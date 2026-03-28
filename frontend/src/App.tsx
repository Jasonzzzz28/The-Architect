import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import './App.css'
import {
  ApiError,
  getDesignProblems,
  getFeedback,
  sendDiagram,
  setDesignProblem,
  streamVoice,
  verifyGcp,
  type DesignPresetRow,
} from './api'
import { LiveAudioOut } from './liveAudioPlayer'
import { isGetUserMediaSupported, LiveMicStreamer } from './liveMicPcm'
import {
  buildLiveDiagramOnlyContext,
  buildLiveNudgeTurn,
  buildLiveSessionStartTurn,
  liveWebSocketUrl,
  parseLiveServerMessages,
  wsPayloadToUtf8,
  type LiveConnectionStatus,
} from './liveWs'
import { FeedbackPanel } from './components/FeedbackPanel'
import { GcpTokenModal } from './components/GcpTokenModal'
import { VoiceControls } from './components/VoiceControls'
import { getSpeechRecognitionConstructor, speak } from './speech'

const FALLBACK_PRESETS: DesignPresetRow[] = [
  {
    id: 'url_shortener',
    title: 'URL shortener',
    summary:
      'Create short links, fast redirects, and sensible scale (millions of links, high read traffic).',
  },
  {
    id: 'youtube',
    title: 'Design YouTube',
    summary:
      'Video upload, encoding/transcoding, storage, CDN delivery, recommendations at scale, and metadata/search.',
  },
  {
    id: 'twitter_feed',
    title: 'Design Twitter News Feed',
    summary:
      'Fan-out on write vs read, timeline generation, ranking, and real-time feel at large scale.',
  },
  {
    id: 'rate_limiter',
    title: 'Rate Limiter',
    summary:
      'Distributed rate limiting (token bucket / sliding window), accuracy vs memory, and API gateway use.',
  },
  {
    id: 'ticket_booking',
    title: 'Ticket Booking System',
    summary:
      'Seat inventory, concurrency, payments, and avoiding double-booking under load.',
  },
]

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
  const [presets, setPresets] = useState<DesignPresetRow[]>(FALLBACK_PRESETS)
  /** Preset id from server, or 'custom' for user-written problem */
  const [problemId, setProblemId] = useState<string>('url_shortener')
  const [customProblem, setCustomProblem] = useState('')
  const [problemTitle, setProblemTitle] = useState('URL shortener')
  const [problemSummary, setProblemSummary] = useState(FALLBACK_PRESETS[0].summary)
  const [problemVersion, setProblemVersion] = useState(0)
  const [problemSyncBusy, setProblemSyncBusy] = useState(false)
  const [problemSyncError, setProblemSyncError] = useState<string | null>(null)
  /** Latest problem wording for Live T0 (ref avoids reconnecting WS on every local title/summary tweak). */
  const liveProblemBriefRef = useRef({ title: 'URL shortener', summary: FALLBACK_PRESETS[0].summary })
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const diagramDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const liveWsRef = useRef<WebSocket | null>(null)
  const liveAudioRef = useRef<LiveAudioOut | null>(null)
  const liveOpeningSentRef = useRef(false)
  /** False until first `turn_complete` — avoids sending context during T0 audio (interrupts native-audio stream). */
  const liveAmbientAllowedRef = useRef(false)
  /** True while the model is generating/speaking this turn; new `client_content` would interrupt and restart audio. */
  const liveModelBusyRef = useRef(false)
  const diagramForLiveRef = useRef<string>('')
  const recRef = useRef<SpeechRecognition | null>(null)
  /** Text confirmed as final by the speech engine; interim hypotheses are not stored here. */
  const speechCommittedRef = useRef('')
  const transcriptRef = useRef(transcript)

  const speechSupported = Boolean(getSpeechRecognitionConstructor())
  const micSupported = isGetUserMediaSupported()
  const liveMicRef = useRef<LiveMicStreamer | null>(null)

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    transcriptRef.current = transcript
  }, [transcript])

  useEffect(() => {
    void getDesignProblems()
      .then((r) => {
        if (r.presets?.length) setPresets(r.presets)
      })
      .catch(() => {
        /* keep FALLBACK_PRESETS */
      })
  }, [])

  useEffect(() => {
    if (problemId === 'custom') {
      const raw = customProblem.trim()
      const line = raw.split('\n')[0] || 'Describe your design question below, then apply.'
      setProblemTitle('Custom design problem')
      setProblemSummary(line.length > 220 ? `${line.slice(0, 217)}…` : line)
      return
    }
    const p = presets.find((x) => x.id === problemId)
    if (p) {
      setProblemTitle(p.title)
      setProblemSummary(p.summary)
    }
  }, [problemId, customProblem, presets])

  useEffect(() => {
    liveProblemBriefRef.current = { title: problemTitle, summary: problemSummary }
  }, [problemTitle, problemSummary])

  const syncDesignProblem = useCallback(async (sid: string, pid: string, custom: string) => {
    let body: { preset_id?: string; custom_problem?: string }
    if (pid === 'custom' && custom.trim()) {
      body = { custom_problem: custom.trim() }
    } else if (pid === 'custom') {
      body = { preset_id: 'url_shortener' }
      setProblemId('url_shortener')
    } else {
      body = { preset_id: pid }
    }
    setProblemSyncBusy(true)
    setProblemSyncError(null)
    try {
      const r = await setDesignProblem(sid, body)
      setProblemTitle(r.title)
      setProblemSummary(r.summary)
      liveProblemBriefRef.current = { title: r.title, summary: r.summary }
      setProblemVersion((v) => v + 1)
    } catch (e) {
      setProblemSyncError(
        e instanceof ApiError ? e.message : 'Could not update design problem on the server.',
      )
    } finally {
      setProblemSyncBusy(false)
    }
  }, [])

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
    if (autoFeedback) return
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
  }, [listening, autoFeedback])

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
    if (!sessionId || !transcript || autoFeedback) return
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
  }, [sessionId, transcript, invalidateSession, autoFeedback])

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
    setTranscript('')
    liveOpeningSentRef.current = false
    liveAmbientAllowedRef.current = false
    liveModelBusyRef.current = false

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
                ws.send(JSON.stringify(buildLiveSessionStartTurn(liveProblemBriefRef.current)))
              }
              setLiveReady(true)
              setLiveStatus('live')
              break
            case 'audio':
              liveModelBusyRef.current = true
              if (!liveAudioRef.current) liveAudioRef.current = new LiveAudioOut()
              liveAudioRef.current.enqueueBase64Pcm16Le(parsed.base64Pcm, parsed.mimeType)
              break
            case 'input_transcription': {
              const piece = parsed.text
              if (!piece) break
              setTranscript((prev) => {
                if (parsed.finished) {
                  return prev ? `${prev} ${piece}`.trim() : piece
                }
                return prev ? `${prev}${piece}` : piece
              })
              break
            }
            case 'output_transcription':
              liveModelBusyRef.current = true
              setLiveStreamText((prev) => prev + parsed.text)
              break
            case 'interrupted':
              liveModelBusyRef.current = false
              liveAudioRef.current?.interrupt()
              setLiveAmbientGate((g) => g + 1)
              break
            case 'text':
              liveModelBusyRef.current = true
              setLiveStreamText((prev) => prev + parsed.text)
              break
            case 'turn_complete':
              liveModelBusyRef.current = false
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
      liveMicRef.current?.stop()
      liveMicRef.current = null
      if (liveWsRef.current === ws) liveWsRef.current = null
      ws.close()
      liveAudioRef.current?.close()
      liveAudioRef.current = null
    }
  }, [autoFeedback, sessionId, problemVersion])

  useEffect(() => {
    if (!autoFeedback || !liveReady) {
      liveMicRef.current?.stop()
      liveMicRef.current = null
      return
    }
    if (!micSupported) {
      setVoiceError('Microphone access is required for Live voice input (getUserMedia).')
      return
    }

    let cancelled = false
    let attempts = 0
    const streamer = new LiveMicStreamer(() => liveWsRef.current)

    const tryStart = () => {
      if (cancelled) return
      const w = liveWsRef.current
      if (!w || w.readyState !== WebSocket.OPEN) {
        if (attempts++ < 50) window.setTimeout(tryStart, 100)
        return
      }
      void streamer.start().then(() => {
        if (cancelled) {
          streamer.stop()
          return
        }
        liveMicRef.current = streamer
        setVoiceError(null)
      }).catch((e) => {
        if (!cancelled) {
          setVoiceError(e instanceof Error ? e.message : 'Could not open microphone.')
        }
      })
    }

    window.setTimeout(tryStart, 0)

    return () => {
      cancelled = true
      streamer.stop()
      if (liveMicRef.current === streamer) liveMicRef.current = null
    }
  }, [autoFeedback, liveReady, micSupported])

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
    if (liveModelBusyRef.current) return
    const ws = liveWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const dj = diagramForLiveRef.current.trim()
    if (!dj) return

    const ms = 4000
    const id = window.setTimeout(() => {
      if (liveWsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
      if (!liveAmbientAllowedRef.current) return
      if (liveModelBusyRef.current) return
      ws.send(JSON.stringify(buildLiveDiagramOnlyContext(diagramForLiveRef.current)))
    }, ms)
    return () => clearTimeout(id)
  }, [diagramEpoch, autoFeedback, liveReady, sessionId, liveAmbientGate])

  return (
    <div className="app-shell">
      <GcpTokenModal
        open={showGcp}
        onVerify={(token, projectId) => verifyGcp(token, projectId)}
        onVerified={(res) => {
          setSessionId(res.session_id)
          setGcpProjectId(res.project_id)
          setShowGcp(false)
          const pid =
            problemId === 'custom' && !customProblem.trim() ? 'url_shortener' : problemId
          if (problemId === 'custom' && !customProblem.trim()) {
            setProblemId('url_shortener')
          }
          void syncDesignProblem(res.session_id, pid, customProblem)
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
        <div className="problem-banner-top">
          <h2 id="problem-title">{problemTitle}</h2>
          <div className="problem-picker" role="group" aria-label="Design problem">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`problem-chip${problemId === p.id ? ' active' : ''}`}
                disabled={problemSyncBusy}
                onClick={() => {
                  setProblemId(p.id)
                  if (sessionId) void syncDesignProblem(sessionId, p.id, customProblem)
                }}
              >
                {p.title}
              </button>
            ))}
            <button
              type="button"
              className={`problem-chip${problemId === 'custom' ? ' active' : ''}`}
              disabled={problemSyncBusy}
              onClick={() => setProblemId('custom')}
            >
              Custom
            </button>
          </div>
        </div>
        {problemId === 'custom' ? (
          <div className="problem-custom">
            <label htmlFor="custom-problem" className="field-label">
              Your problem
            </label>
            <textarea
              id="custom-problem"
              className="problem-custom-input"
              rows={3}
              placeholder="e.g. Design a distributed cache, a real-time collaboration editor, a URL shortener…"
              value={customProblem}
              onChange={(e) => setCustomProblem(e.target.value)}
              disabled={problemSyncBusy}
            />
            {sessionId ? (
              <button
                type="button"
                className="btn secondary problem-apply"
                disabled={problemSyncBusy}
                onClick={() => void syncDesignProblem(sessionId, 'custom', customProblem)}
              >
                {problemSyncBusy ? 'Saving…' : 'Apply custom problem'}
              </button>
            ) : (
              <p className="problem-custom-hint">Sign in to use a custom problem with AI feedback and Live mode.</p>
            )}
          </div>
        ) : null}
        <p className="problem-summary">{problemSummary}</p>
        {problemSyncError ? <p className="form-error problem-sync-err">{problemSyncError}</p> : null}
      </section>

      <main className="app-main">
        <div className="canvas-column">
          <VoiceControls
            sessionReady={Boolean(sessionId)}
            listening={listening}
            speechSupported={speechSupported}
            micSupported={micSupported}
            voiceError={voiceError}
            transcript={transcript}
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
