/**
 * An interval that does not run while the window is hidden.
 *
 * The Jobs page ticks a 1 s clock and polls the queue every 5 s for as long as it is mounted, hidden
 * window included. Hidden, nobody reads either; on becoming visible it catches up at once (`onResume`
 * runs immediately) and the interval restarts. Call `start()` on mount and `stop()` on unmount.
 */
export interface VisibleIntervalEnv {
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  setInterval?: (fn: () => void, ms: number) => any
  clearInterval?: (id: any) => void
}

export function createVisibleInterval(
  tick: () => void,
  ms: number,
  onResume: () => void = tick,
  env: VisibleIntervalEnv = {},
): { start: () => void; stop: () => void } {
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined)
  const setI = env.setInterval ?? ((fn, delay) => setInterval(fn, delay))
  const clearI = env.clearInterval ?? ((id) => clearInterval(id))
  let timer: any = null
  let started = false
  const hidden = () => doc?.visibilityState === 'hidden'
  const arm = () => { if (!timer) timer = setI(tick, ms) }
  const disarm = () => { if (timer) { clearI(timer); timer = null } }
  const onVisibility = () => {
    if (!started) return
    if (hidden()) disarm()
    else { onResume(); arm() }
  }
  return {
    start() {
      if (started) return
      started = true
      doc?.addEventListener('visibilitychange', onVisibility)
      if (!hidden()) arm()
    },
    stop() {
      started = false
      disarm()
      doc?.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
