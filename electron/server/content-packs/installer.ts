import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  verifyContentPackArchive,
  type ContentPackVerificationPolicy,
  type VerifiedContentPack,
} from './archive.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { installedVersionPath, resolveVerifiedPackFile, type ContentPackRuntimePaths } from './runtime-paths.js'
import { type ContentPackInstallRequest, type ContentPackInstallResult, type ContentPackRuntimeState } from './runtime-types.js'
import { mutateContentPackState } from './state.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'

const require = createRequire(import.meta.url)
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_QUARANTINE_REASON = 64
const SAFE_QUARANTINE_REASON = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface ContentPackInstallerHooks {
  afterStageWrite?: () => Promise<void>
  beforeVersionRename?: () => Promise<void>
  beforeActivationWrite?: () => Promise<void>
}

export interface ContentPackInstallOptions {
  paths?: ContentPackRuntimePaths
  policy?: ContentPackVerificationPolicy
  hooks?: ContentPackInstallerHooks
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function contentPackVersion(): string {
  const pkg = require('../../../package.json') as { version?: unknown }
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error('Story Studio version is unavailable for Content Pack compatibility checks')
  }
  return pkg.version
}

function compareExactSemver(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function assertAppCompatible(minimum: string): void {
  const installed = contentPackVersion()
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

async function ensureExclusiveDirectory(root: string, target: string): Promise<void> {
  assertWriteIsolatedInTests(root, 'content-pack-installer')
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Content Pack write path must be contained by its root')
  let cursor = resolvedRoot
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Content Pack write path must be contained by its root')
    try {
      await fs.mkdir(cursor, { mode: DIRECTORY_MODE })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await fs.lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Content Pack write directory is unsafe: ${cursor}`)
    cursor = path.join(cursor, segment)
  }
  try {
    await fs.mkdir(cursor, { mode: DIRECTORY_MODE })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await fs.lstat(cursor)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Content Pack write directory is unsafe: ${cursor}`)
}

async function assertAbsentOrSafeDirectory(target: string): Promise<boolean> {
  try {
    const info = await fs.lstat(target)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Content Pack immutable version path is unsafe: ${target}`)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeExclusiveFile(root: string, target: string, bytes: Uint8Array): Promise<void> {
  assertContained(root, target)
  await ensureExclusiveDirectory(root, path.dirname(target))
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

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeTreeIfContained(root: string, candidate: string): Promise<void> {
  assertContained(root, candidate)
  await fs.rm(candidate, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
}

function nodeKey(packId: string, version: string): string {
  return `${packId}@${version}`
}

function assertVerifiedDependencies(state: ContentPackRuntimeState, candidate: VerifiedContentPack): void {
  const manifests = new Map<string, VerifiedContentPack['manifest']>()
  for (const [packId, pack] of Object.entries(state.packs)) {
    for (const [version, installed] of Object.entries(pack.versions)) manifests.set(nodeKey(packId, version), installed.manifest)
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

/** Store untrusted submitted bytes without retaining user/request details or exception text. */
export async function quarantineContentPackBytes(
  bytes: Uint8Array,
  reason: string,
  paths: ContentPackRuntimePaths,
): Promise<string> {
  const digest = sha256(bytes)
  const archivePath = path.join(paths.quarantineRoot, `${digest}.sspack`)
  const sidecarPath = `${archivePath}.json`
  await ensureExclusiveDirectory(paths.root, paths.quarantineRoot)
  try {
    await writeExclusiveFile(paths.quarantineRoot, archivePath, bytes)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  try {
    await writeExclusiveFile(paths.quarantineRoot, sidecarPath, new TextEncoder().encode(`${JSON.stringify({ code: failureCode(reason) })}\n`))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return archivePath
}

async function stageArchive(bytes: Uint8Array, paths: ContentPackRuntimePaths): Promise<string> {
  const transactionRoot = path.join(paths.stagingRoot, randomUUID())
  await ensureExclusiveDirectory(paths.root, transactionRoot)
  await writeExclusiveFile(transactionRoot, path.join(transactionRoot, 'archive.sspack'), bytes)
  return transactionRoot
}

async function assertExistingVersionMatches(finalPath: string, verified: VerifiedContentPack): Promise<void> {
  if (!await assertAbsentOrSafeDirectory(finalPath)) throw new Error(`Content Pack immutable version is missing on disk: ${finalPath}`)
  for (const [relativePath, bytes] of verified.files) {
    const target = resolveVerifiedPackFile(finalPath, relativePath)
    const info = await fs.lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || sha256(await fs.readFile(target)) !== sha256(bytes)) {
      throw new Error(`Content Pack immutable version already exists with different verified bytes: ${finalPath}`)
    }
  }
}

async function materialiseVerifiedPack(
  verified: VerifiedContentPack,
  stagingRoot: string,
  installedRoot: string,
  finalPath: string,
): Promise<void> {
  const versionRoot = path.join(stagingRoot, 'version')
  await ensureExclusiveDirectory(stagingRoot, versionRoot)
  for (const [relativePath, bytes] of verified.files) {
    await writeExclusiveFile(versionRoot, assertContained(versionRoot, path.join(versionRoot, ...relativePath.split('/'))), bytes)
  }
  await fsyncDirectory(versionRoot).catch(() => {})
  await ensureExclusiveDirectory(installedRoot, path.dirname(finalPath))
  if (await assertAbsentOrSafeDirectory(finalPath)) {
    await assertExistingVersionMatches(finalPath, verified)
    // A power loss after the immutable rename but before state activation is
    // recoverable: the next identical import adopts the already verified tree.
    return
  }
  // Revalidate all parent paths immediately before publishing the immutable directory.
  await ensureExclusiveDirectory(installedRoot, path.dirname(finalPath))
  await fs.rename(versionRoot, finalPath)
  await fsyncDirectory(path.dirname(finalPath)).catch(() => {})
}

/**
 * Verify first, materialise under a UUID staging directory, then activate only
 * inside the cross-process runtime-state lock. The renderer never receives a
 * filesystem path or a policy input.
 */
export async function installContentPack(
  request: ContentPackInstallRequest,
  options: ContentPackInstallOptions = {},
): Promise<ContentPackInstallResult> {
  const paths = options.paths ?? (await import('./runtime-paths.js')).getContentPackRuntimePaths()
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
  assertAppCompatible(verified.manifest.min_app_version)

  let transactionRoot: string | undefined
  try {
    transactionRoot = await stageArchive(request.archiveBytes, paths)
    await options.hooks?.afterStageWrite?.()
    return await mutateContentPackState(async state => {
      const packId = verified.manifest.pack_id
      const version = verified.manifest.version
      const existing = state.packs[packId]?.versions[version]
      if (existing) {
        if (existing.archive_sha256 !== archiveSha) throw new Error(`Content Pack version is immutable and already has a different archive: ${packId}@${version}`)
        await assertExistingVersionMatches(existing.install_path, verified)
        return { pack_id: packId, version, archive_sha256: archiveSha, activated: state.packs[packId].active_version === version, retained_versions: retainedVersions(state, packId) }
      }
      assertVerifiedDependencies(state, verified)
      const finalPath = installedVersionPath(paths, verified.manifest)
      await options.hooks?.beforeVersionRename?.()
      await materialiseVerifiedPack(verified, transactionRoot!, paths.installedRoot, finalPath)
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
    }, paths)
  } finally {
    if (transactionRoot) await removeTreeIfContained(paths.stagingRoot, transactionRoot)
  }
}
