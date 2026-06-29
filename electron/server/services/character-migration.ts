/**
 * Character unification migration — one-time, COPY-ONLY, reversible
 * consolidation of per-project characters into the app-level library.
 *
 * Safety contract (the user prioritised "no data loss" above all):
 *   - Dry-run by default. `planMigration()` writes NOTHING; it only reports
 *     what `runMigration()` would do.
 *   - Copy, never move. `runMigration()` copies each per-project character
 *     (character.json + reference images) into the library, tagged with its
 *     project slug, then VERIFIES the copy. It NEVER deletes or rewrites the
 *     per-project original — the two stores coexist (the unified reader dedups
 *     by id, project-wins, so no duplicates appear).
 *   - Conflicts are skipped, never overwritten. If a DIFFERENT character
 *     already owns the target library id, we report it and leave both stores
 *     untouched for the user to resolve by renaming.
 *   - Reversible. Because originals are untouched, undo = delete the library
 *     entries this run created (the report lists their ids) or unassign the
 *     slug. Nothing destructive to roll back.
 *
 * See docs/character-unification-spec.md.
 */

import * as pm from './project-manager.js'
import * as cm from './character-manager.js'
import * as cl from './character-library.js'
import { existsSync } from 'fs'
import path from 'path'
import type { Character } from '../models/types.js'

export type MigrationStatus =
  | 'copy'            // no library entry with this id → create + assign
  | 'assign-only'     // identical library entry exists → just add the slug tag
  | 'already-assigned'// identical entry already tagged with this slug → no-op
  | 'conflict'        // a DIFFERENT character owns this library id → skip

export interface MigrationItem {
  slug: string
  characterId: string
  libraryId: string
  name: string
  status: MigrationStatus
  /** Populated for `conflict` — why we won't touch it. */
  detail?: string
}

export interface MigrationPlan {
  generatedAt: string
  totals: Record<MigrationStatus, number>
  items: MigrationItem[]
}

export interface MigrationRunItem extends MigrationItem {
  /** What runMigration actually did. */
  action: 'copied' | 'assigned' | 'skipped' | 'failed'
  verified?: boolean
  error?: string
}

export interface MigrationRunResult {
  ranAt: string
  dryRun: boolean
  totals: { copied: number; assigned: number; skipped: number; failed: number }
  /** Library ids created by this run — the undo list (delete these to revert). */
  createdLibraryIds: string[]
  items: MigrationRunItem[]
}

/**
 * Two characters are "the same" for migration purposes when their identity
 * fields match. Conservative on purpose: anything that doesn't clearly match
 * is treated as a CONFLICT and skipped rather than overwritten.
 */
function sameCharacter(a: Character, b: Character): boolean {
  return (a.name || '').trim() === (b.name || '').trim()
    && (a.description || '').trim() === (b.description || '').trim()
}

async function classify(slug: string, char: Character): Promise<MigrationItem> {
  const libraryId = char.id
  const base: MigrationItem = { slug, characterId: char.id, libraryId, name: char.name, status: 'copy' }
  const existing = await cl.getLibraryCharacter(libraryId)
  if (!existing) return { ...base, status: 'copy' }
  if (!sameCharacter(existing, char)) {
    return {
      ...base,
      status: 'conflict',
      detail: `Library id '${libraryId}' is already used by a different character ` +
        `("${existing.name}"). Rename one of them before migrating.`,
    }
  }
  if ((existing.projects || []).includes(slug)) return { ...base, status: 'already-assigned' }
  return { ...base, status: 'assign-only' }
}

/**
 * DRY RUN. Inspect every project's own (non-library) characters and report
 * what runMigration would do. Writes nothing.
 */
export async function planMigration(): Promise<MigrationPlan> {
  const projects = await pm.listProjects()
  const items: MigrationItem[] = []
  for (const proj of projects) {
    let own: Character[]
    try {
      own = await cm.listOwnCharacters(proj.slug)
    } catch (e: any) {
      console.warn(`[character-migration] could not list characters for '${proj.slug}': ${e.message}`)
      continue
    }
    for (const char of own) {
      items.push(await classify(proj.slug, char))
    }
  }
  const totals: Record<MigrationStatus, number> = {
    copy: 0, 'assign-only': 0, 'already-assigned': 0, conflict: 0,
  }
  for (const it of items) totals[it.status]++
  return { generatedAt: new Date().toISOString(), totals, items }
}

/**
 * Execute the migration. Copies + assigns; verifies each copy; never deletes
 * an original; skips conflicts. Pass `{ confirm: true }` to actually write —
 * without it this behaves as a dry run (same as planMigration, reported in the
 * run shape).
 */
export async function runMigration(opts?: { confirm?: boolean }): Promise<MigrationRunResult> {
  const dryRun = !opts?.confirm
  const plan = await planMigration()
  const items: MigrationRunItem[] = []
  const createdLibraryIds: string[] = []
  let copied = 0, assigned = 0, skipped = 0, failed = 0

  for (const it of plan.items) {
    if (it.status === 'conflict' || it.status === 'already-assigned') {
      skipped++
      items.push({ ...it, action: 'skipped' })
      continue
    }

    if (dryRun) {
      // Report the intended action without writing.
      if (it.status === 'copy') copied++
      else assigned++
      items.push({ ...it, action: it.status === 'copy' ? 'copied' : 'assigned', verified: false })
      continue
    }

    try {
      if (it.status === 'copy') {
        // saveToLibrary copies character.json + reference images and
        // auto-assigns the source slug into projects[]. 409-safe: status
        // 'copy' means no existing entry.
        const saved = await cl.saveToLibrary(it.slug, it.characterId, { libraryId: it.libraryId })
        createdLibraryIds.push(it.libraryId)
        const verified = await verifyCopy(it.slug, it.characterId, saved)
        if (verified) {
          copied++
          items.push({ ...it, action: 'copied', verified: true })
        } else {
          failed++
          items.push({ ...it, action: 'failed', verified: false, error: 'verification failed' })
        }
      } else {
        // assign-only: identical entry already exists, just add the tag.
        await cl.assignToProject(it.libraryId, it.slug)
        assigned++
        items.push({ ...it, action: 'assigned', verified: true })
      }
    } catch (e: any) {
      failed++
      items.push({ ...it, action: 'failed', error: e?.message || String(e) })
    }
  }

  return {
    ranAt: new Date().toISOString(),
    dryRun,
    totals: { copied, assigned, skipped, failed },
    createdLibraryIds,
    items,
  }
}

/**
 * Verify a freshly-copied library entry against its project source: identity
 * fields match and every reference image landed in the library folder.
 */
async function verifyCopy(slug: string, characterId: string, libRecord: Character): Promise<boolean> {
  const source = await cm.getCharacter(slug, characterId)
  if (!source) return false
  if (!sameCharacter(source, libRecord)) return false
  const reread = await cl.getLibraryCharacter(libRecord.id)
  if (!reread || !sameCharacter(reread, source)) return false
  const dir = cl.libraryCharacterDir(libRecord.id)
  for (const fn of source.references?.images || []) {
    if (!existsSync(path.join(dir, fn))) return false
  }
  return true
}
