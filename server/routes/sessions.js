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

// POST start a new session (round) for a project
router.post('/', requireAuth, async (req, res) => {
  const { project_id } = req.body
  if (!project_id) return res.status(400).json({ error: 'project_id required' })

  try {
    // Verify project belongs to user
    const { rows: projects } = await pool.query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [project_id, req.user.id]
    )
    if (!projects.length) return res.status(404).json({ error: 'Project not found' })
    const project = projects[0]

    // Get next round number
    const { rows: existing } = await pool.query(
      'SELECT COUNT(*) FROM sessions WHERE project_id = $1',
      [project_id]
    )
    const round_number = parseInt(existing[0].count) + 1

    // Create Band room and add all 4 agents
    const band_room_id = await initSession(project)

    // Create session in DB
    const { rows } = await pool.query(
      `INSERT INTO sessions (project_id, user_id, round_number, band_room_id, active_agent)
       VALUES ($1, $2, $3, $4, 'investor') RETURNING *`,
      [project_id, req.user.id, round_number, band_room_id]
    )
    const session = rows[0]

    // Initialise empty queues for all 4 agents
    await pool.query(
      `INSERT INTO agent_queues (session_id, agent, questions) VALUES
       ($1, 'investor', '[]'),
       ($1, 'competitor', '[]'),
       ($1, 'red_team', '[]'),
       ($1, 'customer', '[]')`,
      [session.id]
    )

    // Log session start event
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, payload)
       VALUES ($1, 'SESSION_START', $2)`,
      [session.id, JSON.stringify({ round_number, band_room_id })]
    )

    res.status(201).json(session)
  } catch (err) {
    console.error('Session start error:', err.message)
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
    console.error('Session state error:', err.message)
    res.status(500).json({ error: 'Failed to fetch session state' })
  }
})

// POST /sessions/:id/start — initialise queues for all agents, return first question
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

    // Initialise all 4 agent queues in parallel
    const [investorQ, competitorQ, redteamQ, customerQ] = await Promise.all([
      AGENTS.investor.initQueue(pitch),
      AGENTS.competitor.initQueue(pitch),
      AGENTS.red_team.initQueue(pitch),
      AGENTS.customer.initQueue(pitch),
    ])

    await Promise.all([
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'investor'`, [JSON.stringify(investorQ), session.id]),
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'competitor'`, [JSON.stringify(competitorQ), session.id]),
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'red_team'`, [JSON.stringify(redteamQ), session.id]),
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'customer'`, [JSON.stringify(customerQ), session.id]),
    ])

    // Investor always opens — deterministic first question
    const firstQ = AGENTS.investor.getFirstQuestion(pitch)

    // Persist the opening question as an event
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'AGENT_QUESTION', 'investor', $2)`,
      [session.id, JSON.stringify({ question: firstQ, topic: 'valuation', isFirst: true, answer: null })]
    )

    // Post to Band room
    await postEvent(session.band_room_id, 'investor', 'AGENT_QUESTION', { question: firstQ, topic: 'valuation', isFirst: true })
    await postMessage(session.band_room_id, 'investor', firstQ)

    // Sidebar event for judge visibility
    const sidebarEvent = { type: 'AGENT_QUESTION', agent: 'investor', payload: { question: firstQ, topic: 'valuation' } }

    res.json({ question: firstQ, activeAgent: 'investor', sidebarEvents: [sidebarEvent] })
  } catch (err) {
    console.error('Session start error:', err.message)
    res.status(500).json({ error: 'Failed to start session' })
  }
})

// POST /sessions/:id/turn — submit founder response, get next question
router.post('/:id/turn', requireAuth, async (req, res) => {
  const { founderResponse, lastQuestion, activeAgent } = req.body
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

    // Persist founder response — attach to the open question event
    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'FOUNDER_RESPONSE', NULL, $2)`,
      [session.id, JSON.stringify({ answer: founderResponse, toQuestion: lastQuestion, toAgent: activeAgent })]
    )

    // Get all current queues + recent annotations
    const { rows: queues } = await pool.query(
      `SELECT agent, questions FROM agent_queues WHERE session_id = $1`,
      [session.id]
    )
    const agentQueues = {}
    queues.forEach(q => { agentQueues[q.agent] = q.questions })

    const { rows: recentAnnotations } = await pool.query(
      `SELECT payload FROM session_events
       WHERE session_id = $1 AND event_type IN ('WEAK_POINT','STRONG_POINT','CONTRADICTION','DEFLECTION')
       ORDER BY created_at DESC LIMIT 20`,
      [session.id]
    )
    const allAnnotations = recentAnnotations.map(r => r.payload)

    // All 4 agents evaluate in parallel (silent — only active agent controls question)
    const sidebarEvents = []

    const evaluationResults = await Promise.allSettled(
      AGENT_ORDER.map(agentName => {
        const currentQueue = agentQueues[agentName] || []
        return AGENTS[agentName].evaluateResponse
          ? AGENTS[agentName].evaluateResponse(pitch, founderResponse, lastQuestion, currentQueue, allAnnotations)
          : Promise.resolve(null)
      })
    )

    // Persist annotations and queue updates for all agents
    await Promise.all(
      AGENT_ORDER.map(async (agentName, idx) => {
        const result = evaluationResults[idx]
        if (result.status !== 'fulfilled' || !result.value) return

        const evaluation = result.value

        // Persist annotation
        if (evaluation.annotation) {
          await pool.query(
            `INSERT INTO session_events (session_id, event_type, agent, payload)
             VALUES ($1, $2, $3, $4)`,
            [session.id, evaluation.annotation.type, agentName, JSON.stringify({ ...evaluation.annotation, agent: agentName })]
          )
          // Post to Band
          await postEvent(session.band_room_id, agentName, evaluation.annotation.type, { ...evaluation.annotation, agent: agentName }).catch(() => {})
          sidebarEvents.push({ type: evaluation.annotation.type, agent: agentName, payload: evaluation.annotation })
        }

        // Update queue with new items
        if (evaluation.newQueueItems?.length) {
          const existing = agentQueues[agentName] || []
          const updated = [...existing, ...evaluation.newQueueItems].sort((a, b) => a.priority - b.priority)
          await pool.query(
            `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`,
            [JSON.stringify(updated), session.id, agentName]
          )
          agentQueues[agentName] = updated
          await postEvent(session.band_room_id, agentName, 'QUEUE_UPDATE', { added: evaluation.newQueueItems }).catch(() => {})
          sidebarEvents.push({ type: 'QUEUE_UPDATE', agent: agentName, payload: { added: evaluation.newQueueItems } })
        }
      })
    )

    // Active agent decides: follow up or pass control
    const activeEvalIdx = AGENT_ORDER.indexOf(activeAgent)
    const activeEval = activeEvalIdx >= 0 && evaluationResults[activeEvalIdx].status === 'fulfilled'
      ? evaluationResults[activeEvalIdx].value
      : null

    let nextQuestion = null
    let nextAgent = activeAgent
    let sessionEnded = false

    if (activeEval && !activeEval.satisfied && activeEval.followUp) {
      // Follow up from same agent
      nextQuestion = activeEval.followUp
      await postEvent(session.band_room_id, activeAgent, 'FOLLOW_UP', { question: activeEval.followUp }).catch(() => {})
      sidebarEvents.push({ type: 'FOLLOW_UP', agent: activeAgent, payload: { question: activeEval.followUp } })
    } else {
      // Pass control — find next agent with highest-priority queued item
      await postEvent(session.band_room_id, activeAgent, 'PASS_CONTROL', { reason: 'satisfied' }).catch(() => {})
      sidebarEvents.push({ type: 'PASS_CONTROL', agent: activeAgent, payload: { reason: 'satisfied' } })

      const nextAgentName = pickNextAgent(agentQueues)

      if (!nextAgentName) {
        // All queues exhausted — session ends
        sessionEnded = true
        await pool.query(
          `UPDATE sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [session.id]
        )
        sidebarEvents.push({ type: 'SESSION_COMPLETE', agent: 'system', payload: { message: 'All queues exhausted' } })
      } else {
        nextAgent = nextAgentName
        const queue = agentQueues[nextAgentName] || []
        if (queue.length > 0) {
          nextQuestion = queue[0].question
          // Remove asked question from queue
          const remaining = queue.slice(1)
          await pool.query(
            `UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`,
            [JSON.stringify(remaining), session.id, nextAgentName]
          )
          agentQueues[nextAgentName] = remaining
        }
      }
    }

    // Remove the asked question from active agent's queue for follow-ups (it's being asked now)
    if (nextQuestion && nextAgent === activeAgent) {
      // Already managed above for follow-up — nothing to pop
    } else if (nextQuestion && nextAgent !== activeAgent) {
      // Already popped from nextAgent's queue above
    }

    // Persist next question event
    if (nextQuestion) {
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, agent, payload)
         VALUES ($1, 'AGENT_QUESTION', $2, $3)`,
        [session.id, nextAgent, JSON.stringify({ question: nextQuestion, topic: 'follow_up', answer: null })]
      )
      await postMessage(session.band_room_id, nextAgent, nextQuestion).catch(() => {})
      // Update active agent in session
      await pool.query(`UPDATE sessions SET active_agent = $1 WHERE id = $2`, [nextAgent, session.id])
    }

    res.json({
      question: nextQuestion,
      activeAgent: nextAgent,
      sidebarEvents,
      sessionEnded,
    })
  } catch (err) {
    console.error('Turn error:', err.message, err.stack)
    res.status(500).json({ error: 'Failed to process turn' })
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
    res.status(500).json({ error: 'Failed to end session' })
  }
})

// POST /sessions/:id/debrief — run debrief generation: all 4 agents nominate, Red Team arbitrates
router.post('/:id/debrief', requireAuth, async (req, res) => {
  try {
    // Ensure debriefs table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_debriefs (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL UNIQUE,
        verdict TEXT,
        weaknesses JSONB,
        gaps JSONB,
        recommended_focus JSONB,
        session_stats JSONB,
        end_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    // Load session + pitch
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

    // Return cached debrief if already generated
    const { rows: existing } = await pool.query(
      `SELECT * FROM session_debriefs WHERE session_id = $1`, [session.id]
    )
    if (existing.length) return res.json(existing[0])

    // Load all session events
    const { rows: events } = await pool.query(
      `SELECT * FROM session_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.id]
    )

    // Load remaining queues
    const { rows: queues } = await pool.query(
      `SELECT agent, questions FROM agent_queues WHERE session_id = $1`, [session.id]
    )
    const agentQueues = {}
    queues.forEach(q => { agentQueues[q.agent] = q.questions || [] })

    // Determine end reason
    const endEvent = events.find(e => e.event_type === 'SESSION_END')
    const endReason = endEvent?.payload?.reason || 'queues_exhausted'

    // Unasked questions per agent (remaining queue items at session end)
    const gaps = {}
    for (const [agent, queue] of Object.entries(agentQueues)) {
      if (queue.length > 0) gaps[agent] = queue
    }
    const hasGaps = Object.values(gaps).some(q => q.length > 0)

    // ── Step 1: All 4 agents nominate weaknesses in parallel ──────────────────
    const sidebarEvents = []

    const [invNoms, compNoms, rtNoms, custNoms] = await Promise.all([
      AGENTS.investor.nominateWeaknesses(pitch, events, agentQueues.investor || []),
      AGENTS.competitor.nominateWeaknesses(pitch, events, agentQueues.competitor || []),
      AGENTS.red_team.nominateWeaknesses(pitch, events, agentQueues.red_team || []),
      AGENTS.customer.nominateWeaknesses(pitch, events, agentQueues.customer || []),
    ])

    // Post nomination events to Band sidebar
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

    // ── Step 2: Red Team arbitrates ───────────────────────────────────────────
    const arbitration = await AGENTS.red_team.arbitrateDebrief(nominations, pitch)

    // Post final debrief event to Band
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

    // ── Step 3: Session stats (for judge sidebar) ─────────────────────────────
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
    const deflectionCount = events.filter(e => e.event_type === 'DEFLECTION').length
    const sessionStats = {
      exchanges: exchangeCount,
      questionsByAgent,
      hardestAgent,
      unaskedByAgent,
      deflections: deflectionCount,
    }

    // ── Step 4: Persist debrief ───────────────────────────────────────────────
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
    console.error('Debrief error:', err.message, err.stack)
    res.status(500).json({ error: 'Failed to generate debrief' })
  }
})

// GET /sessions/:id/debrief — return stored debrief
router.get('/:id/debrief', requireAuth, async (req, res) => {
  try {
    // Ensure table exists before querying
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_debriefs (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL UNIQUE,
        verdict TEXT,
        weaknesses JSONB,
        gaps JSONB,
        recommended_focus JSONB,
        session_stats JSONB,
        end_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    // Verify ownership via session
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

    res.json({ ...debriefs[0], session })
  } catch (err) {
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

    // Pair each AGENT_QUESTION with the FOUNDER_RESPONSE that followed it
    const exchanges = []
    let pending = null
    for (const ev of events) {
      if (ev.event_type === 'AGENT_QUESTION') {
        if (pending) exchanges.push({ ...pending, answer: null }) // unanswered question
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
    if (pending) exchanges.push(pending) // trailing unanswered question

    res.json({ session: sessions[0], exchanges })
  } catch (err) {
    console.error('History error:', err.message)
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

    // Upsert outcome — one per session
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_outcomes (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL UNIQUE,
        meeting_happened BOOLEAN,
        outcome TEXT,
        main_objection TEXT,
        caught_off_guard TEXT,
        wished_prepared TEXT,
        investor_feedback TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
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
    // Mark session as outcome logged
    await pool.query(
      `UPDATE sessions SET outcome_logged = true WHERE id = $1`,
      [req.params.id]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Outcome error:', err.message)
    res.status(500).json({ error: 'Failed to save outcome' })
  }
})

// GET /sessions/:id/deepgram-token — issue a short-lived Deepgram API key for client STT
router.get('/:id/deepgram-token', requireAuth, async (req, res) => {
  try {
    // Verify session belongs to user
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
    // If Deepgram key creation fails (e.g. key not configured), fall back to passing the main key
    // This is acceptable for dev/demo — in prod you'd want scoped keys
    if (process.env.DEEPGRAM_API_KEY) {
      return res.json({ key: process.env.DEEPGRAM_API_KEY })
    }
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

function pickNextAgent(agentQueues) {
  // Find agent (other than current) with highest-priority (lowest priority number) queued item
  let best = null
  let bestPriority = Infinity

  for (const agentName of AGENT_ORDER) {
    const queue = agentQueues[agentName] || []
    if (queue.length > 0) {
      const topPriority = queue[0].priority ?? 3
      if (topPriority < bestPriority) {
        bestPriority = topPriority
        best = agentName
      }
    }
  }

  // If current agent still has items and no other agent has higher priority, stay
  return best
}

module.exports = router
