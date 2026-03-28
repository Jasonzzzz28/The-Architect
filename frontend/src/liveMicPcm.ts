/**
 * Stream microphone PCM (16 kHz s16le, base64) to Gemini Live via WebSocket JSON frames.
 * End-of-turn / response timing is driven by Vertex automatic activity detection on the server.
 */

const TARGET_SAMPLE_RATE = 16000

function downsampleToInt16(input: Float32Array, inputRate: number, outRate: number): Int16Array {
  if (inputRate === outRate) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    }
    return out
  }
  const ratio = inputRate / outRate
  const outLen = Math.floor(input.length / ratio)
  if (outLen <= 0) return new Int16Array(0)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    const s = input[i0] * (1 - frac) + input[i1] * frac
    const clamped = Math.max(-1, Math.min(1, s))
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }
  return out
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export class LiveMicStreamer {
  private readonly getWs: () => WebSocket | null
  private ctx: AudioContext | null = null
  private proc: ScriptProcessorNode | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null

  constructor(getWs: () => WebSocket | null) {
    this.getWs = getWs
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not available in this browser.')
    }
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
      video: false,
    })
    this.stream = media

    const ctx = new AudioContext()
    this.ctx = ctx
    const source = ctx.createMediaStreamSource(media)
    this.source = source

    const bufferSize = 4096
    const proc = ctx.createScriptProcessor(bufferSize, 1, 1)
    this.proc = proc

    proc.onaudioprocess = (ev) => {
      const ws = this.getWs()
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const input = ev.inputBuffer.getChannelData(0)
      if (!input.length) return
      const int16 = downsampleToInt16(input, ctx.sampleRate, TARGET_SAMPLE_RATE)
      if (!int16.length) return
      const data = int16ToBase64(int16)
      try {
        ws.send(
          JSON.stringify({
            realtime_input: {
              media_chunks: [
                {
                  mime_type: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
                  data,
                },
              ],
            },
          }),
        )
      } catch {
        /* ignore send failures during teardown */
      }
    }

    source.connect(proc)
    proc.connect(ctx.destination)

    if (ctx.state === 'suspended') await ctx.resume()
  }

  stop(): void {
    try {
      this.proc?.disconnect()
      this.source?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      void this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.proc = null
    this.source = null
    this.ctx = null
    this.stream = null
  }
}

export function isGetUserMediaSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}
