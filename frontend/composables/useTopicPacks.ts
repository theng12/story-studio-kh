/**
 * Shared Topic Pack catalog.
 *
 * Topic Packs are the second layer beneath a Series Formula. They provide
 * reusable subject inventories and coverage axes without duplicating the
 * formula's hook, title rules, or script structure.
 *
 * Owner ruling, 2026-10-29: the list is installed pack items only. A channel's
 * SAVED `topic_pack_ids` are read back against it by `ensureListed`, so an id
 * that resolves to a pack shows as that pack item and one no pack publishes is
 * shown with its own name — never dropped, never rewritten.
 */

import { computed, onMounted, ref } from 'vue'
import { useApi } from './useApi.js'
import { resolveSavedSelection } from './pack-selection.js'
import type { TopicPack } from './useNiches.js'

const topicPacks = ref<TopicPack[]>([])
const isLoading = ref(false)
const isReady = ref(false)
const error = ref<unknown>(null)
let inflight: Promise<void> | null = null
/** Saved ids that now read as a listed pack item. */
const resolvedIds = ref<Record<string, string>>({})

async function fetchOnce(force = false): Promise<void> {
  if (inflight) return inflight
  // Loaded once per session (was re-fetched, 8 MB, on every mount); `refresh()` re-reads.
  if (isReady.value && !force) return
  isLoading.value = true
  inflight = (async () => {
    try {
      const { get } = useApi()
      const response = await get<{ topic_packs: TopicPack[] }>('/topic-packs?view=list')
      topicPacks.value = response.topic_packs || []
      isReady.value = true
      error.value = null
    } catch (cause) {
      error.value = cause
    } finally {
      isLoading.value = false
      inflight = null
    }
  })()
  return inflight
}

export function useTopicPacks() {
  const { get } = useApi()
  onMounted(() => { void fetchOnce() })

  async function refresh(): Promise<void> {
    inflight = null
    await fetchOnce(true)
  }

  function compatibleWith(seriesFormulaId: string): TopicPack[] {
    if (!seriesFormulaId) return []
    return topicPacks.value.filter(pack =>
      ![...(pack.compatibleNicheIds || []), ...(pack.compatibleFormulaIds || [])].length
      || [...(pack.compatibleNicheIds || []), ...(pack.compatibleFormulaIds || [])].includes(seriesFormulaId))
  }

  /** The pack id a saved id reads as, or the saved id itself. */
  function selectionId(id: string): string {
    return resolvedIds.value[id] || id
  }

  function find(id: string): TopicPack | undefined {
    const resolved = selectionId(id)
    return topicPacks.value.find(pack => pack.id === resolved)
  }

  /**
   * Read a channel's SAVED Topic Pack ids against the pack list: map the ones a
   * pack serves, and add the rest with their real name and `not_in_pack` so the
   * picker can show them instead of silently losing the selection.
   */
  async function ensureListed(ids: readonly (string | null | undefined)[]): Promise<void> {
    const { add, alias } = await resolveSavedSelection<TopicPack>(
      ids,
      id => topicPacks.value.some(pack => pack.id === id),
      async id => (await get<TopicPack>(`/topic-packs/${encodeURIComponent(id)}`)) || null,
    )
    if (Object.keys(alias).length) resolvedIds.value = { ...resolvedIds.value, ...alias }
    if (add.length) topicPacks.value = [...topicPacks.value, ...add]
  }

  return {
    topicPacks: computed(() => topicPacks.value),
    isLoading: computed(() => isLoading.value),
    isReady: computed(() => isReady.value),
    error: computed(() => error.value),
    refresh,
    compatibleWith,
    find,
    selectionId,
    ensureListed,
  }
}
