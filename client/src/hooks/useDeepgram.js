import { useRef, useState, useCallback, useEffect } from 'react'
import { API_URL } from '../context/AuthContext'

const DG_URL = 'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=300'

export function useDeepgram(sessionId) {
  const [transcript, setTranscript] = useState('')
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [ready, setReady] = useState(false) // WS connected and waiting
  const [error, setError] = useState(null)

  const wsRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const transcriptRef = useRef('') // stable ref for use in stop callback

  // Keep transcriptRef in sync
  useEffect(() => { transcriptRef.current = transcript }, [transcript])

  // Eagerly open the WebSocket on mount so first Start has no latency
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    async function connect() {
      try {
        const r = await fetch(`${API_URL}/api/sessions/${sessionId}/deepgram-token`, { credentials: 'include' })
        const { key, error: keyError } = await r.json()
        if (!key || cancelled) return

        const ws = new WebSocket(DG_URL, ['token', key])
        wsRef.current = ws

        ws.onopen = () => {
          if (!cancelled) setReady(true)
        }

        ws.onmessage = e => {
          try {
            const data = JSON.parse(e.data)
            const alt = data.channel?.alternatives?.[0]
            if (!alt) return
            if (data.is_final) {
              setTranscript(prev => (prev ? prev + ' ' + alt.transcript : alt.transcript).trim())
              setInterim('')
            } else {
              setInterim(alt.transcript)
            }
          } catch {}
        }

        ws.onerror = () => { if (!cancelled) setError('Microphone connection error') }
        ws.onclose = () => {
          if (!cancelled) {
            setReady(false)
            setListening(false)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to connect to Deepgram')
      }
    }

    connect()
    return () => {
      cancelled = true
      wsRef.current?.close()
    }
  }, [sessionId])

  const start = useCallback(async () => {
    setError(null)
    setTranscript('')
    setInterim('')
    transcriptRef.current = ''

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // If WS closed (e.g. idle timeout), reconnect
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        const r = await fetch(`${API_URL}/api/sessions/${sessionId}/deepgram-token`, { credentials: 'include' })
        const { key } = await r.json()
        const ws = new WebSocket(DG_URL, ['token', key])
        wsRef.current = ws
        await new Promise((resolve, reject) => {
          ws.onopen = resolve
          ws.onerror = reject
        })
        ws.onmessage = e => {
          try {
            const data = JSON.parse(e.data)
            const alt = data.channel?.alternatives?.[0]
            if (!alt) return
            if (data.is_final) {
              setTranscript(prev => (prev ? prev + ' ' + alt.transcript : alt.transcript).trim())
              setInterim('')
            } else {
              setInterim(alt.transcript)
            }
          } catch {}
        }
        ws.onclose = () => { setReady(false); setListening(false) }
      }

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = e => {
        if (wsRef.current?.readyState === WebSocket.OPEN && e.data.size > 0) {
          wsRef.current.send(e.data)
        }
      }
      recorder.start(200)
      setListening(true)
    } catch (err) {
      setError(err.message || 'Microphone access denied')
      setListening(false)
    }
  }, [sessionId])

  // Returns the final transcript at the moment of stopping
  const stop = useCallback(() => {
    mediaRecorderRef.current?.stop()
    streamRef.current?.getTracks().forEach(t => t.stop())
    setListening(false)
    setInterim('')
    // WS stays open for next recording — don't close it
    return transcriptRef.current
  }, [])

  const reset = useCallback(() => {
    setTranscript('')
    setInterim('')
    transcriptRef.current = ''
  }, [])

  return { transcript, interim, listening, ready, error, start, stop, reset }
}
