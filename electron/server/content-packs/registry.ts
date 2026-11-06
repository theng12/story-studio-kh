import fs from 'node:fs/promises'

import type { ContentPackVerificationPolicy, VerifiedContentPack } from './archive.js'
import { installedTreeFingerprint, verifyInstalledContentPackClosure } from './installer.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { listVerifiedRecoveryPacks } from './recovery.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import type { ContentPackRuntimeState, ContentPackVersionRef } from './runtime-types.js'
import { readContentPackState } from './state.js'
import type { ContentPackDocument, ContentPackItemKind, UserForkableContentPackItemKind } from './types.js'
import {
  listUserForks,
  readUserFork,
  type UserForkDocument,
} from './user-forks.js'

export type ContentCatalogSource = 'signed-installed' | 'signed-recovery' | 'legacy-builtin' | 'legacy-user-fork'

export interface CatalogEntry<T> {
  value: T
  source: ContentCatalogSource
  pack?: ContentPackVersionRef
  /** Manifest-declared raster references only; no filesystem paths or bytes. */
  assets?: Readonly<Record<string, { asset_id: string; mime: 'image/png' | 'image/jpeg' | 'image/webp' }>>
}

export interface CatalogPackVersion {
  ref: ContentPackVersionRef
  items: Array<{
    id: string
    kind: ContentPackItemKind
    content_sha256: string
  }>
}

type LegacyCatalogEntry = CatalogEntry<ContentPackDocument> & {
  source: 'legacy-builtin' | 'legacy-user-fork'
  pack?: never
}

export interface ContentPackRegistryOptions {
  includeDisabled?: boolean
  /** Explicit pins are ordered before active discovery entries. Task 6 supplies project pins. */
  pins?: readonly ContentPackVersionRef[]
  /** Compatibility seam used by existing legacy loaders; signed resolution never accepts bare IDs. */
  legacy?: readonly LegacyCatalogEntry[]
  paths?: ContentPackRuntimePaths
  policy?: ContentPackVerificationPolicy
  recoveryRoot?: string
  /** Test-only compatibility seam; production resolves the installed app version. */
  appVersion?: string
}

/** Resolve one explicit local user fork without exposing its storage path. */
export async function resolveUserForkCatalogItem(
  id: string,
  kind: UserForkableContentPackItemKind,
  options: Pick<ContentPackRegistryOptions, 'paths'> = {},
): Promise<CatalogEntry<UserForkDocument> | null> {
  const record = await readUserFork(id, { paths: options.paths })
  if (!record || record.kind !== kind) return null
  return { value: structuredClone(record.document), source: 'legacy-user-fork' }
}

/** List explicit local user forks after signed discovery and before raw legacy compatibility entries. */
export async function listUserForkCatalogEntries(
  kind: UserForkableContentPackItemKind,
  options: Pick<ContentPackRegistryOptions, 'paths'> = {},
): Promise<Array<CatalogEntry<UserForkDocument>>> {
  return (await listUserForks(kind, { paths: options.paths }))
    .map(record => ({ value: structuredClone(record.document), source: 'legacy-user-fork' as const }))
}

const QUALIFIED_ID = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export function isQualifiedContentPackId(id: string): boolean {
  return QUALIFIED_ID.test(id)
}

function cloneDocument<T extends ContentPackDocument>(document: T): T {
  return structuredClone(document)
}

function packRef(verified: VerifiedContentPack): ContentPackVersionRef {
  return {
    pack_id: verified.manifest.pack_id,
    version: verified.manifest.version,
    archive_sha256: verified.archiveSha256,
  }
}

function entriesFromVerified(
  verified: VerifiedContentPack,
  source: 'signed-installed' | 'signed-recovery',
  kind?: ContentPackItemKind,
): CatalogEntry<ContentPackDocument>[] {
  const ref = packRef(verified)
  const assets = Object.fromEntries(verified.manifest.files
    .filter((file): file is typeof file & { mime: 'image/png' | 'image/jpeg' | 'image/webp' } => file.mime !== 'application/json')
    .map(file => [file.path, { asset_id: file.sha256, mime: file.mime }]))
  return [...verified.documents.values()]
    .filter(document => kind === undefined || document.kind === kind)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(document => ({ value: cloneDocument(document), source, pack: { ...ref }, assets: structuredClone(assets) }))
}

async function policyFor(options: ContentPackRegistryOptions): Promise<ContentPackVerificationPolicy> {
  return options.policy ?? getFirstPartyContentPackVerificationPolicy()
}

async function verifiedInstalled(
  ref: Pick<ContentPackVersionRef, 'pack_id' | 'version'>,
  options: ContentPackRegistryOptions,
  expectedSha?: string,
  // 1.4.257 — a listing passes the state it already read; re-reading and
  // re-validating state.json once per installed pack was most of a listing.
  knownState?: ContentPackRuntimeState,
): Promise<VerifiedContentPack | null> {
  const state = knownState ?? await readContentPackState(options.paths ?? getContentPackRuntimePaths())
  const installed = state.packs[ref.pack_id]?.versions[ref.version]
  if (!installed || installed.pending_removal) return null
  if (expectedSha && installed.archive_sha256 !== expectedSha) return null
  const verified = await verifyInstalledContentPackClosure(
    state,
    ref.pack_id,
    ref.version,
    await policyFor(options),
    options.appVersion,
  )
  if (expectedSha && verified.archiveSha256 !== expectedSha) return null
  return verified
}

async function recoveryPacks(options: ContentPackRegistryOptions): Promise<VerifiedContentPack[]> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  return listVerifiedRecoveryPacks({
    paths,
    policy: await policyFor(options),
    recoveryRoot: options.recoveryRoot,
    appVersion: options.appVersion,
  })
}

function catalogPackVersion(verified: VerifiedContentPack): CatalogPackVersion {
  const fileHashes = new Map(verified.manifest.files.map(file => [file.path, file.sha256]))
  return {
    ref: packRef(verified),
    items: verified.manifest.items.map(item => ({
      id: item.id,
      kind: item.kind,
      content_sha256: fileHashes.get(item.path) || '',
    })),
  }
}

/** Resolve one exact locally verified version without using active discovery. */
export async function resolveCatalogPackVersion(
  packId: string,
  version: string,
  options: ContentPackRegistryOptions = {},
  expectedArchiveSha256?: string,
): Promise<CatalogPackVersion | null> {
  const installed = await verifiedInstalled({ pack_id: packId, version }, options, expectedArchiveSha256)
  // Owner ruling: `retired` resolves nowhere. This is the shared exact-version
  // reader, so selection, pinning, reinstall and the pin-move wrapper all stop
  // here instead of each caller remembering the rule.
  if (installed) return installed.manifest.lifecycle === 'retired' ? null : catalogPackVersion(installed)
  const recovery = (await recoveryPacks(options)).find(pack => (
    pack.manifest.pack_id === packId
    && pack.manifest.version === version
    && (!expectedArchiveSha256 || pack.archiveSha256 === expectedArchiveSha256)
  ))
  return recovery && recovery.manifest.lifecycle !== 'retired' ? catalogPackVersion(recovery) : null
}

/**
 * The one version an existing project pin may move to: the pack's own active
 * installed release, verified and still `active`. A retired, replaced,
 * recalled, disabled-away or missing active version returns null, so a pin
 * move can never land on bytes that discovery already refuses.
 */
export async function resolveActiveInstalledPackVersion(
  packId: string,
  options: ContentPackRegistryOptions = {},
): Promise<CatalogPackVersion | null> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const state = await readContentPackState(paths)
  const version = state.packs[packId]?.active_version
  if (!version) return null
  const verified = await verifiedInstalled({ pack_id: packId, version }, options, undefined, state)
  if (!verified || verified.manifest.lifecycle !== 'active') return null
  return catalogPackVersion(verified)
}

/**
 * List immutable clones in deterministic precedence order. Discovery never
 * exposes retired/replaced packs; disabled installed packs require an exact pin.
 */
export async function listCatalogEntries(
  kind: ContentPackItemKind,
  options: ContentPackRegistryOptions = {},
): Promise<CatalogEntry<ContentPackDocument>[]> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const state = await readContentPackState(paths)
  const key = JSON.stringify([kind, !!options.includeDisabled, options.pins ?? [], paths, options.recoveryRoot ?? null, options.appVersion ?? null])
  const byPolicy = listingMemo.get(options.policy ?? DEFAULT_POLICY) ?? new Map()
  listingMemo.set(options.policy ?? DEFAULT_POLICY, byPolicy)
  const stamp = await listingStamp(paths, state, options)
  let signed = byPolicy.get(key)?.stamp === stamp ? byPolicy.get(key)!.entries : null
  if (!signed) {
    signed = await listSignedCatalogEntries(kind, options, state)
    byPolicy.set(key, { stamp, entries: signed })
  }
  // Callers receive their own clones, exactly as before the memo.
  const result = structuredClone(signed)
  for (const legacy of options.legacy ?? []) {
    if (legacy.value.kind !== kind) continue
    result.push({ value: cloneDocument(legacy.value), source: legacy.source })
  }
  return result
}

/**
 * 1.4.257 — the signed part of a listing, kept until state.json, an active
 * pack's complete version tree or the recovery tree changes. Opening a project
 * listed every Series Formula through here, re-verifying every installed pack
 * each time: 40–82 s on the owner's mini with ~115 packs installed.
 */
const DEFAULT_POLICY = {}
const listingMemo = new WeakMap<object, Map<string, { stamp: string, entries: CatalogEntry<ContentPackDocument>[] }>>()

async function listingStamp(paths: ContentPackRuntimePaths, state: ContentPackRuntimeState, options: ContentPackRegistryOptions): Promise<string> {
  const identity = async (file: string) => {
    const info = await fs.lstat(file).catch(() => null)
    return info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}` : '-'
  }
  const folders = Object.values(state.packs).flatMap(pack => Object.values(pack.versions).map(version => version.install_path)).sort()
  const roots = [options.recoveryRoot ?? paths.recoveryRoot, ...folders]
  const trees = await Promise.all(roots.map(root => installedTreeFingerprint(root).catch(() => '-')))
  const identities = await Promise.all([paths.statePath, ...roots].map(identity))
  return [...identities, ...trees].join('|')
}

async function listSignedCatalogEntries(
  kind: ContentPackItemKind,
  options: ContentPackRegistryOptions,
  state: ContentPackRuntimeState,
): Promise<CatalogEntry<ContentPackDocument>[]> {
  const result: CatalogEntry<ContentPackDocument>[] = []
  const emittedVersions = new Set<string>()

  for (const pin of options.pins ?? []) {
    const installed = await verifiedInstalled(pin, options, pin.archive_sha256, state)
    const verified = installed
      ?? (await recoveryPacks(options)).find(pack => pack.manifest.pack_id === pin.pack_id
        && pack.manifest.version === pin.version && pack.archiveSha256 === pin.archive_sha256)
    if (!verified) continue
    result.push(...entriesFromVerified(verified, installed ? 'signed-installed' : 'signed-recovery', kind))
    emittedVersions.add(`${pin.pack_id}@${pin.version}`)
  }

  for (const [packId, pack] of Object.entries(state.packs).sort(([left], [right]) => left.localeCompare(right))) {
    if (!pack.active_version || (pack.discovery_disabled && !options.includeDisabled)) continue
    const versionKey = `${packId}@${pack.active_version}`
    if (emittedVersions.has(versionKey)) continue
    const verified = await verifiedInstalled({ pack_id: packId, version: pack.active_version }, options, undefined, state)
    if (!verified || verified.manifest.lifecycle !== 'active') continue
    result.push(...entriesFromVerified(verified, 'signed-installed', kind))
    emittedVersions.add(versionKey)
  }

  for (const verified of (await recoveryPacks(options)).sort((left, right) => {
    const packOrder = left.manifest.pack_id.localeCompare(right.manifest.pack_id)
    return packOrder || left.manifest.version.localeCompare(right.manifest.version)
  })) {
    const versionKey = `${verified.manifest.pack_id}@${verified.manifest.version}`
    const installedState = state.packs[verified.manifest.pack_id]
    if (emittedVersions.has(versionKey) || verified.manifest.lifecycle !== 'active'
      || (installedState?.discovery_disabled && !options.includeDisabled)) continue
    result.push(...entriesFromVerified(verified, 'signed-recovery', kind))
    emittedVersions.add(versionKey)
  }
  return result
}

/**
 * A `replaced` pack is superseded, not withdrawn: it is never listed or offered
 * again (a product its successor now owns must not be browsable twice), but a
 * customer who already installed it keeps what they paid for, and a stored id
 * still resolves through it when the successor is not on this Mac (owner
 * ruling, 2026-10-29 — "it's either install or update"). `retired` resolves
 * nowhere.
 */
const RESOLVABLE_LIFECYCLES: ReadonlySet<string> = new Set(['active', 'replaced'])

/** Resolve a qualified signed item. Bare legacy IDs intentionally return null. */
export async function resolveCatalogItem(
  id: string,
  pin?: ContentPackVersionRef,
  options: ContentPackRegistryOptions = {},
): Promise<CatalogEntry<ContentPackDocument> | null> {
  if (!isQualifiedContentPackId(id)) return null
  if (pin) {
    const installed = await verifiedInstalled(pin, options, pin.archive_sha256)
    if (installed) {
      const document = installed.documents.get(id)
      return document ? entriesFromVerified(installed, 'signed-installed').find(entry => entry.value.id === id) ?? null : null
    }
    const recovery = (await recoveryPacks(options)).find(pack => pack.manifest.pack_id === pin.pack_id
      && pack.manifest.version === pin.version && pack.archiveSha256 === pin.archive_sha256)
    const document = recovery?.documents.get(id)
    return recovery && document
      ? entriesFromVerified(recovery, 'signed-recovery').find(entry => entry.value.id === id) ?? null
      : null
  }

  // Project pins are an ordered exact-version preference. They are searched
  // before active discovery so installing a newer version cannot change an
  // existing project's effective content.
  for (const projectPin of options.pins ?? []) {
    const installed = await verifiedInstalled(projectPin, options, projectPin.archive_sha256)
    if (installed?.documents.has(id)) {
      return entriesFromVerified(installed, 'signed-installed').find(entry => entry.value.id === id) ?? null
    }
    const recovery = (await recoveryPacks(options)).find(pack => (
      pack.manifest.pack_id === projectPin.pack_id
      && pack.manifest.version === projectPin.version
      && pack.archiveSha256 === projectPin.archive_sha256
    ))
    if (recovery?.documents.has(id)) {
      return entriesFromVerified(recovery, 'signed-recovery').find(entry => entry.value.id === id) ?? null
    }
  }

  const paths = options.paths ?? getContentPackRuntimePaths()
  const state = await readContentPackState(paths)
  const matches: CatalogEntry<ContentPackDocument>[] = []
  const emittedVersions = new Set<string>()
  for (const [packId, pack] of Object.entries(state.packs).sort(([left], [right]) => left.localeCompare(right))) {
    if (!pack.active_version || pack.discovery_disabled) continue
    const verified = await verifiedInstalled({ pack_id: packId, version: pack.active_version }, options, undefined, state)
    if (!verified || !RESOLVABLE_LIFECYCLES.has(verified.manifest.lifecycle)) continue
    emittedVersions.add(`${packId}@${pack.active_version}`)
    const match = entriesFromVerified(verified, 'signed-installed').find(entry => entry.value.id === id)
    if (match) matches.push(match)
  }
  for (const recovery of await recoveryPacks(options)) {
    if (!RESOLVABLE_LIFECYCLES.has(recovery.manifest.lifecycle)
      || state.packs[recovery.manifest.pack_id]?.discovery_disabled
      || emittedVersions.has(`${recovery.manifest.pack_id}@${recovery.manifest.version}`)) continue
    const match = entriesFromVerified(recovery, 'signed-recovery').find(entry => entry.value.id === id)
    if (match) matches.push(match)
  }
  if (matches.length > 1) throw new Error(`Content Pack catalog item is ambiguous without an exact pin: ${id}`)
  return matches[0] ?? null
}
