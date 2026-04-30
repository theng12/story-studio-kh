/**
 * Shared helpers for the polling clients (TTS, image, video).
 *
 * The providers we integrate (fal.ai, kie.ai, genaipro) all expose long-running
 * work via a submit → poll-status → fetch-result pattern. Previously each
 * client swallowed non-2xx status responses (`if (!resp.ok) continue`) and
 * kept polling until MAX_WAIT expired — so a 10-minute 429 storm surfaced as
 * "timed out", not "rate-limited". These helpers standardise the recovery
 * behaviour and honour `Retry-After` when the provider sends it.
 */

import { redactSecrets } from './redact-secrets.js'

const MAX_BACKOFF_MS = 60_000
const MAX_CONSECUTIVE_FAILURES = 8

export interface PollStepResult<T> {
  /** Return a value to stop polling and resolve with that value. */
  done?: T
  /** True if this step is "still working" — treat as a normal tick. */
  continue?: boolean
  /** Throw from the caller's side; used for terminal provider errors. */
  fail?: Error
}

export interface PollOpts<T> {
  /** Friendly provider label for error messages (e.g. "fal.ai status"). */
  label: string
  /** Status poll URL. */
  url: string
  /** Auth headers. */
  headers: Record<string, string>
  /** Absolute wall-clock deadline (ms). */
  deadline: number
  /** Base poll cadence in ms. */
  intervalMs: number
  /** Parse the successful response body and decide continue/done/fail. */
  onData: (data: unknown, resp: Response) => PollStepResult<T> | Promise<PollStepResult<T>>
  /** Optional cancel probe. When true, abort polling with a user-cancelled error. */
  isCancelled?: () => boolean
  /**
   * Optional API key to scrub from upstream error bodies before they're
   * embedded in thrown Error messages. Without this, a provider that echoes
   * the submitted Authorization header in a 4xx body leaks the key into
   * `logs/*.log` via the JobQueue → renderer → log-file chain.
   */
  redactKey?: string
}

/**
 * Poll `url` until `onData` returns `done`, the deadline elapses, or the
 * provider keeps erroring for `MAX_CONSECUTIVE_FAILURES` in a row.
 *
 * - Non-2xx responses get a `Retry-After`-aware backoff and count towards the
 *   consecutive-failure cap. After the cap, we escalate with a real error so
 *   the job fails loudly instead of timing out silently.
 * - Network errors (fetch throws) behave the same way.
 * - The poll HTTP itself has a per-request timeout via AbortSignal.timeout.
 */
export async function pollForResult<T>(opts: PollOpts<T>): Promise<T> {
  let consecutive = 0
  while (Date.now() < opts.deadline) {
    if (opts.isCancelled?.()) throw new Error('Cancelled by user')

    let resp: Response
    try {
      resp = await fetch(opts.url, {
        headers: opts.headers,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e: any) {
      consecutive++
      if (consecutive > MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`${opts.label}: ${consecutive} consecutive fetch errors (${e?.message || e})`)
      }
      await sleepCancellable(opts.intervalMs * Math.min(consecutive, 4), opts.isCancelled)
      continue
    }

    if (!resp.ok) {
      consecutive++
      if (consecutive > MAX_CONSECUTIVE_FAILURES) {
        const text = await resp.text().catch(() => '')
        const safe = redactSecrets(text, opts.redactKey)
        throw new Error(`${opts.label}: ${resp.status} ${resp.statusText} — ${safe.slice(0, 200)}`)
      }
      await sleepCancellable(backoffMs(resp, opts.intervalMs, consecutive), opts.isCancelled)
      continue
    }

    consecutive = 0
    let data: unknown
    try {
      data = await resp.json()
    } catch (e: any) {
      // Provider returned 2xx with non-JSON body (HTML error page, etc.).
      throw new Error(`${opts.label}: invalid JSON (${resp.status}): ${e?.message || e}`)
    }

    const step = await opts.onData(data, resp)
    if (step.fail) throw step.fail
    if (step.done !== undefined) return step.done as T
    await sleepCancellable(opts.intervalMs, opts.isCancelled)
  }
  throw new Error(`${opts.label}: timed out after ${Math.round((opts.deadline - (Date.now() - opts.intervalMs)) / 1000)}s`)
}

/** Respect `Retry-After` (seconds or HTTP-date); otherwise exponential. */
function backoffMs(resp: Response, baseMs: number, consecutive: number): number {
  const raw = resp.headers.get('Retry-After')
  if (raw) {
    const asNum = Number(raw)
    if (Number.isFinite(asNum) && asNum > 0) return Math.min(asNum * 1000, MAX_BACKOFF_MS)
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) {
      const delta = parsed - Date.now()
      if (delta > 0) return Math.min(delta, MAX_BACKOFF_MS)
    }
  }
  // No header — exponential with a hard ceiling.
  const exp = baseMs * Math.pow(2, Math.min(consecutive, 5))
  return Math.min(exp, MAX_BACKOFF_MS)
}

/**
 * Sleep in short steps so a user-cancelled job doesn't block for minutes
 * between retries. If `isCancelled` flips to true mid-sleep, we throw
 * immediately so the caller unwinds.
 */
export async function sleepCancellable(ms: number, isCancelled?: () => boolean): Promise<void> {
  if (ms <= 0) return
  const step = 200
  for (let t = 0; t < ms; t += step) {
    if (isCancelled?.()) throw new Error('Cancelled by user')
    await new Promise(r => setTimeout(r, Math.min(step, ms - t)))
  }
}

/**
 * Parse a response body as JSON with a readable error when the provider
 * returns a non-JSON body (HTML status page, empty body, etc.). Call AFTER
 * checking `resp.ok` — this helper only protects the JSON parse step.
 */
export async function readJsonOrThrow(resp: Response, label: string): Promise<any> {
  const text = await resp.text()
  if (!text) throw new Error(`${label}: empty response body (${resp.status})`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label}: non-JSON response (${resp.status}): ${text.slice(0, 200)}`)
  }
}

/**
 * Stream `resp.body` into `savePath`, deleting the file if the stream errors
 * mid-flight. Without this cleanup, a failed download leaves a truncated file
 * that the generator's `existsSync` guard mistakes for a valid cache hit.
 */
export async function downloadToFile(resp: Response, savePath: string): Promise<void> {
  const { createWriteStream } = await import('fs')
  const { pipeline } = await import('stream/promises')
  const { Readable } = await import('stream')
  const fs = await import('fs/promises')
  if (!resp.body) throw new Error(`Download failed: no body (${resp.status})`)
  const out = createWriteStream(savePath)
  try {
    await pipeline(Readable.fromWeb(resp.body as any), out)
  } catch (e) {
    await fs.rm(savePath, { force: true }).catch(() => {})
    throw e
  }
  // Sanity check — provider occasionally returns 200 with 0-byte body.
  const stat = await fs.stat(savePath)
  if (stat.size === 0) {
    await fs.rm(savePath, { force: true }).catch(() => {})
    throw new Error('Download wrote 0 bytes')
  }
}

/** Non-zero-size `existsSync` replacement — a 0-byte file is NOT a cache hit. */
export async function fileExistsWithContent(filePath: string): Promise<boolean> {
  const fs = await import('fs/promises')
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * Detect a macOS iCloud Drive placeholder ("evicted" file) for `filePath`.
 *
 * Returns true when the actual file is missing AND a `.<basename>.icloud`
 * stub sits alongside it — which is what iCloud's "Optimize Storage"
 * leaves behind after evicting the local copy of an asset to free disk.
 *
 * Why this helper exists: without it, generators that key off
 * `fileExistsWithContent` would treat an evicted asset as "missing" and
 * re-bill the provider to recreate work that's actually still recoverable
 * for free (open in Finder → iCloud pulls it back). Callers should:
 *   1. Check `fileExistsWithContent` — if true, the file is locally usable.
 *   2. Otherwise check this helper — if true, surface a "download in
 *      Finder before regenerating" hint and DO NOT submit a fresh request.
 *   3. Otherwise the file is genuinely missing — fresh submit is correct.
 */
export async function isCloudEvictedPlaceholder(filePath: string): Promise<boolean> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const stub = path.join(path.dirname(filePath), `.${path.basename(filePath)}.icloud`)
  try {
    const s = await fs.stat(stub)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * Run `count` tasks with at most `concurrency` in flight at once.
 *
 * Uses `Promise.allSettled` so one submit failure doesn't discard the other
 * N-1 results the user already paid for. The caller decides how to treat
 * rejections — the returned array preserves order and status.
 */
export async function runLimitedSettled<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(count)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= count) return
      try {
        results[i] = { status: 'fulfilled', value: await task(i) }
      } catch (e) {
        results[i] = { status: 'rejected', reason: e }
      }
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, count)) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}
