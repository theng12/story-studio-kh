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

/** True when a recorded provider task carries the "no such task" marker. */
export function isNeverCreatedProviderTask(entry: { state?: unknown }): boolean {
  return entry.state === GENSTUDIO_TASK_NOT_CREATED_STATE
}
