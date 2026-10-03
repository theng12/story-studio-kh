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
