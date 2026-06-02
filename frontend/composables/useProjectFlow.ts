import { computed, type Ref, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'

/**
 * useProjectFlow — the format-aware production flow for a project.
 *
 * Every project follows a creation chain, but the chain DIFFERS by the
 * format's `visualSource` (the same value that already gates the sidebar):
 *
 *   scene-images   (narrative, listicle):
 *     Ideas → Script → Metadata → Thumb Prompts → Scene Prompts →
 *     Thumbnails → Scenes → Audio → Audio Assembly → Video Assembly
 *
 *   broll          (stock-footage):
 *     Ideas → Script → Metadata → Thumb Prompts → Thumbnails →
 *     Audio → Audio Assembly → Video Assembly
 *     (no per-scene prompts/images — visuals come from the B-Roll pool)
 *
 *   timestamp-driven (narration-synced):
 *     Ideas → Research → Script → Metadata → Thumb Prompts → Thumbnails →
 *     Audio → Audio Assembly → Scene Plan → Scene Review → Timestamp Assemble
 *
 *   continuity-chain (continuity-chain):
 *     Ideas → Research → Script → Metadata → Thumb Prompts → Thumbnails →
 *     Audio → Audio Assembly → Character Sheet → Scene Plan → Scene Review →
 *     Timestamp Assemble
 *     (like timestamp-driven, plus a Character Sheet step; scenes render
 *     sequentially via img2img anchored to the sheet. Research is available
 *     too — handy when the niche is factual.)
 *
 * The step set + order mirror the format-gated sidebar exactly, so the
 * ribbon is a faithful "where am I / what's next" map of the real nav.
 * Library/Jobs/Settings are intentionally NOT steps — they're tools, not
 * stages of the creation chain.
 */
export type VisualSource = 'scene-images' | 'broll' | 'timestamp-driven' | 'continuity-chain'

export interface FlowStep {
  /** Stable key for v-for + current-step matching. */
  key: string
  /** Plain-language label shown in the ribbon node. */
  label: string
  /** Emoji icon, matching the sidebar entry for the same page. */
  icon: string
  /** Route path suffix (appended to /projects/:slug). */
  path: string
  /** For pages that share a path via ?tab= (image-prompts, images). */
  tab?: 'thumbnails' | 'scenes'
}

// ── Shared steps (referenced by multiple flows) ────────────────────────────
const STEP = {
  ideas:        { key: 'ideas',        label: 'Ideas',          icon: '✨', path: '/ideas' },
  research:     { key: 'research',     label: 'Research',       icon: '🔍', path: '/research' },
  script:       { key: 'script',       label: 'Script',         icon: '📝', path: '/scripts' },
  metadata:     { key: 'metadata',     label: 'Metadata',       icon: '📋', path: '/metadata' },
  thumbPrompts: { key: 'thumb-prompts', label: 'Thumbnail Prompts', icon: '💭', path: '/image-prompts', tab: 'thumbnails' },
  scenePrompts: { key: 'scene-prompts', label: 'Scene Prompts', icon: '💬', path: '/image-prompts', tab: 'scenes' },
  thumbnails:   { key: 'thumbnails',   label: 'Thumbnails',     icon: '🖼', path: '/images', tab: 'thumbnails' },
  scenes:       { key: 'scenes',       label: 'Scenes',         icon: '🎨', path: '/images', tab: 'scenes' },
  audio:        { key: 'audio',        label: 'Audio',          icon: '🎙', path: '/audio' },
  audioMerge:   { key: 'audio-merge',  label: 'Audio Assembly', icon: '🔊', path: '/audio-merge' },
  subtitles:    { key: 'subtitles',    label: 'Subtitles',      icon: '🔤', path: '/subtitles' },
  characterSheet: { key: 'character-sheet', label: 'Character Sheet', icon: '🎭', path: '/character-sheet' },
  scenePlan:    { key: 'scene-plan',   label: 'Scene Plan',     icon: '📚', path: '/scene-plan' },
  sceneReview:  { key: 'scene-review', label: 'Scene Review',   icon: '✅', path: '/scene-review' },
  videoAssembly:    { key: 'video-assembly',     label: 'Video Assembly',     icon: '🎞', path: '/video-assembly' },
  timestampAssemble: { key: 'timestamp-assemble', label: 'Timestamp Assemble', icon: '🎞', path: '/timestamp-assemble' },
} satisfies Record<string, FlowStep>

const FLOW_SCENE_IMAGES: FlowStep[] = [
  STEP.ideas, STEP.script, STEP.metadata,
  STEP.thumbPrompts, STEP.scenePrompts, STEP.thumbnails, STEP.scenes,
  STEP.audio, STEP.audioMerge, STEP.subtitles, STEP.videoAssembly,
]
const FLOW_BROLL: FlowStep[] = [
  STEP.ideas, STEP.script, STEP.metadata,
  STEP.thumbPrompts, STEP.thumbnails,
  STEP.audio, STEP.audioMerge, STEP.subtitles, STEP.videoAssembly,
]
const FLOW_TIMESTAMP: FlowStep[] = [
  STEP.ideas, STEP.research, STEP.script, STEP.metadata,
  STEP.thumbPrompts, STEP.thumbnails,
  STEP.audio, STEP.audioMerge, STEP.subtitles,
  STEP.scenePlan, STEP.sceneReview, STEP.timestampAssemble,
]
const FLOW_CONTINUITY: FlowStep[] = [
  STEP.ideas, STEP.research, STEP.script, STEP.metadata,
  STEP.thumbPrompts, STEP.thumbnails,
  STEP.audio, STEP.audioMerge, STEP.subtitles,
  STEP.characterSheet, STEP.scenePlan, STEP.sceneReview, STEP.timestampAssemble,
]

export function flowForVisualSource(vs: VisualSource): FlowStep[] {
  if (vs === 'broll') return FLOW_BROLL
  if (vs === 'timestamp-driven') return FLOW_TIMESTAMP
  if (vs === 'continuity-chain') return FLOW_CONTINUITY
  return FLOW_SCENE_IMAGES
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
    return step.tab ? `${base}?tab=${step.tab}` : base
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
