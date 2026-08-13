import {
  listCatalogEntries,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import {
  contentPackDocumentToVisualStyle,
  type ContentPackVisualStyle,
} from '../content-packs/legacy-adapters.js'

function assetUrl(packId: string, version: string, assetId: string): string {
  return `/api/content-packs/${encodeURIComponent(packId)}/${encodeURIComponent(version)}/assets/${encodeURIComponent(assetId)}`
}

/** Publish signed styles as renderer-safe records. Legacy fallback is renderer-owned during migration. */
export async function listVisualStyles(options: ContentPackRegistryOptions = {}): Promise<ContentPackVisualStyle[]> {
  const entries = await listCatalogEntries('visual-style', options)
  const result: ContentPackVisualStyle[] = []
  for (const entry of entries) {
    if (entry.value.kind !== 'visual-style' || !entry.pack) continue
    const previewPath = entry.value.preview_assets[0]
    const asset = entry.assets?.[previewPath]
    if (!asset) {
      console.warn(`[visual-style-loader] signed style has no verified preview asset: ${entry.value.id}`)
      continue
    }
    try {
      result.push(contentPackDocumentToVisualStyle(
        entry.value,
        assetUrl(entry.pack.pack_id, entry.pack.version, asset.asset_id),
      ))
    } catch { /* Unsupported categories remain registry metadata, not invented UI behavior. */ }
  }
  return result
}
