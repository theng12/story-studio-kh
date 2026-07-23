/**
 * Shared Topic Pack catalog.
 *
 * Topic Packs are the second layer beneath a Series Formula. They provide
 * reusable subject inventories and coverage axes without duplicating the
 * formula's hook, title rules, or script structure.
 */

import { computed, onMounted, ref } from 'vue'
import { useApi } from './useApi.js'
import type { TopicPack } from './useNiches.js'

const topicPacks = ref<TopicPack[]>([])
const isLoading = ref(false)
const isReady = ref(false)
const error = ref<unknown>(null)
let inflight: Promise<void> | null = null

async function fetchOnce(): Promise<void> {
  if (inflight) return inflight
  isLoading.value = true
  inflight = (async () => {
    try {
      const { get } = useApi()
      const response = await get<{ topic_packs: TopicPack[] }>('/topic-packs')
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
  onMounted(() => { void fetchOnce() })

  async function refresh(): Promise<void> {
    inflight = null
    await fetchOnce()
  }

  function compatibleWith(seriesFormulaId: string): TopicPack[] {
    if (!seriesFormulaId) return []
    return topicPacks.value.filter(pack =>
      !pack.compatibleNicheIds.length || pack.compatibleNicheIds.includes(seriesFormulaId))
  }

  return {
    topicPacks: computed(() => topicPacks.value),
    isLoading: computed(() => isLoading.value),
    isReady: computed(() => isReady.value),
    error: computed(() => error.value),
    refresh,
    compatibleWith,
  }
}
