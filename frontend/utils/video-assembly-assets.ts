const SUPPORTED_SCENE_ASSET_EXTENSIONS = /\.(png|jpe?g|webp|mp4|mov|webm|mkv|m4v)$/i

interface ScannedScene {
  number?: number
  source?: string
}

export interface SceneAssetImportItem {
  type: 'scene'
  source_path: string
  scene_number: number
}

export function isSupportedSceneAssetPath(filePath: string): boolean {
  return SUPPORTED_SCENE_ASSET_EXTENSIONS.test(filePath)
}

export function buildSceneAssetImportItems(
  scannedScenes: ScannedScene[] | null | undefined,
  sourcePaths: string[],
): SceneAssetImportItem[] {
  const classicNumbers = (scannedScenes || [])
    .filter(scene => scene.source !== 'scene_plan')
    .map(scene => Number(scene.number))
    .filter(number => Number.isInteger(number) && number > 0)

  let nextNumber = classicNumbers.length ? Math.max(...classicNumbers) + 1 : 1
  const seen = new Set<string>()
  const items: SceneAssetImportItem[] = []

  for (const sourcePath of sourcePaths) {
    if (!sourcePath || seen.has(sourcePath) || !isSupportedSceneAssetPath(sourcePath)) continue
    seen.add(sourcePath)
    items.push({
      type: 'scene',
      source_path: sourcePath,
      scene_number: nextNumber++,
    })
  }

  return items
}
