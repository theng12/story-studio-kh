import type { GenStudioContentRelease } from '../lib/genstudio-content-store.js'
import { verifyInstalledContentPackClosure, verifyInstalledContentPackVersion } from '../content-packs/installer.js'
import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackVerificationPolicy } from '../content-packs/archive.js'
import type { ContentPackInstallOptions } from '../content-packs/installer.js'
import { mutateContentPackState, withContentPackCoordinationLock, withContentPackStateSnapshot } from '../content-packs/state.js'
import { compareVersionStrings } from '../content-packs/version-order.js'

export type ContentStoreInstallState =
  | 'not_installed' | 'installed_current' | 'installed_other_version'
  | 'update_available' | 'incomplete' | 'unavailable'

export interface ContentStoreClosureState {
  installState: ContentStoreInstallState
  installedVersion: string | null
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
}

export interface ContentStoreInstalledPackState {
  packId: string
  version: string
  active: boolean
  installState: 'installed_current' | 'incomplete'
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
  productId: string
}

export interface ContentStoreInstallSnapshot {
  owned: ContentStoreClosureState[]
  installed: ContentStoreInstalledPackState[]
}

export interface ContentStoreInstallSnapshotOptions {
  /** Test-only dependency injection; production always uses the packaged policy and runtime paths. */
  paths?: ContentPackRuntimePaths
  policy?: ContentPackVerificationPolicy
  resolveSigningKey?: ContentPackInstallOptions['resolveGenStudioSigningKey']
}

export type ContentStoreLocalInstallState = ContentStoreClosureState

/** Receipt recall facts are account-and-origin scoped. Keep bytes as evidence, remove usability. */
export async function reconcileContentStoreRecalledVersions(input: {
  accountId: string
  origin: string
  recalledVersionsByFamily: ReadonlyMap<string, readonly string[]>
}): Promise<void> {
  const paths = getContentPackRuntimePaths()
  await withContentPackCoordinationLock(paths, () => mutateContentPackState(state => {
    for (const pack of Object.values(state.packs)) {
      for (const [version, installed] of Object.entries(pack.versions)) {
        // model-drift-allow: Frozen Studio Library source discriminator reads persisted delivery-attestation state.
        const evidence = installed.source === 'genstudio-store' ? installed.delivery_attestation : undefined
        if (!evidence || evidence.account_id !== input.accountId || evidence.genstudio_origin !== input.origin
          || !input.recalledVersionsByFamily.get(evidence.entitlement_family)?.includes(version)) continue
        installed.recalled = { observed_at: new Date().toISOString(), account_id: input.accountId, genstudio_origin: input.origin }
        if (pack.active_version === version) delete pack.active_version
      }
    }
  }, paths))
}

/** Reads and verifies one immutable local snapshot under coordination → state. */
export async function resolveContentStoreInstallSnapshot(
  releases: ReadonlyArray<GenStudioContentRelease | null>,
  options: ContentStoreInstallSnapshotOptions = {},
): Promise<ContentStoreInstallSnapshot> {
  const paths = options.paths ?? getContentPackRuntimePaths()
  return withContentPackCoordinationLock(paths, () => withContentPackStateSnapshot(paths, async state => {
    const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
    const cache = new Map<string, Promise<ContentStoreClosureState>>()
    const inspect = (packId: string, version: string): Promise<ContentStoreClosureState> => {
      const key = `${packId}@${version}`
      const prior = cache.get(key)
      if (prior) return prior
      const result = (async (): Promise<ContentStoreClosureState> => {
        try {
          await verifyInstalledContentPackClosure(state, packId, version, policy, undefined, options.resolveSigningKey)
          return { installState: 'installed_current', installedVersion: version, missingDependencies: [] }
        } catch {
          const missing = new Map<string, { packId: string; version: string; reason: string }>()
          const inspected = new Set<string>()
          const add = (id: string, requiredVersion: string, reason: string): void => {
            const dependencyKey = `${id}@${requiredVersion}`
            if (missing.size < 100 && !missing.has(dependencyKey)) missing.set(dependencyKey, { packId: id, version: requiredVersion, reason })
          }
          const visit = async (id: string, requiredVersion: string): Promise<void> => {
            const dependencyKey = `${id}@${requiredVersion}`
            if (inspected.has(dependencyKey) || missing.size >= 100) return
            inspected.add(dependencyKey)
            const local = state.packs[id]?.versions[requiredVersion]
            if (!local) return add(id, requiredVersion, 'not installed')
            if (local.recalled) return add(id, requiredVersion, 'recalled')
            if (local.pending_removal) return add(id, requiredVersion, 'pending removal')
            try {
              const verified = await verifyInstalledContentPackVersion(local, policy, options.resolveSigningKey)
              for (const dependency of verified.manifest.dependencies ?? []) await visit(dependency.pack_id, dependency.version)
            } catch { add(id, requiredVersion, 'cannot be verified') }
          }
          const root = state.packs[packId]?.versions[version]
          if (root) {
            try {
              const verified = await verifyInstalledContentPackVersion(root, policy, options.resolveSigningKey)
              for (const dependency of verified.manifest.dependencies ?? []) await visit(dependency.pack_id, dependency.version)
            } catch { /* a bad root is incomplete; never invent a dependency from unverified state */ }
          }
          return { installState: 'incomplete', installedVersion: version, missingDependencies: [...missing.values()] }
        }
      })()
      cache.set(key, result)
      return result
    }

    const owned = await Promise.all(releases.map(async release => {
      if (!release) return { installState: 'unavailable', installedVersion: null, missingDependencies: [] } satisfies ContentStoreClosureState
      const pack = state.packs[release.packId]
      if (!pack) return { installState: release.archiveAvailable ? 'not_installed' : 'unavailable', installedVersion: null, missingDependencies: [] } satisfies ContentStoreClosureState
      const exact = pack.versions[release.version]
      if (exact?.archive_sha256 === release.archiveSha256) {
        const closure = await inspect(release.packId, release.version)
        if (closure.installState === 'incomplete') return closure
        return { installState: pack.active_version === release.version ? 'installed_current' : 'installed_other_version', installedVersion: release.version, missingDependencies: [] } satisfies ContentStoreClosureState
      }
      const activeVersion = pack.active_version
      if (!activeVersion) return { installState: release.archiveAvailable ? 'not_installed' : 'unavailable', installedVersion: null, missingDependencies: [] } satisfies ContentStoreClosureState
      const closure = await inspect(release.packId, activeVersion)
      if (closure.installState === 'incomplete') return closure
      return { installState: release.archiveAvailable ? 'update_available' : 'installed_other_version', installedVersion: activeVersion, missingDependencies: [] } satisfies ContentStoreClosureState
    }))

    const installed: ContentStoreInstalledPackState[] = []
    for (const [packId, pack] of Object.entries(state.packs)) {
      for (const [version, local] of Object.entries(pack.versions)) {
        // model-drift-allow: Frozen Studio Library source discriminator reads persisted reconciled Store state.
        const evidence = local.source === 'genstudio-store' ? local.delivery_attestation : undefined
        if (!evidence || local.recalled || local.pending_removal) continue
        const closure = await inspect(packId, version)
        installed.push({ packId, version, active: pack.active_version === version, productId: evidence.product_id,
          installState: closure.installState === 'incomplete' ? 'incomplete' : 'installed_current',
          missingDependencies: closure.missingDependencies })
      }
    }
    // v1.4.1 — pack id stays a lexicographic sort (it is an identifier), but the
  // version tiebreaker is numeric: '1.0.10' after '1.0.9', not before '1.0.2'.
  return { owned, installed: installed.sort((left, right) => left.packId.localeCompare(right.packId) || compareVersionStrings(left.version, right.version)) }
  }))
}
