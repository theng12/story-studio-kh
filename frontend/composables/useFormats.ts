/**
 * Format library composable — fetches the available Format profiles from
 * the backend (built-in + user-custom merged) and the per-project
 * "effective format" (base + project overrides applied).
 *
 * The format list is small (built-ins + however many user-custom)
 * and rarely changes during a session, so we cache it module-level for the
 * whole process. `refresh()` forces a refetch when the user creates / edits
 * a custom format.
 */

import { ref, computed, onMounted, watch, type Ref } from 'vue'
import { useApi } from './useApi.js'

export interface NarratorStyle {
  id: string
  label: string
  description: string
}

export interface FormulaMotionProfile {
  id: string
  label: string
  description: string
  opening_duration_sec: number
  opening: { still: number; gentle: number; limited: number }
  settled: { still: number; gentle: number; limited: number }
}

export interface Format {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  /** v1.0.280+ — presentation mechanism. Drives the "how it's built" line. */
  visualSource?: 'timestamp-driven' | 'continuity-chain' | 'narrated-scenes'
  /** v1.0.280+ — scene→script pairing for the unified scenes format. */
  sceneAlignment?: 'chapter' | 'sentence'
  idea: {
    systemPromptRole: string
    audienceDefault: string
    moodVocabulary: string[]
    themeVocabulary: string[]
    guidanceText: string
    exampleIdeas?: Array<{
      title: string
      logline: string
      themes: string[]
      suggested_chapters: number
      suggested_length: string
      mood: string
    }>
  }
  script: {
    systemPromptRole: string
    additionalRules: string[]
    pacingArc: string[]
    closingHint: string
    defaultChapterCount: number
    chapterCountRange: [number, number]
    defaultLengthMinutes: number
    lengthMinutesRange: [number, number]
    durationPresets?: number[]
    defaultWordsPerMinute?: number
    visualPacingProfile?: {
      opening_duration_sec: number
      opening: { min_sec: number; max_sec: number }
      settled: { min_sec: number; max_sec: number }
    }
    /** Formula-owned scene-role motion balance. It is stable with the saved
     * scene plan, so operators do not have to reselect it per episode. */
    motionProfile?: FormulaMotionProfile
    narratorStyles: NarratorStyle[]
    defaultNarratorStyleId: string
    /** v1.0.71+: chapters expand in parallel (listicle) vs sequentially. */
    chaptersIndependent?: boolean
    /** v1.0.82+: user-facing label for the format's primary content unit.
     *  Sleep-story → Chapter, reasons-explainer → Reason, listicle → Topic.
     *  Missing on older formats — UI consumers default to "Chapter". */
    sectionLabel?: {
      singular: string
      plural: string
    }
  }
  imagePrompts: {
    purposeNote: string
    visualStyleHint: string
    defaultScenesTotalRange: [number, number]
    defaultThumbnails: number
    defaultStyleTag: string
    characterReferenceMode: 'inline' | 'reference-image' | 'both'
    recommendedAspect: '16:9' | '9:16' | '1:1'
    alignment?: 'chapter' | 'sentence'
  }
  metadata: {
    purposeNote: string
    titleStyleHint: string
    titleHookRules: string[]
    tagsContext: string
    tagsHookRules: string[]
    broadKeywords: string[]
    youtubeDescriptionStructure: {
      musicLabel: string
      booksSectionLabel: string
      supportSection: string
      aiDisclosure: string
      defaultHashtags: string[]
      totalHashtagCount: number
    }
  }
  productionStandardsAddendum?: string
}

/** Normalize saved format ids before a picker mounts. */
export function canonicalFormatId(id?: string | null): string {
  void id
  return 'continuity-chain'
}

// ── Module-level shared cache ───────────────────────────────────────────────
// Format list is cheap, immutable for built-ins, low cardinality. One fetch
// per page load is enough; SWR isn't worth the complexity here.

const formats = ref<Format[]>([])
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
      formats.value = await get<Format[]>('/formats')
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

export function useFormats() {
  const { get } = useApi()

  onMounted(() => { void fetchOnce() })

  /** Force-refetch (e.g. after creating a custom format). */
  async function refresh(): Promise<void> {
    inflight = null
    await fetchOnce()
  }

  /** Lookup a format by id from the cached list. Synchronous after first load. */
  function find(id: string): Format | undefined {
    return formats.value.find(f => f.id === id)
  }

  /** Fetch the effective format for one project (base + that project's overrides). */
  async function fetchEffective(slug: string): Promise<Format> {
    return await get<Format>(`/projects/${slug}/effective-format`)
  }

  return {
    formats: computed(() => formats.value),
    isLoading: computed(() => isLoading.value),
    isReady: computed(() => isReady.value),
    error: computed(() => error.value),
    refresh,
    find,
    fetchEffective,
  }
}
