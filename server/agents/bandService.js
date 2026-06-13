const axios = require('axios')

const BAND_BASE = 'https://app.band.ai/api/v1/agent'

const agents = {
  investor:   { key: process.env.INVESTOR_BAND_KEY,   uuid: process.env.INVESTOR_BAND_UUID },
  competitor: { key: process.env.COMPETITOR_BAND_KEY, uuid: process.env.COMPETITOR_BAND_UUID },
  red_team:   { key: process.env.REDTEAM_BAND_KEY,    uuid: process.env.REDTEAM_BAND_UUID },
  customer:   { key: process.env.CUSTOMER_BAND_KEY,   uuid: process.env.CUSTOMER_BAND_UUID },
}

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

// Create a new Band chat room (called as Investor agent — the session host)
async function createRoom(projectName) {
  const res = await axios.post(
    `${BAND_BASE}/chats`,
    { name: `FORGE | ${projectName}` },
    { headers: headers(agents.investor.key) }
  )
  return res.data.id
}

// Add all 4 agents to the room
async function addAgentsToRoom(roomId) {
  const agentUuids = [
    agents.competitor.uuid,
    agents.red_team.uuid,
    agents.customer.uuid,
  ]
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/participants`,
    { agent_ids: agentUuids },
    { headers: headers(agents.investor.key) }
  )
}

// Post the pitch context brief to the room as a system event
async function postPitchBrief(roomId, project) {
  const brief = buildBrief(project)
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/events`,
    {
      type: 'PITCH_BRIEF',
      payload: brief,
    },
    { headers: headers(agents.investor.key) }
  )
}

// Post a structured annotation event (WEAK_POINT, QUEUE_ADD, PASS_CONTROL, etc.)
async function postEvent(roomId, agentName, eventType, payload) {
  const agentKey = agents[agentName]?.key
  if (!agentKey) throw new Error(`Unknown agent: ${agentName}`)
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/events`,
    { type: eventType, agent: agentName, payload },
    { headers: headers(agentKey) }
  )
}

// Post a visible message to the founder
async function postMessage(roomId, agentName, text, mentionHandle) {
  const agentKey = agents[agentName]?.key
  if (!agentKey) throw new Error(`Unknown agent: ${agentName}`)
  const content = mentionHandle ? `@${mentionHandle} ${text}` : text
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/messages`,
    { content },
    { headers: headers(agentKey) }
  )
}

// Full session start: create room, add agents, post brief
async function initSession(project) {
  const roomId = await createRoom(project.name)
  await addAgentsToRoom(roomId)
  await postPitchBrief(roomId, project)
  return roomId
}

function buildBrief(p) {
  return {
    pitch_name: p.name,
    one_liner: p.one_liner,
    funding_amount: p.funding_amount,
    equity_percent: p.equity_percent,
    implied_valuation: p.implied_valuation,
    stage: p.stage || null,
    industry: p.industry || null,
    use_of_funds: p.use_of_funds || null,
    problem: p.problem || null,
    solution: p.solution || null,
    revenue_model: p.revenue_model || null,
    traction: p.traction || null,
    key_metrics: p.key_metrics || null,
    target_customer: p.target_customer || null,
    tam: p.tam || null,
    competitors: p.competitors || null,
    team: p.team || null,
    prior_funding: p.prior_funding || null,
    known_risks: p.known_risks || null,
  }
}

module.exports = { initSession, postEvent, postMessage, agents, BAND_BASE, headers }
