import type { LiveConnectionStatus } from '../liveWs'

type Props = {
  sessionReady: boolean
  listening: boolean
  speechSupported: boolean
  micSupported: boolean
  voiceError: string | null
  transcript: string
  onToggleListen: () => void
  autoFeedback: boolean
  onToggleAuto: () => void
  onGetFeedback: () => void
  feedbackBusy: boolean
  liveStatus: LiveConnectionStatus
  liveReady: boolean
  onNudgeInterviewer: () => void
}

export function VoiceControls({
  sessionReady,
  listening,
  speechSupported,
  micSupported,
  voiceError,
  transcript,
  onToggleListen,
  autoFeedback,
  onToggleAuto,
  onGetFeedback,
  feedbackBusy,
  liveStatus,
  liveReady,
  onNudgeInterviewer,
}: Props) {
  const liveHint =
    autoFeedback && liveStatus === 'connecting'
      ? 'Connecting to Gemini Live…'
      : autoFeedback && liveStatus === 'live'
        ? 'Your microphone is streamed to Gemini Live; end-of-speech is detected on the server so the interviewer decides when to reply. Diagram-only updates sync about every 4s after edits. Use Nudge for an immediate reply.'
        : autoFeedback && liveStatus === 'error'
          ? 'Live connection issue — check the feedback panel or reconnect.'
          : null

  const startVoiceDisabled = !sessionReady || autoFeedback || !speechSupported

  return (
    <div className="voice-controls">
      <div className="voice-row">
        <button
          type="button"
          className={`btn ${listening ? 'danger' : 'secondary'}`}
          onClick={onToggleListen}
          disabled={startVoiceDisabled}
          title={
            autoFeedback
              ? 'With Auto (Live) on, speech goes to Gemini via the microphone stream.'
              : undefined
          }
        >
          {listening ? 'Stop listening' : 'Start voice'}
        </button>
        <button
          type="button"
          className={`btn ${autoFeedback ? 'primary' : 'secondary'}`}
          onClick={onToggleAuto}
          disabled={!sessionReady || (autoFeedback && !micSupported)}
          title={
            !micSupported
              ? 'Live voice input needs microphone access (getUserMedia).'
              : 'Vertex Gemini Live: mic → server activity detection → native audio replies'
          }
        >
          Auto (Live) {autoFeedback ? 'on' : 'off'}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={onGetFeedback}
          disabled={!sessionReady || feedbackBusy}
        >
          {feedbackBusy ? '…' : 'Get feedback'}
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={onNudgeInterviewer}
          disabled={!autoFeedback || !liveReady || liveStatus !== 'live'}
          title="Ask the Live interviewer to answer your question or give feedback now"
        >
          Nudge interviewer
        </button>
      </div>
      {liveHint ? <p className="muted small">{liveHint}</p> : null}
      {voiceError ? <p className="form-error small voice-error">{voiceError}</p> : null}
      {!speechSupported && !autoFeedback ? (
        <p className="muted small">
          Web Speech API is not available. Use Chrome or Edge for <strong>Start voice</strong>, or turn on{' '}
          <strong>Auto (Live)</strong> if this browser supports the microphone API.
        </p>
      ) : null}
      {autoFeedback && !micSupported ? (
        <p className="muted small">
          This browser does not expose <code>getUserMedia</code>; Live voice input will not work here.
        </p>
      ) : null}
      <label className="transcript-label" htmlFor="transcript">
        Live transcript{' '}
        <span className="transcript-label-hint">
          {autoFeedback ? '(from Gemini input transcription, read-only)' : '(voice only, read-only)'}
        </span>
      </label>
      <textarea
        id="transcript"
        className="transcript-area"
        rows={5}
        value={transcript}
        readOnly
        aria-readonly="true"
        placeholder={
          autoFeedback && liveReady
            ? 'Speak toward the mic — Gemini transcribes your words here when the API sends captions.'
            : speechSupported
              ? listening
                ? 'Listening…'
                : 'Press Start voice — your words appear here automatically.'
              : micSupported
                ? 'Turn on Auto (Live) to speak into Gemini, or use a browser with Web Speech for Start voice.'
                : 'Voice capture unavailable in this browser.'
        }
      />
    </div>
  )
}
