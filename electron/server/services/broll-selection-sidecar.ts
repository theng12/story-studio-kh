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

export type BrollSelectionSource = 'scene_plan' | 'image_pool'

export function readBrollSelectionSource(value: unknown): BrollSelectionSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('B-Roll selection sidecar must be a JSON object')
  }
  const sidecar = value as { source?: unknown }
  if (!Object.prototype.hasOwnProperty.call(sidecar, 'source')) return undefined
  if (sidecar.source === 'scene_plan' || sidecar.source === 'image_pool') return sidecar.source
  throw new Error('B-Roll selection sidecar source must be scene_plan or image_pool')
}

export interface BrollSelectionSidecar {
  schema_version: 1
  episode_code: string
  pool_id: string
  /** Explicit Video Assembly source. Missing keeps legacy Scene Plan mode. */
  source?: BrollSelectionSource
  /** v1.0.404 — 'image' = Image Pool slideshow (still-image assembler);
   *  absent/'video' = B-Roll clips. Lets the assembler pick the right path. */
  media?: 'video' | 'image'
  /** v1.0.404 — image-pool fit mode (crop/fit/blur); ignored for video. */
  fit?: 'crop' | 'fit' | 'blur'
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

  /**
   * v1.0.89+: per-episode motion + transition settings. Stored on the
   * selection sidecar so the picker UI and the renderer agree on the
   * exact treatment for this episode, even if the project-level
   * defaults change later.
   *
   * `motion_mode = 'fixed'` → every segment uses `motion_default`.
   * `motion_mode = 'rotate'` → each segment cycles through `motion_pool`
   *                           in deterministic order (seeded by clip
   *                           index). Pool can include 'static' to
   *                           interleave still segments with moving ones.
   * `motion_mode = 'random'` → same as rotate but with a random pick
   *                           per segment.
   */
  motion_mode?: 'fixed' | 'rotate' | 'random'
  motion_default?: string  // BrollMotion id; 'static' when no animation
  motion_pool?: string[]   // used by 'rotate' + 'random'
  /**
   * Cross-clip transition. 'none' = hard cut between segments (cheapest
   * render, cleanest cadence). Any TransitionDef id from
   * models/transitions.ts is valid here — most prayer/devotional
   * channels stick to 'crossfade' or 'fade-fast' at 0.5-1s duration.
   */
  transition_id?: string
  /** Duration of each transition in seconds. Clamped 0.1-2.0 at render. */
  transition_duration?: number
}

function sidecarPath(episodeDir: string): string {
  return path.join(episodeDir, 'broll-selection.json')
}

function isSelectionSidecar(value: unknown): value is BrollSelectionSidecar {
  const sidecar = value as Partial<BrollSelectionSidecar> | null
  return !!sidecar && typeof sidecar.pool_id === 'string' && Array.isArray(sidecar.selection)
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
    const sidecar = await readJsonOr<unknown>(p, null)
    return isSelectionSidecar(sidecar) ? sidecar : null
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
  let source: BrollSelectionSidecar['source']
  try {
    source = readBrollSelectionSource(JSON.parse(await fs.readFile(p, 'utf8')))
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`B-Roll selection sidecar is malformed for ${episodeId}; repair it before picking again. (${error?.message || error})`)
    }
  }
  // The Image Pool owns its frozen image selection. The B-Roll picker routes
  // also call this shared writer, so preserving only the `source` field would
  // leave an Image Pool record carrying video picks and make it unrenderable.
  // A genuine Image Pool re-pick has `media: 'image'` and remains allowed.
  if (source === 'image_pool' && sidecar.media !== 'image') {
    throw new Error(`B-Roll selection is not used for Image Pool episode ${episodeId}. Keep the saved Image Pool picks or switch this episode to Scene Plan first.`)
  }
  await writeJsonAtomic(p, { ...sidecar, ...(source ? { source } : {}) })
  return p
}
