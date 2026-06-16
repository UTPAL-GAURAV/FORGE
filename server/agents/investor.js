const axios = require('axios')
const { postEvent } = require('./bandService')
const { withRetry } = require('./llmRetry')

const AIML_BASE = 'https://api.aimlapi.com/v1'
const MODEL = process.env.INVESTOR_MODEL || 'gpt-4.1-nano'

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
// Kept short and structured — no verbose prose (cost control)
function buildSystemPrompt(pitch, priorDebriefContext) {
  const stage = pitch.stage ? `Stage: ${pitch.stage}.` : ''
  const priorContext = priorDebriefContext
    ? `\nPRIOR SESSION WEAKNESSES (re-probe these harder):\n${priorDebriefContext}`
    : ''

  return `You are the Investor agent in FORGE, an adversarial pitch preparation system.

ROLE: Attack this pitch on financials, valuation, market size, traction, and defensibility.
You are a blunt, skeptical Series A investor. You do not encourage. You probe hard.
If the founder gives a vague, hand-wavy, or unprepared answer — call it out directly before asking your next question. One sharp sentence of pushback is allowed. Examples:
- "That's not an answer — 'the market is huge' is not a data point."
- "You just said you don't know the number you're asking me to bet on."
- "That's not how valuation works."
Then follow immediately with your next question.

PITCH:
Company: ${pitch.name} — ${pitch.one_liner}
Ask: $${pitch.funding_amount} for ${pitch.equity_percent}% (implied valuation: $${pitch.implied_valuation || 'unknown'})
${stage}
${pitch.traction ? `Traction: ${pitch.traction}` : 'Traction: Not provided — ask about it.'}
${pitch.revenue_model ? `Revenue model: ${pitch.revenue_model}` : ''}
${pitch.key_metrics ? `Metrics: ${pitch.key_metrics}` : ''}
${pitch.tam ? `Market: ${pitch.tam}` : ''}
${priorContext}

RULES:
- Ask ONE sharp question at a time. Never two questions in one message.
- Questions must be specific to THIS pitch, not generic.
- If traction/metrics are missing, open by asking for them.
- Always open Round 1 by attacking the valuation: justify $${pitch.implied_valuation || 'this'} valuation.
- Stage awareness: ${pitch.stage === 'Idea' ? 'Pre-revenue — attack assumptions hard, not metrics.' : pitch.stage === 'Revenue' || pitch.stage === 'Growth' ? 'Revenue stage — demand hard numbers, not projections.' : 'Early stage — probe traction and revenue model.'}
- Do not hallucinate numbers. Only reference what is in the pitch.
- Max 3 sentences total (pushback + question).`
}

// ─── INITIALISE QUEUE FROM PITCH ─────────────────────────────────────────────
// Generate the opening question bank based on pitch context
async function initQueue(pitch) {
  const prompt = `Based on this pitch, generate 5 sharp investor questions as a JSON array.
Each question is an object: { "question": "...", "topic": "...", "priority": 1-5 }
Priority 1 = most dangerous. Focus on: valuation, CAC/LTV, runway, traction, revenue model.
Only output valid JSON. No explanation.

Pitch: ${pitch.name} — ${pitch.one_liner}
Ask: $${pitch.funding_amount} for ${pitch.equity_percent}% (valuation: $${pitch.implied_valuation})
${pitch.traction ? `Traction: ${pitch.traction}` : 'Traction: none provided'}
${pitch.revenue_model ? `Revenue: ${pitch.revenue_model}` : ''}
${pitch.key_metrics ? `Metrics: ${pitch.key_metrics}` : ''}`

  const res = await callAIML([{ role: 'user', content: prompt }], 400)
  try {
    const questions = JSON.parse(res)
    return questions.map(q => ({ ...q, depth: 0 })).sort((a, b) => a.priority - b.priority)
  } catch {
    // Fallback queue if parse fails
    return [
      { question: `You're asking $${pitch.implied_valuation} valuation — what justifies that number right now?`, topic: 'valuation', priority: 1, depth: 0 },
      { question: 'What is your current monthly recurring revenue?', topic: 'traction', priority: 2, depth: 0 },
      { question: 'What does your CAC look like and how does it compare to LTV?', topic: 'unit_economics', priority: 3, depth: 0 },
    ]
  }
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

  const prompt = `You are the Investor agent evaluating a founder's response.

QUESTION ASKED: "${lastQuestion}"
FOUNDER ANSWERED: "${founderResponse}"
TOPIC DEPTH: This topic ("${lastTopic}") has been followed up ${currentDepth} time(s) already.
${coveredLine}

Respond with JSON only:
{
  "satisfied": true/false,
  "annotation": { "type": "WEAK_POINT|STRONG_POINT|CONTRADICTION|DEFLECTION", "topic": "...", "confidence": "high|medium|low", "note": "one sentence max" },
  "followUp": "follow-up question if not satisfied, or null",
  "newQueueItems": [{ "question": "...", "topic": "...", "priority": 2, "depth": 0 }]
}

Rules:
- satisfied=true only if the answer is specific, credible, and complete
- If topic depth >= 2, set satisfied=true and followUp=null — topic is closed, move on
- followUp must be ONE sharp question or null
- newQueueItems: max 1 item, only if it covers a genuinely new topic not yet explored this session`

  const res = await callAIML([{ role: 'user', content: prompt }], 300)
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

// ─── GENERATE FIRST QUESTION ─────────────────────────────────────────────────
function getFirstQuestion(pitch) {
  const val = pitch.implied_valuation
    ? `$${Number(pitch.implied_valuation).toLocaleString()}`
    : `${pitch.equity_percent}% equity`
  return `You're asking for $${Number(pitch.funding_amount).toLocaleString()} at a ${val} valuation — walk me through exactly what justifies that number today.`
}

// ─── DEBRIEF NOMINATION ──────────────────────────────────────────────────────
async function nominateWeaknesses(pitch, sessionEvents, remainingQueue) {
  const askedQuestions = sessionEvents
    .filter(e => e.event_type === 'AGENT_QUESTION' && e.agent === 'investor')
    .map(e => e.payload)

  const prompt = `You are the Investor agent. Nominate the top weaknesses from this pitch session.

PITCH: ${pitch.name} — ${pitch.one_liner} (asking $${pitch.funding_amount} for ${pitch.equity_percent}%)

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
      "why_dangerous": "why an investor would walk",
      "what_to_fix": "specific actionable advice",
      "from_unasked": true/false
    }
  ]
}`

  const res = await callAIML([{ role: 'user', content: prompt }], 500)
  try {
    return JSON.parse(res).nominations
  } catch {
    return []
  }
}

// ─── AIML API CALL ───────────────────────────────────────────────────────────
async function callAIML(messages, maxTokens = 150) {
  const res = await withRetry(() => axios.post(
    `${AIML_BASE}/chat/completions`,
    {
      model: MODEL,
      messages,
      max_tokens: maxTokens, // always capped — cost control
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.AIML_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  ))
  return res.data.choices[0].message.content.trim()
}

// ─── MAIN TURN HANDLER ───────────────────────────────────────────────────────
// Called by the session runner when it's the Investor's turn to respond
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
    await postEvent(roomId, 'investor', 'AGENT_QUESTION', { question: firstQ, topic: 'valuation', isFirst: true })
    return { question: firstQ, passControl: false }
  }

  // Evaluate founder's response
  const evaluation = await evaluateResponse(pitch, founderResponse, lastQuestion, currentQueue, allAnnotations)

  // Post annotation to Band room (visible in sidebar, not in chat)
  await postEvent(roomId, 'investor', evaluation.annotation.type, {
    ...evaluation.annotation,
    agent: 'investor',
  })

  // Persist annotation to DB
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, agent, payload)
     VALUES ($1, $2, 'investor', $3)`,
    [sessionId, evaluation.annotation.type, JSON.stringify(evaluation.annotation)]
  )

  // Add new queue items to DB if any
  if (evaluation.newQueueItems?.length) {
    const existing = await pool.query(
      `SELECT questions FROM agent_queues WHERE session_id = $1 AND agent = 'investor'`,
      [sessionId]
    )
    const queue = existing.rows[0]?.questions || []
    const updated = [...queue, ...evaluation.newQueueItems].sort((a, b) => a.priority - b.priority)
    await pool.query(
      `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'investor'`,
      [JSON.stringify(updated), sessionId]
    )
    // Post queue update to Band sidebar
    await postEvent(roomId, 'investor', 'QUEUE_UPDATE', { added: evaluation.newQueueItems })
  }

  // Decide: follow up or pass control
  if (!evaluation.satisfied && evaluation.followUp) {
    await postEvent(roomId, 'investor', 'FOLLOW_UP', { question: evaluation.followUp })
    return { question: evaluation.followUp, passControl: false }
  }

  // Pass control — post to Band sidebar
  await postEvent(roomId, 'investor', 'PASS_CONTROL', { reason: 'satisfied' })
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
