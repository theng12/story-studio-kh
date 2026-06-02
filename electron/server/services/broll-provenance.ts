/**
 * Per-clip provenance sidecars for the B-Roll Fetch feature.
 *
 * Each clip downloaded via the Fetch flow gets a JSON sidecar at
 *   `<pool-folder>/.broll-provenance/<filename>.json`
 *
 * Why per-clip sidecars (not one pool-wide file):
 *   - Survives if the pool index gets corrupted (sidecars are
 *     independent of `.story-studio-broll.json`).
 *   - No write-contention when two fetch jobs finish at the same
 *     moment — each writes its own file.
 *   - Travels with the SSD across Macs (the sidecar dir is inside
 *     the pool folder).
 *   - Trivially readable in Finder if the user wants to verify a
 *     clip's source by hand.
 *
 * The sidecars are independent of the existing pool index — fetched
 * clips still get registered in `.story-studio-broll.json` via the
 * pool's scan pipeline. The provenance file is the "where did this
 * come from" record that the asset log + hover tooltip read.
 *
 * Clips imported by hand (drag-and-drop into the SSD folder, then
 * scan) HAVE NO sidecar — they show up in the asset log as
 * `source: 'local'`. This is the right behaviour: we never want to
 * fabricate provenance for clips we didn't fetch.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { FetchProvider, FetchResult } from './broll-fetchers/types.js'

export const PROVENANCE_SCHEMA_VERSION = 1 as const
const PROVENANCE_DIR = '.broll-provenance'

export interface ProvenanceRecord {
  schema_version: typeof PROVENANCE_SCHEMA_VERSION
  filename: string
  source: FetchProvider
  /** Provider's stable ID for the clip (stringified). */
  source_id: string
  source_url: string
  author: string
  author_url?: string
  license: string
  license_url: string
  /** ISO timestamp of when the fetch job completed. */
  fetched_at: string
  /** The exact search query that led to this clip being fetched.
   *  Surfaces in the asset log + hover tooltip. */
  search_keywords: string[]
  /** Resolution of the file we actually downloaded (the provider's
   *  may offer multiple — we record what landed on disk). */
  downloaded_width: number
  downloaded_height: number
  /** Best-available dimensions the provider had (for context — if we
   *  picked HD but UHD existed, this records that). */
  source_width: number
  source_height: number
  duration: number
}

export function provenanceDir(poolPath: string): string {
  return path.join(poolPath, PROVENANCE_DIR)
}

export function provenancePathFor(poolPath: string, filename: string): string {
  return path.join(provenanceDir(poolPath), `${filename}.json`)
}

/**
 * Write a provenance sidecar atomically. Caller must ensure the
 * pool's folder is online — we don't check that here because the
 * fetch executor has already downloaded a file into the same pool,
 * so the folder is definitionally present.
 */
export async function writeProvenance(
  poolPath: string,
  rec: ProvenanceRecord,
): Promise<void> {
  const dir = provenanceDir(poolPath)
  await fs.mkdir(dir, { recursive: true })
  const target = provenancePathFor(poolPath, rec.filename)
  await writeJsonAtomic(target, rec)
}

/** Read one sidecar. Returns null on missing file (not an error —
 *  hand-added clips legitimately have no provenance). Throws on
 *  parse error so a corrupt sidecar surfaces instead of silently
 *  treating the clip as local. */
export async function readProvenance(
  poolPath: string,
  filename: string,
): Promise<ProvenanceRecord | null> {
  const p = provenancePathFor(poolPath, filename)
  if (!existsSync(p)) return null
  const raw = await fs.readFile(p, 'utf-8')
  const parsed = JSON.parse(raw)
  // Schema-version gate — at v1 there's nothing to migrate, but the
  // explicit check means future versions can't be silently truncated.
  if (parsed?.schema_version !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported provenance schema ${parsed?.schema_version} at ${p}`)
  }
  return parsed as ProvenanceRecord
}

/**
 * List every sidecar in a pool. Returns an empty array when the
 * `.broll-provenance/` dir doesn't exist (fresh pool with only
 * hand-added clips). Skips files that aren't valid JSON instead of
 * throwing — one bad sidecar shouldn't break the whole asset log.
 */
export async function listProvenance(poolPath: string): Promise<ProvenanceRecord[]> {
  const dir = provenanceDir(poolPath)
  if (!existsSync(dir)) return []
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: ProvenanceRecord[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.schema_version === PROVENANCE_SCHEMA_VERSION) {
        out.push(parsed as ProvenanceRecord)
      }
    } catch {
      // Skip unreadable / corrupt sidecars — surface in logs but
      // don't break the asset log for the rest.
      console.warn(`[broll-provenance] skipping unreadable sidecar: ${name}`)
    }
  }
  return out
}

/**
 * Dedupe check: does this pool already have a clip from
 * `source + source_id`? Used by the search route to annotate results
 * with `already_have: true` so the UI can grey them out.
 *
 * O(N) over sidecars per call — fine for pools up to a few thousand
 * clips. Cache the results inside the search route if a single
 * search request needs many lookups (typical: 20 results × one
 * lookup each = 20 sidecar reads, well under a second on SSD).
 */
export async function hasFetchedClip(
  poolPath: string,
  source: FetchProvider,
  sourceId: string,
): Promise<boolean> {
  const all = await listProvenance(poolPath)
  return all.some(p => p.source === source && p.source_id === sourceId)
}

/**
 * Convenience: derive a stable, filesystem-safe filename for a
 * fetch result. Format:
 *   `<source>-<sourceId>-<keyword>.mp4`
 *
 * The keyword segment is the first non-empty search term (lowercased,
 * non-alphanumerics stripped) — gives a human-readable filename
 * without losing the dedupe key. Provider+ID together guarantee
 * global uniqueness across keyword runs (the same clip fetched via
 * "ocean" and again via "sunset" would yield the same filename and
 * the second fetch short-circuits at the dedupe check).
 */
export function suggestFilename(
  source: FetchProvider,
  sourceId: string,
  keywords: string[],
  ext = 'mp4',
): string {
  const slug = (keywords[0] || 'clip')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'clip'
  return `${source}-${sourceId}-${slug}.${ext}`
}

/**
 * Build a `ProvenanceRecord` from a fetch result. The fetch executor
 * calls this after the download finishes so the `downloaded_*`
 * fields reflect what's actually on disk (not just what the
 * provider's catalogue claimed).
 */
export function recordFromResult(
  result: FetchResult,
  filename: string,
  downloadedWidth: number,
  downloadedHeight: number,
  keywords: string[],
  fetchedAt: string = new Date().toISOString(),
): ProvenanceRecord {
  return {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    filename,
    source: result.provider,
    source_id: result.source_id,
    source_url: result.source_url,
    author: result.author,
    author_url: result.author_url,
    license: result.license,
    license_url: result.license_url,
    fetched_at: fetchedAt,
    search_keywords: keywords,
    downloaded_width: downloadedWidth,
    downloaded_height: downloadedHeight,
    source_width: result.width,
    source_height: result.height,
    duration: result.duration,
  }
}
