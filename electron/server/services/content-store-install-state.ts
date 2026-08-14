import type { GenStudioContentRelease } from '../lib/genstudio-content-store.js'
import { verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { readContentPackState } from '../content-packs/state.js'

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
