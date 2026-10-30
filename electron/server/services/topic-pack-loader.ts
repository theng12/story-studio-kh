/**
 * Topic Pack loader.
 *
 * Topic Packs are reusable subject inventories layered under a Series Formula
 * (the legacy Niche object). The LIST is the installed Content Packs' items;
 * the legacy sources — shipped JSON under `electron/server/topic-packs` and
 * `${PROJECTS_ROOT}/.topic-packs` user files — are no longer listed but stay
 * readable, and are what a stored legacy id falls back to when its pack is not
 * installed (owner ruling, 2026-10-29).
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

// ── Read-time legacy-id aliases ────────────────────────────────────────────

/**
 * Owner ruling, 2026-10-29 — "no custom, no built in, all from packs": a Topic
 * Pack picker lists what the installed Content Packs publish, and nothing else.
 * A channel, preset or plan that stores one of the bare legacy ids keeps its
 * bytes; every READ of that id resolves to the pack item that now owns the
 * content (AGENTS §5 — aliases, never a migration). The legacy
 * `electron/server/topic-packs/*.json` sources stay in place and still answer
 * when the pack is not installed on this Mac.
 *
 * The table is the `topic:<legacy-id>` rows of
 * `content-packs/legacy-migration-dispositions.json`, made executable for the
 * read path; a test derives it from that file and fails if the two drift.
 *
 * THREE EXCEPTIONS, each deliberate:
 *  - `historical-wars-treaties-world-order` points at the merged
 *    `…-v2` item (owner, 2026-10-29: "use the one with the most context"), not
 *    at the archival-ledger 1.0.1 disposition;
 *  - the two superseded item ids below point at the same merged item, so a
 *    stored selection written before the merge reads the fullest pack.
 *
 * Of the two ways to make a superseded id resolve (a v2-declared alias field, or
 * a replaced pack that stays resolvable while hidden), the second is the smaller
 * — no archive-schema change — and `RESOLVABLE_LIFECYCLES` in the registry
 * implements it, so the two packs themselves still answer when the merged one is
 * not installed. This table is what adds the merged pack's content on top.
 */
export const LEGACY_TOPIC_PACK_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'ancient-humans-environments': 'com.storystudio.topic.ancient-humans-environments',
  'ancient-humans-social-life': 'com.storystudio.topic.ancient-humans-social-life',
  'ancient-humans-survival': 'com.storystudio.topic.ancient-humans-survival',
  'ancient-humans-technology': 'com.storystudio.topic.ancient-humans-technology',
  'deep-time-deep-ocean': 'com.storystudio.topic.deep-time-field-record.ancient-oceans-deep-sea',
  'deep-time-earth-systems': 'com.storystudio.topic.deep-time-earth-systems',
  'deep-time-human-origins': 'com.storystudio.topic.deep-time-field-record.human-origins-ancient-worlds',
  'deep-time-prehistoric-life': 'com.storystudio.topic.deep-time-field-record.prehistoric-life-extinction',
  'deep-time-speculative-earth': 'com.storystudio.topic.deep-time-speculative-earth',
  'economics-ancient-civilizations': 'com.storystudio.topic.economics-ancient-civilizations',
  'economics-businesses': 'com.storystudio.topic.economics-businesses',
  'historical-empires-trade-extraction': 'com.storystudio.topic.archival-ledger.empires-trade-extraction',
  'historical-infrastructure-commodities-corporate-power': 'com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power',
  'historical-money-debt-financial-institutions': 'com.storystudio.topic.archival-ledger.money-debt-financial-institutions',
  'historical-states-revolutions-collapse': 'com.storystudio.topic.archival-ledger.states-revolutions-collapse',
  // The merged successor carries the free 1.0.2 and archival-ledger content.
  'historical-wars-treaties-world-order': 'com.storystudio.topic.wars-treaties-world-order-v2',
  'com.storystudio.topic.historical-wars-treaties-world-order': 'com.storystudio.topic.wars-treaties-world-order-v2',
  'com.storystudio.topic.archival-ledger.wars-treaties-world-order': 'com.storystudio.topic.wars-treaties-world-order-v2',
  'human-behavior-social-dynamics': 'com.storystudio.topic.human-behavior-social-dynamics',
  'natural-world-animals': 'com.storystudio.topic.natural-world-animals',
  'natural-world-fungi': 'com.storystudio.topic.natural-world-fungi',
  'natural-world-insects': 'com.storystudio.topic.natural-world-insects',
  'natural-world-plants': 'com.storystudio.topic.natural-world-plants',
  'pastoral-daily-reflection': 'com.storystudio.topic.pastoral-daily-reflection',
  'pastoral-expository-teaching': 'com.storystudio.topic.pastoral-expository-teaching',
  'pov-criminal-hierarchies': 'com.storystudio.topic.pov-criminal-hierarchies',
  'pov-historical-occupations': 'com.storystudio.topic.pov-historical-occupations',
  'pov-law-enforcement': 'com.storystudio.topic.pov-law-enforcement',
})

/** The pack item id a stored Topic Pack id reads as. Unknown ids pass through. */
export function resolveTopicPackAlias(id: string): string {
  return LEGACY_TOPIC_PACK_ALIASES[id] ?? id
}

/**
 * THE COMPATIBILITY FALLBACK RULE.
 *
 * An alias target that is installed but does not support this Formula must not
 * hide the pack the selection came from. Example: the merged Wars pack 1.0.1
 * named only two Formula ids that were never published, so a channel still on
 * the first-generation `history-explained` Formula would load 1.0.1, fail the
 * compatibility test, and silently lose its Wars content.
 *
 * So when the merged item cannot serve this Formula, the pre-alias sources that
 * read as the same item are tried in turn — the stored id itself and every id
 * the alias table sends to the same target — and the first one that supports
 * this Formula is used. The merged item always wins when it is compatible; this
 * only runs after it has been refused. A pack that was never the selection's
 * source is never tried.
 */
export async function loadSupersededTopicPack(
  id: string,
  formulaId: string,
  registryOptions: ContentPackRegistryOptions = {},
): Promise<TopicPack | null> {
  const targetId = resolveTopicPackAlias(id)
  const candidates = [id, ...Object.keys(LEGACY_TOPIC_PACK_ALIASES).filter(key => LEGACY_TOPIC_PACK_ALIASES[key] === targetId)]
  const tried = new Set<string>()
  for (const candidate of candidates) {
    if (candidate === targetId || tried.has(candidate)) continue
    tried.add(candidate)
    let pack: TopicPack | null = null
    try {
      pack = await loadResolvedTopicPack(candidate, registryOptions)
    } catch (e: any) {
      console.warn(`[topic-pack-loader] superseded source '${candidate}' could not be read: ${e.message}`)
      continue
    }
    if (pack && isCompatible(pack, formulaId)) return pack
  }
  return null
}

/**
 * Load a Topic Pack by id. An aliased id reads as its pack item first; a bare
 * legacy id whose pack is not installed still resolves THROUGH the alias target
 * (a newer or superseding pack) and then to its own legacy source, so a stored
 * selection never stops resolving (AGENTS §1, §5).
 */
export async function loadTopicPack(id: string, registryOptions: ContentPackRegistryOptions = {}): Promise<TopicPack | null> {
  if (!id) return null
  const alias = LEGACY_TOPIC_PACK_ALIASES[id]
  if (alias) return loadAliasedTopicPack(id, alias, registryOptions)
  return loadResolvedTopicPack(id, registryOptions)
}

async function loadAliasedTopicPack(
  legacyId: string,
  targetId: string,
  registryOptions: ContentPackRegistryOptions,
): Promise<TopicPack | null> {
  try {
    const target = await loadResolvedTopicPack(targetId, registryOptions)
    if (target) return target
  } catch (e: any) {
    console.warn(`[topic-pack-loader] alias '${legacyId}' → '${targetId}' could not be resolved: ${e.message}`)
  }
  console.warn(
    `[topic-pack-loader] '${legacyId}' reads as '${targetId}', which is not available on this machine; `
    + 'falling back to the legacy Topic Pack so generation keeps working',
  )
  return loadResolvedTopicPack(legacyId, registryOptions)
}

/** Today's resolution order: a local fork, then the qualified pack item, then the legacy file. */
async function loadResolvedTopicPack(id: string, registryOptions: ContentPackRegistryOptions = {}): Promise<TopicPack | null> {
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

/**
 * Every Topic Pack the installed Content Packs publish, sorted by name.
 *
 * Owner ruling, 2026-10-29 — "no custom, no built in, all from packs": this is
 * the picker's list, so it carries installed pack items only. The shipped
 * `electron/server/topic-packs/*.json` files, `.topic-packs` user files and user
 * forks are no longer listed — and nothing is deleted or rewritten. A stored id
 * keeps resolving through `loadTopicPack` (alias → pack item, otherwise the old
 * source as a read-only fallback), and a selection no installed pack publishes
 * is shown as "<name> (not in a pack)" in its own picker.
 *
 * Malformed sources are skipped with a warning rather than failing the list.
 *
 * ONE ROW PER TOPIC, not one per stored id: an entry whose id is an alias key
 * is hidden while the item it reads as is ALSO listed, so the merged Wars pack
 * is not offered three times beside the two packs it supersedes. A scope
 * narrows that: when the list is read for a Formula (`?niche_id=`), the old row
 * stays visible unless that Formula can actually use the merged item — a v1
 * channel on a Mac where the merged pack is still 1.0.1 keeps seeing the pack
 * that serves it. Data-driven from the alias table; no pack is named here.
 */
export async function listTopicPackCatalogEntries(
  registryOptions: ContentPackRegistryOptions = {},
  scopeFormulaId?: string,
): Promise<Array<CatalogEntry<TopicPack>>> {
  const found = new Map<string, CatalogEntry<TopicPack>>()
  for (const entry of await listCatalogEntries('topic-pack', registryOptions)) {
    if (entry.value.kind === 'topic-pack' && !found.has(entry.value.id)) {
      found.set(entry.value.id, { ...entry, value: contentPackDocumentToTopicPack(entry.value) })
    }
  }
  const entries = [...found.values()]
  const listed = new Map(entries.map(entry => [entry.value.id, entry]))
  return entries
    .filter((entry) => {
      const targetId = LEGACY_TOPIC_PACK_ALIASES[entry.value.id]
      if (!targetId || targetId === entry.value.id) return true
      const target = listed.get(targetId)
      // The item this id reads as is not on this Mac, so this row is what serves
      // the stored selection.
      if (!target) return true
      return !!scopeFormulaId && !isCompatible(target.value, scopeFormulaId)
    })
    .sort((a, b) => a.value.name.localeCompare(b.value.name))
}

export async function listTopicPacks(registryOptions: ContentPackRegistryOptions = {}): Promise<TopicPack[]> {
  return (await listTopicPackCatalogEntries(registryOptions)).map(entry => entry.value)
}

/**
 * A user Topic Pack id must be a safe filename segment. See `nicheFilePath` for
 * the incident and for why the rule is the security property rather than the
 * loader's own regex: legacy user forks are named `user:<uuid>`, which that
 * regex rejects, and it had never actually been applied to them.
 */
function assertSafeTopicPackId(id: unknown): string {
  const value = String(id ?? '')
  if (
    !value || value.length > 200 || value !== value.trim()
    || /[/\\\u0000]/.test(value)
    || value.startsWith('.')
  ) {
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
