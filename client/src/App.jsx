import { useState } from 'react'

const AGENTS = [
  {
    name: 'Investor',
    role: 'Financial Attacker',
    emoji: '💰',
    color: '#e8ff47',
    bg: 'rgba(232,255,71,0.1)',
    desc: "Interrogates your valuation, runway, unit economics, and path to profitability with surgical precision.",
    attacks: ['CAC / LTV', 'Valuation', 'Runway math', 'Revenue model'],
  },
  {
    name: 'Competitor',
    role: 'Market Challenger',
    emoji: '⚔️',
    color: '#ff8c47',
    bg: 'rgba(255,140,71,0.1)',
    desc: "Challenges your moat, competitive differentiation, and why you won't be copied or crushed.",
    attacks: ['Defensibility', 'Moat', 'Pricing', 'Market share'],
  },
  {
    name: 'Red Team',
    role: 'Assumption Breaker',
    emoji: '🔴',
    color: '#ff4747',
    bg: 'rgba(255,71,71,0.1)',
    desc: 'Attacks logical gaps, contradictions, and execution risks buried in your assumptions.',
    attacks: ['Logic gaps', 'Contradictions', 'Execution risk', 'TAM claims'],
  },
  {
    name: 'Customer',
    role: 'Adoption Skeptic',
    emoji: '🎯',
    color: '#47c8ff',
    bg: 'rgba(71,200,255,0.1)',
    desc: "Questions real-world adoption, willingness to pay, and whether anyone actually needs this.",
    attacks: ['Willingness to pay', 'Adoption friction', 'Use case', 'Retention'],
  },
]

const NOT_LIST = [
  { bold: 'Not a pitch deck builder', rest: " — FORGE doesn't create, edit, or score your slides." },
  { bold: 'Not a validation tool', rest: " — We don't tell you if your idea is good. We prepare you to defend it." },
  { bold: 'Not a chatbot', rest: ' — No open-ended conversation. Every session is structured and adversarial.' },
  { bold: 'Not a coaching platform', rest: ' — No human mentors, no advisors, no review of your content.' },
  { bold: 'Not a team tool', rest: ' — Single-founder sessions only. No collaborative modes.' },
  { bold: 'Not a document vault', rest: ' — Context is session-scoped. Nothing persists beyond your active session.' },
]

const STEPS = [
  { num: '01', icon: '📋', title: 'Brief the room', desc: 'Fill in your pitch details — company, ask, traction, risks. The more context, the sharper the attack.' },
  { num: '02', icon: '🔥', title: 'Face the panel', desc: 'Four AI agents take turns interrogating your pitch. One question at a time. No escape.' },
  { num: '03', icon: '📊', title: 'Receive your debrief', desc: 'Get a ranked report of your five most dangerous weaknesses, sorted by deal-kill probability.' },
  { num: '04', icon: '🔄', title: 'Evolve each round', desc: 'Log your real meeting outcomes. Agents read your history and attack harder next time.' },
]

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
)

export default function App() {
  const [showModal, setShowModal] = useState(false)

  return (
    <>
      <nav className="nav">
        <div className="nav-logo">FORGE<span>.</span></div>
        <button className="nav-cta" onClick={() => setShowModal(true)}>Get Started</button>
      </nav>

      <section className="hero">
        <div className="hero-badge">
          <span className="hero-badge-dot" />
          Adversarial Pitch Preparation
        </div>
        <h1>The panel that makes<br />investors look <em>easy.</em></h1>
        <p className="hero-sub">
          Four AI agents attack your pitch from every angle before you walk into a real investor meeting.
          Find your weaknesses before they do.
        </p>
        <div className="hero-actions">
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <GoogleIcon />
            Sign in with Google
          </button>
          <button className="btn-ghost" onClick={() => document.getElementById('how').scrollIntoView({ behavior: 'smooth' })}>
            See how it works ↓
          </button>
        </div>
        <div className="agents-strip">
          {AGENTS.map(a => (
            <div className="agent-chip" key={a.name}>
              <span className="agent-chip-dot" style={{ background: a.color }} />
              {a.name} Agent
            </div>
          ))}
        </div>
      </section>

      <div className="divider" />

      <div id="how" className="section">
        <div className="section-label">How it works</div>
        <h2 className="section-title">Shark Tank. On demand.<br />No mercy.</h2>
        <p className="section-sub">
          A structured, adversarial session where four specialized agents take turns attacking your pitch.
          One question at a time. No open chat. No escape.
        </p>
        <div className="steps">
          {STEPS.map(s => (
            <div className="step" key={s.num}>
              <span className="step-num">{s.num}</span>
              <span className="step-icon">{s.icon}</span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="divider" />

      <div className="section">
        <div className="section-label">The Panel</div>
        <h2 className="section-title">Four agents.<br />Four angles of attack.</h2>
        <p className="section-sub">
          Each agent has a fixed role, domain-specific attack vectors, and a persistent question queue.
          They never forget a loophole — even when it wasn't their turn to ask.
        </p>
        <div className="agents-grid">
          {AGENTS.map(a => (
            <div className="agent-card" key={a.name}>
              <div className="agent-card-header">
                <div className="agent-avatar" style={{ background: a.bg }}>{a.emoji}</div>
                <div>
                  <h3>{a.name}</h3>
                  <div className="agent-role">{a.role}</div>
                </div>
              </div>
              <p>{a.desc}</p>
              <div className="agent-attacks">
                {a.attacks.map(t => <span className="attack-tag" key={t}>{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="divider" />

      <div className="section">
        <div className="not-section">
          <div className="section-label">Clarity</div>
          <h2 className="section-title">What FORGE is not.</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '16px', lineHeight: 1.6, maxWidth: 520, marginTop: 12 }}>
            Built to do one thing well. Here is what is explicitly out of scope.
          </p>
          <div className="not-grid">
            {NOT_LIST.map((item, i) => (
              <div className="not-item" key={i}>
                <div className="not-x">✕</div>
                <p><strong>{item.bold}</strong>{item.rest}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="cta-section">
        <div className="cta-box">
          <h2>Ready to get<br />destroyed?</h2>
          <p>
            The best founders don't walk into investor meetings hoping for the best.
            They've already survived worse.
          </p>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <GoogleIcon />
            Start Your First Session
          </button>
        </div>
      </div>

      <footer>
        <div className="nav-logo">FORGE<span style={{ color: 'var(--accent)' }}>.</span></div>
        <span>Built for founders who want to be ready.</span>
      </footer>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-logo">FORGE<span>.</span></div>
            <h2>Enter the room.</h2>
            <p>Sign in to start your pitch preparation session.<br />Four agents are waiting.</p>
            <a className="btn-google" href="http://localhost:3001/api/auth/google">
              <GoogleIcon />
              Continue with Google
            </a>
            <button className="modal-close" onClick={() => setShowModal(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}
