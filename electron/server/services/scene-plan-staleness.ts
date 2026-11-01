/**
 * v1.4.374 — one rule for "this scene's picture no longer matches the plan".
 *
 * The bug (The Curious Why EP0006, 2026-11-01): a forced re-plan went from 36 to
 * 68 scenes. The rebuilt timeline restarts the scene ids, so ids 0001–0036 still
 * had the OLD plan's pictures on disk. The next scene-image batch said
 * "32/32 target scene(s) verified; 36 skipped" and KEPT those pictures — but
 * they had been drawn for different narration, because the new plan's prompt for
 * those ids now says something else. Production noticed from the `image_version`
 * timestamps and forced a redraw.
 *
 * The root cause is that a re-plan REPLACED the plan without carrying the
 * picture's own record forward. `rendered_prompt` is the field that says which
 * prompt a picture was drawn from, and the re-plan threw it away — so the
 * existing rule ("stale when `rendered_prompt` differs from `visual_prompt`")
 * could not see the change at all. An ABSENT `rendered_prompt` means "rendered
 * before the field existed", and that must stay accepted, or every finished
 * episode that was never re-planned would light up red.
 *
 * So a re-plan carries the record forward instead of dropping it, and then the
 * rule the rest of the app already uses decides:
 *
 *  - A scene whose prompt the re-plan did NOT change keeps its picture, its
 *    clip and its approval. A harmless re-plan must not throw away finished
 *    work or spend fleet time.
 *  - A scene whose prompt the re-plan DID change is stale: the picture does not
 *    show what the plan now says, so it is redrawn. Its clip goes with it — the
 *    clip was animated from that picture.
 *  - A picture rendered before `rendered_prompt` existed still gets a truthful
 *    record: the prompt of the plan it was rendered under. Without that, a
 *    re-plan could not tell a legacy picture that still matches from one that
 *    does not.
 *
 * The verdict is never taken from the scene id: ids restart on a re-plan and
 * mean nothing across two plans. The comparison is between two PROMPTS.
 */
import type { ScenePlan, ScenePlanEntry } from '../models/types.js'

/**
 * The prompts that describe a scene's own narration. Carried forward when the
 * narration is unchanged, so a harmless re-plan neither rewrites the prompts
 * nor redraws the pictures.
 */
export const SCENE_PROMPT_FIELDS = ['visual_prompt', 'motion_prompt', 'video_prompt'] as const

/**
 * Exactly the fields a scene's picture and clip are made of. One list, so the
 * re-plan carries the same set the rest of the app already knows.
 */
export const SCENE_MEDIA_FIELDS = [
  'approved', 'image_path', 'rendered_prompt', 'image_version', 'image_sha256', 'stand_in_for_prompt',
  'motion_choice', 'clip_path', 'rendered_motion_prompt', 'rendered_video_prompt',
  'clip_source_image_version', 'clip_requested_duration_seconds', 'clip_duration_seconds',
  'clip_shortfall_mode', 'clip_renderer', 'clip_source_image_sha256', 'clip_scene_window_seconds',
  'clip_sketch',
] as const

/** The prompt a scene's picture is judged against. */
export function scenePromptOf(scene: ScenePlanEntry): string {
  return typeof scene.visual_prompt === 'string' ? scene.visual_prompt : ''
}

/** A scene that has a picture to keep or to stale. */
export function sceneHasPicture(scene: ScenePlanEntry): boolean {
  return !!(scene.image_path || scene.image_sha256 || scene.image_version)
}

/**
 * The record of the prompt a picture on disk was drawn from, taken from the
 * plan it was rendered under.
 *
 * `rendered_prompt` is that record when the picture carries one. A picture made
 * before the field existed has none, and the best fact available is the prompt
 * of the plan it was rendered under — that is what tells a re-plan whether the
 * picture still matches.
 */
function pictureRecordOf(scene: ScenePlanEntry): string {
  if (typeof scene.rendered_prompt === 'string') return scene.rendered_prompt
  return scenePromptOf(scene)
}

/**
 * THE rule: does this scene's picture still show what the plan says?
 *
 * `rendered_prompt` is the record of the prompt the picture was drawn from. A
 * picture whose record differs from the current prompt is stale. An ABSENT
 * record means the picture predates the field, and is accepted — as today —
 * until a re-plan carries a truthful record forward for it.
 *
 * A stand-in (a picture borrowed from a neighbouring scene on the last
 * automatic try) is accepted for THIS prompt only, exactly as the completion
 * audit has always accepted it.
 */
export function sceneImageStaleReason(scene: ScenePlanEntry): string | null {
  if (typeof scene.rendered_prompt !== 'string') return null
  const prompt = scenePromptOf(scene)
  if (scene.rendered_prompt === prompt) return null
  if (scene.stand_in_for_prompt === prompt) return null
  return 'image was rendered from an outdated prompt'
}

/**
 * Carry the picture and clip records of the plan a re-plan replaces forward
 * onto the scenes of the plan that replaces it.
 *
 * The carry-over is by scene id — the only thing that correlates two plans at
 * all — but the VERDICT is never taken from the id: it is the picture's record
 * against the prompt the new plan carries, which `sceneImageStaleReason` reads
 * once the new prompt lands. A scene the new plan adds has nothing to carry; a
 * scene the new plan drops keeps its files on disk, exactly as any other
 * dropped scene does.
 *
 * A scene whose NARRATION is unchanged also keeps its prompts, so a re-plan
 * that only re-chunked the timeline rewrites nothing and redraws nothing. A
 * scene whose narration moved gets fresh prompts, and its old picture is then
 * stale by the prompt comparison — which is the EP0006 case.
 *
 * The picture's own record and the plan's prompt are carried separately,
 * because they can differ: a picture drawn from an older wording of a prompt
 * the owner later edited is stale TODAY, and a re-plan must not heal it.
 *
 * Returns how many scenes kept a picture through the re-plan.
 */
export function carrySceneMediaForward(incoming: ScenePlan, onDisk: ScenePlan | null): number {
  if (!onDisk?.scenes?.length) return 0
  const previous = new Map(onDisk.scenes.map(scene => [scene.id, scene]))
  let carried = 0
  for (const scene of incoming.scenes) {
    const before = previous.get(scene.id)
    if (!before || !sceneHasPicture(before)) continue
    const target = scene as unknown as Record<string, unknown>
    for (const field of SCENE_MEDIA_FIELDS) {
      const value = (before as unknown as Record<string, unknown>)[field]
      if (value === undefined) delete target[field]
      else target[field] = value
    }
    // The narration this scene covers is the fact its prompts were written from.
    // Unchanged narration → the prompts still say the right thing, so they are
    // carried and the planner rewrites nothing. Changed narration → the prompts
    // are regenerated for what the scene now covers, which is what makes the
    // picture stale below. Style lives in the render-time Style Bible, so a
    // carried prompt never carries a look.
    const sameNarration = typeof before.transcript_segment === 'string'
      && before.transcript_segment.trim().length > 0
      && before.transcript_segment === scene.transcript_segment
    if (sameNarration) {
      for (const field of SCENE_PROMPT_FIELDS) {
        const value = (before as unknown as Record<string, unknown>)[field]
        if (value === undefined) delete target[field]
        else target[field] = value
      }
    }
    // The picture's own record, so the existing staleness rule can judge it. A
    // picture rendered before `rendered_prompt` existed gets the prompt of the
    // plan it was rendered under — the only fact that says what it shows.
    target.rendered_prompt = pictureRecordOf(before)
    carried += 1
  }
  return carried
}

/** How a carried picture reads against the new plan: kept, or to be redrawn. */
export function countReplanPictures(plan: ScenePlan): { kept: number; redraw: number } {
  let kept = 0
  let redraw = 0
  for (const scene of plan.scenes) {
    if (!sceneHasPicture(scene)) continue
    if (sceneImageStaleReason(scene)) redraw += 1
    else kept += 1
  }
  return { kept, redraw }
}
