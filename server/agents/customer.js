const axios = require('axios')
const { postEvent } = require('./bandService')
const { withRetry } = require('./llmRetry')
const { featherlessSerial } = require('./featherlessQueue')

const FEATHERLESS_BASE = 'https://api.featherless.ai/v1'
const MODEL = process.env.CUSTOMER_MODEL || 'deepseek-ai/DeepSeek-V3.1'

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
// Kept short and structured — no verbose prose (cost control)
function buildSystemPrompt(pitch, priorDebriefContext) {
  const stage = pitch.stage ? `Stage: ${pitch.stage}.` : ''
  const targetCustomer = pitch.target_customer || 'not specified'
  const priorContext = priorDebriefContext
    ? `\nPRIOR SESSION WEAKNESSES (re-probe these harder):\n${priorDebriefContext}`
    : ''

  return `You are the Customer agent in FORGE, an adversarial pitch preparation system.

ROLE: Attack this pitch on real-world adoption, willingness to pay, product value, onboarding friction, retention, and whether anyone actually needs this.
You are a skeptical, pragmatic customer advocate. You do not encourage. You probe hard.
If the founder gives a vague or unprepared answer — call it out in one sharp sentence before your next question. Examples:
- "Saying customers 'love it' is not retention data."
- "You haven't spoken to a paying customer — you've spoken to people who said it sounds nice."
- "That's a solution looking for a problem."
Then follow immediately with your next question.

PITCH:
Company: ${pitch.name} — ${pitch.one_liner}
Target customer: ${targetCustomer}
${stage}
${pitch.revenue_model ? `Pricing: ${pitch.revenue_model}` : 'Pricing: Not provided — ask about it.'}
${pitch.traction ? `Traction: ${pitch.traction}` : 'Traction: Not provided — ask about real customer conversations.'}
${pitch.key_metrics ? `Metrics: ${pitch.key_metrics}` : ''}
${priorContext}

RULES:
- Ask ONE sharp question at a time. Never two questions in one message.
- Questions must be specific to THIS pitch and THIS customer, not generic.
- Focus on: willingness to pay, onboarding friction, retention, switching costs, problem severity.
- Stage awareness: ${pitch.stage === 'Idea' ? 'Pre-revenue — attack whether the problem is real and painful enough to change behaviour.' : pitch.stage === 'Revenue' || pitch.stage === 'Growth' ? 'Revenue stage — demand retention data, NPS evidence, and churn numbers.' : 'Early stage — probe whether real customers have validated the problem and paid anything.'}
- Do not hallucinate numbers. Only reference what is in the pitch.
- Max 3 sentences total (pushback + question).`
}

// ─── INITIALISE QUEUE FROM PITCH ─────────────────────────────────────────────
// Generate the opening question bank based on pitch context
async function initQueue(pitch) {
  const targetCustomer = pitch.target_customer || 'not specified'

  const prompt = `Based on this pitch, generate 5 sharp questions from a skeptical customer's perspective as a JSON array.
Each question is an object: { "question": "...", "topic": "...", "priority": 1-5 }
Priority 1 = most dangerous.

YOU ARE A CUSTOMER, NOT AN INVESTOR. Your questions must ONLY cover:
- Willingness to pay the stated price
- How a customer discovers and adopts this product
- Onboarding friction and time-to-value
- Why someone switches from what they use today
- Retention: what makes a customer stay or churn
- Whether the problem is real and painful enough to change behaviour
- Real customer validation: who has actually used or paid for this

DO NOT ask about: funding, valuation, market size, TAM, team composition, investors, risks, or financials. Those belong to other agents.
Only output valid JSON. No explanation.

Pitch: ${pitch.name} — ${pitch.one_liner}
Target customer: ${targetCustomer}
${pitch.revenue_model ? `Pricing: ${pitch.revenue_model}` : 'Pricing: none provided'}
${pitch.traction ? `Traction: ${pitch.traction}` : 'Traction: none provided'}
${pitch.key_metrics ? `Metrics: ${pitch.key_metrics}` : ''}`

  const res = await callFeatherless([{ role: 'user', content: prompt }], 400)
  try {
    const questions = JSON.parse(res)
    return questions.map(q => ({ ...q, depth: 0 })).sort((a, b) => a.priority - b.priority)
  } catch {
    // Fallback queue if parse fails
    return [
      { question: 'Walk me through the last conversation where a customer agreed to pay for this — what exactly did they say?', topic: 'willingness_to_pay', priority: 1, depth: 0 },
      { question: 'What does the onboarding look like — how long before a new customer sees value?', topic: 'onboarding', priority: 2, depth: 0 },
      { question: 'Why would someone switch from what they use today — what is the switching cost?', topic: 'switching_cost', priority: 3, depth: 0 },
    ]
  }
}

// ─── GENERATE FIRST QUESTION ─────────────────────────────────────────────────
function getFirstQuestion(pitch) {
  if (pitch.target_customer) {
    return `You're targeting ${pitch.target_customer} — describe the last conversation you had with one of them where they agreed to pay for this.`
  }
  return `Who is your ideal customer and what does their current workflow look like before they find your product?`
}

// ─── EVALUATE FOUNDER RESPONSE ───────────────────────────────────────────────
// Called after every founder answer — all agents evaluate in parallel (isolated, Shark Tank model)
// Returns: { annotation, satisfied, followUp, newQueueItems }
async function evaluateResponse(pitch, founderResponse, lastQuestion, lastTopic, currentDepth, currentQueue, sessionHistory) {
  const coveredTopics = (sessionHistory || [])
    .filter(e => e.event_type === 'AGENT_QUESTION')
    .map(e => e.payload?.topic)
    .filter(Boolean)
  const coveredLine = coveredTopics.length
    ? `TOPICS ALREADY COVERED THIS SESSION: ${[...new Set(coveredTopics)].join(', ')} — do NOT add newQueueItems on these topics.`
    : ''

  const prompt = `You are the Customer agent evaluating a founder's response.

QUESTION ASKED: "${lastQuestion}"
FOUNDER ANSWERED: "${founderResponse}"
TOPIC DEPTH: This topic ("${lastTopic}") has been followed up ${currentDepth} time(s) already.
${coveredLine}

YOU ARE A CUSTOMER, NOT AN INVESTOR. Only add newQueueItems about: willingness to pay, adoption, onboarding, retention, churn, or problem severity. Never ask about funding, team, market size, valuation, or risks.

Respond with JSON only:
{
  "satisfied": true/false,
  "annotation": { "type": "WEAK_POINT|STRONG_POINT|CONTRADICTION|DEFLECTION", "topic": "...", "confidence": "high|medium|low", "note": "one sentence max" },
  "followUp": "follow-up question if not satisfied, or null",
  "newQueueItems": [{ "question": "...", "topic": "...", "priority": 2, "depth": 0 }]
}

Rules:
- satisfied=true only if the answer is specific, credible, with real examples — not hypothetical
- If topic depth >= 2, set satisfied=true and followUp=null — topic is closed, move on
- followUp must be ONE sharp question or null
- newQueueItems: max 1 item, only if it covers a genuinely new customer-perspective topic not yet explored this session`

  const res = await callFeatherless([{ role: 'user', content: prompt }], 350)
  try {
    return JSON.parse(res)
  } catch {
    return {
      satisfied: true,
      annotation: { type: 'WEAK_POINT', topic: 'unclear response', confidence: 'low', note: 'Response was unclear' },
      followUp: null,
      newQueueItems: [],
    }
  }
}

// ─── DEBRIEF NOMINATION ──────────────────────────────────────────────────────
async function nominateWeaknesses(pitch, sessionEvents, remainingQueue) {
  const askedQuestions = sessionEvents
    .filter(e => e.event_type === 'AGENT_QUESTION' && e.agent === 'customer')
    .map(e => e.payload)

  const targetCustomer = pitch.target_customer || 'not specified'

  const prompt = `You are the Customer agent. Nominate the top weaknesses from this pitch session.

PITCH: ${pitch.name} — ${pitch.one_liner} (target customer: ${targetCustomer})

QUESTIONS ASKED AND RESPONSES:
${askedQuestions.map(q => `Q: ${q.question}\nA: ${q.answer || 'No answer'}`).join('\n\n')}

UNASKED QUESTIONS REMAINING:
${remainingQueue.map(q => q.question).join('\n')}

Output JSON only:
{
  "nominations": [
    {
      "title": "short weakness title",
      "topic": "...",
      "severity": "deal_killer|high_risk|needs_work",
      "what_exposed": "what the founder said or didn't say",
      "why_dangerous": "why a real customer would not buy or churn",
      "what_to_fix": "specific actionable advice",
      "from_unasked": true/false
    }
  ]
}`

  const res = await callFeatherless([{ role: 'user', content: prompt }], 500)
  try {
    return JSON.parse(res).nominations
  } catch {
    return []
  }
}

// ─── FEATHERLESS API CALL ─────────────────────────────────────────────────────
async function callFeatherless(messages, maxTokens = 150) {
  return featherlessSerial(() => withRetry(() => axios.post(
    `${FEATHERLESS_BASE}/chat/completions`,
    {
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.FEATHERLESS_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  ))).then(res => res.data.choices[0].message.content.trim())
}

// ─── MAIN TURN HANDLER ───────────────────────────────────────────────────────
// Called by the session runner when it's the Customer's turn to respond
async function handleTurn({
  pitch,
  sessionId,
  roomId,
  founderResponse,
  lastQuestion,
  currentQueue,
  allAnnotations,
  isFirstTurn,
  priorDebriefContext,
  pool,
}) {
  // First turn — return opening question without LLM call (deterministic)
  if (isFirstTurn) {
    const firstQ = getFirstQuestion(pitch)
    await postEvent(roomId, 'customer', 'AGENT_QUESTION', { question: firstQ, topic: 'customer_validation', isFirst: true })
    return { question: firstQ, passControl: false }
  }

  // Evaluate founder's response
  const evaluation = await evaluateResponse(pitch, founderResponse, lastQuestion, currentQueue, allAnnotations)

  // Post annotation to Band room (visible in sidebar, not in chat)
  await postEvent(roomId, 'customer', evaluation.annotation.type, {
    ...evaluation.annotation,
    agent: 'customer',
  })

  // Persist annotation to DB
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, agent, payload)
     VALUES ($1, $2, 'customer', $3)`,
    [sessionId, evaluation.annotation.type, JSON.stringify(evaluation.annotation)]
  )

  // Add new queue items to DB if any
  if (evaluation.newQueueItems?.length) {
    const existing = await pool.query(
      `SELECT questions FROM agent_queues WHERE session_id = $1 AND agent = 'customer'`,
      [sessionId]
    )
    const queue = existing.rows[0]?.questions || []
    const updated = [...queue, ...evaluation.newQueueItems].sort((a, b) => a.priority - b.priority)
    await pool.query(
      `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'customer'`,
      [JSON.stringify(updated), sessionId]
    )
    // Post queue update to Band sidebar
    await postEvent(roomId, 'customer', 'QUEUE_UPDATE', { added: evaluation.newQueueItems })
  }

  // Decide: follow up or pass control
  if (!evaluation.satisfied && evaluation.followUp) {
    await postEvent(roomId, 'customer', 'FOLLOW_UP', { question: evaluation.followUp })
    return { question: evaluation.followUp, passControl: false }
  }

  // Pass control — post to Band sidebar
  await postEvent(roomId, 'customer', 'PASS_CONTROL', { reason: 'satisfied' })
  return { question: null, passControl: true }
}

module.exports = {
  handleTurn,
  initQueue,
  nominateWeaknesses,
  buildSystemPrompt,
  getFirstQuestion,
  evaluateResponse,
}
