/**
 * GenAIPro Labs TTS client.
 * API docs: https://docs.genaipro.vn/
 * Base: https://genaipro.vn/api
 * Auth: Bearer token in Authorization header.
 *
 * Flow: POST /v1/labs/task → { task_id } → poll GET /v1/labs/task/{task_id} until status=completed → { result: audioUrl }.
 */

import { redactSecrets } from './redact-secrets.js'
import { sleepCancellable } from './http-retry.js'

const BASE = 'https://genaipro.vn/api'
const POLL_INTERVAL = 3000
// Bumped from 5 min → 20 min: GenAIPro chapter-length TTS tasks routinely
// exceed 5 min on their side, and timing out client-side orphans the task
// (history is only retained for ~1 day, so retroactive recovery has a tight
// window). Twenty minutes covers ~99% of long-form chapters.
const MAX_WAIT = 1200000

// Map short IDs used by Story Studio to GenAIPro model IDs.
const MODEL_MAP: Record<string, string> = {
  'genaipro-multilingual-v2': 'eleven_multilingual_v2',
  'genaipro-turbo-v2.5':      'eleven_turbo_v2_5',
  'genaipro-flash-v2.5':      'eleven_flash_v2_5',
  'genaipro-v3':              'eleven_v3',
  // Accept raw IDs as pass-through
  'eleven_multilingual_v2':   'eleven_multilingual_v2',
  'eleven_turbo_v2_5':        'eleven_turbo_v2_5',
  'eleven_flash_v2_5':        'eleven_flash_v2_5',
  'eleven_v3':                'eleven_v3',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * GenAIPro periodically returns HTML maintenance / proxy-error pages
 * with non-200 statuses (most commonly a 503 with a Vietnamese-language
 * "Đang Bảo Trì" page). Surfacing the raw HTML to the user produces a
 * wall of `<!DOCTYPE html>...` markup in the job log + UI.
 *
 * This helper detects HTML-shaped bodies and returns a short, action-
 * oriented sentence instead. Plain-text + JSON bodies fall through
 * unchanged so genuine API errors (rate-limit JSON, validation errors)
 * still surface their detail.
 *
 * Returns the message that should follow `GenAIPro <op> failed (<status>):`
 * — i.e. just the body summary, not the full prefix.
 */
export function summarizeGenaiproErrorBody(status: number, body: string): string {
  const trimmed = (body || '').trim()
  const looksLikeHtml = /^<!DOCTYPE\s+html|^<html[\s>]/i.test(trimmed)
  if (!looksLikeHtml) {
    return trimmed.slice(0, 300)
  }
  // Pull <title> when present — the Vietnamese maintenance page sets
  // it to "Đang Bảo Trì - Maintenance" which is usefully descriptive.
  const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || ''
  if (status === 503) {
    const titlePart = title ? ` (${title})` : ''
    return `GenAIPro is temporarily unavailable${titlePart}. The provider is likely under maintenance — try again in a few minutes, or switch the audio model in Settings → Voices.`
  }
  if (status === 502 || status === 504) {
    return `GenAIPro upstream gateway error. Try again in a moment.`
  }
  return title
    ? `GenAIPro returned an HTML error page (${title}). Check the provider's status page or try again.`
    : `GenAIPro returned an HTML error page (no parseable detail). Check the provider's status page or try again.`
}

export interface GenerateTtsOpts {
  model?: string
  voiceId?: string
  speed?: number
  stability?: number
  similarity?: number
  style?: number
  /**
   * Max time to wait for the TTS task to reach `status=completed`, in ms.
   * Overrides the 20-minute default. User-facing setting in Settings →
   * Performance exposes this per-project.
   */
  timeoutMs?: number
  /**
   * Called immediately after the task_id is returned from POST /v1/labs/task,
   * before polling begins. Lets the caller persist the task_id to a sidecar
   * manifest so that if polling times out, recovery can find the task later.
   * Awaited so the caller can do async I/O; errors are swallowed (sidecar
   * write failures must not break the generation flow).
   */
  onTaskSubmitted?: (taskId: string) => Promise<void> | void
  /** Probe for user cancel — stops polling immediately. */
  isCancelled?: () => boolean
}

export async function generateTts(
  text: string, apiKey: string, opts: GenerateTtsOpts = {},
): Promise<string> {
  if (!apiKey) throw new Error('No GenAIPro API key configured. Add one in Settings → API Keys.')
  if (!opts.voiceId) throw new Error('GenAIPro TTS requires a voice_id. Pick a voice in Settings → Voices.')

  const modelId = MODEL_MAP[opts.model || 'genaipro-multilingual-v2'] || 'eleven_multilingual_v2'

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const body = {
    input: text,
    voice_id: opts.voiceId,
    model_id: modelId,
    stability: opts.stability ?? 0.75,
    similarity: opts.similarity ?? 0.5,
    speed: opts.speed ?? 1,
    style: opts.style ?? 0,
    use_speaker_boost: true,
  }

  const submit = await fetch(`${BASE}/v1/labs/task`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!submit.ok) {
    const err = await submit.text()
    throw new Error(`GenAIPro submit failed (${submit.status}): ${summarizeGenaiproErrorBody(submit.status, redactSecrets(err, apiKey))}`)
  }
  const { task_id } = await submit.json() as { task_id: string }
  if (!task_id) throw new Error('GenAIPro did not return a task_id')

  // Persist the task_id ASAP (before polling), so a later timeout or crash
  // still leaves us with a reference for recovery.
  if (opts.onTaskSubmitted) {
    try { await opts.onTaskSubmitted(task_id) } catch { /* sidecar never blocks */ }
  }

  const deadline = Date.now() + (opts.timeoutMs ?? MAX_WAIT)
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error('Cancelled by user')
    await sleepCancellable(POLL_INTERVAL, opts.isCancelled)
    const poll = await fetch(`${BASE}/v1/labs/task/${task_id}`, { headers })
    if (!poll.ok) {
      const err = await poll.text()
      throw new Error(`GenAIPro poll failed (${poll.status}): ${summarizeGenaiproErrorBody(poll.status, redactSecrets(err, apiKey))}`)
    }
    const task = await poll.json() as { status?: string; result?: string; error?: string }
    if (task.status === 'completed' && task.result) return task.result
    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`GenAIPro task failed: ${task.error || 'unknown error'}`)
    }
  }
  throw new Error(`GenAIPro TTS timed out after ${Math.round((opts.timeoutMs ?? MAX_WAIT) / 60000)} minutes`)
}

/**
 * Shape of a Labs TTS task in GenAIPro's history.
 * Only the fields we rely on for recovery — the API returns more.
 */
export interface LabsTask {
  id: string
  input: string
  voice_id: string
  model_id: string
  status: string          // 'completed' | 'failed' | 'processing' | ...
  result?: string         // audio URL, present when completed
  created_at: string
}

/**
 * Fetch a single task by its ID. Used by the reconciler's stored-id-first
 * recovery path — if the sidecar manifest has a task_id for a missing
 * audio chunk, we can fetch it directly without scanning history.
 * Returns null on 404 / error (task aged out, ID typo, etc.).
 */
export async function getTaskById(apiKey: string, taskId: string): Promise<LabsTask | null> {
  if (!apiKey || !taskId) return null
  try {
    const resp = await fetch(`${BASE}/v1/labs/task/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) return null
    const data = await resp.json() as LabsTask
    if (!data?.id) return null
    return data
  } catch {
    return null
  }
}

/**
 * Poll an EXISTING task by its ID until it completes, fails, or times out.
 *
 * Used by the auto-recovery path inside generators (audio.ts) when the
 * task-manifest sidecar shows a stored task_id for a missing chunk:
 * polling the existing task is free, whereas re-submitting would charge
 * the user a second time.
 *
 * Returns the result URL on success, throws on failure / timeout / cancel.
 * Mirrors the structure of `generateTts`'s in-flight poll loop so the same
 * retention window and cancel semantics apply.
 */
export async function pollExistingTask(
  apiKey: string,
  taskId: string,
  opts: { isCancelled?: () => boolean; timeoutMs?: number } = {},
): Promise<string> {
  if (!apiKey) throw new Error('GenAIPro: no API key')
  if (!taskId) throw new Error('GenAIPro: no task id')
  const headers = { Authorization: `Bearer ${apiKey}` }
  const deadline = Date.now() + (opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : MAX_WAIT)
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error('Cancelled by user')
    const poll = await fetch(`${BASE}/v1/labs/task/${taskId}`, { headers })
    if (poll.status === 404) {
      throw new Error(`GenAIPro task ${taskId} not found (likely expired or invalid)`)
    }
    if (!poll.ok) {
      // Treat transient non-OK as poll-again, with a longer wait.
      await sleepCancellable(POLL_INTERVAL * 2, opts.isCancelled)
      continue
    }
    const task = await poll.json() as LabsTask
    if (task.status === 'completed' && task.result) return task.result
    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`GenAIPro task ${taskId} failed on provider side`)
    }
    await sleepCancellable(POLL_INTERVAL, opts.isCancelled)
  }
  throw new Error(`GenAIPro task ${taskId} did not complete within ${Math.round((Date.now() - (deadline - (opts.timeoutMs || MAX_WAIT))) / 1000)}s`)
}

/**
 * Paginate through the Labs task history.
 *
 * GenAIPro only retains TTS history for ~1 day, so this will typically
 * return small volumes (dozens of entries). We cap at 10 pages × 100 tasks
 * = 1000 entries as a safety rail in case the user ran a massive batch.
 */
export async function listAllLabsTasks(apiKey: string): Promise<LabsTask[]> {
  if (!apiKey) return []
  const out: LabsTask[] = []
  const limit = 100
  const maxPages = 10
  for (let page = 1; page <= maxPages; page++) {
    const resp = await fetch(`${BASE}/v1/labs/task?page=${page}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`GenAIPro task history failed (${resp.status}): ${summarizeGenaiproErrorBody(resp.status, redactSecrets(err, apiKey))}`)
    }
    const data = await resp.json() as { tasks?: LabsTask[]; total?: number }
    const tasks = data.tasks || []
    out.push(...tasks)
    if (tasks.length < limit) break
    if (typeof data.total === 'number' && out.length >= data.total) break
  }
  return out
}

export async function getCredits(apiKey: string): Promise<number | null> {
  if (!apiKey) return null
  try {
    const resp = await fetch(`${BASE}/v1/labs/credits`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) return null
    const arr = await resp.json() as Array<{ amount?: number }>
    return Array.isArray(arr) ? arr.reduce((s, c) => s + (c.amount || 0), 0) : null
  } catch {
    return null
  }
}
