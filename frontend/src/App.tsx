import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import './App.css'
import { ApiError, getFeedback, sendDiagram, streamVoice, verifyGcp } from './api'
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
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const diagramDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
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
      diagramDebounce.current = setTimeout(() => pushDiagram(elements), 800)
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
    if (!autoFeedback || !sessionId) return
    const t = setInterval(() => {
      void runFeedback()
    }, 9000)
    return () => clearInterval(t)
  }, [autoFeedback, sessionId, runFeedback])

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
        />
      </main>
    </div>
  )
}
