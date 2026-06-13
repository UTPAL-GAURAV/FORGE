import { useRef, useState, useCallback } from 'react'
import { API_URL } from '../context/AuthContext'

const DG_URL = 'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=300'

export function useDeepgram(sessionId) {
  const [transcript, setTranscript] = useState('')
  const [interim, setInterim] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)

  const wsRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)

  const start = useCallback(async () => {
    setError(null)
    setTranscript('')
    setInterim('')

    try {
      // Fetch short-lived key from our server
      const r = await fetch(`${API_URL}/api/sessions/${sessionId}/deepgram-token`, { credentials: 'include' })
      const { key, error: keyError } = await r.json()
      if (!key) throw new Error(keyError || 'No Deepgram key')

      // Mic access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // WebSocket to Deepgram
      const ws = new WebSocket(DG_URL, ['token', key])
      wsRef.current = ws

      ws.onopen = () => {
        setListening(true)
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
        mediaRecorderRef.current = recorder

        recorder.ondataavailable = e => {
          if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
            ws.send(e.data)
          }
        }
        recorder.start(200) // send chunks every 200ms
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

      ws.onerror = () => setError('Microphone connection error')
      ws.onclose = () => setListening(false)
    } catch (err) {
      setError(err.message || 'Microphone access denied')
      setListening(false)
    }
  }, [sessionId])

  const stop = useCallback(() => {
    mediaRecorderRef.current?.stop()
    wsRef.current?.close()
    streamRef.current?.getTracks().forEach(t => t.stop())
    setListening(false)
    setInterim('')
  }, [])

  const reset = useCallback(() => {
    setTranscript('')
    setInterim('')
  }, [])

  return { transcript, interim, listening, error, start, stop, reset }
}
