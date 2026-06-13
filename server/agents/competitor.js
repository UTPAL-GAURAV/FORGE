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
- Questions must be specific to THIS pitch and its named competitors.
- Focus on: differentiation, moat, switching costs, pricing pressure, copy risk.
- Stage awareness: ${pitch.stage === 'Idea' ? 'Pre-revenue — attack the assumption of differentiation, not proven metrics.' : pitch.stage === 'Revenue' || pitch.stage === 'Growth' ? 'Revenue stage — demand proof of retention vs competitors and defensible pricing.' : 'Early stage — probe what stops a well-funded competitor from replicating this.'}
- Do not hallucinate competitors or features. Only reference what is in the pitch.
- Max 3 sentences total (pushback + question).`
}

// ─── INITIALISE QUEUE FROM PITCH ─────────────────────────────────────────────
// Generate the opening question bank based on pitch context
async function initQueue(pitch) {
  const prompt = `Based on this pitch, generate 5 sharp competitor-focused questions as a JSON array.
Each question is an object: { "question": "...", "topic": "...", "priority": 1-5 }
Priority 1 = most dangerous. Focus on: who else does this, why won't the top competitor copy this feature, pricing vs competitors, switching costs, moat.
Only output valid JSON. No explanation.

Pitch: ${pitch.name} — ${pitch.one_liner}
${pitch.competitors ? `Named competitors: ${pitch.competitors}` : 'Competitors: none provided'}
${pitch.revenue_model ? `Revenue model: ${pitch.revenue_model}` : ''}
${pitch.traction ? `Traction: ${pitch.traction}` : ''}
${pitch.tam ? `Market: ${pitch.tam}` : ''}`

  const res = await callFeatherless([{ role: 'user', content: prompt }], 400)
  try {
    const questions = JSON.parse(res)
    return questions.sort((a, b) => a.priority - b.priority)
  } catch {
    // Fallback queue if parse fails
    const competitorRef = pitch.competitors
      ? `your named competitors (${pitch.competitors})`
      : 'an established player in this space'
    return [
      { question: `What specifically stops ${competitorRef} from building exactly what you're building in the next 6 months?`, topic: 'copy_risk', priority: 1 },
      { question: 'What is your moat — and why is it durable, not just a head start?', topic: 'moat', priority: 2 },
      { question: 'How does your pricing compare to alternatives and why won\'t customers just switch?', topic: 'pricing_defensibility', priority: 3 },
    ]
  }
}

// ─── EVALUATE FOUNDER RESPONSE ───────────────────────────────────────────────
// Called after every founder answer — all agents evaluate in parallel
// Returns: { annotation, queueUpdates, followUp, passControl }
async function evaluateResponse(pitch, founderResponse, lastQuestion, currentQueue, allAnnotations) {
  const annotationContext = allAnnotations.length
    ? `\nOTHER AGENTS FOUND:\n${allAnnotations.map(a => `- ${a.agent}: ${a.type} — ${a.topic}`).join('\n')}`
    : ''

  const prompt = `You are the Competitor agent evaluating a founder's response.

QUESTION ASKED: "${lastQuestion}"
FOUNDER ANSWERED: "${founderResponse}"
${annotationContext}

Respond with JSON only:
{
  "satisfied": true/false,
  "annotation": { "type": "WEAK_POINT|STRONG_POINT|CONTRADICTION|DEFLECTION", "topic": "...", "confidence": "high|medium|low", "note": "one sentence max" },
  "followUp": "follow-up question if not satisfied, or null",
  "newQueueItems": [{ "question": "...", "topic": "...", "priority": 1-5 }]
}

Rules:
- satisfied=true only if the answer is specific, credible, and complete
- followUp must be ONE sharp question or null
- newQueueItems: add questions this response opened up (max 2)`

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
    return `You listed ${pitch.competitors} as your competition — what specifically stops them from building exactly what you're building tomorrow?`
  }
  return `Who are your top 3 competitors and what makes you genuinely different from each of them?`
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
