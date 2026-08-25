import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'

import {
  verifyContentPackArchive,
  verifyDeliveryAttestedContentPackArchive,
  type ContentPackVerificationPolicy,
  type VerifiedContentPack,
} from './archive.js'
import { verifyGenStudioDeliveryAttestation } from './delivery-attestation.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { installedVersionPath, resolveVerifiedPackFile, type ContentPackRuntimePaths } from './runtime-paths.js'
import {
  ContentPackDeliveryAttestationSchema,
  type ContentPackInstallRequest,
  type ContentPackInstallResult,
  type ContentPackInstalledVersion,
  type ContentPackRuntimeState,
} from './runtime-types.js'
import { withContentPackCoordinationLock, withContentPackStateTransaction } from './state.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { resolveStoryStudioVersion } from '../lib/app-version.js'
import { logLine } from '../services/logger.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_QUARANTINE_REASON = 64
const SAFE_QUARANTINE_REASON = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface ContentPackInstallerHooks {
  afterStageWrite?: () => Promise<void>
  beforeVersionRename?: () => Promise<void>
  beforeActivationWrite?: () => Promise<void>
  beforeRequiredFsync?: () => Promise<void>
  afterRequiredFsync?: (directories: readonly string[]) => Promise<void>
}

export interface ContentPackInstallOptions {
  paths?: ContentPackRuntimePaths
  policy?: ContentPackVerificationPolicy
  hooks?: ContentPackInstallerHooks
  /** Test-only seam; production derives the actual app version from its own package resource. */
  appVersion?: string
  /** Test seam; production resolves the independently verified commerce key history. */
  resolveGenStudioSigningKey?: (evidence: NonNullable<ContentPackInstallRequest['deliveryAttestation']>) => Promise<string>
  /** Keep a verified immutable version inactive until a caller commits a wider transaction. */
  activate?: boolean
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifyArchiveForRequest(
  archiveBytes: Uint8Array,
  request: Pick<ContentPackInstallRequest, 'source' | 'deliveryAttestation'>,
  policy: ContentPackVerificationPolicy,
  resolveSigningKey?: ContentPackInstallOptions['resolveGenStudioSigningKey'],
): Promise<VerifiedContentPack> {
  // model-drift-allow: Frozen Content Store source discriminator selects receipt-attested archive verification.
  if (request.source !== 'genstudio-store') {
    if (request.deliveryAttestation) throw new Error('Only GenStudio Store archives may carry delivery attestation evidence')
    return verifyContentPackArchive(archiveBytes, policy)
  }
  const evidence = ContentPackDeliveryAttestationSchema.parse(request.deliveryAttestation)
  const verified = await verifyDeliveryAttestedContentPackArchive(archiveBytes)
  const key = await (resolveSigningKey
    ? resolveSigningKey(evidence)
    : (await import('../content-store/commerce-state.js')).resolveVerifiedContentStoreSigningKey({
        accountId: evidence.account_id, origin: evidence.genstudio_origin, keyId: evidence.key_id,
      }))
  verifyGenStudioDeliveryAttestation(evidence, verified.manifest, sha256(archiveBytes), archiveBytes.byteLength, key)
  return verified
}

export interface ContentPackVersionResolutionOptions {
  packaged?: boolean
  electronVersion?: string
  sourceContentPackRoot?: string
}

/** Compatibility wrapper retained for existing Content Pack callers. */
export async function resolveContentPackAppVersion(options: ContentPackVersionResolutionOptions = {}): Promise<string> {
  return resolveStoryStudioVersion({
    packaged: options.packaged,
    electronVersion: options.electronVersion,
    sourceRoot: options.sourceContentPackRoot
      ? path.resolve(options.sourceContentPackRoot, '..', '..', '..')
      : undefined,
  })
}

function compareExactSemver(left: string, right: string): number {
  const leftParts = left.split('.').map(part => BigInt(part))
  const rightParts = right.split('.').map(part => BigInt(part))
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1
  }
  return 0
}

export async function assertContentPackAppCompatible(minimum: string, explicitAppVersion?: string): Promise<void> {
  const installed = explicitAppVersion ?? await resolveContentPackAppVersion()
  if (!/^\d+\.\d+\.\d+$/.test(installed)) throw new Error('Story Studio version is unavailable for Content Pack compatibility checks')
  if (compareExactSemver(installed, minimum) < 0) {
    throw new Error(`Content Pack requires Story Studio ${minimum} or newer (this app is ${installed})`)
  }
}

function assertContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Content Pack write path must be contained by its root')
  }
  return resolvedCandidate
}

async function assertSafeDirectory(target: string): Promise<void> {
  const info = await fs.lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Content Pack write directory is unsafe: ${target}`)
}

async function ensureExclusiveDirectory(root: string, target: string, createdDirectories?: Set<string>): Promise<void> {
  assertWriteIsolatedInTests(root, 'content-pack-installer')
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Content Pack write path must be contained by its root')
  // Only the root may be recursively created. Descendants are created one at
  // a time and lstat-checked before the next segment, so mkdir never follows
  // an attacker-provided symlink into an outside tree.
  let rootCreated = false
  try { await fs.mkdir(resolvedRoot, { mode: DIRECTORY_MODE }); rootCreated = true } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  let cursor = resolvedRoot
  await assertSafeDirectory(cursor)
  if (rootCreated) createdDirectories?.add(cursor)
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Content Pack write path must be contained by its root')
    const next = path.join(cursor, segment)
    let created = false
    try { await fs.mkdir(next, { mode: DIRECTORY_MODE }); created = true } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    cursor = next
    await assertSafeDirectory(cursor)
    if (created) createdDirectories?.add(cursor)
  }
}

async function existingSafeDirectory(target: string): Promise<boolean> {
  try {
    await assertSafeDirectory(target)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeExclusiveFile(root: string, target: string, bytes: Uint8Array, createdDirectories?: Set<string>): Promise<void> {
  assertContained(root, target)
  await ensureExclusiveDirectory(root, path.dirname(target), createdDirectories)
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await fs.open(target, flags, FILE_MODE)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Content Pack write target is unsafe: ${target}`)
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Directory entry durability is mandatory on POSIX. Windows lacks directory fsync semantics. */
async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncParents(root: string, fromDirectory: string): Promise<void> {
  let cursor = path.resolve(fromDirectory)
  const stop = path.resolve(root)
  while (true) {
    await fsyncDirectory(cursor)
    if (cursor === stop) break
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error('Content Pack directory escaped its root during fsync')
    cursor = parent
  }
}

async function fsyncCreatedDirectories(createdDirectories: ReadonlySet<string>): Promise<string[]> {
  const ordered = [...createdDirectories].sort((left, right) => right.split(path.sep).length - left.split(path.sep).length || right.localeCompare(left))
  for (const directory of ordered) await fsyncDirectory(directory)
  return ordered
}

async function removeTreeIfContained(root: string, candidate: string): Promise<void> {
  assertContained(root, candidate)
  await fs.rm(candidate, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
}

function nodeKey(packId: string, version: string): string {
  return `${packId}@${version}`
}

/**
 * Verification is over IMMUTABLE bytes, so the same bytes cannot verify
 * differently twice — and re-reading them is not free.
 *
 * MEASURED 2026-08-24 on the owner's own install: 64 retained pack versions,
 * 44 MB. Every catalogue listing re-read and re-hashed all of it — the archive
 * once, then every materialised file twice (disk and archive) — and every
 * listing of every KIND paid it again. Opening the Thumbnail Recipe Library
 * took NINE SECONDS to show twelve recipes, and the cost was in the packs, not
 * the recipes: at two hundred packs the same twelve recipes would take half a
 * minute. His question was "we just have a few, what happens when we have
 * hundreds of options?" and this was the answer.
 *
 * WHAT KEEPS THIS HONEST. The memo key is the state of the version directory
 * on disk — every path under it, with its size, mtime and mode. A cache hit
 * therefore means nothing there has changed since the bytes were hashed; any
 * edit, replacement, truncation or permission change misses the memo and pays
 * the full verification. It is per-process and never persisted, so a restart
 * re-verifies from scratch, as does boot recovery.
 */
const verifiedVersionMemo = new Map<string, { fingerprint: string; verified: VerifiedContentPack }>()

/** Every path under a version root with its size, mtime and mode, hashed. */
async function installedTreeFingerprint(installPath: string): Promise<string> {
  const parts: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name)
      const info = await fs.lstat(full)
      parts.push(`${full}\u0000${info.size}\u0000${info.mtimeMs}\u0000${info.mode}`)
      if (info.isDirectory()) await walk(full)
    }
  }
  await walk(installPath)
  return sha256(Buffer.from(parts.join('\n'), 'utf8'))
}

/**
 * The policy and the signing-key resolver are part of the answer, so they are
 * part of the key. A different keyring may legitimately reach a different
 * verdict about the same archive.
 */
function verificationIdentity(
  policy: ContentPackVerificationPolicy,
  resolveSigningKey?: ContentPackInstallOptions['resolveGenStudioSigningKey'],
): string {
  const publishers = [...policy.publisherKeys.entries()]
    .map(([id, key]) => `${id}\u0000${key.publisherId}\u0000${key.publicKeyPem}`)
    .sort()
    .join('\n')
  const limits = JSON.stringify(policy.limits ?? {})
  // A resolver is a closure whose behaviour we cannot inspect, so its presence
  // disables the memo rather than being assumed stable.
  return resolveSigningKey ? 'resolver' : sha256(Buffer.from(`${publishers}\n${limits}`, 'utf8'))
}

export async function verifyInstalledContentPackVersion(
  installed: Pick<ContentPackInstalledVersion, 'install_path' | 'archive_sha256' | 'source' | 'delivery_attestation' | 'recalled'>,
  policy: ContentPackVerificationPolicy,
  resolveSigningKey?: ContentPackInstallOptions['resolveGenStudioSigningKey'],
): Promise<VerifiedContentPack> {
  if (installed.recalled) throw new Error('GenStudio recalled this installed Content Pack version')
  if (!await existingSafeDirectory(installed.install_path)) throw new Error(`Content Pack immutable version is missing on disk: ${installed.install_path}`)
  const identity = verificationIdentity(policy, resolveSigningKey)
  const fingerprint = identity === 'resolver'
    ? null
    : `${installed.archive_sha256}\u0000${identity}\u0000${await installedTreeFingerprint(installed.install_path)}`
  if (fingerprint !== null) {
    const remembered = verifiedVersionMemo.get(installed.install_path)
    if (remembered && remembered.fingerprint === fingerprint) return remembered.verified
  }
  const archivePath = resolveVerifiedPackFile(installed.install_path, 'content/archive.sspack')
  const archiveBytes = await fs.readFile(archivePath)
  if (sha256(archiveBytes) !== installed.archive_sha256) throw new Error(`Content Pack immutable archive hash does not match state: ${installed.install_path}`)
  const verified = await verifyArchiveForRequest(archiveBytes, {
    source: installed.source,
    deliveryAttestation: installed.delivery_attestation,
  }, policy, resolveSigningKey)
  for (const [relativePath, bytes] of verified.files) {
    const target = resolveVerifiedPackFile(installed.install_path, relativePath)
    const info = await fs.lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || sha256(await fs.readFile(target)) !== sha256(bytes)) {
      throw new Error(`Content Pack immutable materialised file differs from verified archive: ${target}`)
    }
  }
  if (fingerprint !== null) verifiedVersionMemo.set(installed.install_path, { fingerprint, verified })
  return verified
}

/** Drop every remembered verification. Tests and uninstall paths use this. */
export function forgetVerifiedContentPackVersions(): void {
  verifiedVersionMemo.clear()
}

/**
 * Verify one retained version and its exact dependency closure using only its
 * immutable local archive and materialised bytes. It deliberately never
 * consults a catalogue, renderer, or network.
 */
export async function verifyInstalledContentPackClosure(
  state: ContentPackRuntimeState,
  packId: string,
  version: string,
  policy: ContentPackVerificationPolicy,
  appVersion?: string,
  resolveSigningKey?: ContentPackInstallOptions['resolveGenStudioSigningKey'],
): Promise<VerifiedContentPack> {
  const visiting = new Set<string>()
  const visited = new Map<string, VerifiedContentPack>()
  const visit = async (requiredPackId: string, requiredVersion: string): Promise<VerifiedContentPack> => {
    const key = nodeKey(requiredPackId, requiredVersion)
    const retained = visited.get(key)
    if (retained) return retained
    if (visiting.has(key)) throw new Error(`Content Pack dependency cycle detected at ${key}`)
    const installed = state.packs[requiredPackId]?.versions[requiredVersion]
    if (!installed) throw new Error(`Content Pack dependency is not installed exactly: ${key}`)
    if (installed.pending_removal) throw new Error(`Content Pack dependency is pending removal: ${key}`)
    visiting.add(key)
    try {
      if (installed.recalled) throw new Error(`GenStudio recalled Content Pack version: ${key}`)
      const verified = await verifyInstalledContentPackVersion(installed, policy, resolveSigningKey)
      if (verified.manifest.pack_id !== requiredPackId || verified.manifest.version !== requiredVersion) {
        throw new Error(`Content Pack immutable archive identity does not match state: ${key}`)
      }
      await assertContentPackAppCompatible(verified.manifest.min_app_version, appVersion)
      for (const dependency of verified.manifest.dependencies ?? []) await visit(dependency.pack_id, dependency.version)
      // model-drift-allow: Frozen Content Store source discriminator identifies persisted receipt-attested closure state.
      if (installed.source === 'genstudio-store' && ContentPackDeliveryAttestationSchema.parse(installed.delivery_attestation).subject === 'receipt-root') {
        const evidence = ContentPackDeliveryAttestationSchema.parse(installed.delivery_attestation)
        const closure = evidence.closure_members
        const dependencies = verified.manifest.dependencies ?? []
        if (closure.length !== dependencies.length) throw new Error(`GenStudio delivery closure does not match Content Pack dependencies: ${key}`)
        for (const [index, dependency] of dependencies.entries()) {
          const pinned = closure[index]!
          const retainedDependency = state.packs[dependency.pack_id]?.versions[dependency.version]
          // model-drift-allow: Frozen Content Store source discriminator identifies persisted receipt-attested dependency evidence.
          const dependencyEvidence = retainedDependency?.source === 'genstudio-store'
            ? retainedDependency.delivery_attestation : undefined
          if (!dependencyEvidence || dependencyEvidence.product_id !== pinned.product_id
            || dependencyEvidence.entitlement_family !== pinned.entitlement_family
            || dependencyEvidence.release_id !== pinned.release_id
            || dependencyEvidence.version !== pinned.version
            || dependencyEvidence.archive_sha256 !== pinned.archive_sha256) {
            throw new Error(`GenStudio delivery closure pin does not match the installed dependency: ${key}`)
          }
        }
      }
      visited.set(key, verified)
      return verified
    } finally {
      visiting.delete(key)
    }
  }
  return visit(packId, version)
}

async function verifiedManifestGraph(
  state: ContentPackRuntimeState,
  candidate: VerifiedContentPack,
  policy: ContentPackVerificationPolicy,
  resolveSigningKey?: ContentPackInstallOptions['resolveGenStudioSigningKey'],
): Promise<void> {
  const manifests = new Map<string, VerifiedContentPack['manifest']>()
  for (const [packId, pack] of Object.entries(state.packs)) {
    for (const [version, installed] of Object.entries(pack.versions)) {
      // A recalled retained version is preserved as evidence, not an available
      // graph node. It must not block unrelated installs, while any exact
      // dependency on it still fails below as missing.
      if (installed.recalled) continue
      const verified = await verifyInstalledContentPackVersion(installed, policy, resolveSigningKey)
      if (verified.manifest.pack_id !== packId || verified.manifest.version !== version) {
        throw new Error(`Content Pack immutable archive identity does not match state: ${packId}@${version}`)
      }
      manifests.set(nodeKey(packId, version), verified.manifest)
    }
  }
  const candidateKey = nodeKey(candidate.manifest.pack_id, candidate.manifest.version)
  manifests.set(candidateKey, candidate.manifest)
  for (const [key, manifest] of manifests) {
    for (const dependency of manifest.dependencies ?? []) {
      const dependencyKey = nodeKey(dependency.pack_id, dependency.version)
      if (!manifests.has(dependencyKey)) throw new Error(`Content Pack dependency is not installed exactly: ${key} requires ${dependencyKey}`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visited.has(key)) return
    if (visiting.has(key)) throw new Error(`Content Pack dependency cycle detected at ${key}`)
    visiting.add(key)
    for (const dependency of manifests.get(key)?.dependencies ?? []) visit(nodeKey(dependency.pack_id, dependency.version))
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of manifests.keys()) visit(key)
}

function retainedVersions(state: ContentPackRuntimeState, packId: string): string[] {
  return Object.keys(state.packs[packId]?.versions ?? {}).sort(compareExactSemver)
}

function failureCode(reason: string): string {
  const candidate = reason.split(/[:\s]/, 1)[0].slice(0, MAX_QUARANTINE_REASON).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return SAFE_QUARANTINE_REASON.test(candidate) ? candidate : 'invalid_content_pack'
}

/** Store only bounded, eligible untrusted bytes and a machine-safe code. */
export async function quarantineContentPackBytes(
  bytes: Uint8Array,
  reason: string,
  paths: ContentPackRuntimePaths,
): Promise<string> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error(`Content Pack archive exceeds ${MAX_ARCHIVE_BYTES} byte limit and will not be retained`)
  const digest = sha256(bytes)
  const archivePath = path.join(paths.quarantineRoot, `${digest}.sspack`)
  const sidecarPath = `${archivePath}.json`
  await ensureExclusiveDirectory(paths.root, paths.quarantineRoot)
  try { await writeExclusiveFile(paths.quarantineRoot, archivePath, bytes) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  try { await writeExclusiveFile(paths.quarantineRoot, sidecarPath, new TextEncoder().encode(`${JSON.stringify({ code: failureCode(reason) })}\n`)) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await fsyncDirectory(paths.quarantineRoot)
  // Quarantining was previously silent in every log, so a paid pack could fail
  // to install and leave no trace anywhere except an opaque folder nobody reads.
  logLine('warn', 'Content Pack archive quarantined', {
    code: failureCode(reason), archive_sha256: digest, archive_bytes: bytes.byteLength,
  })
  return archivePath
}

/**
 * A failed attempt keeps its bytes so the failure can be examined. Once the
 * IDENTICAL archive installs, that copy stops being evidence and becomes a
 * standing accusation against a pack that works.
 *
 * Two paid packs sat in quarantine marked `invalid_archive` while both were
 * installed, active and being served — one had been quarantined by a bug fixed
 * 39 minutes later, the other by being pushed through the local-import door,
 * which verifies Store archives against the wrong trust profile. Nothing ever
 * cleared either, so the only durable record of both was wrong.
 */
export async function releaseQuarantinedContentPackBytes(
  archiveSha256: string,
  paths: ContentPackRuntimePaths,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) return false
  const archivePath = assertContained(paths.quarantineRoot, path.join(paths.quarantineRoot, `${archiveSha256}.sspack`))
  let released = false
  for (const target of [`${archivePath}.json`, archivePath]) {
    try {
      // lstat, never stat: a symlink planted here must be removed as the link
      // it is, never followed to whatever it points at.
      const entry = await fs.lstat(target)
      if (!entry.isFile()) continue
      await fs.unlink(target)
      released = true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (released) {
    await fsyncDirectory(paths.quarantineRoot)
    logLine('info', 'Content Pack quarantine cleared by a successful install', { archive_sha256: archiveSha256 })
  }
  return released
}

async function stageArchive(bytes: Uint8Array, paths: ContentPackRuntimePaths): Promise<string> {
  const transactionRoot = path.join(paths.stagingRoot, randomUUID())
  await ensureExclusiveDirectory(paths.root, transactionRoot)
  await writeExclusiveFile(transactionRoot, path.join(transactionRoot, 'archive.sspack'), bytes)
  await fsyncDirectory(transactionRoot)
  return transactionRoot
}

async function materialiseVerifiedPack(
  archiveBytes: Uint8Array,
  verified: VerifiedContentPack,
  request: Pick<ContentPackInstallRequest, 'source' | 'deliveryAttestation'>,
  stagingRoot: string,
  installedRoot: string,
  finalPath: string,
  hooks?: ContentPackInstallerHooks,
  policy?: ContentPackVerificationPolicy,
): Promise<void> {
  const versionRoot = path.join(stagingRoot, 'version')
  const createdDirectories = new Set<string>()
  await ensureExclusiveDirectory(stagingRoot, versionRoot, createdDirectories)
  await writeExclusiveFile(versionRoot, path.join(versionRoot, 'content', 'archive.sspack'), archiveBytes, createdDirectories)
  for (const [relativePath, bytes] of verified.files) {
    await writeExclusiveFile(versionRoot, assertContained(versionRoot, path.join(versionRoot, ...relativePath.split('/'))), bytes, createdDirectories)
  }
  await hooks?.beforeRequiredFsync?.()
  const syncedDirectories = await fsyncCreatedDirectories(createdDirectories)
  await fsyncParents(stagingRoot, versionRoot)
  await hooks?.afterRequiredFsync?.(syncedDirectories)
  await ensureExclusiveDirectory(installedRoot, path.dirname(finalPath))
  if (await existingSafeDirectory(finalPath)) {
    if (!policy) throw new Error('Content Pack verification policy is required to adopt an orphaned version')
    const orphaned = await verifyInstalledContentPackVersion({
      install_path: finalPath,
      archive_sha256: sha256(archiveBytes),
      source: request.source,
      delivery_attestation: request.deliveryAttestation,
    }, policy)
    if (canonicalJson(orphaned.manifest) !== canonicalJson(verified.manifest)) {
      throw new Error(`Content Pack immutable orphan conflicts with candidate: ${finalPath}`)
    }
    await fsyncParents(installedRoot, path.dirname(finalPath))
    return
  }
  // We remain beneath the cross-process state lock through stage, write, and rename.
  await ensureExclusiveDirectory(installedRoot, path.dirname(finalPath))
  await fs.rename(versionRoot, finalPath)
  await fsyncParents(installedRoot, path.dirname(finalPath))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The entire write operation holds the filesystem state lock. A noncooperating
 * same-user process is still outside this app-level boundary, so every write
 * uses O_NOFOLLOW/exclusive creation and revalidates ancestry before rename.
 */
export async function installContentPack(
  request: ContentPackInstallRequest,
  options: ContentPackInstallOptions = {},
): Promise<ContentPackInstallResult> {
  const paths = options.paths ?? (await import('./runtime-paths.js')).getContentPackRuntimePaths()
  // Reject unbounded input before a coordination lock can create runtime state.
  if (request.archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Content Pack archive exceeds ${MAX_ARCHIVE_BYTES} byte limit`)
  }
  return withContentPackCoordinationLock(paths, () => installContentPackLocked(request, options, paths))
}

/** Caller holds coordination → state; this avoids nested coordination locks in future bulk operations. */
export async function installContentPackLocked(
  request: ContentPackInstallRequest,
  options: ContentPackInstallOptions,
  paths: ContentPackRuntimePaths,
): Promise<ContentPackInstallResult> {
  const archiveSha = sha256(request.archiveBytes)
  if (request.expectedArchiveSha256 && request.expectedArchiveSha256 !== archiveSha) {
    await quarantineContentPackBytes(request.archiveBytes, 'sha256_mismatch', paths)
    throw new Error('Content Pack archive SHA-256 does not match the expected digest')
  }
  const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
  let verified: VerifiedContentPack
  try {
    verified = await verifyArchiveForRequest(request.archiveBytes, request, policy, options.resolveGenStudioSigningKey)
  } catch (error) {
    await quarantineContentPackBytes(request.archiveBytes, 'invalid_archive', paths)
    throw error
  }
  if ((request.expectedPackId !== undefined && verified.manifest.pack_id !== request.expectedPackId)
    || (request.expectedVersion !== undefined && verified.manifest.version !== request.expectedVersion)) {
    await quarantineContentPackBytes(request.archiveBytes, 'remote_identity_mismatch', paths)
    throw new Error('Content Pack signed manifest does not match the expected remote pack identity')
  }
  await assertContentPackAppCompatible(verified.manifest.min_app_version, options.appVersion)

  const installed = await withContentPackStateTransaction(async state => {
    let transactionRoot: string | undefined
    try {
      transactionRoot = await stageArchive(request.archiveBytes, paths)
      await options.hooks?.afterStageWrite?.()
      const packId = verified.manifest.pack_id
      const version = verified.manifest.version
      const existing = state.packs[packId]?.versions[version]
      if (existing) {
        if (existing.pending_removal) throw new Error(`Content Pack version is pending removal: ${packId}@${version}`)
        if (existing.archive_sha256 !== archiveSha) throw new Error(`Content Pack version is immutable and already has a different archive: ${packId}@${version}`)
        if (existing.recalled) throw new Error(`GenStudio recalled Content Pack version: ${packId}@${version}`)
        const verifiedExisting = await verifyInstalledContentPackVersion(existing, policy, options.resolveGenStudioSigningKey)
        if (verifiedExisting.manifest.pack_id !== packId || verifiedExisting.manifest.version !== version) throw new Error(`Content Pack immutable archive identity does not match state: ${packId}@${version}`)
        await verifiedManifestGraph(state, verified, policy, options.resolveGenStudioSigningKey)
        // The retained signed archive is the authority. Repair a stale or
        // forged cache only after proving it against the immutable archive.
        if (canonicalJson(existing.manifest) !== canonicalJson(verifiedExisting.manifest)) {
          existing.manifest = verifiedExisting.manifest
        }
        return { pack_id: packId, version, archive_sha256: archiveSha, activated: state.packs[packId].active_version === version, retained_versions: retainedVersions(state, packId) }
      }
      await verifiedManifestGraph(state, verified, policy, options.resolveGenStudioSigningKey)
      const finalPath = installedVersionPath(paths, verified.manifest)
      await options.hooks?.beforeVersionRename?.()
      await materialiseVerifiedPack(request.archiveBytes, verified, request, transactionRoot, paths.installedRoot, finalPath, options.hooks, policy)
      const pack = state.packs[packId] ?? { discovery_disabled: false, versions: {} }
      pack.versions[version] = {
        archive_sha256: archiveSha,
        installed_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        source: request.source,
        install_path: finalPath,
        manifest: verified.manifest,
        // model-drift-allow: Frozen Content Store source discriminator controls persisted delivery-attestation state.
        ...(request.source === 'genstudio-store' ? {
          delivery_attestation: ContentPackDeliveryAttestationSchema.parse(request.deliveryAttestation),
        } : {}),
      }
      if (options.activate !== false) {
        await options.hooks?.beforeActivationWrite?.()
        pack.active_version = version
      }
      state.packs[packId] = pack
      return { pack_id: packId, version, archive_sha256: archiveSha, activated: options.activate !== false, retained_versions: retainedVersions(state, packId) }
    } finally {
      if (transactionRoot) await removeTreeIfContained(paths.stagingRoot, transactionRoot)
    }
  }, paths)
  // Best effort on purpose: clearing stale evidence must never turn a
  // completed, verified install back into a failure.
  try { await releaseQuarantinedContentPackBytes(archiveSha, paths) } catch { /* the install stands regardless */ }
  return installed
}
