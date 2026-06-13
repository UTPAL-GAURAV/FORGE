import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { API_URL } from '../context/AuthContext'
import { useDeepgram } from '../hooks/useDeepgram'

const AGENT_META = {
  investor:   { label: 'Investor',   color: '#e8ff47', emoji: '💰' },
  competitor: { label: 'Competitor', color: '#ff8c47', emoji: '⚔️' },
  red_team:   { label: 'Red Team',   color: '#ff4747', emoji: '🔴' },
  customer:   { label: 'Customer',   color: '#47c8ff', emoji: '🎯' },
}

const EVENT_LABELS = {
  WEAK_POINT:       { label: 'WEAK POINT',       color: '#ff4747' },
  STRONG_POINT:     { label: 'STRONG POINT',     color: '#47ff8c' },
  CONTRADICTION:    { label: 'CONTRADICTION',    color: '#ff8c47' },
  DEFLECTION:       { label: 'DEFLECTION',       color: '#c847ff' },
  QUEUE_UPDATE:     { label: 'QUEUE UPDATE',     color: '#888' },
  FOLLOW_UP:        { label: 'FOLLOW UP',        color: '#e8ff47' },
  PASS_CONTROL:     { label: 'PASS CONTROL',     color: '#555' },
  AGENT_QUESTION:   { label: 'QUESTION',         color: '#e8ff47' },
  SESSION_COMPLETE: { label: 'SESSION COMPLETE', color: '#47ff8c' },
}

export default function SessionRunner() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)

  // Chat: array of { role: 'agent'|'founder', agent?, text, id }
  const [messages, setMessages] = useState([])
  // Right panel: array of { type, agent, payload, ts }
  const [sidebarEvents, setSidebarEvents] = useState([])

  const [activeAgent, setActiveAgent] = useState('investor')
  const [currentQuestion, setCurrentQuestion] = useState(null)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [generatingDebrief, setGeneratingDebrief] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [starting, setStarting] = useState(false)

  // Session elapsed timer
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef(null)

  // Speech: toggle mode, 90s auto-stop
  const [textInput, setTextInput] = useState('')
  const [inputMode, setInputMode] = useState('speech') // 'speech' | 'text'
  const micTimerRef = useRef(null)
  const micCountdownRef = useRef(null)
  const MIC_MAX_SECONDS = 90
  const [micSecsLeft, setMicSecsLeft] = useState(MIC_MAX_SECONDS)

  const chatEndRef = useRef(null)
  const sidebarEndRef = useRef(null)

  const { transcript, interim, listening, ready, error: micError, start: startMic, stop: stopMic, reset: resetTranscript } = useDeepgram(id)

  // Auto-scroll both panels
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { sidebarEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [sidebarEvents])

  // Merge speech transcript into input when listening
  useEffect(() => {
    if (inputMode === 'speech') setTextInput(transcript + (interim ? ' ' + interim : ''))
  }, [transcript, interim, inputMode])

  // Start elapsed timer once session is active, stop when ended
  useEffect(() => {
    if (!loading && !sessionEnded && !starting) {
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
    }
    return () => clearInterval(timerRef.current)
  }, [loading, sessionEnded, starting])

  useEffect(() => {
    if (sessionEnded) clearInterval(timerRef.current)
  }, [sessionEnded])

  // Load session + existing state on mount
  useEffect(() => {
    fetch(`${API_URL}/api/sessions/${id}/state`, { credentials: 'include' })
      .then(r => r.json())
      .then(({ session: s, events }) => {
        if (!s) { setError('Session not found'); setLoading(false); return }
        setSession(s)
        setActiveAgent(s.active_agent || 'investor')
        setSessionEnded(s.status === 'completed')

        // Seed elapsed timer from session start time
        if (s.created_at && s.status !== 'completed') {
          const secs = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 1000)
          setElapsed(Math.max(0, secs))
        }

        // Reconstruct chat: pair each AGENT_QUESTION with the FOUNDER_RESPONSE that follows it
        const chat = []
        const sidebar = []
        const evList = events || []

        for (let i = 0; i < evList.length; i++) {
          const ev = evList[i]
          if (ev.event_type === 'AGENT_QUESTION') {
            chat.push({ role: 'agent', agent: ev.agent, text: ev.payload.question, id: ev.id })
            // Look ahead for the next FOUNDER_RESPONSE
            const next = evList[i + 1]
            if (next?.event_type === 'FOUNDER_RESPONSE') {
              chat.push({ role: 'founder', text: next.payload.answer, id: `ans-${next.id}` })
              i++ // skip the response event — already consumed
            }
          } else if (['WEAK_POINT','STRONG_POINT','CONTRADICTION','DEFLECTION','QUEUE_UPDATE','FOLLOW_UP','PASS_CONTROL'].includes(ev.event_type)) {
            sidebar.push({ type: ev.event_type, agent: ev.agent, payload: ev.payload, ts: ev.created_at })
          }
        }

        setMessages(chat)
        setSidebarEvents(sidebar)

        if (chat.length === 0 && s.status !== 'completed') {
          startSession()
        } else if (chat.length > 0) {
          const lastMsg = chat[chat.length - 1]
          if (lastMsg.role === 'agent') setCurrentQuestion(lastMsg.text)
        }

        setLoading(false)
      })
      .catch(() => { setError('Failed to load session'); setLoading(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const startSession = useCallback(async () => {
    setStarting(true)
    try {
      const r = await fetch(`${API_URL}/api/sessions/${id}/start`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setCurrentQuestion(data.question)
      setActiveAgent(data.activeAgent)
      setMessages([{ role: 'agent', agent: data.activeAgent, text: data.question, id: 'q0' }])
      if (data.sidebarEvents) pushSidebar(data.sidebarEvents)
    } catch (e) {
      setError('Failed to start session: ' + e.message)
    }
    setStarting(false)
  }, [id])

  function pushSidebar(events) {
    setSidebarEvents(prev => [
      ...prev,
      ...events.map(e => ({ ...e, ts: new Date().toISOString() })),
    ])
  }

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }

  function handleMicToggle() {
    if (listening) {
      stopMic()
      clearTimeout(micTimerRef.current)
      clearInterval(micCountdownRef.current)
      setMicSecsLeft(MIC_MAX_SECONDS)
      // Auto-submit whatever was transcribed
      setTimeout(() => {
        handleSubmitRef.current?.()
      }, 100) // small delay to let transcript state settle
    } else {
      startMic()
      setMicSecsLeft(MIC_MAX_SECONDS)
      micCountdownRef.current = setInterval(() => {
        setMicSecsLeft(s => {
          if (s <= 1) {
            clearInterval(micCountdownRef.current)
            stopMic()
            setTimeout(() => { handleSubmitRef.current?.() }, 100)
            return 0
          }
          return s - 1
        })
      }, 1000)
    }
  }

  // Stable ref so the timeout callbacks always call the latest handleSubmit
  const handleSubmitRef = useRef(null)

  const handleSubmit = useCallback(async () => {
    const answer = textInput.trim()
    if (!answer || !currentQuestion || submitting || sessionEnded) return

    if (listening) { stopMic(); clearInterval(micCountdownRef.current); setMicSecsLeft(MIC_MAX_SECONDS) }

    setSubmitting(true)
    setMessages(prev => [...prev, { role: 'founder', text: answer, id: `f-${Date.now()}` }])
    setTextInput('')
    resetTranscript()

    try {
      const r = await fetch(`${API_URL}/api/sessions/${id}/turn`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ founderResponse: answer, lastQuestion: currentQuestion, activeAgent }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)

      if (data.sidebarEvents) pushSidebar(data.sidebarEvents)

      if (data.sessionEnded) {
        setSessionEnded(true)
        setCurrentQuestion(null)
        triggerDebrief()
      } else if (data.question) {
        setCurrentQuestion(data.question)
        setActiveAgent(data.activeAgent)
        setMessages(prev => [...prev, {
          role: 'agent',
          agent: data.activeAgent,
          text: data.question,
          id: `q-${Date.now()}`,
        }])
      }
    } catch (e) {
      setMessages(prev => prev.slice(0, -1)) // remove optimistic founder message
      setTextInput(answer)
      setError('Failed to submit: ' + e.message)
    }

    setSubmitting(false)
  }, [textInput, currentQuestion, submitting, sessionEnded, listening, stopMic, resetTranscript, id, activeAgent])

  // Keep ref current so timeout callbacks in handleMicToggle always call the latest version
  handleSubmitRef.current = handleSubmit

  const triggerDebrief = useCallback(async () => {
    setGeneratingDebrief(true)
    try {
      await fetch(`${API_URL}/api/sessions/${id}/debrief`, { method: 'POST', credentials: 'include' })
    } catch {}
    navigate(`/session/${id}/debrief`)
  }, [id, navigate])

  const handleEndSession = async () => {
    if (!window.confirm('End session and go to debrief?')) return
    await fetch(`${API_URL}/api/sessions/${id}/end`, { method: 'POST', credentials: 'include' })
    setSessionEnded(true)
    triggerDebrief()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  if (loading) return <div className="session-loading"><div className="session-loading-text">Preparing the room...</div></div>

  const agentMeta = AGENT_META[activeAgent] || AGENT_META.investor

  // Full-page error only when session itself couldn't be loaded at all
  if (error && !session) {
    return (
      <div className="session-loading">
        <div className="session-error">{error}</div>
        <button className="session-retry-btn" onClick={() => { setError(null); setLoading(true); window.location.reload() }}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="session-layout">
      {/* ── LEFT PANEL: Chat ────────────────────────────────── */}
      <div className="session-chat-panel">
        <div className="session-chat-header">
          <div className="session-chat-title">
            <span className="session-logo">FORGE<span className="accent">.</span></span>
            <span className="session-round">{session?.name} — Round {session?.round_number}</span>
          </div>
          <div className="session-header-right">
            {!sessionEnded && <span className="session-timer">{formatTime(elapsed)}</span>}
            {!sessionEnded && (
              <button className="session-end-btn" onClick={handleEndSession}>End Session</button>
            )}
          </div>
        </div>

        <div className="session-chat-body">
          {starting && (
            <div className="chat-loading">
              <div className="chat-loading-dots"><span/><span/><span/></div>
              <p>The panel is reviewing your pitch...</p>
            </div>
          )}

          {error && !starting && (
            <div className="session-inline-error">
              <span>{error}</span>
              <button
                className="session-retry-btn"
                onClick={() => { setError(null); startSession() }}
              >
                Retry
              </button>
            </div>
          )}

          {messages.map(msg => (
            msg.role === 'agent'
              ? <AgentBubble key={msg.id} message={msg} />
              : <FounderBubble key={msg.id} message={msg} />
          ))}

          {(sessionEnded || generatingDebrief) && (
            <div className="session-ended-msg">
              <div className="session-ended-icon">🏁</div>
              <h3>{generatingDebrief ? 'Generating debrief...' : 'Session Complete'}</h3>
              <p>{generatingDebrief ? 'All four agents are submitting nominations. Red Team is arbitrating.' : 'Navigating to your debrief...'}</p>
              <div className="chat-loading-dots" style={{ margin: '0 auto' }}><span/><span/><span/></div>
            </div>
          )}

          {submitting && !sessionEnded && (
            <div className="agent-thinking">
              <div className="agent-thinking-dots"><span/><span/><span/></div>
              <span>Panel evaluating response...</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input area */}
        {!sessionEnded && (
          <div className="session-input-area">
            <div className="session-input-mode">
              <button
                className={`mode-btn ${inputMode === 'speech' ? 'active' : ''}`}
                onClick={() => setInputMode('speech')}
              >🎤 Speech</button>
              <button
                className={`mode-btn ${inputMode === 'text' ? 'active' : ''}`}
                onClick={() => { setInputMode('text'); if (listening) stopMic() }}
              >⌨️ Type</button>
            </div>

            <div className="session-input-row">
              {inputMode === 'speech' && (
                <button
                  className={`mic-btn ${listening ? 'active' : ''}`}
                  onClick={handleMicToggle}
                  disabled={submitting}
                  title={listening ? 'Stop recording' : 'Start recording'}
                >
                  {listening ? '⏹' : '⏺'}
                  <span>{listening ? `${micSecsLeft}s` : (ready ? 'Record' : '...')}</span>
                </button>
              )}

              <div className="session-textarea-wrap">
                <textarea
                  className="session-textarea"
                  placeholder={inputMode === 'speech' ? 'Transcript will appear here...' : 'Type your answer...'}
                  value={textInput}
                  onChange={e => { if (inputMode === 'text') setTextInput(e.target.value) }}
                  onKeyDown={handleKeyDown}
                  readOnly={inputMode === 'speech'}
                  rows={3}
                />
                {micError && <div className="mic-error">{micError}</div>}
              </div>

              <button
                className="session-submit-btn"
                onClick={handleSubmit}
                disabled={!textInput.trim() || submitting || !currentQuestion || listening}
              >
                {submitting ? <span className="submitting-dots"><span/><span/><span/></span> : 'Submit →'}
              </button>
            </div>

            <div className="session-active-agent" style={{ color: agentMeta.color }}>
              {agentMeta.emoji} {agentMeta.label} is asking
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT PANEL: Agent Activity ─────────────────────── */}
      <div className="session-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">Agent Activity</span>
          <span className="sidebar-live-dot" />
          <span className="sidebar-live-label">LIVE</span>
          <span className="sidebar-demo-note">Demo only</span>
        </div>

        <div className="sidebar-agent-status">
          {Object.entries(AGENT_META).map(([key, meta]) => (
            <div key={key} className={`sidebar-agent-pill ${activeAgent === key ? 'active' : ''}`} style={activeAgent === key ? { borderColor: meta.color, color: meta.color } : {}}>
              {meta.emoji} {meta.label}
            </div>
          ))}
        </div>

        <div className="sidebar-events">
          {sidebarEvents.length === 0 && (
            <div className="sidebar-empty">Events will appear here as agents evaluate responses.</div>
          )}
          {sidebarEvents.map((ev, i) => (
            <SidebarEvent key={i} event={ev} />
          ))}
          <div ref={sidebarEndRef} />
        </div>
      </div>
    </div>
  )
}

function AgentBubble({ message }) {
  const meta = AGENT_META[message.agent] || AGENT_META.investor
  return (
    <div className="chat-bubble agent-bubble">
      <div className="agent-bubble-label" style={{ color: meta.color }}>
        {meta.emoji} {meta.label}
      </div>
      <div className="agent-bubble-text">{message.text}</div>
    </div>
  )
}

function FounderBubble({ message }) {
  return (
    <div className="chat-bubble founder-bubble">
      <div className="founder-bubble-text">{message.text}</div>
    </div>
  )
}

function SidebarEvent({ event }) {
  const meta = EVENT_LABELS[event.type] || { label: event.type, color: '#888' }
  const agentMeta = AGENT_META[event.agent] || null
  const p = event.payload || {}

  let detail = null
  if (event.type === 'WEAK_POINT' || event.type === 'STRONG_POINT' || event.type === 'CONTRADICTION' || event.type === 'DEFLECTION') {
    detail = `${p.topic || ''}${p.note ? ' — ' + p.note : ''}${p.confidence ? ` (${p.confidence})` : ''}`
  } else if (event.type === 'QUEUE_UPDATE' && p.added?.length) {
    detail = `+${p.added.length} question${p.added.length > 1 ? 's' : ''} queued`
  } else if (event.type === 'FOLLOW_UP' && p.question) {
    detail = p.question.slice(0, 80) + (p.question.length > 80 ? '…' : '')
  } else if (event.type === 'PASS_CONTROL') {
    detail = 'satisfied'
  } else if (event.type === 'AGENT_QUESTION' && p.topic) {
    detail = p.topic
  }

  return (
    <div className="sidebar-event">
      <div className="sidebar-event-row">
        {agentMeta && (
          <span className="sidebar-event-agent" style={{ color: agentMeta.color }}>
            [{agentMeta.label.toUpperCase()}]
          </span>
        )}
        <span className="sidebar-event-type" style={{ color: meta.color }}>
          {meta.label}
        </span>
      </div>
      {detail && <div className="sidebar-event-detail">{detail}</div>}
    </div>
  )
}
