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
 *   startingSceneSeconds → config.json `default_scene_pacing`, when it declares
 *                         only one band; ignored when tiers are present
 */

import * as pm from './project-manager.js'
import { parseScenePacing, type ScenePacing } from '../contracts/pacing.js'
import type { Niche } from '../models/types.js'

export function startingDefaultsFromFormula(niche: Pick<Niche, 'visualStyleHint' | 'startingSceneSeconds' | 'startingScenePacing'> | null | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  const look = niche?.visualStyleHint?.trim()
  if (look) defaults.default_style_bible = look
  if (niche?.startingScenePacing) {
    // Tiers describe the whole episode, so they are the more specific choice;
    // a Formula that declares both starts on its tiers, not its first band.
    defaults.default_scene_pacing = structuredClone(parseScenePacing(niche.startingScenePacing))
  } else if (Array.isArray(niche?.startingSceneSeconds) && niche.startingSceneSeconds.length === 2) {
    const seconds = niche.startingSceneSeconds
    defaults.default_scene_pacing = { min_sec: seconds[0], max_sec: seconds[1] }
  }
  return defaults
}

/** Best effort: a channel without these defaults behaves exactly as before. */
export async function seedFormulaStartingDefaults(slug: string, niche: Niche | null | undefined): Promise<void> {
  const defaults = startingDefaultsFromFormula(niche)
  if (Object.keys(defaults).length) await pm.updateConfig(slug, defaults as any)
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
