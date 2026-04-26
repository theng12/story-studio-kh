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

  // ── User-custom CRUD ────────────────────────────────────────────────
  // Mirrors useFormats's CRUD shape so the components feel parallel.
  // Each call invalidates the module-level cache so the next read sees
  // the new state immediately (no stale list right after Save).

  /**
   * Save a new pattern (POST /patterns/custom). Throws on conflict
   * (409) so the caller can offer overwrite-vs-rename. Pass
   * `overwrite: true` to skip the conflict check.
   */
  async function save(
    pattern: Pattern,
    opts: { overwrite?: boolean } = {},
  ): Promise<Pattern> {
    const { post } = useApi()
    const r = await post<{ pattern: Pattern }>('/patterns/custom', {
      pattern,
      overwrite: !!opts.overwrite,
    })
    await refresh()
    return r.pattern
  }

  /**
   * Update an existing user-custom pattern (PUT /patterns/custom/:id).
   * The id from the pattern argument is ignored — the URL id wins so
   * the editor can't accidentally rename via PUT.
   */
  async function update(id: string, pattern: Pattern): Promise<Pattern> {
    const { patch } = useApi()
    const r = await patch<{ pattern: Pattern }>(`/patterns/custom/${id}`, { pattern })
    await refresh()
    return r.pattern
  }

  /**
   * Delete a user-custom pattern. Built-in ids return 400; the caller
   * should disable the Delete button on built-in cards rather than
   * relying on the error.
   */
  async function remove(id: string): Promise<void> {
    const { del } = useApi()
    await del(`/patterns/custom/${id}`)
    await refresh()
  }

  /**
   * LLM-driven extraction from sample scripts. Returns the extracted
   * pattern WITHOUT saving it — the wizard's review step lets the user
   * tweak before calling save(). Project-scoped because extraction
   * uses the project's API keys.
   */
  async function extract(
    projectSlug: string,
    body: { samples: string[]; model: string; desired_name?: string; intent?: string },
  ): Promise<Pattern> {
    const { post } = useApi()
    const r = await post<{ pattern: Pattern }>(`/projects/${projectSlug}/patterns/from-sample`, body)
    return r.pattern
  }

  return {
    patterns: computed(() => patterns.value),
    isLoading: computed(() => isLoading.value),
    isReady: computed(() => isReady.value),
    error: computed(() => error.value),
    refresh,
    find,
    compatibleWith,
    save,
    update,
    remove,
    extract,
  }
}
