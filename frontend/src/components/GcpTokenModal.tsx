import { useState } from 'react'
import type { VerifyResponse } from '../api'

type Props = {
  open: boolean
  onVerified: (res: { session_id: string; project_id: string }) => void
  onVerify: (token: string, projectId: string | undefined) => Promise<VerifyResponse>
}

export function GcpTokenModal({ open, onVerified, onVerify }: Props) {
  const [token, setToken] = useState('')
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const t = token.trim()
    if (!t) {
      setError('Enter your GCP OAuth access token.')
      return
    }
    setBusy(true)
    try {
      const res = await onVerify(t, projectId.trim() || undefined)
      onVerified({ session_id: res.session_id, project_id: res.project_id })
      setToken('')
      setProjectId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="gcp-title">
      <div className="modal">
        <h2 id="gcp-title">Connect with GCP access token</h2>
        <p className="modal-lead">
          Paste the same <strong>OAuth 2.0 access token</strong> you use for Google Cloud APIs. The app
          verifies it with Cloud Resource Manager, then calls <strong>Vertex AI (Gemini)</strong> with that
          token for interview feedback. Use a token with{' '}
          <code>https://www.googleapis.com/auth/cloud-platform</code> (for example{' '}
          <code>gcloud auth print-access-token</code> after <code>gcloud auth login</code>).
        </p>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="gcp-token">
            Access token
          </label>
          <textarea
            id="gcp-token"
            className="token-input"
            rows={4}
            placeholder="ya29…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <label className="field-label" htmlFor="gcp-project">
            GCP project ID <span className="optional-mark">(optional)</span>
          </label>
          <input
            id="gcp-project"
            type="text"
            className="text-input"
            placeholder="my-gcp-project — leave empty to use first project from projects.list"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {error ? <p className="form-error">{error}</p> : null}
          <div className="modal-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify & start session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
