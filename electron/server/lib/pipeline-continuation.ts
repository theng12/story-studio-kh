/**
 * What a Pipeline episode chain does when one of its steps fails.
 *
 * A batch used to be a straight line: one failed step stopped every later step
 * of that episode, including steps that never needed it. One failed thumbnail
 * left an overnight run with no audio, no subtitles and no final video for that
 * episode. Each link now carries its step id and the steps it needs
 * (`pipeline_step`, `pipeline_requires`, stamped by routes/pipeline.ts), so a
 * failure holds back only the links that depend on it — directly or through
 * another held link — and the rest keep going.
 *
 * Chains written before these fields existed return `null`: the caller keeps
 * the old stop-on-failure behaviour rather than guessing at dependencies.
 */

export interface PipelineChainLink {
  type?: unknown
  title?: unknown
  params?: Record<string, any>
}

const STEP_LABELS: Record<string, string> = {
  research: 'Research',
  broll: 'B-Roll',
  'script-only': 'Script',
  'introduction-only': 'Introduction',
  image_prompts: 'Thumbnail Prompts',
  thumb_images: 'Thumbnails',
  audio: 'Audio',
  audio_merge: 'Audio Assembly',
  subtitles: 'Subtitles',
  metadata: 'YouTube Finalizer',
  scene_plan: 'Scene Plan',
  contextual_cues: 'Contextual Cues',
  scene_review: 'Scene Review',
  motion_review: 'Motion Clips',
  video_assembly: 'Final Video',
}

/** Plain step names for a list of links, each named once, in chain order. */
export function pipelineStepLabels(links: PipelineChainLink[]): string {
  const names = links.map(link => {
    const step = String(link.params?.pipeline_step || link.type || '')
    return STEP_LABELS[step] || step
  })
  return [...new Set(names)].join(', ')
}

function hasStepFacts(link: PipelineChainLink): boolean {
  return typeof link?.params?.pipeline_step === 'string'
    && Array.isArray(link.params.pipeline_requires)
}

export function splitChainAfterFailure(
  failedStep: unknown,
  rest: PipelineChainLink[],
): { survivors: PipelineChainLink[]; waiting: PipelineChainLink[] } | null {
  if (typeof failedStep !== 'string' || !failedStep) return null
  if (!rest.every(hasStepFacts)) return null
  const held = new Set<string>([failedStep])
  const survivors: PipelineChainLink[] = []
  const waiting: PipelineChainLink[] = []
  for (const link of rest) {
    const step = link.params!.pipeline_step as string
    const needsHeld = held.has(step)
      || (link.params!.pipeline_requires as unknown[]).some(required => held.has(String(required)))
    if (needsHeld) {
      held.add(step)
      waiting.push(link)
    } else {
      survivors.push(link)
    }
  }
  return { survivors, waiting }
}
