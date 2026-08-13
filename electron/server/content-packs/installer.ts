import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  verifyContentPackArchive,
  type ContentPackVerificationPolicy,
  type VerifiedContentPack,
} from './archive.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { findContentPackSourceRoot, installedVersionPath, resolveVerifiedPackFile, type ContentPackRuntimePaths } from './runtime-paths.js'
import { type ContentPackInstallRequest, type ContentPackInstallResult, type ContentPackInstalledVersion, type ContentPackRuntimeState } from './runtime-types.js'
import { withContentPackStateTransaction } from './state.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_QUARANTINE_REASON = 64
const SAFE_QUARANTINE_REASON = /^[a-z0-9][a-z0-9_-]{0,63}$/
const require = createRequire(import.meta.url)

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
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parsePackageVersion(raw: string, source: string): string {
  let pkg: { version?: unknown }
  try {
    pkg = JSON.parse(raw) as { version?: unknown }
  } catch (error) {
    throw new Error(`Story Studio package metadata is invalid: ${source}`, { cause: error })
  }
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`Story Studio package metadata has no exact version: ${source}`)
  }
  return pkg.version
}

export interface ContentPackVersionResolutionOptions {
  packaged?: boolean
  electronVersion?: string
  sourceContentPackRoot?: string
}

/** Work in source, compiled Electron, and packaged ASAR without relying on CJS require paths. */
export async function resolveContentPackAppVersion(options: ContentPackVersionResolutionOptions = {}): Promise<string> {
  let electronApp: { isPackaged?: boolean; getVersion?: () => string } | undefined
  try { electronApp = require('electron').app as typeof electronApp } catch { /* source/node tests have no Electron app */ }
  const packaged = options.packaged ?? electronApp?.isPackaged === true
  if (packaged) {
    const version = options.electronVersion ?? electronApp?.getVersion?.()
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Story Studio packaged app version is unavailable')
    return version
  }
  const sourceRoot = options.sourceContentPackRoot ?? findContentPackSourceRoot(path.dirname(fileURLToPath(import.meta.url)))
  const packagePath = path.resolve(sourceRoot, '..', '..', '..', 'package.json')
  return parsePackageVersion(await fs.readFile(packagePath, 'utf8'), packagePath)
}

function compareExactSemver(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
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

export async function verifyInstalledContentPackVersion(
  installed: Pick<ContentPackInstalledVersion, 'install_path' | 'archive_sha256'>,
  policy: ContentPackVerificationPolicy,
): Promise<VerifiedContentPack> {
  if (!await existingSafeDirectory(installed.install_path)) throw new Error(`Content Pack immutable version is missing on disk: ${installed.install_path}`)
  const archivePath = resolveVerifiedPackFile(installed.install_path, 'content/archive.sspack')
  const archiveBytes = await fs.readFile(archivePath)
  if (sha256(archiveBytes) !== installed.archive_sha256) throw new Error(`Content Pack immutable archive hash does not match state: ${installed.install_path}`)
  const verified = await verifyContentPackArchive(archiveBytes, policy)
  for (const [relativePath, bytes] of verified.files) {
    const target = resolveVerifiedPackFile(installed.install_path, relativePath)
    const info = await fs.lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || sha256(await fs.readFile(target)) !== sha256(bytes)) {
      throw new Error(`Content Pack immutable materialised file differs from verified archive: ${target}`)
    }
  }
  return verified
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
      const verified = await verifyInstalledContentPackVersion(installed, policy)
      if (verified.manifest.pack_id !== requiredPackId || verified.manifest.version !== requiredVersion) {
        throw new Error(`Content Pack immutable archive identity does not match state: ${key}`)
      }
      await assertContentPackAppCompatible(verified.manifest.min_app_version, appVersion)
      for (const dependency of verified.manifest.dependencies ?? []) await visit(dependency.pack_id, dependency.version)
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
): Promise<void> {
  const manifests = new Map<string, VerifiedContentPack['manifest']>()
  for (const [packId, pack] of Object.entries(state.packs)) {
    for (const [version, installed] of Object.entries(pack.versions)) {
      const verified = await verifyInstalledContentPackVersion(installed, policy)
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
  return archivePath
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
    const orphaned = await verifyInstalledContentPackVersion({ install_path: finalPath, archive_sha256: sha256(archiveBytes) }, policy)
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
  if (request.archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Content Pack archive exceeds ${MAX_ARCHIVE_BYTES} byte limit`)
  }
  const archiveSha = sha256(request.archiveBytes)
  if (request.expectedArchiveSha256 && request.expectedArchiveSha256 !== archiveSha) {
    await quarantineContentPackBytes(request.archiveBytes, 'sha256_mismatch', paths)
    throw new Error('Content Pack archive SHA-256 does not match the expected digest')
  }
  const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
  let verified: VerifiedContentPack
  try {
    verified = await verifyContentPackArchive(request.archiveBytes, policy)
  } catch (error) {
    await quarantineContentPackBytes(request.archiveBytes, 'invalid_archive', paths)
    throw error
  }
  await assertContentPackAppCompatible(verified.manifest.min_app_version, options.appVersion)

  return withContentPackStateTransaction(async state => {
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
        const verifiedExisting = await verifyInstalledContentPackVersion(existing, policy)
        if (verifiedExisting.manifest.pack_id !== packId || verifiedExisting.manifest.version !== version) throw new Error(`Content Pack immutable archive identity does not match state: ${packId}@${version}`)
        await verifiedManifestGraph(state, verified, policy)
        // The retained signed archive is the authority. Repair a stale or
        // forged cache only after proving it against the immutable archive.
        if (canonicalJson(existing.manifest) !== canonicalJson(verifiedExisting.manifest)) {
          existing.manifest = verifiedExisting.manifest
        }
        return { pack_id: packId, version, archive_sha256: archiveSha, activated: state.packs[packId].active_version === version, retained_versions: retainedVersions(state, packId) }
      }
      await verifiedManifestGraph(state, verified, policy)
      const finalPath = installedVersionPath(paths, verified.manifest)
      await options.hooks?.beforeVersionRename?.()
      await materialiseVerifiedPack(request.archiveBytes, verified, transactionRoot, paths.installedRoot, finalPath, options.hooks, policy)
      await options.hooks?.beforeActivationWrite?.()
      const pack = state.packs[packId] ?? { discovery_disabled: false, versions: {} }
      pack.versions[version] = {
        archive_sha256: archiveSha,
        installed_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        source: request.source,
        install_path: finalPath,
        manifest: verified.manifest,
      }
      pack.active_version = version
      state.packs[packId] = pack
      return { pack_id: packId, version, archive_sha256: archiveSha, activated: true, retained_versions: retainedVersions(state, packId) }
    } finally {
      if (transactionRoot) await removeTreeIfContained(paths.stagingRoot, transactionRoot)
    }
  }, paths)
}
