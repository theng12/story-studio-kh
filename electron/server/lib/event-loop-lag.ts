/**
 * Main-thread lag, measured — the difference between "a request was slow" and "the process stopped".
 *
 * angkor 2026-11-19: /api/health (no disk, no network, no queue) answered at a 5 ms median but a
 * 218 ms p90 and a 290 ms max while renders ran, and 200-300 ms stalls are long enough for lock waits
 * to pile up behind them. This histogram says whether the loop itself is stalling and how often,
 * which is the question that separates GC thrash from synchronous work.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 10 })

export function startEventLoopMonitor(): void {
  histogram.enable()
}

/** Percentiles in milliseconds, rounded, and how many samples the window holds. */
export function readEventLoopLag(): { p50_ms: number; p90_ms: number; p99_ms: number; max_ms: number; samples: number } {
  const ms = (ns: number) => Math.round(ns / 1e6)
  return {
    p50_ms: ms(histogram.percentile(50)),
    p90_ms: ms(histogram.percentile(90)),
    p99_ms: ms(histogram.percentile(99)),
    max_ms: ms(histogram.max),
    samples: histogram.count,
  }
}

/** Test seam: build the same shape from given nanosecond percentiles. */
export function eventLoopLagFrom(snapshot: { p50: number; p90: number; p99: number; max: number; count: number }) {
  const ms = (ns: number) => Math.round(ns / 1e6)
  return { p50_ms: ms(snapshot.p50), p90_ms: ms(snapshot.p90), p99_ms: ms(snapshot.p99), max_ms: ms(snapshot.max), samples: snapshot.count }
}
