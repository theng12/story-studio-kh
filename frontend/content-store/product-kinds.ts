/**
 * The published Content Store wire kinds — ONE list, defining the type.
 *
 * WHY THIS IS ITS OWN MODULE. This list used to exist twice on the frontend:
 * once as the `ContentStoreProductKind` union in `useContentStore.ts`, and once
 * as a private array in `persisted-catalog.ts` used to validate the catalogue on
 * its way back off disk. The second copy had fallen behind the first — it never
 * learned `font_pack` — and its reader treats one unrecognised product as a
 * corrupt document (`parsePersistedCatalog` returns null), so a cache containing
 * a font pack was thrown away on every load.
 *
 * Deriving the union from the array means a kind cannot be added to the type
 * without appearing in the runtime list that every consumer validates against.
 * The backend keeps its own copy in `electron/server/lib/genstudio-content-store.ts`
 * (`PRODUCT_KINDS`) because the two sides cannot import across that boundary;
 * `genstudio-content-store-client.test.ts` pins the wire spelling for every kind
 * so the pair can be checked against one spelling.
 */
export const CONTENT_STORE_PRODUCT_KINDS = [
  'series_formula',
  'topic_pack',
  'visual_style',
  'thumbnail_recipe',
  'font_pack',
  'metadata_formula',
  'niche_bundle',
] as const

export type ContentStoreProductKind = (typeof CONTENT_STORE_PRODUCT_KINDS)[number]

/**
 * The wire kinds whose archive carries `preview_assets`.
 *
 * Three document kinds declare previews — `visual-style`, `thumbnail-recipe`
 * and `lettering-style` — and the Gateway maps the last of those to `font_pack`
 * (`gateway-kh/repository/gateway/content_delivery.py` `_WIRE_KIND_EXCEPTIONS`).
 * Every other kind ships no pictures at any point, so telling its owner
 * "previews appear after installing" would promise something installing cannot
 * deliver.
 */
const KINDS_WITH_PREVIEWS: readonly string[] = ['visual_style', 'thumbnail_recipe', 'font_pack']

export function contentStoreKindCanCarryPreviews(kind: ContentStoreProductKind): boolean {
  return KINDS_WITH_PREVIEWS.includes(kind)
}
