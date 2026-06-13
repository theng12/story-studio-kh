/**
 * Fish Audio TTS — direct API client.
 *
 * Like ElevenLabs (and unlike the fal.ai / GenAIPro gateways, which hand back a
 * URL we then download), Fish Audio streams the audio bytes back inline, so we
 * write them straight to the caller's target path — no generate-then-download
 * round trip.
 *
 * Voices are chosen by `reference_id` — a model id from fish.audio, including
 * your own cloned voices. There is no fixed catalogue to enumerate, so the
 * Audio Generator surfaces a free-text reference-id field instead of a picker.
 *
 * Docs: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'

/** Default TTS model when the caller doesn't pin one. s2-pro is the flagship. */
export const DEFAULT_FISHAUDIO_MODEL = 's2-pro'

/** The only valid values for the Fish `model` request header. */
const FISH_MODELS = new Set(['s1', 's2-pro'])

export interface FishAudioTtsOptions {
  /**
   * Catalog model id ('fishaudio-s2-pro' / 'fishaudio-s1') or a bare Fish
   * model header value ('s2-pro' / 's1'). The 'fishaudio-' prefix is stripped
   * and the result is validated against the known set; anything unknown falls
   * back to the default so a stale catalog id can never 400 the request.
   */
  model?: string
  /** reference_id — the Fish voice/model id (including your cloned voices). */
  voiceId?: string
  /** 0.5–2.0 playback-speed multiplier → prosody.speed (omitted when 1). */
  speed?: number
  /** Output container. Defaults to mp3. */
  format?: 'mp3' | 'wav' | 'pcm' | 'opus'
  /** Abort signal for caller-level timeouts. */
  signal?: AbortSignal
  /** Streaming progress callback — fires per chunk as bytes arrive. */
  onProgress?: (bytesReceived: number, totalBytes?: number) => void
}

/** Map a catalog/model id to the Fish `model` header value. */
function resolveFishModel(model?: string): string {
  if (!model) return DEFAULT_FISHAUDIO_MODEL
  const bare = model.startsWith('fishaudio-') ? model.slice('fishaudio-'.length) : model
  return FISH_MODELS.has(bare) ? bare : DEFAULT_FISHAUDIO_MODEL
}

/** Shared POST helper — both the file writer and the buffer reader call this. */
async function callTts(text: string, apiKey: string, opts: FishAudioTtsOptions): Promise<Response> {
  if (!apiKey) throw new Error('No Fish Audio API key configured. Add one in Settings → API Keys.')
  if (!opts.voiceId) {
    throw new Error(
      'Fish Audio needs a voice reference ID. Paste one in the Voice field '
      + '(your cloned voice id, or any model id from fish.audio).',
    )
  }

  const format = opts.format || 'mp3'
  const body: Record<string, unknown> = {
    text,
    reference_id: opts.voiceId,
    format,
    mp3_bitrate: 128,
    normalize: true,
    latency: 'normal',
  }
  // prosody.speed defaults to 1 server-side; only send it when it differs.
  if (typeof opts.speed === 'number' && opts.speed !== 1) {
    body.prosody = { speed: opts.speed }
  }

  const resp = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Selects the TTS model. Only 's1' / 's2-pro' are valid.
      model: resolveFishModel(opts.model),
    },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(180000),
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Fish Audio TTS failed (${resp.status}): ${errText.slice(0, 300)}`)
  }
  return resp
}

/**
 * Synthesize speech and write the bytes directly to `outPath`.
 * Creates parent directories as needed. Throws on non-2xx or network error.
 */
export async function generateTtsToFile(
  text: string,
  apiKey: string,
  outPath: string,
  opts: FishAudioTtsOptions = {},
): Promise<void> {
  const resp = await callTts(text, apiKey, opts)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  // Fish streams chunked, so content-length is usually absent (total undefined).
  const cl = resp.headers.get('content-length')
  const total = cl ? Number(cl) || undefined : undefined
  let received = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      try { opts.onProgress?.(received, total) } catch { /* never let UI plumbing kill a download */ }
      cb(null, chunk)
    },
  })
  const out = createWriteStream(outPath)
  // Delete partial file on mid-stream error — otherwise the audio generator's
  // fileExistsWithContent cache guard would treat a truncated MP3 as a valid
  // hit on retry and skip regeneration.
  try {
    await pipeline(Readable.fromWeb(resp.body as any), counter, out)
  } catch (e) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw e
  }
}

/**
 * Synthesize speech and return the bytes in memory. Used for short-lived
 * voice previews where we inline the result as a data URL.
 */
export async function generateTtsBuffer(
  text: string,
  apiKey: string,
  opts: FishAudioTtsOptions = {},
): Promise<Buffer> {
  const resp = await callTts(text, apiKey, opts)
  const arr = await resp.arrayBuffer()
  return Buffer.from(arr)
}
