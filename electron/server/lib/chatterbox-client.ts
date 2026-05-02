/**
 * Chatterbox (Resemble AI) self-hosted TTS client.
 *
 * The user runs the Chatterbox server on a Mac mini reachable over Tailscale
 * (default `http://100.66.3.3:5052`). No auth — Tailscale handles network
 * security at the transport layer, so we send plain HTTP without a key.
 *
 * Lifecycle:
 *   1. POST /api/generate-batch  → 202 { job_id, audio_url, ... }
 *   2. GET  /api/jobs/{job_id}   → poll until status === 'done' | 'failed'
 *   3. GET  /api/jobs/{id}/audio → binary download in requested format
 *
 * Cancellation: there is no documented cancel endpoint on Chatterbox today, so
 * `isCancelled` only stops *our* polling. The server keeps processing the job
 * to completion and discards the result. Acceptable for a local server where
 * idle compute is free.
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { sleepCancellable } from './http-retry.js'

export const DEFAULT_CHATTERBOX_BASE_URL = 'http://100.66.3.3:5052'

export type ChatterboxOutputFormat = 'wav' | 'mp3' | 'flac' | 'ogg'

export interface ChatterboxGenerateParams {
  /** Full text — server auto-chunks at ~400 chars on sentence boundaries. */
  text: string
  /** ISO language code; default 'en'. */
  language?: string
  /** UUID returned by uploadReference(); omit for the built-in default voice. */
  reference_id?: string
  /** Default 'wav'. We always ask for wav for lossless on-disk audio. */
  output_format?: ChatterboxOutputFormat
  /** 0.5–2.0; default 1.0 (pitch-preserving). */
  speed?: number
  /** 0.1–2.0; default 0.8. Sampling randomness. */
  temperature?: number
  /** 0.1–1.0; default 1.0. Nucleus sampling. */
  top_p?: number
  /** 0.0–0.5; default 0.05. */
  min_p?: number
  /** 0.0–1.0; default 0.5. Classifier-free guidance weight. */
  cfg_weight?: number
  /** 0.25–2.0; default 0.5. Emotional intensity. */
  exaggeration?: number
  /** 1.0–4.0; default 2.0. */
  repetition_penalty?: number
  /** Integer; omit for random. */
  seed?: number
}

export interface ChatterboxSubmitResponse {
  job_id: string
  status_url: string
  audio_url: string
  char_count: number
  chunks_total: number
  estimated_seconds: number
}

export type ChatterboxJobStatus = 'pending' | 'running' | 'stitching' | 'done' | 'failed'

export interface ChatterboxJob {
  id: string
  status: ChatterboxJobStatus
  chunks_done?: number
  chunks_total?: number
  elapsed_seconds?: number
  eta_seconds?: number
  audio_seconds?: number
  error?: string | null
  final_format?: string
}

export interface ChatterboxHealth {
  ok: boolean
  modelLoaded?: boolean
  device?: string
  sampleRate?: number
  error?: string
}

interface PollOpts {
  isCancelled?: () => boolean
  /** Total wait cap, ms. Default 30 min. */
  timeoutMs?: number
  /** Optional progress hook fired on every successful status response. */
  onProgress?: (job: ChatterboxJob) => void
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000

function trimBaseUrl(baseUrl: string): string {
  const t = (baseUrl || '').trim()
  if (!t) throw new Error('Chatterbox base URL is empty. Set it in Settings → Local TTS.')
  return t.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, p: string): string {
  return `${trimBaseUrl(baseUrl)}${p.startsWith('/') ? p : `/${p}`}`
}

function friendlyConnectError(baseUrl: string, e: any): Error {
  const code: string = e?.cause?.code || e?.code || ''
  const msg: string = e?.message || String(e)
  if (code === 'ENOTFOUND' || code === 'ENETUNREACH' || code === 'EAI_AGAIN' || /getaddrinfo|fetch failed/i.test(msg)) {
    return new Error(
      `Cannot reach Chatterbox server at ${baseUrl}. ` +
      `Check that Tailscale is connected and the server is running.`,
    )
  }
  if (code === 'ECONNREFUSED' || /connect.*refused/i.test(msg)) {
    return new Error(
      `Chatterbox server at ${baseUrl} refused the connection. ` +
      `Confirm the server process is running on that host/port.`,
    )
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(msg)) {
    return new Error(
      `Chatterbox server at ${baseUrl} timed out. ` +
      `Tailscale may be reconnecting — try again in a moment.`,
    )
  }
  return e instanceof Error ? e : new Error(msg)
}

/**
 * Submit a batch generation job. Returns the new job_id and metadata.
 * Throws with a friendly message on connection / 4xx / 5xx errors.
 */
export async function submitBatch(
  baseUrl: string,
  params: ChatterboxGenerateParams,
): Promise<ChatterboxSubmitResponse> {
  const body: Record<string, unknown> = { text: params.text }
  if (params.language) body.language = params.language
  if (params.reference_id) body.reference_id = params.reference_id
  if (params.output_format) body.output_format = params.output_format
  if (typeof params.speed === 'number') body.speed = params.speed
  if (typeof params.temperature === 'number') body.temperature = params.temperature
  if (typeof params.top_p === 'number') body.top_p = params.top_p
  if (typeof params.min_p === 'number') body.min_p = params.min_p
  if (typeof params.cfg_weight === 'number') body.cfg_weight = params.cfg_weight
  if (typeof params.exaggeration === 'number') body.exaggeration = params.exaggeration
  if (typeof params.repetition_penalty === 'number') body.repetition_penalty = params.repetition_penalty
  if (typeof params.seed === 'number') body.seed = params.seed

  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/generate-batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Chatterbox submit failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  return await resp.json() as ChatterboxSubmitResponse
}

/**
 * Poll a job until it reaches 'done' or 'failed'. Adaptive cadence:
 *   - 2s for the first ~12s
 *   - 5s for the next ~60s
 *   - 10s thereafter
 *   - Honours `eta_seconds` when reported (>8s) by sleeping eta/2 (max 10s).
 *
 * Throws on 'failed' status, on timeout, or on user cancellation.
 */
export async function pollJob(
  baseUrl: string,
  jobId: string,
  opts: PollOpts = {},
): Promise<ChatterboxJob> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let polls = 0
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error('Cancelled by user')

    let resp: Response
    try {
      resp = await fetch(joinUrl(baseUrl, `/api/jobs/${jobId}`), {
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      throw friendlyConnectError(baseUrl, e)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Chatterbox poll failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    const job = await resp.json() as ChatterboxJob
    try { opts.onProgress?.(job) } catch { /* never let UI plumbing kill polling */ }

    if (job.status === 'done') return job
    if (job.status === 'failed') {
      throw new Error(`Chatterbox job failed: ${job.error || 'unknown error'}`)
    }

    const baseSleepMs =
      polls < 6 ? 2_000 :
      polls < 18 ? 5_000 :
      10_000
    const eta = typeof job.eta_seconds === 'number' ? job.eta_seconds : 0
    const etaSleep = eta > 8 ? Math.min(eta * 1000 * 0.5, 10_000) : 0
    const sleepMs = Math.max(baseSleepMs, etaSleep)

    await sleepCancellable(sleepMs, opts.isCancelled)
    polls += 1
  }
  throw new Error(`Chatterbox job ${jobId} did not complete within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} min`)
}

/**
 * Stream the finished audio to `outPath`. Creates parent dirs as needed.
 * Removes the partial file on stream error so a half-written WAV won't be
 * mistaken for a valid cache hit by `fileExistsWithContent` on retry.
 *
 * `signal` lets callers abort mid-download (we tie it to the audio
 * generator's AbortController so cancellation tears down the read).
 */
export async function downloadAudio(
  baseUrl: string,
  jobId: string,
  outPath: string,
  opts: { signal?: AbortSignal; onProgress?: (bytesReceived: number, totalBytes?: number) => void } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, `/api/jobs/${jobId}/audio`), {
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Chatterbox audio download failed (${resp.status}): ${text.slice(0, 200)}`)
  }
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
  try {
    await pipeline(Readable.fromWeb(resp.body as any), counter, out)
  } catch (e) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw e
  }
  const stat = await fs.stat(outPath)
  if (stat.size === 0) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw new Error('Chatterbox download wrote 0 bytes')
  }
}

/**
 * Upload a reference voice clip (5–15s recommended) for zero-shot cloning.
 * Returns the reference_id UUID to pass back in subsequent generate-batch
 * requests as `reference_id`.
 */
export async function uploadReference(
  baseUrl: string,
  audioBytes: Buffer,
  filename: string,
  opts: { displayName?: string; contentType?: string } = {},
): Promise<{ referenceId: string }> {
  const form = new FormData()
  // The Chatterbox /api/upload-reference endpoint expects the audio file
  // under the field name `audio` (Flask multipart convention). If the
  // server expects a different field name, tweak here.
  const mime = opts.contentType || guessAudioMime(filename)
  form.append('audio', new Blob([new Uint8Array(audioBytes)], { type: mime }), filename)
  if (opts.displayName) form.append('name', opts.displayName)

  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/upload-reference'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Chatterbox reference upload failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as { reference_id?: string; id?: string }
  const referenceId = data.reference_id || data.id || ''
  if (!referenceId) {
    throw new Error(`Chatterbox upload returned no reference_id: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return { referenceId }
}

function guessAudioMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  switch (ext) {
    case '.wav': return 'audio/wav'
    case '.mp3': return 'audio/mpeg'
    case '.m4a': return 'audio/mp4'
    case '.ogg': return 'audio/ogg'
    case '.flac': return 'audio/flac'
    case '.webm': return 'audio/webm'
    default: return 'application/octet-stream'
  }
}

/**
 * Liveness + readiness probe. Hits `/health` and `/api/status` and rolls the
 * results into a single object the UI's "Test connection" button can render.
 * Never throws — returns `{ ok: false, error }` on any failure.
 */
export async function health(baseUrl: string): Promise<ChatterboxHealth> {
  try {
    const trimmed = trimBaseUrl(baseUrl)
    const [healthResp, statusResp] = await Promise.all([
      fetch(`${trimmed}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => null),
      fetch(`${trimmed}/api/status`, { signal: AbortSignal.timeout(5_000) }).catch(() => null),
    ])
    if (!healthResp || !healthResp.ok) {
      return { ok: false, error: `Health check failed (${healthResp?.status ?? 'no response'})` }
    }
    let modelLoaded: boolean | undefined
    let device: string | undefined
    let sampleRate: number | undefined
    if (statusResp && statusResp.ok) {
      try {
        const s = await statusResp.json() as { model_loaded?: boolean; device?: string; sample_rate?: number }
        modelLoaded = !!s.model_loaded
        device = typeof s.device === 'string' ? s.device : undefined
        sampleRate = typeof s.sample_rate === 'number' ? s.sample_rate : undefined
      } catch { /* tolerate non-JSON status */ }
    }
    return { ok: true, modelLoaded, device, sampleRate }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
