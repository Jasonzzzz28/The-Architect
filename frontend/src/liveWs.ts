export type LiveConnectionStatus = 'off' | 'connecting' | 'live' | 'error'

/** Stable context updates: wait this long after transcript/diagram stops changing. */
export const LIVE_DEBOUNCE_MS = 3000

/** When the candidate asks a question or asks for feedback, respond sooner. */
export const LIVE_DEBOUNCE_URGENT_MS = 400

/**
 * True if transcript suggests T1/T2 (question or ask for interviewer input).
 * Speech-to-text often omits "?" — match common spoken question shapes and asks.
 */
export function liveTranscriptLooksUrgent(transcript: string): boolean {
  const t = transcript.trim()
  if (!t) return false

  if (/\?/.test(t)) return true

  if (
    /\b(feedback|what do you think|your thoughts|anything i'?m missing|am i missing|clarify|does that make sense|any thoughts|not sure|i wonder|i was wondering|quick question|want your (take|opinion)|hear your thoughts)\b/i.test(
      t,
    )
  ) {
    return true
  }

  // WH-word + auxiliary (e.g. "how does that work", "what would you want", "where does it go")
  if (/\b(what|how|when|where|why|who|which)\s+(is|are|was|were|do|does|did|would|could|should|will|can)\s/i.test(t)) {
    return true
  }

  if (/\bhow\s+(about|come|long|much|many|often|does|do|would|should|can|is)\b/i.test(t)) return true
  // "explain how it works" / "how sharding works" (STT often no "?")
  if (/\bhow\s+(\w+\s+){0,4}works?\b/i.test(t)) return true
  if (/\bwhat\s+(about|if|else|happens?)\b/i.test(t)) return true

  // Modal questions ("should I shard", "could we use", "can you explain")
  if (/\b(should|could|would|can)\s+i\s/i.test(t)) return true
  if (/\b(do|does)\s+you\s+(think|want|mean|recommend|expect|prefer|see|agree|suggest)\b/i.test(t)) return true
  if (/\b(is|are)\s+(we|you|they|it)\s+(ok|okay|allowed|supposed|expected)\b/i.test(t)) return true
  if (/\b(can|could|would)\s+you\s+(help|explain|clarify|confirm|tell|elaborate|walk|describe)\b/i.test(t)) {
    return true
  }

  // "which database", "who owns", "any constraints"
  if (/\bwhich\s+(one|approach|option|database|service|layer|tool|strategy)\b/i.test(t)) return true
  if (/\bwho\s+(handles|owns|calls|uses)\b/i.test(t)) return true
  if (/\b(any|some)\s+(constraints|requirements|preference|concern|downside|risk|limits?)\b/i.test(t)) {
    return true
  }
  if (/\b(thoughts\s+on|make sense|sound right|reasonable approach)\b/i.test(t)) return true

  return false
}

export function liveDebounceMsForTranscript(transcript: string): number {
  return liveTranscriptLooksUrgent(transcript) ? LIVE_DEBOUNCE_URGENT_MS : LIVE_DEBOUNCE_MS
}

/** Normalize browser WebSocket `data` (string, Blob, ArrayBuffer) to UTF-8 text for JSON parsing. */
export async function wsPayloadToUtf8(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView
    return new TextDecoder().decode(
      v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    )
  }
  return String(data)
}

/** WebSocket URL for Vertex Live bridge (same host as the app; Vite proxies /ws → backend). */
export function liveWebSocketUrl(sessionId: string): string {
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const origin = (import.meta.env.VITE_WS_ORIGIN as string | undefined)?.replace(/\/$/, '')
  const base = origin || `${wsProto}//${window.location.host}`
  return `${base}/ws/live?session_id=${encodeURIComponent(sessionId)}`
}

/** T0 — one opening turn; sent once after `setupComplete`. */
export function buildLiveSessionStartTurn(): object {
  return {
    client_content: {
      turns: [
        {
          role: 'user',
          parts: [
            {
              text: '(Session start — T0.) You are connected with the candidate. Give exactly ONE brief spoken opening: restate the URL-shortener design problem in one or two sentences, tell them to walk you through their approach and to ask you for requirements or constraints, then STOP and wait. Do not ask them to repeat everything they said.',
            },
          ],
        },
      ],
      turn_complete: true,
    },
  }
}

/** Diagram-only text turn while user audio is streamed via `realtime_input`. */
export function buildLiveDiagramOnlyContext(diagramJson: string): object {
  const cap = 12000
  let body =
    '(Canvas update only — your speech is streamed as live audio; use server voice activity to detect end of user turns. Do not treat this JSON alone as a new spoken turn. Stay silent unless T3 applies to the diagram.)\n\n'
  if (diagramJson.trim()) {
    body += `Excalidraw JSON (truncated):\n${diagramJson.slice(0, cap)}`
  } else {
    body += '(empty canvas snapshot)'
  }
  return {
    client_content: {
      turns: [{ role: 'user', parts: [{ text: body }] }],
      turn_complete: true,
    },
  }
}

/** Background context for T3 only; model should usually stay silent. */
export function buildLiveContextUpdate(transcript: string, diagramJson: string): object {
  const cap = 12000
  let body =
    '(Candidate context update — for your awareness only. Default: **stay silent** per your system instructions. Only speak if T3 applies: a rare, high-value checkpoint after a clearly finished thought, and only if you have something material to say. Never narrate every edit.)\n\n'
  body += `Latest transcript:\n${transcript.trim() || '(empty)'}\n`
  if (diagramJson) {
    body += `\nExcalidraw JSON (truncated):\n${diagramJson.slice(0, cap)}`
  }
  return {
    client_content: {
      turns: [{ role: 'user', parts: [{ text: body }] }],
      turn_complete: true,
    },
  }
}

/** Manual nudge: answer question or give feedback once, then stop. */
export function buildLiveNudgeTurn(transcript: string, diagramJson: string): object {
  const cap = 12000
  let body =
    '(The candidate pressed “Nudge interviewer” — respond **once**.) Answer their last direct question if they asked one; otherwise give **focused** feedback on the design or explanation. Then stop.\n\n'
  body += `Transcript:\n${transcript.trim() || '(empty)'}\n`
  if (diagramJson) {
    body += `\nDiagram JSON (truncated):\n${diagramJson.slice(0, cap)}`
  }
  return {
    client_content: {
      turns: [{ role: 'user', parts: [{ text: body }] }],
      turn_complete: true,
    },
  }
}

export type ParsedLive =
  | { kind: 'setup_complete' }
  | { kind: 'text'; text: string }
  | { kind: 'audio'; base64Pcm: string; mimeType: string }
  | { kind: 'input_transcription'; text: string; finished: boolean }
  | { kind: 'output_transcription'; text: string; finished: boolean }
  | { kind: 'turn_complete' }
  | { kind: 'interrupted' }
  | { kind: 'architect_error'; message: string }
  | { kind: 'ignored' }

type InlineBlob = {
  mimeType?: string
  mime_type?: string
  data?: string
}

function partInlineData(p: object): InlineBlob | undefined {
  const o = p as { inlineData?: InlineBlob; inline_data?: InlineBlob }
  return o.inlineData ?? o.inline_data
}

/** One WebSocket frame may include several signals (e.g. audio + turnComplete). */
export function parseLiveServerMessages(raw: string): ParsedLive[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  const out: ParsedLive[] = []

  if (typeof d.architect_error === 'string') {
    return [{ kind: 'architect_error', message: d.architect_error }]
  }
  if (d.setupComplete || d.setup_complete) {
    return [{ kind: 'setup_complete' }]
  }

  const sc = (d.serverContent ?? d.server_content) as Record<string, unknown> | undefined
  if (!sc) return []

  if (sc.interrupted) {
    out.push({ kind: 'interrupted' })
  }

  const it = (sc.inputTranscription ?? sc.input_transcription) as
    | { text?: string; finished?: boolean }
    | undefined
  if (it && typeof it.text === 'string') {
    out.push({
      kind: 'input_transcription',
      text: it.text,
      finished: Boolean(it.finished),
    })
  }

  const ot = (sc.outputTranscription ?? sc.output_transcription) as
    | { text?: string; finished?: boolean }
    | undefined
  if (ot && typeof ot.text === 'string') {
    out.push({
      kind: 'output_transcription',
      text: ot.text,
      finished: Boolean(ot.finished),
    })
  }

  const mt = (sc.modelTurn ?? sc.model_turn) as { parts?: object[] } | undefined
  const parts = mt?.parts
  if (parts?.length) {
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue
      const id = partInlineData(p)
      if (id?.data && typeof id.data === 'string') {
        const mime = id.mimeType ?? id.mime_type ?? ''
        const looksAudio =
          /pcm|L16|audio|rate=|octet-stream/i.test(mime) || (!mime && id.data.length > 64)
        if (looksAudio) {
          out.push({ kind: 'audio', base64Pcm: id.data, mimeType: mime })
        }
      }
    }
    const textChunks = parts
      .map((p) => {
        if (!p || typeof p !== 'object') return ''
        return typeof (p as { text?: string }).text === 'string'
          ? (p as { text: string }).text
          : ''
      })
      .filter(Boolean)
    if (textChunks.length) {
      out.push({ kind: 'text', text: textChunks.join('') })
    }
  }

  if (sc.turnComplete || sc.turn_complete) {
    out.push({ kind: 'turn_complete' })
  }

  return out
}

/** @deprecated Prefer parseLiveServerMessages — one frame can carry multiple events. */
export function parseLiveServerJson(raw: string): ParsedLive {
  const all = parseLiveServerMessages(raw)
  return all[0] ?? { kind: 'ignored' }
}
