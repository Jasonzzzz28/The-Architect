import type { LiveConnectionStatus } from '../liveWs'

type Props = {
  sessionReady: boolean
  listening: boolean
  supported: boolean
  voiceError: string | null
  transcript: string
  onTranscriptChange: (value: string) => void
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
  supported,
  voiceError,
  transcript,
  onTranscriptChange,
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
        ? 'Live interviewer stays quiet unless you ask something, request feedback, or use Nudge. Context syncs after you pause (~3s; faster if you type a question).'
        : autoFeedback && liveStatus === 'error'
          ? 'Live connection issue — check the feedback panel or reconnect.'
          : null

  return (
    <div className="voice-controls">
      <div className="voice-row">
        <button
          type="button"
          className={`btn ${listening ? 'danger' : 'secondary'}`}
          onClick={onToggleListen}
          disabled={!sessionReady || !supported}
        >
          {listening ? 'Stop listening' : 'Start voice'}
        </button>
        <button
          type="button"
          className={`btn ${autoFeedback ? 'primary' : 'secondary'}`}
          onClick={onToggleAuto}
          disabled={!sessionReady}
          title="Vertex Gemini Live: streaming native audio + captions (WebSocket)"
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
      {!supported ? (
        <p className="muted small">
          Web Speech API not available in this browser. You can still type in the transcript area or
          use Chrome / Edge.
        </p>
      ) : null}
      <label className="transcript-label" htmlFor="transcript">
        Live transcript
      </label>
      <textarea
        id="transcript"
        className="transcript-area"
        rows={5}
        value={transcript}
        readOnly={listening}
        onChange={(e) => {
          if (!listening) onTranscriptChange(e.target.value)
        }}
        placeholder={
          supported
            ? 'Speak your design, or type here if speech is unavailable.'
            : 'Type your system design explanation here.'
        }
      />
    </div>
  )
}
