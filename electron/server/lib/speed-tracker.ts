/**
 * Sliding-window transfer-rate helper. One instance per in-flight transfer
 * (upload or download). Call `update(bytesNow)` whenever you observe a new
 * cumulative byte count; it returns the rolling average bytes/second over
 * the configured window plus an optional ETA when total bytes are known.
 *
 * Design notes:
 *   - 5-second default window smooths out chunk-size jitter (YouTube's
 *     resumable PUT fires `onProgress` 50×/s with non-uniform chunk sizes).
 *   - First sample anchors the window; speed reads as 0 until at least one
 *     interval elapses. UI tooltip explains the warm-up to the user.
 *   - Sample buffer is bounded by the window itself — old samples are
 *     dropped on each `update`, so memory stays O(window/Δt).
 */
export class SpeedTracker {
  private samples: { t: number; bytes: number }[] = []

  constructor(private windowMs = 5000, private totalBytes?: number) {}

  update(bytesNow: number): { speedBps: number; etaSeconds?: number } {
    const now = Date.now()
    this.samples.push({ t: now, bytes: bytesNow })
    while (this.samples.length > 1 && now - this.samples[0]!.t > this.windowMs) {
      this.samples.shift()
    }
    const first = this.samples[0]!
    const dt = (now - first.t) / 1000
    const speedBps = dt > 0 ? Math.max(0, (bytesNow - first.bytes) / dt) : 0
    const etaSeconds = this.totalBytes && speedBps > 0
      ? Math.max(0, (this.totalBytes - bytesNow) / speedBps)
      : undefined
    return { speedBps, etaSeconds }
  }
}

/**
 * Trailing-edge throttle. Used to cap how often we mutate Job state (and
 * therefore how often the SSE stream wakes up) when the underlying transfer
 * fires progress events many times per second. The latest call's args win.
 */
export function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0
  let pending: any[] | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    if (!pending) return
    last = Date.now()
    const args = pending
    pending = null
    timer = null
    fn(...args)
  }
  return ((...args: any[]) => {
    pending = args
    const now = Date.now()
    const remaining = ms - (now - last)
    if (remaining <= 0) {
      run()
    } else if (!timer) {
      timer = setTimeout(run, remaining)
    }
  }) as T
}
