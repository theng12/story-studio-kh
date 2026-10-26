/**
 * The app-wide default model per generation family (Settings → This Mac → Default models).
 *
 * This is the fetch-and-hold half; the decision itself lives in `utils/live-genstudio-model-selection.ts`
 * so a picker can reach it without pulling this module in. Together they are the LAST link of the one
 * precedence chain, read at USE time only:
 *
 *   the preset's saved model → the page's remembered last choice → this default
 *
 * Nothing here writes the setting, and nothing writes the resolved id into a preset, a channel config
 * or a remembered form. The server checks the same setting against the live catalogue before a job
 * runs, so a default that has left the catalogue fails loudly there too.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useApi } from './useApi.js'
import {
  emptyDefaultModels,
  normalizeDefaultModels,
  resolveEffectiveModel,
  type DefaultModelFamily,
  type DefaultModels,
  type EffectiveModel,
} from '../utils/live-genstudio-model-selection.js'

const state = ref<DefaultModels>(emptyDefaultModels())
let loaded = false
let inflight: Promise<void> | null = null

async function load(force = false): Promise<void> {
  if (inflight) return inflight
  if (loaded && !force) return
  const { get } = useApi()
  inflight = (async () => {
    try {
      applyDefaults(await get<Partial<DefaultModels>>('/app-settings/default-models', { cache: 'no-store' }))
    } catch {
      // An unreadable setting means "no default", the same answer as "unset" — the page then asks
      // for a choice as usual. It never invents a model.
      state.value = emptyDefaultModels()
    } finally {
      loaded = true
      inflight = null
    }
  })()
  return inflight
}

/** Fold one settings response into the shared state. Exported so a test can seed it without a fetch. */
export function applyDefaults(response: unknown): void {
  state.value = normalizeDefaultModels(response)
  loaded = true
}

export function invalidateDefaultModels(): void {
  loaded = false
}

/** The saved default for one family, or '' when this Mac has none. */
export function useDefaultModels() {
  void load()
  return {
    models: state,
    refresh: (force = true) => load(force),
  }
}

/**
 * The defaults as they stand right now, WITHOUT triggering a read.
 *
 * For a caller that must decide synchronously (removing a defaulted value from a remembered form)
 * and must not start a fetch of its own.
 */
export function peekDefaultModels(): Readonly<Ref<DefaultModels>> {
  return state
}

/**
 * Resolve the model one page submits.
 *
 * `selected` is the page's own value (its preset's, or the one `useRememberedForm` restored).
 * `liveIds` is that family's live catalogue — an empty list means "not loaded yet", and then the
 * default is used without claiming anything about its availability.
 */
export function useEffectiveModel(
  family: DefaultModelFamily,
  selected: Ref<string> | ComputedRef<string>,
  liveIds?: Ref<string[]> | ComputedRef<string[]>,
): {
  model: ComputedRef<string>
  defaultModel: ComputedRef<string>
  goneNotice: ComputedRef<string>
} {
  const { models } = useDefaultModels()
  const resolved = computed(() => resolveEffectiveModel(family, selected.value, liveIds?.value ?? [], models.value))
  return {
    model: computed(() => resolved.value.model),
    defaultModel: computed(() => resolved.value.defaultModel),
    goneNotice: computed(() => resolved.value.goneNotice),
  }
}
