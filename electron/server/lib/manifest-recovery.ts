/**
 * Auto-recovery helpers for the three generator pools (images, audio, video).
 *
 * Why this exists
 * ---------------
 * When a job fails partway and the user re-runs Generate, the per-item skip
 * check (`fileExistsWithContent`) only protects items that already finished
 * downloading. A request that was *submitted but still in flight* at the
 * provider has no file on disk yet — so a naive re-run would re-submit the
 * same prompt, charging the user a second time for a task that's literally
 * still running upstream.
 *
 * These helpers consult the per-modality `.task-manifest.json` sidecar
 * (written by `recordTask`) and try to recover missing items from existing
 * provider task records BEFORE submitting fresh:
 *
 *   - `success` upstream → download the result, no charge
 *   - `pending` upstream → poll until completion, still no charge
 *   - `failed` / `expired` / no manifest entry → return null; caller falls
 *                                                through to a fresh submit
 *
 * Per-provider dispatch matches the existing reconciler services
 * (image-reconciler.ts, video-reconciler.ts, audio-reconciler.ts). The
 * difference: those reconcilers are SINGLE-SHOT (used by the manual Repair
 * button), whereas these helpers POLL ON PENDING (used inline by Generate
 * before falling through to a fresh submit).
 *
 * Returning null means "no recovery available — caller should submit
 * fresh." Throwing only happens for provider-side failures (failed/expired)
 * — caller catches and falls through.
 */

import type { TaskManifestEntry } from '../services/task-manifest.js'
import {
  fetchKieVideo, fetchFalVideo, type FetchResult,
} from '../services/video-reconciler.js'
import { pollForImageUrls } from './kie-client.js'
import { pollExistingTask as pollExistingGenaiproTask } from './genaipro-client.js'
import { pollExistingFalAudio } from './fal-client.js'
import { fetchKieAudioUrlByTaskId } from './kie-tts-client.js'
import { sleepCancellable } from './http-retry.js'
import type { ImageModelConfig } from '../models/types.js'

export interface RecoveryResult {
  urls: string[]
  taskId: string
  provider: string
}

// Default poll deadline for recovery. Matches the kie image poller's
// MAX_WAIT (6 minutes) — enough time for an in-flight task to land but
// short enough that a stuck task doesn't block the whole batch.
const DEFAULT_POLL_DEADLINE_MS = 6 * 60 * 1000

// ── Images (kie only — matches existing image-reconciler scope) ──────────

/**
 * Try to recover scene/thumb image URLs from a stored manifest entry.
 * Returns null when the entry is missing, the provider isn't supported,
 * or the provider says the task failed/expired (caller falls through to
 * a fresh submit). On `pending`, polls until completion.
 */
export async function tryRecoverImageFromManifest(
  entry: TaskManifestEntry | null,
  apiKey: string,
  modelConfig: ImageModelConfig,
  isCancelled?: () => boolean,
): Promise<RecoveryResult | null> {
  if (!entry || !entry.task_id) return null
  if (entry.provider !== 'kie' && entry.provider !== 'kie-image') return null
  if (!apiKey) return null
  try {
    // pollForImageUrls already handles pending→success polling and throws
    // on provider failure / expired. Reuse it directly.
    const urls = await pollForImageUrls(entry.task_id, apiKey, modelConfig, { isCancelled })
    if (!urls.length) return null
    return { urls, taskId: entry.task_id, provider: entry.provider }
  } catch {
    // failed / expired / network — caller falls through to fresh submit.
    return null
  }
}

// ── Audio (genaipro only — matches existing audio-reconciler scope) ──────

/**
 * Try to recover an audio chunk URL from a stored manifest entry.
 * Wired providers:
 *   - GenAIPro → polls the stored task_id
 *   - fal      → re-polls the stored (poll_path, result_url) pair from
 *                fal's queue API. Auto-fills missing url fields by deriving
 *                them from request_id when an old (pre-5/6) entry only has
 *                task_id. ElevenLabs streams direct → no recovery possible.
 * On `pending`, polls until completion.
 */
export async function tryRecoverAudioFromManifest(
  entry: TaskManifestEntry | null,
  apiKey: string,
  isCancelled?: () => boolean,
  timeoutMs?: number,
): Promise<{ url: string; taskId: string; provider: string } | null> {
  if (!entry || !entry.task_id) return null
  if (!apiKey) return null
  if (entry.provider === 'genaipro') {
    try {
      const url = await pollExistingGenaiproTask(apiKey, entry.task_id, { isCancelled, timeoutMs })
      if (!url) return null
      return { url, taskId: entry.task_id, provider: entry.provider }
    } catch {
      return null
    }
  }
  if (entry.provider === 'fal') {
    if (!entry.poll_path || !entry.result_url) return null
    const url = await pollExistingFalAudio(entry.poll_path, entry.result_url, apiKey, {
      isCancelled, timeoutMs,
    })
    if (!url) return null
    return { url, taskId: entry.task_id, provider: entry.provider }
  }
  if (entry.provider === 'kie') {
    // Poll kie's task history until the in-flight task lands (or fails/expires).
    // Recovering a completed task is free; only the fresh submit below charges.
    const deadline = Date.now() + (timeoutMs || DEFAULT_POLL_DEADLINE_MS)
    while (Date.now() < deadline) {
      if (isCancelled?.()) return null
      let r: Awaited<ReturnType<typeof fetchKieAudioUrlByTaskId>>
      try { r = await fetchKieAudioUrlByTaskId(entry.task_id, apiKey) } catch { return null }
      if (r.status === 'success' && r.url) return { url: r.url, taskId: entry.task_id, provider: 'kie' }
      if (r.status === 'failed' || r.status === 'expired') return null
      await sleepCancellable(4000, isCancelled) // pending — wait + re-poll
    }
    return null // still pending at deadline → fall through to fresh submit
  }
  return null
}

// ── Video (kie / fal) ────────────────────────────────────────────────────

/**
 * Try to recover a per-scene video clip from a stored manifest entry.
 * Dispatches per provider. On `pending`, polls the single-shot fetcher
 * with backoff until completion or `pollDeadlineMs`.
 *
 * Returns null when no entry exists, the provider isn't recognised, or
 * the task failed/expired. Caller falls through to fresh submit.
 */
export async function tryRecoverVideoFromManifest(
  entry: TaskManifestEntry | null,
  config: { kie_api_key?: string; fal_api_key?: string },
  isCancelled?: () => boolean,
  pollDeadlineMs: number = DEFAULT_POLL_DEADLINE_MS,
): Promise<RecoveryResult | null> {
  if (!entry || !entry.task_id) return null

  // Pick the right single-shot fetcher per provider. Same dispatch shape
  // as video-reconciler.ts:recoverOne.
  const fetcher = (): Promise<FetchResult> | null => {
    switch (entry.provider) {
      case 'kie-video':
      case 'kie': {
        const k = config.kie_api_key || ''
        if (!k) return null
        return fetchKieVideo(entry.task_id, entry.poll_path || '', k)
      }
      case 'fal-video':
      case 'fal':
        return fetchFalVideo(entry.result_url || '')
      default:
        return null
    }
  }

  const probe = fetcher()
  if (!probe) return null

  const deadline = Date.now() + pollDeadlineMs
  // Poll-on-pending loop. Re-creates the fetch each iteration since
  // single-shot fetchers don't accept a continuation token. Backoff is
  // a fixed 6 s — provider task durations are 10s–10min so a tight loop
  // would just waste API calls.
  let result: FetchResult
  try {
    result = await probe
  } catch {
    return null
  }

  while (Date.now() < deadline) {
    if (isCancelled?.()) return null
    if (result.status === 'success' && result.urls.length) {
      return { urls: result.urls, taskId: entry.task_id, provider: entry.provider }
    }
    if (result.status === 'failed' || result.status === 'expired' || result.status === 'unknown') {
      return null
    }
    // pending — wait and retry.
    await sleepCancellable(6000, isCancelled)
    const next = fetcher()
    if (!next) return null
    try {
      result = await next
    } catch {
      return null
    }
  }
  // Timed out while still pending. Caller decides whether to fall through
  // to fresh submit (will double-charge) or skip and let the user retry
  // later. Returning null here = fall-through; the user can re-run for a
  // free retry-attempt on the same task.
  return null
}
