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
  const pack = entry.pack
  // Every verified preview, hero first (owner, 2026-10-24: at least three per style). The hero
  // stays `preview_image` too: older readers, and the card's first image, use it.
  const previews = entry.value.preview_assets.flatMap(previewPath => {
    const asset = entry.assets?.[previewPath]
    return asset ? [assetUrl(pack.pack_id, pack.version, asset.asset_id)] : []
  })
  if (!entry.assets?.[entry.value.preview_assets[0]]) return null
  return contentPackDocumentToVisualStyle(entry.value, previews[0]!, previews)
}

/** Resolve one signed style through the immutable current-job snapshot. */
export async function loadVisualStyle(
  id: string,
  options: ContentPackRegistryOptions = {},
): Promise<ContentPackVisualStyle | null> {
  const effectiveOptions = await registryOptionsForCurrentJob(['visual-style'], options)
  return mapEntry(await resolveCatalogItem(id, undefined, effectiveOptions))
}

/**
 * The Style Library list: what the installed Content Packs publish.
 *
 * Owner ruling, 2026-10-29 — "no custom, no built in, all from packs". The
 * owner's own user style packs are no longer listed here, and nothing is
 * deleted or rewritten: their styles keep resolving for every channel that
 * already carries their text, and a stored legacy preset id reads the Store
 * style that owns the look through `aliasedVisualStyleId` (art-style-resolver).
 */
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
