/**
 * Niche library composable — fetches the available Niche profiles from the
 * backend (built-in + user-custom merged) and the per-project "effective
 * niche" (base + project overrides applied).
 *
 * Mirrors useFormats but for the subject-domain layer. The list is small
 * (4 built-in + however many user-custom) and rarely changes during a
 * session, so we cache it module-level.
 */

import { ref, computed, onMounted, type Ref } from 'vue'
import { useApi } from './useApi.js'

export interface NicheReferenceImage {
  id: string
  label: string
  path: string
  role: 'master' | 'character' | 'scene'
  description?: string
}

export interface NicheVocabulary {
  mood?: string[]
  theme?: string[]
  genre?: string[]
  keyword?: string[]
}

export interface NicheThumbnailProfile {
  layout?: 'hero' | 'annotated-collage'
  conceptGuidance?: string
  compositionRules?: string[]
  moodKeywords?: string[]
  avoid?: string[]
  defaultTextStyle?: string
  defaultFontStyle?: string
}

export interface IdeaAxis {
  id: string
  label: string
  values: string[]
}

export interface FormulaEpisodeProfile {
  id: string
  label: string
  description: string
  ideaAxisValue: string
  titleSuffix?: string
  forbiddenTitleSuffixes?: string[]
  narratorStyleId?: string
  titlePolicy?: string
  thumbnailPolicy?: string
  metadataPolicy?: string
}

export interface FormulaProductionKit {
  id: string
  label: string
  description: string
  episodeProfiles?: FormulaEpisodeProfile[]
}

export interface Niche {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  kind?: 'series-formula'
  formulaFamily?: string
  catalogStatus?: 'active' | 'legacy'
  successorFormulaId?: string
  catalogName?: string
  perspectivePolicy?: string
  narrativeQualityContract?: {
    openingPolicy: string
    forbiddenPatterns: string[]
    requiredHabits: string[]
    closingPolicy?: string
  }
  openingProfile?: {
    id: string
    label: string
    description: string
  }
  metadataProfile?: {
    id: string
    label: string
    description: string
    descriptionSectionIds: string[]
    titleMode: 'use_idea_title' | 'paraphrase'
    descriptionMaxChars: number
    titleMaxLength: number
    tagCount: number
  }
  productionKit?: FormulaProductionKit
  tagline?: string
  exampleTopics: string[]
  defaultTopicPackIds?: string[]
  compatibleTopicPackIds?: string[]
  ideaAxes?: IdeaAxis[]
  vocabulary?: NicheVocabulary
  visualStyleSheet?: string
  thumbnailStyleSheet?: string
  /** Styles this channel type suggests, best first. A suggestion only — the
   *  customer applies it, or does not. */
  recommendedVisualStyleIds?: string[]
  thumbnailProfile?: NicheThumbnailProfile
  defaultStyleKeywords?: string[]
  referenceImages?: NicheReferenceImage[]
  youtubeTagsHint?: string[]
  audienceHint?: string
  scriptContext?: string
  /** v1.0.280+ — content-ownership fields. After the format↔niche split, the
   *  niche owns the voice; these let the picker show what it controls. */
  scriptSystemPromptRole?: string
  titleShapeRules?: string[]
  narratorStyles?: Array<{ id: string; label: string; description?: string }>
  /** How this Formula's YouTube titles should be pitched. Absent means the
   *  Format's own wording applies. */
  metadataTitleStyleHint?: string
  activeTopicPacks?: TopicPack[]
  defaultThumbnailTemplateId?: string
  scriptStructure?: {
    defaultChapterCount?: number
    chapterCountRange?: [number, number]
    defaultLengthMinutes?: number
    lengthMinutesRange?: [number, number]
    durationPresets?: number[]
    defaultWordsPerMinute?: number
    /** True when a chapter is its own subject rather than part of one story —
     *  the generator switches between listicle and narrative mode on it. */
    chaptersIndependent?: boolean
    visualPacingProfile?: {
      opening_duration_sec: number
      opening: { min_sec: number; max_sec: number }
      settled: { min_sec: number; max_sec: number }
    }
    motionProfile?: {
      id: string
      label: string
      description: string
      opening_duration_sec: number
      opening: { still: number; gentle: number; limited: number }
      settled: { still: number; gentle: number; limited: number }
    }
  }
  /** Server-attached count of projects referencing this niche. Present on
   *  list responses, absent on single-niche reads. */
  project_count?: number
}

export interface TopicPack {
  id: string
  name: string
  description: string
  builtin: boolean
  schemaVersion: 1
  compatibleNicheIds: string[]
  compatibleFormulaIds?: string[]
  subjects: string[]
  ideaAxes?: IdeaAxis[]
  vocabulary?: NicheVocabulary
  tags?: string[]
}

// ── Module-level shared cache ───────────────────────────────────────────────

const niches = ref<Niche[]>([])
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
      const resp = await get<{ niches: Niche[] }>('/niches')
      niches.value = resp.niches || []
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

export function useNiches() {
  const { get, post, put, del } = useApi()

  onMounted(() => { void fetchOnce() })

  /** Force-refetch (e.g. after creating / deleting a custom niche). */
  async function refresh(): Promise<void> {
    inflight = null
    await fetchOnce()
  }

  /** Synchronous lookup from the cached list. */
  function find(id: string): Niche | undefined {
    return niches.value.find(n => n.id === id)
  }

  /** Fetch the effective niche for one project. Returns `null` field if the
   *  project has no niche assigned — distinguished from a 404 (project missing). */
  async function fetchEffective(slug: string): Promise<Niche | null> {
    const resp = await get<{ niche: Niche | null }>(`/projects/${slug}/effective-niche`)
    return resp.niche
  }

  /** Set or clear a project's Series Formula and its explicit Topic Packs. */
  async function setProjectNiche(
    slug: string,
    niche_id: string | null,
    topic_pack_ids?: string[],
  ): Promise<void> {
    await put(`/projects/${slug}/niche`, { niche_id, topic_pack_ids })
  }

  /** Create a brand-new user-custom niche. */
  async function createNiche(body: Niche): Promise<Niche> {
    const created = await post<Niche>('/niches', body)
    await refresh()
    return created
  }

  /** Full-document replace. Also accepts overriding a built-in by passing
   *  the built-in's id — server writes a shadow file to the user dir. */
  async function updateNiche(body: Niche): Promise<Niche> {
    const updated = await put<Niche>(`/niches/${body.id}`, body)
    await refresh()
    return updated
  }

  /** Delete a user-custom niche. Server refuses if it's built-in or in use. */
  async function deleteNiche(id: string): Promise<void> {
    await del(`/niches/${id}`)
    await refresh()
  }

  return {
    niches: computed(() => niches.value),
    isLoading: computed(() => isLoading.value),
    isReady: computed(() => isReady.value),
    error: computed(() => error.value),
    refresh,
    find,
    fetchEffective,
    setProjectNiche,
    createNiche,
    updateNiche,
    deleteNiche,
  }
}
