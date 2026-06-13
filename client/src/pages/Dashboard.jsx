import { useState, useEffect, useCallback } from 'react'
import { useAuth, API_URL } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'

const OPTIONAL_FIELDS = [
  'industry', 'stage', 'use_of_funds', 'problem', 'solution',
  'revenue_model', 'traction', 'key_metrics', 'target_customer',
  'tam', 'competitors', 'team', 'prior_funding', 'known_risks',
]
const COMPLETENESS_HINTS = {
  industry: 'industry', stage: 'stage', use_of_funds: 'use of funds',
  problem: 'problem statement', solution: 'solution', revenue_model: 'revenue model',
  traction: 'traction', key_metrics: 'key metrics', target_customer: 'target customer',
  tam: 'market size', competitors: 'competitor info', team: 'team info',
  prior_funding: 'prior funding', known_risks: 'known risks',
}
function completeness(form) {
  const filled = OPTIONAL_FIELDS.filter(f => form[f]?.trim())
  const pct = Math.round((filled.length / OPTIONAL_FIELDS.length) * 100)
  const missing = OPTIONAL_FIELDS.filter(f => !form[f]?.trim())
  const hint = missing.length > 0 ? `add ${COMPLETENESS_HINTS[missing[0]]} to sharpen agent attacks` : 'fully loaded'
  return { pct, hint }
}

const AGENT_META = {
  investor:   { label: 'Investor',   color: '#e8ff47' },
  competitor: { label: 'Competitor', color: '#ff8c47' },
  red_team:   { label: 'Red Team',   color: '#ff4747' },
  customer:   { label: 'Customer',   color: '#47c8ff' },
}

export default function Dashboard() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showNewProject, setShowNewProject] = useState(false)
  const [historySession, setHistorySession] = useState(null) // { id, name, round }
  const [outcomeSession, setOutcomeSession] = useState(null) // session object
  const [detailProject, setDetailProject] = useState(null) // project object

  const reload = useCallback(() => {
    fetch(`${API_URL}/api/projects`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { setProjects(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { reload() }, [reload])

  const onProjectCreated = (project) => {
    setProjects(p => [{ ...project, sessions: [] }, ...p])
    setShowNewProject(false)
  }

  return (
    <div className="dash-layout">
      <aside className="dash-sidebar">
        <div className="dash-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>FORGE<span>.</span></div>
        <nav className="dash-nav">
          <a className="dash-nav-item active" href="/dashboard"><span>⚡</span> Sessions</a>
        </nav>
        <div className="dash-sidebar-bottom">
          <div className="dash-user">
            {user?.avatar_url && <img src={user.avatar_url} alt="" className="dash-avatar" />}
            <div className="dash-user-info">
              <div className="dash-user-name">{user?.name || 'Founder'}</div>
              <div className="dash-user-email">{user?.email}</div>
            </div>
          </div>
          <button className="dash-logout" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="dash-main">
        <div className="dash-inner">
          <div className="dash-header">
            <div>
              <h1 className="dash-title">Your Pitches</h1>
              <p className="dash-subtitle">Each project is a pitch. Each round is a session.</p>
            </div>
            <button className="btn-primary" onClick={() => setShowNewProject(true)}>+ New Project</button>
          </div>

          {loading ? (
            <div className="empty-state"><p style={{ color: 'var(--text-muted)' }}>Loading...</p></div>
          ) : projects.length === 0 ? (
            <EmptyState onNew={() => setShowNewProject(true)} />
          ) : (
            <div className="project-list">
              {projects.map(p => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onViewHistory={(s) => setHistorySession(s)}
                  onLogOutcome={(s) => setOutcomeSession(s)}
                  onViewDetail={(p) => setDetailProject(p)}
                  onReload={reload}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={onProjectCreated} />
      )}

      {historySession && (
        <SessionHistoryDrawer session={historySession} onClose={() => setHistorySession(null)} />
      )}

      {outcomeSession && (
        <OutcomeLoggerModal
          session={outcomeSession}
          onClose={() => setOutcomeSession(null)}
          onSaved={() => { setOutcomeSession(null); reload() }}
        />
      )}
      {detailProject && (
        <ProjectDetailModal project={detailProject} onClose={() => setDetailProject(null)} />
      )}
    </div>
  )
}

function EmptyState({ onNew }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">🎯</div>
      <h2>No pitches yet.</h2>
      <p>Create your first project and face the panel.</p>
      <button className="btn-primary" onClick={onNew}>+ New Project</button>
    </div>
  )
}

function ProjectCard({ project, onViewHistory, onLogOutcome, onViewDetail, onReload }) {
  const [open, setOpen] = useState(true)
  const [starting, setStarting] = useState(false)
  const navigate = useNavigate()

  const sessions = project.sessions || []
  const completedCount = sessions.filter(s => s.status === 'completed').length
  const nextRound = sessions.length + 1

  const startSession = async () => {
    setStarting(true)
    try {
      const r = await fetch(`${API_URL}/api/sessions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: project.id }),
      })
      const session = await r.json()
      if (!r.ok) throw new Error(session.error)
      navigate(`/session/${session.id}`)
    } catch (e) {
      alert('Failed to start session: ' + e.message)
      setStarting(false)
    }
  }

  return (
    <div className="project-card">
      <button className="project-card-header" onClick={() => setOpen(o => !o)}>
        <div className="project-card-left">
          <span className="project-folder">📁</span>
          <div>
            <div className="project-name">{project.name}</div>
            <div className="project-meta">{project.one_liner}</div>
          </div>
        </div>
        <div className="project-card-right">
          {sessions.length > 0 && (
            <span className="project-round-badge">{completedCount}/{sessions.length} rounds</span>
          )}
          <button
            className="project-info-btn"
            onClick={e => { e.stopPropagation(); onViewDetail(project) }}
            title="View pitch details"
          >ⓘ</button>
          <span className="project-chevron">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="project-rounds">
          {sessions.length === 0 ? (
            <div className="round-empty">
              No sessions yet.{' '}
              <button className="link-btn" onClick={startSession} disabled={starting}>
                {starting ? 'Starting...' : 'Start Round 1 →'}
              </button>
            </div>
          ) : (
            <>
              {sessions.map(s => (
                <RoundRow
                  key={s.id}
                  session={s}
                  projectName={project.name}
                  onViewHistory={onViewHistory}
                  onLogOutcome={onLogOutcome}
                />
              ))}
              {/* Start next round only if last session is completed */}
              {sessions[sessions.length - 1]?.status === 'completed' && (
                <div className="round-new-row">
                  <button className="btn-primary" style={{ fontSize: 13, padding: '9px 18px' }} onClick={startSession} disabled={starting}>
                    {starting ? 'Starting...' : `+ Start Round ${nextRound}`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RoundRow({ session, projectName, onViewHistory, onLogOutcome }) {
  const navigate = useNavigate()
  const isComplete = session.status === 'completed'
  const date = new Date(session.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const completedDate = session.completed_at
    ? new Date(session.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  return (
    <div className="round-row">
      <div className="round-left">
        <span className="round-label">Round {session.round_number}</span>
        <span className="round-date">{completedDate || date}</span>
        <span className={`round-status ${session.status}`}>
          {isComplete ? 'Completed' : 'In Progress'}
        </span>
      </div>
      <div className="round-actions">
        {isComplete ? (
          <>
            <button
              className="round-btn"
              onClick={() => navigate(`/session/${session.id}/debrief`)}
            >
              Report
            </button>
            <button
              className="round-btn"
              onClick={() => onViewHistory({ id: session.id, name: projectName, round: session.round_number })}
            >
              History
            </button>
            {!session.outcome_logged && (
              <button className="round-btn subtle" onClick={() => onLogOutcome(session)}>
                Log Outcome ↗
              </button>
            )}
            {session.outcome_logged && (
              <span className="round-outcome-done">✓ Outcome logged</span>
            )}
          </>
        ) : (
          <button className="round-btn primary" onClick={() => navigate(`/session/${session.id}`)}>
            Resume →
          </button>
        )}
      </div>
    </div>
  )
}

// ─── SESSION HISTORY DRAWER ───────────────────────────────────────────────────

function SessionHistoryDrawer({ session, onClose }) {
  const [loading, setLoading] = useState(true)
  const [exchanges, setExchanges] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch(`${API_URL}/api/sessions/${session.id}/history`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setExchanges(data.exchanges || [])
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [session.id])

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <div className="drawer-title">{session.name} — Round {session.round} History</div>
            <div className="drawer-subtitle">Read-only log of all exchanges</div>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-body">
          {loading && <div className="drawer-loading">Loading exchanges...</div>}
          {error && <div className="drawer-error">{error}</div>}
          {!loading && !error && exchanges.length === 0 && (
            <div className="drawer-empty">No exchanges recorded for this session.</div>
          )}
          {exchanges.map((ex, i) => (
            <ExchangeCard key={i} exchange={ex} index={i + 1} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ExchangeCard({ exchange, index }) {
  const agentMeta = AGENT_META[exchange.agent] || { label: exchange.agent, color: '#888' }
  return (
    <div className="exchange-card">
      <div className="exchange-num">#{index}</div>
      <div className="exchange-body">
        <div className="exchange-q">
          <span className="exchange-agent-label" style={{ color: agentMeta.color }}>
            {agentMeta.label}
          </span>
          <p className="exchange-question">{exchange.question}</p>
        </div>
        {exchange.answer ? (
          <div className="exchange-a">
            <span className="exchange-founder-label">You</span>
            <p className="exchange-answer">{exchange.answer}</p>
          </div>
        ) : (
          <div className="exchange-unanswered">— Not answered</div>
        )}
      </div>
    </div>
  )
}

// ─── OUTCOME LOGGER MODAL ─────────────────────────────────────────────────────

const OUTCOME_OPTIONS = [
  { value: 'got_investment', label: 'Got investment 🎉' },
  { value: 'follow_up', label: 'Follow-up scheduled' },
  { value: 'passed', label: 'Passed' },
  { value: 'no_response', label: 'No response yet' },
]

function OutcomeLoggerModal({ session, onClose, onSaved }) {
  const EMPTY = {
    meeting_happened: true,
    outcome: '',
    main_objection: '',
    caught_off_guard: '',
    wished_prepared: '',
    investor_feedback: '',
  }
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/api/sessions/${session.id}/outcome`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      onSaved()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal outcome-modal" onClick={e => e.stopPropagation()}>
        <div className="intake-header">
          <h2>Log Meeting Outcome</h2>
          <p>Round {session.round_number} — agents use this to sharpen their attacks next time.</p>
        </div>

        <div className="outcome-body">
          <div className="form-group">
            <label>Did the meeting happen?</label>
            <div className="outcome-toggle">
              <button
                className={`outcome-toggle-btn ${form.meeting_happened ? 'active' : ''}`}
                onClick={() => set('meeting_happened', true)}
              >Yes</button>
              <button
                className={`outcome-toggle-btn ${!form.meeting_happened ? 'active' : ''}`}
                onClick={() => set('meeting_happened', false)}
              >Not yet</button>
            </div>
          </div>

          {form.meeting_happened && (
            <>
              <div className="form-group">
                <label>Outcome</label>
                <div className="outcome-options">
                  {OUTCOME_OPTIONS.map(o => (
                    <button
                      key={o.value}
                      className={`outcome-option-btn ${form.outcome === o.value ? 'active' : ''}`}
                      onClick={() => set('outcome', o.value)}
                    >{o.label}</button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label>Investor's main objection</label>
                <textarea
                  className="form-input form-textarea"
                  placeholder="What did they push back on hardest?"
                  value={form.main_objection}
                  onChange={e => set('main_objection', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>What question caught you most off guard?</label>
                <textarea
                  className="form-input form-textarea"
                  placeholder="The one you weren't ready for..."
                  value={form.caught_off_guard}
                  onChange={e => set('caught_off_guard', e.target.value)}
                />
                <div className="field-hint">Red Team will open with a variant of this next round.</div>
              </div>

              <div className="form-group">
                <label>What did you wish you'd prepared better?</label>
                <textarea
                  className="form-input form-textarea"
                  placeholder="Specific topics, numbers, or stories you fumbled..."
                  value={form.wished_prepared}
                  onChange={e => set('wished_prepared', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Any feedback the investor gave?</label>
                <textarea
                  className="form-input form-textarea"
                  placeholder="Specific things they said about the pitch, team, or market..."
                  value={form.investor_feedback}
                  onChange={e => set('investor_feedback', e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="intake-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving...' : 'Save Outcome →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NEW PROJECT MODAL (unchanged) ───────────────────────────────────────────

function NewProjectModal({ onClose, onCreated }) {
  const EMPTY = {
    name: '', one_liner: '', funding_amount: '', equity_percent: '',
    industry: '', stage: '', use_of_funds: '', problem: '', solution: '',
    revenue_model: '', traction: '', key_metrics: '', target_customer: '',
    tam: '', competitors: '', team: '', prior_funding: '', known_risks: '',
  }
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [section, setSection] = useState('basics')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const implied = form.funding_amount && form.equity_percent && parseFloat(form.equity_percent) > 0
    ? (parseFloat(form.funding_amount) / (parseFloat(form.equity_percent) / 100)).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : null

  const { pct, hint } = completeness(form)
  const canSubmit = form.name && form.one_liner && form.funding_amount && form.equity_percent

  const handleSubmit = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch(`${API_URL}/api/projects`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      onCreated(data)
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  const tabs = [
    { id: 'basics', label: 'The Ask' },
    { id: 'business', label: 'Business' },
    { id: 'market', label: 'Market' },
    { id: 'team', label: 'Team & Risks' },
  ]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal intake-modal" onClick={e => e.stopPropagation()}>
        <div className="intake-header">
          <h2>New Project</h2>
          <p>Brief the panel before they brief you.</p>
        </div>

        <div className="completeness-bar-wrap">
          <div className="completeness-label">
            <span>Pitch strength</span>
            <span className="completeness-pct">{pct}%</span>
          </div>
          <div className="completeness-track">
            <div className="completeness-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="completeness-hint">{hint}</div>
        </div>

        <div className="intake-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`intake-tab ${section === t.id ? 'active' : ''}`}
              onClick={() => setSection(t.id)}
            >{t.label}</button>
          ))}
        </div>

        <div className="intake-body">
          {section === 'basics' && (
            <>
              <div className="form-group">
                <label>Company / Pitch Name <span className="required">*</span></label>
                <input className="form-input" placeholder="e.g. HealthTrack AI" value={form.name} onChange={e => set('name', e.target.value)} />
              </div>
              <div className="form-group">
                <label>One-liner <span className="required">*</span></label>
                <input className="form-input" placeholder="e.g. AI expense tracking for finance teams" value={form.one_liner} onChange={e => set('one_liner', e.target.value)} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Asking ($) <span className="required">*</span></label>
                  <input className="form-input" type="number" placeholder="3000000" value={form.funding_amount} onChange={e => set('funding_amount', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Equity (%) <span className="required">*</span></label>
                  <input className="form-input" type="number" placeholder="10" value={form.equity_percent} onChange={e => set('equity_percent', e.target.value)} />
                </div>
              </div>
              {implied && <div className="implied-val">Implied valuation: <strong>${implied}</strong></div>}
              <div className="form-row">
                <div className="form-group">
                  <label>Industry</label>
                  <input className="form-input" placeholder="e.g. HealthTech, SaaS" value={form.industry} onChange={e => set('industry', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Stage</label>
                  <select className="form-input" value={form.stage} onChange={e => set('stage', e.target.value)}>
                    <option value="">Select stage</option>
                    <option>Idea</option><option>Pre-revenue</option>
                    <option>Revenue</option><option>Growth</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>What the money is for</label>
                <input className="form-input" placeholder="e.g. Hiring, product development, marketing" value={form.use_of_funds} onChange={e => set('use_of_funds', e.target.value)} />
              </div>
            </>
          )}
          {section === 'business' && (
            <>
              <div className="form-group">
                <label>Problem being solved</label>
                <textarea className="form-input form-textarea" placeholder="What pain are you solving? Who feels it?" value={form.problem} onChange={e => set('problem', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Solution / Product</label>
                <textarea className="form-input form-textarea" placeholder="What do you actually do?" value={form.solution} onChange={e => set('solution', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Revenue model</label>
                <input className="form-input" placeholder="How do you make money?" value={form.revenue_model} onChange={e => set('revenue_model', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Current traction</label>
                <input className="form-input" placeholder="MRR, users, contracts, pilots — or none" value={form.traction} onChange={e => set('traction', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Key metrics</label>
                <input className="form-input" placeholder="CAC, LTV, churn, growth rate" value={form.key_metrics} onChange={e => set('key_metrics', e.target.value)} />
              </div>
            </>
          )}
          {section === 'market' && (
            <>
              <div className="form-group">
                <label>Target customer</label>
                <input className="form-input" placeholder="Who exactly buys this?" value={form.target_customer} onChange={e => set('target_customer', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Market size (TAM / SAM)</label>
                <input className="form-input" placeholder="e.g. $4B TAM, $800M SAM" value={form.tam} onChange={e => set('tam', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Top 2–3 competitors</label>
                <textarea className="form-input form-textarea" placeholder="Who else is in this space? What makes you different?" value={form.competitors} onChange={e => set('competitors', e.target.value)} />
              </div>
            </>
          )}
          {section === 'team' && (
            <>
              <div className="form-group">
                <label>Founders & roles</label>
                <textarea className="form-input form-textarea" placeholder="Who is on the team and what do they bring?" value={form.team} onChange={e => set('team', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Prior funding</label>
                <input className="form-input" placeholder="e.g. $500K pre-seed from angels, or none" value={form.prior_funding} onChange={e => set('prior_funding', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Key risks you already know about</label>
                <textarea className="form-input form-textarea" placeholder="Be honest. Red Team will use these." value={form.known_risks} onChange={e => set('known_risks', e.target.value)} />
                <div className="field-hint">⚠️ Red Team will open with whatever you write here. Be specific.</div>
              </div>
            </>
          )}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="intake-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!canSubmit || saving}>
            {saving ? 'Creating...' : 'Create Project →'}
          </button>
        </div>
      </div>
    </div>
  )
}

const DETAIL_LABELS = {
  name: 'Company Name', one_liner: 'One-line Description',
  funding_amount: 'Funding Ask', equity_percent: 'Equity Offered', implied_valuation: 'Implied Valuation',
  industry: 'Industry / Sector', stage: 'Stage', use_of_funds: 'Use of Funds',
  problem: 'Problem', solution: 'Solution', revenue_model: 'Revenue Model',
  traction: 'Traction', key_metrics: 'Key Metrics', target_customer: 'Target Customer',
  tam: 'Market Size (TAM/SAM)', competitors: 'Competitors', team: 'Team & Roles',
  prior_funding: 'Prior Funding', known_risks: 'Known Risks',
}

function ProjectDetailModal({ project, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">📁 {project.name}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="project-detail-grid">
          {Object.entries(DETAIL_LABELS).map(([key, label]) => {
            const val = project[key]
            if (!val && val !== 0) return null
            return (
              <div key={key} className="project-detail-row">
                <div className="project-detail-label">{label}</div>
                <div className="project-detail-value">
                  {key === 'funding_amount' ? `$${Number(val).toLocaleString()}`
                    : key === 'equity_percent' ? `${val}%`
                    : key === 'implied_valuation' ? `$${Number(val).toLocaleString()}`
                    : val}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
