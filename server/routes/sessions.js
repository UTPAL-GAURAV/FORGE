const express = require('express')
const router = express.Router()
const pool = require('../db/pool')
const { requireAuth } = require('../middleware/requireAuth')
const { initSession, postEvent, postMessage } = require('../agents/bandService')
const investorAgent = require('../agents/investor')
const competitorAgent = require('../agents/competitor')
const redteamAgent = require('../agents/redteam')
const customerAgent = require('../agents/customer')

const AGENTS = {
  investor:   investorAgent,
  competitor: competitorAgent,
  red_team:   redteamAgent,
  customer:   customerAgent,
}

const AGENT_ORDER = ['investor', 'competitor', 'red_team', 'customer']

function logErr(label, err) {
  console.error(`[${label}]`, err.message)
  if (err.response?.data) console.error(`[${label}] API response:`, JSON.stringify(err.response.data))
  if (err.stack) console.error(err.stack)
}

// POST start a new session (round) for a project
router.post('/', requireAuth, async (req, res) => {
  const { project_id } = req.body
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    const { rows: projects } = await pool.query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [project_id, req.user.id]
    )
    if (!projects.length) return res.status(404).json({ error: 'Project not found' })
    const project = projects[0]

    const { rows: existing } = await pool.query(
      'SELECT COUNT(*) FROM sessions WHERE project_id = $1',
      [project_id]
    )
    const round_number = parseInt(existing[0].count) + 1

    const band_room_id = await initSession({ ...project, round_number })

    const { rows } = await pool.query(
      `INSERT INTO sessions (project_id, user_id, round_number, band_room_id, active_agent)
       VALUES ($1, $2, $3, $4, 'investor') RETURNING *`,
      [project_id, req.user.id, round_number, band_room_id]
    )
    const session = rows[0]

    await pool.query(
      `INSERT INTO agent_queues (session_id, agent, questions) VALUES
       ($1, 'investor', '[]'),
       ($1, 'competitor', '[]'),
       ($1, 'red_team', '[]'),
       ($1, 'customer', '[]')`,
      [session.id]
    )

    await pool.query(
      `INSERT INTO session_events (session_id, event_type, payload)
       VALUES ($1, 'SESSION_START', $2)`,
      [session.id, JSON.stringify({ round_number, band_room_id })]
    )

    res.status(201).json(session)
  } catch (err) {
    logErr('POST /sessions', err)
    res.status(500).json({ error: 'Failed to start session' })
  }
})

// GET session by id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
        json_object_agg(aq.agent, aq.questions) AS agent_queues
       FROM sessions s
       LEFT JOIN agent_queues aq ON aq.session_id = s.id
       WHERE s.id = $1 AND s.user_id = $2
       GROUP BY s.id`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Session not found' })
    res.json(rows[0])
  } catch (err) {
    logErr('GET /sessions/:id', err)
    res.status(500).json({ error: 'Failed to fetch session' })
  }
})

// GET full session state (exchanges + sidebar events)
router.get('/:id/state', requireAuth, async (req, res) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT s.*, p.name, p.one_liner, p.funding_amount, p.equity_percent,
              p.implied_valuation, p.stage, p.industry, p.traction, p.revenue_model,
              p.key_metrics, p.tam, p.competitors, p.known_risks, p.target_customer,
              p.team, p.problem, p.solution, p.use_of_funds, p.prior_funding
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })

    const session = sessions[0]

    const { rows: events } = await pool.query(
      `SELECT * FROM session_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    )

    const { rows: queues } = await pool.query(
      `SELECT agent, questions FROM agent_queues WHERE session_id = $1`,
      [req.params.id]
    )

    const agentQueues = {}
    queues.forEach(q => { agentQueues[q.agent] = q.questions })

    res.json({ session, events, agentQueues })
  } catch (err) {
    logErr('GET /sessions/:id/state', err)
    res.status(500).json({ error: 'Failed to fetch session state' })
  }
})

// POST /sessions/:id/start — return first question immediately, init queues in background
router.post('/:id/start', requireAuth, async (req, res) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT s.*, p.name, p.one_liner, p.funding_amount, p.equity_percent,
              p.implied_valuation, p.stage, p.industry, p.traction, p.revenue_model,
              p.key_metrics, p.tam, p.competitors, p.known_risks, p.target_customer,
              p.team, p.problem, p.solution, p.use_of_funds, p.prior_funding
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })
    const session = sessions[0]
    const pitch = buildPitch(session)

    // First question is deterministic — no LLM needed
    const firstQ = AGENTS.investor.getFirstQuestion(pitch)

    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'AGENT_QUESTION', 'investor', $2)`,
      [session.id, JSON.stringify({ question: firstQ, topic: 'valuation', isFirst: true, answer: null })]
    )

    // Mark queues as not ready yet
    await pool.query(`UPDATE sessions SET queues_ready = false WHERE id = $1`, [session.id])

    await postEvent(session.band_room_id, 'investor', 'AGENT_QUESTION', { question: firstQ, topic: 'valuation', isFirst: true })
    await postMessage(session.band_room_id, 'investor', firstQ)

    // Respond immediately — founder sees first question right away
    const sidebarEvent = { type: 'AGENT_QUESTION', agent: 'investor', payload: { question: firstQ, topic: 'valuation' } }
    res.json({ question: firstQ, activeAgent: 'investor', topic: 'valuation', depth: 0, sidebarEvents: [sidebarEvent] })

    // Init all 4 queues in background — does not block the response
    initQueuesInBackground(session.id, pitch).catch(err => logErr('initQueues bg', err))

  } catch (err) {
    logErr('POST /sessions/:id/start', err)
    res.status(500).json({ error: 'Failed to start session' })
  }
})

// POST /sessions/:id/turn — submit founder response, get next question + annotation events
router.post('/:id/turn', requireAuth, async (req, res) => {
  const { founderResponse, lastQuestion, lastTopic, lastDepth, activeAgent } = req.body
  if (!founderResponse || !lastQuestion || !activeAgent) {
    return res.status(400).json({ error: 'founderResponse, lastQuestion, activeAgent required' })
  }

  try {
    const { rows: sessions } = await pool.query(
      `SELECT s.*, p.name, p.one_liner, p.funding_amount, p.equity_percent,
              p.implied_valuation, p.stage, p.industry, p.traction, p.revenue_model,
              p.key_metrics, p.tam, p.competitors, p.known_risks, p.target_customer,
              p.team, p.problem, p.solution, p.use_of_funds, p.prior_funding
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })
    const session = sessions[0]
    const pitch = buildPitch(session)

    // If queues are still initialising (founder answered very fast), tell client to retry
    if (session.queues_ready === false) {
      return res.json({ queuesLoading: true })
    }

    // Persist founder response
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'FOUNDER_RESPONSE', NULL, $2)`,
      [session.id, JSON.stringify({ answer: founderResponse, toQuestion: lastQuestion, toAgent: activeAgent })]
    )

    // Load queues
    const { rows: queues } = await pool.query(
      `SELECT agent, questions FROM agent_queues WHERE session_id = $1`,
      [session.id]
    )
    const agentQueues = {}
    queues.forEach(q => { agentQueues[q.agent] = q.questions })

    // Load session history (agents use it to avoid repeating covered topics)
    const { rows: events } = await pool.query(
      `SELECT event_type, agent, payload FROM session_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.id]
    )

    // Count questions asked so far per agent (for 40% share cap)
    const { rows: questionCounts } = await pool.query(
      `SELECT agent, COUNT(*) as count FROM session_events WHERE session_id = $1 AND event_type = 'AGENT_QUESTION' GROUP BY agent`,
      [session.id]
    )
    const totalAsked = questionCounts.reduce((sum, r) => sum + parseInt(r.count), 0)
    const askedByAgent = {}
    questionCounts.forEach(r => { askedByAgent[r.agent] = parseInt(r.count) })

    // Run all-agent evaluation synchronously so annotations are included in the response
    const annotationEvents = await runBackgroundEvaluation({
      session, pitch, founderResponse, lastQuestion,
      lastTopic: lastTopic || 'general', lastDepth: lastDepth ?? 0,
      activeAgent, agentQueues, band_room_id: session.band_room_id, sessionHistory: events,
    }).catch(err => { logErr('bgEval', err); return [] })

    // Reload queues after eval (eval may have added follow-ups / new items)
    const { rows: updatedQueues } = await pool.query(
      `SELECT agent, questions FROM agent_queues WHERE session_id = $1`,
      [session.id]
    )
    const updatedAgentQueues = {}
    updatedQueues.forEach(q => { updatedAgentQueues[q.agent] = q.questions })

    // Pick next agent + question from updated queues (no LLM, deterministic)
    const { nextAgent, nextQuestion } = pickNextQuestion(updatedAgentQueues, activeAgent, askedByAgent, totalAsked)

    let sessionEnded = false
    const sidebarEvents = [...(annotationEvents || [])]

    // Capture topic/depth of the next question BEFORE popping it from the queue
    const nextTopic = nextAgent ? (updatedAgentQueues[nextAgent][0]?.topic || 'general') : null
    const nextDepth = nextAgent ? (updatedAgentQueues[nextAgent][0]?.depth ?? 0) : 0

    if (!nextAgent) {
      sessionEnded = true
      await pool.query(`UPDATE sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`, [session.id])
      sidebarEvents.push({ type: 'SESSION_COMPLETE', agent: 'system', payload: { message: 'All queues exhausted' } })
      await postEvent(session.band_room_id, activeAgent, 'PASS_CONTROL', { reason: 'exhausted' }).catch(() => {})
    } else {
      const remaining = updatedAgentQueues[nextAgent].slice(1)
      await pool.query(
        `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`,
        [JSON.stringify(remaining), session.id, nextAgent]
      )
      await pool.query(`UPDATE sessions SET active_agent = $1 WHERE id = $2`, [nextAgent, session.id])
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, agent, payload) VALUES ($1, 'AGENT_QUESTION', $2, $3)`,
        [session.id, nextAgent, JSON.stringify({ question: nextQuestion, topic: nextTopic, depth: nextDepth, answer: null })]
      )
      await postMessage(session.band_room_id, nextAgent, nextQuestion).catch(() => {})
      await postEvent(session.band_room_id, activeAgent, 'PASS_CONTROL', { reason: 'next_queued', nextAgent }).catch(() => {})
      sidebarEvents.push({ type: 'PASS_CONTROL', agent: activeAgent, payload: { reason: 'next_queued', nextAgent } })
      sidebarEvents.push({ type: 'AGENT_QUESTION', agent: nextAgent, payload: { question: nextQuestion, topic: nextTopic } })
    }

    res.json({ question: nextQuestion || null, activeAgent: nextAgent || activeAgent, topic: nextTopic || 'general', depth: nextDepth, sidebarEvents, sessionEnded })

  } catch (err) {
    logErr('POST /sessions/:id/turn', err)
    if (!res.headersSent) res.status(500).json({ error: 'Failed to process turn' })
  }
})

// POST /sessions/:id/end — founder manually ends session
router.post('/:id/end', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sessions SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Session not found' })
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, payload)
       VALUES ($1, 'SESSION_END', $2)`,
      [req.params.id, JSON.stringify({ reason: 'founder_ended' })]
    )
    res.json({ ok: true })
  } catch (err) {
    logErr('POST /sessions/:id/end', err)
    res.status(500).json({ error: 'Failed to end session' })
  }
})

// POST /sessions/:id/debrief — run debrief generation: all 4 agents nominate, Red Team arbitrates
router.post('/:id/debrief', requireAuth, async (req, res) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT s.*, p.name, p.one_liner, p.funding_amount, p.equity_percent,
              p.implied_valuation, p.stage, p.industry, p.traction, p.revenue_model,
              p.key_metrics, p.tam, p.competitors, p.known_risks, p.target_customer,
              p.team, p.problem, p.solution, p.use_of_funds, p.prior_funding
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })
    const session = sessions[0]
    const pitch = buildPitch(session)

    const { rows: existing } = await pool.query(
      `SELECT * FROM session_debriefs WHERE session_id = $1`, [session.id]
    )
    if (existing.length) return res.json(existing[0])

    const { rows: events } = await pool.query(
      `SELECT * FROM session_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.id]
    )

    const { rows: queues } = await pool.query(
      `SELECT agent, questions FROM agent_queues WHERE session_id = $1`, [session.id]
    )
    const agentQueues = {}
    queues.forEach(q => { agentQueues[q.agent] = q.questions || [] })

    const endEvent = events.find(e => e.event_type === 'SESSION_END')
    const endReason = endEvent?.payload?.reason || 'queues_exhausted'

    const gaps = {}
    for (const [agent, queue] of Object.entries(agentQueues)) {
      if (queue.length > 0) gaps[agent] = queue
    }
    const hasGaps = Object.values(gaps).some(q => q.length > 0)

    const sidebarEvents = []

    console.log('[/debrief] all 4 agents nominating...')
    const [invNoms, compNoms, rtNoms, custNoms] = await Promise.all([
      AGENTS.investor.nominateWeaknesses(pitch, events, agentQueues.investor || []),
      AGENTS.competitor.nominateWeaknesses(pitch, events, agentQueues.competitor || []),
      AGENTS.red_team.nominateWeaknesses(pitch, events, agentQueues.red_team || []),
      AGENTS.customer.nominateWeaknesses(pitch, events, agentQueues.customer || []),
    ])

    const nominations = [
      { agent: 'investor',   nominations: invNoms },
      { agent: 'competitor', nominations: compNoms },
      { agent: 'red_team',   nominations: rtNoms },
      { agent: 'customer',   nominations: custNoms },
    ]

    for (const { agent, nominations: noms } of nominations) {
      const payload = { nominations: noms.map(n => ({ title: n.title, severity: n.severity })) }
      await postEvent(session.band_room_id, agent, 'NOMINATION', payload).catch(() => {})
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, agent, payload)
         VALUES ($1, 'NOMINATION', $2, $3)`,
        [session.id, agent, JSON.stringify(payload)]
      )
      sidebarEvents.push({ type: 'NOMINATION', agent, payload })
    }

    console.log('[/debrief] red_team arbitrating...')
    const arbitration = await AGENTS.red_team.arbitrateDebrief(nominations, pitch)

    await postEvent(session.band_room_id, 'red_team', 'FINAL_DEBRIEF', {
      ranked: arbitration.weaknesses?.map(w => w.title),
    }).catch(() => {})
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'FINAL_DEBRIEF', 'red_team', $2)`,
      [session.id, JSON.stringify({ ranked: arbitration.weaknesses?.map(w => w.title) })]
    )
    sidebarEvents.push({
      type: 'FINAL_DEBRIEF',
      agent: 'red_team',
      payload: { ranked: arbitration.weaknesses?.map(w => w.title) },
    })

    const exchangeCount = events.filter(e => e.event_type === 'FOUNDER_RESPONSE').length
    const questionsByAgent = {}
    for (const agent of AGENT_ORDER) {
      questionsByAgent[agent] = events.filter(
        e => e.event_type === 'AGENT_QUESTION' && e.agent === agent
      ).length
    }
    const hardestAgent = Object.entries(questionsByAgent).sort((a, b) => b[1] - a[1])[0]?.[0]
    const unaskedByAgent = {}
    for (const [agent, queue] of Object.entries(agentQueues)) {
      unaskedByAgent[agent] = queue.length
    }
    const sessionStats = {
      exchanges: exchangeCount,
      questionsByAgent,
      hardestAgent,
      unaskedByAgent,
      deflections: events.filter(e => e.event_type === 'DEFLECTION').length,
    }

    const { rows: saved } = await pool.query(
      `INSERT INTO session_debriefs
         (session_id, verdict, weaknesses, gaps, recommended_focus, session_stats, end_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        session.id,
        arbitration.verdict || '',
        JSON.stringify(arbitration.weaknesses || []),
        JSON.stringify(hasGaps ? gaps : {}),
        JSON.stringify(arbitration.recommended_focus || []),
        JSON.stringify(sessionStats),
        endReason,
      ]
    )

    res.json({ ...saved[0], sidebarEvents })
  } catch (err) {
    logErr('POST /sessions/:id/debrief', err)
    res.status(500).json({ error: 'Failed to generate debrief' })
  }
})

// GET /sessions/:id/debrief — return stored debrief with nomination sidebar events
router.get('/:id/debrief', requireAuth, async (req, res) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT s.id, s.round_number, s.status, p.name, p.one_liner, p.funding_amount, p.equity_percent
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })
    const session = sessions[0]

    const { rows: debriefs } = await pool.query(
      `SELECT * FROM session_debriefs WHERE session_id = $1`, [req.params.id]
    )
    if (!debriefs.length) return res.status(404).json({ error: 'Debrief not yet generated', session })

    // Rebuild nomination sidebar events from stored session_events
    const { rows: nomEvents } = await pool.query(
      `SELECT agent, event_type, payload FROM session_events
       WHERE session_id = $1 AND event_type IN ('NOMINATION', 'FINAL_DEBRIEF')
       ORDER BY created_at ASC`,
      [req.params.id]
    )
    const sidebarEvents = nomEvents.map(e => ({ type: e.event_type, agent: e.agent, payload: e.payload }))

    res.json({ ...debriefs[0], session, sidebarEvents })
  } catch (err) {
    logErr('GET /sessions/:id/debrief', err)
    res.status(500).json({ error: 'Failed to fetch debrief' })
  }
})

// GET /sessions/:id/history — full Q&A transcript as exchange pairs
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT s.id, s.round_number, s.status, s.completed_at,
              p.name, p.one_liner, p.funding_amount, p.equity_percent
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })

    const { rows: events } = await pool.query(
      `SELECT event_type, agent, payload, created_at
       FROM session_events
       WHERE session_id = $1 AND event_type IN ('AGENT_QUESTION','FOUNDER_RESPONSE')
       ORDER BY created_at ASC`,
      [req.params.id]
    )

    const exchanges = []
    let pending = null
    for (const ev of events) {
      if (ev.event_type === 'AGENT_QUESTION') {
        if (pending) exchanges.push({ ...pending, answer: null })
        pending = {
          question: ev.payload.question,
          topic: ev.payload.topic,
          agent: ev.agent,
          asked_at: ev.created_at,
          answer: null,
          answered_at: null,
        }
      } else if (ev.event_type === 'FOUNDER_RESPONSE' && pending) {
        pending.answer = ev.payload.answer
        pending.answered_at = ev.created_at
        exchanges.push(pending)
        pending = null
      }
    }
    if (pending) exchanges.push(pending)

    res.json({ session: sessions[0], exchanges })
  } catch (err) {
    logErr('GET /sessions/:id/history', err)
    res.status(500).json({ error: 'Failed to fetch session history' })
  }
})

// POST /sessions/:id/outcome — log post-meeting outcome
router.post('/:id/outcome', requireAuth, async (req, res) => {
  const { meeting_happened, outcome, main_objection, caught_off_guard, wished_prepared, investor_feedback } = req.body
  try {
    const { rows: sessions } = await pool.query(
      `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' })

    await pool.query(
      `INSERT INTO session_outcomes
         (session_id, meeting_happened, outcome, main_objection, caught_off_guard, wished_prepared, investor_feedback)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id) DO UPDATE SET
         meeting_happened = EXCLUDED.meeting_happened,
         outcome = EXCLUDED.outcome,
         main_objection = EXCLUDED.main_objection,
         caught_off_guard = EXCLUDED.caught_off_guard,
         wished_prepared = EXCLUDED.wished_prepared,
         investor_feedback = EXCLUDED.investor_feedback`,
      [req.params.id, meeting_happened ?? true, outcome || null, main_objection || null,
       caught_off_guard || null, wished_prepared || null, investor_feedback || null]
    )
    await pool.query(
      `UPDATE sessions SET outcome_logged = true WHERE id = $1`,
      [req.params.id]
    )
    res.json({ ok: true })
  } catch (err) {
    logErr('POST /sessions/:id/outcome', err)
    res.status(500).json({ error: 'Failed to save outcome' })
  }
})

// GET /sessions/:id/deepgram-token — issue a short-lived Deepgram API key for client STT
router.get('/:id/deepgram-token', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Session not found' })

    const axios = require('axios')
    const response = await axios.post(
      'https://api.deepgram.com/v1/projects/keys',
      {
        comment: 'FORGE session STT',
        scopes: ['usage:write'],
        time_to_live_in_seconds: 3600,
      },
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    )
    res.json({ key: response.data.key })
  } catch (err) {
    if (process.env.DEEPGRAM_API_KEY) {
      return res.json({ key: process.env.DEEPGRAM_API_KEY })
    }
    logErr('GET /sessions/:id/deepgram-token', err)
    res.status(500).json({ error: 'Deepgram not configured' })
  }
})

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildPitch(session) {
  return {
    name: session.name,
    one_liner: session.one_liner,
    funding_amount: session.funding_amount,
    equity_percent: session.equity_percent,
    implied_valuation: session.implied_valuation,
    stage: session.stage,
    industry: session.industry,
    traction: session.traction,
    revenue_model: session.revenue_model,
    key_metrics: session.key_metrics,
    tam: session.tam,
    competitors: session.competitors,
    known_risks: session.known_risks,
    target_customer: session.target_customer,
    team: session.team,
    problem: session.problem,
    solution: session.solution,
    use_of_funds: session.use_of_funds,
    prior_funding: session.prior_funding,
  }
}

// Pick the next agent + question from queues using rotation + 40% share cap
function pickNextQuestion(agentQueues, justAsked, askedByAgent, totalAsked) {
  const MAX_SHARE = 0.4

  const startIdx = justAsked ? (AGENT_ORDER.indexOf(justAsked) + 1) % AGENT_ORDER.length : 0

  // First pass: rotation order, respecting share cap (only enforced after 5 questions)
  for (let i = 0; i < AGENT_ORDER.length; i++) {
    const agentName = AGENT_ORDER[(startIdx + i) % AGENT_ORDER.length]
    const queue = agentQueues[agentName] || []
    if (!queue.length) continue
    const share = totalAsked > 0 ? (askedByAgent[agentName] || 0) / totalAsked : 0
    if (share >= MAX_SHARE && totalAsked >= 5) continue // only enforce cap after 5 questions
    return { nextAgent: agentName, nextQuestion: queue[0].question }
  }

  // Second pass: cap relaxed (all other agents exhausted)
  for (let i = 0; i < AGENT_ORDER.length; i++) {
    const agentName = AGENT_ORDER[(startIdx + i) % AGENT_ORDER.length]
    const queue = agentQueues[agentName] || []
    if (queue.length) return { nextAgent: agentName, nextQuestion: queue[0].question }
  }

  return { nextAgent: null, nextQuestion: null }
}

// Init all 4 agent queues in background after /start responds
async function initQueuesInBackground(sessionId, pitch) {
  console.log('[initQueues bg] starting all 4 agents...')
  const [investorQ, redteamQ] = await Promise.all([
    AGENTS.investor.initQueue(pitch),
    AGENTS.red_team.initQueue(pitch),
  ])
  const competitorQ = await AGENTS.competitor.initQueue(pitch)
  const customerQ = await AGENTS.customer.initQueue(pitch)

  await Promise.all([
    pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'investor'`,   [JSON.stringify(investorQ),   sessionId]),
    pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'competitor'`, [JSON.stringify(competitorQ), sessionId]),
    pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'red_team'`,   [JSON.stringify(redteamQ),   sessionId]),
    pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'customer'`,   [JSON.stringify(customerQ),  sessionId]),
  ])
  await pool.query(`UPDATE sessions SET queues_ready = true WHERE id = $1`, [sessionId])
  console.log('[initQueues bg] all queues ready')
}


// Updates queues with follow-ups and newly discovered questions (Shark Tank model — no cross-agent context)
async function runBackgroundEvaluation({ session, pitch, founderResponse, lastQuestion, lastTopic, lastDepth, activeAgent, agentQueues, band_room_id, sessionHistory }) {
  const results = await Promise.allSettled(
    AGENT_ORDER.map(agentName =>
      AGENTS[agentName].evaluateResponse
        ? AGENTS[agentName].evaluateResponse(
            pitch,
            founderResponse,
            lastQuestion,
            agentName === activeAgent ? lastTopic : (agentQueues[agentName]?.[0]?.topic || 'general'),
            agentName === activeAgent ? lastDepth : 0,
            agentQueues[agentName] || [],
            sessionHistory || []
          )
        : Promise.resolve(null)
    )
  )

  const annotationEvents = []

  await Promise.all(AGENT_ORDER.map(async (agentName, idx) => {
    const r = results[idx]
    if (r.status !== 'fulfilled' || !r.value) {
      if (r.status === 'rejected') logErr(`bgEval[${agentName}]`, r.reason)
      return
    }
    const eval_ = r.value

    // Persist annotation to DB and post to Band sidebar
    if (eval_.annotation) {
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, agent, payload) VALUES ($1, $2, $3, $4)`,
        [session.id, eval_.annotation.type, agentName, JSON.stringify({ ...eval_.annotation, agent: agentName })]
      )
      await postEvent(band_room_id, agentName, eval_.annotation.type, { ...eval_.annotation, agent: agentName }).catch(() => {})
      annotationEvents.push({ type: eval_.annotation.type, agent: agentName, payload: eval_.annotation })
    }

    // Reload this agent's queue fresh from DB (may have changed since we last read it)
    const { rows } = await pool.query(
      `SELECT questions FROM agent_queues WHERE session_id = $1 AND agent = $2`,
      [session.id, agentName]
    )
    let queue = rows[0]?.questions || []

    let queueChanged = false

    // Active agent: prepend follow-up at P1 if not satisfied and depth < 2
    if (agentName === activeAgent && !eval_.satisfied && eval_.followUp && lastDepth < 2) {
      const followUpItem = { question: eval_.followUp, topic: lastTopic, priority: 1, depth: lastDepth + 1 }
      queue = [followUpItem, ...queue].sort((a, b) => a.priority - b.priority)
      await postEvent(band_room_id, agentName, 'QUEUE_UPDATE', { added: [followUpItem] }).catch(() => {})
      annotationEvents.push({ type: 'QUEUE_UPDATE', agent: agentName, payload: { added: [followUpItem] } })
      queueChanged = true
    }

    // All agents: append newly discovered queue items — deduplicate by topic
    if (eval_.newQueueItems?.length) {
      const coveredTopics = new Set([
        ...(sessionHistory || []).filter(e => e.event_type === 'AGENT_QUESTION').map(e => e.payload?.topic).filter(Boolean),
        ...queue.map(q => q.topic).filter(Boolean),
      ])
      const newItems = eval_.newQueueItems
        .slice(0, 1) // hard cap: max 1 new item per agent per turn
        .map(item => ({ ...item, priority: Math.max(item.priority ?? 2, 2), depth: 0 }))
        .filter(item => item.topic && !coveredTopics.has(item.topic))
      if (newItems.length) {
        queue = [...queue, ...newItems].sort((a, b) => a.priority - b.priority)
        await postEvent(band_room_id, agentName, 'QUEUE_UPDATE', { added: newItems }).catch(() => {})
        annotationEvents.push({ type: 'QUEUE_UPDATE', agent: agentName, payload: { added: newItems } })
        queueChanged = true
      }
    }

    if (queueChanged) {
      await pool.query(
        `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`,
        [JSON.stringify(queue), session.id, agentName]
      )
    }
  }))

  return annotationEvents
}

module.exports = router
