/**
 * Small, dependency-free provider-task vocabulary shared by server recovery
 * and renderer status views. A provider's definitive `not_created` answer
 * wins over an older Story queue hint that happened to say `running`.
 */
export const GENSTUDIO_TASK_NOT_CREATED_STATE = 'not_created'

export type GenStudioTaskStateLike = {
  state?: unknown
  queue_state?: unknown
}

function stateText(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** The provider's no-record result is terminal even if an old queue state conflicts. */
export function effectiveGenStudioTaskState(entry: GenStudioTaskStateLike): string {
  const providerState = stateText(entry.state)
  if (providerState === GENSTUDIO_TASK_NOT_CREATED_STATE) return providerState
  return stateText(entry.queue_state) || providerState
}

export function isNeverCreatedProviderTask(entry: Pick<GenStudioTaskStateLike, 'state'>): boolean {
  return stateText(entry.state) === GENSTUDIO_TASK_NOT_CREATED_STATE
}

/** Preserve the established reconciliation labels while adding no-record evidence. */
export function reconciledGenStudioQueueState(providerState: unknown) {
  const state = stateText(providerState)
  if (state === 'succeeded' || state === 'failed' || state === GENSTUDIO_TASK_NOT_CREATED_STATE) return state
  if (state === 'accepted' || state === 'reserved') return 'accepted'
  if (state === 'validating' || state === 'reconciling') return 'completing'
  return 'running'
}

/**
 * Work on the owner's own Studio Hub fleet. The Gateway publishes every fleet model under the
 * `studio-hub::` namespace (`catalog_encode` → `fleet.publish_id`), on the catalogue and on every job
 * envelope's `model_id`, and that work costs nothing. Free work is never described in credits, and a
 * Mac that is busy, offline or slow to answer is a wait, not a failure (owner, 2026-10-03).
 * Display and wait policy only — never a routing choice.
 */
export function isFreeFleetModelId(modelId: unknown): boolean {
  return typeof modelId === 'string' && /^studio-hub(?:-[\w-]+)?::/.test(modelId)
}

/** Every remote request of a job ran on the owner's fleet (and there was at least one). */
export function isFreeFleetWork(remotes: ReadonlyArray<{ model_id?: unknown }> | null | undefined): boolean {
  return !!remotes?.length && remotes.every(remote => isFreeFleetModelId(remote.model_id))
}

/** The one wording for an item that is waiting because no Mac could take it yet. */
export const FREE_MAC_WAIT_REASON = 'Waiting for a free Mac'

/**
 * A `failed` task the Gateway still holds as an unknown outcome: its result may yet be adopted as
 * `succeeded` without running anything twice (Dreamlands 571ec142, 2026-10-15). Not finished, not a
 * failure to retry or replace.
 */
export function holdsUnknownProviderOutcome(entry: { state?: unknown; recovery_required?: unknown; recovery_state?: unknown }): boolean {
  return entry.state === 'failed' && (entry.recovery_required === true || entry.recovery_state === 'unknown_outcome')
}

/** A Music Library song of this job is held that way. */
export function holdsUnknownMusicResult(
  remotes: ReadonlyArray<{ operation?: unknown; state?: unknown; recovery_required?: unknown; recovery_state?: unknown }> | null | undefined,
): boolean {
  return (remotes || []).some(remote => remote.operation === 'music.generation' && holdsUnknownProviderOutcome(remote))
}

/** The ONE line the Jobs control and the job card show for a finished song not in the library yet. */
export const MUSIC_RESULT_AWAITING_IMPORT_GUIDANCE = 'A song from this job finished at the Gateway but is not in the library yet; nothing was run twice. '
  + 'Open Music Library and use "Recover existing result" to import it without a new generation. This history is kept until then.'

/** The ONE line the Jobs control and the job card show for a held song. */
export const HELD_MUSIC_RESULT_GUIDANCE = 'The Gateway is still checking a song from this job; nothing was run twice. '
  + 'Do not retry or replace it: open Music Library and use "Recover existing result" to import it without a new generation.'
