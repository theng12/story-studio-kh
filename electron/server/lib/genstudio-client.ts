/**
 * GenStudio KH client boundary for Story Studio.
 *
 * This module knows only the public GenStudio API contract. It has no Studio
 * Hub URL, token, worker list, or direct Voice Studio connection. Keeping that
 * boundary here keeps Story Studio's local Studio Hub token and Voice Studio
 * endpoints out of every GenStudio request. Direct/Hub TTS remains a separate
 * legacy route; AI transcription does not.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { getGenStudioUrl } from '../services/app-settings.js'
import { runFfmpeg } from './ffmpeg-utils.js'
import { chunkText } from './text-chunker.js'

const POLL_INTERVAL_MS = 1_000
const NETWORK_RETRY_ATTEMPTS = 4
export const GENSTUDIO_MAX_TTS_CHARACTERS = 15_000
export const GENSTUDIO_LONG_JOB_TIMEOUT_MS = 4 * 60 * 60_000
export const GENSTUDIO_MAX_TRANSCRIPTION_BYTES = 100 * 1024 * 1024

interface GenStudioOperationContext {
  signal?: AbortSignal
  isCancelled?: () => boolean
}

interface GenStudioJob {
  id: string
  state: 'accepted' | 'reserved' | 'dispatched' | 'running' | 'validating' | 'succeeded' | 'failed' | 'reconciling'
  failure_code?: string | null
  audio_url?: string | null
}

export interface GenStudioTtsRequest extends GenStudioOperationContext {
  text: string
  voiceId?: string
  speed: number
  onProgress?: (received: number, total?: number) => void
}

export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  provider: string
  language: string
  available: boolean
  available_workers: number
  qualification_only: boolean
}

interface GenStudioTranscriptionJob {
  id: string
  state: GenStudioJob['state']
  model_id: string
  failure_code?: string | null
  srt_url?: string | null
}

export interface GenStudioTranscriptionRequest extends GenStudioOperationContext {
  audioPath: string
  modelId: string
  storyJobId: string
  language?: string
  wordTimestamps?: boolean
  onState?: (state: GenStudioTranscriptionJob['state']) => void
}

export interface GenStudioSubmission {
  body: {
    voice_id: string
    text: string
    speed: number
  }
  idempotencyKey: string
}

export interface GenStudioVoice {
  id: string
  display_name: string
  language?: string
  description?: string
  provider?: string
  generation_enabled?: boolean
}

export function catalogHasVoice(voices: GenStudioVoice[], voiceId: unknown): boolean {
  if (typeof voiceId !== 'string' || !voiceId.trim()) return false
  return voices.some(voice => voice.id === voiceId.trim() && voice.generation_enabled !== false)
}

function apiBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function requestUrl(baseUrl: string, value: string): string {
  const base = new URL(`${apiBase(baseUrl)}/`)
  const resolved = new URL(value, base)
  if (resolved.origin !== base.origin) {
    throw new Error('GenStudio KH returned an artifact URL outside its API origin')
  }
  return resolved.toString()
}

function authorization(apiKey: string): Record<string, string> {
  if (!apiKey.trim()) throw new Error('No GenStudio KH API key configured. Open Settings → This Mac → API Keys.')
  return { Authorization: `Bearer ${apiKey.trim()}` }
}

/**
 * Split only at GenStudio's public API boundary. VoiceStudio owns every
 * smaller model-sized chunk, join, and final speed operation behind it.
 */
export function splitGenStudioApiRequests(text: string): string[] {
  return chunkText(text, GENSTUDIO_MAX_TTS_CHARACTERS).flatMap(part => {
    if (part.length <= GENSTUDIO_MAX_TTS_CHARACTERS) return [part]
    const slices: string[] = []
    for (let offset = 0; offset < part.length; offset += GENSTUDIO_MAX_TTS_CHARACTERS) {
      slices.push(part.slice(offset, offset + GENSTUDIO_MAX_TTS_CHARACTERS))
    }
    return slices
  })
}

/** Build the exact customer API payload plus a stable retry identity. */
export function buildGenStudioSubmission(request: GenStudioTtsRequest): GenStudioSubmission {
  const voiceId = request.voiceId?.trim() || ''
  if (!voiceId) throw new Error('Select a GenStudio KH voice before generating audio.')
  if (!request.text.trim()) throw new Error('GenStudio KH text cannot be empty.')
  const characterCount = Array.from(request.text.normalize('NFC')).length
  if (characterCount > GENSTUDIO_MAX_TTS_CHARACTERS) {
    throw new Error(`GenStudio KH accepts at most ${GENSTUDIO_MAX_TTS_CHARACTERS.toLocaleString()} characters per request.`)
  }
  if (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2) {
    throw new Error('GenStudio KH speed must be between 0.5 and 2.0.')
  }
  const body = { voice_id: voiceId, text: request.text, speed: request.speed }
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { body, idempotencyKey: `story-tts-${digest.slice(0, 48)}` }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function combinedSignal(signal: AbortSignal | undefined, deadline: number): AbortSignal {
  const remaining = Math.max(1, deadline - Date.now())
  const timeoutSignal = AbortSignal.timeout(remaining)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function retryDelay(attempt: number, request: GenStudioOperationContext, deadline: number): Promise<void> {
  if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
  if (Date.now() >= deadline) throw new Error('GenStudio KH job timed out while waiting for completion')
  await new Promise(resolve => setTimeout(resolve, Math.min(4_000, 500 * (2 ** (attempt - 1)))))
}

async function requestJsonWithRetry(
  url: string,
  init: RequestInit,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<any> {
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    try {
      const response = await fetch(url, { ...init, signal: combinedSignal(request.signal, deadline) })
      const raw = await response.text()
      let body: any = {}
      if (raw) {
        try { body = JSON.parse(raw) }
        catch { throw new Error(`GenStudio KH returned invalid JSON (HTTP ${response.status})`) }
      }
      if (!response.ok) {
        const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
        const error = new Error(`GenStudio KH request failed: ${detail}`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        return body
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      lastError = error
      if (error instanceof Error && error.message.startsWith('GenStudio KH request failed:')
        && !/HTTP (408|425|429|5\d\d)/.test(error.message)) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) await retryDelay(attempt, request, deadline)
  }
  throw lastError instanceof Error ? lastError : new Error('GenStudio KH request failed after reconnect attempts')
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
    throw new Error(`GenStudio KH request failed: ${detail}`)
  }
  return body
}

/** Fetch the account-visible catalog so callers never need to know voice IDs. */
export async function listVoices(apiKey: string): Promise<GenStudioVoice[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/voices`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid voice catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    language: typeof value?.language === 'string' ? value.language : undefined,
    description: typeof value?.description === 'string' ? value.description : undefined,
    provider: typeof value?.provider === 'string' ? value.provider : undefined,
    generation_enabled: typeof value?.generation_enabled === 'boolean' ? value.generation_enabled : undefined,
  })).filter((voice: GenStudioVoice) => voice.id && voice.display_name && voice.generation_enabled !== false)
}

/** Fetch the account-visible transcription catalog from the GenStudio boundary. */
export async function listTranscriptionModels(
  apiKey: string,
): Promise<GenStudioTranscriptionModel[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/transcription/models`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) {
    throw new Error('GenStudio KH returned an invalid transcription model catalog')
  }
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    provider: typeof value?.provider === 'string' ? value.provider.trim() : 'GenStudio KH',
    language: typeof value?.language === 'string' ? value.language.trim() : 'multilingual',
    available: value?.available === true,
    available_workers: Number.isInteger(value?.available_workers)
      ? Math.max(0, value.available_workers)
      : 0,
    qualification_only: value?.qualification_only !== false,
  })).filter((model: GenStudioTranscriptionModel) => model.id && model.display_name)
}

function transcriptionMediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.wav': return 'audio/wav'
    case '.mp3': return 'audio/mpeg'
    case '.m4a': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.flac': return 'audio/flac'
    case '.ogg': return 'audio/ogg'
    case '.opus': return 'audio/opus'
    case '.webm': return 'audio/webm'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    default: return 'application/octet-stream'
  }
}

export function buildGenStudioTranscriptionIdempotencyKey(input: {
  storyJobId: string
  fileSha256: string
  modelId: string
  language?: string
  wordTimestamps?: boolean
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    story_job_id: input.storyJobId,
    file_sha256: input.fileSha256,
    model_id: input.modelId,
    language: input.language || null,
    word_timestamps: input.wordTimestamps === true,
  })).digest('hex')
  return `story-stt-${digest.slice(0, 48)}`
}

async function waitForTranscriptionJob(
  baseUrl: string,
  apiKey: string,
  submitted: GenStudioTranscriptionJob,
  request: GenStudioTranscriptionRequest,
  deadline: number,
): Promise<GenStudioTranscriptionJob> {
  let current = submitted
  request.onState?.(current.state)
  while (current.state !== 'succeeded' && current.state !== 'failed') {
    if (request.isCancelled?.()) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) {
      throw new Error('GenStudio KH transcription timed out while waiting for completion')
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/transcriptions/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioTranscriptionJob
    request.onState?.(current.state)
  }
  if (current.state === 'failed') {
    throw new Error(
      `GenStudio KH transcription failed${current.failure_code ? ` (${current.failure_code})` : ''}. ` +
      'No OpenAI, Studio Hub, or direct Voice Studio fallback was attempted.',
    )
  }
  return current
}

/** Submit private audio to GenStudio, poll its durable job, and return verified SRT text. */
export async function transcribeWithGenStudio(
  apiKey: string,
  request: GenStudioTranscriptionRequest,
): Promise<{ srt: string; jobId: string; modelId: string }> {
  const modelId = request.modelId.trim()
  if (!modelId) throw new Error('Select a GenStudio KH transcription model.')
  if (!request.storyJobId.trim()) throw new Error('Story Studio transcription job ID is required.')
  const file = await fs.readFile(request.audioPath)
  if (!file.length) throw new Error('Transcription audio is empty.')
  if (file.length > GENSTUDIO_MAX_TRANSCRIPTION_BYTES) {
    throw new Error('GenStudio KH transcription input exceeds the 100 MiB qualification limit.')
  }
  const fileSha256 = createHash('sha256').update(file).digest('hex')
  const idempotencyKey = buildGenStudioTranscriptionIdempotencyKey({
    storyJobId: request.storyJobId,
    fileSha256,
    modelId,
    language: request.language,
    wordTimestamps: request.wordTimestamps,
  })
  const body = new FormData()
  body.set(
    'file',
    new Blob([new Uint8Array(file)], { type: transcriptionMediaType(request.audioPath) }),
    path.basename(request.audioPath),
  )
  body.set('model', modelId)
  if (request.language) body.set('language', request.language)
  body.set('word_timestamps', String(request.wordTimestamps === true))

  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submitted = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/audio/transcriptions`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Idempotency-Key': idempotencyKey,
      },
      body,
    },
    request,
    deadline,
  ) as GenStudioTranscriptionJob
  const completed = await waitForTranscriptionJob(baseUrl, apiKey, submitted, request, deadline)
  if (!completed.srt_url) {
    throw new Error('GenStudio KH transcription completed without an SRT download URL')
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(requestUrl(baseUrl, completed.srt_url), {
        headers: authorization(apiKey),
        signal: combinedSignal(request.signal, deadline),
      })
      if (!response.ok) {
        const error = new Error(`GenStudio KH SRT download failed (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const srt = await response.text()
        if (!srt.trim()) throw new Error('GenStudio KH returned an empty SRT artifact')
        return { srt, jobId: completed.id, modelId: completed.model_id }
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      lastError = error
      if (error instanceof Error && !/HTTP (408|425|429|5\d\d)/.test(error.message)
        && !error.message.includes('fetch failed')) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) await retryDelay(attempt, request, deadline)
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('GenStudio KH SRT download failed after reconnect attempts')
}

async function waitForJob(
  baseUrl: string,
  apiKey: string,
  job: GenStudioJob,
  request: GenStudioTtsRequest,
  deadline: number,
): Promise<GenStudioJob> {
  let current = job
  while (current.state !== 'succeeded' && current.state !== 'failed') {
    if (request.isCancelled?.()) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) throw new Error('GenStudio KH job timed out while waiting for completion')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioJob
  }
  if (current.state === 'failed') {
    throw new Error(`GenStudio KH generation failed${current.failure_code ? ` (${current.failure_code})` : ''}. No direct Studio Hub fallback was attempted.`)
  }
  return current
}

/** Generate a GenStudio API TTS job, then convert its private WAV response to Story's MP3 contract. */
export async function generateTtsToFile(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submission = buildGenStudioSubmission(request)
  const submitted = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/audio/speech`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': submission.idempotencyKey,
      },
      body: JSON.stringify(submission.body),
    },
    request,
    deadline,
  ) as GenStudioJob
  const completed = await waitForJob(baseUrl, apiKey, submitted, request, deadline)
  if (!completed.audio_url) throw new Error('GenStudio KH job completed without an audio download URL')

  const tempPath = path.join(os.tmpdir(), `genstudio-audio-${randomUUID()}.wav`)
  try {
    let downloaded = false
    let downloadError: unknown
    for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS && !downloaded; attempt++) {
      try {
        const audioResponse = await fetch(requestUrl(baseUrl, completed.audio_url), {
          headers: authorization(apiKey),
          signal: combinedSignal(request.signal, deadline),
        })
        if (!audioResponse.ok) {
          const error = new Error(`GenStudio KH audio download failed (HTTP ${audioResponse.status})`)
          if (!retryableStatus(audioResponse.status)) throw error
          downloadError = error
        } else {
          const body = audioResponse.body as ReadableStream<Uint8Array> | null
          if (!body) throw new Error('GenStudio KH audio download returned no body')
          const file = await fs.open(tempPath, 'w')
          let received = 0
          try {
            const reader = body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                await file.write(value)
                received += value.length
                request.onProgress?.(received, Number(audioResponse.headers.get('content-length')) || undefined)
              }
            }
          } finally {
            await file.close()
          }
          downloaded = true
        }
      } catch (error) {
        if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
        downloadError = error
      }
      if (!downloaded && attempt < NETWORK_RETRY_ATTEMPTS) {
        await fs.rm(tempPath, { force: true }).catch(() => {})
        await retryDelay(attempt, request, deadline)
      }
    }
    if (!downloaded) throw downloadError instanceof Error ? downloadError : new Error('GenStudio KH audio download failed')
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    // Conversion only. VoiceStudio already joined internal chunks and applied
    // final speed before this completed WAV crossed the GenStudio boundary.
    await runFfmpeg(['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath])
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}
