import type { GenStudioContentRelease } from '../lib/genstudio-content-store.js'
import { verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { readContentPackState } from '../content-packs/state.js'
import { mutateContentPackState } from '../content-packs/state.js'

export type ContentStoreInstallState =
  | 'not_installed'
  | 'installed_current'
  | 'installed_other_version'
  | 'update_available'
  | 'unavailable'

export interface ContentStoreLocalInstallState {
  installState: ContentStoreInstallState
  installedVersion: string | null
}

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
): Promise<ContentStoreLocalInstallState[]> {
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

  return Promise.all(releases.map(async release => {
    if (!release) return { installState: 'unavailable', installedVersion: null }
    const pack = state.packs[release.packId]
    if (!pack) {
      return { installState: release.archiveAvailable ? 'not_installed' : 'unavailable', installedVersion: null }
    }
    const installedExact = pack.versions[release.version]
    if (installedExact?.archive_sha256 === release.archiveSha256 && await verify(release.packId, release.version)) {
      return {
        installState: pack.active_version === release.version ? 'installed_current' : 'installed_other_version',
        installedVersion: pack.active_version ?? release.version,
      }
    }
    const activeVersion = pack.active_version
    if (activeVersion && await verify(release.packId, activeVersion)) {
      return {
        installState: release.archiveAvailable ? 'update_available' : 'installed_other_version',
        installedVersion: activeVersion,
      }
    }
    return {
      installState: release.archiveAvailable ? 'not_installed' : 'unavailable',
      installedVersion: null,
    }
  }))
}
