const express = require('express')
const router = express.Router()
const pool = require('../db/pool')
const { requireAuth } = require('../middleware/requireAuth')
const { initSession } = require('../agents/bandService')

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

module.exports = router
