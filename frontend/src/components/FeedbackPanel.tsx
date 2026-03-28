import type { LiveConnectionStatus } from '../liveWs'

type Props = {
  textFeedback: string
  diagramHints: string[]
  loading: boolean
  lastVoiceLine: string
  liveStatus: LiveConnectionStatus
  liveStreamText: string
  liveError: string | null
  autoFeedbackOn: boolean
}

export function FeedbackPanel({
  textFeedback,
  diagramHints,
  loading,
  lastVoiceLine,
  liveStatus,
  liveStreamText,
  liveError,
  autoFeedbackOn,
}: Props) {
  const textBody =
    textFeedback || (loading ? '' : 'Press “Get feedback” or enable auto-feedback (Live).')

  const showLiveBlock = autoFeedbackOn || liveStreamText.length > 0 || liveError

  return (
    <aside className="feedback-panel">
      <h2>Interviewer feedback</h2>
      {loading ? <p className="muted">Thinking…</p> : null}
      {lastVoiceLine ? (
        <blockquote className="voice-line">&ldquo;{lastVoiceLine}&rdquo;</blockquote>
      ) : null}

      {showLiveBlock ? (
        <details className="feedback-details" open={Boolean(liveStreamText || liveError)}>
          <summary className="feedback-summary">
            Live (Gemini · voice + captions){' '}
            {liveStatus === 'connecting' ? (
              <span className="muted">· connecting…</span>
            ) : liveStatus === 'live' ? (
              <span className="live-dot" title="Streaming">
                · live
              </span>
            ) : liveStatus === 'error' ? (
              <span className="form-error small">· error</span>
            ) : null}
          </summary>
          <div className="feedback-details-body">
            {liveError ? <p className="form-error small">{liveError}</p> : null}
            {liveStreamText ? (
              <div className="feedback-text live-stream whitespace-pre-wrap">{liveStreamText}</div>
            ) : autoFeedbackOn && liveStatus === 'live' && !liveError ? (
              <p className="muted small">
                Waiting for the interviewer… speak or draw to send context. Audio plays automatically when the
                model responds.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <details className="feedback-details">
        <summary className="feedback-summary">Text (manual REST)</summary>
        <div className="feedback-details-body">
          <div className="feedback-text whitespace-pre-wrap">{textBody}</div>
        </div>
      </details>

      {diagramHints.length > 0 ? (
        <details className="feedback-details">
          <summary className="feedback-summary">Diagram hints</summary>
          <div className="feedback-details-body">
            <ul className="hint-list">
              {diagramHints.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </aside>
  )
}
