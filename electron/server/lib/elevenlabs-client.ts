/**
 * ElevenLabs TTS — direct API client.
 *
 * Unlike the fal.ai / genaipro gateways (which return a URL we then download),
 * ElevenLabs' direct endpoint streams MP3 bytes back inline. We save those
 * bytes straight to the caller's target path, so callers don't need the
 * two-step generate-then-download pattern.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'

/**
 * Default model id if none specified. Mirrors the ElevenLabs web app default.
 */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2'

export interface ElevenLabsTtsOptions {
  /** ElevenLabs model_id. e.g. 'eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'. */
  model?: string
  /** Voice id to synthesize. Required. */
  voiceId?: string
  /** 0..1 — how strictly the voice sticks to its reference. */
  stability?: number
  /** 0..1 — how strongly similar to the reference voice. */
  similarity?: number
  /** 0..1 — style exaggeration. Optional; omitted if undefined. */
  style?: number
  /** Whether to boost the speaker's identity. */
  useSpeakerBoost?: boolean
  /**
   * Relative speed: 0.7 (slowest) → 1.2 (fastest). ElevenLabs accepts this
   * natively on v3; we pass it through unchanged and let the API clamp.
   */
  speed?: number
  /** Abort signal for caller-level timeouts. */
  signal?: AbortSignal
  /** Streaming progress callback — fires per chunk while the MP3 is downloading. */
  onProgress?: (bytesReceived: number, totalBytes?: number) => void
}

/** Shared POST helper — both the file writer and the buffer reader call this. */
async function callTts(text: string, apiKey: string, opts: ElevenLabsTtsOptions): Promise<Response> {
  if (!apiKey) throw new Error('No ElevenLabs API key configured')
  if (!opts.voiceId) throw new Error('ElevenLabs requires a voice_id. Set one in Settings → Voices.')

  const modelId = opts.model || DEFAULT_ELEVENLABS_MODEL
  const voiceSettings: Record<string, unknown> = {
    stability: opts.stability ?? 0.5,
    similarity_boost: opts.similarity ?? 0.75,
    use_speaker_boost: opts.useSpeakerBoost ?? true,
  }
  if (typeof opts.style === 'number') voiceSettings.style = opts.style
  if (typeof opts.speed === 'number') voiceSettings.speed = opts.speed

  const body = { text, model_id: modelId, voice_settings: voiceSettings }

  // Non-streaming endpoint; fast enough for chapter-length chunks. If we ever
  // need lower latency, switch to `/stream`.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(180000),
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`ElevenLabs TTS failed (${resp.status}): ${errText.slice(0, 300)}`)
  }
  return resp
}

/**
 * Synthesize speech and write the MP3 bytes directly to `outPath`.
 * Creates parent directories as needed. Throws on non-2xx or network error.
 */
export async function generateTtsToFile(
  text: string,
  apiKey: string,
  outPath: string,
  opts: ElevenLabsTtsOptions = {},
): Promise<void> {
  const resp = await callTts(text, apiKey, opts)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
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
 * Synthesize speech and return the MP3 bytes in memory. Use this for
 * short-lived previews where we want to inline the result as a data URL.
 */
export async function generateTtsBuffer(
  text: string,
  apiKey: string,
  opts: ElevenLabsTtsOptions = {},
): Promise<Buffer> {
  const resp = await callTts(text, apiKey, opts)
  const arr = await resp.arrayBuffer()
  return Buffer.from(arr)
}

// ── Sound effects (text → SFX) ──────────────────────────────────────────
//
// Endpoint:  POST https://api.elevenlabs.io/v1/sound-generation
// Auth:      `xi-api-key` header (same credential as TTS).
// Body:      { text, duration_seconds?, prompt_influence?, loop?, model_id? }
// Response:  binary MP3 (default output_format mp3_44100_128).
// Docs:      https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
// (The docs path moved from /sound-generation; the API endpoint is unchanged.)

export interface ElevenLabsSfxOptions {
  /** 0.5–22 s. Omit to let ElevenLabs auto-pick the length from the prompt. */
  durationSeconds?: number
  /** 0..1 — how literally the model follows the prompt vs. adds variety.
   *  API default is 0.3; we pass through and let the API default when omitted. */
  promptInfluence?: number
  /** Generate a seamlessly-loopable effect. Defaults to false. */
  loop?: boolean
  /** Abort signal for caller-level timeouts. */
  signal?: AbortSignal
}

/**
 * Generate a sound effect from a text prompt and write the MP3 bytes directly
 * to `outPath`. Creates parent directories as needed. Throws on non-2xx or
 * network error, removing any partial file.
 */
export async function generateSoundEffectToFile(
  text: string,
  apiKey: string,
  outPath: string,
  opts: ElevenLabsSfxOptions = {},
): Promise<void> {
  if (!apiKey) throw new Error('No ElevenLabs API key configured')
  const prompt = text.trim()
  if (!prompt) throw new Error('Sound-effect prompt text is required')

  const body: Record<string, unknown> = { text: prompt }
  if (typeof opts.durationSeconds === 'number') body.duration_seconds = opts.durationSeconds
  if (typeof opts.promptInfluence === 'number') body.prompt_influence = opts.promptInfluence
  if (opts.loop) body.loop = true

  const resp = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
    // SFX generation is short but can spike; 120s is a generous ceiling.
    signal: opts.signal ?? AbortSignal.timeout(120000),
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`ElevenLabs sound-generation failed (${resp.status}): ${errText.slice(0, 300)}`)
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const out = createWriteStream(outPath)
  try {
    await pipeline(Readable.fromWeb(resp.body as any), out)
  } catch (e) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw e
  }
}

/**
 * Quick connectivity + auth probe. Used by Settings → API Keys → Test.
 * Returns the subscription tier + character quota if valid.
 */
export async function getElevenLabsSubscription(apiKey: string): Promise<{
  tier: string
  character_count: number
  character_limit: number
} | null> {
  if (!apiKey) return null
  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null
    const data = await resp.json() as any
    return {
      tier: String(data.tier || 'unknown'),
      character_count: Number(data.character_count) || 0,
      character_limit: Number(data.character_limit) || 0,
    }
  } catch {
    return null
  }
}
