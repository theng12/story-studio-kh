/**
 * Per-episode B-Roll selection sidecar.
 *
 * Lives at <episode>/broll-selection.json. Written by the /broll/pick
 * endpoint after the selector runs; read by the assembly job at render
 * time. Persisting on disk (not in memory) means the user can pick clips
 * one day, review, then assemble the next without losing state — same
 * lifecycle the outline / chapter / image-prompt sidecars use.
 */
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { writeJsonAtomic, readJsonOr } from '../lib/atomic-store.js'
import { resolveEpisodePaths } from './utils.js'
import type { SelectionEntry } from '../lib/broll-selector.js'

export interface BrollSelectionSidecar {
  schema_version: 1
  episode_code: string
  pool_id: string
  selection_mode: string
  pacing_mode: string
  segment_seconds?: number
  tags?: string[]
  broll_volume: number
  /** Resolved at pick time so the renderer doesn't re-run the algorithm. */
  selection: SelectionEntry[]
  /** Narration duration the selection was built against (seconds). */
  target_duration: number
  generated_at: string
  /** Any soft warnings the selector returned ("pool too small", etc.). */
  warnings?: string[]
}

function sidecarPath(episodeDir: string): string {
  return path.join(episodeDir, 'broll-selection.json')
}

export async function getSelectionSidecar(
  slug: string,
  episodeId: string,
  title: string,
): Promise<BrollSelectionSidecar | null> {
  try {
    const paths = await resolveEpisodePaths(slug, episodeId, title || '')
    const p = sidecarPath(paths.episode_dir)
    if (!existsSync(p)) return null
    return await readJsonOr<BrollSelectionSidecar | null>(p, null)
  } catch {
    return null
  }
}

export async function saveSelectionSidecar(
  slug: string,
  episodeId: string,
  title: string,
  sidecar: BrollSelectionSidecar,
): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episodeId, title || '')
  await fs.mkdir(paths.episode_dir, { recursive: true })
  const p = sidecarPath(paths.episode_dir)
  await writeJsonAtomic(p, sidecar)
  return p
}
