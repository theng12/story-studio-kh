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
