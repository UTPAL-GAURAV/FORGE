const axios = require('axios')

const BAND_BASE = 'https://app.band.ai/api/v1/agent'

const agents = {
  investor:   { key: process.env.INVESTOR_BAND_KEY,   uuid: process.env.INVESTOR_BAND_UUID },
  competitor: { key: process.env.COMPETITOR_BAND_KEY, uuid: process.env.COMPETITOR_BAND_UUID },
  red_team:   { key: process.env.REDTEAM_BAND_KEY,    uuid: process.env.REDTEAM_BAND_UUID },
  customer:   { key: process.env.CUSTOMER_BAND_KEY,   uuid: process.env.CUSTOMER_BAND_UUID },
}

function headers(apiKey) {
  return { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }
}

// Create a new Band chat room (called as Investor agent)
async function createRoom(projectName, roundNumber) {
  const res = await axios.post(
    `${BAND_BASE}/chats`,
    { chat: {} },
    { headers: headers(agents.investor.key) }
  )
  return res.data.data.id
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Add one agent at a time to the room (Band requires individual participant adds)
async function addAgentsToRoom(roomId) {
  const others = [agents.competitor.uuid, agents.red_team.uuid, agents.customer.uuid]
  for (const uuid of others) {
    await axios.post(
      `${BAND_BASE}/chats/${roomId}/participants`,
      { participant: { participant_id: uuid } },
      { headers: headers(agents.investor.key) }
    ).catch(() => {}) // ignore if already a participant
    await sleep(300)
  }
}

// Post the pitch context brief as a structured event
async function postPitchBrief(roomId, project) {
  const brief = buildBrief(project)
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/events`,
    { event: { content: JSON.stringify({ type: 'PITCH_BRIEF', payload: brief }), message_type: 'task' } },
    { headers: headers(agents.investor.key) }
  )
}

// Post a structured annotation event (WEAK_POINT, QUEUE_ADD, PASS_CONTROL, etc.)
async function postEvent(roomId, agentName, eventType, payload) {
  const agentKey = agents[agentName]?.key
  if (!agentKey) throw new Error(`Unknown agent: ${agentName}`)
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/events`,
    { event: { content: JSON.stringify({ type: eventType, agent: agentName, payload }), message_type: 'task' } },
    { headers: headers(agentKey) }
  )
}

// Post a visible question message — mention all other agents so they receive it
async function postMessage(roomId, agentName, text) {
  const agentKey = agents[agentName]?.key
  if (!agentKey) throw new Error(`Unknown agent: ${agentName}`)
  // Mention the other three agents so they see the message
  const otherUuids = Object.entries(agents)
    .filter(([name]) => name !== agentName)
    .map(([, a]) => ({ id: a.uuid }))
  await axios.post(
    `${BAND_BASE}/chats/${roomId}/messages`,
    { message: { content: text, mentions: otherUuids } },
    { headers: headers(agentKey) }
  )
}

// Full session start: create room, add agents, post brief
async function initSession(project) {
  const roomId = await createRoom(project.name, project.round_number)
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
