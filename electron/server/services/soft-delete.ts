/**
 * Soft-delete registry for projects.
 *
 * "Delete project" used to mean rm -rf the project folder + (sometimes) its
 * external output_root. Destructive, irreversible, and a footgun whenever
 * the user wanted to re-import an existing folder that came in via a wrong
 * slug or a stale registration: the only way to "unregister" was to lose
 * all the assets.
 *
 * The new contract: `deleteProject` only **unregisters** a slug from the
 * app's view. The folder on disk is untouched. The user sees a banner
 * naming the path with an "Open in Finder" button, and the home page
 * surfaces a "🗑️ Hidden projects (N)" chip listing every soft-deleted
 * folder still on disk. From there:
 *
 *   - Restore → unregister the soft-delete; project re-appears in the list.
 *   - Open in Finder → reveal the folder so the user can inspect / move
 *     / delete by hand.
 *   - Delete from disk → explicit hard delete with an extra confirm.
 *
 * Storage: per-Mac in app-settings.json under `soft_deleted_slugs` (an
 * array of slugs). Linked-project deletes don't go through here — they
 * already non-destructive (just `removeLinkedProject` from the registry).
 *
 * Re-creating a project (createProject / addLinkedProject) with a slug
 * that's currently soft-deleted auto-clears it from this list — the
 * user explicitly chose to bring that slug back, so we honour that
 * over the stale tombstone.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { projectsRoot } from './project-manager.js'

const APP_SETTINGS_KEY = 'soft_deleted_slugs'

export interface SoftDeletedProjectInfo {
  slug: string
  /** project.json's `name` if readable, else the slug. */
  name: string
  /** Absolute path to the still-on-disk project folder. */
  path: string
  /** True iff the path still exists on disk. False entries are stale
   *  tombstones — `forgetSoftDeletedProject` cleans them up. */
  exists: boolean
  /** Whether this lived in PROJECTS_ROOT. (Linked-project deletes never
   *  arrive here — they go through removeLinkedProject directly.) */
  is_default_location: boolean
  /** Best-effort recursive size of the folder. -1 when unknown. */
  estimated_bytes: number
  /** ISO timestamp of when the soft-delete was recorded. Optional —
   *  pre-existing entries from before this field shipped won't have
   *  it. */
  deleted_at?: string
}

/**
 * Internal storage shape: a list of `{slug, deleted_at}` objects. Old
 * versions stored bare strings — read code tolerates both.
 */
interface SoftDeleteEntry {
  slug: string
  deleted_at?: string
}

async function getRawList(): Promise<SoftDeleteEntry[]> {
  const raw = await getAppSetting(APP_SETTINGS_KEY)
  if (!Array.isArray(raw)) return []
  const out: SoftDeleteEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item) {
      out.push({ slug: item })
    } else if (item && typeof item === 'object' && typeof (item as any).slug === 'string') {
      out.push({
        slug: (item as any).slug,
        deleted_at: typeof (item as any).deleted_at === 'string' ? (item as any).deleted_at : undefined,
      })
    }
  }
  return out
}

async function setRawList(entries: SoftDeleteEntry[]): Promise<void> {
  // De-dupe by slug (last entry wins so a re-delete refreshes deleted_at).
  const map = new Map<string, SoftDeleteEntry>()
  for (const e of entries) {
    if (!e.slug) continue
    map.set(e.slug, e)
  }
  await setAppSetting(APP_SETTINGS_KEY, Array.from(map.values()))
}

/**
 * Get the list of slugs currently flagged soft-deleted. Used by
 * project-manager.listProjects to filter them out without an extra
 * round trip.
 */
export async function getSoftDeletedSlugSet(): Promise<Set<string>> {
  const list = await getRawList()
  return new Set(list.map(e => e.slug))
}

/**
 * Add a slug to the soft-delete list. Idempotent — calling twice with
 * the same slug just refreshes the deleted_at timestamp.
 */
export async function softDeleteProjectAfterGuard(slug: string): Promise<void> {
  const list = await getRawList()
  const filtered = list.filter(e => e.slug !== slug)
  filtered.push({ slug, deleted_at: new Date().toISOString() })
  await setRawList(filtered)
}

/** Keep the public registry mutation behind the same queue-owned guard. */
export async function softDeleteProject(slug: string): Promise<void> {
  const projectDir = path.join(projectsRoot(), slug)
  if (!existsSync(projectDir)) return softDeleteProjectAfterGuard(slug)
  const { withProjectJobRemovalGuard } = await import('./job-queue.js')
  return withProjectJobRemovalGuard(slug, projectDir, () => softDeleteProjectAfterGuard(slug))
}

/**
 * Remove a slug from the soft-delete list. Returns true if the slug
 * was actually in the list, false if it wasn't (e.g. the project
 * never went through soft-delete, or was already restored).
 *
 * Called from:
 *   - "Restore" button on the home-page hidden-projects panel
 *   - createProject / addLinkedProject when a re-creation/re-add
 *     covers the same slug (auto-undelete on revive)
 */
export async function forgetSoftDeletedProject(slug: string): Promise<boolean> {
  const list = await getRawList()
  if (!list.some(e => e.slug === slug)) return false
  await setRawList(list.filter(e => e.slug !== slug))
  return true
}

/**
 * Detailed info per soft-deleted slug — folder path, size, name from
 * project.json, etc. Drives the home-page "🗑️ Hidden projects" UI.
 *
 * Skips bytes calculation for tombstones whose folder no longer exists
 * (the user already deleted from Finder); those rows surface anyway so
 * the user can click "Forget" to clear them.
 */
export async function listSoftDeletedProjects(): Promise<SoftDeletedProjectInfo[]> {
  const list = await getRawList()
  const out: SoftDeletedProjectInfo[] = []
  for (const entry of list) {
    const slug = entry.slug
    const candidatePath = path.join(projectsRoot(), slug)
    const exists = existsSync(candidatePath)
    let name = slug
    let estimated_bytes = -1
    if (exists) {
      try {
        const raw = await fs.readFile(path.join(candidatePath, 'project.json'), 'utf-8')
        const meta = JSON.parse(raw)
        if (typeof meta?.name === 'string' && meta.name) name = meta.name
      } catch { /* missing/corrupt project.json — keep slug as name */ }
      // `-1` means "unknown" and is now reachable: `null` from the tally is the
      // only honest answer when a child could not be read.
      estimated_bytes = (await tallyDirSize(candidatePath)) ?? -1
    }
    out.push({
      slug,
      name,
      path: candidatePath,
      exists,
      is_default_location: true,
      estimated_bytes,
      deleted_at: entry.deleted_at,
    })
  }
  return out
}

/**
 * Hard-delete a soft-deleted project — actually rm -rf the folder. This
 * is the explicit "yes I really want it gone" path; the soft-delete
 * tombstone is also removed so the slug is fully forgotten.
 *
 * Refuses with a 400 if the slug isn't currently soft-deleted (caller
 * should have soft-deleted first), and with a 409 when the size the caller
 * confirmed is not the size measured here: the number on the confirmation is
 * the only thing standing between a person and an irreversible delete, so it is
 * compared against a fresh measurement rather than trusted (row `20261120-161`).
 */
export async function hardDeleteSoftDeletedProject(slug: string, expectedBytes: number): Promise<void> {
  const list = await getRawList()
  if (!list.some(e => e.slug === slug)) {
    const e: any = new Error(`Slug '${slug}' is not currently soft-deleted. Soft-delete it first via DELETE /projects/:slug.`)
    e.statusCode = 400
    throw e
  }
  const candidatePath = path.join(projectsRoot(), slug)
  if (existsSync(candidatePath)) {
    const measured = await tallyDirSize(candidatePath)
    if (measured === null) {
      const e: any = new Error(
        `'${slug}' could not be measured, so what would be deleted cannot be shown. Nothing was deleted; `
        + 'fix the folder\'s permissions or delete it in Finder.',
      )
      e.statusCode = 409
      throw e
    }
    if (measured !== expectedBytes) {
      const e: any = new Error(
        `'${slug}' is ${measured.toLocaleString()} bytes now, not the ${expectedBytes.toLocaleString()} you confirmed. `
        + 'Nothing was deleted. Review it again and confirm the number shown.',
      )
      e.statusCode = 409
      throw e
    }
    const { withProjectJobRemovalGuard } = await import('./job-queue.js')
    await withProjectJobRemovalGuard(slug, candidatePath, async () => {
      await fs.rm(candidatePath, { recursive: true, force: true })
    })
  }
  await setRawList(list.filter(e => e.slug !== slug))
}

/**
 * Recursive size of a directory in bytes, or `null` when it cannot be measured.
 *
 * v1.4.200 — this used to return 0 for BOTH "the directory is empty" and "I
 * could not read it", and to skip unreadable children silently. Its only caller
 * guarded with `.catch(() => -1)`, which could never fire because this function
 * never rejects, so the `-1` "unknown size" sentinel was **unreachable** and a
 * folder nobody could measure was reported as **0 bytes** — the exact
 * conflation that sentinel was written to avoid (AGENTS.md §6).
 *
 * `null` now propagates: any unreadable child makes the whole total unknown,
 * because a partial sum presented as a total is the same lie in a smaller font.
 * The caller turns `null` into the documented `-1`.
 */
async function tallyDirSize(dir: string): Promise<number | null> {
  let total = 0
  let entries: import('fs').Dirent[] = []
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      const child = await tallyDirSize(full)
      if (child === null) return null
      total += child
    } else if (ent.isFile()) {
      try { total += (await fs.stat(full)).size } catch { return null }
    }
  }
  return total
}
