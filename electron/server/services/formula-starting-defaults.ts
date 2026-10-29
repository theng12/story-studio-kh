/**
 * What a NEW channel starts with, taken from its Series Formula.
 *
 * A Formula knows its own look and its own rhythm: a sleep channel wants soft,
 * dreamlike pictures held for 20–30 seconds, not the app-wide "cohesive,
 * grounded" look at 1–3 seconds (≈ 2,700–8,000 images for a two-hour episode).
 * These values are COPIED into the new channel's own settings once, at
 * creation, and are ordinary editable settings from then on. Nothing is read
 * from the Formula at generation time and nothing is written to an existing
 * channel, so a channel's saved look and pacing are never overwritten.
 *
 *   visualStyleHint     → config.json `default_style_bible` (Scene Plan's
 *                         "Channel default style"; Thumbnail Prompts seeds
 *                         its style text from it)
 *   startingScenePacing → config.json `default_scene_pacing`, when the Formula
 *                         declares a tiered rhythm (the Sleep tiers, owner
 *                         2026-10-26): slow down as the episode lengthens
 *   visualPacingProfile → config.json `default_scene_pacing`, when the Formula
 *                         declares a two-phase profile instead (a short opening
 *                         band, then a settled one). This is the Formula's own
 *                         scene density; a Quote Shorts channel must open on
 *                         2–4 s scenes for its first 6 s, not on the long-form
 *                         5–10 s tiers (Production, 2026-10-29).
 *   startingSceneSeconds → config.json `default_scene_pacing`, when it declares
 *                         only one band; ignored when either of the above is
 *                         present
 *   scriptStructure      → config.json `episode_length` when it declares a
 *                         seconds-precision length range (Quote Shorts, owner
 *                         2026-10-29): each NEW episode's length is drawn once
 *                         inside the range instead of copying one fixed figure
 *
 * The rhythm is also seeded as a Scene Plan preset the channel builds on. A
 * new channel already gets the app-wide "Owner standard pacing" preset marked
 * last-used (project-manager.ts); Scene Plan's run route prefers the active
 * preset's pacing (the owner's explicit choice), so without a Formula-owned
 * preset the long-form tiers would win over the Formula's profile. The Formula
 * preset is appended for the new channel only — a stored preset or channel is
 * never rewritten.
 */

import * as pm from './project-manager.js'
import { parseScenePacing, type ScenePacing } from '../contracts/pacing.js'
import { episodeLengthSettingFromScript } from '../lib/episode-length.js'
import type { Niche } from '../models/types.js'

type StartingDefaultsSource = Pick<
  Niche,
  'visualStyleHint' | 'startingSceneSeconds' | 'startingScenePacing' | 'scriptStructure'
>

function validBand(band: unknown): band is { min_sec: number; max_sec: number } {
  if (!band || typeof band !== 'object') return false
  const { min_sec, max_sec } = band as Record<string, unknown>
  return typeof min_sec === 'number' && typeof max_sec === 'number'
    && Number.isFinite(min_sec) && Number.isFinite(max_sec)
    && min_sec >= 1 && max_sec <= 60 && max_sec >= min_sec
}

/**
 * A Formula's two-phase visual profile as the one `variable` pacing shape Scene
 * Plan's Visual timing & motion panel writes. Returns null for a profile the
 * pacing contract would refuse, so a bad Formula degrades to the flat band
 * rather than failing channel creation.
 */
function scenePacingFromVisualProfile(
  profile: NonNullable<Niche['scriptStructure']>['visualPacingProfile'],
): ScenePacing | null {
  if (!profile) return null
  const openingSeconds = profile.opening_duration_sec
  if (typeof openingSeconds !== 'number' || !Number.isFinite(openingSeconds) || openingSeconds < 0) return null
  if (!validBand(profile.opening) || !validBand(profile.settled)) return null
  const periods = openingSeconds === 0
    ? [{ start_sec: 0, end_sec: null, min_sec: profile.settled.min_sec, max_sec: profile.settled.max_sec }]
    : [
        { start_sec: 0, end_sec: openingSeconds, min_sec: profile.opening.min_sec, max_sec: profile.opening.max_sec },
        { start_sec: openingSeconds, end_sec: null, min_sec: profile.settled.min_sec, max_sec: profile.settled.max_sec },
      ]
  return { mode: 'variable', min_sec: periods[0]!.min_sec, max_sec: periods[0]!.max_sec, periods }
}

/** The starting rhythm a Formula declares, most specific first. */
export function startingPacingFromFormula(niche: StartingDefaultsSource | null | undefined): ScenePacing | null {
  if (niche?.startingScenePacing) {
    // Tiers describe the whole episode, so they are the more specific choice.
    return structuredClone(parseScenePacing(niche.startingScenePacing))
  }
  const profile = scenePacingFromVisualProfile(niche?.scriptStructure?.visualPacingProfile)
  if (profile) return profile
  if (Array.isArray(niche?.startingSceneSeconds) && niche.startingSceneSeconds.length === 2) {
    const seconds = niche.startingSceneSeconds
    return { min_sec: seconds[0]!, max_sec: seconds[1]! }
  }
  return null
}

export function startingDefaultsFromFormula(niche: StartingDefaultsSource | null | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  const look = niche?.visualStyleHint?.trim()
  if (look) defaults.default_style_bible = look
  const pacing = startingPacingFromFormula(niche)
  if (pacing) defaults.default_scene_pacing = pacing
  // 1.4.369 — a Formula that declares a seconds-precision length range (Quote
  // Shorts: 10–60 s) seeds the channel's own copy. From then on it is an
  // ordinary editable setting — the channel can change the range or switch the
  // per-episode draw off — and each NEW episode's length is drawn from it once
  // (services/episode-length.ts). A channel created before this has no copy and
  // reads the Formula live, so it needs no migration.
  const episodeLength = episodeLengthSettingFromScript(niche?.scriptStructure)
  if (episodeLength) defaults.episode_length = episodeLength
  return defaults
}

/**
 * The Scene Plan preset a new channel starts on when its Formula declares a
 * rhythm. Named from the Formula so the channel's own list says where the
 * rhythm came from; it carries no model (a live GenStudio choice, AGENTS.md
 * §1) and is an ordinary editable preset from the moment the channel exists.
 */
export function formulaPacingPreset(
  niche: Pick<Niche, 'id' | 'name'>,
  pacing: ScenePacing,
): { id: string; name: string; type: 'scene-plan'; data: { pacing: ScenePacing } } {
  return {
    id: `preset-${niche.id}-pacing`,
    name: `${niche.name} formula pacing`,
    type: 'scene-plan',
    data: { pacing: structuredClone(pacing) },
  }
}

/** Best effort: a channel without these defaults behaves exactly as before. */
export async function seedFormulaStartingDefaults(slug: string, niche: Niche | null | undefined): Promise<void> {
  const defaults = startingDefaultsFromFormula(niche)
  if (!Object.keys(defaults).length) return
  const pacing = defaults.default_scene_pacing as ScenePacing | undefined
  if (pacing && niche?.id && niche?.name) {
    const preset = formulaPacingPreset(niche, pacing)
    const config = (await pm.getConfig(slug)) as Record<string, unknown> | null
    const presets = Array.isArray(config?.scene_plan_presets) ? config!.scene_plan_presets as Array<Record<string, unknown>> : []
    // Creation-time only. A preset already stored under this id is left
    // exactly as it is; the Formula only adds its own starting rhythm.
    if (!presets.some(entry => entry?.id === preset.id)) {
      defaults.scene_plan_presets = [...presets, preset]
    }
    defaults['scene_plan_last_preset_scene-plan'] = preset.id
  }
  await pm.updateConfig(slug, defaults as any)
}

/** The channel's starting scene pacing, or undefined to use the app default. */
export async function readProjectStartingPacing(slug: string): Promise<ScenePacing | undefined> {
  try {
    const raw = ((await pm.getConfig(slug)) as any)?.default_scene_pacing
    return raw === undefined ? undefined : parseScenePacing(raw)
  } catch {
    return undefined
  }
}
