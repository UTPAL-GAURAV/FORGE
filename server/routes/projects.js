const express = require('express')
const router = express.Router()
const pool = require('../db/pool')
const { requireAuth } = require('../middleware/requireAuth')

function logErr(label, err) {
  console.error(`[${label}]`, err.message)
  if (err.response?.data) console.error(`[${label}] API response:`, JSON.stringify(err.response.data))
  if (err.stack) console.error(err.stack)
}

// GET all projects for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
        json_agg(
          json_build_object(
            'id', s.id,
            'round_number', s.round_number,
            'status', s.status,
            'created_at', s.created_at,
            'completed_at', s.completed_at,
            'band_room_id', s.band_room_id,
            'outcome_logged', s.outcome_logged,
            'has_debrief', (sd.id IS NOT NULL)
          ) ORDER BY s.round_number
        ) FILTER (WHERE s.id IS NOT NULL) AS sessions
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
       LEFT JOIN session_debriefs sd ON sd.session_id = s.id
       WHERE p.user_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    logErr('GET /projects', err)
    res.status(500).json({ error: 'Failed to fetch projects' })
  }
})

// POST create new project
router.post('/', requireAuth, async (req, res) => {
  const {
    name, one_liner, funding_amount, equity_percent,
    industry, stage, use_of_funds, problem, solution,
    revenue_model, traction, key_metrics, target_customer,
    tam, competitors, team, prior_funding, known_risks,
  } = req.body

  if (!name || !one_liner || !funding_amount || !equity_percent) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO projects (
        user_id, name, one_liner, funding_amount, equity_percent,
        industry, stage, use_of_funds, problem, solution,
        revenue_model, traction, key_metrics, target_customer,
        tam, competitors, team, prior_funding, known_risks
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      ) RETURNING *`,
      [
        req.user.id, name, one_liner, funding_amount, equity_percent,
        industry || null, stage || null, use_of_funds || null,
        problem || null, solution || null, revenue_model || null,
        traction || null, key_metrics || null, target_customer || null,
        tam || null, competitors || null, team || null,
        prior_funding || null, known_risks || null,
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    logErr('POST /projects', err)
    res.status(500).json({ error: 'Failed to create project' })
  }
})

// DELETE project
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
    res.json({ success: true })
  } catch (err) {
    logErr('DELETE /projects/:id', err)
    res.status(500).json({ error: 'Failed to delete project' })
  }
})

module.exports = router
