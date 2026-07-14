/**
 * kie.ai ElevenLabs TTS client — a fourth ElevenLabs gateway (alongside direct,
 * fal, and GenAIPro), notable for the cheapest per-character pricing.
 *
 * kie.ai's unified "jobs" API: POST /jobs/createTask returns a taskId; poll
 * /jobs/recordInfo until success, then download the audio from resultUrls[0].
 * Same pattern as the image client (lib/kie-client.ts); this one carries the
 * ElevenLabs TTS input shape and returns the finished audio URL (the audio
 * generator downloads it, mirroring the genaipro/fal path).
 *
 * Docs: https://docs.kie.ai/market/elevenlabs/text-to-speech-multilingual-v2
 *       https://docs.kie.ai/market/elevenlabs/text-to-dialogue-v3
 */
import { redactSecrets } from './redact-secrets.js'

const KIE_BASE_URL = 'https://api.kie.ai/api/v1'
const POLL_INTERVAL = 2000
const MAX_WAIT = 5 * 60 * 1000
// Polling an existing task can retry safely. Creating a paid task cannot: a
// dropped response may still mean the provider accepted and charged the first
// request, so an automatic resubmit risks duplicate work and cost.
const MAX_CONSECUTIVE_POLL_FAILURES = 6

/** Exponential backoff (capped), honoring Retry-After when present. */
function backoffMs(attempt: number, resp?: Response): number {
  const ra = resp?.headers.get('Retry-After')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000)
  }
  return Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000)
}
const isRetriableStatus = (s: number) => s === 429 || s === 408 || (s >= 500 && s < 600)
function sleepCancellable(ms: number, isCancelled?: () => boolean): Promise<void> {
  return new Promise(res => {
    const step = 200
    let waited = 0
    const t = setInterval(() => {
      waited += step
      if (waited >= ms || isCancelled?.()) { clearInterval(t); res() }
    }, step)
  })
}

/** Catalog key → kie.ai model string. */
const KIE_TTS_MODELS: Record<string, string> = {
  'kie-eleven-turbo-v2.5': 'elevenlabs/text-to-speech-turbo-2-5',
  'kie-eleven-multilingual-v2': 'elevenlabs/text-to-speech-multilingual-v2',
  'kie-eleven-v3': 'elevenlabs/text-to-dialogue-v3',
}

export function kieTtsModelFor(catalogKey: string | undefined): string | undefined {
  return catalogKey ? KIE_TTS_MODELS[catalogKey] : undefined
}
export function isKieTtsModel(catalogKey: string | undefined): boolean {
  return !!kieTtsModelFor(catalogKey)
}

export interface KieTtsOptions {
  /** Catalog key (e.g. 'kie-eleven-turbo-v2.5'). */
  model?: string
  /** ElevenLabs voice id (kie's `voice` field). Required. */
  voiceId?: string
  stability?: number
  similarity?: number
  style?: number
  /** 0.7–1.2 */
  speed?: number
  signal?: AbortSignal
  isCancelled?: () => boolean
  /** Called with the kie taskId right after createTask, before polling — lets
   *  the caller persist it for later repair (recover a completed-but-lost download). */
  onTaskSubmitted?: (taskId: string) => void | Promise<void>
}

export function buildKieTtsInput(kieModel: string, text: string, opts: KieTtsOptions): Record<string, any> {
  const voice = opts.voiceId || ''
  const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  // text-to-dialogue-v3 takes an array of turns; narration is a single turn.
  if (kieModel.endsWith('text-to-dialogue-v3')) {
    const input: Record<string, any> = { dialogue: [{ text, voice }] }
    if (num(opts.stability) !== undefined) input.stability = opts.stability
    return input
  }
  const input: Record<string, any> = { text, voice }
  if (num(opts.stability) !== undefined) input.stability = opts.stability
  if (num(opts.similarity) !== undefined) input.similarity_boost = opts.similarity
  if (num(opts.style) !== undefined) input.style = opts.style
  if (num(opts.speed) !== undefined) input.speed = opts.speed
  return input
}

async function submitTask(text: string, apiKey: string, opts: KieTtsOptions): Promise<string> {
  const kieModel = kieTtsModelFor(opts.model)
  if (!kieModel) throw new Error(`Unknown kie.ai TTS model: ${opts.model}`)
  if (!opts.voiceId) throw new Error('A voice is required for kie.ai ElevenLabs TTS.')
  const body = JSON.stringify({ model: kieModel, input: buildKieTtsInput(kieModel, text, opts) })

  if (opts.isCancelled?.()) throw new Error('Cancelled by user')
  let resp: Response
  try {
    resp = await fetch(`${KIE_BASE_URL}/jobs/createTask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    })
  } catch (e: any) {
    throw new Error(`kie.ai createTask network error: ${e?.message || e}. Automatic resubmission is disabled for paid API work; use Retry after checking provider history.`)
  }
  if (isRetriableStatus(resp.status)) {
    throw new Error(`kie.ai createTask ${resp.status}. Automatic resubmission is disabled for paid API work; use Retry when ready.`)
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`kie.ai createTask ${resp.status}: ${redactSecrets(t, apiKey).slice(0, 200)}`)
  }
  const data = (await resp.json()) as any
  if (data?.code && data.code !== 200 && data.code !== '200') {
    throw new Error(`kie.ai createTask error: ${redactSecrets(data.msg || JSON.stringify(data), apiKey).slice(0, 200)}`)
  }
  const taskId = data?.data?.taskId || data?.taskId || data?.data?.task_id
  if (!taskId) throw new Error(`kie.ai: no taskId in response: ${redactSecrets(JSON.stringify(data), apiKey).slice(0, 200)}`)
  return String(taskId)
}

function extractAudioUrl(taskData: any): string | null {
  const r = taskData.response
  if (r && typeof r === 'object') {
    const urls = r.resultUrls || r.audioUrls || []
    if (Array.isArray(urls) && urls.length) return urls.find((u: any) => typeof u === 'string' && u) || null
    if (r.resultUrl || r.audioUrl) return r.resultUrl || r.audioUrl
  }
  if (taskData.resultJson) {
    try {
      const rj = typeof taskData.resultJson === 'string' ? JSON.parse(taskData.resultJson) : taskData.resultJson
      const urls = rj.resultUrls || rj.audioUrls || []
      if (Array.isArray(urls) && urls.length) return urls.find((u: any) => typeof u === 'string' && u) || null
    } catch { /* ignore */ }
  }
  const single = taskData.resultUrl || taskData.audioUrl || taskData.outputUrl
  return typeof single === 'string' && single ? single : null
}


async function pollAudioUrl(taskId: string, apiKey: string, opts: KieTtsOptions): Promise<string> {
  const deadline = Date.now() + MAX_WAIT
  const headers = { Authorization: `Bearer ${apiKey}` }
  let consecutiveFailures = 0
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error('Cancelled by user')

    let resp: Response
    try {
      resp = await fetch(`${KIE_BASE_URL}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
        headers, signal: AbortSignal.timeout(30_000),
      })
    } catch (e: any) {
      // Transient network error on a poll — DON'T fail the chunk; the task is
      // still running on kie's side. Back off and retry; only give up after a
      // sustained run of failures.
      consecutiveFailures++
      if (consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`kie.ai poll failed ${consecutiveFailures}× in a row: ${e?.message || e}`)
      }
      await sleepCancellable(backoffMs(consecutiveFailures), opts.isCancelled)
      continue
    }

    if (!resp.ok) {
      consecutiveFailures++
      if (consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`kie.ai poll HTTP ${resp.status} ${consecutiveFailures}× in a row`)
      }
      await sleepCancellable(backoffMs(consecutiveFailures, resp), opts.isCancelled)
      continue
    }

    consecutiveFailures = 0
    const data = (await resp.json()) as any
    const taskData = data.data || data
    let status: string
    const flag = taskData.successFlag
    if (flag !== undefined && flag !== null) status = flag === 1 ? 'success' : flag >= 2 ? 'failed' : 'pending'
    else status = String(taskData.state || taskData.status || '').toLowerCase()

    if (['success', 'completed', 'finished', 'succeed'].includes(status)) {
      const url = extractAudioUrl(taskData)
      if (url) return url
      throw new Error('kie.ai TTS succeeded but no audio URL in response')
    }
    if (['failed', 'error', 'fail'].includes(status)) {
      throw new Error(`kie.ai TTS failed: ${redactSecrets(taskData.errorMessage || taskData.error || 'provider reported failure', apiKey)}`)
    }
    await sleepCancellable(POLL_INTERVAL, opts.isCancelled)
  }
  throw new Error(`kie.ai TTS did not complete within ${MAX_WAIT / 1000}s`)
}

/** Submit + poll; returns the finished audio file URL (caller downloads it). */
export async function generateTtsToUrl(text: string, apiKey: string, opts: KieTtsOptions): Promise<string> {
  const taskId = await submitTask(text, apiKey, opts)
  await opts.onTaskSubmitted?.(taskId)
  return pollAudioUrl(taskId, apiKey, opts)
}

/**
 * Single-shot task lookup for the audio reconciler: given a stored taskId,
 * return the finished audio URL if the task completed on kie's side (and is
 * still in kie's history), else a status. Never loops.
 */
export async function fetchKieAudioUrlByTaskId(
  taskId: string,
  apiKey: string,
): Promise<{ status: 'success' | 'failed' | 'pending' | 'expired' | 'unknown'; url?: string; message?: string }> {
  const resp = await fetch(`${KIE_BASE_URL}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`kie.ai recordInfo: ${e?.message || e}`) })
  if (resp.status === 404) return { status: 'expired', message: 'Task not found (aged out of kie history)' }
  if (!resp.ok) return { status: 'unknown', message: `HTTP ${resp.status}` }
  const data = (await resp.json()) as any
  const taskData = data.data || data
  let status: string
  const flag = taskData.successFlag
  if (flag !== undefined && flag !== null) status = flag === 1 ? 'success' : flag >= 2 ? 'failed' : 'pending'
  else status = String(taskData.state || taskData.status || '').toLowerCase()
  if (['success', 'completed', 'finished', 'succeed'].includes(status)) {
    const url = extractAudioUrl(taskData)
    return url ? { status: 'success', url } : { status: 'unknown', message: 'succeeded but no audio URL' }
  }
  if (['failed', 'error', 'fail'].includes(status)) {
    return { status: 'failed', message: taskData.errorMessage || taskData.error || 'provider reported failure' }
  }
  return { status: 'pending', message: `status: ${status || 'unknown'}` }
}
