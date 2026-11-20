/**
 * Abort a transfer that has delivered NOTHING for a while — the bound for work whose duration is
 * decided by how much there is to move, not by a clock.
 *
 * 1.4.415: both final-render transports were bounded by total time, and the import's ceiling was the
 * same 300 000 ms as the download's own abort, so a transfer of more than five minutes could never
 * finish and the row named whichever timer fired first. A transfer that keeps delivering bytes is
 * progress, whatever its total duration; one that stops delivering is over. Callers reset the timer on
 * every chunk (`touch()`), so the only thing that ends a healthy transfer is its own completion.
 */
export interface IdleAbort {
  readonly signal: AbortSignal
  /** A chunk arrived: start the window again. */
  touch(): void
  /** Done with it: no timer is left behind. */
  dispose(): void
}

export function createIdleAbort(timeoutMs: number, describe: (seconds: number) => string): IdleAbort {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error(describe(Math.round(timeoutMs / 1000)))), timeoutMs)
    timer.unref?.()
  }
  arm()
  return {
    signal: controller.signal,
    touch: arm,
    dispose: () => { if (timer) clearTimeout(timer); timer = undefined },
  }
}
