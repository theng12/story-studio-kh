import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { parseSketchLineWeight, type SketchLineWeight } from '../lib/sketch-line-weight.js'
import { episodeDir, EpisodeSettingFileUnreadable } from './episode-sketch-pen.js'

/**
 * An episode's own Sketch Draw line weight, stored exactly like its pen, hold and reveal: a file
 * of its own in the episode's folder (`sketch_line_weight.json`), the SELECTION only, `weight:
 * null` meaning "use the channel default" (written rather than deleting the file). Presets and
 * whole-config saves never touch it.
 *
 * It is per episode because the ink weight is an editorial choice about ONE episode's look, the
 * same way the reveal is. The channel value is only the starting default for an episode that has
 * none.
 */
export const EPISODE_SKETCH_LINE_WEIGHT_FILENAME = 'sketch_line_weight.json'

/** The episode's own weight, or null when it follows the channel. A malformed file throws: it is not "normal". */
export async function readEpisodeSketchLineWeight(slug: string, episodeId: string): Promise<SketchLineWeight | null> {
  const file = path.join(await episodeDir(slug, episodeId), EPISODE_SKETCH_LINE_WEIGHT_FILENAME)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new EpisodeSettingFileUnreadable(`This episode's line weight setting file (${EPISODE_SKETCH_LINE_WEIGHT_FILENAME} for ${episodeId}) is malformed and cannot be read. Choose its line weight again in Motion Review to rewrite it.`) }
  const weight = (value as { weight?: unknown } | null)?.weight
  if (weight === null) return null
  const parsed = parseSketchLineWeight(weight)
  if (!parsed.ok) throw new EpisodeSettingFileUnreadable(`This episode's line weight setting file (${EPISODE_SKETCH_LINE_WEIGHT_FILENAME} for ${episodeId}) holds something that is not a valid line weight. Choose its line weight again in Motion Review to rewrite it.`)
  return parsed.weight
}

/** Set the episode's weight, or pass null to follow the channel default again. Returns what was stored. */
export async function writeEpisodeSketchLineWeight(slug: string, episodeId: string, weight: unknown): Promise<SketchLineWeight | null> {
  let stored: SketchLineWeight | null = null
  if (weight !== null) {
    const parsed = parseSketchLineWeight(weight)
    if (!parsed.ok) throw new Error(parsed.error)
    stored = parsed.weight
  }
  const dir = await episodeDir(slug, episodeId)
  // Never create an episode folder just to hold a setting.
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`Episode ${episodeId} has no folder yet.`)
  const file = path.join(dir, EPISODE_SKETCH_LINE_WEIGHT_FILENAME)
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, weight: stored, updated_at: new Date().toISOString() })
  })
  return stored
}
