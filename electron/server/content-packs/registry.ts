import type { ContentPackVerificationPolicy, VerifiedContentPack } from './archive.js'
import { verifyInstalledContentPackClosure } from './installer.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { listVerifiedRecoveryPacks } from './recovery.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import type { ContentPackVersionRef } from './runtime-types.js'
import { readContentPackState } from './state.js'
import type { ContentPackDocument, ContentPackItemKind } from './types.js'

export type ContentCatalogSource = 'signed-installed' | 'signed-recovery' | 'legacy-builtin' | 'legacy-user-fork'

export interface CatalogEntry<T> {
  value: T
  source: ContentCatalogSource
  pack?: ContentPackVersionRef
  /** Manifest-declared raster references only; no filesystem paths or bytes. */
  assets?: Readonly<Record<string, { asset_id: string; mime: 'image/png' | 'image/jpeg' | 'image/webp' }>>
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
): Promise<VerifiedContentPack | null> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const state = await readContentPackState(paths)
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
  const result: CatalogEntry<ContentPackDocument>[] = []
  const emittedVersions = new Set<string>()

  for (const pin of options.pins ?? []) {
    const installed = await verifiedInstalled(pin, options, pin.archive_sha256)
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
    const verified = await verifiedInstalled({ pack_id: packId, version: pack.active_version }, options)
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

  for (const legacy of options.legacy ?? []) {
    if (legacy.value.kind !== kind) continue
    result.push({ value: cloneDocument(legacy.value), source: legacy.source })
  }
  return result
}

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

  const paths = options.paths ?? getContentPackRuntimePaths()
  const state = await readContentPackState(paths)
  const matches: CatalogEntry<ContentPackDocument>[] = []
  const emittedVersions = new Set<string>()
  for (const [packId, pack] of Object.entries(state.packs).sort(([left], [right]) => left.localeCompare(right))) {
    if (!pack.active_version || pack.discovery_disabled) continue
    const verified = await verifiedInstalled({ pack_id: packId, version: pack.active_version }, options)
    if (!verified || verified.manifest.lifecycle !== 'active') continue
    emittedVersions.add(`${packId}@${pack.active_version}`)
    const match = entriesFromVerified(verified, 'signed-installed').find(entry => entry.value.id === id)
    if (match) matches.push(match)
  }
  for (const recovery of await recoveryPacks(options)) {
    if (recovery.manifest.lifecycle !== 'active'
      || state.packs[recovery.manifest.pack_id]?.discovery_disabled
      || emittedVersions.has(`${recovery.manifest.pack_id}@${recovery.manifest.version}`)) continue
    const match = entriesFromVerified(recovery, 'signed-recovery').find(entry => entry.value.id === id)
    if (match) matches.push(match)
  }
  if (matches.length > 1) throw new Error(`Content Pack catalog item is ambiguous without an exact pin: ${id}`)
  return matches[0] ?? null
}
