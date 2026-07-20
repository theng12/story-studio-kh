export interface SceneReviewCompletionScene {
  id?: string
  approved?: boolean
}

export interface SceneReviewCompletion {
  total: number
  approved: number
  withImage: number
  unapprovedIds: string[]
  missingImageIds: string[]
  complete: boolean
}

/**
 * Authoritative Scene Review completion rule shared by list/status readers and
 * the workspace API. Rendering every image is not approval: each planned scene
 * must have its exact image and an explicit human approval.
 */
export function inspectSceneReviewCompletion(
  scenes: SceneReviewCompletionScene[],
  imageReady: boolean[],
  prerequisitesComplete: boolean,
): SceneReviewCompletion {
  const total = scenes.length
  const approved = scenes.filter(scene => scene.approved === true).length
  const withImage = scenes.reduce((count, _scene, index) => count + (imageReady[index] === true ? 1 : 0), 0)
  const sceneId = (scene: SceneReviewCompletionScene, index: number) => scene.id || `scene-${index + 1}`
  const unapprovedIds = scenes
    .map((scene, index) => scene.approved === true ? null : sceneId(scene, index))
    .filter((id): id is string => id !== null)
  const missingImageIds = scenes
    .map((scene, index) => imageReady[index] === true ? null : sceneId(scene, index))
    .filter((id): id is string => id !== null)

  return {
    total,
    approved,
    withImage,
    unapprovedIds,
    missingImageIds,
    complete: total > 0
      && prerequisitesComplete
      && imageReady.length === total
      && unapprovedIds.length === 0
      && missingImageIds.length === 0,
  }
}
