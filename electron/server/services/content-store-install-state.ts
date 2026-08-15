import type { GenStudioContentRelease } from '../lib/genstudio-content-store.js'
import { verifyInstalledContentPackClosure, verifyInstalledContentPackVersion } from '../content-packs/installer.js'
import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { readContentPackState } from '../content-packs/state.js'
import { mutateContentPackState } from '../content-packs/state.js'

export type ContentStoreInstallState =
  | 'not_installed'
  | 'installing_dependencies'
  | 'installed_current'
  | 'installed_other_version'
  | 'update_available'
  | 'incomplete'
  | 'unavailable'

export interface ContentStoreClosureState {
  installState: ContentStoreInstallState
  installedVersion: string | null
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
}

export type ContentStoreLocalInstallState = ContentStoreClosureState

/**
 * Receipt restore/overview recall facts are account-and-origin scoped. Keep
 * the immutable bytes and ownership evidence, but durably remove usability.
 */
export async function reconcileContentStoreRecalledVersions(input: {
  accountId: string
  origin: string
  recalledVersionsByFamily: ReadonlyMap<string, readonly string[]>
}): Promise<void> {
  await mutateContentPackState(state => {
    for (const pack of Object.values(state.packs)) {
      for (const [version, installed] of Object.entries(pack.versions)) {
        const evidence = installed.source === 'genstudio-store' ? installed.delivery_attestation : undefined
        if (!evidence || evidence.account_id !== input.accountId || evidence.genstudio_origin !== input.origin
          || !input.recalledVersionsByFamily.get(evidence.entitlement_family)?.includes(version)) continue
        installed.recalled = {
          observed_at: new Date().toISOString(), account_id: input.accountId, genstudio_origin: input.origin,
        }
        if (pack.active_version === version) delete pack.active_version
      }
    }
  })
}

export async function resolveContentStoreInstallStates(
  releases: ReadonlyArray<GenStudioContentRelease | null>,
): Promise<ContentStoreClosureState[]> {
  const state = await readContentPackState()
  const policy = await getFirstPartyContentPackVerificationPolicy()
  const verified = new Map<string, Promise<boolean>>()
  const verify = (packId: string, version: string): Promise<boolean> => {
    const key = `${packId}@${version}`
    const existing = verified.get(key)
    if (existing) return existing
    const result = verifyInstalledContentPackClosure(state, packId, version, policy)
      .then(() => true, () => false)
    verified.set(key, result)
    return result
  }

  const closure = new Map<string, Promise<ContentStoreClosureState>>()
  const inspectClosure = (packId: string, version: string): Promise<ContentStoreClosureState> => {
    const key = `${packId}@${version}`
    const existing = closure.get(key)
    if (existing) return existing
    const result = (async (): Promise<ContentStoreClosureState> => {
      if (await verify(packId, version)) return { installState: 'installed_current', installedVersion: version, missingDependencies: [] }

      const missing = new Map<string, { packId: string; version: string; reason: string }>()
      const inspected = new Set<string>()
      const add = (dependencyPackId: string, dependencyVersion: string, reason: string): void => {
        const dependencyKey = `${dependencyPackId}@${dependencyVersion}`
        if (missing.size < 100 && !missing.has(dependencyKey)) missing.set(dependencyKey, {
          packId: dependencyPackId, version: dependencyVersion, reason,
        })
      }
      const visit = async (dependencyPackId: string, dependencyVersion: string): Promise<void> => {
        const dependencyKey = `${dependencyPackId}@${dependencyVersion}`
        if (inspected.has(dependencyKey) || missing.size >= 100) return
        inspected.add(dependencyKey)
        const installed = state.packs[dependencyPackId]?.versions[dependencyVersion]
        if (!installed) return add(dependencyPackId, dependencyVersion, 'not installed')
        if (installed.recalled) return add(dependencyPackId, dependencyVersion, 'recalled')
        if (installed.pending_removal) return add(dependencyPackId, dependencyVersion, 'pending removal')
        try {
          const verifiedVersion = await verifyInstalledContentPackVersion(installed, policy)
          for (const dependency of verifiedVersion.manifest.dependencies ?? []) await visit(dependency.pack_id, dependency.version)
        } catch {
          add(dependencyPackId, dependencyVersion, 'cannot be verified')
        }
      }
      const root = state.packs[packId]?.versions[version]
      if (root) {
        try {
          const verifiedRoot = await verifyInstalledContentPackVersion(root, policy)
          for (const dependency of verifiedRoot.manifest.dependencies ?? []) await visit(dependency.pack_id, dependency.version)
        } catch {
          // Root corruption is truthfully incomplete, but does not invent a dependency.
        }
      }
      return { installState: 'incomplete', installedVersion: version, missingDependencies: [...missing.values()] }
    })()
    closure.set(key, result)
    return result
  }

  return Promise.all(releases.map(async release => {
    if (!release) return { installState: 'unavailable', installedVersion: null, missingDependencies: [] }
    const pack = state.packs[release.packId]
    if (!pack) {
      return { installState: release.archiveAvailable ? 'not_installed' : 'unavailable', installedVersion: null, missingDependencies: [] }
    }
    const installedExact = pack.versions[release.version]
    if (installedExact?.archive_sha256 === release.archiveSha256) {
      const exactClosure = await inspectClosure(release.packId, release.version)
      if (exactClosure.installState === 'incomplete') return exactClosure
      return {
        installState: pack.active_version === release.version ? 'installed_current' : 'installed_other_version',
        installedVersion: pack.active_version ?? release.version,
        missingDependencies: [],
      }
    }
    const activeVersion = pack.active_version
    if (activeVersion) {
      const activeClosure = await inspectClosure(release.packId, activeVersion)
      if (activeClosure.installState === 'incomplete') return activeClosure
      return {
        installState: release.archiveAvailable ? 'update_available' : 'installed_other_version',
        installedVersion: activeVersion,
        missingDependencies: [],
      }
    }
    return {
      installState: release.archiveAvailable ? 'not_installed' : 'unavailable',
      installedVersion: null,
      missingDependencies: [],
    }
  }))
}
