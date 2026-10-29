/**
 * Taking a Content Pack off this Mac — and putting it back.
 *
 * Owner, 2026-10-29: a Library pack is something to install, not something to
 * own, so removing one must be as ordinary as installing it. Nothing is ever
 * hard-deleted: the bytes move into Story's Trash (`moveContentPackToTrash`),
 * a record here says where they came from, and Restore moves them back.
 *
 * Two facts decide a removal and both are read before a single file moves:
 * does a channel use this pack, and does another installed pack depend on it.
 * Either answer refuses the removal and names what answered.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { writeJsonAtomic } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { logLine } from '../services/logger.js'
import {
  completeInterruptedContentPackRemoval,
  ContentPackInUseError,
  removeContentPackVersions,
  type ContentPackLifecycleOptions,
  type ContentPackRemovedVersion,
} from './lifecycle.js'
import { moveContentPackToTrash } from './installer.js'
import { listVerifiedRecoveryPacks } from './recovery.js'
import { ContentPackInstalledVersionSchema, type ContentPackRuntimeState } from './runtime-types.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import { candidateProjectSlugs, listProjectSlugsPinningContentPackVersionLocked } from './project-pins.js'
import { aliasedVisualStyleId } from './style-aliases.js'
import { resolveFormulaAlias } from '../services/niche-loader.js'
import * as projectManager from '../services/project-manager.js'
import { readContentPackState, withContentPackCoordinationLock, withContentPackStateTransaction } from './state.js'
import type { GenStudioRetiredPackRemoval } from '../lib/genstudio-content-store.js'

const LEDGER_MODE = 0o600
const LEDGER_FILE = 'removals.json'

export const CONTENT_PACK_REMOVAL_OUTCOMES = ['removed', 'kept_in_use', 'failed'] as const
export type ContentPackRemovalOutcome = typeof CONTENT_PACK_REMOVAL_OUTCOMES[number]

const RemovedVersionSchema = z.object({
  version: z.string().min(1).max(64),
  install_path: z.string().min(1).max(4096),
  trash_path: z.string().min(1).max(4096).nullable(),
  active: z.boolean(),
  record: ContentPackInstalledVersionSchema,
}).strict()

const RemovalEntrySchema = z.object({
  pack_id: z.string().min(1).max(256),
  removed_at: z.string().datetime(),
  outcome: z.enum(CONTENT_PACK_REMOVAL_OUTCOMES),
  /** Channels that used it, when that is why it was kept. */
  channels: z.array(z.string().min(1).max(200)).max(200),
  detail: z.string().max(2048).nullable(),
  /** The Gateway `remove_from_installs_at` this answered, when the Gateway asked. */
  gateway_remove_at: z.string().datetime().nullable(),
  versions: z.array(RemovedVersionSchema).max(200),
  restored_at: z.string().datetime().nullable(),
  /** When this Mac last told the Gateway what happened. */
  reported_at: z.string().datetime().nullable(),
}).strict()

export const ContentPackRemovalLedgerSchema = z.object({
  schema_version: z.literal(1),
  packs: z.record(z.string(), RemovalEntrySchema),
}).strict()

export type ContentPackRemovalEntry = z.infer<typeof RemovalEntrySchema>
export interface ContentPackRemovalLedger {
  schema_version: 1
  packs: Record<string, ContentPackRemovalEntry>
}

export interface ContentPackRemovalStore {
  ledger: ContentPackRemovalLedger
  /**
   * True when the file exists but cannot be read. It is NOT "nothing was ever
   * removed": the page says so rather than showing an empty list.
   */
  unreadable: boolean
}

export class ContentPackRemovalError extends Error {
  constructor(readonly code: string, message: string, readonly channels: string[] = []) {
    super(message)
    this.name = 'ContentPackRemovalError'
  }
}

function ledgerPath(paths: ContentPackRuntimePaths): string {
  return path.join(paths.root, LEDGER_FILE)
}

export async function readContentPackRemovalStore(
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<ContentPackRemovalStore> {
  let raw: string
  try {
    raw = await fs.readFile(ledgerPath(paths), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ledger: { schema_version: 1, packs: {} }, unreadable: false }
    logLine('error', 'Content Pack removal records could not be read', { code: (error as NodeJS.ErrnoException).code })
    return { ledger: { schema_version: 1, packs: {} }, unreadable: true }
  }
  try {
    return { ledger: ContentPackRemovalLedgerSchema.parse(JSON.parse(raw)), unreadable: false }
  } catch {
    // The file is kept exactly as it is: it is this Mac's only record of where
    // the bytes went, and a rewrite would destroy that.
    logLine('error', 'Content Pack removal records are not readable and were left untouched')
    return { ledger: { schema_version: 1, packs: {} }, unreadable: true }
  }
}

async function writeRemovalLedger(ledger: ContentPackRemovalLedger, paths: ContentPackRuntimePaths): Promise<void> {
  const validated = ContentPackRemovalLedgerSchema.parse(ledger)
  assertWriteIsolatedInTests(ledgerPath(paths), 'content-pack-removals')
  await fs.mkdir(paths.root, { recursive: true })
  await writeJsonAtomic(ledgerPath(paths), validated, { mode: LEDGER_MODE })
}

async function recordRemoval(entry: ContentPackRemovalEntry, paths: ContentPackRuntimePaths): Promise<void> {
  await withContentPackCoordinationLock(paths, async () => {
    const store = await readContentPackRemovalStore(paths)
    const ledger: ContentPackRemovalLedger = { schema_version: 1, packs: { ...store.ledger.packs, [entry.pack_id]: entry } }
    await writeRemovalLedger(ledger, paths)
  })
}

/** A string that could name a pack item: ids, never prompt prose. */
const REFERENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MAX_REFERENCE_IDS = 4000
const MAX_REFERENCE_DEPTH = 6
const UNCHECKED_PREFIX = 'could not check '

interface ChannelReference {
  slug: string
  /** Every id this channel names anywhere a pack could serve it. */
  ids: Set<string>
  /** Part of this channel could not be read: that is NOT the same as "unused". */
  unreadable: boolean
}

function collectReferenceIds(value: unknown, ids: Set<string>, depth = 0): void {
  if (ids.size >= MAX_REFERENCE_IDS || depth > MAX_REFERENCE_DEPTH) return
  if (typeof value === 'string') {
    const id = value.trim()
    if (id.length <= 200 && REFERENCE_SHAPE.test(id)) ids.add(id)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectReferenceIds(entry, ids, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectReferenceIds(child, ids, depth + 1)
  }
}

/**
 * The channel's config, parsed as written.
 *
 * Deliberately not `getConfig()`: that merges model catalogues and reads the
 * project's saved secrets, which a safety check has no business doing for every
 * channel on every read. Its migrations leave these ids untouched, so the ids
 * this check compares are the ones the app will act on.
 */
async function readChannelConfig(slug: string): Promise<Record<string, unknown> | null> {
  const dir = projectManager.getProjectDir(slug)
  if (!dir) return null
  let text: string
  try {
    text = await fs.readFile(path.join(dir, 'config.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A channel config is not an object.')
  return parsed as Record<string, unknown>
}

/**
 * Every place a channel names a pack item, read the way the app reads them:
 * the Formula/niche id, the Topic Packs, the active style and its presets,
 * every `*_presets` pool (Scene Plan, thumbnail prompts and generators,
 * Character Sheet, …), and the exact version pins.
 *
 * An id that cannot be read makes the CHANNEL unreadable, not empty: a removal
 * must refuse rather than assume the channel does not use the pack.
 */
async function channelReferences(): Promise<ChannelReference[]> {
  const references: ChannelReference[] = []
  for (const slug of await candidateProjectSlugs()) {
    const ids = new Set<string>()
    let unreadable = false
    let meta: Awaited<ReturnType<typeof projectManager.readProjectMetaConsistently>> = null
    try {
      meta = await projectManager.readProjectMetaConsistently(slug)
    } catch {
      unreadable = true
    }
    if (meta) {
      for (const packId of Object.keys(meta.content_pack_versions ?? {})) ids.add(packId)
      for (const [itemId, item] of Object.entries(meta.content_pack_items ?? {})) {
        ids.add(itemId)
        if (item && typeof item.pack_id === 'string') ids.add(item.pack_id)
      }
      if (typeof meta.active_style_preset_id === 'string') ids.add(meta.active_style_preset_id)
      if (typeof meta.thumbnail_template_id === 'string') ids.add(meta.thumbnail_template_id)
    }
    try {
      const config = await readChannelConfig(slug)
      if (config) {
        for (const field of ['niche_id', 'active_style_preset_id', 'thumbnail_template_id']) {
          const value = config[field]
          if (typeof value === 'string' && value.trim()) ids.add(value.trim())
        }
        collectReferenceIds(config.topic_pack_ids, ids)
        collectReferenceIds(config.style_presets, ids)
        for (const [key, value] of Object.entries(config)) {
          if (key.endsWith('_presets')) collectReferenceIds(value, ids)
        }
      }
    } catch {
      unreadable = true
    }
    // A folder with no project.json is not a channel; one that has meta but an
    // unreadable config is a channel this check could not finish.
    if (!meta && !unreadable && ids.size === 0) continue
    references.push({ slug, ids, unreadable })
  }
  return references
}

/** The ids a reference may name to reach this pack, aliases resolved both ways. */
function resolvesToPack(reference: string, packIds: ReadonlySet<string>): boolean {
  if (packIds.has(reference)) return true
  const style = aliasedVisualStyleId(reference)
  if (style && packIds.has(style)) return true
  const formula = resolveFormulaAlias(reference)
  return formula !== reference && packIds.has(formula)
}

/** Every name this pack answers to: its id, and every item and bundle it installs. */
function packReferenceIds(state: ContentPackRuntimeState, packId: string): Set<string> {
  const ids = new Set<string>([packId])
  for (const version of Object.values(state.packs[packId]?.versions ?? {})) {
    const manifest = version.manifest
    ids.add(manifest.pack_id)
    for (const item of manifest.items ?? []) ids.add(item.id)
    for (const bundle of manifest.bundles ?? []) {
      const id = (bundle as { id?: unknown }).id
      if (typeof id === 'string') ids.add(id)
    }
  }
  return ids
}

function channelLabels(references: readonly ChannelReference[], packIds: ReadonlySet<string>): string[] {
  const labels: string[] = []
  for (const reference of references) {
    if ([...reference.ids].some(id => resolvesToPack(id, packIds))) labels.push(reference.slug)
    else if (reference.unreadable) labels.push(`${UNCHECKED_PREFIX}${reference.slug}`)
  }
  return [...new Set(labels)].sort()
}

/**
 * Which channels use each installed pack — by exact version pin AND by every
 * selection a channel actually makes. The removal refuses on this same answer,
 * so what the page shows and what it enforces cannot disagree.
 */
export async function contentPackUsage(
  packIds: readonly string[],
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<Record<string, string[]>> {
  const usage: Record<string, string[]> = {}
  for (const packId of packIds) usage[packId] = []
  if (packIds.length === 0) return usage
  const state = await readContentPackState(paths)
  const references = await channelReferences()
  for (const packId of packIds) usage[packId] = channelLabels(references, packReferenceIds(state, packId))
  return usage
}

/**
 * A pack that ships inside Story Studio cannot be removed. The app's own
 * bundled archives are the only built-in source, so that is the question
 * asked — never a hardcoded id list.
 */
export async function isBuiltInContentPack(
  packId: string,
  options: ContentPackLifecycleOptions = {},
  paths: ContentPackRuntimePaths = options.paths ?? getContentPackRuntimePaths(),
): Promise<boolean> {
  try {
    const packs = await listVerifiedRecoveryPacks({ paths, policy: options.policy, appVersion: options.appVersion })
    return packs.some(pack => pack.manifest.pack_id === packId)
  } catch (error) {
    logLine('warn', 'Built-in Content Pack lookup failed', { pack_id: packId, reason: String((error as Error)?.message ?? error) })
    return false
  }
}

export interface ContentPackRemovalResult {
  pack_id: string
  removed: ContentPackRemovedVersion[]
}

/** Take every installed version of one pack off this Mac. Never deletes. */
export async function removeContentPack(
  packId: string,
  options: ContentPackLifecycleOptions = {},
): Promise<ContentPackRemovalResult> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const state = await readContentPackState(paths)
  if (!state.packs[packId]) {
    if (await isBuiltInContentPack(packId, options, paths)) {
      throw new ContentPackRemovalError('CONTENT_PACK_BUILT_IN', 'This pack ships with Story Studio and cannot be removed.')
    }
    throw new ContentPackRemovalError('CONTENT_PACK_NOT_INSTALLED', 'This pack is not installed on this Mac.')
  }
  const channels = (await contentPackUsage([packId], paths))[packId] ?? []
  try {
    // The live pin reader runs under the removal's own lock as well; the scan
    // above is what catches a Formula, Topic Pack or style selected in config.
    const outcome = await removeContentPackVersions(packId, listProjectSlugsPinningContentPackVersionLocked, {
      ...options,
      isPinned: async (id, version) => [
        ...new Set([...channels, ...await listProjectSlugsPinningContentPackVersionLocked(id, version)]),
      ].sort(),
    })
    await recordRemoval({
      pack_id: packId,
      removed_at: new Date().toISOString(),
      outcome: 'removed',
      channels: [],
      detail: null,
      gateway_remove_at: null,
      versions: outcome.versions,
      restored_at: null,
      reported_at: null,
    }, paths)
    logLine('info', 'Content Pack removed from this Mac', { pack_id: packId, versions: outcome.versions.length })
    return { pack_id: packId, removed: outcome.versions }
  } catch (error) {
    if (error instanceof ContentPackInUseError) {
      await recordRemoval({
        pack_id: packId,
        removed_at: new Date().toISOString(),
        outcome: 'kept_in_use',
        channels: error.channels,
        detail: error.message,
        gateway_remove_at: null,
        versions: [],
        restored_at: null,
        reported_at: null,
      }, paths).catch(() => { /* the refusal is the answer; the record is best effort here */ })
      throw new ContentPackRemovalError('CONTENT_PACK_IN_USE', error.message, error.channels)
    }
    const code = (error as { code?: unknown })?.code
    if (typeof code === 'string' && code.startsWith('CONTENT_PACK_')) {
      throw new ContentPackRemovalError(code, (error as Error).message)
    }
    throw error
  }
}

/** Put a pack this Mac removed back where it was, from Story's Trash. */
export async function restoreContentPack(
  packId: string,
  options: ContentPackLifecycleOptions = {},
): Promise<ContentPackRemovalResult> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const store = await readContentPackRemovalStore(paths)
  if (store.unreadable) {
    throw new ContentPackRemovalError('CONTENT_PACK_REMOVAL_STATE_UNREADABLE', 'This Mac cannot read its Content Pack removal records.')
  }
  const entry = store.ledger.packs[packId]
  if (!entry || entry.outcome !== 'removed') {
    throw new ContentPackRemovalError('CONTENT_PACK_NOT_REMOVED', 'This pack was not removed by Story Studio, so there is nothing to restore.')
  }
  if (entry.restored_at) throw new ContentPackRemovalError('CONTENT_PACK_ALREADY_RESTORED', 'This pack was already restored.')
  const restored = await withContentPackCoordinationLock(paths, () => withContentPackStateTransaction(async (state, transaction) => {
    const pack = state.packs[packId] ?? { discovery_disabled: false, versions: {} }
    for (const version of entry.versions) {
      if (pack.versions[version.version]) {
        throw new ContentPackRemovalError('CONTENT_PACK_ALREADY_INSTALLED', `${packId} ${version.version} is already installed on this Mac.`)
      }
      const { pending_removal: _pending, ...record } = version.record
      pack.versions[version.version] = { ...record, install_path: version.install_path }
    }
    const active = entry.versions.find(version => version.active)
    if (active) pack.active_version = active.version
    state.packs[packId] = pack
    await transaction.checkpoint()
    for (const version of entry.versions) {
      if (!version.trash_path) {
        throw new ContentPackRemovalError('CONTENT_PACK_TRASH_MISSING', `The files for ${packId} ${version.version} are no longer in Story Studio's Trash.`)
      }
      await fs.mkdir(path.dirname(version.install_path), { recursive: true })
      try {
        await fs.rename(version.trash_path, version.install_path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        // A rename cannot cross volumes. Copy first, and only then move the
        // Trash copy aside — a failed copy must leave the only copy in Trash.
        await fs.cp(version.trash_path, version.install_path, { recursive: true, errorOnExist: true, force: false })
        moveContentPackToTrash(version.trash_path, path.join('restored-source', path.basename(version.trash_path)))
      }
    }
    return entry.versions
  }, paths))
  await recordRemoval({ ...entry, restored_at: new Date().toISOString() }, paths)
  logLine('info', 'Content Pack restored from Story Studio Trash', { pack_id: packId, versions: restored.length })
  return { pack_id: packId, removed: restored }
}

/**
 * Apply the Gateway's "take this pack off installs" request.
 *
 * Once per `remove_from_installs_at`: the instant is compared with the record
 * this Mac already holds, so a restart, a second overview read or a Gateway
 * that keeps saying it can never remove the same pack twice. A pack a channel
 * uses is kept, and the reason is recorded and shown.
 */
export async function applyGatewayPackRemovals(
  entries: readonly GenStudioRetiredPackRemoval[],
  options: ContentPackLifecycleOptions = {},
): Promise<ContentPackRemovalEntry[]> {
  if (entries.length === 0) return []
  const paths = options.paths ?? getContentPackRuntimePaths()
  const applied: ContentPackRemovalEntry[] = []
  for (const entry of entries) {
    const store = await readContentPackRemovalStore(paths)
    if (store.unreadable) {
      logLine('warn', 'Gateway pack removal not applied: removal records are unreadable', { pack_id: entry.packId })
      continue
    }
    const previous = store.ledger.packs[entry.packId]
    if (previous && previous.gateway_remove_at === entry.removeFromInstallsAt) continue
    const state = await readContentPackState(paths)
    if (!state.packs[entry.packId]) continue
    const channels = (await contentPackUsage([entry.packId], paths))[entry.packId] ?? []
    try {
      const outcome = await removeContentPackVersions(entry.packId, listProjectSlugsPinningContentPackVersionLocked, {
        ...options,
        isPinned: async (id, version) => [
          ...new Set([...channels, ...await listProjectSlugsPinningContentPackVersionLocked(id, version)]),
        ].sort(),
      })
      const record: ContentPackRemovalEntry = {
        pack_id: entry.packId,
        removed_at: new Date().toISOString(),
        outcome: 'removed',
        channels: [],
        detail: 'Removed on the Gateway.',
        gateway_remove_at: entry.removeFromInstallsAt,
        versions: outcome.versions,
        restored_at: null,
        reported_at: null,
      }
      await recordRemoval(record, paths)
      applied.push(record)
      logLine('info', 'Content Pack removed at the Gateway\'s request', { pack_id: entry.packId })
    } catch (error) {
      const inUse = error instanceof ContentPackInUseError
      const record: ContentPackRemovalEntry = {
        pack_id: entry.packId,
        removed_at: new Date().toISOString(),
        outcome: inUse ? 'kept_in_use' : 'failed',
        channels: inUse ? error.channels : [],
        detail: String((error as Error)?.message ?? error).slice(0, 2048),
        gateway_remove_at: entry.removeFromInstallsAt,
        versions: [],
        restored_at: null,
        reported_at: null,
      }
      await recordRemoval(record, paths).catch(() => { /* the log below is the durable trace */ })
      applied.push(record)
      logLine('warn', 'Gateway Content Pack removal could not be applied', {
        pack_id: entry.packId, outcome: record.outcome, reason: record.detail,
      })
    }
  }
  return applied
}

/** What the Gateway has not been told yet, for the app check-in body. */
export async function pendingPackRemovalReports(
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<Array<{ pack_id: string; outcome: ContentPackRemovalOutcome; channels?: string[]; detail?: string }>> {
  const store = await readContentPackRemovalStore(paths)
  if (store.unreadable) return []
  return Object.values(store.ledger.packs)
    .filter(entry => entry.gateway_remove_at !== null && entry.reported_at === null)
    .map(entry => ({
      pack_id: entry.pack_id,
      outcome: entry.outcome,
      ...(entry.channels.length ? { channels: entry.channels } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    }))
}

/** Called only after the Gateway accepted the check-in. */
export async function markPackRemovalReportsSent(
  packIds: readonly string[],
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<void> {
  if (packIds.length === 0) return
  const store = await readContentPackRemovalStore(paths)
  if (store.unreadable) return
  const sentAt = new Date().toISOString()
  const packs = { ...store.ledger.packs }
  for (const packId of packIds) {
    const entry = packs[packId]
    if (entry) packs[packId] = { ...entry, reported_at: sentAt }
  }
  await withContentPackCoordinationLock(paths, () => writeRemovalLedger({ schema_version: 1, packs }, paths))
}

export interface ContentPackRemovalStatus {
  /** Removal records, newest first is not guaranteed: keyed by pack id. */
  packs: Record<string, ContentPackRemovalEntry>
  channels: Record<string, string[]>
  unreadable: boolean
}

/**
 * Finish a removal a crash left half-done: every version `pending_removal`,
 * no ledger entry. Nothing to veto it — the decision was already taken — so
 * the bytes still on disk go to Story's Trash and the pack stops being listed.
 * A failure here is logged and simply tried again on the next read.
 */
export async function healInterruptedContentPackRemovals(
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<void> {
  let state: ContentPackRuntimeState
  try { state = await readContentPackState(paths) } catch { return }
  const store = await readContentPackRemovalStore(paths)
  if (store.unreadable) return
  for (const [packId, pack] of Object.entries(state.packs)) {
    const versions = Object.values(pack.versions)
    if (versions.length === 0 || !versions.every(version => version.pending_removal)) continue
    if (store.ledger.packs[packId]) continue
    try {
      const outcome = await completeInterruptedContentPackRemoval(packId, { paths })
      await recordRemoval({
        pack_id: packId,
        removed_at: new Date().toISOString(),
        outcome: 'removed',
        channels: [],
        detail: 'Story Studio finished a removal that had been interrupted.',
        gateway_remove_at: null,
        versions: outcome.versions,
        restored_at: null,
        reported_at: null,
      }, paths)
      logLine('info', 'Interrupted Content Pack removal finished', { pack_id: packId, versions: outcome.versions.length })
    } catch (error) {
      logLine('warn', 'Interrupted Content Pack removal could not be finished', {
        pack_id: packId, reason: String((error as Error)?.message ?? error),
      })
    }
  }
}

/** Everything the Library's Installed view needs, in one local read. */
export async function readContentPackRemovalStatus(
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<ContentPackRemovalStatus> {
  await healInterruptedContentPackRemovals(paths).catch(() => { /* a heal never breaks the read */ })
  const store = await readContentPackRemovalStore(paths)
  const state = await readContentPackState(paths)
  const channels = await contentPackUsage(Object.keys(state.packs), paths)
  return { packs: store.ledger.packs, channels, unreadable: store.unreadable }
}
