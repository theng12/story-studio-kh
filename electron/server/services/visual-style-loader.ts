import {
  listCatalogEntries,
  resolveCatalogItem,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { registryOptionsForCurrentJob } from '../content-packs/project-pins.js'
import {
  contentPackDocumentToVisualStyle,
  type ContentPackVisualStyle,
} from '../content-packs/legacy-adapters.js'

function assetUrl(packId: string, version: string, assetId: string): string {
  return `/api/content-packs/${encodeURIComponent(packId)}/${encodeURIComponent(version)}/assets/${encodeURIComponent(assetId)}`
}

function mapEntry(entry: Awaited<ReturnType<typeof resolveCatalogItem>>): ContentPackVisualStyle | null {
  if (!entry || entry.value.kind !== 'visual-style' || !entry.pack) return null
  const previewPath = entry.value.preview_assets[0]
  const asset = entry.assets?.[previewPath]
  if (!asset) return null
  return contentPackDocumentToVisualStyle(
    entry.value,
    assetUrl(entry.pack.pack_id, entry.pack.version, asset.asset_id),
  )
}

/** Resolve one signed style through the immutable current-job snapshot. */
export async function loadVisualStyle(
  id: string,
  options: ContentPackRegistryOptions = {},
): Promise<ContentPackVisualStyle | null> {
  const effectiveOptions = await registryOptionsForCurrentJob(['visual-style'], options)
  return mapEntry(await resolveCatalogItem(id, undefined, effectiveOptions))
}

/** Publish installed signed styles as renderer-safe records for visible discovery. */
export async function listVisualStyles(options: ContentPackRegistryOptions = {}): Promise<ContentPackVisualStyle[]> {
  const entries = await listCatalogEntries('visual-style', options)
  const result: ContentPackVisualStyle[] = []
  for (const entry of entries) {
    // Recovery entries can resolve an exact project pin, but are not customer
    // entitlements and must never appear as browseable library products.
    if (entry.source !== 'signed-installed') continue
    const mapped = mapEntry(entry)
    if (!mapped) {
      console.warn(`[visual-style-loader] signed style has no verified preview asset: ${entry.value.id}`)
      continue
    }
    result.push(mapped)
  }
  return result
}
