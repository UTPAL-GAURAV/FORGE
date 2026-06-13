import { useState, useEffect } from 'react'
import { useAuth, API_URL } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'

const OPTIONAL_FIELDS = [
  'industry', 'stage', 'use_of_funds', 'problem', 'solution',
  'revenue_model', 'traction', 'key_metrics', 'target_customer',
  'tam', 'competitors', 'team', 'prior_funding', 'known_risks',
]

const COMPLETENESS_HINTS = {
  industry: 'industry',
  stage: 'stage',
  use_of_funds: 'use of funds',
  problem: 'problem statement',
  solution: 'solution',
  revenue_model: 'revenue model',
  traction: 'traction',
  key_metrics: 'key metrics',
  target_customer: 'target customer',
  tam: 'market size',
  competitors: 'competitor info',
  team: 'team info',
  prior_funding: 'prior funding',
  known_risks: 'known risks',
}

function completeness(form) {
  const filled = OPTIONAL_FIELDS.filter(f => form[f]?.trim())
  const pct = Math.round((filled.length / OPTIONAL_FIELDS.length) * 100)
  const missing = OPTIONAL_FIELDS.filter(f => !form[f]?.trim())
  const hint = missing.length > 0 ? `add ${COMPLETENESS_HINTS[missing[0]]} to sharpen agent attacks` : 'fully loaded'
  return { pct, hint }
}

export default function Dashboard() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showNewProject, setShowNewProject] = useState(false)

  useEffect(() => {
    fetch(`${API_URL}/api/projects`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { setProjects(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const onProjectCreated = (project) => {
    setProjects(p => [{ ...project, sessions: [] }, ...p])
    setShowNewProject(false)
  }

  return (
    <div className="dash-layout">
      <aside className="dash-sidebar">
        <div className="dash-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>FORGE<span>.</span></div>
        <nav className="dash-nav">
          <a className="dash-nav-item active" href="/dashboard">
            <span>⚡</span> Sessions
          </a>
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
            {projects.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}
        </div>
      </main>

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={onProjectCreated} />
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

function ProjectCard({ project }) {
  const [open, setOpen] = useState(true)
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
        <span className="project-chevron">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="project-rounds">
          {(!project.sessions || project.sessions.length === 0) ? (
            <div className="round-empty">No sessions yet. <button className="link-btn">Start Round 1 →</button></div>
          ) : (
            project.sessions.map(s => <RoundRow key={s.id} session={s} />)
          )}
        </div>
      )}
    </div>
  )
}

function RoundRow({ session }) {
  const date = new Date(session.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const isComplete = session.status === 'completed'
  return (
    <div className="round-row">
      <div className="round-left">
        <span className="round-label">Round {session.round_number}</span>
        <span className="round-date">{date}</span>
        <span className={`round-status ${session.status}`}>{isComplete ? 'Completed' : 'In Progress'}</span>
      </div>
      <div className="round-actions">
        {isComplete ? (
          <>
            <button className="round-btn">Report</button>
            <button className="round-btn primary">Start Round {session.round_number + 1} →</button>
          </>
        ) : (
          <button className="round-btn primary">Resume →</button>
        )}
        {isComplete && !session.outcome_logged && (
          <button className="round-btn subtle">Log Outcome ↗</button>
        )}
      </div>
    </div>
  )
}

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
  const [section, setSection] = useState('basics') // basics | business | market | team

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

        {/* Completeness bar */}
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

        {/* Tabs */}
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
                <input className="form-input" placeholder="What do you do, for who?" value={form.one_liner} onChange={e => set('one_liner', e.target.value)} />
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
              {implied && (
                <div className="implied-val">Implied valuation: <strong>${implied}</strong></div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>Industry</label>
                  <input className="form-input" placeholder="e.g. HealthTech, SaaS" value={form.industry} onChange={e => set('industry', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Stage</label>
                  <select className="form-input" value={form.stage} onChange={e => set('stage', e.target.value)}>
                    <option value="">Select stage</option>
                    <option>Idea</option>
                    <option>Pre-revenue</option>
                    <option>Revenue</option>
                    <option>Growth</option>
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
