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

    const band_room_id = await initSession(project)

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

    // Stagger initQueue calls: AIML pair first, then Featherless pair (avoid simultaneous 429s)
    console.log('[/start] initQueue investor + red_team...')
    const [investorQ, redteamQ] = await Promise.all([
      AGENTS.investor.initQueue(pitch),
      AGENTS.red_team.initQueue(pitch),
    ])
    console.log('[/start] investor queue:', investorQ?.length, 'redteam queue:', redteamQ?.length)

    console.log('[/start] initQueue competitor...')
    const competitorQ = await AGENTS.competitor.initQueue(pitch)
    console.log('[/start] competitor queue:', competitorQ?.length)

    console.log('[/start] initQueue customer...')
    const customerQ = await AGENTS.customer.initQueue(pitch)
    console.log('[/start] customer queue:', customerQ?.length)

    await Promise.all([
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'investor'`, [JSON.stringify(investorQ), session.id]),
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'competitor'`, [JSON.stringify(competitorQ), session.id]),
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'red_team'`, [JSON.stringify(redteamQ), session.id]),
      pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = 'customer'`, [JSON.stringify(customerQ), session.id]),
    ])

    const firstQ = AGENTS.investor.getFirstQuestion(pitch)
    console.log('[/start] first question:', firstQ)

    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'AGENT_QUESTION', 'investor', $2)`,
      [session.id, JSON.stringify({ question: firstQ, topic: 'valuation', isFirst: true, answer: null })]
    )

    await postEvent(session.band_room_id, 'investor', 'AGENT_QUESTION', { question: firstQ, topic: 'valuation', isFirst: true })
    await postMessage(session.band_room_id, 'investor', firstQ)

    const sidebarEvent = { type: 'AGENT_QUESTION', agent: 'investor', payload: { question: firstQ, topic: 'valuation' } }
    res.json({ question: firstQ, activeAgent: 'investor', sidebarEvents: [sidebarEvent] })
  } catch (err) {
    logErr('POST /sessions/:id/start', err)
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

    await pool.query(
      `INSERT INTO session_events (session_id, event_type, agent, payload)
       VALUES ($1, 'FOUNDER_RESPONSE', NULL, $2)`,
      [session.id, JSON.stringify({ answer: founderResponse, toQuestion: lastQuestion, toAgent: activeAgent })]
    )

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

    const sidebarEvents = []

    // ── Step 1: Active agent evaluates first — determines follow-up or pass ──
    const activeEvalResult = await (AGENTS[activeAgent].evaluateResponse
      ? AGENTS[activeAgent].evaluateResponse(pitch, founderResponse, lastQuestion, agentQueues[activeAgent] || [], allAnnotations)
      : Promise.resolve(null)
    ).catch(err => { logErr(`turn activeEval[${activeAgent}]`, err); return null })

    // Persist active agent annotation + queue update immediately
    if (activeEvalResult?.annotation) {
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, agent, payload) VALUES ($1, $2, $3, $4)`,
        [session.id, activeEvalResult.annotation.type, activeAgent, JSON.stringify({ ...activeEvalResult.annotation, agent: activeAgent })]
      )
      await postEvent(session.band_room_id, activeAgent, activeEvalResult.annotation.type, { ...activeEvalResult.annotation, agent: activeAgent }).catch(() => {})
      sidebarEvents.push({ type: activeEvalResult.annotation.type, agent: activeAgent, payload: activeEvalResult.annotation })
    }
    if (activeEvalResult?.newQueueItems?.length) {
      const existing = agentQueues[activeAgent] || []
      const updated = [...existing, ...activeEvalResult.newQueueItems].sort((a, b) => a.priority - b.priority)
      await pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`, [JSON.stringify(updated), session.id, activeAgent])
      agentQueues[activeAgent] = updated
      await postEvent(session.band_room_id, activeAgent, 'QUEUE_UPDATE', { added: activeEvalResult.newQueueItems }).catch(() => {})
      sidebarEvents.push({ type: 'QUEUE_UPDATE', agent: activeAgent, payload: { added: activeEvalResult.newQueueItems } })
    }

    // ── Step 2: Active agent decides next question — before other agents run ──
    let nextQuestion = null
    let nextAgent = activeAgent
    let sessionEnded = false

    if (activeEvalResult && !activeEvalResult.satisfied && activeEvalResult.followUp) {
      nextQuestion = activeEvalResult.followUp
      await postEvent(session.band_room_id, activeAgent, 'FOLLOW_UP', { question: activeEvalResult.followUp }).catch(() => {})
      sidebarEvents.push({ type: 'FOLLOW_UP', agent: activeAgent, payload: { question: activeEvalResult.followUp } })
    } else {
      await postEvent(session.band_room_id, activeAgent, 'PASS_CONTROL', { reason: 'satisfied' }).catch(() => {})
      sidebarEvents.push({ type: 'PASS_CONTROL', agent: activeAgent, payload: { reason: 'satisfied' } })

      const nextAgentName = pickNextAgent(agentQueues, activeAgent)
      if (!nextAgentName) {
        sessionEnded = true
        await pool.query(`UPDATE sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`, [session.id])
        sidebarEvents.push({ type: 'SESSION_COMPLETE', agent: 'system', payload: { message: 'All queues exhausted' } })
      } else {
        nextAgent = nextAgentName
        const queue = agentQueues[nextAgentName] || []
        if (queue.length > 0) {
          nextQuestion = queue[0].question
          const remaining = queue.slice(1)
          await pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`, [JSON.stringify(remaining), session.id, nextAgentName])
          agentQueues[nextAgentName] = remaining
        }
      }
    }

    // ── Step 3: Other agents evaluate in background (annotations + queue only) ──
    const otherAgents = AGENT_ORDER.filter(a => a !== activeAgent)
    const otherResults = await Promise.allSettled(
      otherAgents.map(agentName =>
        AGENTS[agentName].evaluateResponse
          ? AGENTS[agentName].evaluateResponse(pitch, founderResponse, lastQuestion, agentQueues[agentName] || [], allAnnotations)
          : Promise.resolve(null)
      )
    )

    otherResults.forEach((r, i) => {
      if (r.status === 'rejected') logErr(`turn evaluateResponse[${otherAgents[i]}]`, r.reason)
    })

    await Promise.all(
      otherAgents.map(async (agentName, idx) => {
        const result = otherResults[idx]
        if (result.status !== 'fulfilled' || !result.value) return
        const evaluation = result.value

        if (evaluation.annotation) {
          await pool.query(
            `INSERT INTO session_events (session_id, event_type, agent, payload) VALUES ($1, $2, $3, $4)`,
            [session.id, evaluation.annotation.type, agentName, JSON.stringify({ ...evaluation.annotation, agent: agentName })]
          )
          await postEvent(session.band_room_id, agentName, evaluation.annotation.type, { ...evaluation.annotation, agent: agentName }).catch(() => {})
          sidebarEvents.push({ type: evaluation.annotation.type, agent: agentName, payload: evaluation.annotation })
        }
        if (evaluation.newQueueItems?.length) {
          const existing = agentQueues[agentName] || []
          const updated = [...existing, ...evaluation.newQueueItems].sort((a, b) => a.priority - b.priority)
          await pool.query(`UPDATE agent_queues SET questions = $1, updated_at = NOW() WHERE session_id = $2 AND agent = $3`, [JSON.stringify(updated), session.id, agentName])
          agentQueues[agentName] = updated
          await postEvent(session.band_room_id, agentName, 'QUEUE_UPDATE', { added: evaluation.newQueueItems }).catch(() => {})
          sidebarEvents.push({ type: 'QUEUE_UPDATE', agent: agentName, payload: { added: evaluation.newQueueItems } })
        }
      })
    )

    if (nextQuestion) {
      await pool.query(
        `INSERT INTO session_events (session_id, event_type, agent, payload)
         VALUES ($1, 'AGENT_QUESTION', $2, $3)`,
        [session.id, nextAgent, JSON.stringify({ question: nextQuestion, topic: 'follow_up', answer: null })]
      )
      await postMessage(session.band_room_id, nextAgent, nextQuestion).catch(() => {})
      await pool.query(`UPDATE sessions SET active_agent = $1 WHERE id = $2`, [nextAgent, session.id])
    }

    res.json({ question: nextQuestion, activeAgent: nextAgent, sidebarEvents, sessionEnded })
  } catch (err) {
    logErr('POST /sessions/:id/turn', err)
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

// GET /sessions/:id/debrief — return stored debrief
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

    res.json({ ...debriefs[0], session })
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

function pickNextAgent(agentQueues, justAsked) {
  // Rotate through agents in order, skipping the one that just asked.
  // Among agents with queued items, prefer the one that comes next in rotation
  // after justAsked — so no single agent monopolises when all have equal priority.
  const startIdx = justAsked ? (AGENT_ORDER.indexOf(justAsked) + 1) % AGENT_ORDER.length : 0

  // First pass: find next agent in rotation order that has a queued item
  for (let i = 0; i < AGENT_ORDER.length; i++) {
    const agentName = AGENT_ORDER[(startIdx + i) % AGENT_ORDER.length]
    if (agentName === justAsked) continue
    const queue = agentQueues[agentName] || []
    if (queue.length > 0) return agentName
  }

  // All non-active agents exhausted — allow justAsked to continue if it still has items
  if (justAsked && (agentQueues[justAsked] || []).length > 0) return justAsked

  return null
}

module.exports = router
