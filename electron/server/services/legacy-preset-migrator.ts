/**
 * Legacy video_assembly preset migrator (v1.0.71+).
 *
 * Pre-v1.0.64 video_assembly presets stored fields flat at the top of
 * `data`. v1.0.68+ presets use the bundle shape with five slot
 * snapshots under `data.fallback.{intro,timeline,effects,subtitles,export}`.
 * The flatten function in routes/pipeline.ts handles legacy shapes at
 * runtime via a passthrough, but the saved JSON stays in the old shape
 * forever — there's no automatic cleanup.
 *
 * This module provides a one-shot migrator: given a stored preset, if
 * it's in the legacy flat shape it returns a bundlified copy. Pure
 * function, no I/O, easy to unit-test. The caller decides when to
 * persist the migrated copy back (typically a Settings → Storage
 * button or a one-time scan endpoint).
 *
 * Slot assignment mirrors the keys flattenVideoAssemblyBundle reads:
 *   export    → resolution, quality, fps, encoding_effort, codec, format
 *   timeline  → scene_recycling, duration, post_audio, transition,
 *               scene_animation, transition_pool, transition_randomize,
 *               animation_pool, animation_randomize, title_image
 *   effects   → logo, color_grading, vignette, film_grain, letterbox,
 *               chroma_key, overlays, chapter_titles, title_card,
 *               outro_card, compilation_layout, exclude_intro_from_effects,
 *               align_visuals_to_chapters
 *   intro     → intro
 *   outro     → outro
 *   subtitles → subtitles
 */

export interface StoredPreset {
  id: string
  name: string
  data?: any
  type?: string
  [k: string]: any
}

const EXPORT_KEYS = ['resolution', 'quality', 'fps', 'encoding_effort', 'codec', 'format']
const TIMELINE_KEYS = [
  'scene_recycling', 'duration', 'post_audio',
  'transition', 'transition_pool', 'transition_randomize',
  'scene_animation', 'animation_pool', 'animation_randomize',
  'title_image',
]
const EFFECTS_KEYS = [
  'logo', 'color_grading', 'vignette', 'film_grain', 'letterbox',
  'chroma_key', 'overlays', 'chapter_titles', 'title_card', 'outro_card',
  'compilation_layout', 'exclude_intro_from_effects', 'align_visuals_to_chapters',
  'video_layout', 'background_plate', 'foreground_defaults',
]
const INTRO_KEYS = ['intro']
const OUTRO_KEYS = ['outro']
const SUBTITLES_KEYS = ['subtitles']

const ALL_LEGACY_KEYS = new Set([
  ...EXPORT_KEYS, ...TIMELINE_KEYS, ...EFFECTS_KEYS,
  ...INTRO_KEYS, ...OUTRO_KEYS, ...SUBTITLES_KEYS,
])

/**
 * True iff `preset.data` looks like the legacy flat shape (no
 * `fallback` block but at least one known generator-shape field at
 * the top level). Mirrors the detection in
 * `flattenVideoAssemblyBundle`'s passthrough.
 */
export function isLegacyVideoAssemblyPreset(preset: StoredPreset | undefined): boolean {
  if (!preset?.data || typeof preset.data !== 'object') return false
  if (preset.data.fallback) return false
  for (const key of Object.keys(preset.data)) {
    if (ALL_LEGACY_KEYS.has(key)) return true
  }
  return false
}

/**
 * Rewrite a legacy flat preset into the v1.0.68 bundle shape. Returns
 * a NEW preset object — does not mutate the input. When the input
 * isn't legacy (already a bundle, or empty), returns `null` so the
 * caller can short-circuit without writing.
 *
 * Unknown top-level keys (anything not in the slot maps) pass through
 * onto the bundle's top-level alongside `fallback`. This is defensive:
 * a future preset shape change won't lose data.
 */
export function bundlifyLegacyVideoAssemblyPreset(preset: StoredPreset): StoredPreset | null {
  if (!isLegacyVideoAssemblyPreset(preset)) return null
  const data = preset.data as Record<string, any>

  const exportSlot: Record<string, any> = {}
  const timelineSlot: Record<string, any> = {}
  const effectsSlot: Record<string, any> = {}
  const introSlot: Record<string, any> = {}
  const outroSlot: Record<string, any> = {}
  const subtitlesSlot: Record<string, any> = {}
  const passthrough: Record<string, any> = {}

  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue
    if (EXPORT_KEYS.includes(k)) {
      exportSlot[k] = v
    } else if (TIMELINE_KEYS.includes(k)) {
      timelineSlot[k] = v
    } else if (EFFECTS_KEYS.includes(k)) {
      effectsSlot[k] = v
    } else if (k === 'intro') {
      Object.assign(introSlot, v && typeof v === 'object' ? v : { value: v })
    } else if (k === 'outro') {
      Object.assign(outroSlot, v && typeof v === 'object' ? v : { value: v })
    } else if (k === 'subtitles') {
      Object.assign(subtitlesSlot, v && typeof v === 'object' ? v : { value: v })
    } else {
      // Unknown key — preserve at the top of `data` so nothing is lost.
      passthrough[k] = v
    }
  }

  const fallback: Record<string, any> = {}
  if (Object.keys(introSlot).length)     fallback.intro     = introSlot
  if (Object.keys(outroSlot).length)     fallback.outro     = outroSlot
  if (Object.keys(timelineSlot).length)  fallback.timeline  = timelineSlot
  if (Object.keys(effectsSlot).length)   fallback.effects   = effectsSlot
  if (Object.keys(subtitlesSlot).length) fallback.subtitles = subtitlesSlot
  if (Object.keys(exportSlot).length)    fallback.export    = exportSlot

  return {
    ...preset,
    data: { ...passthrough, fallback },
  }
}

export interface MigrationScanResult {
  total_presets: number
  legacy_presets: Array<{ id: string; name: string }>
}

export interface MigrationResult {
  migrated: Array<{ id: string; name: string }>
  skipped: Array<{ id: string; reason: string }>
}

/**
 * Scan a project's video_bundle_presets list for legacy-shape presets.
 * Returns the count + a summary list. Does not mutate.
 */
export function scanForLegacyVideoAssemblyPresets(config: any): MigrationScanResult {
  const list: StoredPreset[] = Array.isArray(config?.video_bundle_presets)
    ? config.video_bundle_presets : []
  const legacy = list.filter(isLegacyVideoAssemblyPreset).map(p => ({ id: p.id, name: p.name }))
  return { total_presets: list.length, legacy_presets: legacy }
}

/**
 * Rewrite every legacy preset in a project's video_bundle_presets list
 * to the bundle shape. Returns a NEW config object (caller decides
 * when to write it back). Bundles + non-legacy presets pass through
 * unchanged.
 */
export function migrateAllLegacyVideoAssemblyPresets(config: any): {
  config: any
  result: MigrationResult
} {
  const list: StoredPreset[] = Array.isArray(config?.video_bundle_presets)
    ? [...config.video_bundle_presets] : []
  const migrated: MigrationResult['migrated'] = []
  const skipped: MigrationResult['skipped'] = []

  const next: StoredPreset[] = list.map((p) => {
    if (!isLegacyVideoAssemblyPreset(p)) {
      return p
    }
    try {
      const bundled = bundlifyLegacyVideoAssemblyPreset(p)
      if (!bundled) {
        skipped.push({ id: p.id, reason: 'not legacy after detection (race?)' })
        return p
      }
      migrated.push({ id: p.id, name: p.name })
      return bundled
    } catch (e: any) {
      skipped.push({ id: p.id, reason: e?.message || String(e) })
      return p
    }
  })

  return {
    config: { ...config, video_bundle_presets: next },
    result: { migrated, skipped },
  }
}
