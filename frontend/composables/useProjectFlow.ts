import { computed, type Ref, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'

/**
 * useProjectFlow — the format-aware production flow for a project.
 *
 * Every project follows a creation chain, but the chain DIFFERS by the
 * format's `visualSource` (the same value that already gates the sidebar):
 *
 *   timestamp-driven (narration-synced):
 *     Ideas → Research → Script → Introduction → Thumbnail Prompts →
 *     Thumbnails →
 *     Audio → Audio Assembly → Subtitles → YouTube Finalizer →
 *     Scene Plan → Scene Review → Video Assembly
 *
 *   continuity-chain (continuity-chain):
 *     Ideas → Research → Script → Introduction → Thumbnail Prompts →
 *     Thumbnails →
 *     Audio → Audio Assembly → Subtitles → YouTube Finalizer →
 *     Character Sheet → Scene Plan → Scene Review → Video Assembly
 *     (like timestamp-driven, plus a Character Sheet step; scenes render
 *     sequentially via img2img anchored to the sheet. Research is available
 *     too — handy when the niche is factual.)
 *
 * The step set + order mirror the format-gated sidebar exactly, so the
 * ribbon is a faithful "where am I / what's next" map of the real nav.
 * Library/Jobs/Settings are intentionally NOT steps — they're tools, not
 * stages of the creation chain.
 */
export type VisualSource = 'timestamp-driven' | 'continuity-chain' | 'narrated-scenes'

export type SceneAlignment = 'chapter' | 'sentence'

export type FlowPhaseKey = 'story' | 'media' | 'video'

export const FLOW_PHASES: ReadonlyArray<{ key: FlowPhaseKey; label: string }> = [
  { key: 'story', label: 'Story' },
  { key: 'media', label: 'Media' },
  { key: 'video', label: 'Video' },
]

/**
 * Only current visual-source values can select a flow. Saved unknown values
 * use the Continuity flow until the project is next deliberately configured.
 */
export function normalizeVisualSource(
  visualSource: string | undefined | null,
  sceneAlignment?: SceneAlignment | string | null,
): VisualSource {
  void sceneAlignment
  switch (visualSource) {
    case 'continuity-chain': return 'continuity-chain'
    case 'timestamp-driven': return 'timestamp-driven'
    case 'narrated-scenes': return 'narrated-scenes'
    default: return 'continuity-chain'
  }
}

export interface FlowStep {
  /** Stable key for v-for + current-step matching. */
  key: string
  /** Plain-language label shown in the ribbon node. */
  label: string
  /** Emoji icon, matching the sidebar entry for the same page. */
  icon: string
  /** Route path suffix (appended to /projects/:slug). */
  path: string
  /** Production phase used to orient long workflow views without hiding steps. */
  phase: FlowPhaseKey
  /** For pages that share a path via ?tab=. */
  tab?: 'thumbnails'
  /** Visible in the workflow, but never blocks an episode from being done. */
  optional?: boolean
}

// ── Shared steps (referenced by multiple flows) ────────────────────────────
const STEP = {
  ideas:        { key: 'ideas',        label: 'Ideas',          icon: '✨', path: '/ideas', phase: 'story' },
  research:     { key: 'research',     label: 'Research',       icon: '🔍', path: '/research', phase: 'story', optional: true },
  // v1.4.73 — the Introduction. `optional` because some channels open with a
  // host and some open on the story itself, and until now there was nowhere at
  // all to say which: the control was a per-session checkbox on the Outline
  // tab, gated on a niche field only one niche declares. It is shown to every
  // channel whether or not it is switched on, because a stage nobody can see
  // is a stage nobody knows to switch on.
  introduction: { key: 'introduction', label: 'Introduction', icon: '👋', path: '/introduction', phase: 'story', optional: true },
  script:       { key: 'script',       label: 'Script',         icon: '📝', path: '/scripts', phase: 'story' },
  metadata:     { key: 'metadata',     label: 'YouTube Finalizer', icon: '📋', path: '/metadata', phase: 'media' },
  thumbPrompts: { key: 'thumb-prompts', label: 'Thumbnail Prompts', icon: '💭', path: '/image-prompts', phase: 'media', tab: 'thumbnails' },
  thumbnails:   { key: 'thumbnails',   label: 'Thumbnails',     icon: '🖼', path: '/images', phase: 'media', tab: 'thumbnails' },
  audio:        { key: 'audio',        label: 'Audio',          icon: '🎙', path: '/audio', phase: 'media' },
  audioMerge:   { key: 'audio-merge',  label: 'Audio Assembly', icon: '🔊', path: '/audio-merge', phase: 'media' },
  subtitles:    { key: 'subtitles',    label: 'Subtitles',      icon: '🔤', path: '/subtitles', phase: 'media' },
  characterSheet: { key: 'character-sheet', label: 'Character Sheet', icon: '🎭', path: '/character-sheet', phase: 'video' },
  scenePlan:    { key: 'scene-plan',   label: 'Scene Plan',     icon: '📚', path: '/scene-plan', phase: 'video' },
  contextualCues: { key: 'contextual-cues', label: 'Contextual Cues', icon: '🏷️', path: '/contextual-cues', phase: 'video', optional: true },
  soundDesign: { key: 'sound-design', label: 'Sound Design', icon: '🎵', path: '/sound-design', phase: 'video', optional: true },
  // v1.4.37 — the music library. `optional` because a scripted channel never
  // touches it, and a music channel touches almost nothing else.
  musicLibrary: { key: 'music', label: 'Music Library', icon: '🎼', path: '/music', phase: 'media', optional: true },
  sceneReview:  { key: 'scene-review', label: 'Scene Review',   icon: '✅', path: '/scene-review', phase: 'video' },
  motionReview: { key: 'motion-review', label: 'Motion Review', icon: '🎬', path: '/motion-review', phase: 'video', optional: true },
  videoAssembly:    { key: 'video-assembly',     label: 'Video Assembly',     icon: '🎞', path: '/video-assembly', phase: 'video' },
  // v1.0.408 — Image Pool slideshow: pick images + assemble the slideshow.
} satisfies Record<string, FlowStep>
const FLOW_TIMESTAMP: FlowStep[] = [
  STEP.ideas, STEP.research, STEP.script, STEP.introduction,
  STEP.thumbPrompts, STEP.thumbnails,
  STEP.audio, STEP.audioMerge, STEP.subtitles,
  STEP.metadata,
  STEP.scenePlan, STEP.contextualCues, STEP.soundDesign, STEP.sceneReview, STEP.motionReview, STEP.videoAssembly,
]
const FLOW_CONTINUITY: FlowStep[] = [
  STEP.ideas, STEP.research, STEP.script, STEP.introduction,
  STEP.thumbPrompts, STEP.thumbnails,
  STEP.audio, STEP.audioMerge, STEP.subtitles,
  STEP.metadata,
  STEP.characterSheet, STEP.scenePlan, STEP.contextualCues, STEP.soundDesign, STEP.sceneReview, STEP.motionReview, STEP.videoAssembly,
]
// v1.0.300 — narrated-scenes: story/fiction on the audio-paced flow.
// v1.0.301 — Research + Character Sheet exposed as OPTIONAL steps (non-
// blocking; use or skip). Differs from continuity only in the render (no
// img2img character-lock) + default pacing.
const FLOW_NARRATED_SCENES: FlowStep[] = [
  STEP.ideas, STEP.research, STEP.script, STEP.introduction,
  STEP.thumbPrompts, STEP.thumbnails,
  STEP.audio, STEP.audioMerge, STEP.subtitles,
  STEP.metadata,
  STEP.characterSheet, STEP.scenePlan, STEP.contextualCues, STEP.soundDesign, STEP.sceneReview, STEP.motionReview, STEP.videoAssembly,
]

export function flowForVisualSource(vs: VisualSource): FlowStep[] {
  if (vs === 'timestamp-driven') return FLOW_TIMESTAMP
  if (vs === 'continuity-chain') return FLOW_CONTINUITY
  if (vs === 'narrated-scenes') return FLOW_NARRATED_SCENES
  return FLOW_NARRATED_SCENES
}

/** Steps that may block an episode from being considered production-ready. */
export function requiredFlowSteps(vs: VisualSource): FlowStep[] {
  return flowForVisualSource(vs).filter(step => !step.optional)
}

/**
 * v1.4.82 — flow step key → the per-episode status field that reports on it.
 *
 * WHY THIS LIVES HERE. Three surfaces each kept their own copy of this map and
 * their own "is this episode done" loop: the Production Board, the project
 * Dashboard, and the episode selector's Steps chip. They drifted — the
 * Dashboard's copy was missing Research and Introduction entirely — so the same
 * episode could read "Steps 10 of 12" in one place and "100%" in another. One
 * map, one done-test, three readers.
 *
 * Steps with no detectable per-episode status are deliberately absent (Ideas is
 * implicit; Contextual Cues, Sound Design and Music Library have no per-episode
 * signal), so every field here is a real, meaningful status.
 */
export const STEP_STATUS_FIELD: Readonly<Record<string, string>> = {
  research: 'research',
  // v1.4.73 — `status.introduction` was returned per episode all along and
  // rendered nowhere: no badge, no count, no filter. That is how four episodes
  // reached paid audio with no opening without anyone noticing. Because the
  // Introduction step is optional it never blocks an episode from reading done.
  introduction: 'introduction',
  script: 'script',
  metadata: 'metadata',
  'thumb-prompts': 'thumb_prompts',
  thumbnails: 'thumbnails',
  audio: 'audio',
  'audio-merge': 'merged_audio',
  subtitles: 'subtitles',
  'character-sheet': 'character_sheet',
  'scene-plan': 'scene_plan',
  'scene-review': 'scene_review',
  'motion-review': 'motion_review',
  'video-assembly': 'video_assembly',
}

/** The status fields that can hold an episode back, for this format's flow. */
export function requiredStatusFields(vs: VisualSource): string[] {
  return requiredFlowSteps(vs)
    .map(step => STEP_STATUS_FIELD[step.key])
    .filter((field): field is string => !!field)
}

/**
 * Is this episode finished? Every REQUIRED step of its format's flow is done.
 *
 * Optional steps never count against it — that is what `optional` means, and
 * every surface that reports completeness must agree on it. The server keeps
 * its own twin of this rule (`all_done`, routes/ideas.ts) which is deliberately
 * left alone for now; if the two ever disagree, that is the other half.
 */
export function isEpisodeDone(
  status: Record<string, unknown> | null | undefined,
  vs: VisualSource,
): boolean {
  if (!status) return false
  return requiredStatusFields(vs).every(field => status[field] === true)
}

export function useProjectFlow(
  slug: Ref<string> | ComputedRef<string>,
  visualSource: Ref<VisualSource> | ComputedRef<VisualSource>,
) {
  const route = useRoute()

  const steps = computed<FlowStep[]>(() => flowForVisualSource(visualSource.value))

  /** Full route for a step (the ribbon links here). */
  function routeFor(step: FlowStep): string {
    const base = `/projects/${slug.value}${step.path}`
    // A workflow step is per-episode whenever the current project route has
    // one selected. Keep that explicit selection while moving through the
    // ribbon, but never borrow a query from another project's route.
    const activeSlug = String(route.params.slug || '')
    const episodeId = activeSlug === slug.value
      ? String(route.query.episode_id || '').trim()
      : ''
    const query = new URLSearchParams()
    if (episodeId) query.set('episode_id', episodeId)
    if (step.tab) query.set('tab', step.tab)
    const suffix = query.toString()
    return suffix ? `${base}?${suffix}` : base
  }

  /** Which step (if any) the current route is on. null = off-flow page
   *  (Dashboard / Jobs / Settings / Library), where no node is highlighted. */
  const currentKey = computed<string | null>(() => {
    const path = route.path
    // image-prompts + images share a path across two steps via ?tab=; the
    // default tab is 'thumbnails' (matches the pages' own default).
    const matches = steps.value.filter(s => path.endsWith(s.path))
    if (matches.length === 0) return null
    if (matches.length === 1) return matches[0].key
    const tab = String(route.query.tab || 'thumbnails')
    return (matches.find(s => s.tab === tab) || matches[0]).key
  })

  /** 1-based index of the current step, or 0 when off-flow. */
  const currentIndex = computed<number>(() => {
    if (!currentKey.value) return 0
    return steps.value.findIndex(s => s.key === currentKey.value) + 1
  })

  return { steps, routeFor, currentKey, currentIndex }
}
