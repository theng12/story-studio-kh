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
 *   startingSceneSeconds → config.json `default_scene_pacing` (the pacing an
 *                         episode starts with until it saves its own)
 */

import * as pm from './project-manager.js'
import { parseScenePacing, type ScenePacing } from '../contracts/pacing.js'
import type { Niche } from '../models/types.js'

export function startingDefaultsFromFormula(niche: Pick<Niche, 'visualStyleHint' | 'startingSceneSeconds'> | null | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  const look = niche?.visualStyleHint?.trim()
  if (look) defaults.default_style_bible = look
  const seconds = niche?.startingSceneSeconds
  if (Array.isArray(seconds) && seconds.length === 2) {
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
