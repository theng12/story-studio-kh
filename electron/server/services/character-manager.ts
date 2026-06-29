/**
 * Character primitive — CRUD over per-project character files.
 *
 * Layout:
 *   ${PROJECTS_ROOT}/${slug}/characters/
 *     ├── {character-id}/
 *     │     ├── character.json    (the Character record)
 *     │     └── <reference image files>   (optional, referenced from character.references.images)
 *     └── …
 *
 * The whole tree travels with the project folder when transferred between
 * machines (relative paths in references.images keep the cross-machine
 * portability invariant from audit Session 05).
 *
 * Scope filtering: episode-scoped characters carry an episode_codes array;
 * the script-page picker filters by current episode_code. Project-scoped
 * characters appear for every episode.
 *
 * IMPORTANT: this service is the ONLY writer of the characters tree. Every
 * mutator goes through atomic-store.withLock + writeJsonAtomic so two
 * concurrent updates can't corrupt the per-character file.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import * as pm from './project-manager.js'
import type { Character } from '../models/types.js'

const SCHEMA_VERSION = 1 as const

function projectCharactersDir(slug: string): string {
  // Honour linked-project locations so iCloud-synced projects find their
  // characters tree. Default-location fallback covers fresh-project
  // creation flows.
  const dir = pm.getProjectDir(slug) || path.join(pm.PROJECTS_ROOT, slug)
  return path.join(dir, 'characters')
}

function characterDir(slug: string, characterId: string): string {
  return path.join(projectCharactersDir(slug), characterId)
}

/**
 * Public helper — resolves the absolute disk path of a reference image
 * filename for a given character. Used by the /describe-from-image vision
 * route so it doesn't have to redo path arithmetic.
 */
export function referenceImagePath(slug: string, characterId: string, filename: string): string {
  const projectPath = path.join(characterDir(slug, characterId), filename)
  if (existsSync(projectPath)) return projectPath
  // Unified-library fallback: a character assigned from the app-level library
  // keeps its reference images in the library folder, not the project folder.
  // Resolve the path inline (sync) to avoid an async import here — the
  // library layout is a stable constant shared with character-library.ts.
  const libraryPath = path.join(pm.PROJECTS_ROOT, '.character-library', characterId, filename)
  if (existsSync(libraryPath)) return libraryPath
  // Neither exists — preserve legacy behaviour (the project path; callers
  // existsSync-check before reading).
  return projectPath
}

function characterJsonPath(slug: string, characterId: string): string {
  return path.join(characterDir(slug, characterId), 'character.json')
}

/**
 * Read one character. Returns null on missing file. Throws on malformed
 * JSON so callers can surface the corruption rather than silently using
 * a stale or missing character.
 *
 * Unified-library fallback: when the project has no on-disk character with
 * this id, we look for a library character assigned to this project (its
 * `projects[]` includes `slug`). This keeps every consumer that calls
 * getCharacter (prompt-director, continuity-render, resolveCharacters →
 * episode/image-prompts) working for assigned-from-library characters with
 * no per-consumer change. See docs/character-unification-spec.md.
 */
export async function getCharacter(slug: string, characterId: string): Promise<Character | null> {
  const p = characterJsonPath(slug, characterId)
  if (existsSync(p)) {
    const raw = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as Character
    return normalize(parsed)
  }
  // Fall back to an assigned library character.
  const cl = await import('./character-library.js')
  const lib = await cl.getLibraryCharacter(characterId)
  if (lib && (lib.projects || []).includes(slug)) {
    return normalize({ ...lib, source: 'library' })
  }
  return null
}

/**
 * List the project's OWN on-disk characters only (no library merge). The
 * old `listCharacters` body — kept separate so the migration and the unified
 * reader can see the un-merged per-project store. Optional filter by current
 * episode_code narrows to project-scoped + episode-scoped-matching characters.
 */
export async function listOwnCharacters(slug: string, opts?: { episodeCode?: string }): Promise<Character[]> {
  const dir = projectCharactersDir(slug)
  if (!existsSync(dir)) return []

  let entries: string[] = []
  try { entries = await fs.readdir(dir) } catch { return [] }

  const out: Character[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue  // skip dotfiles (.DS_Store etc.)
    const file = characterJsonPath(slug, id)
    if (!existsSync(file)) continue
    try {
      const c = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
      const normalised = normalize(c)
      if (opts?.episodeCode) {
        if (normalised.scope === 'project') {
          out.push(normalised)
        } else if (normalised.scope === 'episode' && normalised.episode_codes?.includes(opts.episodeCode)) {
          out.push(normalised)
        }
      } else {
        out.push(normalised)
      }
    } catch (e: any) {
      console.warn(`[character-manager] skipping malformed character '${id}' for project '${slug}': ${e.message}`)
    }
  }
  // Stable order: project-scoped characters first (brand cast appears at the top of pickers).
  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/**
 * List all characters visible to a project — the UNIFIED view. This is what
 * every consumer (the Characters page, the picker, the image/audio generators)
 * sees. It is the project's own on-disk characters PLUS every library
 * character assigned to this project (`projects[]` includes `slug`),
 * de-duplicated by id with the on-disk project character winning.
 *
 * Library characters carry project-scope semantics, so they appear for every
 * episode regardless of the `episodeCode` filter (same as a scope:'project'
 * character). Dedup-by-id (project wins) means a character that has been both
 * migrated into the library AND left on disk shows up exactly once — running
 * the migration never produces duplicates. See docs/character-unification-spec.md.
 */
export async function listCharacters(slug: string, opts?: { episodeCode?: string }): Promise<Character[]> {
  const own = await listOwnCharacters(slug, opts)
  let assigned: Character[] = []
  try {
    const cl = await import('./character-library.js')
    assigned = await cl.listForProject(slug)
  } catch (e: any) {
    console.warn(`[character-manager] could not merge library characters for '${slug}': ${e.message}`)
  }
  if (!assigned.length) return own

  const ownIds = new Set(own.map(c => c.id))
  const merged = own.slice()
  for (const lib of assigned) {
    if (ownIds.has(lib.id)) continue  // project copy wins on id collision
    merged.push(normalize({ ...lib, source: 'library' }))
  }
  // Re-apply the stable picker order across the merged set.
  merged.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return merged
}

/**
 * Resolve a list of character ids to Character objects, dropping any that
 * are missing (with a warning). Used by the script generator to convert
 * GenerateScriptRequest.character_ids → real cast data for prompt assembly.
 */
export async function resolveCharacters(slug: string, ids: string[]): Promise<Character[]> {
  const out: Character[] = []
  for (const id of ids) {
    try {
      const c = await getCharacter(slug, id)
      if (c) out.push(c)
      else console.warn(`[character-manager] character '${id}' not found in project '${slug}'`)
    } catch (e: any) {
      console.warn(`[character-manager] failed to load character '${id}': ${e.message}`)
    }
  }
  return out
}

/**
 * Create a new character. `id` MUST be a kebab-case slug (file-system safe);
 * `name` and `description` are required; `scope` defaults to 'episode'.
 * If scope === 'episode', episode_codes MUST be a non-empty array.
 *
 * Returns the persisted Character (with normalised defaults). Throws on
 * id collision; the route handler surfaces this as 409.
 */
export async function createCharacter(
  slug: string,
  draft: Partial<Character> & Pick<Character, 'name' | 'description'>,
): Promise<Character> {
  if (!await pm.getProject(slug)) {
    throw new Error(`Project '${slug}' not found`)
  }

  const id = String(draft.id || slugify(draft.name)).trim()
  if (!id || !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(id)) {
    throw new Error(`Invalid character id '${id}' — must be kebab-case (lowercase, hyphens, alphanumeric)`)
  }
  if (existsSync(characterJsonPath(slug, id))) {
    const e = new Error(`Character id '${id}' already exists in project '${slug}'`)
    ;(e as any).status = 409
    throw e
  }

  const scope = draft.scope || 'episode'
  if (scope === 'episode' && (!draft.episode_codes || draft.episode_codes.length === 0)) {
    throw new Error("scope='episode' requires episode_codes to be a non-empty array")
  }

  const character: Character = {
    id,
    name: draft.name.trim(),
    archetype: draft.archetype?.trim() || undefined,
    description: draft.description.trim(),
    scope,
    episode_codes: scope === 'episode' ? [...(draft.episode_codes || [])] : undefined,
    speech: draft.speech ? { ...draft.speech } : undefined,
    references: draft.references ? {
      images: draft.references.images ? [...draft.references.images] : undefined,
      style_keywords: draft.references.style_keywords ? [...draft.references.style_keywords] : undefined,
    } : undefined,
    source: draft.source || 'project',
    schemaVersion: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
  }

  const dir = characterDir(slug, id)
  await fs.mkdir(dir, { recursive: true })
  const file = characterJsonPath(slug, id)
  await withLock(file, async () => {
    await writeJsonAtomic(file, character)
  })
  return character
}

/**
 * Update an existing character. Merges `patch` onto the persisted record.
 * `id`, `created_at`, `schemaVersion`, `source` are NOT patchable — use
 * promoteScope / delete + recreate instead.
 */
export async function updateCharacter(
  slug: string,
  characterId: string,
  patch: Partial<Character>,
): Promise<Character | null> {
  const file = characterJsonPath(slug, characterId)
  if (!existsSync(file)) return null

  let result: Character | null = null
  await withLock(file, async () => {
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const merged: Character = {
      ...current,
      // Allow patching display fields, scope (with episode_codes constraint),
      // speech, references, archetype.
      name: patch.name?.trim() ?? current.name,
      archetype: patch.archetype?.trim() ?? current.archetype,
      description: patch.description?.trim() ?? current.description,
      scope: patch.scope ?? current.scope,
      episode_codes: patch.episode_codes ?? current.episode_codes,
      speech: patch.speech !== undefined ? patch.speech : current.speech,
      references: patch.references !== undefined ? patch.references : current.references,
      // Immutable fields:
      id: current.id,
      created_at: current.created_at,
      schemaVersion: current.schemaVersion,
      source: current.source,
    }
    if (merged.scope === 'episode' && (!merged.episode_codes || merged.episode_codes.length === 0)) {
      throw new Error("scope='episode' requires non-empty episode_codes (drop scope to 'project' to clear)")
    }
    if (merged.scope === 'project') {
      merged.episode_codes = undefined
    }
    await writeJsonAtomic(file, merged)
    result = normalize(merged)
  })
  return result
}

/**
 * Promote scope episode → project (drops episode_codes). One-click action
 * in the picker UI. Returns the updated character.
 */
export async function promoteToProject(slug: string, characterId: string): Promise<Character | null> {
  return updateCharacter(slug, characterId, { scope: 'project', episode_codes: undefined })
}

/** Delete a character (and its reference images). */
export async function deleteCharacter(slug: string, characterId: string): Promise<boolean> {
  const dir = characterDir(slug, characterId)
  if (!existsSync(dir)) return false
  await fs.rm(dir, { recursive: true, force: true })
  return true
}

/**
 * Save a reference image into a character's folder. Returns the relative
 * path to store in `character.references.images[]` (relative so the project
 * stays portable across machines). Caller has already validated mime-type
 * and size.
 */
export async function addReferenceImage(
  slug: string,
  characterId: string,
  buf: Buffer,
  filename: string,
): Promise<{ relativePath: string; absolutePath: string }> {
  if (!existsSync(characterJsonPath(slug, characterId))) {
    throw new Error(`Character '${characterId}' not found in project '${slug}'`)
  }
  const safe = sanitizeFilename(filename)
  const destDir = characterDir(slug, characterId)
  await fs.mkdir(destDir, { recursive: true })
  const absolutePath = path.join(destDir, safe)
  await fs.writeFile(absolutePath, buf)

  // Update the character record to include this image in references.images
  // (idempotent — skips if already listed).
  await updateCharacter(slug, characterId, {
    references: await mergeReferenceImage(slug, characterId, safe),
  })

  return { relativePath: safe, absolutePath }
}

async function mergeReferenceImage(slug: string, characterId: string, filename: string): Promise<Character['references']> {
  const current = await getCharacter(slug, characterId)
  const images = new Set(current?.references?.images || [])
  images.add(filename)
  return {
    images: [...images],
    style_keywords: current?.references?.style_keywords,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function sanitizeFilename(name: string): string {
  // Strip directory components, keep basename only. Replace anything
  // non-alphanumeric (except . and -) with _ to avoid path traversal.
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || `ref-${Date.now()}`
}

function normalize(c: Character): Character {
  // Tolerate older / hand-edited records that miss some optional fields.
  return {
    ...c,
    schemaVersion: c.schemaVersion ?? SCHEMA_VERSION,
    source: c.source ?? 'project',
    created_at: c.created_at ?? new Date(0).toISOString(),
  }
}
