import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type { Niche, ProjectMeta, ThumbnailTemplate, TopicPack, UpdateConfigRequest } from '../models/types.js'
import * as projectManager from '../services/project-manager.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import { withContentPackCoordinationLock } from './state.js'
import type { ContentPackItemKind, UserForkableContentPackItemKind } from './types.js'
import {
  isQualifiedContentPackId,
  resolveCatalogItem,
  type ContentPackRegistryOptions,
} from './registry.js'

export type UserForkId = `user:${string}`
export type UserForkDocument = Niche | TopicPack | ThumbnailTemplate

/**
 * Where a fork's content came from. `content-pack` is a Formula or Topic Pack
 * that ships as a Content Pack (owner, 2026-10-29: every Formula comes from a
 * pack): its channel stores the qualified item id, so editing it must fork the
 * installable item rather than look for a built-in file that no longer speaks
 * for it.
 */
export type UserForkSource = 'legacy-builtin' | 'legacy-user-fork' | 'content-pack'

export interface UserForkRecord {
  schema_version: 1
  fork_id: UserForkId
  kind: UserForkableContentPackItemKind
  source: {
    catalog_source: UserForkSource
    legacy_id: string
  }
  created_at: string
  document: UserForkDocument
}

export interface LegacyShadowConflict {
  kind: ContentPackItemKind
  legacy_id: string
  signed_item_id?: string
  referencing_project_slugs: string[]
}

export type UserForkOptions = Pick<ContentPackRegistryOptions,
  'paths' | 'policy' | 'recoveryRoot' | 'appVersion'
>

const USER_FORK_ID = /^user:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const LEGACY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_FORK_RECORDS = 5_000

function pathsFor(options: UserForkOptions): ContentPackRuntimePaths {
  return options.paths ?? getContentPackRuntimePaths()
}

function userForkRoot(paths: ContentPackRuntimePaths): string {
  return path.join(paths.root, 'user-forks')
}

function forkPath(paths: ContentPackRuntimePaths, id: UserForkId): string {
  const match = USER_FORK_ID.exec(id)
  if (!match) throw Object.assign(new Error('Invalid user Content Pack fork id'), { statusCode: 400, expose: true })
  return path.join(userForkRoot(paths), `${match[1]!.toLowerCase()}.json`)
}

async function assertSafeRuntimeRoot(paths: ContentPackRuntimePaths, create = false): Promise<void> {
  if (create) await fs.mkdir(path.dirname(paths.root), { recursive: true })
  try {
    const stat = await fs.lstat(paths.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Content Pack runtime root is not a safe directory')
  } catch (error: unknown) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    if (create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(paths.root, { mode: 0o700 })
      return assertSafeRuntimeRoot(paths)
    }
    throw error
  }
}

export function isUserForkId(id: string): id is UserForkId {
  return USER_FORK_ID.test(id)
}

async function ensureSafeForkRoot(paths: ContentPackRuntimePaths): Promise<string> {
  await assertSafeRuntimeRoot(paths, true)
  const root = userForkRoot(paths)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Content Pack user-fork store is not a safe directory')
  return root
}

function assertForkDocument(kind: UserForkRecord['kind'], forkId: UserForkId, value: unknown): asserts value is UserForkDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Content Pack user-fork document must be an object')
  const document = value as Record<string, unknown>
  if (document.id !== forkId || document.schemaVersion !== 1 || document.builtin !== false) {
    throw new Error('Content Pack user-fork document identity is invalid')
  }
  if (typeof document.name !== 'string' || !document.name || typeof document.description !== 'string') {
    throw new Error('Content Pack user-fork document is missing required fields')
  }
  if (kind === 'series-formula' && !Array.isArray(document.exampleTopics)) {
    throw new Error('Content Pack Formula user fork is malformed')
  }
  if (kind === 'topic-pack' && (!Array.isArray(document.subjects) || !Array.isArray(document.compatibleNicheIds))) {
    throw new Error('Content Pack Topic user fork is malformed')
  }
}

function parseForkRecord(value: unknown): UserForkRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Content Pack user-fork record must be an object')
  const record = value as Record<string, unknown>
  if (record.schema_version !== 1 || typeof record.fork_id !== 'string' || !isUserForkId(record.fork_id)) {
    throw new Error('Content Pack user-fork record identity is invalid')
  }
  if (record.kind !== 'series-formula' && record.kind !== 'topic-pack' && record.kind !== 'thumbnail-recipe') {
    throw new Error('Unsupported Content Pack user-fork kind')
  }
  const source = record.source as Record<string, unknown> | undefined
  if (!source || (source.catalog_source !== 'legacy-builtin' && source.catalog_source !== 'legacy-user-fork'
    && source.catalog_source !== 'content-pack')
    || typeof source.legacy_id !== 'string' || !LEGACY_ID.test(source.legacy_id)) {
    throw new Error('Content Pack user-fork source metadata is invalid')
  }
  if (typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))) {
    throw new Error('Content Pack user-fork timestamp is invalid')
  }
  assertForkDocument(record.kind, record.fork_id, record.document)
  return structuredClone(record as unknown as UserForkRecord)
}

async function readForkFile(filePath: string): Promise<UserForkRecord> {
  const stat = await fs.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Content Pack user-fork record is not a regular file')
  return parseForkRecord(JSON.parse(await fs.readFile(filePath, 'utf8')))
}

export async function readUserFork(id: string, options: UserForkOptions = {}): Promise<UserForkRecord | null> {
  if (!isUserForkId(id)) return null
  const paths = pathsFor(options)
  const root = userForkRoot(paths)
  try {
    await assertSafeRuntimeRoot(paths)
    const rootStat = await fs.lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Content Pack user-fork store is not a safe directory')
    const record = await readForkFile(forkPath(paths, id))
    if (record.fork_id !== id) throw new Error('Content Pack user-fork filename and record identity do not match')
    return record
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function listUserForks(
  kind?: UserForkableContentPackItemKind,
  options: UserForkOptions = {},
): Promise<UserForkRecord[]> {
  const root = userForkRoot(pathsFor(options))
  const paths = pathsFor(options)
  let names: string[]
  try {
    await assertSafeRuntimeRoot(paths)
    const rootStat = await fs.lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Content Pack user-fork store is not a safe directory')
    names = await fs.readdir(root)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const candidates = names.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).sort()
  if (candidates.length > MAX_FORK_RECORDS) throw new Error('Content Pack user-fork store exceeds the supported record limit')
  const records: UserForkRecord[] = []
  for (const name of candidates) {
    const record = await readForkFile(path.join(root, name))
    const expectedId = `user:${name.slice(0, -'.json'.length)}`.toLowerCase()
    if (record.fork_id.toLowerCase() !== expectedId) {
      throw new Error('Content Pack user-fork filename and record identity do not match')
    }
    if (!kind || record.kind === kind) records.push(record)
  }
  return records.sort((left, right) => left.fork_id.localeCompare(right.fork_id))
}

/**
 * A Formula or Topic Pack that ships as a Content Pack, read as a fork source.
 *
 * A channel pinned to one stores the pack's qualified item id, and a bare
 * legacy id reads as its pack through the read-time alias. Both must fork the
 * installed item — reading only `electron/server/niches/*.json` sent a
 * pack-pinned channel to a 404 the moment its own pack was installed
 * (Settings → episode shape / music format).
 *
 * A recipe is deliberately not resolved here: forking one needs its signed
 * preview rasters, which this path has never carried.
 */
async function loadPackItemSource(
  kind: UserForkableContentPackItemKind,
  itemId: string,
  options: UserForkOptions,
): Promise<{ document: UserForkDocument; source: 'content-pack' } | null> {
  if (kind === 'thumbnail-recipe') return null
  const entry = await resolveCatalogItem(itemId, undefined, options)
  if (!entry) return null
  const { contentPackDocumentToNiche, contentPackDocumentToTopicPack } = await import('./legacy-adapters.js')
  if (kind === 'series-formula' && entry.value.kind === 'series-formula') {
    return { document: contentPackDocumentToNiche(entry.value), source: 'content-pack' }
  }
  if (kind === 'topic-pack' && entry.value.kind === 'topic-pack') {
    return { document: contentPackDocumentToTopicPack(entry.value), source: 'content-pack' }
  }
  return null
}

async function loadLegacySource(
  kind: UserForkableContentPackItemKind,
  legacyId: string,
  options: UserForkOptions = {},
): Promise<{ document: UserForkDocument; source: UserForkSource }> {
  if (!LEGACY_ID.test(legacyId)) throw Object.assign(new Error('Invalid legacy content id'), { statusCode: 400, expose: true })
  // A qualified id can only ever be a pack item: there is no built-in file for
  // it to fall back to, so an uninstalled one says so plainly.
  if (isQualifiedContentPackId(legacyId)) {
    const fromPack = await loadPackItemSource(kind, legacyId, options)
    if (fromPack) return fromPack
    throw Object.assign(
      new Error(`Content Pack item is not installed on this Mac: ${legacyId}`),
      { statusCode: 404, expose: true },
    )
  }
  if (kind === 'series-formula') {
    const loader = await import('../services/niche-loader.js')
    // A bare legacy id reads as its pack first; the built-in file is the
    // fallback, exactly as the niche loader resolves it (AGENTS §1, §5).
    const canonical = loader.resolveFormulaAlias(legacyId)
    if (canonical !== legacyId) {
      const fromPack = await loadPackItemSource(kind, canonical, options)
      if (fromPack) return fromPack
      console.warn(
        `[user-forks] '${legacyId}' reads as '${canonical}', which is not installed on this machine; `
        + 'forking the legacy Formula so editing keeps working',
      )
    }
    const result = await loader.loadLegacyNiche(legacyId)
    if (result) return result
  } else if (kind === 'topic-pack') {
    const loader = await import('../services/topic-pack-loader.js')
    // The same read-time alias the Topic Pack loader uses: a bare id reads as
    // its pack first (the merged Wars pack, for example), and the legacy file
    // is the fallback for a Mac where the pack is not installed (AGENTS §1, §5).
    const canonical = loader.resolveTopicPackAlias(legacyId)
    if (canonical !== legacyId) {
      const fromPack = await loadPackItemSource(kind, canonical, options)
      if (fromPack) return fromPack
      console.warn(
        `[user-forks] '${legacyId}' reads as '${canonical}', which is not installed on this machine; `
        + 'forking the legacy Topic Pack so editing keeps working',
      )
    }
    const result = await loader.loadLegacyTopicPack(legacyId)
    if (result) return result
  } else {
    const loader = await import('../services/thumbnail-template-loader.js')
    const result = await loader.loadLegacyThumbnailTemplate(legacyId)
    if (result) return result
  }
  throw Object.assign(new Error(`Legacy ${kind} content not found: ${legacyId}`), { statusCode: 404, expose: true })
}

function removeSignedSelection(project: ProjectMeta, kind: ContentPackItemKind, itemId: string): void {
  const items = { ...(project.content_pack_items ?? {}) }
  if (kind === 'series-formula') {
    for (const [id, ref] of Object.entries(items)) if (ref.kind === kind) delete items[id]
  } else {
    const ref = items[itemId]
    if (ref?.kind === kind) delete items[itemId]
  }
  const retainedPacks = new Set(Object.values(items).map(ref => ref.pack_id))
  const versions = Object.fromEntries(Object.entries(project.content_pack_versions ?? {})
    .filter(([packId]) => retainedPacks.has(packId)))
  if (Object.keys(items).length) project.content_pack_items = items
  else delete project.content_pack_items
  if (Object.keys(versions).length) project.content_pack_versions = versions
  else delete project.content_pack_versions
}

async function selectForkForProject(
  projectSlug: string,
  kind: UserForkableContentPackItemKind,
  legacyId: string,
  forkId: UserForkId,
): Promise<void> {
  if (kind === 'thumbnail-recipe') {
    const config = await projectManager.getConfig(projectSlug)
    if (!config) throw Object.assign(new Error(`Project not found: ${projectSlug}`), { statusCode: 404, expose: true })
    if (config.thumbnail_template_id !== legacyId) {
      throw Object.assign(new Error(`Project does not select thumbnail recipe: ${legacyId}`), { statusCode: 409, expose: true })
    }
    const request: UpdateConfigRequest = { thumbnail_template_id: forkId }
    const updated = await projectManager.updateConfigAndProjectMetaConsistently(projectSlug, request, project => {
      removeSignedSelection(project, kind, legacyId)
      project.thumbnail_template_id = forkId
    })
    if (!updated) throw Object.assign(new Error(`Project not found: ${projectSlug}`), { statusCode: 404, expose: true })
    return
  }
  const updated = await projectManager.mutateProjectMetaConsistently(projectSlug, project => {
    if (kind === 'series-formula') {
      if (project.niche_id !== legacyId) {
        throw Object.assign(new Error(`Project does not select Series Formula: ${legacyId}`), { statusCode: 409, expose: true })
      }
      project.niche_id = forkId
    } else {
      const selected = project.topic_pack_ids ?? []
      if (!selected.includes(legacyId)) {
        throw Object.assign(new Error(`Project does not select Topic Pack: ${legacyId}`), { statusCode: 409, expose: true })
      }
      project.topic_pack_ids = selected.map(id => id === legacyId ? forkId : id)
    }
    removeSignedSelection(project, kind, legacyId)
  })
  if (!updated) throw Object.assign(new Error(`Project not found: ${projectSlug}`), { statusCode: 404, expose: true })
}

async function assertProjectSelectsLegacySource(
  projectSlug: string,
  kind: UserForkableContentPackItemKind,
  legacyId: string,
): Promise<void> {
  const project = await projectManager.readProjectMetaConsistently(projectSlug)
  if (!project) throw Object.assign(new Error(`Project not found: ${projectSlug}`), { statusCode: 404, expose: true })
  if (kind === 'series-formula' && project.niche_id !== legacyId) {
    throw Object.assign(new Error(`Project does not select Series Formula: ${legacyId}`), { statusCode: 409, expose: true })
  }
  if (kind === 'topic-pack' && !project.topic_pack_ids?.includes(legacyId)) {
    throw Object.assign(new Error(`Project does not select Topic Pack: ${legacyId}`), { statusCode: 409, expose: true })
  }
  if (kind === 'thumbnail-recipe') {
    const config = await projectManager.getConfig(projectSlug)
    if (config?.thumbnail_template_id !== legacyId) {
      throw Object.assign(new Error(`Project does not select thumbnail recipe: ${legacyId}`), { statusCode: 409, expose: true })
    }
  }
}

export async function forkLegacyContentForEdit(input: {
  kind: ContentPackItemKind
  legacyId: string
  projectSlug?: string
}, options: UserForkOptions = {}): Promise<{ fork_id: UserForkId; source: UserForkSource }> {
  if (input.kind === 'visual-style' || input.kind === 'subtitle-style'
    || input.kind === 'scene-effect' || input.kind === 'overlay'
    || input.kind === 'reveal') {
    throw Object.assign(
      new Error(`Legacy ${input.kind} user overrides are not supported`),
      { statusCode: 400, expose: true },
    )
  }
  const kind: UserForkableContentPackItemKind = input.kind
  const paths = pathsFor(options)
  return withContentPackCoordinationLock(paths, async () => {
    if (input.projectSlug) await assertProjectSelectsLegacySource(input.projectSlug, kind, input.legacyId)
    const legacy = await loadLegacySource(kind, input.legacyId, options)
    const forkId = `user:${randomUUID()}` as UserForkId
    const document = structuredClone(legacy.document) as UserForkDocument
    document.id = forkId
    document.builtin = false
    const record: UserForkRecord = {
      schema_version: 1,
      fork_id: forkId,
      kind,
      source: { catalog_source: legacy.source, legacy_id: input.legacyId },
      created_at: new Date().toISOString(),
      document,
    }
    assertForkDocument(record.kind, forkId, document)
    await ensureSafeForkRoot(paths)
    const filePath = forkPath(paths, forkId)
    await withLock(filePath, async () => {
      const handle = await fs.open(filePath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    if (input.projectSlug) {
      try {
        await selectForkForProject(input.projectSlug, kind, input.legacyId, forkId)
      } catch (error) {
        await fs.unlink(filePath).catch(() => {})
        throw error
      }
    }
    return { fork_id: forkId, source: legacy.source }
  })
}

export async function saveUserForkDocument(id: string, document: UserForkDocument, options: UserForkOptions = {}): Promise<UserForkRecord> {
  if (!isUserForkId(id)) throw Object.assign(new Error('Invalid user Content Pack fork id'), { statusCode: 400, expose: true })
  const paths = pathsFor(options)
  return withContentPackCoordinationLock(paths, async () => {
    await ensureSafeForkRoot(paths)
    const filePath = forkPath(paths, id)
    return withLock(filePath, async () => {
      const existing = await readForkFile(filePath)
      if (existing.fork_id !== id) throw new Error('Content Pack user-fork filename and record identity do not match')
      const updatedDocument = structuredClone(document)
      updatedDocument.id = id
      updatedDocument.builtin = false
      assertForkDocument(existing.kind, id, updatedDocument)
      const updated = { ...existing, document: updatedDocument }
      await writeJsonAtomic(filePath, updated, { mode: 0o600 })
      return structuredClone(updated)
    })
  })
}

async function legacyFilesForKind(kind: UserForkableContentPackItemKind): Promise<string[]> {
  let directory: string
  if (kind === 'series-formula') directory = (await import('../services/niche-loader.js'))._userNichesDir()
  else if (kind === 'topic-pack') directory = path.dirname((await import('../services/topic-pack-loader.js')).topicPackFilePath('probe'))
  else directory = (await import('../services/thumbnail-template-loader.js'))._userTemplatesDir()
  try {
    return (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Whether anything an id resolves to exists to be shadowed: an installed pack
 * item (the id itself, or the item a bare legacy Formula id reads as), or —
 * the fallback — the legacy built-in file.
 */
async function hasLegacyBuiltin(
  kind: UserForkableContentPackItemKind,
  id: string,
  options: UserForkOptions = {},
): Promise<boolean> {
  if (isQualifiedContentPackId(id) || kind === 'series-formula' || kind === 'topic-pack') {
    let itemId = id
    if (!isQualifiedContentPackId(id)) {
      // A bare id reads as its pack item, exactly as the loader resolves it.
      itemId = kind === 'topic-pack'
        ? (await import('../services/topic-pack-loader.js')).resolveTopicPackAlias(id)
        : (await import('../services/niche-loader.js')).resolveFormulaAlias(id)
    }
    if (await loadPackItemSource(kind, itemId, options)) return true
    // A qualified id has no legacy file; only a bare one can still answer.
    if (isQualifiedContentPackId(id)) return false
  }
  let filePath: string
  if (kind === 'series-formula') {
    filePath = path.join((await import('../services/niche-loader.js')).BUILTIN_NICHES_DIR, `${id}.json`)
  } else if (kind === 'topic-pack') {
    filePath = path.join((await import('../services/topic-pack-loader.js')).BUILTIN_TOPIC_PACKS_DIR, `${id}.json`)
  } else {
    filePath = path.join((await import('../services/thumbnail-template-loader.js')).BUILTIN_TEMPLATES_DIR, `${id}.json`)
  }
  try {
    const stat = await fs.lstat(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function referencingProjects(kind: UserForkableContentPackItemKind, id: string): Promise<string[]> {
  const matches: string[] = []
  for (const summary of await projectManager.listProjects()) {
    const project = await projectManager.getProject(summary.slug).catch(() => null)
    if (!project) continue
    if (kind === 'series-formula' && project.niche_id === id) matches.push(project.slug)
    if (kind === 'topic-pack' && project.topic_pack_ids?.includes(id)) matches.push(project.slug)
    if (kind === 'thumbnail-recipe') {
      const config = await projectManager.getConfig(project.slug).catch(() => null)
      if (project.thumbnail_template_id === id || config?.thumbnail_template_id === id) matches.push(project.slug)
    }
  }
  return [...new Set(matches)].sort()
}

export async function listLegacyShadowConflicts(options: UserForkOptions = {}): Promise<LegacyShadowConflict[]> {
  const conflicts: LegacyShadowConflict[] = []
  for (const kind of ['series-formula', 'thumbnail-recipe', 'topic-pack'] as const) {
    for (const fileName of await legacyFilesForKind(kind)) {
      const legacyId = fileName.slice(0, -'.json'.length)
      if (!LEGACY_ID.test(legacyId)) continue
      let signedItemId: string | undefined
      if (legacyId.includes('.')) {
        const { resolveCatalogItem } = await import('./registry.js')
        const signed = await resolveCatalogItem(legacyId, undefined, options)
        if (signed?.value.kind === kind) signedItemId = legacyId
      }
      if (!signedItemId && !await hasLegacyBuiltin(kind, legacyId, options)) continue
      conflicts.push({
        kind,
        legacy_id: legacyId,
        ...(signedItemId ? { signed_item_id: signedItemId } : {}),
        referencing_project_slugs: await referencingProjects(kind, legacyId),
      })
    }
  }
  return conflicts.sort((left, right) => left.kind.localeCompare(right.kind) || left.legacy_id.localeCompare(right.legacy_id))
}
