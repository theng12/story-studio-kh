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

import { DEFAULT_SCENE_PACING, parseScenePacing, type ScenePacing } from '@shared/pacing'
import { normalizeMotionScope, type MotionScope } from '@shared/motion-scope'
import { DEFAULT_EXCLUDE_KEYS } from './usePresets'

export interface ContinuityConfig {
  schema_version: 1
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  pacing: ScenePacing
  motion_scope: MotionScope
  motion_level: number
  references: {
    prev_render: boolean
    sheet: boolean
    characters: boolean
    style: boolean
    /**
     * The composition template (`img2img-references/composition.png`) — the
     * LAYOUT every scene is structured against, attached as an img2img
     * reference on every scene when on.
     *
     * Restored 2026-08-27 at the owner's explicit direction ("composition UI,
     * yeah we should restore it"). The backend never lost it: the type, the
     * default, the POST normalizer, the generator and the generate/delete
     * routes all stayed. Only this key was missing from the frontend shape,
     * and because `normalizeContinuityConfig` rebuilds `references` field by
     * field, its absence here silently dropped the flag on every load and
     * every save — the whole feature was unreachable through one missing line.
     */
    composition: boolean
  }
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
  { id: 'drifting', min: 12, max: 20, label: '12–20 seconds — Drifting' },
  { id: 'sleep-slow', min: 20, max: 30, label: '20–30 seconds — Slow drift' },
  { id: 'sleep-very-slow', min: 30, max: 45, label: '30–45 seconds — Very slow' },
  { id: 'near-still', min: 45, max: 60, label: '45–60 seconds — Near-still' },
] as const

export function continuityDefaults(): ContinuityConfig {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { ...DEFAULT_SCENE_PACING },
    motion_scope: { mode: 'off' },
    motion_level: 2,
    references: { prev_render: false, sheet: false, characters: false, style: false, composition: false },
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
    pacing: parseScenePacing(value?.pacing),
    motion_scope: normalizeMotionScope(value?.motion_scope),
    motion_level: typeof value?.motion_level === 'number' && Number.isInteger(value.motion_level)
      && value.motion_level >= 1 && value.motion_level <= 4
      ? value.motion_level
      : d.motion_level,
    references: {
      prev_render: value?.references?.prev_render ?? d.references.prev_render,
      sheet: useEpisodeSheet,
      characters: anchorIds.length > 0,
      style: value?.references?.style ?? d.references.style,
      composition: value?.references?.composition ?? d.references.composition,
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
 * customer made deliberately must not ride along inside one — the same boundary
 * AGENTS.md draws for Video Assembly presets and `title_image.image_path`.
 *
 * `pacing` IS EXCLUDED — put back in the list by the owner on 2026-10-17.
 * Read the whole history before touching this line: it has moved twice, and
 * only the newest direction is in force.
 *
 *   2026-08-03  EXCLUDED. A preset's stored 4–8s band silently replaced a
 *               chosen 1–3s on 50 of 53 episodes of a live project.
 *   2026-08-18  REINSTATED by the owner, incident in front of him: "Put pacing
 *               back in presets." Character Sheet presets carried rhythm again,
 *               and the page announced which of the two had happened.
 *   2026-10-17  EXCLUDED again, by the owner, because the timing editor moved.
 *               Scene rhythm belongs to Scene Plan's "Visual timing & motion"
 *               panel and is read back by Scene Review; the Character Sheet is
 *               a visual-setup page that neither shows nor owns it. A preset
 *               applied there must not move an episode's rhythm. That is why
 *               the notice the page used to carry is DELETED rather than
 *               reworded — with the key excluded there is nothing left for it
 *               to report, and a notice describing a setting this page no
 *               longer owns is the leftover the owner asked to be cleaned up.
 *
 * What the 2026-10-17 rule does NOT do: it never rewrites a stored preset.
 * `continuity_page_presets` on disk that still carry a `pacing` block keep it
 * byte-for-byte; it is stripped at the boundary — on the way in, before `apply`
 * ever sees it — exactly as `usePresets` already treats the anchor keys.
 * `applyContinuityPagePreset` is the other half: the live rhythm is carried
 * across an apply explicitly, so `normalizeContinuityConfig`'s
 * `DEFAULT_SCENE_PACING` can never be what a preset leaves behind.
 *
 * `use_episode_sheet` + `sheet` — excluded, unchanged since 2026-08-03.
 * Whether this episode uses its uploaded anchor image
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
 * `motion_scope` is excluded for the same episode-state reason, and
 * `motion_level` is carried across the apply rather than excluded (an older
 * preset without one must not reset the live choice).
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
  'motion_scope',
  // 2026-10-17 — Scene Plan owns the episode's rhythm; see the history above.
  'pacing',
  // Spread rather than re-typed: v1.4.205 exported the list after a caller
  // re-typing it (which is how a page silently loses the per-episode guards).
  ...DEFAULT_EXCLUDE_KEYS,
]

/**
 * The scene rhythm a preset body actually STORES, or `null` when it stores none.
 *
 * The caller is the Scene Plan **Visual timing & motion** panel
 * (`frontend/components/VisualTimingMotion.vue`), which owns the episode's
 * rhythm and its own preset — the one surface where a stored rhythm still has
 * authority (owner, 2026-10-17). The Character Sheet deliberately does not call
 * this any more: `pacing` is excluded from `continuity_page_presets`, so a
 * preset reaching that page has no rhythm to report and nothing to apply.
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
 * `pacing` is carried across the same way, and for the same reason, since the
 * owner put it back in the exclusion list on 2026-10-17. Reading it off `data`
 * is already impossible — `usePresets` strips it before `apply` runs — but the
 * explicit carry is what makes the *preserve* half real rather than incidental:
 * without it `normalizeContinuityConfig` would substitute `DEFAULT_SCENE_PACING`
 * (1–3s) for every preset, which is the original 2026-08-03 incident with the
 * sign flipped. It is deep-cloned as one whole value rather than merged field
 * by field, so an extended profile (ordered periods, `settled_*` holds) survives
 * intact and a half-written band can never be completed from the default.
 *
 * `motion_level` is carried the same way — an older preset without one must not
 * reset the live intensity — while `motion_scope` is excluded outright as
 * episode state.
 *
 * Normalizing explicitly also keeps retired composition fields in older
 * presets from silently returning to newly saved continuity configs.
 */
export function applyContinuityPagePreset(
  current: ContinuityConfig,
  data: Partial<ContinuityConfig> | null | undefined,
): ContinuityConfig {
  const pacing = JSON.parse(
    JSON.stringify(current.pacing),
  ) as ContinuityConfig['pacing']
  const keepEpisodeSheet = current.use_episode_sheet === true || current.references?.sheet === true
  const motionLevel = typeof data?.motion_level === 'number'
    && Number.isInteger(data.motion_level)
    && data.motion_level >= 1
    && data.motion_level <= 4
    ? data.motion_level
    : current.motion_level
  return normalizeContinuityConfig({
    ...(data || {}),
    pacing,
    motion_scope: current.motion_scope,
    motion_level: motionLevel,
    use_episode_sheet: keepEpisodeSheet,
    references: {
      ...(data?.references || continuityDefaults().references),
      sheet: keepEpisodeSheet,
    },
  })
}
