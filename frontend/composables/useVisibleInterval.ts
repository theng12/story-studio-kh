/**
 * An interval that does not run while the window is hidden.
 *
 * The Jobs page ticks a 1 s clock and polls the queue every 5 s for as long as it is mounted, hidden
 * window included. Hidden, nobody reads either; on becoming visible it catches up at once (`onResume`
 * runs immediately) and the interval restarts. Call `start()` on mount and `stop()` on unmount.
 */
export function createVisibleInterval(tick: () => void, ms: number, onResume: () => void = tick): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let started = false
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const arm = () => { if (!timer) timer = setInterval(tick, ms) }
  const disarm = () => { if (timer) { clearInterval(timer); timer = null } }
  const onVisibility = () => {
    if (!started) return
    if (hidden()) disarm()
    else { onResume(); arm() }
  }
  return {
    start() {
      if (started) return
      started = true
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
      if (!hidden()) arm()
    },
    stop() {
      started = false
      disarm()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
