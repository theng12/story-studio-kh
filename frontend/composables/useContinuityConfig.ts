/**
 * Shape, defaults, and preset boundary for the per-episode continuity config
 * (`<episode_dir>/continuity.json`) edited on the Character Sheet page.
 *
 * Extracted from character-sheet.vue so the rules below are real, importable
 * code that tests exercise directly — a .vue SFC cannot be imported by
 * node:test, and the preset boundary is too easy to regress to leave it
 * asserted only by source greps.
 *
 * `continuityDefaults()`'s pacing comes from `DEFAULT_SCENE_PACING`
 * (`@shared/pacing`) — the same constant `defaultContinuityConfig()` in
 * electron/server/routes/continuity.ts imports — so the two can no longer
 * drift the way they did before (see contracts/pacing.ts for that history).
 */

import { DEFAULT_SCENE_PACING } from '@shared/pacing'

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
    pacing: { ...DEFAULT_SCENE_PACING },
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
 * A preset here is a LOOK plus the rhythm that look is usually cut at.
 * Anything that is really a per-episode decision the customer made
 * deliberately must not ride along inside one — the same boundary AGENTS.md
 * draws for Video Assembly presets and `title_image.image_path`.
 *
 * `pacing` IS NO LONGER EXCLUDED — reinstated 2026-08-18 at the owner's
 * explicit direction. It was excluded on 2026-08-03 after a preset's stored
 * 4–8s band silently overwrote a chosen 1–3s on 50 of 53 episodes. Shown that
 * history again, and offered a separate explicit bulk-pacing action that could
 * never fire as a side effect, the owner chose the full reversal: "Put pacing
 * back in presets." Scene rhythm now saves into a preset and applies with it.
 * See `applyContinuityPagePreset` for the half of the change that keeps the
 * reversal from re-running the original incident on already-saved presets.
 *
 * `use_episode_sheet` + `sheet` — STILL EXCLUDED, and the 2026-08-03 rule
 * still stands for them. Whether this episode uses its uploaded anchor image
 * (`img2img-references/master.png`) is episode state, not a channel look: an
 * episode that has no sheet uploaded must not be switched to "use the sheet"
 * because a style preset said so. Both names are stripped because
 * `normalizeContinuityConfig` ORs the legacy `references.sheet` mirror into
 * `use_episode_sheet` — excluding only one of them would leave the other to
 * flip the setting anyway. Within a continuity preset `sheet` occurs at
 * exactly one path, `references.sheet`, so the deep strip is precise (the
 * unrelated `character.references.images` lives on a different object entirely
 * and is never part of this payload).
 *
 * DELIBERATELY LEFT IN — these are genuinely reusable look data:
 *   `references.prev_render`  chain each render to the previous one
 *   `references.style`        use the style reference
 *   `style_bible` / `negative_prompt` / `denoise_strength` / `anchor_character_ids`
 * `references.characters` is left in too but cannot drift on its own: it is
 * re-derived from `anchor_character_ids.length` on every normalize.
 *
 * Because `usePresets` applies `excludeKeys` on read as well as write, presets
 * already saved carrying an excluded key stop restoring it without rewriting a
 * single stored file.
 *
 * The trailing entries are `usePresets`' own DEFAULT_EXCLUDE_KEYS: that
 * fallback only applies when `excludeKeys` is omitted entirely, so a page
 * passing its own list must keep carrying the per-episode identifiers.
 */
export const CONTINUITY_PRESET_EXCLUDE_KEYS = [
  'use_episode_sheet',
  'sheet',
  'episode_id', 'episodeId', 'episode', 'title',
]

/**
 * The scene rhythm a preset body actually STORES, or `null` when it stores none.
 *
 * Between 2026-08-03 and 2026-08-18 `pacing` was an excluded key, and
 * `usePresets` strips excluded keys on SAVE as well as on load — so every
 * preset saved in that window contains no `pacing` whatsoever. Those presets
 * far outnumber the older ones for anybody who kept working through August.
 *
 * A missing rhythm must mean "this preset has nothing to say about rhythm",
 * never "reset the rhythm". A half-written band is treated the same way: a
 * `pacing` object without both finite ends cannot express a range, and letting
 * it through would merge the preset's one end with `continuityDefaults()`'s
 * other end and produce a band nobody chose.
 */
export function storedPresetPacing(
  data: Partial<ContinuityConfig> | null | undefined,
): ContinuityConfig['pacing'] | null {
  const pacing = data?.pacing
  if (!pacing || typeof pacing !== 'object' || Array.isArray(pacing)) return null
  if (!Number.isFinite(pacing.min_sec) || !Number.isFinite(pacing.max_sec)) return null
  return pacing
}

/**
 * Fold an applied Character Sheet preset into the live config.
 *
 * Stripping an episode-specific key out of the preset is not sufficient on its
 * own: `normalizeContinuityConfig` would then fall back to its DEFAULT for
 * that key and still discard what the customer had — for the episode anchor
 * that fallback is `false`, which is just as wrong as `true` for someone who
 * had the anchor switched on. The live anchor is therefore carried across
 * explicitly, read through the same OR the normalizer uses so a config still
 * carrying only the legacy `references.sheet` mirror survives too.
 *
 * `pacing` (2026-08-18) now travels WITH the preset — but the identical trap
 * sits on this side of the reversal. Simply un-excluding the key would let
 * `normalizeContinuityConfig` fall back to the built-in `DEFAULT_SCENE_PACING`
 * band for every preset saved during the exclusion window, i.e. almost all of
 * them, silently resetting a customer's chosen rhythm to 1–3s. So the rule is
 * explicit in both directions: a preset that STORES a rhythm applies it; a
 * preset that stores none leaves the live rhythm exactly as it was. The
 * Character Sheet says which of the two happened, because a rhythm that does
 * not move looks identical to a feature that does not work.
 *
 * Normalizing explicitly also keeps retired Visual Recipe/composition fields
 * in older presets from silently returning to newly saved continuity configs.
 */
export function applyContinuityPagePreset(
  current: ContinuityConfig,
  data: Partial<ContinuityConfig> | null | undefined,
): ContinuityConfig {
  const pacing = JSON.parse(
    JSON.stringify(storedPresetPacing(data) ?? current.pacing),
  ) as ContinuityConfig['pacing']
  const keepEpisodeSheet = current.use_episode_sheet === true || current.references?.sheet === true
  return normalizeContinuityConfig({
    ...(data || {}),
    pacing,
    use_episode_sheet: keepEpisodeSheet,
    references: {
      ...(data?.references || continuityDefaults().references),
      sheet: keepEpisodeSheet,
    },
  })
}
