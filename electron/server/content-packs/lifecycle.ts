import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ContentPackVerificationPolicy } from './archive.js'
import {
  verifyInstalledContentPackClosure,
  verifyInstalledContentPackVersion,
} from './installer.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { installedVersionPath, type ContentPackRuntimePaths } from './runtime-paths.js'
import type { ContentPackInstalledVersion, ContentPackRuntimeState } from './runtime-types.js'
import { getContentPackRuntimePaths } from './runtime-paths.js'
import { readContentPackState, withContentPackStateTransaction } from './state.js'

const DIRECTORY_MODE = 0o700

export interface ContentPackLifecycleHooks {
  /** Test seam: runs after the durable pending-removal checkpoint, before any move. */
  beforeRemovalDelete?: () => Promise<void>
}

export interface ContentPackLifecycleOptions {
  paths?: ContentPackRuntimePaths
  policy?: ContentPackVerificationPolicy
  /** Test-only seam; production resolves the app version from its own package resource. */
  appVersion?: string
  hooks?: ContentPackLifecycleHooks
}

export interface ContentPackRollbackResult {
  pack_id: string
  from: string
  to: string
}

function compareSemverDescending(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index]
  }
  return 0
}

function assertContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Content Pack lifecycle path must be contained by its root')
  }
  return resolvedCandidate
}

function safeSegment(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) && !/^[a-z0-9]$/.test(value)) {
    throw new Error('Content Pack lifecycle path is invalid')
  }
  return value
}

async function lstatDirectory(target: string): Promise<boolean> {
  try {
    const info = await fs.lstat(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Content Pack lifecycle directory is unsafe: ${target}`)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertSafeDirectoryChain(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = assertContained(resolvedRoot, target)
  if (!await lstatDirectory(resolvedRoot)) throw new Error(`Content Pack lifecycle root is missing: ${resolvedRoot}`)
  let cursor = resolvedRoot
  for (const segment of path.relative(resolvedRoot, resolvedTarget).split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Content Pack lifecycle path must be contained by its root')
    cursor = path.join(cursor, segment)
    if (!await lstatDirectory(cursor)) throw new Error(`Content Pack lifecycle directory is missing: ${cursor}`)
  }
}

async function ensureSafeDirectory(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  assertContained(resolvedRoot, resolvedTarget)
  let cursor = resolvedRoot
  let created = false
  try { await fs.mkdir(cursor, { mode: DIRECTORY_MODE }); created = true } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!await lstatDirectory(cursor)) throw new Error(`Content Pack lifecycle root is unsafe: ${cursor}`)
  void created
  for (const segment of path.relative(resolvedRoot, resolvedTarget).split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Content Pack lifecycle path must be contained by its root')
    cursor = path.join(cursor, segment)
    try { await fs.mkdir(cursor, { mode: DIRECTORY_MODE }) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!await lstatDirectory(cursor)) throw new Error(`Content Pack lifecycle directory is unsafe: ${cursor}`)
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function removalRoot(paths: ContentPackRuntimePaths): string {
  return path.join(paths.root, '.removing')
}

function removalPath(paths: ContentPackRuntimePaths, installed: ContentPackInstalledVersion): string {
  const pending = installed.pending_removal
  if (!pending) throw new Error('Content Pack version is not pending removal')
  const manifest = installed.manifest
  return assertContained(removalRoot(paths), path.join(
    removalRoot(paths),
    safeSegment(manifest.publisher_id),
    safeSegment(manifest.pack_id),
    `${safeSegment(manifest.version)}-${pending.operation_id}`,
  ))
}

function getInstalled(state: ContentPackRuntimeState, packId: string, version: string): ContentPackInstalledVersion {
  const installed = state.packs[packId]?.versions[version]
  if (!installed) throw new Error(`Content Pack version is not installed: ${packId}@${version}`)
  return installed
}

function assertNotPending(packId: string, version: string, installed: ContentPackInstalledVersion): void {
  if (installed.pending_removal) throw new Error(`Content Pack version is pending removal: ${packId}@${version}`)
}

async function resolvePolicy(options: ContentPackLifecycleOptions): Promise<ContentPackVerificationPolicy> {
  return options.policy ?? getFirstPartyContentPackVerificationPolicy()
}

/** Returns installed versions that use this exact version as a dependency, from signed local truth. */
async function findInstalledDependents(
  state: ContentPackRuntimeState,
  packId: string,
  version: string,
  policy: ContentPackVerificationPolicy,
): Promise<string[]> {
  const dependents: string[] = []
  for (const [otherPackId, pack] of Object.entries(state.packs)) {
    for (const [otherVersion, installed] of Object.entries(pack.versions)) {
      if (otherPackId === packId && otherVersion === version) continue
      if (installed.pending_removal) continue
      let verified
      try {
        verified = await verifyInstalledContentPackVersion(installed, policy)
      } catch {
        // A corrupt retained version is not evidence that removing one of its
        // declared dependencies is safe. Preserve the candidate instead.
        return [`unverified:${otherPackId}@${otherVersion}`]
      }
      if ((verified.manifest.dependencies ?? []).some(dependency => dependency.pack_id === packId && dependency.version === version)) {
        dependents.push(`${otherPackId}@${otherVersion}`)
      }
    }
  }
  return dependents.sort()
}

async function removePendingVersion(
  paths: ContentPackRuntimePaths,
  installed: ContentPackInstalledVersion,
): Promise<void> {
  const expectedInstallPath = installedVersionPath(paths, installed.manifest)
  if (installed.install_path !== expectedInstallPath) throw new Error('Content Pack state install path does not match manifest')
  const tombstone = removalPath(paths, installed)
  const tombstoneExists = await lstatDirectory(tombstone)
  const sourceExists = await lstatDirectory(installed.install_path)
  if (sourceExists && tombstoneExists) throw new Error('Content Pack pending removal has both source and tombstone directories')
  if (sourceExists) {
    await assertSafeDirectoryChain(paths.installedRoot, installed.install_path)
    await ensureSafeDirectory(paths.root, path.dirname(tombstone))
    await fs.rename(installed.install_path, tombstone)
    await fsyncDirectory(path.dirname(installed.install_path))
    await fsyncDirectory(path.dirname(tombstone))
  } else if (!tombstoneExists) {
    throw new Error(`Content Pack pending removal source is missing: ${installed.install_path}`)
  }
  await assertSafeDirectoryChain(removalRoot(paths), tombstone)
  await fs.rm(tombstone, { recursive: true, force: false, maxRetries: 2 })
  await fsyncDirectory(path.dirname(tombstone))
}

export async function setContentPackDiscoveryDisabled(
  packId: string,
  disabled: boolean,
  options: ContentPackLifecycleOptions = {},
): Promise<void> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  await withContentPackStateTransaction(state => {
    const pack = state.packs[packId]
    if (!pack) throw new Error(`Content Pack is not installed: ${packId}`)
    pack.discovery_disabled = disabled
  }, paths)
}

export async function rollbackContentPack(
  packId: string,
  version: string,
  options: ContentPackLifecycleOptions = {},
): Promise<void> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const policy = await resolvePolicy(options)
  await withContentPackStateTransaction(async state => {
    const installed = getInstalled(state, packId, version)
    assertNotPending(packId, version, installed)
    await verifyInstalledContentPackClosure(state, packId, version, policy, options.appVersion)
    state.packs[packId].active_version = version
  }, paths)
}

export async function uninstallContentPackVersion(
  packId: string,
  version: string,
  isPinned: (packId: string, version: string) => Promise<string[]>,
  options: ContentPackLifecycleOptions = {},
): Promise<void> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const policy = await resolvePolicy(options)
  await withContentPackStateTransaction(async (state, transaction) => {
    const pack = state.packs[packId]
    const installed = getInstalled(state, packId, version)
    if (pack.active_version === version) throw new Error(`Content Pack active version cannot be uninstalled: ${packId}@${version}`)
    const projectSlugs = [...new Set(await isPinned(packId, version))].sort()
    if (projectSlugs.length) throw new Error(`Content Pack version is pinned by projects: ${projectSlugs.join(', ')}`)
    const dependents = await findInstalledDependents(state, packId, version, policy)
    if (dependents.length) throw new Error(`Content Pack version is required by installed dependent packs: ${dependents.join(', ')}`)
    if (!installed.pending_removal) {
      installed.pending_removal = { operation_id: randomUUID(), started_at: new Date().toISOString() }
      await transaction.checkpoint()
    }
    await options.hooks?.beforeRemovalDelete?.()
    await removePendingVersion(paths, installed)
    delete pack.versions[version]
    if (Object.keys(pack.versions).length === 0) delete state.packs[packId]
  }, paths)
}

/**
 * Keep the active version, its two prior semantic versions, every pinned
 * version, and every version an installed pack depends on. Invalid candidates
 * are retained: pruning is never an opportunity to erase evidence.
 */
export async function pruneUnpinnedContentPackVersions(
  packId: string,
  isPinned: (packId: string, version: string) => Promise<boolean>,
  options: ContentPackLifecycleOptions = {},
): Promise<string[]> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const policy = await resolvePolicy(options)
  const snapshot = await readContentPackState(paths)
  const pack = snapshot.packs[packId]
  if (!pack) throw new Error(`Content Pack is not installed: ${packId}`)
  const ordered = Object.keys(pack.versions).sort(compareSemverDescending)
  const activeIndex = pack.active_version ? ordered.indexOf(pack.active_version) : -1
  const keep = new Set(activeIndex >= 0 ? ordered.slice(activeIndex, activeIndex + 3) : [])
  const removed: string[] = []
  for (const version of ordered) {
    if (keep.has(version)) continue
    if (await isPinned(packId, version)) continue
    const current = await readContentPackState(paths)
    const candidate = current.packs[packId]?.versions[version]
    if (!candidate || candidate.pending_removal || current.packs[packId]?.active_version === version) continue
    const dependents = await findInstalledDependents(current, packId, version, policy)
    if (dependents.length) continue
    try {
      await verifyInstalledContentPackVersion(candidate, policy)
    } catch {
      continue
    }
    try {
      await uninstallContentPackVersion(packId, version, async () => (await isPinned(packId, version)) ? ['pinned-during-prune'] : [], options)
      removed.push(version)
    } catch (error) {
      // A pin/dependency race is a normal skip. Filesystem deletion errors are
      // intentionally surfaced so the durable pending-removal guard is visible.
      if (/pinned|dependent|active/i.test(error instanceof Error ? error.message : String(error))) continue
      throw error
    }
  }
  return removed
}

/**
 * Local-only recovery used by boot verification: if active bytes no longer
 * match their signed archive, select the newest healthy retained version. No
 * request, credential, or catalogue fallback is involved.
 */
export async function recoverContentPackActiveVersion(
  packId: string,
  options: ContentPackLifecycleOptions = {},
): Promise<ContentPackRollbackResult | null> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const policy = await resolvePolicy(options)
  return withContentPackStateTransaction(async state => {
    const pack = state.packs[packId]
    if (!pack?.active_version) return null
    const from = pack.active_version
    try {
      await verifyInstalledContentPackClosure(state, packId, from, policy, options.appVersion)
      return null
    } catch {
      // Search only local retained immutable versions. A failed candidate is
      // left untouched, and a missing healthy fallback leaves state unchanged.
    }
    for (const candidate of Object.keys(pack.versions).filter(version => version !== from).sort(compareSemverDescending)) {
      if (pack.versions[candidate].pending_removal) continue
      try {
        await verifyInstalledContentPackClosure(state, packId, candidate, policy, options.appVersion)
      } catch {
        continue
      }
      pack.active_version = candidate
      return { pack_id: packId, from, to: candidate }
    }
    throw new Error(`Content Pack active version is corrupt and has no healthy retained rollback: ${packId}@${from}`)
  }, paths)
}
