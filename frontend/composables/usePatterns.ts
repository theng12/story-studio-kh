/**
 * Pattern library composable — fetches the available Pattern profiles
 * (built-in + user-custom merged) from the backend.
 *
 * Mirrors useFormats: small list, low cardinality, module-level cached.
 */

import { ref, computed, onMounted } from 'vue'
import { useApi } from './useApi.js'

export interface Pattern {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  titleTemplate: string
  subjectLabel: string
  pov: 'first' | 'second' | 'third' | 'mixed'
  openingDevice: string
  bodyStructure?: string[]
  closingDevice: string
  suggestedLengthMinutes?: [number, number]
  preferredFormats?: string[]
  metadataKeywordAdditions?: string[]
}

const patterns = ref<Pattern[]>([])
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
      patterns.value = await get<Pattern[]>('/patterns')
      isReady.value = true
      error.value = null
    } catch (e) {
      error.value = e
    } finally {
      isLoading.value = false
      inflight = null
    }
  })()
  return inflight
}

export function usePatterns() {
  onMounted(() => { void fetchOnce() })

  async function refresh(): Promise<void> {
    inflight = null
    await fetchOnce()
  }

  function find(id: string): Pattern | undefined {
    return patterns.value.find(p => p.id === id)
  }

  /** Patterns whose preferredFormats includes the given format id (or have no preference). */
  function compatibleWith(formatId: string): Pattern[] {
    return patterns.value.filter(p =>
      !p.preferredFormats?.length || p.preferredFormats.includes(formatId),
    )
  }

  return {
    patterns: computed(() => patterns.value),
    isLoading: computed(() => isLoading.value),
    isReady: computed(() => isReady.value),
    error: computed(() => error.value),
    refresh,
    find,
    compatibleWith,
  }
}
