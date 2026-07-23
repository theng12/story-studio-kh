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
import { GenStudioAdmissionPool } from './genstudio-admission.js'
import { chunkText } from './text-chunker.js'

const POLL_INTERVAL_MS = 1_000
const NETWORK_RETRY_ATTEMPTS = 4
export const GENSTUDIO_MAX_TTS_CHARACTERS = 15_000
export const GENSTUDIO_LONG_JOB_TIMEOUT_MS = 4 * 60 * 60_000
export const GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS = 30_000
export const GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS = 5 * 60_000
export const GENSTUDIO_MAX_TRANSCRIPTION_BYTES = 100 * 1024 * 1024

interface GenStudioOperationContext {
  signal?: AbortSignal
  isCancelled?: () => boolean
}

export interface GenStudioJob {
  id: string
  state: 'accepted' | 'reserved' | 'dispatched' | 'running' | 'validating' | 'succeeded' | 'failed' | 'reconciling'
  failure_code?: string | null
  audio_url?: string | null
  model_id?: string
  model_revision_id?: string
  credit_cost?: number
  remaining_credits?: number
  routing_status_code?: string | null
  price_version?: string | null
}

export interface GenStudioTtsRequest extends GenStudioOperationContext {
  text: string
  voiceId?: string
  speed: number
  /** Stable Story asset identity, such as project + episode + output file. */
  requestIdentity?: string
  /** Reuse a key already checkpointed beside the Story asset. */
  idempotencyKey?: string
  onProgress?: (received: number, total?: number) => void
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
}

export interface GenStudioTranscriptionModel {
  id: string
  display_name: string
  provider: string
  language: string
  available: boolean
  available_workers: number
  qualification_only: boolean
  unlimited_relaxed: boolean
  credits_per_minute: number
  minimum_credits: number
  price_version: string
}

export interface GenStudioImageModel {
  id: string
  display_name: string
  description?: string
  available: boolean
  qualification_only: boolean
  execution_label?: string
  unlimited_relaxed: boolean
  credits_per_image: number | null
  minimum_credits: number | null
  price_version: string | null
  chargeable: boolean
  aspect_ratios: string[]
  default_aspect_ratio: string
  default_steps: number
  min_steps: number
  max_steps: number
  sizes?: Array<{
    aspect_ratio: string
    width: number
    height: number
    label?: string
    default?: boolean
  }>
}

interface GenStudioImageJob {
  id: string
  state: GenStudioJob['state']
  model_id: string
  prompt: string
  width: number
  height: number
  aspect_ratio: string
  steps: number
  seed?: number | null
  failure_code?: string | null
  image_url?: string | null
}

export interface GenStudioImageRequest extends GenStudioOperationContext {
  prompt: string
  modelId: string
  aspectRatio: string
  steps: number
  width?: number
  height?: number
  seed?: number
  /** Stable for this Story Studio submission, distinct for a deliberate rerender. */
  requestIdentity?: string
  onState?: (state: GenStudioJob['state']) => void
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
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
  /** Stable Story asset identity; never use a transient queue job ID here. */
  requestIdentity: string
  /** Reuse a key already checkpointed beside the Story asset. */
  idempotencyKey?: string
  language?: string
  wordTimestamps?: boolean
  onState?: (state: GenStudioTranscriptionJob['state'], jobId: string) => void | Promise<void>
  onJobAccepted?: (jobId: string, idempotencyKey: string, fileSha256: string) => void | Promise<void>
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
  engine_id?: string
  engine_name?: string
  model_revision_id?: string
  model_family?: string
  voice_tier?: string
  generation_enabled?: boolean
  preview_available?: boolean
  preview_url?: string | null
  preview_text?: string | null
}

export interface GenStudioModelCapability {
  id: string
  revision: string
  display_name: string
  description?: string
  modality: 'audio' | 'image' | 'text' | 'video'
  operation: 'voice.tts' | 'audio.transcription' | 'image.generation' | 'chat.response' | 'video.generation'
  availability: 'available' | 'unavailable' | 'unknown'
  qualification_only: boolean
  pricing_unit?: string
  limits: Record<string, unknown>
  controls: Record<string, unknown>
}

export interface GenStudioChatModel {
  id: string
  display_name: string
  description?: string
  available: boolean
  qualification_only: boolean
  max_output_tokens: number
  controls: string[]
  activation_blockers: string[]
  unlimited_relaxed: boolean
  input_credits_per_million_tokens: number
  output_credits_per_million_tokens: number
  minimum_credits: number
  price_version: string
}

export interface GenStudioTtsQuote {
  voice_id: string
  billable_characters: number
  speed: number
  estimated_duration_ms: number
  credits: number
  credits_per_1000_characters: number
  price_version: string
  chargeable: boolean
}

export interface GenStudioVideoModel {
  id: string
  display_name: string
  description?: string
  available: boolean
  modes: Array<'image-to-video'>
  aspect_ratios: string[]
  variants: Array<{
    duration_seconds: 5 | 10
    resolution: '720p' | '1080p'
    credits_per_video: number
    minimum_credits: number
    price_version: string
  }>
}

interface GenStudioChatJob {
  id: string
  state: GenStudioJob['state']
  model_id: string
  output_text?: string | null
  failure_code?: string | null
  routing_status_code?: string | null
  credit_cost?: number
  remaining_credits?: number
  price_version?: string | null
}

interface GenStudioVideoSourceAsset {
  id: string
  media_type: string
  byte_size: number
  width: number
  height: number
  expires_at: string
}

interface GenStudioVideoJob extends GenStudioJob {
  model_id: string
  video_url?: string | null
  cancellation_requested?: boolean
  cancelled?: boolean
}

export interface GenStudioVideoRequest extends GenStudioOperationContext {
  prompt: string
  modelId: string
  sourceImagePath: string
  aspectRatio: string
  durationSeconds: 5 | 10
  resolution: '720p' | '1080p'
  requestIdentity?: string
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
}

export interface GenStudioAccountOverview {
  credit_balance: number
  credits_used_30d: number
  subscription_plan_name: string
  /** @deprecated GenStudio 0.16 compatibility alias. */
  api_concurrency_limit?: number
  paid_concurrency_limit: number
  paid_active_jobs: number
  paid_queued_jobs: number
  max_queued_jobs: number
  generation_submissions_per_minute: number
  relaxed_concurrency_limit: number
  total_jobs: number
  active_jobs: number
  completed_jobs: number
  failed_jobs: number
  available_assets: number
  next_asset_expiration: string | null
}

export interface GenStudioCustomerJob {
  id: string
  operation: GenStudioModelCapability['operation']
  state: GenStudioJob['state']
  model_id: string
  credit_cost: number
  reserved_credits: number
  settled_credits: number
  released_credits: number
  failure_code: string | null
  routing_status_code: string | null
  created_at: string
  updated_at: string
}

export interface GenStudioCreditActivity {
  id: string
  kind: 'credit' | 'charge' | 'return'
  description: string
  credits: number
  state: string
  reason_code: string
  balance_after: number | null
  created_at: string
  job_id: string | null
}

export interface GenStudioChatRequest extends GenStudioOperationContext {
  modelId: string
  system: string
  userMessage: string
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  requestIdentity?: string
  idempotencyKey?: string
  onJobAccepted?: (jobId: string, idempotencyKey: string) => void | Promise<void>
  onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
}

type GenStudioOperation = GenStudioModelCapability['operation']

const genStudioAdmission = new GenStudioAdmissionPool(async (apiKey) => {
  const overview = await readAccountJson<GenStudioAccountOverview>(
    apiKey,
    '/v1/account/overview',
  )
  if (
    !Number.isInteger(overview.paid_concurrency_limit)
    || overview.paid_concurrency_limit < 1
  ) {
    throw new Error('GenStudio account overview did not include a valid paid concurrency limit')
  }
  return overview.paid_concurrency_limit
})

export function genStudioAdmissionSnapshot() {
  return genStudioAdmission.snapshot()
}

function withGenStudioAdmission<T>(
  apiKey: string,
  request: GenStudioOperationContext,
  work: () => Promise<T>,
): Promise<T> {
  return genStudioAdmission.run(apiKey, request.signal, work)
}

async function recordGenStudioEvidence(operation: GenStudioOperation, job: GenStudioJob): Promise<void> {
  const queue = await import('../services/job-queue.js')
  const storyJobId = queue.currentJobId()
  if (!storyJobId || !job?.id) return
  await queue.recordGenStudioJob(storyJobId, {
    id: job.id,
    operation,
    state: job.state,
    model_id: job.model_id || job.model_revision_id,
    credit_cost: Number.isFinite(job.credit_cost) ? job.credit_cost : undefined,
    remaining_credits: Number.isFinite(job.remaining_credits) ? job.remaining_credits : undefined,
    price_version: job.price_version,
    failure_code: job.failure_code,
    routing_status_code: job.routing_status_code,
    updated_at: new Date().toISOString(),
  })
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
  const digest = createHash('sha256').update(JSON.stringify({
    ...body,
    request_identity: request.requestIdentity?.trim() || null,
  })).digest('hex')
  return { body, idempotencyKey: `story-tts-${digest.slice(0, 48)}` }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export class GenStudioApiError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(
      status === 401 || status === 403
        ? `GenStudio KH rejected the scoped API key (HTTP ${status}): ${detail}. ` +
          'Verify this key belongs to the intended account and includes the scope required by this operation.'
        : `GenStudio KH request failed: ${detail}`,
    )
    this.name = 'GenStudioApiError'
  }
}

export function operationSignal(
  signal: AbortSignal | undefined,
  deadline: number,
  operationTimeoutMs: number,
): AbortSignal {
  const remaining = Math.max(1, Math.min(operationTimeoutMs, deadline - Date.now()))
  const timeoutSignal = AbortSignal.timeout(remaining)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

export function parseGenStudioRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return null
  return Math.max(0, retryAt - now)
}

async function retryDelay(
  attempt: number,
  request: GenStudioOperationContext,
  deadline: number,
  retryAfterMs?: number | null,
): Promise<void> {
  if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
  if (Date.now() >= deadline) throw new Error('GenStudio KH job timed out while waiting for completion')
  const fallbackMs = Math.min(4_000, 500 * (2 ** (attempt - 1)))
  const requestedMs = retryAfterMs == null ? fallbackMs : Math.max(0, retryAfterMs)
  const delayMs = Math.min(requestedMs, Math.max(0, deadline - Date.now()))
  await new Promise(resolve => setTimeout(resolve, delayMs))
}

async function requestJsonWithRetry(
  url: string,
  init: RequestInit,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<any> {
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    let retryAfterMs: number | null = null
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    try {
      const response = await fetch(url, {
        ...init,
        signal: operationSignal(request.signal, deadline, GENSTUDIO_CONTROL_REQUEST_TIMEOUT_MS),
      })
      const raw = await response.text()
      let body: any = {}
      if (raw) {
        try { body = JSON.parse(raw) }
        catch { throw new Error(`GenStudio KH returned invalid JSON (HTTP ${response.status})`) }
      }
      if (!response.ok) {
        const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
        const error = new GenStudioApiError(response.status, detail)
        if (!retryableStatus(response.status)) throw error
        lastError = error
        retryAfterMs = parseGenStudioRetryAfterMs(response.headers.get('retry-after'))
      } else {
        return body
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      lastError = error
      if (error instanceof GenStudioApiError && !retryableStatus(error.status)) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) {
      await retryDelay(attempt, request, deadline, retryAfterMs)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GenStudio KH request failed after reconnect attempts')
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
    throw new GenStudioApiError(response.status, detail)
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
    engine_id: typeof value?.engine_id === 'string' ? value.engine_id.trim() : undefined,
    engine_name: typeof value?.engine_name === 'string' ? value.engine_name.trim() : undefined,
    model_revision_id: typeof value?.model_revision_id === 'string' ? value.model_revision_id.trim() : undefined,
    model_family: typeof value?.model_family === 'string' ? value.model_family.trim() : undefined,
    voice_tier: typeof value?.voice_tier === 'string' ? value.voice_tier.trim() : undefined,
    generation_enabled: typeof value?.generation_enabled === 'boolean' ? value.generation_enabled : undefined,
    preview_available: typeof value?.preview_available === 'boolean' ? value.preview_available : undefined,
    preview_url: typeof value?.preview_url === 'string' ? value.preview_url.trim() : null,
    preview_text: typeof value?.preview_text === 'string' ? value.preview_text.trim() : null,
  })).filter((voice: GenStudioVoice) => voice.id && voice.display_name && voice.generation_enabled !== false)
}

/**
 * Download one already-generated GenStudio voice sample. This path never
 * submits a TTS job and therefore never consumes generation credits.
 */
export async function downloadVoicePreview(
  apiKey: string,
  previewPath: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const baseUrl = await getGenStudioUrl()
  if (!previewPath.startsWith('/v1/voices/') || !previewPath.endsWith('/preview')) {
    throw new Error('GenStudio KH returned an invalid voice preview path')
  }
  const response = await fetch(requestUrl(baseUrl, previewPath), {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new GenStudioApiError(response.status, `voice preview download returned HTTP ${response.status}`)
  }
  const mediaType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0]!.trim()
  if (!mediaType.startsWith('audio/')) {
    throw new Error('GenStudio KH voice preview did not return audio')
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mediaType,
  }
}

/** Fetch GenStudio's provider-owned capability registry without copying it into project config. */
export async function listModelCapabilities(apiKey: string): Promise<GenStudioModelCapability[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/models`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid capability catalog')
  const modalities = new Set(['audio', 'image', 'text', 'video'])
  const operations = new Set(['voice.tts', 'audio.transcription', 'image.generation', 'chat.response', 'video.generation'])
  const availability = new Set(['available', 'unavailable', 'unknown'])
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    revision: typeof value?.revision === 'string' ? value.revision.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    modality: value?.modality,
    operation: value?.operation,
    availability: availability.has(value?.availability) ? value.availability : 'unknown',
    qualification_only: value?.qualification_only !== false,
    pricing_unit: typeof value?.pricing_unit === 'string' ? value.pricing_unit.trim() : undefined,
    limits: value?.limits && typeof value.limits === 'object' ? value.limits : {},
    controls: value?.controls && typeof value.controls === 'object' ? value.controls : {},
  })).filter((model: GenStudioModelCapability) => (
    !!model.id && !!model.display_name && modalities.has(model.modality) && operations.has(model.operation)
  ))
}

export async function listChatModels(apiKey: string): Promise<GenStudioChatModel[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/chat/models`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid chat model catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    qualification_only: value?.qualification_only !== false,
    max_output_tokens: Number.isInteger(value?.max_output_tokens)
      ? Math.max(1, Math.min(32_768, value.max_output_tokens))
      : 2_048,
    controls: Array.isArray(value?.controls) ? value.controls.filter((item: unknown) => typeof item === 'string') : [],
    activation_blockers: Array.isArray(value?.activation_blockers)
      ? value.activation_blockers.filter((item: unknown) => typeof item === 'string')
      : [],
    unlimited_relaxed: value?.unlimited_relaxed === true,
    input_credits_per_million_tokens: Number.isFinite(value?.input_credits_per_million_tokens)
      ? Math.max(0, value.input_credits_per_million_tokens)
      : 0,
    output_credits_per_million_tokens: Number.isFinite(value?.output_credits_per_million_tokens)
      ? Math.max(0, value.output_credits_per_million_tokens)
      : 0,
    minimum_credits: Number.isFinite(value?.minimum_credits)
      ? Math.max(0, value.minimum_credits)
      : 0,
    price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : '',
  })).filter((model: GenStudioChatModel) => model.id && model.display_name)
}

/**
 * Get GenStudio's exact TTS quote. This deliberately keeps TTS pricing out of
 * Story Studio: GenStudio owns the voice tier, character rules, price version,
 * and the final settlement.
 */
export async function quoteTts(
  apiKey: string,
  input: { voiceId: string; text: string; speed: number },
): Promise<GenStudioTtsQuote> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/tts/quotes`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_id: input.voiceId, text: input.text, speed: input.speed }),
    signal: AbortSignal.timeout(12_000),
  })) as any
  if (
    typeof payload?.voice_id !== 'string'
    || !Number.isFinite(payload?.credits)
    || !Number.isFinite(payload?.billable_characters)
    || !Number.isFinite(payload?.estimated_duration_ms)
    || typeof payload?.price_version !== 'string'
  ) {
    throw new Error('GenStudio KH returned an invalid TTS quote')
  }
  return {
    voice_id: payload.voice_id.trim(),
    billable_characters: Math.max(0, payload.billable_characters),
    speed: Number.isFinite(payload?.speed) ? payload.speed : input.speed,
    estimated_duration_ms: Math.max(0, payload.estimated_duration_ms),
    credits: Math.max(0, payload.credits),
    credits_per_1000_characters: Number.isFinite(payload?.credits_per_1000_characters)
      ? Math.max(0, payload.credits_per_1000_characters)
      : 0,
    price_version: payload.price_version.trim(),
    chargeable: payload?.chargeable === true,
  }
}

export async function listVideoModels(apiKey: string): Promise<GenStudioVideoModel[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/videos/models`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid video model catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    modes: Array.isArray(value?.modes)
      ? value.modes.filter((item: unknown): item is 'image-to-video' => item === 'image-to-video')
      : [],
    aspect_ratios: Array.isArray(value?.aspect_ratios)
      ? value.aspect_ratios.filter((item: unknown): item is string => typeof item === 'string')
      : [],
    variants: Array.isArray(value?.variants)
      ? value.variants.filter((item: any) => (
          (item?.duration_seconds === 5 || item?.duration_seconds === 10)
          && (item?.resolution === '720p' || item?.resolution === '1080p')
          && Number.isFinite(item?.credits_per_video)
          && Number.isFinite(item?.minimum_credits)
          && typeof item?.price_version === 'string'
        )).map((item: any) => ({
          duration_seconds: item.duration_seconds,
          resolution: item.resolution,
          credits_per_video: item.credits_per_video,
          minimum_credits: item.minimum_credits,
          price_version: item.price_version,
        }))
      : [],
  })).filter((model: GenStudioVideoModel) => model.id && model.display_name)
}

function videoSourceMediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

export function buildGenStudioVideoIdempotencyKey(input: {
  prompt: string
  modelId: string
  sourceSha256: string
  aspectRatio: string
  durationSeconds: 5 | 10
  resolution: '720p' | '1080p'
  requestIdentity?: string
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    prompt: input.prompt.trim(),
    model_id: input.modelId.trim(),
    source_sha256: input.sourceSha256,
    aspect_ratio: input.aspectRatio,
    duration_seconds: input.durationSeconds,
    resolution: input.resolution,
    request_identity: input.requestIdentity || null,
  })).digest('hex')
  return `story-video-${digest.slice(0, 44)}`
}

/** Submit image-to-video work only through GenStudio's durable video boundary. */
async function generateVideoWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioVideoRequest,
): Promise<{
  videoUrl: string
  jobId: string
  modelId: string
  downloadHeaders: Record<string, string>
  creditCost?: number
  remainingCredits?: number
  priceVersion?: string | null
}> {
  const prompt = request.prompt.trim()
  const modelId = request.modelId.trim()
  if (prompt.length < 3 || prompt.length > 4_000) throw new Error('GenStudio video prompts must contain 3 to 4,000 characters.')
  if (!modelId) throw new Error('Select a GenStudio video model.')
  const source = await fs.readFile(request.sourceImagePath)
  if (!source.length) throw new Error('GenStudio video source image is empty.')
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  const idempotencyKey = buildGenStudioVideoIdempotencyKey({
    prompt,
    modelId,
    sourceSha256,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    requestIdentity: request.requestIdentity,
  })
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const uploadBody = new FormData()
  uploadBody.set(
    'upload',
    new Blob([new Uint8Array(source)], { type: videoSourceMediaType(request.sourceImagePath) }),
    path.basename(request.sourceImagePath),
  )
  const sourceAsset = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/videos/source-images`,
    { method: 'POST', headers: authorization(apiKey), body: uploadBody },
    request,
    deadline,
  ) as GenStudioVideoSourceAsset
  if (!sourceAsset.id) throw new Error('GenStudio video source upload returned no asset id.')

  const submitted = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/videos/generations`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        prompt,
        model_id: modelId,
        mode: 'image-to-video',
        reference_asset_id: sourceAsset.id,
        aspect_ratio: request.aspectRatio,
        duration_seconds: request.durationSeconds,
        resolution: request.resolution,
      }),
    },
    request,
    deadline,
  ) as GenStudioVideoJob
  await recordGenStudioEvidence('video.generation', submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  let current = submitted
  let reportedState = ''
  while (current.state !== 'succeeded' && current.state !== 'failed') {
    if (reportedState !== current.state) {
      reportedState = current.state
      await recordGenStudioEvidence('video.generation', current)
      await request.onState?.(current.state, current.id)
    }
    if (request.isCancelled?.() || request.signal?.aborted) {
      await requestJsonWithRetry(
        `${apiBase(baseUrl)}/v1/videos/${encodeURIComponent(current.id)}/cancel`,
        { method: 'POST', headers: authorization(apiKey) },
        {},
        deadline,
      ).catch(() => {})
      throw new Error('Cancelled by user')
    }
    if (Date.now() >= deadline) throw new Error('GenStudio video job timed out while waiting for completion.')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/videos/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioVideoJob
  }
  await recordGenStudioEvidence('video.generation', current)
  await request.onState?.(current.state, current.id)
  if (current.state === 'failed') {
    throw new Error(`GenStudio video generation failed${current.failure_code ? ` (${current.failure_code})` : ''}. No legacy fallback was attempted.`)
  }
  const videoUrl = current.video_url || `/v1/videos/${encodeURIComponent(current.id)}/file`
  return {
    videoUrl: requestUrl(baseUrl, videoUrl),
    jobId: current.id,
    modelId: current.model_id,
    downloadHeaders: authorization(apiKey),
    creditCost: current.credit_cost,
    remainingCredits: current.remaining_credits,
    priceVersion: current.price_version,
  }
}

export async function generateVideoWithGenStudio(
  apiKey: string,
  request: GenStudioVideoRequest,
): Promise<{
  videoUrl: string
  jobId: string
  modelId: string
  downloadHeaders: Record<string, string>
  creditCost?: number
  remainingCredits?: number
  priceVersion?: string | null
}> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => generateVideoWithGenStudioAdmitted(apiKey, request),
  )
}

async function readAccountJson<T>(apiKey: string, pathName: string): Promise<T> {
  const baseUrl = await getGenStudioUrl()
  return readJson(await fetch(`${apiBase(baseUrl)}${pathName}`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  })) as Promise<T>
}

/** Lightweight authoritative account status used by model catalogs and plan guidance. */
export async function getGenStudioAccountOverview(apiKey: string): Promise<GenStudioAccountOverview> {
  return readAccountJson<GenStudioAccountOverview>(apiKey, '/v1/account/overview')
}

/** Authoritative balance and settlement data; never reconstructed locally. */
export async function getGenStudioAccountSnapshot(apiKey: string): Promise<{
  overview: GenStudioAccountOverview
  jobs: { items: GenStudioCustomerJob[]; page: number; page_size: number; total: number; total_pages: number }
  credit_activity: { items: GenStudioCreditActivity[]; page: number; page_size: number; total: number; total_pages: number }
}> {
  // Prove the key has account access before starting the two larger paginated
  // reads. An invalid or under-scoped key therefore produces one clear
  // failure instead of three concurrent rejected requests.
  const overview = await getGenStudioAccountOverview(apiKey)
  const [jobs, creditActivity] = await Promise.all([
    readAccountJson<any>(apiKey, '/v1/account/jobs?page=1&page_size=25'),
    readAccountJson<any>(apiKey, '/v1/account/credit-activity?page=1&page_size=25'),
  ])
  return { overview, jobs, credit_activity: creditActivity }
}

export function buildGenStudioChatIdempotencyKey(request: GenStudioChatRequest): string {
  const digest = createHash('sha256').update(JSON.stringify({
    model_id: request.modelId.trim(),
    system: request.system,
    user_message: request.userMessage,
    temperature: request.temperature ?? 0.7,
    top_p: request.topP ?? 1,
    max_output_tokens: request.maxOutputTokens ?? 2_048,
    request_identity: request.requestIdentity?.trim() || null,
  })).digest('hex')
  return `story-chat-${digest.slice(0, 47)}`
}

/** Submit once, then poll only GenStudio's durable chat job state. */
async function callChatWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioChatRequest,
): Promise<{ text: string; jobId: string; modelId: string }> {
  const modelId = request.modelId.trim()
  if (!modelId) throw new Error('Select a GenStudio KH chat model.')
  if (!request.userMessage.trim()) throw new Error('GenStudio KH chat input cannot be empty.')
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioChatIdempotencyKey(request)
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submitted = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/chat/responses`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        model_id: modelId,
        input: [
          ...(request.system.trim() ? [{ role: 'system', content: request.system }] : []),
          { role: 'user', content: request.userMessage },
        ],
        temperature: request.temperature ?? 0.7,
        top_p: request.topP ?? 1,
        max_output_tokens: Math.max(1, Math.min(32_768, request.maxOutputTokens ?? 2_048)),
      }),
    },
    request,
    deadline,
  ) as GenStudioChatJob
  await recordGenStudioEvidence('chat.response', submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  let current = submitted
  let reportedState = ''
  while (true) {
    if (reportedState !== current.state) {
      reportedState = current.state
      await recordGenStudioEvidence('chat.response', current)
      await request.onState?.(current.state, current.id)
    }
    if (current.state === 'failed') {
      throw new Error(
        `GenStudio KH chat generation failed${current.failure_code ? ` (${current.failure_code})` : ''}. ` +
        'No direct provider or Studio Hub fallback was attempted.',
      )
    }
    if (current.state === 'succeeded') break
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) throw new Error('GenStudio KH chat job timed out while waiting for completion')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/chat/responses/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioChatJob
  }
  if (typeof current.output_text !== 'string' || !current.output_text.trim()) {
    throw new Error('GenStudio KH chat job succeeded without usable output text')
  }
  return { text: current.output_text, jobId: current.id, modelId: current.model_id }
}

export async function callChatWithGenStudio(
  apiKey: string,
  request: GenStudioChatRequest,
): Promise<{ text: string; jobId: string; modelId: string }> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => callChatWithGenStudioAdmitted(apiKey, request),
  )
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
    unlimited_relaxed: value?.unlimited_relaxed === true,
    credits_per_minute: Number.isFinite(value?.credits_per_minute)
      ? Math.max(0, value.credits_per_minute)
      : 0,
    minimum_credits: Number.isFinite(value?.minimum_credits)
      ? Math.max(0, value.minimum_credits)
      : 0,
    price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : '',
  })).filter((model: GenStudioTranscriptionModel) => model.id && model.display_name)
}

/** Fetch the account-visible image catalog owned by GenStudio. */
export async function listImageModels(apiKey: string): Promise<GenStudioImageModel[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/image/models`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid image model catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    description: typeof value?.description === 'string' ? value.description.trim() : undefined,
    available: value?.available === true,
    qualification_only: value?.qualification_only !== false,
    execution_label: typeof value?.execution_label === 'string' ? value.execution_label.trim() : undefined,
    unlimited_relaxed: value?.unlimited_relaxed === true || value?.execution_label === 'Local fleet',
    credits_per_image: Number.isFinite(value?.credits_per_image)
      ? Math.max(0, value.credits_per_image)
      : null,
    minimum_credits: Number.isFinite(value?.minimum_credits)
      ? Math.max(0, value.minimum_credits)
      : null,
    price_version: typeof value?.price_version === 'string' ? value.price_version.trim() : null,
    chargeable: value?.chargeable === true,
    aspect_ratios: Array.isArray(value?.aspect_ratios)
      ? value.aspect_ratios.filter((ratio: unknown): ratio is string => typeof ratio === 'string' && !!ratio.trim())
      : [],
    default_aspect_ratio: typeof value?.default_aspect_ratio === 'string'
      ? value.default_aspect_ratio.trim()
      : '16:9',
    default_steps: Number.isInteger(value?.default_steps) ? value.default_steps : 4,
    min_steps: Number.isInteger(value?.min_steps) ? value.min_steps : 2,
    max_steps: Number.isInteger(value?.max_steps) ? value.max_steps : 8,
    sizes: Array.isArray(value?.sizes)
      ? value.sizes.filter((size: any) => (
          typeof size?.aspect_ratio === 'string' && size.aspect_ratio.trim().length > 0
          && Number.isInteger(size?.width) && size.width > 0
          && Number.isInteger(size?.height) && size.height > 0
        )).map((size: any) => ({
          aspect_ratio: size.aspect_ratio.trim(),
          width: size.width,
          height: size.height,
          label: typeof size.label === 'string' ? size.label.trim() : undefined,
          default: size.default === true,
        }))
      : undefined,
  })).filter((model: GenStudioImageModel) => model.id && model.display_name)
}

export function buildGenStudioImageIdempotencyKey(input: {
  prompt: string
  modelId: string
  aspectRatio: string
  steps: number
  width?: number
  height?: number
  seed?: number
  requestIdentity?: string
}): string {
  const hasDimensions = Number.isInteger(input.width) && input.width! > 0
    && Number.isInteger(input.height) && input.height! > 0
  const digest = createHash('sha256').update(JSON.stringify({
    prompt: input.prompt.trim(),
    model_id: input.modelId.trim(),
    aspect_ratio: input.aspectRatio,
    steps: input.steps,
    width: hasDimensions ? input.width : null,
    height: hasDimensions ? input.height : null,
    seed: input.seed ?? null,
    request_identity: input.requestIdentity || null,
  })).digest('hex')
  return `story-image-${digest.slice(0, 44)}`
}

async function waitForImageJob(
  baseUrl: string,
  apiKey: string,
  submitted: GenStudioImageJob,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void },
  deadline: number,
): Promise<GenStudioImageJob> {
  let current = submitted
  await recordGenStudioEvidence('image.generation', current)
  request.onState?.(current.state)
  while (current.state !== 'succeeded' && current.state !== 'failed') {
    if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) throw new Error('GenStudio KH image job timed out while waiting for completion')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/images/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioImageJob
    await recordGenStudioEvidence('image.generation', current)
    request.onState?.(current.state)
  }
  if (current.state === 'failed') {
    throw new Error(`GenStudio KH image generation failed${current.failure_code ? ` (${current.failure_code})` : ''}.`)
  }
  return current
}

async function downloadImageArtifact(
  baseUrl: string,
  apiKey: string,
  completed: GenStudioImageJob,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<string> {
  if (!completed.image_url) throw new Error('GenStudio KH image completed without an image download URL')
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(requestUrl(baseUrl, completed.image_url), {
        headers: authorization(apiKey),
        signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        const error = new Error(`GenStudio KH image download failed (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length < 24 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
          throw new Error('GenStudio KH returned an invalid PNG artifact')
        }
        return `data:image/png;base64,${bytes.toString('base64')}`
      }
    } catch (error) {
      if (request.isCancelled?.() || request.signal?.aborted) throw new Error('Cancelled by user')
      lastError = error
      if (error instanceof Error && !/HTTP (408|425|429|5\d\d)/.test(error.message)
        && !error.message.includes('fetch failed')) throw error
    }
    if (attempt < NETWORK_RETRY_ATTEMPTS) await retryDelay(attempt, request, deadline)
  }
  throw lastError instanceof Error ? lastError : new Error('GenStudio KH image download failed')
}

/** Reconnect to an already accepted image task. Never submits new work. */
async function recoverImageWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void } = {},
): Promise<{ url: string; jobId: string; modelId: string }> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/images/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioImageJob
  const completed = await waitForImageJob(baseUrl, apiKey, initial, request, deadline)
  const url = await downloadImageArtifact(baseUrl, apiKey, completed, request, deadline)
  return { url, jobId: completed.id, modelId: completed.model_id }
}

export async function recoverImageWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & { onState?: (state: GenStudioJob['state']) => void } = {},
): Promise<{ url: string; jobId: string; modelId: string }> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => recoverImageWithGenStudioAdmitted(apiKey, jobId, request),
  )
}

/** Submit one durable GenStudio image task and return its verified private PNG. */
async function generateImageWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioImageRequest,
): Promise<{ url: string; jobId: string; modelId: string }> {
  const prompt = request.prompt.trim()
  const modelId = request.modelId.trim()
  if (prompt.length < 3 || prompt.length > 4_000) {
    throw new Error('GenStudio KH image prompts must contain 3 to 4,000 characters.')
  }
  if (!modelId) throw new Error('Select a GenStudio KH image model.')
  if (!Number.isInteger(request.steps) || request.steps < 1 || request.steps > 100) {
    throw new Error('GenStudio KH image steps must be a whole number supported by the selected model.')
  }
  const hasDimensions = Number.isInteger(request.width) && request.width! > 0
    && Number.isInteger(request.height) && request.height! > 0
  const body = {
    prompt,
    model_id: modelId,
    aspect_ratio: request.aspectRatio,
    steps: request.steps,
    ...(hasDimensions
      ? { width: request.width, height: request.height }
      : {}),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  }
  const idempotencyKey = buildGenStudioImageIdempotencyKey({
    prompt,
    modelId,
    aspectRatio: request.aspectRatio,
    steps: request.steps,
    width: request.width,
    height: request.height,
    seed: request.seed,
    requestIdentity: request.requestIdentity || randomUUID(),
  })
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submitted = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/images/generations`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    request,
    deadline,
  ) as GenStudioImageJob
  await recordGenStudioEvidence('image.generation', submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  const completed = await waitForImageJob(baseUrl, apiKey, submitted, request, deadline)
  const url = await downloadImageArtifact(baseUrl, apiKey, completed, request, deadline)
  return { url, jobId: completed.id, modelId: completed.model_id }
}

export async function generateImageWithGenStudio(
  apiKey: string,
  request: GenStudioImageRequest,
): Promise<{ url: string; jobId: string; modelId: string }> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => generateImageWithGenStudioAdmitted(apiKey, request),
  )
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
  requestIdentity: string
  fileSha256: string
  modelId: string
  language?: string
  wordTimestamps?: boolean
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    request_identity: input.requestIdentity,
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
  request: GenStudioOperationContext & {
    onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  },
  deadline: number,
): Promise<GenStudioTranscriptionJob> {
  let current = submitted
  let reportedState: string | null = null
  const reportState = async (): Promise<void> => {
    if (reportedState === current.state) return
    reportedState = current.state
    await recordGenStudioEvidence('audio.transcription', current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
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
    await reportState()
  }
  if (current.state === 'failed') {
    throw new Error(
      `GenStudio KH transcription failed${current.failure_code ? ` (${current.failure_code})` : ''}. ` +
      'No OpenAI, Studio Hub, or direct Voice Studio fallback was attempted.',
    )
  }
  return current
}

async function downloadTranscriptionArtifact(
  baseUrl: string,
  apiKey: string,
  completed: GenStudioTranscriptionJob,
  request: GenStudioOperationContext,
  deadline: number,
): Promise<string> {
  if (!completed.srt_url) {
    throw new Error('GenStudio KH transcription completed without an SRT download URL')
  }
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(requestUrl(baseUrl, completed.srt_url), {
        headers: authorization(apiKey),
        signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        const error = new Error(`GenStudio KH SRT download failed (HTTP ${response.status})`)
        if (!retryableStatus(response.status)) throw error
        lastError = error
      } else {
        const srt = await response.text()
        if (!srt.trim()) throw new Error('GenStudio KH returned an empty SRT artifact')
        return srt
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

/** Reconnect to an already accepted transcription. Never submits new work. */
async function recoverTranscriptionWithGenStudioAdmitted(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & {
    onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  },
): Promise<{ srt: string; jobId: string; modelId: string }> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const initial = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/transcriptions/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioTranscriptionJob
  const completed = await waitForTranscriptionJob(baseUrl, apiKey, initial, request, deadline)
  const srt = await downloadTranscriptionArtifact(baseUrl, apiKey, completed, request, deadline)
  return { srt, jobId: completed.id, modelId: completed.model_id }
}

export async function recoverTranscriptionWithGenStudio(
  apiKey: string,
  jobId: string,
  request: GenStudioOperationContext & {
    onState?: (state: GenStudioJob['state'], jobId: string) => void | Promise<void>
  },
): Promise<{ srt: string; jobId: string; modelId: string }> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => recoverTranscriptionWithGenStudioAdmitted(apiKey, jobId, request),
  )
}

/** Submit private audio to GenStudio, poll its durable job, and return verified SRT text. */
async function transcribeWithGenStudioAdmitted(
  apiKey: string,
  request: GenStudioTranscriptionRequest,
): Promise<{ srt: string; jobId: string; modelId: string }> {
  const modelId = request.modelId.trim()
  if (!modelId) throw new Error('Select a GenStudio KH transcription model.')
  if (!request.requestIdentity.trim()) throw new Error('Stable Story Studio transcription asset identity is required.')
  const file = await fs.readFile(request.audioPath)
  if (!file.length) throw new Error('Transcription audio is empty.')
  if (file.length > GENSTUDIO_MAX_TRANSCRIPTION_BYTES) {
    throw new Error('GenStudio KH transcription input exceeds the 100 MiB qualification limit.')
  }
  const fileSha256 = createHash('sha256').update(file).digest('hex')
  const idempotencyKey = request.idempotencyKey?.trim() || buildGenStudioTranscriptionIdempotencyKey({
    requestIdentity: request.requestIdentity,
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
  await recordGenStudioEvidence('audio.transcription', submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey, fileSha256)
  const completed = await waitForTranscriptionJob(baseUrl, apiKey, submitted, request, deadline)
  const srt = await downloadTranscriptionArtifact(baseUrl, apiKey, completed, request, deadline)
  return { srt, jobId: completed.id, modelId: completed.model_id }
}

export async function transcribeWithGenStudio(
  apiKey: string,
  request: GenStudioTranscriptionRequest,
): Promise<{ srt: string; jobId: string; modelId: string }> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => transcribeWithGenStudioAdmitted(apiKey, request),
  )
}

async function waitForJob(
  baseUrl: string,
  apiKey: string,
  job: GenStudioJob,
  request: GenStudioTtsRequest,
  deadline: number,
): Promise<GenStudioJob> {
  let current = job
  let reportedState: string | null = null
  const reportState = async (): Promise<void> => {
    if (reportedState === current.state) return
    reportedState = current.state
    await recordGenStudioEvidence('voice.tts', current)
    await request.onState?.(current.state, current.id)
  }
  await reportState()
  while (current.state !== 'succeeded' && current.state !== 'failed') {
    if (request.isCancelled?.()) throw new Error('Cancelled by user')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    current = await requestJsonWithRetry(
      `${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(current.id)}`,
      { headers: authorization(apiKey) },
      request,
      deadline,
    ) as GenStudioJob
    await reportState()
  }
  if (current.state === 'failed') {
    throw new Error(`GenStudio KH generation failed${current.failure_code ? ` (${current.failure_code})` : ''}. No direct Studio Hub fallback was attempted.`)
  }
  return current
}

async function completeTtsJobToFile(
  baseUrl: string,
  apiKey: string,
  outPath: string,
  submitted: GenStudioJob,
  request: GenStudioTtsRequest,
  deadline: number,
): Promise<void> {
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
          signal: operationSignal(request.signal, deadline, GENSTUDIO_ARTIFACT_REQUEST_TIMEOUT_MS),
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
    await runFfmpeg(['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath])
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

/** Reconnect to an already accepted TTS task. Never submits new work. */
async function recoverTtsToFileAdmitted(
  apiKey: string,
  outPath: string,
  jobId: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const current = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(jobId)}`,
    { headers: authorization(apiKey) },
    request,
    deadline,
  ) as GenStudioJob
  await completeTtsJobToFile(baseUrl, apiKey, outPath, current, request, deadline)
}

export async function recoverTtsToFile(
  apiKey: string,
  outPath: string,
  jobId: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => recoverTtsToFileAdmitted(apiKey, outPath, jobId, request),
  )
}

/** Generate a GenStudio API TTS job, then convert its private WAV response to Story's MP3 contract. */
async function generateTtsToFileAdmitted(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  const baseUrl = await getGenStudioUrl()
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  const submission = buildGenStudioSubmission(request)
  const idempotencyKey = request.idempotencyKey?.trim() || submission.idempotencyKey
  const submitted = await requestJsonWithRetry(
    `${apiBase(baseUrl)}/v1/audio/jobs`,
    {
      method: 'POST',
      headers: {
        ...authorization(apiKey),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(submission.body),
    },
    request,
    deadline,
  ) as GenStudioJob
  await recordGenStudioEvidence('voice.tts', submitted)
  await request.onJobAccepted?.(submitted.id, idempotencyKey)
  await completeTtsJobToFile(baseUrl, apiKey, outPath, submitted, request, deadline)
}

export async function generateTtsToFile(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  return withGenStudioAdmission(
    apiKey,
    request,
    () => generateTtsToFileAdmitted(apiKey, outPath, request),
  )
}
