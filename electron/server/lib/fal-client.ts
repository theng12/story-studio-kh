/**
 * fal.ai TTS client — ElevenLabs via fal.ai.
 * Submits to queue, polls for completion, returns audio URL.
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { pollForResult, readJsonOrThrow } from './http-retry.js'
import { redactSecrets } from './redact-secrets.js'

// Map of audio model id (from config.audio_models) → fal.ai queue slug.
// Every id registered in `DEFAULT_AUDIO_MODELS` with `provider: 'fal'` must
// have a live queue endpoint here. Verified against fal.ai in Delivery 5 —
// see docs/refactors/fal-model-audit.md. Removed entries: `v2` (endpoint
// never existed on fal; ElevenLabs v2 is superseded by eleven-v3) and
// `flash-v2.5` (also never existed on fal — turbo-v2.5 is fal's low-latency
// option).
const FAL_MODELS: Record<string, string> = {
  'turbo-v2.5':      'fal-ai/elevenlabs/tts/turbo-v2.5',
  'multilingual-v2': 'fal-ai/elevenlabs/tts/multilingual-v2',
  'eleven-v3':       'fal-ai/elevenlabs/tts/eleven-v3',
}

const DEFAULT_VOICE_ID = '' // Configure a voice in Settings → Voices
const DEFAULT_SPEED = 0.93
const DEFAULT_STABILITY = 1.0
const DEFAULT_SIMILARITY = 1.0
const POLL_INTERVAL = 3000  // 3 seconds
const MAX_WAIT = 300000     // 5 minutes

export async function generateTts(
  text: string, apiKey: string, opts: {
    model?: string
    voiceId?: string
    speed?: number
    stability?: number
    similarity?: number
    /** Max wait for fal.ai queue completion, ms. Default 5 min. */
    timeoutMs?: number
    /** Probe for user cancel — polls stop immediately and the promise rejects. */
    isCancelled?: () => boolean
  } = {},
): Promise<string> {
  const requestedId = opts.model || 'turbo-v2.5'
  const falModel = FAL_MODELS[requestedId]
  if (!falModel) {
    // Previous behavior silently routed unknown ids to turbo-v2.5, which
    // masked typos and deprecated slugs. Fail loudly so the user sees the
    // bad model id in the generator error instead of a surprise turbo run.
    throw new Error(
      `Unknown fal.ai TTS model "${requestedId}". ` +
      `Known ids: ${Object.keys(FAL_MODELS).join(', ')}. ` +
      `Pick a different model in Settings → Models or the Audio panel.`,
    )
  }
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const payload = {
    text,
    voice: opts.voiceId || DEFAULT_VOICE_ID,
    stability: opts.stability ?? DEFAULT_STABILITY,
    similarity_boost: opts.similarity ?? DEFAULT_SIMILARITY,
    speed: opts.speed ?? DEFAULT_SPEED,
    apply_text_normalization: 'auto',
  }

  // Submit to queue
  const submitResp = await fetch(`https://queue.fal.run/${falModel}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!submitResp.ok) {
    const errText = await submitResp.text()
    throw new Error(`fal.ai submit failed (${submitResp.status}): ${redactSecrets(errText, apiKey)}`)
  }

  const submitResult = await readJsonOrThrow(submitResp, 'fal.ai submit')

  // If we got a direct result (not queued), extract audio
  if (submitResult.audio || submitResult.audio_url) {
    return extractAudioUrl(submitResult)
  }

  // It's queued — poll for completion
  const statusUrl = submitResult.status_url || submitResult.response_url
  const responseUrl = submitResult.response_url

  if (!statusUrl && !responseUrl) {
    throw new Error(`No status_url or response_url in queue response: ${redactSecrets(JSON.stringify(submitResult), apiKey).slice(0, 300)}`)
  }

  // Poll with escalation: a run of 429s or 5xxs now fails the job loudly
  // instead of silently timing out after MAX_WAIT. Retry-After is honoured.
  const finalResult = await pollForResult<any>({
    label: 'fal.ai TTS status',
    url: statusUrl,
    headers: { Authorization: `Key ${apiKey}` },
    deadline: Date.now() + (opts.timeoutMs ?? MAX_WAIT),
    intervalMs: POLL_INTERVAL,
    redactKey: apiKey,
    isCancelled: opts.isCancelled,
    onData: async (data: any) => {
      if (data.status === 'COMPLETED') {
        const resultResp = await fetch(responseUrl, {
          headers: { Authorization: `Key ${apiKey}` },
          signal: AbortSignal.timeout(30000),
        })
        if (!resultResp.ok) {
          return { fail: new Error(`fal.ai result fetch failed: ${resultResp.status}`) }
        }
        return { done: await readJsonOrThrow(resultResp, 'fal.ai result') }
      }
      if (data.status === 'FAILED') {
        return { fail: new Error(`fal.ai TTS failed: ${data.error || 'Unknown error'}`) }
      }
      return { continue: true }
    },
  })
  return extractAudioUrl(finalResult)
}

function extractAudioUrl(result: any): string {
  let audioUrl: string | null = null

  if (typeof result?.audio === 'object') audioUrl = result.audio.url
  if (!audioUrl) audioUrl = result?.audio_url || result?.url
  if (!audioUrl) {
    const raw = JSON.stringify(result)
    const match = raw.match(/https?:\/\/[^\s"']+\.(mp3|wav)[^\s"']*/i)
    if (match) audioUrl = match[0]
  }

  if (!audioUrl) throw new Error(`No audio URL in fal.ai response: ${JSON.stringify(result).slice(0, 500)}`)
  return audioUrl
}

export async function downloadAudio(url: string, savePath: string): Promise<void> {
  await fs.mkdir(path.dirname(savePath), { recursive: true })
  const resp = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!resp.ok || !resp.body) throw new Error(`Download failed: ${resp.status}`)
  const writeStream = createWriteStream(savePath)
  // Delete partial file on error — otherwise the generator's "skip if
  // exists" guard would treat a truncated MP3 as a valid cache hit on retry.
  try {
    await pipeline(Readable.fromWeb(resp.body as any), writeStream)
  } catch (e) {
    await fs.rm(savePath, { force: true }).catch(() => {})
    throw e
  }
  const stat = await fs.stat(savePath)
  if (stat.size === 0) {
    await fs.rm(savePath, { force: true }).catch(() => {})
    throw new Error('Audio download wrote 0 bytes')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
