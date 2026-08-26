/**
 * Portable manifest I/O.
 *
 * One file, one purpose: build the project's structural manifest and cache it
 * beside `project.json` every time metadata changes. It travels with the
 * folder when the user syncs via iCloud / Google Drive / OneDrive, carrying a
 * stable `project_id` so the same channel copied onto another Mac is
 * recognisable as the same channel rather than a new one.
 *
 * It used to be written into the episodes folder as well, and read back by an
 * "Import from folder" flow that registered a project living at an arbitrary
 * path. Both are gone with the episodes folder becoming fixed — see
 * `resolveOutputRoot()` in project-manager.ts.
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
import os from 'os'
import path from 'path'
import { writeAtomic } from '../lib/sync-safe.js'
import type {
  PortableManifest,
  ProjectMeta,
} from '../models/types.js'

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

/** Write the manifest beside project.json so the folder carries its identity. */
export async function writeManifestCache(projectDir: string, manifest: PortableManifest): Promise<void> {
  const dest = path.join(projectDir, 'cache', 'manifest.json')
  await writeAtomic(dest, JSON.stringify(manifest, null, 2))
}

// (Removed: writeManifest / readManifest.) Both existed only for the portable
// manifest written INTO a project's episodes folder when that folder sat
// OUTSIDE the project directory, and for the external-folder import that read
// it back. Episodes always live at `<projectDir>/episodes` now, so no project
// can be external, the import feature is gone, and `writeManifestCache` above
// writes the only manifest that remains.

/**
 * Human-friendly label for the current machine. Used in `last_edited.machine_label`
 * so users can see "last edited on Alice's MacBook" instead of a UUID.
 */
export function getMachineLabel(): string {
  try { return os.hostname() || 'unknown' } catch { return 'unknown' }
}

// (Removed: getManifestStatus + ManifestStatus. They powered the legacy
// manifest-polling UI ("another machine just edited this project") which
// is gone — cloud sync now happens at the OS level via Settings →
// Storage. The manifest cache is still WRITTEN on every project
// mutation as a project_id identity marker.)
