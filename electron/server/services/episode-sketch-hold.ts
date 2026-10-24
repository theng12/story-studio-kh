import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { parseSketchHold, type SketchHoldSetting } from '../lib/sketch-hold.js'
import { episodeDir } from './episode-sketch-pen.js'

/**
 * An episode's own Sketch Draw closing hold, stored exactly like its pen: a file of its own in the
 * episode's folder (`sketch_hold.json`), the SELECTION only, `hold: null` meaning "use the channel
 * default" (written rather than deleting the file). Presets and whole-config saves never touch it.
 */
export const EPISODE_SKETCH_HOLD_FILENAME = 'sketch_hold.json'

/** The episode's own hold, or null when it follows the channel. A malformed file throws: it is not "auto". */
export async function readEpisodeSketchHold(slug: string, episodeId: string): Promise<SketchHoldSetting | null> {
  const file = path.join(await episodeDir(slug, episodeId), EPISODE_SKETCH_HOLD_FILENAME)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new Error(`${EPISODE_SKETCH_HOLD_FILENAME} for ${episodeId} is malformed. Choose this episode's closing hold again in Motion Review.`) }
  const hold = (value as { hold?: unknown } | null)?.hold
  if (hold === null) return null
  const parsed = parseSketchHold(hold)
  if (!parsed.ok) throw new Error(`${EPISODE_SKETCH_HOLD_FILENAME} for ${episodeId} is not a valid hold. Choose this episode's closing hold again in Motion Review.`)
  return parsed.hold
}

/** Set the episode's hold, or pass null to follow the channel default again. Returns what was stored. */
export async function writeEpisodeSketchHold(slug: string, episodeId: string, hold: unknown): Promise<SketchHoldSetting | null> {
  let stored: SketchHoldSetting | null = null
  if (hold !== null) {
    const parsed = parseSketchHold(hold)
    if (!parsed.ok) throw new Error(parsed.error)
    stored = parsed.hold
  }
  const dir = await episodeDir(slug, episodeId)
  // Never create an episode folder just to hold a setting.
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`Episode ${episodeId} has no folder yet.`)
  const file = path.join(dir, EPISODE_SKETCH_HOLD_FILENAME)
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, hold: stored, updated_at: new Date().toISOString() })
  })
  return stored
}
