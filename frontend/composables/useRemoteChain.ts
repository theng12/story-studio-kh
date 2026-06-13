// v1.0.365 — step chains for the Remote cockpit's one-tap bulk run.
//
// Mirrors the per-format chains in pipeline.vue (CHAIN_*), reduced to the
// batchable steps that are ON by default there. It intentionally EXCLUDES the
// opt-in / costly steps that pipeline.vue leaves unchecked — Introduction
// (optional since v1.0.363), AI Video Clips (`video`, $0.50–$2/clip), and the
// legacy unified `images` — so a remote "Full run" matches the desktop
// "Run all pending" defaults and never surprise-spends. The backend skips
// already-done steps (run-batch force=false), so sending the whole chain only
// runs what's actually outstanding.
//
// pipeline.vue remains the source of truth for the chains; keep this in sync.
import type { VisualSource } from '~/composables/useProjectFlow'

export type CockpitStep =
  | 'script-only' | 'metadata' | 'image_prompts' | 'thumb_images' | 'scene_images'
  | 'audio' | 'audio_merge' | 'subtitles' | 'character_sheet'
  | 'scene_plan' | 'scene_review' | 'timestamp_assemble' | 'video_assembly'

const CHAINS: Record<VisualSource, CockpitStep[]> = {
  'broll':            ['script-only', 'metadata', 'image_prompts', 'thumb_images', 'audio', 'audio_merge', 'subtitles'],
  'scene-images':     ['script-only', 'metadata', 'image_prompts', 'thumb_images', 'scene_images', 'audio', 'audio_merge', 'subtitles', 'video_assembly'],
  'timestamp-driven': ['script-only', 'metadata', 'image_prompts', 'thumb_images', 'audio', 'audio_merge', 'subtitles', 'scene_plan', 'scene_review', 'timestamp_assemble'],
  'continuity-chain': ['script-only', 'metadata', 'image_prompts', 'thumb_images', 'audio', 'audio_merge', 'subtitles', 'character_sheet', 'scene_plan', 'scene_review', 'timestamp_assemble'],
  'narrated-scenes':  ['script-only', 'metadata', 'image_prompts', 'thumb_images', 'audio', 'audio_merge', 'subtitles', 'character_sheet', 'scene_plan', 'scene_review', 'timestamp_assemble'],
}

// The "Final video" steps — "Up to review" stops before these so you can eyeball
// the rendered scenes before assembling.
const FINAL_STEPS = new Set<CockpitStep>(['timestamp_assemble', 'video_assembly'])

export const STEP_LABELS: Record<CockpitStep, string> = {
  'script-only': 'Script',
  'metadata': 'Metadata',
  'image_prompts': 'Image prompts',
  'thumb_images': 'Thumbnail',
  'scene_images': 'Scene images',
  'audio': 'Audio',
  'audio_merge': 'Audio merge',
  'subtitles': 'Subtitles',
  'character_sheet': 'Character sheet',
  'scene_plan': 'Scene plan',
  'scene_review': 'Scene render',
  'timestamp_assemble': 'Final video',
  'video_assembly': 'Final video',
}

export function stepLabelFor(vs: VisualSource, step: CockpitStep): string {
  if (step === 'image_prompts' && vs !== 'scene-images') return 'Thumbnail prompts'
  return STEP_LABELS[step]
}

export function fullRunSteps(vs: VisualSource): CockpitStep[] {
  return CHAINS[vs] ?? CHAINS['scene-images']
}
export function upToReviewSteps(vs: VisualSource): CockpitStep[] {
  return fullRunSteps(vs).filter(s => !FINAL_STEPS.has(s))
}
/** Whether this format has a final-assembly step (so "Up to review" differs from "Full run"). */
export function chainHasFinal(vs: VisualSource): boolean {
  return fullRunSteps(vs).some(s => FINAL_STEPS.has(s))
}
