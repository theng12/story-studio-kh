/**
 * Per-endpoint latency tracking for multi-Mac local-model pools (v1.0.294).
 *
 * MLX models on Apple Silicon (Voice Studio TTS, Image Studio diffusion,
 * LM Studio LLM) accumulate state across requests — KV cache growth, Metal
 * command buffer pressure, VAE decode memory churn. After enough sustained
 * use, this surfaces as either an outright crash (memory exhausted) or — more
 * insidiously — silent latency degradation where the modal still responds
 * but each call takes 2-5× longer. The user sees nothing wrong; the job
 * just feels slow.
 *
 * Story Studio can't see the modal's internal memory state, but it CAN see
 * how long each call takes. This module tracks per-endpoint latency over
 * the course of one job, computes a baseline from the first N successful
 * calls, and surfaces a warning when the moving-window average exceeds the
 * baseline by a configurable factor (default 2×). The user gets an early
 * heads-up to restart Voice Studio before things actually hang.
 *
 * Single-job scoped by design: stats start fresh for each audio job. Cross-
 * job persistence would conflate different sessions (Mac slept, user
 * restarted the modal, etc.) and bias the baseline.
 *
 * Lightweight by design: a Map of small per-endpoint stat objects, a few
 * arithmetic ops per call. No I/O, no async, safe to call from inside hot
 * loops.
 */

export interface EndpointStat {
  /** Sliding window of the most recent N call durations (ms). */
  durations: number[]
  /** Total successful calls observed (durations.length is capped at
   *  recentWindow but totalCount keeps growing). */
  totalCount: number
  /** Average of the FIRST baselineWindow calls — set once and never
   *  updated, so it represents "fresh-modal" performance. Null until
   *  enough samples have arrived. */
  baselineAvg: number | null
  /** True after the degradation threshold was crossed at least once.
   *  Used to suppress duplicate warnings — one per endpoint per job. */
  degradationWarned: boolean
  /** Internal: first-N samples being accumulated until baselineAvg is set. */
  firstDurations: number[]
}

export interface RecordCallOptions {
  /** Fired exactly once per endpoint per job when the recent-window
   *  average first exceeds baselineAvg × degradationFactor. The argument
   *  is a human-readable warning suitable for job.output_lines.push. */
  onDegradation?: (message: string) => void
  /** How many initial successful calls to average for the baseline.
   *  Larger = more stable baseline but slower to detect degradation on
   *  short jobs. Default 5. */
  baselineWindow?: number
  /** Sliding-window size for the "recent" comparison. Default 5. */
  recentWindow?: number
  /** Trigger threshold. Default 2.0 (recent avg > 2× baseline → warn). */
  degradationFactor?: number
}

export function newLatencyStats(): Map<string, EndpointStat> {
  return new Map()
}

/**
 * Record a single successful call's duration for the given endpoint. Updates
 * the rolling window, computes the baseline if enough samples have arrived,
 * and fires `onDegradation` exactly once per endpoint when the recent-window
 * average first exceeds the threshold.
 *
 * Only record SUCCESSFUL calls — a failed/retried call doesn't say much
 * about model health (the server might just be down or the network blipped).
 * The dispatcher's failover handles those separately.
 */
export function recordCall(
  stats: Map<string, EndpointStat>,
  endpoint: string,
  durationMs: number,
  opts?: RecordCallOptions,
): void {
  const baselineWindow = opts?.baselineWindow ?? 5
  const recentWindow = opts?.recentWindow ?? 5
  const degradationFactor = opts?.degradationFactor ?? 2

  let s = stats.get(endpoint)
  if (!s) {
    s = {
      durations: [],
      totalCount: 0,
      baselineAvg: null,
      degradationWarned: false,
      firstDurations: [],
    }
    stats.set(endpoint, s)
  }

  s.totalCount++
  s.durations.push(durationMs)
  if (s.durations.length > recentWindow) s.durations.shift()

  // Lock in the baseline from the FIRST N samples. The baseline is
  // intentionally NOT updated after that — we want "how fresh was this
  // modal at the start of the job?" as the reference for "is it degrading
  // now?". A rolling baseline would silently absorb the degradation.
  if (s.firstDurations.length < baselineWindow) {
    s.firstDurations.push(durationMs)
    if (s.firstDurations.length === baselineWindow) {
      s.baselineAvg = avg(s.firstDurations)
    }
  }

  // Detect degradation. Three preconditions:
  //   1. We have a baseline (enough samples landed)
  //   2. The recent window is full (avoid firing on a single slow outlier)
  //   3. We haven't warned for this endpoint already this job
  if (
    s.baselineAvg !== null
    && s.durations.length >= recentWindow
    && !s.degradationWarned
  ) {
    const recent = avg(s.durations)
    if (recent > s.baselineAvg * degradationFactor) {
      s.degradationWarned = true
      const recentS = (recent / 1000).toFixed(1)
      const baseS = (s.baselineAvg / 1000).toFixed(1)
      const factor = (recent / s.baselineAvg).toFixed(1)
      opts?.onDegradation?.(
        `⚠ ${endpoint} latency degrading — last ${recentWindow} calls avg ${recentS}s `
        + `vs baseline ${baseS}s (${factor}× slower). The MLX modal may be running out of `
        + `memory; consider restarting Voice Studio on this Mac when convenient.`,
      )
    }
  }
}

/**
 * Build the end-of-job summary lines. Push these into job.output_lines so
 * the user can scan the Jobs panel and see per-endpoint timing without
 * scrolling through every chunk. Empty array if no endpoints were tracked.
 */
export function summarize(stats: Map<string, EndpointStat>): string[] {
  if (stats.size === 0) return []
  const out: string[] = ['Endpoint latency summary:']
  // Sort by endpoint URL so the summary is stable across runs.
  const entries = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [ep, s] of entries) {
    const recentAvg = s.durations.length > 0 ? avg(s.durations) : 0
    const parts: string[] = [`${ep}: ${s.totalCount} call${s.totalCount === 1 ? '' : 's'}`]
    parts.push(`recent avg ${(recentAvg / 1000).toFixed(1)}s/chunk`)
    if (s.baselineAvg !== null) {
      parts.push(`baseline ${(s.baselineAvg / 1000).toFixed(1)}s`)
      const factor = recentAvg / s.baselineAvg
      if (factor > 1.5) parts.push(`${factor.toFixed(1)}× slower`)
    }
    if (s.degradationWarned) parts.push('⚠ degraded mid-job')
    out.push(`  • ${parts.join(' · ')}`)
  }
  return out
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
