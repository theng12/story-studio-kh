/**
 * Topic Pack loader.
 *
 * Topic Packs are reusable subject inventories layered under a Series Formula
 * (the legacy Niche object). Built-ins ship with the app; user packs live in
 * `${PROJECTS_ROOT}/.topic-packs` and shadow built-ins by id.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import * as pm from './project-manager.js'
import type { TopicPack } from '../models/types.js'
import {
  isQualifiedContentPackId,
  listCatalogEntries,
  listUserForkCatalogEntries,
  resolveCatalogItem,
  resolveUserForkCatalogItem,
  type CatalogEntry,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { registryOptionsForCurrentJob } from '../content-packs/project-pins.js'
import { contentPackDocumentToTopicPack } from '../content-packs/legacy-adapters.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function isPackagedApp(): boolean {
  if (__dirname.includes('.asar')) return true
  if (process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE) {
    try {
      const { app } = require('electron')
      return app?.isPackaged === true
    } catch {
      return false
    }
  }
  return false
}

function findRepoDir(start: string, maxDepth = 8): string | null {
  let current = start
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(current, 'electron', 'server', 'topic-packs')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function resolveBuiltinDir(): string {
  if (isPackagedApp() && process.resourcesPath) {
    return path.join(process.resourcesPath, 'topic-packs')
  }
  return findRepoDir(__dirname) || path.resolve(__dirname, '..', 'topic-packs')
}

export const BUILTIN_TOPIC_PACKS_DIR = resolveBuiltinDir()

function userDir(): string {
  return path.join(pm.projectsRoot(), '.topic-packs')
}

const builtinCache = new Map<string, TopicPack>()
const userCache = new Map<string, { mtimeMs: number; pack: TopicPack }>()

function validate(pack: any, filePath: string): asserts pack is TopicPack {
  const missing: string[] = []
  if (typeof pack?.id !== 'string' || !pack.id) missing.push('id')
  if (typeof pack?.name !== 'string' || !pack.name) missing.push('name')
  if (typeof pack?.description !== 'string') missing.push('description')
  if (pack?.schemaVersion !== 1) missing.push('schemaVersion (must be 1)')
  if (!Array.isArray(pack?.compatibleNicheIds)) missing.push('compatibleNicheIds (array)')
  if (!Array.isArray(pack?.subjects) || !pack.subjects.length) missing.push('subjects (non-empty array)')
  if (missing.length) {
    throw new Error(`Topic Pack at ${filePath} is missing required fields: ${missing.join(', ')}`)
  }
}

async function readPack(filePath: string): Promise<TopicPack> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch (error: any) {
    throw new Error(`Topic Pack JSON parse failed at ${filePath}: ${error.message}`)
  }
  validate(parsed, filePath)
  return parsed
}

export async function loadTopicPack(id: string, registryOptions: ContentPackRegistryOptions = {}): Promise<TopicPack | null> {
  if (!id) return null
  const userFork = await resolveUserForkCatalogItem(id, 'topic-pack', registryOptions)
  if (userFork) return userFork.value as TopicPack
  if (isQualifiedContentPackId(id)) {
    const effectiveOptions = await registryOptionsForCurrentJob(['topic-pack'], registryOptions)
    const signed = await resolveCatalogItem(id, undefined, effectiveOptions)
    if (signed?.value.kind === 'topic-pack') return contentPackDocumentToTopicPack(signed.value)
  }
  return loadLegacyTopicPack(id).then(result => result?.document ?? null)
}

/** Explicit compatibility resolver used by non-destructive fork-on-edit. */
export async function loadLegacyTopicPack(id: string): Promise<{ document: TopicPack; source: 'legacy-builtin' | 'legacy-user-fork' } | null> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) return null
  const customPath = topicPackFilePath(id)
  if (existsSync(customPath)) {
    const stat = await fs.stat(customPath)
    const cached = userCache.get(customPath)
    if (cached?.mtimeMs === stat.mtimeMs) return { document: cached.pack, source: 'legacy-user-fork' }
    const pack = await readPack(customPath)
    userCache.set(customPath, { mtimeMs: stat.mtimeMs, pack })
    return { document: pack, source: 'legacy-user-fork' }
  }
  if (builtinCache.has(id)) return { document: builtinCache.get(id)!, source: 'legacy-builtin' }
  const builtinPath = path.join(BUILTIN_TOPIC_PACKS_DIR, `${id}.json`)
  if (!existsSync(builtinPath)) return null
  const pack = await readPack(builtinPath)
  builtinCache.set(id, pack)
  return { document: pack, source: 'legacy-builtin' }
}

export async function listTopicPackCatalogEntries(registryOptions: ContentPackRegistryOptions = {}): Promise<Array<CatalogEntry<TopicPack>>> {
  const found = new Map<string, CatalogEntry<TopicPack>>()
  for (const entry of await listCatalogEntries('topic-pack', registryOptions)) {
    if (entry.value.kind === 'topic-pack') {
      found.set(entry.value.id, { ...entry, value: contentPackDocumentToTopicPack(entry.value) })
    }
  }
  for (const entry of await listUserForkCatalogEntries('topic-pack', registryOptions)) {
    const pack = entry.value as TopicPack
    if (!found.has(pack.id)) found.set(pack.id, { ...entry, value: pack })
  }
  if (existsSync(userDir())) {
    for (const name of await fs.readdir(userDir()).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        const pack = await readPack(path.join(userDir(), name))
        if (!found.has(pack.id)) found.set(pack.id, { value: pack, source: 'legacy-user-fork' })
      } catch (error: any) {
        console.warn(`[topic-pack-loader] skipping malformed user pack ${name}: ${error.message}`)
      }
    }
  }
  if (existsSync(BUILTIN_TOPIC_PACKS_DIR)) {
    for (const name of await fs.readdir(BUILTIN_TOPIC_PACKS_DIR).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        const pack = await readPack(path.join(BUILTIN_TOPIC_PACKS_DIR, name))
        if (!found.has(pack.id)) found.set(pack.id, { value: pack, source: 'legacy-builtin' })
      } catch (error: any) {
        console.warn(`[topic-pack-loader] skipping malformed built-in pack ${name}: ${error.message}`)
      }
    }
  }
  return [...found.values()].sort((a, b) => a.value.name.localeCompare(b.value.name))
}

export async function listTopicPacks(registryOptions: ContentPackRegistryOptions = {}): Promise<TopicPack[]> {
  return (await listTopicPackCatalogEntries(registryOptions)).map(entry => entry.value)
}

/**
 * A user Topic Pack id must be a safe filename segment. See `nicheFilePath` for
 * the incident: the loader's pattern was applied only on the miss branch, so an
 * id naming an existing file reached `path.join` unchecked and
 * `DELETE /api/topic-packs/..%2F<project>%2Fconfig` unlinked a project's own
 * `config.json`. Starting with an alphanumeric makes `.`/`..` impossible as a
 * whole segment, and `/` is excluded.
 */
function assertSafeTopicPackId(id: unknown): string {
  const value = String(id ?? '')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid topic pack id '${value}'`)
  }
  return value
}

export function topicPackFilePath(id: string): string {
  return path.join(userDir(), `${assertSafeTopicPackId(id)}.json`)
}

export async function ensureTopicPacksDir(): Promise<void> {
  // ensureProjectsRoot() so the test-isolation guard fires before a recursive
  // mkdir can create `.topic-packs` in the real projects folder.
  await fs.mkdir(path.join(pm.ensureProjectsRoot(), '.topic-packs'), { recursive: true })
}

export function invalidateTopicPackCache(id?: string): void {
  if (!id) {
    builtinCache.clear()
    userCache.clear()
    return
  }
  builtinCache.delete(id)
  userCache.delete(topicPackFilePath(id))
}

export function isCompatible(pack: TopicPack, nicheId: string): boolean {
  const compatibleIds = [...(pack.compatibleNicheIds || []), ...(pack.compatibleFormulaIds || [])]
  return compatibleIds.length === 0 || compatibleIds.includes(nicheId)
}
