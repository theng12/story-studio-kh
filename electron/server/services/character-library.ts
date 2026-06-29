/**
 * Global character library — app-level shared cast (Phase 7).
 *
 * Per-project characters live under ${PROJECTS_ROOT}/${slug}/characters/.
 * The global library lives at ${PROJECTS_ROOT}/.character-library/{id}/
 * and is shared across every project on this machine. Characters can be
 * authored directly in the library OR saved from a project ("Save to
 * library"); they can be imported into a project ("Import from library"),
 * which copies the record into the project as a snapshot — NOT a live
 * link. The snapshot's `source: 'imported'` field marks the provenance
 * but the imported record can be edited independently of its origin.
 *
 * Why snapshot not link:
 *   - Project transfers (audit Session 05) move the project folder
 *     between machines. A live link to a library entry on the source
 *     machine would dangle on the destination.
 *   - Per-project edits (e.g., a different costume for one channel's
 *     fork of a character) don't pollute the library entry.
 *   - The library acts as a versioning anchor: re-import to refresh
 *     the project copy from the library if you want the upstream change.
 *
 * Voice IDs travel with the imported character — the user can clear or
 * remap them on the project copy if a different machine has different
 * TTS provider keys.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import * as pm from './project-manager.js'
import * as cm from './character-manager.js'
import type { Character } from '../models/types.js'

const SCHEMA_VERSION = 1 as const

function libraryRoot(): string {
  return path.join(pm.PROJECTS_ROOT, '.character-library')
}

function libraryDir(characterId: string): string {
  return path.join(libraryRoot(), characterId)
}

/**
 * Public helper — absolute path to a library character's folder. Used by
 * character-manager.referenceImagePath so a library character assigned to a
 * project can resolve its reference images from the library folder.
 */
export function libraryCharacterDir(characterId: string): string {
  return libraryDir(characterId)
}

function libraryJsonPath(characterId: string): string {
  return path.join(libraryDir(characterId), 'character.json')
}

/** Read one library character. Null if missing. */
export async function getLibraryCharacter(characterId: string): Promise<Character | null> {
  const p = libraryJsonPath(characterId)
  if (!existsSync(p)) return null
  return JSON.parse(await fs.readFile(p, 'utf-8')) as Character
}

/** List every character in the library. Sorted alphabetically by name. */
export async function listLibrary(): Promise<Character[]> {
  const root = libraryRoot()
  if (!existsSync(root)) return []
  let entries: string[] = []
  try { entries = await fs.readdir(root) } catch { return [] }

  const out: Character[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue
    const file = libraryJsonPath(id)
    if (!existsSync(file)) continue
    try {
      out.push(JSON.parse(await fs.readFile(file, 'utf-8')) as Character)
    } catch (e: any) {
      console.warn(`[character-library] skipping malformed entry '${id}': ${e.message}`)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Save a project character to the library. Snapshot copy: includes the
 * character.json + every reference image file. The library entry's id
 * defaults to the source character's id but the caller may override
 * (useful when "Save as" with rename). Refuses to overwrite an existing
 * library entry unless `overwrite: true`.
 *
 * The library copy is normalised:
 *   - scope = 'project' (libraries don't carry episode_codes)
 *   - source = 'project' (the library record IS the canonical version)
 *   - episode_codes cleared
 */
export async function saveToLibrary(
  slug: string,
  sourceCharacterId: string,
  opts?: { libraryId?: string; overwrite?: boolean },
): Promise<Character> {
  const source = await cm.getCharacter(slug, sourceCharacterId)
  if (!source) throw new Error(`Character '${sourceCharacterId}' not found in project '${slug}'`)

  const libraryId = (opts?.libraryId || source.id).trim()
  if (!libraryId || !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(libraryId)) {
    throw new Error(`Invalid library id '${libraryId}' — must be kebab-case`)
  }

  if (existsSync(libraryJsonPath(libraryId)) && !opts?.overwrite) {
    const e = new Error(`Library id '${libraryId}' already exists. Pass overwrite:true to replace.`)
    ;(e as any).status = 409
    throw e
  }

  // Auto-assign the source project so "Save to library" also keeps the
  // character assigned to the project it came from (unified-library model).
  // On overwrite, merge the existing assignment set so we never drop tags.
  const existing = await getLibraryCharacter(libraryId)
  const projects = mergeProjects(existing?.projects, [slug])

  const libraryRecord: Character = {
    ...source,
    id: libraryId,
    scope: 'project',
    episode_codes: undefined,
    projects,
    source: 'project',
    schemaVersion: SCHEMA_VERSION,
  }

  const targetDir = libraryDir(libraryId)
  await fs.mkdir(targetDir, { recursive: true })
  const targetJson = libraryJsonPath(libraryId)
  await withLock(targetJson, async () => {
    await writeJsonAtomic(targetJson, libraryRecord)
  })

  // Copy reference images — they're stored under the source character's
  // folder; copy to the library folder so the library entry is
  // self-contained (project deletion shouldn't break the library).
  if (source.references?.images?.length) {
    const sourceDir = path.join(
      pm.getProjectDir(slug) || path.join(pm.PROJECTS_ROOT, slug),
      'characters', source.id,
    )
    for (const filename of source.references.images) {
      try {
        const src = path.join(sourceDir, filename)
        const dst = path.join(targetDir, filename)
        await fs.copyFile(src, dst)
      } catch (e: any) {
        console.warn(`[character-library] reference image copy failed (${filename}): ${e.message}`)
      }
    }
  }

  return libraryRecord
}

/**
 * Import a library character into a project. Snapshot copy in the other
 * direction. Defaults to scope='project' on import; caller may pass
 * scope='episode' + episode_codes to import as episode-scoped.
 *
 * Refuses to overwrite an existing project character with the same id
 * unless `overwrite: true`. Marks the project copy as `source: 'imported'`
 * so the UI can show provenance.
 */
export async function importFromLibrary(
  libraryId: string,
  targetSlug: string,
  opts?: {
    overwrite?: boolean
    scope?: 'project' | 'episode'
    episode_codes?: string[]
    targetId?: string  // rename on import; defaults to library id
  },
): Promise<Character> {
  const libraryRec = await getLibraryCharacter(libraryId)
  if (!libraryRec) throw new Error(`Library character '${libraryId}' not found`)

  if (!await pm.getProject(targetSlug)) {
    throw new Error(`Project '${targetSlug}' not found`)
  }

  const targetId = (opts?.targetId || libraryRec.id).trim()
  if (!targetId || !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(targetId)) {
    throw new Error(`Invalid target id '${targetId}' — must be kebab-case`)
  }

  const projectDir = path.join(
    pm.getProjectDir(targetSlug) || path.join(pm.PROJECTS_ROOT, targetSlug),
    'characters', targetId,
  )
  const projectJson = path.join(projectDir, 'character.json')
  if (existsSync(projectJson) && !opts?.overwrite) {
    const e = new Error(`Character id '${targetId}' already exists in project '${targetSlug}'. Pass overwrite:true to replace.`)
    ;(e as any).status = 409
    throw e
  }

  const scope = opts?.scope || 'project'
  if (scope === 'episode' && (!opts?.episode_codes || opts.episode_codes.length === 0)) {
    throw new Error("scope='episode' requires non-empty episode_codes on import")
  }

  const projectRec: Character = {
    ...libraryRec,
    id: targetId,
    scope,
    episode_codes: scope === 'episode' ? opts!.episode_codes!.slice() : undefined,
    // Assignment tags belong to the library record, not the per-project
    // snapshot copy — drop them so the project copy stands on its own.
    projects: undefined,
    source: 'imported',
    created_at: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  }

  await fs.mkdir(projectDir, { recursive: true })
  await withLock(projectJson, async () => {
    await writeJsonAtomic(projectJson, projectRec)
  })

  // Copy reference images so the project copy is self-contained.
  if (libraryRec.references?.images?.length) {
    const sourceDir = libraryDir(libraryId)
    for (const filename of libraryRec.references.images) {
      try {
        const src = path.join(sourceDir, filename)
        const dst = path.join(projectDir, filename)
        await fs.copyFile(src, dst)
      } catch (e: any) {
        console.warn(`[character-library] reference image copy failed on import (${filename}): ${e.message}`)
      }
    }
  }

  return projectRec
}

/** Delete a library character (and reference images). */
export async function deleteLibraryCharacter(characterId: string): Promise<boolean> {
  const dir = libraryDir(characterId)
  if (!existsSync(dir)) return false
  await fs.rm(dir, { recursive: true, force: true })
  return true
}

/** Update a library character in place. */
export async function updateLibraryCharacter(
  characterId: string,
  patch: Partial<Character>,
): Promise<Character | null> {
  const file = libraryJsonPath(characterId)
  if (!existsSync(file)) return null
  let result: Character | null = null
  await withLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const merged: Character = {
      ...current,
      name: patch.name?.trim() ?? current.name,
      archetype: patch.archetype?.trim() ?? current.archetype,
      description: patch.description?.trim() ?? current.description,
      speech: patch.speech !== undefined ? patch.speech : current.speech,
      references: patch.references !== undefined ? patch.references : current.references,
      // Assignment tags are managed via assign/unassign, not generic edits —
      // but allow an explicit patch.projects through (e.g. bulk reassign UI).
      projects: patch.projects !== undefined ? normalizeProjects(patch.projects) : current.projects,
      // Library entries are always project-scoped + canonical.
      scope: 'project',
      episode_codes: undefined,
      source: 'project',
      id: current.id,
      created_at: current.created_at,
      schemaVersion: current.schemaVersion,
    }
    await writeJsonAtomic(file, merged)
    result = merged
  })
  return result
}

// ── Project assignment (unified-library model) ─────────────────────────────
//
// A library character carries a `projects: string[]` tag set listing the
// project slugs it's assigned to. The per-project Characters page reads the
// unified view (character-manager.listCharacters) which merges in every
// library character assigned to that slug. Assignment is additive and fully
// reversible — it never copies or mutates the per-project store.

function normalizeProjects(slugs: string[] | undefined): string[] {
  // Dedupe + drop empties; keep order stable for readable diffs on disk.
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of slugs || []) {
    const t = String(s || '').trim()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

function mergeProjects(current: string[] | undefined, add: string[]): string[] {
  return normalizeProjects([...(current || []), ...add])
}

/**
 * Assign a library character to a project (idempotent). Adds `slug` to its
 * `projects[]` tag set. Returns the updated record, or null if the library
 * character doesn't exist.
 */
export async function assignToProject(characterId: string, slug: string): Promise<Character | null> {
  const cleanSlug = String(slug || '').trim()
  if (!cleanSlug) throw new Error('slug is required')
  const file = libraryJsonPath(characterId)
  if (!existsSync(file)) return null
  let result: Character | null = null
  await withLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const merged: Character = { ...current, projects: mergeProjects(current.projects, [cleanSlug]) }
    await writeJsonAtomic(file, merged)
    result = merged
  })
  return result
}

/**
 * Unassign a library character from a project (idempotent). Removes `slug`
 * from its `projects[]`. Returns the updated record, or null if missing.
 * Does NOT delete the library entry or touch any per-project copy.
 */
export async function unassignFromProject(characterId: string, slug: string): Promise<Character | null> {
  const cleanSlug = String(slug || '').trim()
  const file = libraryJsonPath(characterId)
  if (!existsSync(file)) return null
  let result: Character | null = null
  await withLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const merged: Character = {
      ...current,
      projects: normalizeProjects(current.projects).filter(s => s !== cleanSlug),
    }
    await writeJsonAtomic(file, merged)
    result = merged
  })
  return result
}

/** Replace a library character's entire assignment set. Returns null if missing. */
export async function setProjects(characterId: string, slugs: string[]): Promise<Character | null> {
  const file = libraryJsonPath(characterId)
  if (!existsSync(file)) return null
  let result: Character | null = null
  await withLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const merged: Character = { ...current, projects: normalizeProjects(slugs) }
    await writeJsonAtomic(file, merged)
    result = merged
  })
  return result
}

/**
 * List the library characters assigned to a given project. The unified
 * per-project view (character-manager.listCharacters) merges these in. Each
 * record is normalised to `source: 'library'` so the UI can distinguish an
 * assigned-from-library character from a native project character.
 */
export async function listForProject(slug: string): Promise<Character[]> {
  const cleanSlug = String(slug || '').trim()
  if (!cleanSlug) return []
  const all = await listLibrary()
  return all
    .filter(c => normalizeProjects(c.projects).includes(cleanSlug))
    .map(c => ({ ...c, source: 'library' as const }))
}
