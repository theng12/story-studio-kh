/**
 * The ONE definition of "what precedes the scenes".
 *
 * Two places need this number and they must never disagree:
 *
 *   • `generators/video.ts` measures it at render time as `preSceneDuration` —
 *     where the scene track actually begins in the composed video.
 *   • `generators/scene-plan.ts` reserves it at plan time as
 *     `opening_reserved_sec` — where the plan's first scene starts.
 *
 * When those two are the same number, `sceneTimelineOffsetSec` (v1.2.7)
 * computes 0 and every scene's picture sits under the narration it was
 * planned against. When they are two independent measurements they drift —
 * which is exactly how v1.3.1's defect happened: the plan trusted a
 * remembered preset value while the renderer probed real files.
 *
 * So there is one function, and its input type names all four head buckets
 * explicitly. Adding a fifth thing to the head of the video is a compile
 * error at BOTH call sites, which is the point: a new bucket can no longer
 * be added to the render without the plan learning about it.
 *
 * The order below is the order `buildConcatList` emits, and the order the
 * viewer sees:  before_intro → intro → title → after_intro → scenes.
 */

/** One thing at the head of the video, either already measured or probeable. */
export interface OpeningHeadClip {
  /** Absolute path to probe when `duration_sec` is not already known. */
  path?: string
  /** Known duration in seconds — prepared clips and static image cards have one. */
  duration_sec?: number
  /** Used when the probe returns nothing. Mirrors the renderer's `|| 5`. */
  fallback_sec?: number
  /** Human label for the job log / plan report. */
  label?: string
}

/**
 * The head of the video, bucket by bucket. Every key is REQUIRED — pass an
 * empty array or `null` for a bucket that has no content. Optional keys would
 * let a call site silently forget one, which is the drift this type exists to
 * prevent.
 */
export interface OpeningHead {
  /** User timeline clips anchored `before_intro`. */
  before_intro: OpeningHeadClip[]
  /** The branded intro video, when one is enabled and available. */
  intro: OpeningHeadClip | null
  /** The title image clip or text title card, when one is enabled. */
  title: OpeningHeadClip | null
  /** User timeline clips anchored `after_intro`. */
  after_intro: OpeningHeadClip[]
}

/** Bucket order as composed. Exported so callers can report the parts. */
export const OPENING_HEAD_ORDER = ['before_intro', 'intro', 'title', 'after_intro'] as const

/** An empty head — nothing precedes the scenes. */
export function emptyOpeningHead(): OpeningHead {
  return { before_intro: [], intro: null, title: null, after_intro: [] }
}

function clipsOf(head: OpeningHead): OpeningHeadClip[] {
  const out: OpeningHeadClip[] = []
  for (const bucket of OPENING_HEAD_ORDER) {
    const value = head[bucket]
    if (Array.isArray(value)) out.push(...value)
    else if (value) out.push(value)
  }
  return out
}

/**
 * Sum the head buckets in seconds, rounded to the millisecond.
 *
 * `probe` is the caller's duration reader (`getAudioDuration` in both real
 * call sites — ffprobe works on video containers too). A clip that already
 * carries `duration_sec` is never probed; a clip with neither a usable probe
 * result nor a `fallback_sec` contributes 0.
 */
export async function measureOpeningSec(
  head: OpeningHead,
  probe: (filePath: string) => Promise<number | undefined>,
): Promise<number> {
  let total = 0
  for (const clip of clipsOf(head)) {
    total += await measureClipSec(clip, probe)
  }
  return Math.round(total * 1000) / 1000
}

/** Per-clip measurement, exported so callers can report the breakdown. */
export async function measureClipSec(
  clip: OpeningHeadClip,
  probe: (filePath: string) => Promise<number | undefined>,
): Promise<number> {
  if (typeof clip.duration_sec === 'number' && clip.duration_sec > 0) {
    return clip.duration_sec
  }
  if (clip.path) {
    const probed = await probe(clip.path).catch(() => undefined)
    if (probed && probed > 0) return probed
  }
  return clip.fallback_sec || 0
}

/**
 * A one-line, human breakdown of the head, for the job log. Empty string when
 * nothing precedes the scenes.
 */
export async function describeOpeningHead(
  head: OpeningHead,
  probe: (filePath: string) => Promise<number | undefined>,
): Promise<string> {
  const parts: string[] = []
  for (const clip of clipsOf(head)) {
    const sec = await measureClipSec(clip, probe)
    if (sec <= 0) continue
    parts.push(`${clip.label || 'clip'} ${sec.toFixed(2)}s`)
  }
  return parts.join(' + ')
}
