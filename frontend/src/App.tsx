import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import './App.css'
import { ApiError, getFeedback, sendDiagram, streamVoice, verifyGcp } from './api'
import { LiveAudioOut } from './liveAudioPlayer'
import {
  buildLiveContextUpdate,
  buildLiveNudgeTurn,
  buildLiveSessionStartTurn,
  liveDebounceMsForTranscript,
  liveWebSocketUrl,
  parseLiveServerMessages,
  wsPayloadToUtf8,
  type LiveConnectionStatus,
} from './liveWs'
import { FeedbackPanel } from './components/FeedbackPanel'
import { GcpTokenModal } from './components/GcpTokenModal'
import { VoiceControls } from './components/VoiceControls'
import { getSpeechRecognitionConstructor, speak } from './speech'

function serializeElements(elements: readonly OrderedExcalidrawElement[]) {
  try {
    return { elements: JSON.parse(JSON.stringify(elements)) as object[] }
  } catch {
    return { elements: [] as object[] }
  }
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [gcpProjectId, setGcpProjectId] = useState<string | null>(null)
  const [showGcp, setShowGcp] = useState(true)
  const [transcript, setTranscript] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [autoFeedback, setAutoFeedback] = useState(false)
  const [textFeedback, setTextFeedback] = useState('')
  const [diagramHints, setDiagramHints] = useState<string[]>([])
  const [lastVoiceLine, setLastVoiceLine] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [liveStatus, setLiveStatus] = useState<LiveConnectionStatus>('off')
  const [liveReady, setLiveReady] = useState(false)
  const [liveStreamText, setLiveStreamText] = useState('')
  const [liveError, setLiveError] = useState<string | null>(null)
  const [diagramEpoch, setDiagramEpoch] = useState(0)
  /** Bumps when Live may send debounced context (after first model `turn_complete` or fallback timeout). */
  const [liveAmbientGate, setLiveAmbientGate] = useState(0)
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const diagramDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const liveWsRef = useRef<WebSocket | null>(null)
  const liveAudioRef = useRef<LiveAudioOut | null>(null)
  const liveOpeningSentRef = useRef(false)
  /** False until first `turn_complete` — avoids sending context during T0 audio (interrupts native-audio stream). */
  const liveAmbientAllowedRef = useRef(false)
  const diagramForLiveRef = useRef<string>('')
  const recRef = useRef<SpeechRecognition | null>(null)
  /** Text confirmed as final by the speech engine; interim hypotheses are not stored here. */
  const speechCommittedRef = useRef('')
  const transcriptRef = useRef(transcript)

  const speechSupported = Boolean(getSpeechRecognitionConstructor())

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    transcriptRef.current = transcript
  }, [transcript])

  const invalidateSession = useCallback((hint?: string) => {
    if (diagramDebounce.current) {
      clearTimeout(diagramDebounce.current)
      diagramDebounce.current = null
    }
    setSessionId(null)
    setGcpProjectId(null)
    setShowGcp(true)
    if (hint) setTextFeedback(hint)
  }, [])

  const pushDiagram = useCallback(
    (elements: readonly OrderedExcalidrawElement[]) => {
      const sid = sessionIdRef.current
      if (!sid) return
      const payload = serializeElements(elements)
      void sendDiagram(sid, payload).catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          invalidateSession(
            'Session no longer exists on the server (e.g. after a backend restart). Sign in again.',
          )
        }
      })
    },
    [invalidateSession],
  )

  const handleDiagramChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[]) => {
      if (diagramDebounce.current) clearTimeout(diagramDebounce.current)
      diagramDebounce.current = setTimeout(() => {
        pushDiagram(elements)
        try {
          diagramForLiveRef.current = JSON.stringify(serializeElements(elements)).slice(0, 12000)
        } catch {
          diagramForLiveRef.current = ''
        }
        setDiagramEpoch((n) => n + 1)
      }, 800)
    },
    [pushDiagram],
  )

  const runFeedback = useCallback(async () => {
    if (!sessionId) return
    const api = excalidrawRef.current
    const elements = api?.getSceneElements() ?? []
    const diagram = serializeElements(elements)
    setFeedbackBusy(true)
    try {
      const res = await getFeedback(sessionId, { transcript, diagram })
      setTextFeedback(res.text_feedback)
      setDiagramHints(res.diagram_hints)
      setLastVoiceLine(res.voice_script)
      speak(res.voice_script)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        invalidateSession(
          'Session no longer exists on the server (e.g. after a backend restart). Sign in again.',
        )
        return
      }
      if (e instanceof ApiError) {
        setTextFeedback(e.message)
        setDiagramHints([])
        return
      }
      setTextFeedback('Could not reach the backend. Is FastAPI running on port 8000?')
      setDiagramHints([])
    } finally {
      setFeedbackBusy(false)
    }
  }, [sessionId, transcript, invalidateSession])

  const toggleListening = useCallback(() => {
    setVoiceError(null)

    if (listening) {
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
      recRef.current = null
      setTranscript(speechCommittedRef.current)
      setListening(false)
      return
    }

    const Ctor = getSpeechRecognitionConstructor()
    if (!Ctor) {
      setVoiceError('Speech recognition is not available in this browser. Try Chrome or Edge.')
      return
    }

    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    speechCommittedRef.current = transcriptRef.current
    rec.onresult = (event: SpeechRecognitionEvent) => {
      const newFinalChunks: string[] = []
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const piece = r[0]?.transcript ?? ''
        if (r.isFinal) {
          const t = piece.trim()
          if (t) newFinalChunks.push(t)
        } else {
          interim += piece
        }
      }
      if (newFinalChunks.length) {
        const joined = newFinalChunks.join(' ')
        speechCommittedRef.current = speechCommittedRef.current
          ? `${speechCommittedRef.current} ${joined}`.trim()
          : joined
      }
      const committed = speechCommittedRef.current
      const withInterim = interim.trim()
        ? committed
          ? `${committed} ${interim.trimEnd()}`.trim()
          : interim.trimEnd()
        : committed
      if (newFinalChunks.length || withInterim !== committed || interim) {
        setTranscript(withInterim)
      }
    }
    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      const code = event.error
      const hints: Record<string, string> = {
        'not-allowed':
          'Microphone permission denied. Allow microphone access for this site in your browser settings.',
        'service-not-allowed':
          'Speech recognition is blocked. Try Chrome/Edge, or a secure (HTTPS) origin.',
        aborted: 'Speech recognition was interrupted.',
        'no-speech': 'No speech detected. Check your microphone and try again.',
        network: 'Could not reach the speech service. Check your network connection.',
        'audio-capture': 'No microphone found or it could not be opened.',
      }
      setVoiceError(hints[code] ?? `Speech recognition error: ${code}`)
      recRef.current = null
      setTranscript(speechCommittedRef.current)
      setListening(false)
    }
    rec.onend = () => {
      recRef.current = null
      setTranscript(speechCommittedRef.current)
      setListening(false)
    }

    try {
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch (e) {
      recRef.current = null
      setVoiceError(e instanceof Error ? e.message : 'Could not start speech recognition.')
    }
  }, [listening])

  useEffect(() => {
    return () => {
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
      recRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!sessionId || !transcript) return
    const t = setInterval(() => {
      void streamVoice(sessionId, transcript).catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          invalidateSession(
            'Session no longer exists on the server (e.g. after a backend restart). Sign in again.',
          )
        }
      })
    }, 2500)
    return () => clearInterval(t)
  }, [sessionId, transcript, invalidateSession])

  useEffect(() => {
    if (!autoFeedback || !sessionId) {
      const existing = liveWsRef.current
      liveWsRef.current = null
      existing?.close()
      liveAudioRef.current?.close()
      liveAudioRef.current = null
      setLiveReady(false)
      setLiveStatus('off')
      setLiveError(null)
      setLiveStreamText('')
      return
    }

    setLiveStatus('connecting')
    setLiveReady(false)
    setLiveError(null)
    setLiveStreamText('')
    liveOpeningSentRef.current = false
    liveAmbientAllowedRef.current = false

    const url = liveWebSocketUrl(sessionId)
    const ws = new WebSocket(url)
    liveWsRef.current = ws
    let cancelled = false

    ws.onmessage = (ev) => {
      void (async () => {
        const raw = await wsPayloadToUtf8(ev.data)
        const events = parseLiveServerMessages(raw)
        for (const parsed of events) {
          switch (parsed.kind) {
            case 'setup_complete':
              if (!liveAudioRef.current) liveAudioRef.current = new LiveAudioOut()
              if (!liveOpeningSentRef.current && ws.readyState === WebSocket.OPEN) {
                liveOpeningSentRef.current = true
                ws.send(JSON.stringify(buildLiveSessionStartTurn()))
              }
              setLiveReady(true)
              setLiveStatus('live')
              break
            case 'audio':
              if (!liveAudioRef.current) liveAudioRef.current = new LiveAudioOut()
              liveAudioRef.current.enqueueBase64Pcm16Le(parsed.base64Pcm, parsed.mimeType)
              break
            case 'output_transcription':
              setLiveStreamText((prev) => prev + parsed.text)
              break
            case 'interrupted':
              liveAudioRef.current?.interrupt()
              break
            case 'text':
              setLiveStreamText((prev) => prev + parsed.text)
              break
            case 'turn_complete':
              liveAmbientAllowedRef.current = true
              setLiveAmbientGate((g) => g + 1)
              setLiveStreamText((prev) => (/\n\n$/.test(prev) ? prev : `${prev}\n\n`))
              break
            case 'architect_error':
              setLiveError(parsed.message)
              setLiveStatus('error')
              break
            default:
              break
          }
        }
      })().catch((e) => {
        console.error('Live WebSocket message handling failed', e)
        setLiveError('Could not parse a Live message from the server.')
        setLiveStatus('error')
      })
    }

    ws.onerror = () => {
      if (cancelled) return
      setLiveError('WebSocket error (is the backend running on port 8000?)')
      setLiveStatus('error')
    }

    ws.onclose = () => {
      if (cancelled) return
      if (liveWsRef.current !== ws) return
      setLiveReady(false)
      setLiveStatus((s) => (s === 'off' ? 'off' : 'error'))
      setLiveError((prev) => prev ?? 'Live session closed. Toggle auto feedback to reconnect.')
    }

    return () => {
      cancelled = true
      if (liveWsRef.current === ws) liveWsRef.current = null
      ws.close()
      liveAudioRef.current?.close()
      liveAudioRef.current = null
    }
  }, [autoFeedback, sessionId])

  useEffect(() => {
    if (!autoFeedback || !liveReady || !sessionId) return
    const id = window.setTimeout(() => {
      if (!liveAmbientAllowedRef.current) {
        liveAmbientAllowedRef.current = true
        setLiveAmbientGate((g) => g + 1)
      }
    }, 35000)
    return () => clearTimeout(id)
  }, [autoFeedback, liveReady, sessionId])

  const sendLiveNudge = useCallback(() => {
    const w = liveWsRef.current
    if (!w || w.readyState !== WebSocket.OPEN) return
    const api = excalidrawRef.current
    const elements = api?.getSceneElements() ?? []
    let diagramJson = diagramForLiveRef.current
    try {
      if (!diagramJson) diagramJson = JSON.stringify(serializeElements(elements)).slice(0, 12000)
    } catch {
      diagramJson = ''
    }
    w.send(JSON.stringify(buildLiveNudgeTurn(transcript, diagramJson)))
  }, [transcript])

  useEffect(() => {
    if (!autoFeedback || !liveReady || !sessionId) return
    if (!liveAmbientAllowedRef.current) return
    const ws = liveWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const tTrim = transcript.trim()
    const dj = diagramForLiveRef.current.trim()
    if (!tTrim && !dj) return

    const ms = liveDebounceMsForTranscript(transcript)
    const id = window.setTimeout(() => {
      if (liveWsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
      if (!liveAmbientAllowedRef.current) return
      ws.send(JSON.stringify(buildLiveContextUpdate(transcript, diagramForLiveRef.current)))
    }, ms)
    return () => clearTimeout(id)
  }, [transcript, diagramEpoch, autoFeedback, liveReady, sessionId, liveAmbientGate])

  return (
    <div className="app-shell">
      <GcpTokenModal
        open={showGcp}
        onVerify={(token, projectId) => verifyGcp(token, projectId)}
        onVerified={(res) => {
          setSessionId(res.session_id)
          setGcpProjectId(res.project_id)
          setShowGcp(false)
        }}
      />

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>The Architect</h1>
            <p className="tagline">Live system design interview simulator</p>
          </div>
        </div>
        <div className="header-actions">
          {sessionId ? (
            <span className="session-pill" title="Vertex AI project for Gemini">
              Session · {gcpProjectId ?? '—'}
            </span>
          ) : (
            <button type="button" className="btn secondary" onClick={() => setShowGcp(true)}>
              Sign in
            </button>
          )}
        </div>
      </header>

      <section className="problem-banner" aria-labelledby="problem-title">
        <h2 id="problem-title">Today&apos;s problem: URL shortener</h2>
        <p>
          Design a service like bit.ly: create short links, fast redirects, and sensible scale.
          Explain trade-offs aloud and sketch your architecture in the canvas.
        </p>
      </section>

      <main className="app-main">
        <div className="canvas-column">
          <VoiceControls
            sessionReady={Boolean(sessionId)}
            listening={listening}
            supported={speechSupported}
            voiceError={voiceError}
            transcript={transcript}
            onTranscriptChange={setTranscript}
            onToggleListen={toggleListening}
            autoFeedback={autoFeedback}
            onToggleAuto={() => setAutoFeedback((v) => !v)}
            onGetFeedback={() => void runFeedback()}
            feedbackBusy={feedbackBusy}
            liveStatus={liveStatus}
            liveReady={liveReady}
            onNudgeInterviewer={sendLiveNudge}
          />
          <div className="excalidraw-wrap" aria-label="Diagram canvas">
            <Excalidraw
              excalidrawAPI={(api) => {
                excalidrawRef.current = api
              }}
              onChange={(elements) => handleDiagramChange(elements)}
            />
          </div>
        </div>
        <FeedbackPanel
          textFeedback={textFeedback}
          diagramHints={diagramHints}
          loading={feedbackBusy}
          lastVoiceLine={lastVoiceLine}
          liveStatus={liveStatus}
          liveStreamText={liveStreamText}
          liveError={liveError}
          autoFeedbackOn={autoFeedback}
        />
      </main>
    </div>
  )
}
