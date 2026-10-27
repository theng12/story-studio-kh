export interface SceneReviewCompletionScene {
  id?: string
  approved?: boolean
  /** Owner, 2026-10-26: a text-to-video scene has no still by design. It is reviewed
   *  (and approved) in Motion Review instead, so it never counts toward Scene Review. */
  visual_lane?: string
}

export interface SceneReviewCompletion {
  total: number
  approved: number
  withImage: number
  unapprovedIds: string[]
  missingImageIds: string[]
  /** Ids of text-to-video scenes, which Scene Review never owns. */
  motionOnlyIds: string[]
  complete: boolean
}

/**
 * Authoritative Scene Review completion rule shared by list/status readers and
 * the workspace API. Rendering every image is not approval: each planned scene
 * must have its exact image and an explicit human approval.
 *
 * A text-to-video scene is out of scope here — Motion Review approves it.
 */
export function inspectSceneReviewCompletion(
  scenes: SceneReviewCompletionScene[],
  imageReady: boolean[],
  prerequisitesComplete: boolean,
): SceneReviewCompletion {
  const motionOnlyIds = scenes
    .map((scene, index) => scene.visual_lane === 'text_to_video' ? (scene.id || `scene-${index + 1}`) : null)
    .filter((id): id is string => id !== null)
  const inSceneReview = scenes.map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => scene.visual_lane !== 'text_to_video')
  const total = inSceneReview.length
  const approved = inSceneReview.filter(({ scene }) => scene.approved === true).length
  const withImage = inSceneReview.reduce((count, { index }) => count + (imageReady[index] === true ? 1 : 0), 0)
  const sceneId = (scene: SceneReviewCompletionScene, index: number) => scene.id || `scene-${index + 1}`
  const unapprovedIds = inSceneReview
    .filter(({ scene }) => scene.approved !== true)
    .map(({ scene, index }) => sceneId(scene, index))
  const missingImageIds = inSceneReview
    .filter(({ index }) => imageReady[index] !== true)
    .map(({ scene, index }) => sceneId(scene, index))

  return {
    total,
    approved,
    withImage,
    unapprovedIds,
    missingImageIds,
    motionOnlyIds,
    // A plan whose every scene is text-to-video has nothing for Scene Review to approve.
    complete: prerequisiteOk(prerequisitesComplete, scenes)
      && unapprovedIds.length === 0
      && missingImageIds.length === 0,
  }
}

function prerequisiteOk(prerequisitesComplete: boolean, scenes: SceneReviewCompletionScene[]): boolean {
  if (!prerequisitesComplete) return false
  // No scenes at all is not a complete review; an all-T2V plan is.
  return scenes.length > 0
}
