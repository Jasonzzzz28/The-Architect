type Props = {
  textFeedback: string
  diagramHints: string[]
  loading: boolean
  lastVoiceLine: string
}

export function FeedbackPanel({ textFeedback, diagramHints, loading, lastVoiceLine }: Props) {
  const textBody =
    textFeedback || (loading ? '' : 'Press “Get feedback” or enable auto-feedback.')

  return (
    <aside className="feedback-panel">
      <h2>Interviewer feedback</h2>
      {loading ? <p className="muted">Thinking…</p> : null}
      {lastVoiceLine ? (
        <blockquote className="voice-line">&ldquo;{lastVoiceLine}&rdquo;</blockquote>
      ) : null}

      <details className="feedback-details">
        <summary className="feedback-summary">Text</summary>
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
