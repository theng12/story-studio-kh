/**
 * Portable manifest I/O.
 *
 * One file, one purpose: write `.story-studio-project.json` at the root of
 * a project's `output_root` every time metadata changes. That file travels
 * with the folder when the user syncs via iCloud / Google Drive / OneDrive,
 * so "Import from folder" on another machine can recognise the project,
 * reuse its `project_id` (relocate vs. fresh import), and line up episode
 * codes against the folder layout.
 *
 * Schema:
 *   - v2 (current): slim — just structural metadata + last_edited.
 *   - v1 (legacy): rich — also carried presets, production_standards,
 *     required_named_roots. Accepted on read, discarded silently, rewritten
 *     as v2 on next save. See the schema bump note in types.ts for why.
 *
 * Design notes:
 *
 * • We generate a stable `project_id` (UUID v4) on first write when the
 *   project doesn't have one yet, and backfill it into `project.json` so
 *   subsequent reads use the same identity. The backfill still happens in
 *   `project-manager.ts::syncManifest`, not here.
 *
 * • Writes go through the sync-safe `writeAtomic` helper so iCloud never
 *   observes a half-written file. We also mirror the last-written manifest
 *   to `{userData}/projects/{slug}/cache/manifest.json` so the app can show
 *   project metadata when the sync folder is offline.
 */

import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { writeAtomic } from '../lib/sync-safe.js'
import type {
  PortableManifest,
  ProjectMeta,
} from '../models/types.js'

const MANIFEST_FILENAME = '.story-studio-project.json'

/**
 * Compose the manifest from the project's ProjectMeta. Pure — does not
 * touch disk. `outputRoot` is accepted for future use (e.g. per-project
 * machine labels) but is not embedded in the v2 payload.
 */
export function buildManifest(
  meta: ProjectMeta,
  _outputRoot: string,
  machineLabel: string,
): PortableManifest {
  return {
    schema_version: 2,
    project_id: meta.project_id || randomUUID(),
    slug: meta.slug,
    name: meta.name,
    episode_prefix: meta.episode_prefix,
    episode_digits: meta.episode_digits,
    season_size: meta.season_size,
    season_prefix: meta.season_prefix,
    folder_template: meta.folder_template,
    subfolder_names: meta.subfolder_names,
    last_edited: { machine_label: machineLabel, at: new Date().toISOString() },
  }
}

/** Write the manifest to the project's output_root. */
export async function writeManifest(outputRoot: string, manifest: PortableManifest): Promise<void> {
  const dest = path.join(outputRoot, MANIFEST_FILENAME)
  await writeAtomic(dest, JSON.stringify(manifest, null, 2))
}

/** Mirror the manifest to userData so offline machines can still show metadata. */
export async function writeManifestCache(projectDir: string, manifest: PortableManifest): Promise<void> {
  const dest = path.join(projectDir, 'cache', 'manifest.json')
  await writeAtomic(dest, JSON.stringify(manifest, null, 2))
}

/**
 * Read the manifest at a given output_root. Accepts both v1 (legacy, with
 * preset bag) and v2. Returns null if the file is missing, unreadable, or
 * doesn't have the minimum structural fields we need.
 *
 * v1 → v2 normalisation: we keep only the structural fields + last_edited.
 * `presets`, `production_standards`, `required_named_roots`, and
 * `youtube_channel_url` are silently dropped. A later `syncManifest` will
 * overwrite the file with a clean v2 shape.
 */
export async function readManifest(outputRoot: string): Promise<PortableManifest | null> {
  const src = path.join(outputRoot, MANIFEST_FILENAME)
  if (!existsSync(src)) return null
  try {
    const raw = await fs.readFile(src, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.project_id !== 'string') return null
    const sv = parsed.schema_version
    if (sv !== 1 && sv !== 2) return null

    const normalized: PortableManifest = {
      schema_version: 2,
      project_id: parsed.project_id,
      slug: typeof parsed.slug === 'string' ? parsed.slug : '',
      name: typeof parsed.name === 'string' ? parsed.name : '',
      episode_prefix: typeof parsed.episode_prefix === 'string' ? parsed.episode_prefix : 'EP',
      episode_digits: typeof parsed.episode_digits === 'number' ? parsed.episode_digits : 4,
      season_size: typeof parsed.season_size === 'number' ? parsed.season_size : 10,
      season_prefix: typeof parsed.season_prefix === 'string' ? parsed.season_prefix : 'Season',
      folder_template: typeof parsed.folder_template === 'string'
        ? parsed.folder_template
        : '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: (parsed.subfolder_names && typeof parsed.subfolder_names === 'object')
        ? parsed.subfolder_names
        : {} as any,
      last_edited: (parsed.last_edited && typeof parsed.last_edited === 'object')
        ? parsed.last_edited
        : { machine_label: 'unknown', at: new Date(0).toISOString() },
    }
    return normalized
  } catch {
    return null
  }
}

/**
 * Human-friendly label for the current machine. Used in `last_edited.machine_label`
 * so users can see "last edited on Alice's MacBook" instead of a UUID.
 */
export function getMachineLabel(): string {
  try { return os.hostname() || 'unknown' } catch { return 'unknown' }
}

/**
 * Compare the mtime of the external manifest against our local cache
 * mirror. Used by the concurrent-edit detector to spot "another machine
 * wrote a newer manifest while this machine had the project loaded".
 *
 * Returns:
 *   - `in_sync: true`  — cache is up to date (or no external manifest yet).
 *   - `in_sync: false` — external manifest is newer than our cache.
 *
 * Skew tolerance: we treat external mtimes within 2 seconds of the cache
 * as equal, because the two files are written in quick succession from
 * the same host in `syncManifest` and tiny clock jitter shouldn't fire
 * the UI toast on our own writes.
 */
export interface ManifestStatus {
  in_sync: boolean
  external_exists: boolean
  external_mtime: number | null
  cache_mtime: number | null
  last_edited?: { machine_label: string; at: string }
}

export async function getManifestStatus(outputRoot: string, projectDir: string): Promise<ManifestStatus> {
  const externalPath = path.join(outputRoot, MANIFEST_FILENAME)
  const cachePath = path.join(projectDir, 'cache', 'manifest.json')
  let externalMtime: number | null = null
  let cacheMtime: number | null = null
  let lastEdited: { machine_label: string; at: string } | undefined

  try {
    if (existsSync(externalPath)) {
      const st = await fs.stat(externalPath)
      externalMtime = st.mtimeMs
      const m = await readManifest(outputRoot)
      lastEdited = m?.last_edited
    }
  } catch { /* external unreadable — treat as missing */ }

  try {
    if (existsSync(cachePath)) {
      const st = await fs.stat(cachePath)
      cacheMtime = st.mtimeMs
    }
  } catch { /* cache unreadable — treat as missing */ }

  const in_sync = (() => {
    if (!externalMtime) return true
    if (!cacheMtime) return false
    return externalMtime - cacheMtime <= 2_000
  })()

  return { in_sync, external_exists: externalMtime !== null, external_mtime: externalMtime, cache_mtime: cacheMtime, last_edited: lastEdited }
}
