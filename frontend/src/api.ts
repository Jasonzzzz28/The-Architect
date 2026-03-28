const base = () => import.meta.env.VITE_API_BASE?.replace(/\/$/, '') || '/api'

export class ApiError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

function messageFromFastApiBody(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { detail?: unknown }
    const d = j.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d))
      return d
        .map((x) =>
          typeof x === 'object' && x !== null && 'msg' in x
            ? String((x as { msg: string }).msg)
            : JSON.stringify(x),
        )
        .join('; ')
  } catch {
    /* not JSON */
  }
  return body.trim() || `HTTP ${status}`
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string>),
    },
  })
  if (!r.ok) {
    const body = await r.text()
    throw new ApiError(messageFromFastApiBody(body, r.status), r.status, body)
  }
  return r.json() as Promise<T>
}

export type VerifyResponse = {
  valid: boolean
  session_id: string
  project_id: string
  message: string
}

export type FeedbackResponse = {
  text_feedback: string
  diagram_hints: string[]
  voice_script: string
  mentioned_topics: string[]
}

export function verifyGcp(token: string, projectId?: string) {
  return json<VerifyResponse>('/verify-gcp', {
    method: 'POST',
    body: JSON.stringify({
      token,
      ...(projectId?.trim() ? { project_id: projectId.trim() } : {}),
    }),
  })
}

export function streamVoice(sessionId: string, transcript: string) {
  return json<{ status: string }>('/stream-voice', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, transcript }),
  })
}

export function sendDiagram(sessionId: string, diagram: object) {
  return json<{ status: string }>('/send-diagram', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, diagram }),
  })
}

export function getFeedback(
  sessionId: string,
  opts?: { transcript?: string; diagram?: object | null },
) {
  return json<FeedbackResponse>('/get-feedback', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      transcript: opts?.transcript,
      diagram: opts?.diagram ?? undefined,
    }),
  })
}

export type DesignPresetRow = { id: string; title: string; summary: string }

export type SetDesignProblemResponse = {
  problem_id: string
  title: string
  summary: string
}

export function getDesignProblems() {
  return json<{ presets: DesignPresetRow[] }>('/design-problems')
}

export function setDesignProblem(
  sessionId: string,
  body: { preset_id?: string; custom_problem?: string },
) {
  return json<SetDesignProblemResponse>('/session/design-problem', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      ...body,
    }),
  })
}
