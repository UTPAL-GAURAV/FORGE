const axios = require('axios')
const { postEvent } = require('./bandService')
const { withRetry } = require('./llmRetry')

const AIML_BASE = 'https://api.aimlapi.com/v1'
const MODEL = process.env.REDTEAM_MODEL || 'gpt-4.1-nano'

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
// Kept short and structured — no verbose prose (cost control)
function buildSystemPrompt(pitch, priorDebriefContext) {
  const stage = pitch.stage ? `Stage: ${pitch.stage}.` : ''
  const priorContext = priorDebriefContext
    ? `\nPRIOR SESSION WEAKNESSES (re-probe these harder):\n${priorDebriefContext}`
    : ''
  const knownRisks = pitch.known_risks
    ? `\nKNOWN RISKS (founder admitted these — open by attacking them):\n${pitch.known_risks}`
    : ''

  return `You are the Red Team agent in FORGE, an adversarial pitch preparation system.

ROLE: Attack this pitch on logical gaps, internal contradictions, flawed assumptions, and execution risk.
You find what doesn't add up. You catch the founder in contradictions across everything they've said.
You are relentless, precise, and forensic. You do not encourage. You dismantle.
If the founder gives a vague, evasive, or self-contradicting answer — name the problem directly in one sentence before your next question. Examples:
- "You said distribution is your biggest risk, then described a plan with no distribution budget."
- "That contradicts what you said about runway two questions ago."
- "That's not an answer — that's a hope dressed up as a strategy."
Then follow immediately with your next question.

PITCH:
Company: ${pitch.name} — ${pitch.one_liner}
Ask: $${pitch.funding_amount} for ${pitch.equity_percent}% (implied valuation: $${pitch.implied_valuation || 'unknown'})
${stage}
${pitch.traction ? `Traction: ${pitch.traction}` : 'Traction: Not provided — question whether they have any.'}
${pitch.revenue_model ? `Revenue model: ${pitch.revenue_model}` : ''}
${pitch.key_metrics ? `Metrics: ${pitch.key_metrics}` : ''}
${pitch.tam ? `Market: ${pitch.tam}` : ''}
${knownRisks}
${priorContext}

RULES:
- Ask ONE sharp question at a time. Never two questions in one message.
- Questions must be specific to THIS pitch, not generic.
- If known_risks are present, open by attacking those directly — the founder already admitted them.
- Always attack assumptions hard at every stage: pre-revenue, early, or growth.
- TAM claims: demand methodology. "Large market" is not a number — how was it calculated?
- Contradictions: if the founder said something that doesn't add up, name it explicitly.
- Do not hallucinate numbers. Only reference what is in the pitch.
- Max 3 sentences total (pushback + question).`
}

// ─── INITIALISE QUEUE FROM PITCH ─────────────────────────────────────────────
// Generate the opening question bank based on pitch context
async function initQueue(pitch) {
  const knownRisksLine = pitch.known_risks
    ? `Known risks admitted by founder: ${pitch.known_risks}`
    : 'No risks admitted by founder.'

  const prompt = `Based on this pitch, generate 5 sharp red team questions as a JSON array.
Each question is an object: { "question": "...", "topic": "...", "priority": 1-5 }
Priority 1 = most dangerous. Focus on: logical contradictions, TAM methodology, execution risks, assumptions with no evidence.
If known risks are listed, the priority-1 question MUST directly attack those risks.
Only output valid JSON. No explanation.

Pitch: ${pitch.name} — ${pitch.one_liner}
Ask: $${pitch.funding_amount} for ${pitch.equity_percent}% (valuation: $${pitch.implied_valuation})
${pitch.traction ? `Traction: ${pitch.traction}` : 'Traction: none provided'}
${pitch.revenue_model ? `Revenue: ${pitch.revenue_model}` : ''}
${pitch.key_metrics ? `Metrics: ${pitch.key_metrics}` : ''}
${pitch.tam ? `Market: ${pitch.tam}` : ''}
${knownRisksLine}`

  const res = await callAIML([{ role: 'user', content: prompt }], 400)
  try {
    const questions = JSON.parse(res)
    return questions.map(q => ({ ...q, depth: 0 })).sort((a, b) => a.priority - b.priority)
  } catch {
    // Fallback queue if parse fails
    return [
      { question: `What's the single biggest assumption your entire business model rests on — and what happens if it's wrong?`, topic: 'core_assumption', priority: 1, depth: 0 },
      { question: 'How did you calculate your TAM — walk me through the methodology, not just the number?', topic: 'tam_methodology', priority: 2, depth: 0 },
      { question: 'What execution step have you underestimated the most, and why haven\'t you solved it yet?', topic: 'execution_risk', priority: 3, depth: 0 },
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

  const prompt = `You are the Red Team agent evaluating a founder's response.

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
- satisfied=true only if the answer is specific, credible, logically consistent, and complete
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
  if (pitch.known_risks) {
    return `You listed '${pitch.known_risks}' as risks you already know about — let's start there. What's your concrete plan to address the first one?`
  }
  return `What's the single biggest assumption your entire business model rests on — and what happens if it's wrong?`
}

// ─── DEBRIEF NOMINATION ──────────────────────────────────────────────────────
async function nominateWeaknesses(pitch, sessionEvents, remainingQueue) {
  const askedQuestions = sessionEvents
    .filter(e => e.event_type === 'AGENT_QUESTION' && e.agent === 'red_team')
    .map(e => e.payload)

  const prompt = `You are the Red Team agent. Nominate the top weaknesses from this pitch session.

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

// ─── DEBRIEF ARBITRATION ─────────────────────────────────────────────────────
// UNIQUE TO RED TEAM — reads all 4 agents' nominations and produces the final
// ranked list of 5 weaknesses plus overall verdict and recommended focus areas.
async function arbitrateDebrief(allNominations, pitch) {
  const nominationBlocks = allNominations
    .map(({ agent, nominations }) => {
      const items = (nominations || [])
        .map((n, i) => `  ${i + 1}. [${n.severity}] ${n.title}: ${n.what_exposed}`)
        .join('\n')
      return `=== ${agent.toUpperCase()} ===\n${items || '  (no nominations)'}`
    })
    .join('\n\n')

  const prompt = `You are the Red Team arbitrator for FORGE. All 4 agents have submitted their weakness nominations from an adversarial pitch session. Your job is to synthesise them into the definitive final debrief.

PITCH: ${pitch.name} — ${pitch.one_liner}
Ask: $${pitch.funding_amount} for ${pitch.equity_percent}% equity

ALL AGENT NOMINATIONS:
${nominationBlocks}

YOUR TASK:
1. Deduplicate and rank the top 5 weaknesses across all agents (most dangerous first).
2. Write a one-paragraph overall verdict on whether this pitch is ready.
3. Provide 3 recommended focus areas (bullet points).

Output JSON only — no commentary outside the JSON:
{
  "weaknesses": [
    {
      "rank": 1,
      "title": "short weakness title",
      "severity": "deal_killer|high_risk|needs_work",
      "what_exposed": "what the founder said or didn't say",
      "why_dangerous": "why an investor would walk",
      "what_to_fix": "specific actionable advice",
      "asked_by": "agent name that surfaced this",
      "from_unasked": true/false
    }
  ],
  "verdict": "one paragraph overall assessment of pitch readiness",
  "recommended_focus": [
    "focus area 1",
    "focus area 2",
    "focus area 3"
  ]
}`

  const res = await callAIML([{ role: 'user', content: prompt }], 800)
  try {
    return JSON.parse(res)
  } catch {
    return {
      weaknesses: [],
      verdict: 'Arbitration failed — raw nominations available from each agent.',
      recommended_focus: [],
    }
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
// Called by the session runner when it's the Red Team's turn to respond
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
    await postEvent(roomId, 'red_team', 'AGENT_QUESTION', { question: firstQ, topic: 'core_assumption', isFirst: true })
    return { question: firstQ, passControl: false }
  }

  // Evaluate founder's response
  const evaluation = await evaluateResponse(pitch, founderResponse, lastQuestion, currentQueue, allAnnotations)

  // Post annotation to Band room (visible in sidebar, not in chat)
  await postEvent(roomId, 'red_team', evaluation.annotation.type, {
    ...evaluation.annotation,
    agent: 'red_team',
  })

  // Persist annotation to DB
  await pool.query(
    `INSERT INTO session_events (session_id, event_type, agent, payload)
     VALUES ($1, $2, 'red_team', $3)`,
    [sessionId, evaluation.annotation.type, JSON.stringify(evaluation.annotation)]
  )

  // Add new queue items to DB if any
  if (evaluation.newQueueItems?.length) {
    const existing = await pool.query(
      `SELECT questions FROM agent_queues WHERE session_id = $1 AND agent = 'red_team'`,
      [sessionId]
    )
    const queue = existing.rows[0]?.questions || []
    const updated = [...queue, ...evaluation.newQueueItems].sort((a, b) => a.priority - b.priority)
    await pool.query(
      `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'red_team'`,
      [JSON.stringify(updated), sessionId]
    )
    // Post queue update to Band sidebar
    await postEvent(roomId, 'red_team', 'QUEUE_UPDATE', { added: evaluation.newQueueItems })
  }

  // Decide: follow up or pass control
  if (!evaluation.satisfied && evaluation.followUp) {
    await postEvent(roomId, 'red_team', 'FOLLOW_UP', { question: evaluation.followUp })
    return { question: evaluation.followUp, passControl: false }
  }

  // Pass control — post to Band sidebar
  await postEvent(roomId, 'red_team', 'PASS_CONTROL', { reason: 'satisfied' })
  return { question: null, passControl: true }
}

module.exports = {
  handleTurn,
  initQueue,
  nominateWeaknesses,
  buildSystemPrompt,
  getFirstQuestion,
  arbitrateDebrief,
  evaluateResponse,
}
