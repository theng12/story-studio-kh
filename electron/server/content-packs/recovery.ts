import fs from 'node:fs/promises'
import path from 'node:path'

import { verifyContentPackArchive, type ContentPackVerificationPolicy, type VerifiedContentPack } from './archive.js'
import { assertContentPackAppCompatible, verifyInstalledContentPackClosure, verifyInstalledContentPackVersion } from './installer.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import type { ContentPackRuntimeState } from './runtime-types.js'
import { withContentPackCoordinationLock, withContentPackStateTransaction } from './state.js'

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ContentPackRecoveryOptions {
  paths?: ContentPackRuntimePaths
  policy?: ContentPackVerificationPolicy
  /** Injectable only for main-process tests and packaged-resource probing. */
  recoveryRoot?: string
  /** Test-only seam; production checks the actual Story Studio version. */
  appVersion?: string
  now?: () => number
  /** Receives only operation identifiers and counts, never archive/document bytes. */
  report?: (message: string) => void
}

export interface ContentPackBootVerificationSummary {
  recovery_verified: number
  installed_verified: number
  rolled_back: Array<{ pack_id: string; from: string; to: string }>
  /**
   * Installed packs that had NO active version and were given one here.
   * See the adoption pass in `verifyInstalledAndRecover`.
   */
  adopted: Array<{ pack_id: string; version: string }>
  /** Invalid local archive/version count; recovery resources are never modified. */
  quarantined: number
}

function compareSemverDescending(left: string, right: string): number {
  const leftParts = left.split('.').map(part => BigInt(part))
  const rightParts = right.split('.').map(part => BigInt(part))
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? 1 : -1
  }
  return 0
}

async function resolvePolicy(options: ContentPackRecoveryOptions): Promise<ContentPackVerificationPolicy> {
  return options.policy ?? getFirstPartyContentPackVerificationPolicy()
}

function report(options: ContentPackRecoveryOptions, message: string): void {
  if (options.report) options.report(message)
  else console.warn(`[content-packs] ${message}`)
}

async function assertSafeInstalledVersionPath(paths: ContentPackRuntimePaths, installPath: string): Promise<void> {
  const root = path.resolve(paths.root)
  const target = path.resolve(installPath)
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Content Pack installed path is outside its runtime root')
  }
  let cursor = root
  for (const segment of ['.', ...relative.split(path.sep)]) {
    if (segment !== '.') cursor = path.join(cursor, segment)
    const stat = await fs.lstat(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Content Pack installed path is unsafe: ${cursor}`)
  }
}

async function assertSafeInstalledClosurePaths(
  state: ContentPackRuntimeState,
  packId: string,
  version: string,
  paths: ContentPackRuntimePaths,
  visiting = new Set<string>(),
): Promise<void> {
  const key = `${packId}@${version}`
  if (visiting.has(key)) throw new Error(`Content Pack dependency cycle detected at ${key}`)
  const installed = state.packs[packId]?.versions[version]
  if (!installed || installed.pending_removal) throw new Error(`Content Pack dependency is not retained: ${key}`)
  visiting.add(key)
  try {
    await assertSafeInstalledVersionPath(paths, installed.install_path)
    for (const dependency of installed.manifest.dependencies ?? []) {
      await assertSafeInstalledClosurePaths(state, dependency.pack_id, dependency.version, paths, visiting)
    }
  } finally {
    visiting.delete(key)
  }
}

async function recoveryArchives(recoveryRoot: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(recoveryRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const archives: string[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.sspack')) continue
    const candidate = path.join(recoveryRoot, entry.name)
    const stat = await fs.lstat(candidate)
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    archives.push(candidate)
  }
  return archives.sort((left, right) => path.basename(left).localeCompare(path.basename(right)))
}

async function scanRecoveryPacks(
  recoveryRoot: string,
  policy: ContentPackVerificationPolicy,
  options: ContentPackRecoveryOptions,
  ignoreFailures: boolean,
): Promise<{ packs: VerifiedContentPack[]; invalid: number }> {
  const packs: VerifiedContentPack[] = []
  let invalid = 0
  for (const archivePath of await recoveryArchives(recoveryRoot)) {
    try {
      const verified = await verifyContentPackArchive(await fs.readFile(archivePath), policy)
      await assertContentPackAppCompatible(verified.manifest.min_app_version, options.appVersion)
      packs.push(verified)
    } catch (error) {
      if (!ignoreFailures) throw error
      invalid += 1
      report(options, `recovery archive ignored: ${path.basename(archivePath)}`)
    }
  }
  return { packs, invalid }
}

/** Verify immutable bundled archives only; this never creates or mutates userData. */
export async function listVerifiedRecoveryPacks(options: ContentPackRecoveryOptions = {}): Promise<VerifiedContentPack[]> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const policy = await resolvePolicy(options)
  // A broken sibling archive must not make the immutable fallback catalog
  // disappear. Report only its filename and return every healthy signed pack.
  return (await scanRecoveryPacks(options.recoveryRoot ?? paths.recoveryRoot, policy, options, true)).packs
}

async function cleanupStaleStaging(
  paths: ContentPackRuntimePaths,
  now: number,
  options: ContentPackRecoveryOptions,
): Promise<number> {
  try {
    const root = await fs.lstat(paths.stagingRoot)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Content Pack staging root is unsafe: ${paths.stagingRoot}`)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(paths.stagingRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const entry of entries) {
    if (!TRANSACTION_ID.test(entry.name)) continue
    const candidate = path.join(paths.stagingRoot, entry.name)
    const stat = await fs.lstat(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs <= STAGING_MAX_AGE_MS) continue
    await fs.rm(candidate, { recursive: true, force: false, maxRetries: 2 })
    removed += 1
  }
  if (removed) report(options, `stale staging removed: ${removed}`)
  return removed
}

async function verifyInstalledAndRecover(
  state: ContentPackRuntimeState,
  paths: ContentPackRuntimePaths,
  policy: ContentPackVerificationPolicy,
  options: ContentPackRecoveryOptions,
): Promise<Pick<ContentPackBootVerificationSummary, 'installed_verified' | 'rolled_back' | 'adopted' | 'quarantined'>> {
  let installedVerified = 0
  let invalid = 0
  const rolledBack: ContentPackBootVerificationSummary['rolled_back'] = []
  const adopted: ContentPackBootVerificationSummary['adopted'] = []
  for (const [packId, pack] of Object.entries(state.packs).sort(([left], [right]) => left.localeCompare(right))) {
    for (const [version, installed] of Object.entries(pack.versions).sort(([left], [right]) => compareSemverDescending(left, right))) {
      if (installed.pending_removal) continue
      try {
        await assertSafeInstalledVersionPath(paths, installed.install_path)
        await verifyInstalledContentPackVersion(installed, policy)
        installedVerified += 1
      } catch {
        invalid += 1
        report(options, `installed archive invalid: ${packId}@${version}`)
      }
    }
    if (!pack.active_version) {
      /**
       * v1.4.44 — a pack installed with NO active version is inert, and says
       * nothing about it.
       *
       * `active_version` is what every catalog lookup keys on: the formula,
       * style and thumbnail registries all `continue` past a pack without one.
       * The Content Store keys on it too — with no active version it reports a
       * pack sitting verified on disk as "not installed", which also means a
       * newer published release can never surface as an update.
       *
       * MEASURED on the owner's own Mac, 2026-08-23: all 55 packs he installed
       * on 2026-08-16 had no active version. Every one had been unusable for a
       * week, and nine packs with a newer release published that day showed
       * nothing to update. Nothing self-healed it, because the recovery pass
       * below started by skipping exactly this case.
       *
       * Adoption is deliberately narrow: the newest retained version that is
       * neither recalled nor pending removal AND whose closure verifies under
       * the same policy the rollback path uses. A version that fails
       * verification is still never made discoverable, which is the guarantee
       * the `delete pack.active_version` below exists to keep.
       */
      for (const candidate of Object.keys(pack.versions).sort(compareSemverDescending)) {
        const retained = pack.versions[candidate]
        if (retained.pending_removal || retained.recalled) continue
        try {
          await assertSafeInstalledClosurePaths(state, packId, candidate, paths)
          await verifyInstalledContentPackClosure(state, packId, candidate, policy, options.appVersion)
        } catch {
          continue
        }
        pack.active_version = candidate
        adopted.push({ pack_id: packId, version: candidate })
        report(options, `active version adopted: ${packId}@${candidate}`)
        break
      }
      continue
    }
    const from = pack.active_version
    if (pack.versions[from]?.recalled) {
      delete pack.active_version
      report(options, `active version disabled after GenStudio recall: ${packId}@${from}`)
      continue
    }
    try {
      await assertSafeInstalledClosurePaths(state, packId, from, paths)
      await verifyInstalledContentPackClosure(state, packId, from, policy, options.appVersion)
      continue
    } catch {
      // A damaged active version is never re-downloaded at boot. Search only
      // already-retained, verified versions and leave a no-fallback state intact.
    }
    let recovered = false
    for (const candidate of Object.keys(pack.versions).filter(version => version !== from).sort(compareSemverDescending)) {
      if (pack.versions[candidate].pending_removal || pack.versions[candidate].recalled) continue
      try {
        await assertSafeInstalledClosurePaths(state, packId, candidate, paths)
        await verifyInstalledContentPackClosure(state, packId, candidate, policy, options.appVersion)
      } catch {
        continue
      }
      pack.active_version = candidate
      rolledBack.push({ pack_id: packId, from, to: candidate })
      report(options, `active version rolled back: ${packId}@${from} -> ${candidate}`)
      recovered = true
      break
    }
    if (!recovered) {
      // Preserve immutable bytes for forensic inspection, but never leave a
      // verified-bad version discoverable just because no rollback exists.
      delete pack.active_version
      report(options, `active version disabled: ${packId}@${from}`)
    }
  }
  return { installed_verified: installedVerified, rolled_back: rolledBack, adopted, quarantined: invalid }
}

/**
 * Main-process, local-only boot maintenance. It never fetches, reads secrets,
 * or imports renderer/GenStudio code. Individual corrupt archives are retained
 * as evidence and reported by ID while healthy local versions stay usable.
 */
export async function verifyContentPackRuntimeAtBoot(
  options: ContentPackRecoveryOptions = {},
): Promise<ContentPackBootVerificationSummary> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  const policy = await resolvePolicy(options)
  return withContentPackCoordinationLock(paths, async () => {
    const recovery = await scanRecoveryPacks(options.recoveryRoot ?? paths.recoveryRoot, policy, options, true)
    const summary = await withContentPackStateTransaction(async state => verifyInstalledAndRecover(state, paths, policy, options), paths)
    await cleanupStaleStaging(paths, options.now?.() ?? Date.now(), options)
    return {
      recovery_verified: recovery.packs.length,
      installed_verified: summary.installed_verified,
      rolled_back: summary.rolled_back,
      adopted: summary.adopted,
      quarantined: recovery.invalid + summary.quarantined,
    }
  })
}
