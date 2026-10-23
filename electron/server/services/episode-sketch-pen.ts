import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { SketchDrawPenMode } from '../models/types.js'
import { resolveEpisodePathsByCodeWithSidecar } from './utils.js'

/**
 * An episode's own Sketch Draw pen.
 *
 * Lives in the episode's folder, beside `scene_plan.json`, in a file of its own: not in
 * `config.json` (channel-wide, which is what made one pen stale every episode's clips), not in
 * `continuity.json` (whole-config saves and presets round-trip that file), and not in the Scene
 * Plan (regenerated). It stores the SELECTION only; the channel name and logo resolve live.
 * `pen: null` means "use the channel default" and is written rather than deleting the file.
 */
export const EPISODE_SKETCH_PEN_FILENAME = 'sketch_pen.json'
export const SKETCH_PEN_MODES: readonly SketchDrawPenMode[] = ['none', 'plain', 'name', 'logo']

export function isSketchPenMode(value: unknown): value is SketchDrawPenMode {
  return typeof value === 'string' && (SKETCH_PEN_MODES as readonly string[]).includes(value)
}

/** The same episode-code shape Media Cleanup accepts; no separator or dot can pass, so no `../`. */
export const isEpisodeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z]{1,12}\d{1,8}$/.test(value.trim())

async function episodeDir(slug: string, episodeId: string): Promise<string> {
  if (!isEpisodeCode(episodeId)) throw new Error('Choose a valid episode.')
  const { SCENE_PLAN_FILENAME } = await import('../generators/scene-plan.js')
  return (await resolveEpisodePathsByCodeWithSidecar(slug, episodeId.trim(), SCENE_PLAN_FILENAME)).episode_dir
}

/** The episode's own pen, or null when it follows the channel. A malformed file throws: it is not "none". */
export async function readEpisodeSketchPen(slug: string, episodeId: string): Promise<SketchDrawPenMode | null> {
  const file = path.join(await episodeDir(slug, episodeId), EPISODE_SKETCH_PEN_FILENAME)
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new Error(`${EPISODE_SKETCH_PEN_FILENAME} for ${episodeId} is malformed. Choose this episode's pen again in Motion Review.`) }
  const pen = (value as { pen?: unknown } | null)?.pen
  if (pen === null) return null
  if (!isSketchPenMode(pen)) throw new Error(`${EPISODE_SKETCH_PEN_FILENAME} for ${episodeId} names an unknown pen. Choose this episode's pen again in Motion Review.`)
  return pen
}

/** Set the episode's pen, or pass null to follow the channel default again. */
export async function writeEpisodeSketchPen(slug: string, episodeId: string, pen: SketchDrawPenMode | null): Promise<void> {
  if (pen !== null && !isSketchPenMode(pen)) throw new Error('Choose a valid Sketch Draw pen.')
  const dir = await episodeDir(slug, episodeId)
  // Never create an episode folder just to hold a pen.
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`Episode ${episodeId} has no folder yet.`)
  const file = path.join(dir, EPISODE_SKETCH_PEN_FILENAME)
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, pen, updated_at: new Date().toISOString() })
  })
}
