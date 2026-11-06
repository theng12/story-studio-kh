/**
 * Channel-owned character library.
 *
 * Canonical records live at ${PROJECTS_ROOT}/.character-library/_channels/<channel>/<id>/.
 * The legacy flat store at ${PROJECTS_ROOT}/.character-library/<id>/ is READ-ONLY:
 * it is the immutable source for channel copies, a fallback for unmigrated
 * characters, and the undo baseline. Nothing writes it.
 *
 * One character belongs to exactly one channel. A channel namespace preserves
 * the record id, so episode codes and every existing character-id reference
 * keep working without a rewrite.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'path'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import * as pm from './project-manager.js'
import * as cm from './character-manager.js'
import { CHARACTER_TRASH, libraryTrashDir, moveToTrashSync } from '../lib/trash-move.js'
import type { Character } from '../models/types.js'

const SCHEMA_VERSION = 1 as const
const CHANNEL_ROOT = '_channels'
const MIGRATION_ROOT = '_migration'

export class CharacterLegacyReadOnlyError extends Error {
  status = 409
  constructor(id: string) {
    super(`Character '${id}' is a read-only legacy record. Migrate the channel library before editing it.`)
  }
}

function libraryRoot(): string {
  return path.join(pm.projectsRoot(), '.character-library')
}

function validateId(value: string): string {
  const id = value.trim()
  if (!id || !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(id)) {
    throw new Error(`Invalid character id '${id}' — must be kebab-case`)
  }
  return id
}

function validateChannelSlug(value: string): string {
  const slug = String(value ?? '').trim()
  if (!slug || slug.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error(`Invalid channel slug '${slug}'`)
  }
  return slug
}

function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || `ref-${Date.now()}`
}

/** A reference name must be one plain file name inside the character folder. */
function referenceNameError(filename: string): string | null {
  if (!filename || filename === '.' || filename === '..'
    || path.isAbsolute(filename) || filename.includes('/') || filename.includes('\\')
    || path.basename(filename) !== filename) {
    return `Reference name '${filename}' is not a plain file name.`
  }
  return null
}

/** lstat, so a symlink is rejected instead of followed out of the source folder. */
async function regularFileExists(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => null)
  return !!stat?.isFile()
}

function normalizeProjects(slugs: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of slugs || []) {
    const t = String(s || '').trim()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

// ── Channel-owned records ──────────────────────────────────────────────────

function channelsRoot(): string {
  return path.join(libraryRoot(), CHANNEL_ROOT)
}

/** Absolute path to a channel-owned character folder. Validated at the chokepoint. */
export function channelCharacterDir(channelSlug: string, characterId: string): string {
  return path.join(channelsRoot(), validateChannelSlug(channelSlug), validateId(characterId))
}

function channelCharacterJsonPath(channelSlug: string, characterId: string): string {
  return path.join(channelCharacterDir(channelSlug, characterId), 'character.json')
}

function channelRecord(record: Character, channelSlug: string, createdAtFallback = new Date().toISOString()): Character {
  return {
    ...record,
    id: record.id,
    scope: 'project',
    episode_codes: undefined,
    projects: [channelSlug],
    // The channel's own voice becomes the record's voice. Other channels'
    // profiles stay only in the immutable legacy source.
    speech: record.channel_profiles?.[channelSlug]?.speech ?? record.speech,
    channel_profiles: undefined,
    source: 'project',
    schemaVersion: record.schemaVersion ?? SCHEMA_VERSION,
    created_at: record.created_at ?? createdAtFallback,
  }
}

function legacyRecordReadOnly(id: string): never {
  throw new CharacterLegacyReadOnlyError(id)
}

/** Create a character owned by one channel. */
export async function createChannelCharacter(
  channelSlug: string,
  draft: Partial<Character> & Pick<Character, 'name' | 'description'>,
): Promise<Character> {
  const slug = validateChannelSlug(channelSlug)
  const name = String(draft.name || '').trim()
  const description = String(draft.description || '').trim()
  if (!name) throw new Error('name is required')
  if (!description) throw new Error('description is required')
  const id = validateId(String(draft.id || slugify(name)))
  const file = channelCharacterJsonPath(slug, id)

  const record = channelRecord({
    ...draft,
    id,
    name,
    description,
    scope: 'project',
    episode_codes: undefined,
    source: 'project',
    schemaVersion: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
  } as Character, slug)

  await fs.mkdir(path.dirname(file), { recursive: true })
  // Same lock migration publish takes: check and create cannot interleave.
  await withLock(file, async () => {
    if (existsSync(file)) {
      const e = new Error(`Channel character id '${id}' already exists on '${slug}'`)
      ;(e as any).status = 409
      throw e
    }
    await writeJsonAtomic(file, record)
  })
  return record
}

/** Read one channel-owned character. Null if missing. */
export async function getChannelCharacter(channelSlug: string, characterId: string): Promise<Character | null> {
  const p = channelCharacterJsonPath(channelSlug, characterId)
  if (!existsSync(p)) return null
  return JSON.parse(await fs.readFile(p, 'utf-8')) as Character
}

/** List one channel's owned characters, sorted by name. */
export async function listChannelCharacters(channelSlug: string): Promise<Character[]> {
  const root = path.join(channelsRoot(), validateChannelSlug(channelSlug))
  if (!existsSync(root)) return []
  let entries: string[] = []
  try { entries = await fs.readdir(root) } catch { return [] }
  const out: Character[] = []
  for (const id of entries) {
    if (id.startsWith('.')) continue
    const file = path.join(root, id, 'character.json')
    if (!existsSync(file)) continue
    try { out.push(JSON.parse(await fs.readFile(file, 'utf-8')) as Character) }
    catch (e: any) { console.warn(`[character-library] skipping malformed channel character '${id}': ${e.message}`) }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Merge a patch into a channel record. The caller holds the record lock. */
async function writeChannelRecordLocked(
  file: string,
  channelSlug: string,
  patch: Partial<Character>,
): Promise<Character> {
  const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
  const merged: Character = {
    ...current,
    name: patch.name?.trim() ?? current.name,
    archetype: typeof patch.archetype === 'string' ? (patch.archetype.trim() || undefined) : current.archetype,
    description: patch.description?.trim() ?? current.description,
    speech: patch.speech !== undefined ? patch.speech : current.speech,
    references: patch.references !== undefined ? patch.references : current.references,
    id: current.id,
    scope: 'project',
    episode_codes: undefined,
    projects: [validateChannelSlug(channelSlug)],
    channel_profiles: undefined,
    source: current.source,
    created_at: current.created_at,
    schemaVersion: current.schemaVersion,
  }
  await writeJsonAtomic(file, merged)
  return merged
}

/** Update a channel-owned character. Legacy records are refused by callers. */
export async function updateChannelCharacter(
  channelSlug: string,
  characterId: string,
  patch: Partial<Character>,
): Promise<Character | null> {
  const file = channelCharacterJsonPath(channelSlug, characterId)
  let result: Character | null = null
  await withLock(file, async () => {
    if (!existsSync(file)) return
    result = await writeChannelRecordLocked(file, channelSlug, patch)
  })
  return result
}

/** Delete a channel-owned character to Story's Trash. */
export async function deleteChannelCharacter(channelSlug: string, characterId: string): Promise<boolean> {
  const dir = channelCharacterDir(channelSlug, characterId)
  let deleted = false
  await withLock(path.join(dir, 'character.json'), async () => {
    if (!existsSync(dir)) return
    moveToTrashSync(
      dir,
      path.join(libraryTrashDir(pm.projectsRoot()), CHARACTER_TRASH, validateChannelSlug(channelSlug), validateId(characterId)),
      'character',
    )
    deleted = true
  })
  return deleted
}

/** Save a reference image beside the channel-owned record. */
export async function addChannelReferenceImage(
  channelSlug: string,
  characterId: string,
  buf: Buffer,
  filename: string,
): Promise<{ relativePath: string; absolutePath: string }> {
  const safe = sanitizeFilename(filename)
  const dir = channelCharacterDir(channelSlug, characterId)
  const file = path.join(dir, 'character.json')
  const absolutePath = path.join(dir, safe)
  let updated: Character | null = null
  await withLock(file, async () => {
    if (!existsSync(file)) return
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const images = new Set(current.references?.images || [])
    images.add(safe)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(absolutePath, buf)
    updated = await writeChannelRecordLocked(file, channelSlug, {
      references: { images: [...images], style_keywords: current.references?.style_keywords },
    })
  })
  if (!updated) throw new Error(`Channel character '${characterId}' not found`)
  return { relativePath: safe, absolutePath }
}

/** Remove one reference image (record entry and file) to Story's Trash. */
export async function removeChannelReferenceImage(
  channelSlug: string,
  characterId: string,
  filename: string,
): Promise<Character> {
  const dir = channelCharacterDir(channelSlug, characterId)
  const file = path.join(dir, 'character.json')
  let updated: Character | null = null
  await withLock(file, async () => {
    if (!existsSync(file)) return
    const current = JSON.parse(await fs.readFile(file, 'utf-8')) as Character
    const images = current.references?.images || []
    if (path.basename(filename) !== filename || !images.includes(filename)) {
      throw new Error(`Reference image '${filename}' not found`)
    }
    updated = await writeChannelRecordLocked(file, channelSlug, {
      references: {
        images: images.filter(f => f !== filename),
        style_keywords: current.references?.style_keywords,
      },
    })
    const refFile = path.join(dir, filename)
    if (existsSync(refFile)) {
      moveToTrashSync(
        refFile,
        path.join(libraryTrashDir(pm.projectsRoot()), CHARACTER_TRASH, validateChannelSlug(channelSlug), validateId(characterId), filename),
        'character-picture',
      )
    }
  })
  if (!updated) throw new Error(`Channel character '${characterId}' not found`)
  return updated
}

/** Save a project character as this channel's owned copy. */
export async function saveToLibrary(
  channelSlug: string,
  sourceCharacterId: string,
  opts?: { libraryId?: string; overwrite?: boolean },
): Promise<Character> {
  const slug = validateChannelSlug(channelSlug)
  const source = (await cm.listOwnCharacters(slug)).find(c => c.id === sourceCharacterId)
  if (!source) throw new Error(`Character '${sourceCharacterId}' not found in channel '${slug}'`)

  const id = validateId(String(opts?.libraryId || source.id))
  const targetDir = channelCharacterDir(slug, id)
  const record = channelRecord({ ...source, id }, slug)
  await withLock(path.join(targetDir, 'character.json'), async () => {
    // Re-check under the record lock: migration may publish between the caller's
    // read and this write.
    if (!opts?.overwrite && existsSync(path.join(targetDir, 'character.json'))) {
      const e = new Error(`Channel character id '${id}' already exists on '${slug}'. Pass overwrite:true to replace.`)
      ;(e as any).status = 409
      throw e
    }
    await fs.mkdir(targetDir, { recursive: true })
    if (source.references?.images?.length) {
      const sourceDir = path.join(pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug), 'characters', source.id)
      for (const filename of source.references.images) {
        try { await fs.copyFile(path.join(sourceDir, filename), path.join(targetDir, filename)) }
        catch (e: any) { console.warn(`[character-library] reference image copy failed (${filename}): ${e.message}`) }
      }
    }
    await writeJsonAtomic(path.join(targetDir, 'character.json'), record)
  })
  return record
}

// ── Legacy flat records: read-only forever ────────────────────────────────

function legacyLibraryDir(characterId: string): string {
  return path.join(libraryRoot(), validateId(characterId))
}

/** Absolute path to a legacy flat record's folder (read-only). */
export function legacyLibraryCharacterDir(characterId: string): string {
  return legacyLibraryDir(characterId)
}

function legacyLibraryJsonPath(characterId: string): string {
  return path.join(legacyLibraryDir(characterId), 'character.json')
}

/** Read one legacy flat character. Null if missing. */
export async function getLibraryCharacter(characterId: string): Promise<Character | null> {
  const p = legacyLibraryJsonPath(characterId)
  if (!existsSync(p)) return null
  return JSON.parse(await fs.readFile(p, 'utf-8')) as Character
}

/** List the immutable legacy flat store, sorted by name. */
export async function listLibrary(): Promise<Character[]> {
  const root = libraryRoot()
  if (!existsSync(root)) return []
  let entries: string[] = []
  try { entries = await fs.readdir(root) } catch { return [] }
  const out: Character[] = []
  for (const id of entries) {
    if (id.startsWith('.') || id === CHANNEL_ROOT) continue
    const file = legacyLibraryJsonPath(id)
    if (!existsSync(file)) continue
    try { out.push(JSON.parse(await fs.readFile(file, 'utf-8')) as Character) }
    catch (e: any) { console.warn(`[character-library] skipping malformed legacy entry '${id}': ${e.message}`) }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function rejectLegacyWrite(characterId: string): never {
  return legacyRecordReadOnly(characterId)
}

/**
 * Merged per-channel read: channel-owned records first, then legacy records
 * assigned to this channel whose id has not been copied yet. Legacy rows are
 * resolved through their channel voice profile and flagged source='library'.
 */
export async function listForProject(channelSlug: string): Promise<Character[]> {
  const slug = validateChannelSlug(channelSlug)
  const owned = await listChannelCharacters(slug)
  const ownedIds = new Set(owned.map(c => c.id))
  const legacy = (await listLibrary())
    .filter(c => normalizeProjects(c.projects).includes(slug) && !ownedIds.has(c.id))
    .map(c => resolveForChannel(c, slug))
  // Channel-owned records stay source='project'; only the read-only legacy
  // fallback is marked source='library' so the UI can disable editing it.
  return [...owned, ...legacy]
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve the effective voice profile for one channel. */
export function resolveForChannel(character: Character, channelSlug: string): Character {
  return {
    ...character,
    scope: 'project',
    episode_codes: undefined,
    speech: character.channel_profiles?.[channelSlug]?.speech || character.speech,
    source: 'library',
  }
}

// ── Compatibility names for existing callers/tests ─────────────────────────
// These are channel-scoped; they cannot create or mutate a multi-channel record.

async function uniqueChannelRecord(characterId: string): Promise<{ channel: string; record: Character } | null> {
  const root = channelsRoot()
  if (!existsSync(root)) return null
  const found: Array<{ channel: string; record: Character }> = []
  for (const channel of await fs.readdir(root)) {
    if (channel.startsWith('.') || channel === MIGRATION_ROOT) continue
    const record = await getChannelCharacter(channel, characterId).catch(() => null)
    if (record) found.push({ channel, record })
  }
  if (found.length > 1) throw new Error(`Character id '${characterId}' exists on more than one channel; pass the channel explicitly.`)
  return found[0] || null
}

/** Create a channel record from a legacy-shaped draft that names exactly one channel. */
export async function createLibraryCharacter(
  draft: Partial<Character> & Pick<Character, 'name' | 'description'>,
): Promise<Character> {
  const channels = normalizeProjects(draft.projects)
  if (channels.length !== 1) throw new Error('A character must name exactly one channel.')
  return createChannelCharacter(channels[0], draft)
}

export async function updateLibraryCharacter(characterId: string, patch: Partial<Character>): Promise<Character | null> {
  const found = await uniqueChannelRecord(characterId)
  if (!found) legacyRecordReadOnly(characterId)
  return updateChannelCharacter(found.channel, characterId, patch)
}

export async function deleteLibraryCharacter(characterId: string): Promise<boolean> {
  const found = await uniqueChannelRecord(characterId)
  if (!found) return false
  return deleteChannelCharacter(found.channel, characterId)
}

export async function addLibraryReferenceImage(
  characterId: string, buf: Buffer, filename: string,
): Promise<{ relativePath: string; absolutePath: string }> {
  const found = await uniqueChannelRecord(characterId)
  if (!found) throw new Error(`Channel character '${characterId}' not found`)
  return addChannelReferenceImage(found.channel, characterId, buf, filename)
}

export async function removeLibraryReferenceImage(characterId: string, filename: string): Promise<Character> {
  const found = await uniqueChannelRecord(characterId)
  if (!found) throw new Error(`Channel character '${characterId}' not found`)
  return removeChannelReferenceImage(found.channel, characterId, filename)
}

export function libraryCharacterDir(characterId: string): string {
  const channels = channelsRoot()
  if (existsSync(channels)) {
    for (const channel of require('fs').readdirSync(channels) as string[]) {
      if (channel.startsWith('.') || channel === MIGRATION_ROOT) continue
      const dir = path.join(channels, channel, validateId(characterId))
      if (existsSync(path.join(dir, 'character.json'))) return dir
    }
  }
  return legacyLibraryDir(characterId)
}

// ── Migration: immutable legacy → one channel-owned copy per channel ──────

interface MigrationEntry {
  character_id: string
  channel: string
  source_dir: string
  target_dir: string
  source_record_sha: string
  target_record_sha: string
  /** Chosen once in buildPlan so re-deriving the copy is byte-identical. */
  target_created_at?: string
  source_files: Record<string, string>
  target_files: Record<string, string>
  /** Verified copy of the source bytes, written before any channel publish. */
  backup_dir?: string
  backup_record_sha?: string
  backup_files?: Record<string, string>
  status: 'pending' | 'copied' | 'failed'
  error?: string
}

export interface CharacterMigrationConflict {
  character_id: string
  channel: string
  reason: 'target_changed' | 'project_local_conflict' | 'missing_reference' | 'source_changed' | 'publish_verify_failed' | 'channel_missing' | 'invalid'
  detail?: string
}

export interface CharacterMigrationReport {
  run_id?: string
  legacy_records: number
  assigned_records: number
  unassigned_records: number
  copies_planned: number
  copies_created: number
  already_present: number
  conflicts: CharacterMigrationConflict[]
  missing_references: Array<{ character_id: string; channel: string; filenames: string[] }>
  copies: Array<{ character_id: string; channel: string; target_dir: string }>
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function sha256File(file: string): Promise<string> {
  return sha256(await fs.readFile(file))
}

function recordBody(record: Character): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * A stable created_at for migration hashes. Legacy records may not carry one;
 * the file's mtime is the same on every preview of an untouched record.
 */
async function legacyCreatedAt(record: Character, sourceDir: string): Promise<string> {
  if (record.created_at) return record.created_at
  return (await fs.stat(path.join(sourceDir, 'character.json'))).mtime.toISOString()
}

function migrationRoot(): string {
  return path.join(channelsRoot(), MIGRATION_ROOT)
}

function manifestPath(runId: string): string {
  return path.join(migrationRoot(), runId, 'manifest.json')
}

function validRunId(runId: string): string {
  const value = String(runId || '').trim()
  // Exactly the id applyChannelMigration generates: ISO timestamp (":" and "."
  // swapped for "-") plus eight hex characters. No "." or ".." can pass.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/.test(value)) {
    throw new Error(`Invalid migration run id '${value}'`)
  }
  return value
}

async function buildPlan(): Promise<{
  entries: MigrationEntry[]
  report: CharacterMigrationReport
}> {
  const legacy = await listLibrary()
  const report: CharacterMigrationReport = {
    legacy_records: legacy.length,
    assigned_records: 0,
    unassigned_records: 0,
    copies_planned: 0,
    copies_created: 0,
    already_present: 0,
    conflicts: [],
    missing_references: [],
    copies: [],
  }
  const entries: MigrationEntry[] = []

  for (const record of legacy) {
    const channels = normalizeProjects(record.projects)
    if (!channels.length) { report.unassigned_records++; continue }
    report.assigned_records++

    for (const rawChannel of channels) {
      let channel: string
      try { channel = validateChannelSlug(rawChannel) }
      catch (e: any) {
        report.conflicts.push({ character_id: record.id, channel: rawChannel, reason: 'invalid', detail: e.message })
        continue
      }
      let projectExists = false
      try { projectExists = (await pm.getProject(channel)) !== null }
      catch (e: any) {
        report.conflicts.push({ character_id: record.id, channel, reason: 'invalid', detail: e.message })
        continue
      }
      if (!projectExists) {
        report.conflicts.push({ character_id: record.id, channel, reason: 'channel_missing', detail: `Channel '${channel}' has no project; its assignment was not migrated.` })
        continue
      }
      const sourceDir = legacyLibraryDir(record.id)
      const targetDir = channelCharacterDir(channel, record.id)

      const own = await cm.listOwnCharacters(channel)
      if (own.some(c => c.id === record.id)) {
        report.conflicts.push({ character_id: record.id, channel, reason: 'project_local_conflict', detail: `A project-local character '${record.id}' already exists in '${channel}'. Rename one before migrating; nothing was copied.` })
        continue
      }

      const targetCreatedAt = await legacyCreatedAt(record, sourceDir)
      const expected = channelRecord(record, channel, targetCreatedAt)
      const targetRecordSha = sha256(recordBody(expected))
      const files = record.references?.images || []
      const missing: string[] = []
      const sourceFiles: Record<string, string> = {}
      let invalidReference = ''
      for (const filename of files) {
        const nameError = referenceNameError(filename)
        if (nameError) { invalidReference = nameError; break }
        const source = path.join(sourceDir, filename)
        if (!existsSync(source)) { missing.push(filename); continue }
        if (!await regularFileExists(source)) {
          invalidReference = `Reference '${filename}' is not a regular file.`
          break
        }
        sourceFiles[filename] = await sha256File(source)
      }
      if (invalidReference) {
        report.conflicts.push({ character_id: record.id, channel, reason: 'invalid', detail: invalidReference })
        continue
      }
      if (missing.length) {
        report.missing_references.push({ character_id: record.id, channel, filenames: missing })
        report.conflicts.push({ character_id: record.id, channel, reason: 'missing_reference', detail: missing.join(', ') })
        continue
      }

      if (existsSync(path.join(targetDir, 'character.json'))) {
        const current = await getChannelCharacter(channel, record.id)
        if (current && sha256(recordBody(current)) === targetRecordSha) {
          report.already_present++
        } else {
          report.conflicts.push({ character_id: record.id, channel, reason: 'target_changed', detail: 'A channel copy exists with different content; it was not overwritten.' })
        }
        continue
      }

      report.copies_planned++
      entries.push({
        character_id: record.id,
        channel,
        source_dir: sourceDir,
        target_dir: targetDir,
        source_record_sha: await sha256File(path.join(sourceDir, 'character.json')),
        target_record_sha: targetRecordSha,
        target_created_at: targetCreatedAt,
        source_files: sourceFiles,
        target_files: { ...sourceFiles },
        status: 'pending',
      })
    }
  }
  return { entries, report }
}

/** Dry run: counts, conflicts and missing references. Writes nothing. */
export async function previewChannelMigration(): Promise<CharacterMigrationReport> {
  return (await buildPlan()).report
}

async function discardStaging(dir: string, channel: string, characterId: string): Promise<void> {
  if (!existsSync(dir)) return
  moveToTrashSync(
    dir,
    path.join(libraryTrashDir(pm.projectsRoot()), CHARACTER_TRASH, channel, `${characterId}-staging`),
    'character-staging',
  )
}

/** Copy one entry to staging, verify its bytes, then publish by atomic rename. */
async function migrateEntry(entry: MigrationEntry): Promise<CharacterMigrationConflict | null> {
  const stageDir = path.join(channelsRoot(), entry.channel, `.staging-${entry.character_id}-${randomUUID()}`)
  try {
    // Re-read the immutable source at apply time; a manifest is not proof.
    if (!existsSync(path.join(entry.source_dir, 'character.json'))) {
      return { character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: 'Legacy source record disappeared.' }
    }
    for (const [filename, expected] of Object.entries(entry.source_files)) {
      const source = path.join(entry.source_dir, filename)
      if (!await regularFileExists(source) || await sha256File(source) !== expected) {
        return { character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: `Legacy reference '${filename}' changed during migration.` }
      }
    }
    const legacy = await getLibraryCharacter(entry.character_id)
    if (!legacy) {
      return { character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: 'Legacy record disappeared.' }
    }
    const expectedRecord = channelRecord(legacy, entry.channel, entry.target_created_at)
    if (sha256(recordBody(expectedRecord)) !== entry.target_record_sha) {
      return { character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: 'Legacy record changed during migration.' }
    }

    await fs.mkdir(stageDir, { recursive: true })
    for (const filename of Object.keys(entry.source_files)) {
      await fs.copyFile(path.join(entry.source_dir, filename), path.join(stageDir, filename))
    }
    await fs.writeFile(path.join(stageDir, 'character.json'), recordBody(expectedRecord))

    // Verify the staged snapshot against the source bytes, not just the manifest.
    if (await sha256File(path.join(stageDir, 'character.json')) !== entry.target_record_sha) {
      await discardStaging(stageDir, entry.channel, entry.character_id)
      return { character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: 'Staged record did not match the verified copy.' }
    }
    for (const [filename, expected] of Object.entries(entry.source_files)) {
      if (await sha256File(path.join(stageDir, filename)) !== expected) {
        await discardStaging(stageDir, entry.channel, entry.character_id)
        return { character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: `Staged reference '${filename}' did not match the legacy file.` }
      }
    }

    await fs.mkdir(path.dirname(entry.target_dir), { recursive: true })
    let appeared = false
    let verifyFailure = ''
    // Hold the record lock through publish verification and cleanup: a save
    // cannot slip between the rename and the checks and be mistaken for corruption.
    await withLock(path.join(entry.target_dir, 'character.json'), async () => {
      if (existsSync(entry.target_dir)) { appeared = true; return }
      await fs.rename(stageDir, entry.target_dir)

      if (await sha256File(path.join(entry.target_dir, 'character.json')) !== entry.target_record_sha) {
        await discardStaging(entry.target_dir, entry.channel, entry.character_id)
        verifyFailure = 'Published record failed verification and was moved to Trash.'
        return
      }
      for (const [filename, expected] of Object.entries(entry.source_files)) {
        if (await sha256File(path.join(entry.target_dir, filename)) !== expected) {
          await discardStaging(entry.target_dir, entry.channel, entry.character_id)
          verifyFailure = `Published reference '${filename}' failed verification and the copy was moved to Trash.`
          return
        }
      }
    })
    if (appeared) {
      await discardStaging(stageDir, entry.channel, entry.character_id)
      return { character_id: entry.character_id, channel: entry.channel, reason: 'target_changed', detail: 'Channel copy appeared during migration; nothing was overwritten.' }
    }
    if (verifyFailure) {
      return { character_id: entry.character_id, channel: entry.channel, reason: 'publish_verify_failed', detail: verifyFailure }
    }
    return null
  } catch (e: any) {
    await discardStaging(stageDir, entry.channel, entry.character_id)
    return { character_id: entry.character_id, channel: entry.channel, reason: 'publish_verify_failed', detail: e.message }
  }
}

interface MigrationSnapshot {
  dir: string
  record_sha: string
  files: Record<string, string>
}

/**
 * Copy the verified legacy bytes into the run folder before any channel is
 * published. The legacy store stays read-only; this backup is the recovery
 * copy the manifest points at.
 */
async function snapshotSources(runDir: string, entries: MigrationEntry[]): Promise<Map<string, MigrationSnapshot | Error>> {
  const snapshots = new Map<string, MigrationSnapshot | Error>()
  for (const entry of entries) {
    if (snapshots.has(entry.character_id)) continue
    try {
      const dir = path.join(runDir, 'backup', entry.character_id)
      if (existsSync(dir)) throw new Error(`Migration backup already exists at '${dir}'.`)
      await fs.mkdir(dir, { recursive: true })
      const recordBytes = await fs.readFile(path.join(entry.source_dir, 'character.json'))
      if (sha256(recordBytes) !== entry.source_record_sha) throw new Error('Legacy record changed before the backup snapshot.')
      await fs.writeFile(path.join(dir, 'character.json'), recordBytes)
      for (const [filename, expected] of Object.entries(entry.source_files)) {
        const source = path.join(entry.source_dir, filename)
        if (!await regularFileExists(source)) throw new Error(`Legacy reference '${filename}' is missing or not a regular file.`)
        const bytes = await fs.readFile(source)
        if (sha256(bytes) !== expected) throw new Error(`Legacy reference '${filename}' changed before the backup snapshot.`)
        await fs.writeFile(path.join(dir, filename), bytes)
      }
      if (await sha256File(path.join(dir, 'character.json')) !== entry.source_record_sha) throw new Error('Backup record failed verification.')
      for (const [filename, expected] of Object.entries(entry.source_files)) {
        if (await sha256File(path.join(dir, filename)) !== expected) throw new Error(`Backup reference '${filename}' failed verification.`)
      }
      snapshots.set(entry.character_id, { dir, record_sha: entry.source_record_sha, files: { ...entry.source_files } })
    } catch (e: any) {
      snapshots.set(entry.character_id, e instanceof Error ? e : new Error(String(e)))
    }
  }
  return snapshots
}

/** Apply the migration. Every copy is staged, verified, then atomically published. */
export async function applyChannelMigration(): Promise<CharacterMigrationReport> {
  const { entries, report } = await buildPlan()
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  report.run_id = runId
  const manifest = {
    run_id: runId,
    created_at: new Date().toISOString(),
    source: 'legacy-flat',
    entries,
  }
  const runDir = path.dirname(manifestPath(runId))
  await fs.mkdir(runDir, { recursive: true })
  const snapshots = await snapshotSources(runDir, entries)
  for (const entry of entries) {
    const snapshot = snapshots.get(entry.character_id)
    if (!snapshot || snapshot instanceof Error) {
      entry.status = 'failed'
      entry.error = snapshot instanceof Error ? snapshot.message : 'Backup snapshot failed.'
      report.conflicts.push({ character_id: entry.character_id, channel: entry.channel, reason: 'source_changed', detail: entry.error })
      continue
    }
    entry.backup_dir = snapshot.dir
    entry.backup_record_sha = snapshot.record_sha
    entry.backup_files = snapshot.files
  }
  // Manifest with every source hash and backup path is on disk BEFORE the first copy.
  await writeJsonAtomic(manifestPath(runId), manifest)

  for (const entry of manifest.entries) {
    if (entry.status === 'failed') continue
    const conflict = await migrateEntry(entry)
    if (conflict) {
      entry.status = 'failed'
      entry.error = conflict.detail
      report.conflicts.push(conflict)
    } else {
      entry.status = 'copied'
      report.copies_created++
      report.copies.push({ character_id: entry.character_id, channel: entry.channel, target_dir: entry.target_dir })
    }
    await writeJsonAtomic(manifestPath(runId), manifest)
  }
  return report
}

export interface CharacterMigrationUndoReport {
  run_id: string
  removed: number
  already_absent: number
  refused: CharacterMigrationConflict[]
  missing_manifest: boolean
}

/** '' when the folder is exactly the copy this run planned, else the change found. */
async function targetMismatch(target: string, entry: MigrationEntry): Promise<string> {
  const expected = new Set(['character.json', ...Object.keys(entry.source_files)])
  try {
    const names = await fs.readdir(target)
    for (const name of names) {
      if (!expected.has(name)) return `extra file '${name}'`
    }
    if (await sha256File(path.join(target, 'character.json')) !== entry.target_record_sha) return 'character.json changed'
    for (const [filename, hash] of Object.entries(entry.source_files)) {
      if (await sha256File(path.join(target, filename)) !== hash) return `reference '${filename}' changed`
    }
  } catch (e: any) { return e.message }
  return ''
}

/** Undo one run. Changed copies are refused: an edit is never thrown away. */
export async function undoChannelMigration(runIdInput: string): Promise<CharacterMigrationUndoReport> {
  const runId = validRunId(runIdInput)
  const file = manifestPath(runId)
  if (!existsSync(file)) {
    return { run_id: runId, removed: 0, already_absent: 0, refused: [], missing_manifest: true }
  }
  const manifest = JSON.parse(await fs.readFile(file, 'utf-8')) as { entries: MigrationEntry[] }
  const report: CharacterMigrationUndoReport = { run_id: runId, removed: 0, already_absent: 0, refused: [], missing_manifest: false }

  for (const entry of manifest.entries) {
    let target: string
    try { target = channelCharacterDir(entry.channel, entry.character_id) }
    catch (e: any) {
      report.refused.push({ character_id: entry.character_id, channel: entry.channel, reason: 'invalid', detail: e.message })
      continue
    }
    // Only the exact channel/id folder this run computed may be undone.
    if (typeof entry.target_dir !== 'string' || path.resolve(entry.target_dir) !== path.resolve(target)) {
      report.refused.push({ character_id: entry.character_id, channel: entry.channel, reason: 'invalid', detail: 'Manifest target is not this channel/id folder.' })
      continue
    }
    if (entry.status === 'pending') {
      // Crash after the atomic rename but before the manifest write: adopt the
      // pending copy only when it is byte-for-byte what this run planned.
      if (existsSync(target) && !await targetMismatch(target, entry)) entry.status = 'copied'
      else continue
    }
    if (entry.status !== 'copied') continue
    if (!existsSync(target)) { report.already_absent++; continue }

    let changed = ''
    let absent = false
    // Same per-record lock updateChannelCharacter uses, so a writer cannot edit
    // between the verification and the move.
    await withLock(path.join(target, 'character.json'), async () => {
      if (!existsSync(target)) { absent = true; return }
      changed = await targetMismatch(target, entry)
      if (changed) return
      moveToTrashSync(
        target,
        path.join(libraryTrashDir(pm.projectsRoot()), CHARACTER_TRASH, entry.channel, entry.character_id),
        'character-migration-undo',
      )
    })
    if (absent) { report.already_absent++; continue }
    if (changed) {
      report.refused.push({ character_id: entry.character_id, channel: entry.channel, reason: 'target_changed', detail: `Copy was edited (${changed}); it was left in place.` })
      continue
    }
    entry.status = 'failed'
    entry.error = 'undone'
    report.removed++
  }
  await writeJsonAtomic(file, manifest)
  return report
}
