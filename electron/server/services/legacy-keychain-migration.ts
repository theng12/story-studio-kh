import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { writeJsonAtomic, withCrossProcessLock } from '../lib/atomic-store.js'
import { appSecretsPath, contentStoreAnchorsPath, parseV3, parseAnchorState } from './app-secrets-store.js'
import { parseProjectSecrets } from './secrets-store.js'
import { getUserDataDir, projectsRoot } from './project-manager.js'

interface MigrationGuard {
  probe(service: string, account: string, interactive: boolean): number
  delete(service: string, account: string): number
}
interface MigrationStorage { decryptString(value: Buffer): string }
interface MigrationDependencies { guard?: MigrationGuard; safeStorage?: MigrationStorage }
type Outcome = 'migrated' | 'skipped' | 'not-needed'

async function nativeDependencies(): Promise<MigrationDependencies> {
  if (!process.versions.electron || process.platform !== 'darwin') return {}
  const require = createRequire(import.meta.url)
  try { await require('electron').app.whenReady() } catch { return {} }
  let guard: MigrationGuard | undefined
  let safeStorage: MigrationStorage | undefined
  try { guard = require('../../keychain-guard.node') as MigrationGuard } catch { /* unavailable */ }
  try { safeStorage = require('electron')?.safeStorage as MigrationStorage | undefined } catch { /* plain node */ }
  return { guard, safeStorage }
}

/** The only credential path allowed to load Electron/native credential APIs. Never awaited at boot. */
export async function migrateLegacyKeychain(dependencies?: MigrationDependencies): Promise<void> {
  const marker = path.join(getUserDataDir(), 'app-secrets-migration.json')
  await withCrossProcessLock(marker, async () => {
    try { await fs.access(marker); return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    let outcome: Outcome = 'not-needed'
    const files: Array<{ file: string; parse: (raw: unknown) => unknown }> = [
      { file: appSecretsPath(), parse: parseV3 },
      { file: contentStoreAnchorsPath(), parse: parseAnchorState },
    ]
    try {
      const entries = await fs.readdir(projectsRoot(), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) files.push({ file: path.join(projectsRoot(), entry.name, 'secrets.json'), parse: parseProjectSecrets })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') outcome = 'skipped'
    }
    const legacy: Array<{ file: string; text: string; raw: Record<string, unknown>; parse: (raw: unknown) => unknown }> = []
    for (const candidate of files) {
      try {
        const text = await fs.readFile(candidate.file, 'utf8')
        const raw = JSON.parse(text)
        if (raw && typeof raw === 'object' && raw.__encrypted === true) legacy.push({ ...candidate, text, raw })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') outcome = 'skipped'
      }
    }
    let deleteStatus: number | undefined
    if (legacy.length || outcome === 'skipped') {
      outcome = 'skipped'
      const { guard, safeStorage } = dependencies ?? await nativeDependencies()
      const service = 'Story Studio KH Safe Storage'
      const account = 'Story Studio KH Key'
      try {
        // Even availability checks can initialize Electron encryption; probe before decrypting.
        if (guard && safeStorage && guard.probe(service, account, false) === 0) {
          const decoded = legacy.map(candidate => {
            if (candidate.raw.version !== 1 || typeof candidate.raw.ciphertext !== 'string'
              || !candidate.raw.ciphertext || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.raw.ciphertext)) throw new Error('Invalid legacy envelope')
            const value = candidate.parse(JSON.parse(safeStorage.decryptString(Buffer.from(candidate.raw.ciphertext, 'base64'))))
            if (!value) throw new Error('Invalid legacy payload')
            return { ...candidate, value }
          })
          for (const candidate of decoded) {
            await withCrossProcessLock(candidate.file, async () => {
              // A request may have replaced the legacy file while boot migration was pending.
              if (await fs.readFile(candidate.file, 'utf8') !== candidate.text) throw new Error('Legacy file changed')
              await writeJsonAtomic(candidate.file, candidate.value, { mode: 0o600 })
            })
          }
          if (decoded.length) outcome = 'migrated'
        }
      } catch { /* leave unreadable legacy files intact; never retry automatically */ }
      finally {
        // Cleanup is non-interactive even when decryption was refused or failed.
        if (guard) {
          try {
            const status = guard.delete(service, account)
            if (Number.isFinite(status)) deleteStatus = status
          } catch { /* native failures must never block startup */ }
        }
      }
    }
    await writeJsonAtomic(marker, {
      keychain_migration: outcome, at: new Date().toISOString(),
      ...(deleteStatus === undefined ? {} : { delete_status: deleteStatus }),
    }, { mode: 0o600 })
  })
}
