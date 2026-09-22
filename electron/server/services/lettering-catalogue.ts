/**
 * The thumbnail lettering catalogue: the app's own styles plus every style a
 * Content Pack has added.
 *
 * `FONT_STYLES` and `TEXT_STYLES` are hardcoded maps, so before this a pack
 * could not add a lettering style at all — which made a font pack unsellable,
 * whatever else was built around it. The owner's ask was plain: "i want it to
 * be packages i can sell. font package with image generated."
 *
 * A pack ships a phrase and its swatches; the prompt builder already turns a
 * phrase into an instruction for the image model. Nothing is composited
 * locally and no font file is involved — the model draws the letters, by the
 * owner's ruling.
 */
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'
import { listCatalogEntries } from '../content-packs/registry.js'
import type { ContentPackRegistryOptions } from '../content-packs/registry.js'

export type LetteringAxis = 'font' | 'text'

export interface LetteringCatalogueEntry {
  id: string
  axis: LetteringAxis
  /** What the prompt builder injects. The product itself. */
  phrase: string
  name: string
  description: string
  /** Where it came from, so the picker can say so and a buyer can see value. */
  source: 'built-in' | 'pack'
  packId: string | null
  /** In-pack asset paths for the rendered swatches; empty for built-ins, whose
   *  swatches are bundled with the app rather than shipped inside an archive. */
  previewAssets: readonly string[]
  /**
   * The app URL for this style's rendered swatch.
   *
   * A pack ships its swatches; without this the picker would ignore them and
   * try to generate a replacement through a paid image model, which is exactly
   * what buying the pack was meant to avoid.
   *
   * A built-in has no archive to ship one in, so its swatch is bundled in the
   * frontend build under /builtin-lettering-swatches/ -- the same arrangement
   * the built-in VISUAL styles already use for `preview_image`. Bundled, not
   * cached: the content-hash preview cache lives in per-machine userData, so a
   * swatch seeded there would exist only on the machine that seeded it and
   * every customer would still open the picker to thirty-five bare words.
   */
  previewUrl: string | null
}

function builtIns(): LetteringCatalogueEntry[] {
  const rows: LetteringCatalogueEntry[] = []
  for (const [axis, source] of [['font', FONT_STYLES], ['text', TEXT_STYLES]] as const) {
    for (const [id, phrase] of Object.entries(source)) {
      rows.push({
        id, axis, phrase,
        name: id.replace(/-/g, ' '),
        description: phrase,
        source: 'built-in',
        packId: null,
        previewAssets: [],
        previewUrl: `/builtin-lettering-swatches/${axis}-${id}.webp`,
      })
    }
  }
  return rows
}

/**
 * Built-ins first, then pack styles, and a pack may never take an id a
 * built-in already owns — the schema refuses that at authoring time, and this
 * refuses it again at read time so a pack authored against an older build
 * cannot shadow a style added since.
 */
export async function letteringCatalogue(
  options: ContentPackRegistryOptions = {},
): Promise<LetteringCatalogueEntry[]> {
  const rows = builtIns()
  const taken = new Set(rows.map(row => `${row.axis}:${row.id}`))
  for (const entry of await listCatalogEntries('lettering-style', options)) {
    const document = entry.value as {
      id?: unknown; axis?: unknown; phrase?: unknown
      name?: unknown; description?: unknown; preview_assets?: unknown
    }
    const id = typeof document.id === 'string' ? document.id : ''
    const axis = document.axis === 'font' || document.axis === 'text' ? document.axis : null
    const phrase = typeof document.phrase === 'string' ? document.phrase.trim() : ''
    if (!id || !axis || !phrase) continue
    const key = `${axis}:${id}`
    if (taken.has(key)) continue
    const previewAssets = Array.isArray(document.preview_assets)
      ? document.preview_assets.filter((value): value is string => typeof value === 'string')
      : []
    const previewAsset = entry.pack ? entry.assets?.[previewAssets[0] ?? ''] : undefined
    taken.add(key)
    rows.push({
      id, axis, phrase,
      name: typeof document.name === 'string' && document.name.trim() ? document.name.trim() : id,
      description: typeof document.description === 'string' ? document.description : phrase,
      source: 'pack',
      packId: entry.pack?.pack_id ?? null,
      previewAssets,
      previewUrl: previewAsset
        ? `/api/content-packs/${encodeURIComponent(entry.pack!.pack_id)}`
          + `/${encodeURIComponent(entry.pack!.version)}`
          + `/assets/${encodeURIComponent(previewAsset.asset_id)}`
        : null,
    })
  }
  return rows
}

/** The phrase for one style, from either source. Falls back to '' so a caller
 *  can decide what an unknown id means rather than being handed a wrong style. */
export async function letteringPhrase(
  axis: LetteringAxis,
  id: string,
  options: ContentPackRegistryOptions = {},
): Promise<string> {
  const rows = await letteringCatalogue(options)
  return rows.find(row => row.axis === axis && row.id === id)?.phrase || ''
}

export interface LetteringPhraseMaps {
  font: Record<string, string>
  text: Record<string, string>
}

/**
 * Every phrase the catalogue knows, keyed by axis and style id — built-ins and
 * installed packs alike.
 *
 * WHY THIS EXISTS. The thumbnail prompt builder is synchronous and used to
 * resolve a style id against the hardcoded `FONT_STYLES` / `TEXT_STYLES` maps
 * only. A pack's style id is not in those maps, so a bought lettering style
 * resolved to the built-in serif: the picker showed the swatch the customer
 * paid for and the image model was told to draw something else. The builder
 * cannot await the pack registry, so the resolution happens here, once per run,
 * and the caller hands the builder a map it can look up synchronously.
 *
 * Returning the whole map rather than a probe for two guessed ids matters: the
 * effective style may come from the request, from the recipe's own default, or
 * from `auto`, and this way the builder resolves whichever id it actually ends
 * up using without the caller having to predict it.
 */
export async function letteringPhraseMaps(
  options: ContentPackRegistryOptions = {},
): Promise<LetteringPhraseMaps> {
  const maps: LetteringPhraseMaps = { font: {}, text: {} }
  for (const row of await letteringCatalogue(options)) maps[row.axis][row.id] = row.phrase
  return maps
}
