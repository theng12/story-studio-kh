/**
 * The vocabulary for "GenStudio has no such task", kept in a leaf module with
 * no imports of its own.
 *
 * It lives here rather than in `genstudio-client.ts` for one concrete reason:
 * `job-control.ts` needs the constant at MODULE-INITIALISATION time, to build
 * its terminal-state set. `genstudio-client.ts` sits in an import cycle with
 * the job services, so reading a `const` from it during module evaluation
 * throws `Cannot access '…' before initialization` — a real failure that took
 * out sixty test files the first time this was written the obvious way.
 *
 * `genstudio-client.ts` re-exports both symbols, so callers that already
 * import provider vocabulary from there keep working unchanged.
 */

/**
 * Story Studio's own record that GenStudio answered a control-plane lookup and
 * said it does not have this task.
 *
 * It is NOT a GenStudio state — GenStudio publishes nothing about a task it
 * never created, which is exactly the point. Recording it as `failed` would be
 * Story Studio asserting the provider failed work the provider never had, and
 * v1.2.6 exists because of precisely that class of unearned claim.
 *
 * It is terminal: a task that does not exist cannot later start, finish, bill,
 * or be cancelled.
 */
export const GENSTUDIO_TASK_NOT_CREATED_STATE = 'not_created'

/**
 * The exact GenStudio JobState values that still represent accepted provider
 * work. Unknown values deliberately do not join this set: admitting image
 * overflow on a newly invented state would turn provider drift into paid work.
 */
export type ActiveGenStudioProviderState =
  | 'accepted' | 'reserved' | 'dispatched' | 'running' | 'reconciling' | 'validating'

export const ACTIVE_GENSTUDIO_PROVIDER_STATES: ReadonlySet<ActiveGenStudioProviderState> = new Set([
  'accepted', 'reserved', 'dispatched', 'running', 'reconciling', 'validating',
])

export function isActiveGenStudioProviderState(value: unknown): value is ActiveGenStudioProviderState {
  return typeof value === 'string' && ACTIVE_GENSTUDIO_PROVIDER_STATES.has(value as ActiveGenStudioProviderState)
}

/** True when a recorded provider task carries the "no such task" marker. */
export function isNeverCreatedProviderTask(entry: { state?: unknown }): boolean {
  return entry.state === GENSTUDIO_TASK_NOT_CREATED_STATE
}

/**
 * Every provider state from which no further outcome can arrive.
 *
 * v1.4.81 — THERE WERE TWO OF THESE, and they disagreed by one word.
 *
 * `job-control.ts` decided whether to offer "Remove from history" using a set
 * that contained `cancelled`. `job-queue.ts` decided whether `clearFinished`
 * would actually remove the row using a predicate that did not: it accepted the
 * `cancelled` BOOLEAN but not the `cancelled` STATE. So a task recorded as
 * `state: 'cancelled'` without that boolean read as terminal to the button and
 * as still-settling to the thing behind the button.
 *
 * The owner met this on 2026-08-29: six Scene Review jobs abandoned when the
 * queue drained, a header reading "Clear finished (6)", and clicking it
 * removing nothing, repeatedly, while the badge kept promising six. The badge
 * was not wrong and the clear was not broken — they were reading two different
 * definitions of the same word.
 *
 * One definition now, in the leaf module both sides already import. A cancelled
 * provider task is settled: it will not run again, produce more output, or
 * incur further charges.
 */
const SETTLED_PROVIDER_STATES: ReadonlySet<string> = new Set([
  'succeeded', 'failed', 'cancelled', GENSTUDIO_TASK_NOT_CREATED_STATE,
])

/** True when this recorded provider task can no longer change. */
export function isSettledProviderEntry(entry: { state?: unknown; cancelled?: boolean | null }): boolean {
  return entry.cancelled === true || SETTLED_PROVIDER_STATES.has(String(entry.state))
}

/** True when this recorded provider task's outcome can still change. */
export function isUnsettledProviderEntry(entry: { state?: unknown; cancelled?: boolean | null }): boolean {
  return !isSettledProviderEntry(entry)
}
