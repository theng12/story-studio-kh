export interface SceneImageBatchItem {
  id: string
  scene_index: number
  visual_prompt?: string
}

export interface SceneImageBatchSelection {
  sceneIds?: string[]
  missingOnly?: boolean
  singleIndex?: number
  force?: boolean
  hasRenderedImage: (sceneId: string) => boolean
}

/** Selects the exact work for a durable GenStudio image batch.
 *
 * Explicit selections normally mean "regenerate these scenes", including
 * existing images. Missing-only selections are different: they are durable
 * repair scopes, so every retry must re-check disk and omit recovered items.
 */
export function selectSceneImageBatch<T extends SceneImageBatchItem>(
  scenes: T[],
  selection: SceneImageBatchSelection,
): T[] {
  const selectedIds = selection.sceneIds?.length ? new Set(selection.sceneIds) : null
  const singleIndex = selection.singleIndex || 0

  return scenes.filter((scene) => {
    if (!scene.visual_prompt?.trim()) return false
    if (selectedIds) {
      if (!selectedIds.has(scene.id)) return false
      return selection.missingOnly !== true || !selection.hasRenderedImage(scene.id)
    }
    return singleIndex > 0
      ? scene.scene_index === singleIndex
      : selection.force === true
        ? true
        : !selection.hasRenderedImage(scene.id)
  })
}
