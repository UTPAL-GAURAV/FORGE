import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { API_URL } from '../context/AuthContext'

const SEVERITY_META = {
  deal_killer: { label: 'Deal-killer', color: '#ff4747', bg: 'rgba(255,71,71,0.08)', dot: '🔴' },
  high_risk:   { label: 'High risk',   color: '#ff8c47', bg: 'rgba(255,140,71,0.08)', dot: '🟠' },
  needs_work:  { label: 'Needs work',  color: '#e8c447', bg: 'rgba(232,196,71,0.08)', dot: '🟡' },
}

const AGENT_META = {
  investor:   { label: 'Investor',   color: '#e8ff47' },
  competitor: { label: 'Competitor', color: '#ff8c47' },
  red_team:   { label: 'Red Team',   color: '#ff4747' },
  customer:   { label: 'Customer',   color: '#47c8ff' },
}

const NOMINATION_COLOR = {
  investor:   '#e8ff47',
  competitor: '#ff8c47',
  red_team:   '#ff4747',
  customer:   '#47c8ff',
}

export default function Debrief() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [state, setState] = useState('loading') // loading | generating | ready | error
  const [debrief, setDebrief] = useState(null)
  const [session, setSession] = useState(null)
  const [sidebarEvents, setSidebarEvents] = useState([])
  const [error, setError] = useState(null)
  const sidebarEndRef = useRef(null)

  useEffect(() => {
    sidebarEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sidebarEvents])

  useEffect(() => {
    loadDebrief()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function loadDebrief() {
    setState('loading')
    try {
      // Try to fetch existing debrief first
      const r = await fetch(`${API_URL}/api/sessions/${id}/debrief`, { credentials: 'include' })
      const data = await r.json()

      if (r.ok) {
        setDebrief(data)
        setSession(data.session)
        setState('ready')
        return
      }

      // Not generated yet — generate now
      if (data.error === 'Debrief not yet generated') {
        setSession(data.session)
        setState('generating')
        await generateDebrief()
        return
      }

      throw new Error(data.error || 'Failed to load debrief')
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }

  async function generateDebrief() {
    try {
      const r = await fetch(`${API_URL}/api/sessions/${id}/debrief`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)

      if (data.sidebarEvents) {
        // Drip sidebar events with small delays for visual effect
        data.sidebarEvents.forEach((ev, i) => {
          setTimeout(() => {
            setSidebarEvents(prev => [...prev, { ...ev, ts: new Date().toISOString() }])
          }, i * 400)
        })
      }

      setDebrief(data)
      setState('ready')
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }

  if (state === 'loading') {
    return (
      <div className="debrief-loading">
        <div className="debrief-loading-dots"><span/><span/><span/></div>
        <p>Loading debrief...</p>
      </div>
    )
  }

  if (state === 'generating') {
    return (
      <div className="debrief-loading">
        <div className="debrief-generating-header">
          <span className="debrief-logo">FORGE<span className="accent">.</span></span>
        </div>
        <div className="debrief-generating-body">
          <div className="debrief-loading-dots"><span/><span/><span/></div>
          <h2>Generating your debrief...</h2>
          <p>All four agents are submitting their nominations. Red Team is arbitrating.</p>
        </div>
        {sidebarEvents.length > 0 && (
          <div className="debrief-generating-events">
            {sidebarEvents.map((ev, i) => (
              <GeneratingEvent key={i} event={ev} />
            ))}
          </div>
        )}
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="debrief-loading">
        <p className="debrief-error">{error || 'Failed to generate debrief'}</p>
        <button className="btn-ghost" onClick={() => navigate('/dashboard')}>← Dashboard</button>
      </div>
    )
  }

  const weaknesses = debrief?.weaknesses || []
  const gaps = debrief?.gaps || {}
  const recommended = debrief?.recommended_focus || []
  const stats = debrief?.session_stats || {}
  const hasGaps = Object.values(gaps).some(q => q?.length > 0)
  const endReason = debrief?.end_reason

  const roundNum = session?.round_number || 1
  const pitchName = session?.name || 'Pitch'

  return (
    <div className="debrief-layout">
      {/* ── LEFT: Report ── */}
      <div className="debrief-main">
        <div className="debrief-main-inner">

          {/* Header */}
          <div className="debrief-header">
            <div className="debrief-header-nav">
              <button className="debrief-back-btn" onClick={() => navigate('/dashboard')}>← Dashboard</button>
            </div>
            <div className="debrief-title-row">
              <span className="debrief-logo-sm">FORGE<span className="accent">.</span></span>
              <h1 className="debrief-title">{pitchName} — Round {roundNum} Debrief</h1>
            </div>
            <div className="debrief-meta">
              {stats.exchanges != null && <span>{stats.exchanges} exchanges</span>}
              <span>·</span>
              <span>4 agents</span>
              {debrief?.created_at && (
                <>
                  <span>·</span>
                  <span>{new Date(debrief.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                </>
              )}
            </div>
          </div>

          {/* Section 1: Verdict */}
          <section className="debrief-section">
            <div className="debrief-section-label">Verdict</div>
            <div className="debrief-verdict">{debrief?.verdict || 'No verdict generated.'}</div>
          </section>

          {/* Section 2: Top 5 Weaknesses */}
          <section className="debrief-section">
            <div className="debrief-section-label">Top {weaknesses.length} Weaknesses — ranked by deal-kill probability</div>
            {weaknesses.length === 0 ? (
              <p className="debrief-empty">No weaknesses were nominated.</p>
            ) : (
              <div className="debrief-weakness-list">
                {weaknesses.map((w, i) => (
                  <WeaknessCard key={i} weakness={w} rank={i + 1} />
                ))}
              </div>
            )}
          </section>

          {/* Section 3: Gaps (only if session ended early) */}
          {hasGaps && endReason !== 'queues_exhausted' && (
            <section className="debrief-section">
              <div className="debrief-section-label">Gaps You Never Had to Defend</div>
              <div className="debrief-gaps-intro">
                {endReason === 'founder_ended'
                  ? 'You ended the session early. These questions were waiting.'
                  : 'Time ran out before these could be asked.'}
              </div>
              <div className="debrief-gaps-list">
                {Object.entries(gaps).map(([agent, queue]) =>
                  (queue || []).map((q, i) => (
                    <GapItem key={`${agent}-${i}`} agent={agent} question={q.question} topic={q.topic} />
                  ))
                )}
              </div>
            </section>
          )}

          {/* Section 4: Recommended Focus */}
          {recommended.length > 0 && (
            <section className="debrief-section">
              <div className="debrief-section-label">Recommended Focus Before Next Session</div>
              <ul className="debrief-focus-list">
                {recommended.map((item, i) => (
                  <li key={i} className="debrief-focus-item">
                    <span className="debrief-focus-bullet">→</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Footer */}
          <div className="debrief-footer">
            <button className="btn-primary" onClick={() => navigate('/dashboard')}>
              Start Round {roundNum + 1} →
            </button>
            <button className="btn-ghost" onClick={() => navigate('/dashboard')}>
              Log Meeting Outcome
            </button>
          </div>

        </div>
      </div>

      {/* ── RIGHT: Agent Activity + Stats ── */}
      <div className="debrief-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">Agent Activity</span>
        </div>

        {/* Session Stats */}
        {stats.exchanges != null && (
          <div className="debrief-stats">
            <div className="debrief-stat-row">
              <span className="debrief-stat-label">Exchanges</span>
              <span className="debrief-stat-value">{stats.exchanges}</span>
            </div>
            {stats.hardestAgent && (
              <div className="debrief-stat-row">
                <span className="debrief-stat-label">Most questions</span>
                <span className="debrief-stat-value" style={{ color: AGENT_META[stats.hardestAgent]?.color }}>
                  {AGENT_META[stats.hardestAgent]?.label}
                </span>
              </div>
            )}
            {stats.deflections > 0 && (
              <div className="debrief-stat-row">
                <span className="debrief-stat-label">Deflections</span>
                <span className="debrief-stat-value debrief-stat-warn">{stats.deflections}</span>
              </div>
            )}
            {stats.questionsByAgent && (
              <div className="debrief-agent-stats">
                {Object.entries(stats.questionsByAgent).map(([agent, count]) => (
                  <div key={agent} className="debrief-agent-stat">
                    <span className="debrief-agent-stat-name" style={{ color: AGENT_META[agent]?.color }}>
                      {AGENT_META[agent]?.label}
                    </span>
                    <span className="debrief-agent-stat-asked">{count} asked</span>
                    {stats.unaskedByAgent?.[agent] > 0 && (
                      <span className="debrief-agent-stat-unasked">
                        {stats.unaskedByAgent[agent]} unasked
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="sidebar-divider" />

        {/* Nomination events */}
        <div className="sidebar-events" style={{ flex: 1 }}>
          {sidebarEvents.length === 0 ? (
            <div className="sidebar-empty">Debrief nomination events will appear here.</div>
          ) : (
            sidebarEvents.map((ev, i) => <DebriefSidebarEvent key={i} event={ev} />)
          )}
          <div ref={sidebarEndRef} />
        </div>
      </div>
    </div>
  )
}

function WeaknessCard({ weakness, rank }) {
  const sev = SEVERITY_META[weakness.severity] || SEVERITY_META.needs_work
  const agentMeta = AGENT_META[weakness.asked_by]
  return (
    <div className="weakness-card" style={{ borderLeftColor: sev.color, background: sev.bg }}>
      <div className="weakness-card-top">
        <span className="weakness-rank">#{rank}</span>
        <span className="weakness-severity" style={{ color: sev.color }}>{sev.dot} {sev.label}</span>
        {weakness.from_unasked && (
          <span className="weakness-unasked-badge">Never asked</span>
        )}
      </div>
      <h3 className="weakness-title">{weakness.title}</h3>
      {weakness.what_exposed && (
        <div className="weakness-block">
          <span className="weakness-block-label">What was exposed</span>
          <p>{weakness.what_exposed}</p>
        </div>
      )}
      {weakness.why_dangerous && (
        <div className="weakness-block">
          <span className="weakness-block-label">Why it's dangerous</span>
          <p>{weakness.why_dangerous}</p>
        </div>
      )}
      {weakness.what_to_fix && (
        <div className="weakness-block weakness-fix">
          <span className="weakness-block-label">What to fix</span>
          <p>{weakness.what_to_fix}</p>
        </div>
      )}
      {agentMeta && (
        <div className="weakness-agent" style={{ color: agentMeta.color }}>
          Asked by {agentMeta.label}
        </div>
      )}
    </div>
  )
}

function GapItem({ agent, question, topic }) {
  const meta = AGENT_META[agent]
  return (
    <div className="gap-item">
      <span className="gap-agent" style={{ color: meta?.color }}>{meta?.label}</span>
      <span className="gap-question">{question}</span>
      {topic && <span className="gap-topic">{topic}</span>}
    </div>
  )
}

function GeneratingEvent({ event }) {
  const color = NOMINATION_COLOR[event.agent] || '#888'
  const label = event.type === 'NOMINATION' ? 'NOMINATION' : event.type === 'FINAL_DEBRIEF' ? 'FINAL DEBRIEF' : event.type
  const detail = event.type === 'NOMINATION'
    ? event.payload?.nominations?.map(n => n.title).join(', ')
    : event.type === 'FINAL_DEBRIEF'
      ? event.payload?.ranked?.join(', ')
      : null
  return (
    <div className="generating-event">
      <span className="generating-event-agent" style={{ color }}>[{(AGENT_META[event.agent]?.label || event.agent).toUpperCase()}]</span>
      {' → '}
      <span className="generating-event-type">{label}</span>
      {detail && <span className="generating-event-detail"> · {detail}</span>}
    </div>
  )
}

function DebriefSidebarEvent({ event }) {
  const agentMeta = AGENT_META[event.agent]
  const color = NOMINATION_COLOR[event.agent] || '#888'
  const isDebrief = event.type === 'FINAL_DEBRIEF'

  return (
    <div className={`sidebar-event ${isDebrief ? 'sidebar-event-final' : ''}`}>
      <div className="sidebar-event-row">
        {agentMeta && (
          <span className="sidebar-event-agent" style={{ color }}>
            [{agentMeta.label.toUpperCase()}]
          </span>
        )}
        <span className="sidebar-event-type" style={{ color: isDebrief ? '#47ff8c' : color }}>
          {isDebrief ? 'FINAL DEBRIEF' : 'NOMINATION'}
        </span>
      </div>
      {event.payload?.nominations && (
        <div className="sidebar-event-detail">
          {event.payload.nominations.map((n, i) => (
            <div key={i}>{n.title}</div>
          ))}
        </div>
      )}
      {isDebrief && event.payload?.ranked && (
        <div className="sidebar-event-detail">
          {event.payload.ranked.slice(0, 3).map((t, i) => (
            <div key={i}>#{i + 1} {t}</div>
          ))}
        </div>
      )}
    </div>
  )
}
