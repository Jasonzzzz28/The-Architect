/** Stream Gemini Live native-audio chunks (PCM, typically 24 kHz s16le) via Web Audio. */

const DEFAULT_SAMPLE_RATE = 24000

export function sampleRateFromMime(mime: string): number {
  const m = /rate=(\d+)/i.exec(mime)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n > 0) return n
  }
  return DEFAULT_SAMPLE_RATE
}

export class LiveAudioOut {
  private ctx: AudioContext | null = null
  private nextStart = 0
  private sources = new Set<AudioBufferSourceNode>()
  /** Serialize chunk scheduling — parallel `.then()` races caused overlapping / stutter playback. */
  private scheduleChain: Promise<void> = Promise.resolve()

  interrupt(): void {
    this.scheduleChain = Promise.resolve()
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear()
    if (this.ctx) this.nextStart = this.ctx.currentTime
  }

  close(): void {
    this.scheduleChain = Promise.resolve()
    this.interrupt()
    const c = this.ctx
    this.ctx = null
    this.nextStart = 0
    if (c) void c.close()
  }

  /** Base64-encoded little-endian PCM16 mono. */
  enqueueBase64Pcm16Le(base64: string, mimeType = ''): void {
    const rate = sampleRateFromMime(mimeType)
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: rate })
      this.nextStart = this.ctx.currentTime
    } else if (Math.abs(this.ctx.sampleRate - rate) > 1) {
      this.scheduleChain = Promise.resolve()
      this.interrupt()
      void this.ctx.close()
      this.ctx = new AudioContext({ sampleRate: rate })
      this.nextStart = this.ctx.currentTime
    }
    const ctx = this.ctx
    const bytes = base64ToBytes(base64)
    const sampleCount = Math.floor(bytes.byteLength / 2)
    if (sampleCount <= 0) return

    const dv = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2)
    const f32 = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      f32[i] = dv.getInt16(i * 2, true) / 32768
    }

    const buffer = ctx.createBuffer(1, sampleCount, rate)
    buffer.copyToChannel(f32, 0)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)

    this.scheduleChain = this.scheduleChain.then(async () => {
      try {
        await this.ensureRunning(ctx)
        const t = Math.max(ctx.currentTime, this.nextStart)
        src.start(t)
        this.nextStart = t + buffer.duration
        this.sources.add(src)
        src.onended = () => {
          this.sources.delete(src)
        }
      } catch (e) {
        console.error('LiveAudioOut schedule failed', e)
      }
    })
  }

  private async ensureRunning(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'suspended') await ctx.resume()
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
