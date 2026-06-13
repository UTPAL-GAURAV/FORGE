const axios = require('axios')
const { postEvent } = require('./bandService')
const { withRetry } = require('./llmRetry')
const { featherlessSerial } = require('./featherlessQueue')

const FEATHERLESS_BASE = 'https://api.featherless.ai/v1'
const MODEL = process.env.COMPETITOR_MODEL || 'deepseek-ai/DeepSeek-V3.1'

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
// Kept short and structured — no verbose prose (cost control)
function buildSystemPrompt(pitch, priorDebriefContext) {
  const stage = pitch.stage ? `Stage: ${pitch.stage}.` : ''
  const priorContext = priorDebriefContext
    ? `\nPRIOR SESSION WEAKNESSES (re-probe these harder):\n${priorDebriefContext}`
    : ''

  return `You are the Competitor agent in FORGE, an adversarial pitch preparation system.

ROLE: Attack this pitch on differentiation, moat, competitive landscape, pricing defensibility, and why this company won't be copied or crushed.
You are a blunt, skeptical strategist who knows the market. You do not encourage. You probe hard.
If the founder gives a vague or unprepared answer — call it out in one sharp sentence before your next question. Examples:
- "That's not differentiation — that's a feature any competitor can ship in a sprint."
- "You just named three better-funded competitors and couldn't explain why customers would switch."
- "'Better UX' is not a moat."
Then follow immediately with your next question.

PITCH:
Company: ${pitch.name} — ${pitch.one_liner}
${stage}
${pitch.competitors ? `Named competitors: ${pitch.competitors}` : 'Competitors: Not provided — demand a full competitive landscape.'}
${pitch.revenue_model ? `Revenue model: ${pitch.revenue_model}` : ''}
${pitch.traction ? `Traction: ${pitch.traction}` : ''}
${pitch.tam ? `Market: ${pitch.tam}` : ''}
${priorContext}

RULES:
- Ask ONE sharp question at a time. Never two questions in one message.
- NEVER ask "who are your competitors?" — you already know the market. Name them. Attack with specifics.
- If no competitors were provided, infer the obvious ones from the pitch description and use them.
- Focus on: differentiation, moat, switching costs, pricing pressure, copy risk.
- Stage awareness: ${pitch.stage === 'Idea' ? 'Pre-revenue — attack the assumption of differentiation, not proven metrics.' : pitch.stage === 'Revenue' || pitch.stage === 'Growth' ? 'Revenue stage — demand proof of retention vs competitors and defensible pricing.' : 'Early stage — probe what stops a well-funded competitor from replicating this.'}
- Do not hallucinate features or traction numbers. Only reference what is in the pitch.
- Max 3 sentences total (pushback + question).`
}

// ─── INITIALISE QUEUE FROM PITCH ─────────────────────────────────────────────
// Generate the opening question bank based on pitch context
async function initQueue(pitch) {
  const competitorContext = pitch.competitors
    ? `Named competitors: ${pitch.competitors}`
    : `No competitors named. Based on the pitch, infer the 2-3 most obvious real competitors in this space (by name) and use them in your questions. Do not ask the founder who their competitors are — you already know the market.`

  const prompt = `Based on this pitch, generate 5 sharp competitor-focused questions as a JSON array.
Each question is an object: { "question": "...", "topic": "...", "priority": 1-5 }
Priority 1 = most dangerous. Focus on: why won't [specific named competitor] copy this, pricing vs named alternatives, switching costs, moat, copy risk.
Questions must name specific competitors — never ask "who are your competitors?".
Only output valid JSON. No explanation.

Pitch: ${pitch.name} — ${pitch.one_liner}
${competitorContext}
${pitch.revenue_model ? `Revenue model: ${pitch.revenue_model}` : ''}
${pitch.traction ? `Traction: ${pitch.traction}` : ''}
${pitch.tam ? `Market: ${pitch.tam}` : ''}`

  const res = await callFeatherless([{ role: 'user', content: prompt }], 400)
  try {
    const questions = JSON.parse(res)
    return questions.map(q => ({ ...q, depth: 0 })).sort((a, b) => a.priority - b.priority)
  } catch {
    const competitorRef = pitch.competitors || 'a well-funded incumbent in this space'
    return [
      { question: `What specifically stops ${competitorRef} from shipping your core feature in 60 days?`, topic: 'copy_risk', priority: 1, depth: 0 },
      { question: 'What is your moat — and why is it durable, not just a head start?', topic: 'moat', priority: 2, depth: 0 },
      { question: 'How does your pricing compare to alternatives and why won\'t customers just switch?', topic: 'pricing_defensibility', priority: 3, depth: 0 },
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

  const prompt = `You are the Competitor agent evaluating a founder's response.

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

  const res = await callFeatherless([{ role: 'user', content: prompt }], 300)
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
  if (pitch.competitors) {
    return `You listed ${pitch.competitors} as your competition — what specifically stops them from shipping exactly what you're building in the next 60 days?`
  }
  // No competitors provided — agent names the obvious ones and attacks directly
  return `${pitch.name} operates in a space with well-funded incumbents. Without knowing your moat, I'd assume a larger player ships your core feature as a minor update. What's the specific reason that doesn't happen?`
}

// ─── DEBRIEF NOMINATION ──────────────────────────────────────────────────────
async function nominateWeaknesses(pitch, sessionEvents, remainingQueue) {
  const askedQuestions = sessionEvents
    .filter(e => e.event_type === 'AGENT_QUESTION' && e.agent === 'competitor')
    .map(e => e.payload)

  const prompt = `You are the Competitor agent. Nominate the top weaknesses from this pitch session.

PITCH: ${pitch.name} — ${pitch.one_liner}
${pitch.competitors ? `Competitors mentioned: ${pitch.competitors}` : 'Competitors: not provided'}

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
      "why_dangerous": "why a competitor or acquirer would exploit this",
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
// Called by the session runner when it's the Competitor's turn to respond
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
    await postEvent(roomId, 'competitor', 'AGENT_QUESTION', { question: firstQ, topic: 'differentiation', isFirst: true })
    return { question: firstQ, passControl: false }
  }

  // Evaluate founder's response
  const evaluation = await evaluateResponse(pitch, founderResponse, lastQuestion, currentQueue, allAnnotations)

  // Post annotation to Band room (visible in sidebar, not in chat)
  await postEvent(roomId, 'competitor', evaluation.annotation.type, {
    ...evaluation.annotation,
    agent: 'competitor',
  })

  // Persist annotation to DB
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, agent, payload)
     VALUES ($1, $2, 'competitor', $3)`,
    [sessionId, evaluation.annotation.type, JSON.stringify(evaluation.annotation)]
  )

  // Add new queue items to DB if any
  if (evaluation.newQueueItems?.length) {
    const existing = await pool.query(
      `SELECT questions FROM agent_queues WHERE session_id = $1 AND agent = 'competitor'`,
      [sessionId]
    )
    const queue = existing.rows[0]?.questions || []
    const updated = [...queue, ...evaluation.newQueueItems].sort((a, b) => a.priority - b.priority)
    await pool.query(
      `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'competitor'`,
      [JSON.stringify(updated), sessionId]
    )
    // Post queue update to Band sidebar
    await postEvent(roomId, 'competitor', 'QUEUE_UPDATE', { added: evaluation.newQueueItems })
  }

  // Decide: follow up or pass control
  if (!evaluation.satisfied && evaluation.followUp) {
    await postEvent(roomId, 'competitor', 'FOLLOW_UP', { question: evaluation.followUp })
    return { question: evaluation.followUp, passControl: false }
  }

  // Pass control — post to Band sidebar
  await postEvent(roomId, 'competitor', 'PASS_CONTROL', { reason: 'satisfied' })
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
