/**
 * The ids of the metadata formulas the app ships.
 *
 * Built-in formulas are ordinary metadata-formula documents validated by the
 * ordinary content-pack schema, so they carry qualified reverse-DNS ids exactly
 * as a bought formula does — which is what makes the eventual cutover to
 * signed-packs-only a deletion rather than a migration: the ids do not change,
 * only where the document comes from.
 *
 * Because the namespaces are identical, a pack COULD otherwise claim a
 * built-in's id and silently shadow it. This list is what the schema refuses
 * that with. It lives in its own leaf module so the schema can import it
 * without reading the filesystem at import time; the loader asserts the shipped
 * directory and this list still agree.
 */
export const BUILT_IN_METADATA_FORMULA_IDS = [
  'com.storystudio.metadata-formula.story-first-calm',
  'com.storystudio.metadata-formula.curiosity-gap',
  'com.storystudio.metadata-formula.chapters-first',
  'com.storystudio.metadata-formula.community-first',
  'com.storystudio.metadata-formula.minimal',
] as const

export type BuiltInMetadataFormulaId = typeof BUILT_IN_METADATA_FORMULA_IDS[number]
