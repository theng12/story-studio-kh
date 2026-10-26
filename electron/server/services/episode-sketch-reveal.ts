import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { parseSketchReveal, type SketchRevealSetting } from '../lib/sketch-reveal.js'
import { episodeDir, EpisodeSettingFileUnreadable } from './episode-sketch-pen.js'

/**
 * An episode's own Sketch Draw reveal style, stored exactly like its pen and hold: a file of its
 * own in the episode's folder (`sketch_reveal.json`), the SELECTION only (style, mix and this
 * episode's per-scene pins), `reveal: null` meaning "use the channel default" (written rather than
 * deleting the file). Presets and whole-config saves never touch it.
 *
 * It is per episode because the reveal is an editorial choice about ONE episode's rhythm — the
 * owner, 2026-10-27: "different episodes use different effects". The channel value is only the
 * starting default for an episode that has none.
 */
export const EPISODE_SKETCH_REVEAL_FILENAME = 'sketch_reveal.json'

/** The episode's own reveal, or null when it follows the channel. A malformed file throws: it is not "line". */
export async function readEpisodeSketchReveal(slug: string, episodeId: string): Promise<SketchRevealSetting | null> {
  const file = path.join(await episodeDir(slug, episodeId), EPISODE_SKETCH_REVEAL_FILENAME)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new EpisodeSettingFileUnreadable(`This episode's reveal setting file (${EPISODE_SKETCH_REVEAL_FILENAME} for ${episodeId}) is malformed and cannot be read. Choose its reveal style again in Motion Review to rewrite it.`) }
  const reveal = (value as { reveal?: unknown } | null)?.reveal
  if (reveal === null) return null
  const parsed = parseSketchReveal(reveal)
  if (!parsed.ok) throw new EpisodeSettingFileUnreadable(`This episode's reveal setting file (${EPISODE_SKETCH_REVEAL_FILENAME} for ${episodeId}) holds something that is not a valid reveal style. Choose its reveal style again in Motion Review to rewrite it.`)
  return parsed.reveal
}

/** Set the episode's reveal, or pass null to follow the channel default again. Returns what was stored. */
export async function writeEpisodeSketchReveal(slug: string, episodeId: string, reveal: unknown): Promise<SketchRevealSetting | null> {
  let stored: SketchRevealSetting | null = null
  if (reveal !== null) {
    const parsed = parseSketchReveal(reveal)
    if (!parsed.ok) throw new Error(parsed.error)
    stored = parsed.reveal
  }
  const dir = await episodeDir(slug, episodeId)
  // Never create an episode folder just to hold a setting.
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`Episode ${episodeId} has no folder yet.`)
  const file = path.join(dir, EPISODE_SKETCH_REVEAL_FILENAME)
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, reveal: stored, updated_at: new Date().toISOString() })
  })
  return stored
}
