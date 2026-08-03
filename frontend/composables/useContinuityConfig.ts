/**
 * Shape, defaults, and preset boundary for the per-episode continuity config
 * (`<episode_dir>/continuity.json`) edited on the Character Sheet page.
 *
 * Extracted from character-sheet.vue so the rules below are real, importable
 * code that tests exercise directly — a .vue SFC cannot be imported by
 * node:test, and the preset boundary is too easy to regress to leave it
 * asserted only by source greps.
 *
 * Keep `continuityDefaults()` in sync with `defaultContinuityConfig()` in
 * electron/server/routes/continuity.ts — both must produce the same fresh
 * episode rhythm.
 */

export interface ContinuityConfig {
  schema_version: 1
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  pacing: {
    min_sec: number
    max_sec: number
    opening_duration_sec?: number
    settled_min_sec?: number
    settled_max_sec?: number
  }
  references: { prev_render: boolean; sheet: boolean; characters: boolean; style: boolean }
  denoise_strength: number
  style_bible?: string
  negative_prompt?: string
  updated_at?: string
}

/** Whole-page preset body: the full config minus the transient timestamp. */
export type ContinuityPagePreset = Omit<ContinuityConfig, 'updated_at'>

export const PACING_PRESETS = [
  { id: 'rapid', min: 1, max: 3, label: '1–3 seconds — Rapid & lively' },
  { id: 'lively', min: 1, max: 4, label: '1–4 seconds — Lively storytelling' },
  { id: 'balanced', min: 3, max: 6, label: '3–6 seconds — Balanced narrative' },
  { id: 'cinematic', min: 2, max: 8, label: '2–8 seconds — Cinematic & robust' },
  { id: 'slow', min: 5, max: 10, label: '5–10 seconds — Slow & deliberate' },
  { id: 'contemplative', min: 8, max: 15, label: '8–15 seconds — Contemplative / ambient' },
] as const

export function continuityDefaults(): ContinuityConfig {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { min_sec: 1, max_sec: 4 },
    references: { prev_render: false, sheet: false, characters: false, style: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
  }
}

export function normalizeContinuityConfig(value?: Partial<ContinuityConfig> | null): ContinuityConfig {
  const d = continuityDefaults()
  const anchorIds = Array.isArray(value?.anchor_character_ids) ? [...value.anchor_character_ids] : []
  // Older pages exposed two controls for the same sheet choice. Reconcile
  // either legacy "on" value into the single compact control on load.
  const useEpisodeSheet = value?.use_episode_sheet === true || value?.references?.sheet === true
  return {
    ...d,
    schema_version: 1,
    anchor_character_ids: anchorIds,
    use_episode_sheet: useEpisodeSheet,
    pacing: { ...d.pacing, ...(value?.pacing || {}) },
    references: {
      prev_render: value?.references?.prev_render ?? d.references.prev_render,
      sheet: useEpisodeSheet,
      characters: anchorIds.length > 0,
      style: value?.references?.style ?? d.references.style,
    },
    denoise_strength: typeof value?.denoise_strength === 'number' ? value.denoise_strength : d.denoise_strength,
    style_bible: value?.style_bible || '',
    negative_prompt: value?.negative_prompt || '',
  }
}

/**
 * Keys stripped from Character Sheet presets on BOTH save and apply.
 *
 * A preset here is a LOOK. Anything that is really a per-episode decision the
 * customer made deliberately must not ride along inside one — the same
 * boundary AGENTS.md draws for Video Assembly presets and
 * `title_image.image_path`. Applying a look should change the look and
 * nothing else.
 *
 * `pacing` — a RHYTHM decision. The owner chose "1–3 seconds — Rapid &
 * lively", then applied a preset to change the ART STYLE, and the preset's
 * stored `pacing` silently replaced that choice. Every episode in the channel
 * ended up on the preset's 4–8s band (~6s midpoint) — exactly the 5.6–8s
 * scenes Scene Plan then produced from `continuity.json`.
 *
 * `use_episode_sheet` + `sheet` — the SAME defect, one field over. Whether
 * this episode uses its uploaded anchor image (`img2img-references/master.png`)
 * is episode state, not a channel look: an episode that has no sheet uploaded
 * must not be switched to "use the sheet" because a style preset said so.
 * Both names are stripped because `normalizeContinuityConfig` ORs the legacy
 * `references.sheet` mirror into `use_episode_sheet` — excluding only one of
 * them would leave the other to flip the setting anyway. Within a continuity
 * preset `sheet` occurs at exactly one path, `references.sheet`, so the deep
 * strip is precise (the unrelated `character.references.images` lives on a
 * different object entirely and is never part of this payload).
 *
 * DELIBERATELY LEFT IN — these are genuinely reusable look data:
 *   `references.prev_render`  chain each render to the previous one
 *   `references.style`        use the style reference
 *   `style_bible` / `negative_prompt` / `denoise_strength` / `anchor_character_ids`
 * `references.characters` is left in too but cannot drift on its own: it is
 * re-derived from `anchor_character_ids.length` on every normalize.
 *
 * Because `usePresets` applies `excludeKeys` on read as well as write, presets
 * already saved carrying these keys stop restoring them without rewriting a
 * single stored file.
 *
 * The trailing entries are `usePresets`' own DEFAULT_EXCLUDE_KEYS: that
 * fallback only applies when `excludeKeys` is omitted entirely, so a page
 * passing its own list must keep carrying the per-episode identifiers.
 */
export const CONTINUITY_PRESET_EXCLUDE_KEYS = [
  'pacing',
  'use_episode_sheet',
  'sheet',
  'episode_id', 'episodeId', 'episode', 'title',
]

/**
 * Fold an applied Character Sheet preset into the live config.
 *
 * Stripping the episode-specific keys out of the preset is not sufficient on
 * its own: `normalizeContinuityConfig` would then fall back to its DEFAULT for
 * each one and still discard what the customer had. For `pacing` that fallback
 * is the built-in 1–4s band; for the episode anchor it is `false`, which is
 * just as wrong as `true` for someone who had the anchor switched on. Both
 * live values are therefore carried across explicitly, so applying a look
 * leaves the rhythm and the anchor exactly as they were.
 *
 * The anchor is read through the same OR the normalizer uses, so a config
 * still carrying only the legacy `references.sheet` mirror survives too.
 *
 * Normalizing explicitly also keeps retired Visual Recipe/composition fields
 * in older presets from silently returning to newly saved continuity configs.
 */
export function applyContinuityPagePreset(
  current: ContinuityConfig,
  data: Partial<ContinuityConfig> | null | undefined,
): ContinuityConfig {
  const keepPacing = JSON.parse(JSON.stringify(current.pacing)) as ContinuityConfig['pacing']
  const keepEpisodeSheet = current.use_episode_sheet === true || current.references?.sheet === true
  return normalizeContinuityConfig({
    ...(data || {}),
    pacing: keepPacing,
    use_episode_sheet: keepEpisodeSheet,
    references: {
      ...(data?.references || continuityDefaults().references),
      sheet: keepEpisodeSheet,
    },
  })
}
