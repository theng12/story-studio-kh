/**
 * Per-clip provenance sidecars retained for the local B-Roll asset log.
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

export const PROVENANCE_SCHEMA_VERSION = 1 as const
const PROVENANCE_DIR = '.broll-provenance'

export interface ProvenanceRecord {
  schema_version: typeof PROVENANCE_SCHEMA_VERSION
  filename: string
  source: 'pexels' | 'pixabay' | 'nasa'
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

function provenanceDir(poolPath: string): string {
  return path.join(poolPath, PROVENANCE_DIR)
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
