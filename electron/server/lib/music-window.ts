/**
 * How many music requests a job keeps at the Gateway (1.4.270, owner: "if I approve a pool of 500
 * songs, can we fill up the fleet if nothing else is generating? that's why it's a fleet").
 *
 * No fixed number when the Gateway can say what the fleet can take (0.2.165+, `/v1/fleet/capacity`):
 * requests go as `priority: "background"`, which the Gateway runs only on idle Macs, after every
 * normal job. The window is re-read as each request finishes (and every 30 s): keep what is in
 * flight, and add as many as there are idle Macs for the model plus a small buffer, minus the
 * background requests already waiting at the Gateway (anyone's). So the Gateway's background queue
 * stays at about idle Macs + BACKGROUND_BUFFER and never piles up toward its 3-hour queue timeout,
 * and two jobs share the idle Macs instead of each claiming them all.
 *
 * Older Gateway (no capacity endpoint): MUSIC_FALLBACK_WINDOW at a time, normal priority, as a
 * Song Pool "at once" ceiling allows. A cloud music model (not on the fleet): the fallback window.
 */
import { readFleetCapacity, type GenStudioFleetModelCapacity } from './genstudio-client.js'

export const MUSIC_FALLBACK_WINDOW = 6
/** Background requests kept waiting at the Gateway beyond its idle Macs, so a Mac that frees never sits idle. */
export const BACKGROUND_BUFFER = 2

/** The window for one read: in flight now plus what the idle Macs can take. Pure, for tests. */
export function backgroundWindow(capacity: GenStudioFleetModelCapacity, inFlight: number): number {
  return inFlight + Math.max(0, capacity.idle_macs + BACKGROUND_BUFFER - capacity.queued.background)
}

export interface MusicWindowSizer {
  /** 'background' when the Gateway has the class (sent on every request), else undefined. */
  priority: 'background' | undefined
  size(inFlight: number): Promise<number>
}

/** Read once whether the Gateway has the background class; then size the window on every call. */
export async function musicWindowSizer(
  apiKey: string, modelId: string, log: (line: string) => void, ownerCap?: number,
): Promise<MusicWindowSizer> {
  const first = await readFleetCapacity(apiKey, 'music', modelId).catch(() => ({ supported: false as const }))
  const fallback = Math.max(1, ownerCap && ownerCap > 0 ? Math.min(ownerCap, 256) : MUSIC_FALLBACK_WINDOW)
  if (!first.supported) {
    log(`Requests in flight: ${fallback} at a time (this Gateway has no fleet capacity reading).`)
    return { priority: undefined, size: async () => fallback }
  }
  if (!first.model) {
    log(`Requests in flight: ${fallback} at a time (${modelId} is not a fleet model), sent as background work.`)
    return { priority: 'background', size: async () => fallback }
  }
  log(`Requests in flight: sized to the fleet (${first.model.eligible_macs} Mac(s) can run this model, `
    + `${first.model.idle_macs} idle now), sent as background work that only uses idle Macs.`)
  let last = Math.max(1, backgroundWindow(first.model, 0))
  return {
    priority: 'background',
    size: async inFlight => {
      // A failed read keeps the last window; it never stops the run.
      const read = await readFleetCapacity(apiKey, 'music', modelId).catch(() => null)
      if (read?.supported && read.model) last = backgroundWindow(read.model, inFlight)
      return Math.max(1, last)
    },
  }
}

/**
 * Run `fn` over `items`, keeping `sizeNow(inFlight)` in flight. The window is re-read whenever a
 * request finishes, and at least every `recheckMs` so Macs that free up are used without waiting
 * for one of ours to finish. Stops starting new items as soon as `stopped()` is true; always waits
 * for the ones in flight. `fn` handles a per-item failure itself; a throw is fatal and stops the
 * run (rethrown after the in-flight items end).
 */
export async function runRollingWindow<T>(
  items: readonly T[],
  sizeNow: (inFlight: number) => Promise<number>,
  fn: (item: T, index: number) => Promise<void>,
  stopped: () => boolean,
  recheckMs = 30_000,
): Promise<void> {
  const running = new Set<Promise<void>>()
  let next = 0
  let fatal: unknown = null
  let size = 1
  while (next < items.length && !stopped() && !fatal) {
    size = Math.max(1, await sizeNow(running.size).catch(() => size))
    while (running.size < size && next < items.length && !stopped() && !fatal) {
      const index = next++
      const run: Promise<void> = fn(items[index]!, index)
        .catch(error => { fatal ??= error })
        .finally(() => { running.delete(run) })
      running.add(run)
    }
    if (next >= items.length || stopped() || fatal) break
    let timer: NodeJS.Timeout | undefined
    await Promise.race([...running, new Promise<void>(resolve => { timer = setTimeout(resolve, recheckMs) })])
    clearTimeout(timer)
  }
  await Promise.all(running)
  if (fatal) throw fatal
}
