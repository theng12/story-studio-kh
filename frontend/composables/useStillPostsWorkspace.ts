/**
 * The Still Posts workspace, shared by the five steps of the page (owner, 2026-10-30).
 *
 * One instance is made by the page and provided to every step, so the channel cast, the preset draft,
 * the batch and the posts are one state, not five copies. Every rule that decides what is "done" is on
 * the server (AGENTS §8); this file only reads it, and the step states come from `still-posts-flow`.
 */
import { computed, inject, onUnmounted, provide, reactive, ref, watch, type ComputedRef, type InjectionKey } from 'vue'
import { useApi } from './useApi'
import { useJobs } from './useJobs'
import { useConfirm } from './useConfirm'
import type { Job } from './useJobs'
import { describeImageBatchEstimate, type PricedImageModel } from '../utils/genstudio-credit-cost'
import { emptyDefaultModels, normalizeDefaultModels } from '../utils/live-genstudio-model-selection'
import {
  emptyFontPool,
  normaliseFontPools,
  percentagesFor,
  STILL_POST_FONT_USAGE_LABELS,
  STILL_POST_FONT_USAGE_MODES,
  type StillPostFontPool,
  type StillPostFontPools,
} from '@shared/still-post-fonts'
import { STILL_POST_LANGUAGE_SCRIPT } from '@shared/still-posts'
import {
  landingTab,
  stillPostStepStates,
  type StillPostFlowFacts,
  type StillPostStepStatus,
  type StillPostTab,
} from '../utils/still-posts-flow'

export const STILL_POST_ASPECTS = ['1:1', '9:16', '16:9'] as const
export const STILL_POST_ANCHORS = ['bottom', 'bottom-left', 'bottom-right', 'top', 'top-left', 'top-right', 'center']
export const STILL_POST_LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'km', label: 'Khmer' },
  { id: 'zh', label: 'Mandarin (Simplified Chinese)' },
] as const

export interface StillPostBranding {
  handle_enabled: boolean
  handle_text: string | null
  logo_enabled: boolean
  position: string
  handle_size_px: number
  logo_width_pct: number
  margin_pct: number
  opacity: number
}

export interface StillPostPresetData {
  writing_model: string | null
  image_model: string | null
  format_id: string
  option_id: string
  language: 'en' | 'km' | 'zh'
  aspects: string[]
  /** Draw a separate picture per ticked frame. A reusable choice, so the preset carries it (§5). */
  fresh_drawing_per_size: boolean
  /** The channel's lettering font pool per writing system. Empty = the format's own face. */
  font_pools: StillPostFontPools
  text_scale: number
  branding: StillPostBranding
}

export interface StillPostPanelState {
  panel_id: string
  image: string
  images?: Record<string, string>
  finals: Record<string, string>
  problems: string[]
}
export interface StillPostState { id: string, complete: boolean, panels: StillPostPanelState[], problems: string[] }

export interface StillPost {
  id: string
  batch_id: string
  format_id: string
  option_id: string
  language: 'en' | 'km' | 'zh'
  character_ids: string[]
  caption: string
  panels: Array<{ id: string, role: string, text: string, scene_prompt: string, image?: { filename: string } | null }>
  finals: Array<{ aspect: string, panel_id: string, filename: string, text: string }>
  aspects: string[]
  /** Absent = a single drawing fitted to every size (the original behaviour). */
  art_mode?: 'single' | 'per-size'
  /** When a reviewer approved the exact words and pictures on this post. Absent = not approved. */
  approved_at?: string | null
  /** The drawings a redo replaced, kept in the channel's Trash. Newest last. */
  redraws?: Array<{ at: string, panel_id: string, aspect: string | null, trash_path: string }>
  updated_at: string
}

export interface StillPostsWorkspaceData {
  config: { character_ids: string[], logo_path: string | null, handle: string | null, logo_ready: boolean }
  characters: Array<{ id: string, name: string, description: string, has_reference: boolean, reference_count: number, portrait_url: string | null }>
  formats: Array<{ id: string, name: string, description: string, lettering: { fonts: Record<string, string> } }>
  /** The layout catalogue: the boxes the sample draws are the boxes the renderer uses. */
  options: Array<{
    id: string
    name: string
    description: string
    panels: 1 | 2
    text: Array<{ anchor: string, x_pct: number, y_pct: number, width_pct: number, height_pct: number, align: 'left' | 'center' | 'right', max_lines: number }>
    text_background: boolean
  }>
  /** The bundled font catalogue, read live from the manifest — only these faces can be chosen. */
  fonts: Array<{ id: string, label: string, scripts: string[], role?: string }>
  presets: Array<{ id: string, name: string, builtin: boolean, data: StillPostPresetData }>
  last_preset_id: string | null
  posts: StillPost[]
  batches: Array<{ batch_id: string, aspects: string[], total: number, complete_count: number, complete: boolean, posts: StillPostState[], missing: string[] }>
  /** Receipts and the last refusal per platform, keyed by post id. */
  publishes?: Record<string, PublishRecord>
}
export interface PublishReceipt { post_id: string, permalink?: string, file: string, file_sha256: string, posted_at: string }
export interface PublishRecord {
  facebook?: PublishReceipt
  instagram?: PublishReceipt
  last_failure?: Record<string, { message: string, at: string }>
}

export type ImageModelRow = PricedImageModel & {
  id: string
  display_name: string
  available?: boolean
  supports_reference_images?: boolean
  max_reference_images?: number
}


/** The script a language is drawn in. Module-level so nothing in a component initializer depends on order. */
export function scriptForLanguage(language: string): string {
  return STILL_POST_LANGUAGE_SCRIPT[language as keyof typeof STILL_POST_LANGUAGE_SCRIPT] || 'latn'
}

/**
 * The pools the page edits: every script the page's languages use has a real entry, so a pool can be
 * built from empty. Empty pools are dropped by the server and mean "the format's own face".
 */
export function poolsForEditing(value: unknown): StillPostFontPools {
  const pools = normaliseFontPools(value)
  for (const entry of STILL_POST_LANGUAGES) {
    const script = scriptForLanguage(entry.id)
    if (!pools[script]) pools[script] = emptyFontPool()
  }
  return pools
}

export function useStillPostsWorkspace(slug: ComputedRef<string>) {
  const { get, put, post, del } = useApi()
  // The dashboard layout already keeps this channel's job stream open; this only reads it.
  const { jobs } = useJobs()
  const { ask } = useConfirm()

  const workspace = ref<StillPostsWorkspaceData | null>(null)
  const loading = ref(true)
  const loadError = ref('')

  // ── Publishing (the channel's own switch; nothing posts until the owner turns a platform on) ──
  const socialPlatforms = ref<string[]>([])
  const publishes = ref<Record<string, PublishRecord>>({})
  const publishBusy = ref(false)
  const publishMessage = ref('')

  // ── The channel's cast, handle and logo ──
  const castDraft = ref<string[]>([])
  const handleDraft = ref('')
  const logoDraft = ref('')
  const savingConfig = ref(false)
  const configNote = ref('')
  const configError = ref(false)

  // ── The preset (the reusable look, layout, language, frames, fonts, placement and models) ──
  const presetId = ref('clean-handle')
  const languages = STILL_POST_LANGUAGES
  const aspects = STILL_POST_ASPECTS
  const anchors = STILL_POST_ANCHORS

  const preset = reactive<StillPostPresetData>({
    writing_model: null,
    image_model: null,
    format_id: 'night-painterly',
    option_id: 'quote-top',
    language: 'en',
    aspects: ['1:1'],
    fresh_drawing_per_size: false,
    font_pools: poolsForEditing({}),
    text_scale: 1,
    branding: {
      handle_enabled: true,
      handle_text: null,
      logo_enabled: true,
      position: 'bottom',
      handle_size_px: 30,
      logo_width_pct: 12,
      margin_pct: 4,
      opacity: 0.9,
    },
  })
  const savingPreset = ref(false)
  const presetNote = ref('')
  const presetError = ref(false)
  const presetName = ref('My still posts preset')

  // ── Models (live from the Gateway; nothing is chosen for the customer) ──
  const writingModels = ref<Array<{ id: string, label: string, available: boolean }>>([])
  const imageModels = ref<ImageModelRow[]>([])
  /** Settings → Default models for this Mac: the LAST link of the chain, read only, never written back. */
  const appDefaults = ref(emptyDefaultModels())

  /**
   * What the picking controls show. The preset's own saved model wins; with none, Settings' default
   * fills the field for display. A value that merely EQUALS the default is never written into the
   * preset (AGENTS §7), so a later change of default still reaches this channel.
   */
  const writingModelChoice = computed({
    get: () => preset.writing_model || appDefaults.value.writing || '',
    set: (value: string) => {
      if (!value) { preset.writing_model = null; return }
      if (!preset.writing_model && value === appDefaults.value.writing) return
      preset.writing_model = value
    },
  })
  const imageModelChoice = computed({
    get: () => preset.image_model || appDefaults.value.image || '',
    set: (value: string) => {
      if (!value) { preset.image_model = null; return }
      if (!preset.image_model && value === appDefaults.value.image) return
      preset.image_model = value
    },
  })

  /** A format's own sample picture, or the plain "no sample yet" the card shows when it is absent. */
  function formatSampleUrl(formatId: string): string {
    return `/still-post-formats/${encodeURIComponent(formatId)}.webp`
  }
  /** A face's sample line, drawn by the real renderer, in the post's own language. */
  function fontSampleUrl(fontId: string, language: string, scale = 1): string {
    const query = new URLSearchParams({ font_id: fontId, language, scale: String(scale) })
    return `/api/projects/${slug.value}/still-posts/font-sample?${query.toString()}`
  }

  // ── Writing and drawing ──
  const brief = ref('')
  const count = ref(6)
  const writing = ref(false)
  const writeError = ref('')
  const writeJobId = ref<string | null>(null)
  const drawing = ref(false)
  const drawError = ref('')

  // ── The post in focus, and the review board's own selection ──
  const selectedId = ref<string | null>(null)
  /**
   * Review's filter: which posts the board shows. `complete` is the honest "finished but not yet
   * approved" list — a post that is still missing a frame cannot be reviewed, so it is not offered
   * here; Draw is the step that finishes it.
   */
  const reviewFilter = ref<'needs-review' | 'approved' | 'complete' | 'failed'>('needs-review')
  /** The posts ticked for a batch Approve or Redo. Selection never outlives a change of filter. */
  const reviewSelected = ref<string[]>([])

  const draftFormat = computed(() => workspace.value?.formats.find(format => format.id === preset.format_id) || null)
  const draftOption = computed(() => workspace.value?.options.find(option => option.id === preset.option_id) || null)
  const posts = computed<StillPost[]>(() => workspace.value?.posts || [])
  const castCharacters = computed(() => (workspace.value?.characters || []).filter(character => castDraft.value.includes(character.id)))
  const canWrite = computed(() => !!workspace.value && brief.value.trim().length > 0)
  // The model actually used: the preset's, or this Mac's default when the preset names none (§7).
  const canDraw = computed(() => !!imageModelChoice.value)
  const selected = computed(() => posts.value.find(entry => entry.id === selectedId.value) || null)
  const selectedPublish = computed(() => selected.value ? publishes.value[selected.value.id] : undefined)
  const imageModelInfo = computed(() => imageModels.value.find(model => model.id === imageModelChoice.value) || null)
  const writeJob = computed(() => jobs.value.find(job => job.job_id === writeJobId.value) || null)
  const socialOn = computed(() => socialPlatforms.value.includes('facebook'))

  type JobRow = (typeof jobs.value)[number]
  /** The newest job of one type for this channel. Null when none is in the stream. */
  function latestJob(type: string): JobRow | null {
    let found: JobRow | null = null
    for (const job of jobs.value) {
      if (job.type !== type) continue
      if (!found || String(job.created_at || '') > String(found.created_at || '')) found = job
    }
    return found
  }

  function postState(id: string): StillPostState | undefined {
    for (const batch of workspace.value?.batches || []) {
      const hit = batch.posts.find(entry => entry.id === id)
      if (hit) return hit
    }
    return undefined
  }

  const completePostCount = computed(() => posts.value.filter(entry => postState(entry.id)?.complete).length)
  const approvedPostIds = computed(() => posts.value.filter(entry => !!entry.approved_at).map(entry => entry.id))
  const approvedCount = computed(() => approvedPostIds.value.length)
  const needsReviewCount = computed(() => posts.value.filter(entry => postState(entry.id)?.complete && !entry.approved_at).length)
  /** Approved posts that have really been sent, on every platform this channel has turned on. */
  const publishedCount = computed(() => {
    const platforms = socialOn.value ? ['facebook'] : []
    if (!platforms.length) return 0
    return posts.value.filter(entry => entry.approved_at
      && platforms.every(platform => !!(publishes.value[entry.id] as any)?.[platform])).length
  })

  /** The five steps, derived from the server's verification and the jobs in the stream. */
  /** One post's review verdict, from the server's verification and its recorded approval. */
  function reviewStatus(entry: StillPost): 'needs-review' | 'approved' | 'failed' | 'undrawn' {
    const state = postState(entry.id)
    if (!state?.complete) return 'failed'
    return entry.approved_at ? 'approved' : 'needs-review'
  }
  const reviewPosts = computed(() => posts.value.filter(entry => {
    if (reviewFilter.value === 'approved') return reviewStatus(entry) === 'approved'
    if (reviewFilter.value === 'failed') return reviewStatus(entry) === 'failed'
    if (reviewFilter.value === 'complete') return !!postState(entry.id)?.complete
    return reviewStatus(entry) === 'needs-review'
  }))
  watch(reviewFilter, () => { reviewSelected.value = [] })

  const stepStates = computed<StillPostStepStatus[]>(() => {
    const facts: StillPostFlowFacts = {
      castCount: workspace.value?.config.character_ids.length ?? 0,
      postCount: posts.value.length,
      completePostCount: completePostCount.value,
      needsReviewCount: needsReviewCount.value,
      approvedCount: approvedCount.value,
      publishedCount: publishedCount.value,
      socialOn: socialOn.value,
      writeJob: latestOf('still_post_write'),
      drawJob: latestOf('still_post_render'),
    }
    return stillPostStepStates(facts)
  })
  const landing = computed<StillPostTab>(() => landingTab(stepStates.value))

  function latestOf(type: string): { status: string, error?: string | null } | null {
    const job = latestJob(type)
    return job ? { status: job.status, error: job.error ?? null } : null
  }

  // ── The lettering font pool ────────────────────────────────────────────────
  // Every rule here is a function in `@shared/still-post-fonts`, the same module the server and the
  // job use — the percentage the customer reads is the percentage the rotation draws with.

  const usageModes = STILL_POST_FONT_USAGE_MODES
  const usageModeLabels = STILL_POST_FONT_USAGE_LABELS

  /** Every face the bundled manifest lists for one script. Nothing else can be offered. */
  function facesFor(script: string): Array<{ id: string, label: string, scripts: string[] }> {
    return (workspace.value?.fonts || []).filter(font => font.scripts.includes(script))
  }

  const poolRows = computed(() => languages.map(entry => {
    const script = scriptForLanguage(entry.id)
    return { language: entry.id, label: entry.label, script, pool: preset.font_pools[script] || emptyFontPool(), faces: facesFor(script) }
  }))

  /** Faces not already in this row's pool — a face is listed once, and a repeat is never offered. */
  function freeFaces(row: { script: string, pool: StillPostFontPool }): Array<{ id: string, label: string, scripts: string[] }> {
    const used = new Set(row.pool.fonts.map(choice => choice.font_id))
    return facesFor(row.script).filter(face => !used.has(face.id))
  }

  /**
   * The options one entry may switch to: faces for this script that no OTHER entry already uses, plus
   * the entry's own current face even when this build no longer offers it — so a stored pool is shown
   * as it really is instead of looking empty.
   */
  function facesForChoice(row: { script: string, pool: StillPostFontPool }, index: number): Array<{ id: string, label: string, scripts: string[] }> {
    const own = row.pool.fonts[index]?.font_id
    const used = new Set(row.pool.fonts.map(choice => choice.font_id))
    if (own) used.delete(own)
    const faces = facesFor(row.script).filter(face => !used.has(face.id))
    if (own && !faces.some(face => face.id === own)) faces.unshift({ id: own, label: `${fontLabel(own)} (not offered for ${row.script})`, scripts: [] })
    return faces
  }

  function poolSummary(row: { label: string, pool: StillPostFontPool }): string {
    const count = row.pool.fonts.length
    if (!count) return `No pool — every post uses the format's own ${row.label} face.`
    if (count === 1) return `One font — every post uses ${fontLabel(row.pool.fonts[0]!.font_id)}.`
    return `${count} fonts, ${usageModeLabels[row.pool.usage_mode].toLowerCase()}, wrapping.`
  }

  function fontLabel(id: string): string {
    return (workspace.value?.fonts || []).find(font => font.id === id)?.label || id
  }

  /** Add one face to a pool. Refuses a face the manifest does not list for this script (§1). */
  function addPoolFont(script: string, id: string): boolean {
    if (!id) return false
    const pool = preset.font_pools[script] || emptyFontPool()
    if (!facesFor(script).some(face => face.id === id)) return false
    if (pool.fonts.some(choice => choice.font_id === id)) return false
    preset.font_pools[script] = { ...pool, fonts: [...pool.fonts, { font_id: id, weight: 100 }] }
    return true
  }

  /** The old `<select>` wiring, kept for callers that still hand over the change event. */
  function onAddPoolFont(script: string, event: Event): void {
    const select = event.target as HTMLSelectElement
    const id = select.value
    select.value = ''
    addPoolFont(script, id)
  }

  function removePoolFont(script: string, index: number): void {
    const pool = preset.font_pools[script]
    if (!pool) return
    preset.font_pools[script] = { ...pool, fonts: pool.fonts.filter((_, position) => position !== index) }
  }

  const letteringFontLabel = computed(() => {
    const script = scriptForLanguage(preset.language)
    const pool = preset.font_pools[script]
    const formatFace = draftFormat.value?.lettering.fonts[script]
    if (pool && pool.fonts.length === 1) {
      return `Lettering: ${fontLabel(pool.fonts[0]!.font_id)} for every post (from your font pool).`
    }
    if (pool && pool.fonts.length > 1) {
      return `Lettering: ${pool.fonts.length} fonts, ${usageModeLabels[pool.usage_mode].toLowerCase()}.`
    }
    return formatFace
      ? `Lettering: ${fontLabel(formatFace)} (the format's own face — no font pool for this language).`
      : 'This format has no font for that language yet.'
  })

  const imageModelHelp = computed(() => {
    const model = imageModels.value.find(entry => entry.id === imageModelChoice.value)
    if (!imageModelChoice.value) return 'Pick a live Gateway model. Nothing is chosen for you.'
    if (!model) return 'That model is not in the live catalogue right now.'
    return model.supports_reference_images
      ? `References: up to ${model.max_reference_images ?? '?'} character portrait(s).`
      : 'This model publishes no reference support, so your characters cannot be attached to it.'
  })

  /**
   * How many paid drawings the posts still needing art would take: one per panel, times one per ticked
   * frame when a fresh drawing per size is on. The price comes from `describeImageBatchEstimate`, which
   * only multiplies the model's PUBLISHED rate and says "not reported" when there is none.
   */
  const drawingsForBatch = computed(() => {
    const frames = preset.aspects.length || 1
    return posts.value.reduce((total, post) =>
      total + Math.max(1, post.panels?.length || 1) * (preset.fresh_drawing_per_size ? frames : 1), 0)
  })
  const drawCost = computed(() => describeImageBatchEstimate(imageModelInfo.value, null, drawingsForBatch.value))

  function finalName(index: number, aspect: string): string {
    return `final-p${index}-${String(aspect).replace(':', 'x')}.png`
  }

  function fileBase(entry: StillPost): string {
    return `/api/projects/${slug.value}/still-posts/posts/${entry.id}/file`
  }

  function postImageUrl(entry: StillPost): string | null {
    const final = entry.finals.find(item => item.aspect === (entry.aspects[0] || '1:1'))
    const name = final?.filename || 'p0.png'
    return `${fileBase(entry)}/${name}?v=${encodeURIComponent(entry.updated_at || '')}`
  }

  function finalUrl(entry: StillPost, index: number, aspect: string): string | null {
    const state = postState(entry.id)
    const panelId = entry.panels[index]?.id
    const stateOf = state?.panels.find(panel => panel.panel_id === panelId)?.finals?.[aspect]
    if (stateOf === 'ok' || stateOf === 'stale') {
      return `${fileBase(entry)}/${finalName(index, aspect)}?v=${encodeURIComponent(entry.updated_at || '')}`
    }
    return null
  }

  function finalState(entry: StillPost, index: number, aspect: string): string {
    const panelId = entry.panels[index]?.id
    return postState(entry.id)?.panels.find(panel => panel.panel_id === panelId)?.finals?.[aspect] || 'missing'
  }

  function activeJobLine(job: { status: string, error?: string | null, progress?: number }): string {
    if (job.status === 'done') return 'Done.'
    if (job.status === 'error') return job.error || 'Failed.'
    return `${job.status}${typeof job.progress === 'number' ? ` · ${job.progress}%` : ''}`
  }

  function toggleCast(id: string): void {
    const index = castDraft.value.indexOf(id)
    if (index >= 0) castDraft.value.splice(index, 1)
    else if (castDraft.value.length < 10) castDraft.value.push(id)
  }

  function applyPreset(id: string): void {
    const found = workspace.value?.presets.find(entry => entry.id === id)
    if (!found) return
    preset.writing_model = found.data.writing_model ?? null
    preset.image_model = found.data.image_model ?? null
    preset.format_id = found.data.format_id
    preset.option_id = found.data.option_id
    preset.language = found.data.language
    preset.aspects = [...(found.data.aspects || ['1:1'])]
    preset.fresh_drawing_per_size = found.data.fresh_drawing_per_size === true
    // §4/§5: the preset REPLACES the pools — a preset with no pool must not leave the previous
    // preset's fonts standing on this one.
    preset.font_pools = poolsForEditing(found.data.font_pools)
    preset.text_scale = Number(found.data.text_scale) || 1
    Object.assign(preset.branding, found.data.branding)
    presetNote.value = found.builtin
      ? 'Built-in preset. Save it under a new name to change it.'
      : `Loaded "${found.name}".`
    presetError.value = false
  }

  async function load(): Promise<void> {
    loading.value = true
    loadError.value = ''
    try {
      const data = await get<StillPostsWorkspaceData>(`/projects/${slug.value}/still-posts`)
      workspace.value = data
      publishes.value = data.publishes || {}
      castDraft.value = [...data.config.character_ids]
      handleDraft.value = data.config.handle && data.config.handle !== '' ? `@${data.config.handle}` : ''
      logoDraft.value = data.config.logo_path || ''
      presetId.value = data.last_preset_id && data.presets.some(entry => entry.id === data.last_preset_id)
        ? data.last_preset_id
        : data.presets[0]?.id || 'clean-handle'
      applyPreset(presetId.value)
    } catch (error: any) {
      loadError.value = error?.data?.detail || error?.message || 'Could not load Still Posts.'
    } finally {
      loading.value = false
    }
  }

  async function loadPublishing(): Promise<void> {
    try {
      const settings = await get<{ platforms: string[] }>(`/projects/${slug.value}/social/settings`)
      socialPlatforms.value = Array.isArray(settings.platforms) ? settings.platforms : []
    } catch { socialPlatforms.value = [] }
  }

  async function loadModels(): Promise<void> {
    try {
      const chat = await get<Array<{ id: string, label: string, available: boolean }>>(`/models?project=${slug.value}`)
      writingModels.value = chat.map(model => ({ id: model.id, label: model.label, available: model.available !== false }))
    } catch { writingModels.value = [] }
    try {
      const response = await get<{ models: any[] }>('/app-settings/genstudio/image-models')
      // Kept whole: the price fields feed the batch estimate, and capabilities drive the help text.
      imageModels.value = (Array.isArray(response.models) ? response.models : []) as ImageModelRow[]
    } catch { imageModels.value = [] }
    try {
      appDefaults.value = normalizeDefaultModels(await get('/app-settings/default-models', { cache: 'no-store' }))
    } catch {
      // An unreadable setting is "no default"; the pickers then ask for a real choice.
      appDefaults.value = emptyDefaultModels()
    }
  }

  async function saveConfig(): Promise<void> {
    savingConfig.value = true
    configNote.value = ''
    try {
      await put(`/projects/${slug.value}/still-posts/config`, {
        character_ids: castDraft.value,
        handle: handleDraft.value.trim() || null,
        logo_path: logoDraft.value.trim() || null,
      })
      configNote.value = `Saved: ${castDraft.value.length} character(s) in this channel's cast.`
      configError.value = false
      await load()
    } catch (error: any) {
      configNote.value = error?.data?.detail || error?.message || 'Could not save the channel settings.'
      configError.value = true
    } finally {
      savingConfig.value = false
    }
  }

  async function savePreset(): Promise<void> {
    if (!workspace.value) return
    savingPreset.value = true
    presetNote.value = ''
    const name = presetName.value.trim() || 'Untitled preset'
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'}-${Date.now().toString(36).slice(-4)}`
    const entry = {
      id,
      name,
      data: JSON.parse(JSON.stringify({ ...preset, branding: { ...preset.branding } })),
    }
    const saved = (workspace.value.presets || []).filter(item => !item.builtin)
    try {
      const response = await put<{ presets: StillPostsWorkspaceData['presets'] }>(`/projects/${slug.value}/still-posts/presets`, {
        presets: [...saved.map(item => ({ id: item.id, name: item.name, data: item.data })), entry],
        last_preset_id: id,
      })
      workspace.value.presets = response.presets
      presetId.value = id
      presetNote.value = `Saved "${name}".`
      presetError.value = false
    } catch (error: any) {
      presetNote.value = error?.data?.detail || error?.message || 'Could not save the preset.'
      presetError.value = true
    } finally {
      savingPreset.value = false
    }
  }

  async function writeBatch(): Promise<void> {
    if (!workspace.value) return
    writing.value = true
    writeError.value = ''
    writeJobId.value = null
    try {
      const response = await post<{ job: Job, batch_id: string }>(`/projects/${slug.value}/still-posts/batches`, {
        brief: brief.value.trim(),
        count: count.value,
        format_id: preset.format_id,
        option_id: preset.option_id,
        language: preset.language,
        aspects: preset.aspects,
        fresh_drawing_per_size: preset.fresh_drawing_per_size,
        font_pools: preset.font_pools,
        character_ids: castDraft.value,
        writing_model: preset.writing_model,
      })
      writeJobId.value = response.job.job_id
    } catch (error: any) {
      writeError.value = error?.data?.detail || error?.message || 'Could not start writing.'
    } finally {
      writing.value = false
    }
  }

  /** The newest batch's id, which is where a hand-typed post joins. */
  const newestBatchId = computed(() => posts.value[0]?.batch_id || '')

  /**
   * Save one quote typed or edited before any drawing: an existing post is re-saved without touching
   * its picture (there is none yet), and a new row becomes a real post through the add route.
   */
  async function saveQuote(postId: string | null, text: string): Promise<{ ok: boolean, post?: StillPost, message: string }> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, message: 'Type the line this post should carry.' }
    try {
      const response = postId
        ? await put<{ post: StillPost, render_error: string | null }>(
          `/projects/${slug.value}/still-posts/posts/${postId}`, { panels: [{ text: trimmed }] },
        )
        : await post<{ post: StillPost }>(`/projects/${slug.value}/still-posts/posts`, {
          text: trimmed,
          batch_id: newestBatchId.value || undefined,
          format_id: preset.format_id,
          option_id: preset.option_id,
          language: preset.language,
          aspects: preset.aspects,
          character_ids: castDraft.value,
        })
      await load()
      // An undrawn post is expected to have nothing to letter; that is not an error here.
      const warning = postId && (response as any).render_error && (response as any).post?.panels?.[0]?.image
        ? String((response as any).render_error)
        : ''
      return { ok: true, post: (response as any).post, message: warning }
    } catch (error: any) {
      return { ok: false, message: error?.data?.detail || error?.message || 'Could not save that line.' }
    }
  }

  async function draw(batchId?: string, postIds?: string[], redraw = false): Promise<void> {
    drawing.value = true
    drawError.value = ''
    try {
      await post(`/projects/${slug.value}/still-posts/render`, {
        ...(batchId ? { batch_id: batchId } : {}),
        ...(postIds?.length ? { post_ids: postIds } : {}),
        image_model: imageModelChoice.value,
        redraw,
        fresh_drawing_per_size: preset.fresh_drawing_per_size,
        preset: { branding: preset.branding, text_scale: preset.text_scale },
      })
    } catch (error: any) {
      drawError.value = error?.data?.detail || error?.message || 'Could not start drawing.'
    } finally {
      drawing.value = false
    }
  }

  async function postSelectedToFacebook(): Promise<void> {
    const entry = selected.value
    if (!entry) return
    publishBusy.value = true
    publishMessage.value = ''
    try {
      const result = await post<{ already: boolean, receipt: PublishReceipt }>(
        `/projects/${slug.value}/still-posts/posts/${entry.id}/publish`, { platform: 'facebook' },
      )
      publishes.value = {
        ...publishes.value,
        [entry.id]: { ...(publishes.value[entry.id] || {}), facebook: result.receipt },
      }
      publishMessage.value = result.already
        ? `Already posted from this exact image (${result.receipt.post_id}). Nothing was sent again.`
        : `Posted to Facebook (${result.receipt.post_id}).`
    } catch (error: any) {
      publishMessage.value = error?.data?.detail || error?.message || 'Facebook did not accept the image.'
    } finally {
      publishBusy.value = false
    }
  }

  async function deletePost(id: string): Promise<{ ok: boolean, message: string }> {
    const confirmed = await ask({
      title: 'Remove this post?',
      message: 'It moves to the channel’s recycle bin (_trash), so it is not gone for good.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!confirmed) return { ok: false, message: '' }
    try {
      await del(`/projects/${slug.value}/still-posts/posts/${id}`)
      if (selectedId.value === id) selectedId.value = null
      await load()
      return { ok: true, message: '' }
    } catch (error: any) {
      return { ok: false, message: error?.data?.detail || error?.message || 'Could not remove the post.' }
    }
  }

  // A finished Still Posts job changes the files on disk, so the workspace is re-read rather than
  // patched from the job payload. While one is RUNNING the workspace is re-read every few seconds, so
  // finished posts appear as they are made instead of only when the whole batch ends.
  let poll: ReturnType<typeof setInterval> | null = null
  function stopPolling(): void {
    if (poll) { clearInterval(poll); poll = null }
  }
  watch(() => jobs.value.map(job => `${job.job_id}:${job.status}`).join('|'), () => {
    const active = jobs.value.some(job =>
      (job.type === 'still_post_write' || job.type === 'still_post_render')
      && ['queued', 'running', 'paused'].includes(job.status))
    if (active && !poll) poll = setInterval(() => { void load() }, 4000)
    if (!active) stopPolling()
    const finished = jobs.value.some(job =>
      (job.type === 'still_post_write' || job.type === 'still_post_render') && job.status === 'done')
    if (finished) void load()
  })
  // The page owns the instance for its whole life, but a poll must never outlive it.
  onUnmounted?.(stopPolling)


  const state = {
    slug, workspace, loading, loadError, load, loadModels, loadPublishing,
    castDraft, handleDraft, logoDraft, savingConfig, configNote, configError, saveConfig, toggleCast, castCharacters,
    presetId, preset, presetName, savingPreset, presetNote, presetError, applyPreset, savePreset,
    draftFormat, draftOption, imageModelHelp, letteringFontLabel,
    aspects, anchors, languages, writingModels, imageModels,
    usageModes, usageModeLabels, poolRows, freeFaces, facesForChoice, poolSummary, fontLabel,
    appDefaults, writingModelChoice, imageModelChoice, formatSampleUrl, fontSampleUrl,
    onAddPoolFont, addPoolFont, removePoolFont, percentagesFor, scriptForLanguage,
    brief, count, writing, writeError, writeJob, writeBatch, canWrite,
    drawing, drawError, draw, canDraw, drawCost, drawingsForBatch, imageModelInfo, newestBatchId, saveQuote,
    posts, selected, selectedId, selectedPublish, completePostCount, approvedCount, approvedPostIds, needsReviewCount, publishedCount, postState,
    reviewStatus, reviewFilter, reviewPosts, reviewSelected,
    finalName, fileBase, postImageUrl, finalUrl, finalState, activeJobLine,
    socialPlatforms, socialOn, publishes, publishBusy, publishMessage, postSelectedToFacebook,
    deletePost, stepStates, landing, latestJob,
  }
  return state
}

export type StillPostsWorkspace = ReturnType<typeof useStillPostsWorkspace>

const STILL_POSTS_KEY: InjectionKey<StillPostsWorkspace> = Symbol('still-posts-workspace')

export function provideStillPosts(value: StillPostsWorkspace): void {
  provide(STILL_POSTS_KEY, value)
}

export function useStillPosts(): StillPostsWorkspace {
  const value = inject(STILL_POSTS_KEY, null)
  if (!value) throw new Error('useStillPosts() must be used inside the Still Posts page.')
  return value
}
