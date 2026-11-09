/** OS-protected credentials; unavailable encrypted stores must never become empty stores. */
import { createRequire } from 'module'
import { CREDENTIALS_UNAVAILABLE, CredentialsUnavailableError, KeychainAccess } from './keychain-access.js'
import type { CredentialsStatus, KeychainGuard } from './keychain-access.js'

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

const require = createRequire(import.meta.url)
let cached: ElectronSafeStorage | null | undefined
let keychainAccess: KeychainAccess | undefined
let moduleUnavailable = false

function getSafeStorage(): ElectronSafeStorage | null {
  if (cached === undefined) {
    try {
      const electron = require('electron') as { safeStorage?: ElectronSafeStorage; app?: { getName(): string } }
      cached = electron?.safeStorage ?? null
      if (process.platform === 'darwin' && process.versions.electron && cached) {
        keychainAccess = new KeychainAccess(
          () => require('../../keychain-guard.node') as KeychainGuard,
          electron.app!.getName(),
        )
      }
    } catch { cached = null }
    moduleUnavailable = process.platform === 'darwin' && !!process.versions.electron && !cached
  }
  if (moduleUnavailable) throw new CredentialsUnavailableError('module-unavailable')
  return cached
}

/** Explicit development opt-out; existing ciphertext still refuses reads and mutations. */
export function shouldUseKeychain(): boolean {
  if (process.env.STORY_STUDIO_FORCE_KEYCHAIN === '1') return true
  if (process.env.STORY_STUDIO_DISABLE_KEYCHAIN === '1') return false
  return true
}

export function getCredentialsStatus(): CredentialsStatus {
  if (moduleUnavailable) return { state: 'unavailable', code: 'module-unavailable', message: CREDENTIALS_UNAVAILABLE }
  return keychainAccess?.getStatus() ?? { state: 'not-checked', message: '' }
}

function availableStorage(): ElectronSafeStorage {
  const ss = getSafeStorage()
  if (!ss) throw new Error('safeStorage not available (not running in Electron?)')
  if (!ss.isEncryptionAvailable()) throw new CredentialsUnavailableError('encryption-unavailable')
  return ss
}

export function isEncryptionAvailable(): boolean {
  if (!shouldUseKeychain()) return false
  const ss = getSafeStorage()
  if (!ss) return false
  // On macOS, refuse before Chromium can cache a denied initialization or show a modal.
  if (keychainAccess) return keychainAccess.run(() => !!availableStorage())
  try { return ss.isEncryptionAvailable() } catch { return false }
}

function withEncryption<T>(operation: (ss: ElectronSafeStorage) => T): T {
  if (!shouldUseKeychain()) throw new Error('safeStorage disabled (personal-use opt-out)')
  getSafeStorage()
  const run = () => operation(availableStorage())
  return keychainAccess ? keychainAccess.run(run) : run()
}

// A failed encrypt or decrypt is reported as its own finite stage, never as the
// native message (which may name the reason, the item, or nothing useful at all).
export function encryptToBase64(plaintext: string): string {
  return withEncryption((ss) => {
    try { return ss.encryptString(plaintext).toString('base64') }
    catch { throw new CredentialsUnavailableError('encrypt-failed') }
  })
}

export function decryptFromBase64(b64: string): string {
  return withEncryption((ss) => {
    try { return ss.decryptString(Buffer.from(b64, 'base64')) }
    catch { throw new CredentialsUnavailableError('decrypt-failed') }
  })
}

/**
 * Native menu only: a person at the Mac explicitly requests the Keychain dialog.
 * Reports success only when noninteractive reads work AND the key really
 * round-trips a decrypt — availability alone never proved that.
 * Returns a boolean instead of throwing so the menu cannot echo a raw
 * diagnostic (or a path, or native text) back to the screen.
 */
export function unlockCredentials(verify?: () => void): boolean {
  try {
    if (!shouldUseKeychain()) return false
    getSafeStorage()
    if (!keychainAccess) return false
    return keychainAccess.unlock(() => {
      availableStorage()
      // A fresh install has no stored ciphertext yet; a round-trip proves the
      // key decrypts either way. Callers pass a store-level check on top.
      const probe = 'story-studio-unlock-probe'
      if (decryptFromBase64(encryptToBase64(probe)) !== probe) {
        throw new CredentialsUnavailableError('decrypt-failed')
      }
      verify?.()
    })
  } catch {
    // Coded configuration/module failures only; status (or module-unavailable
    // above) already carries the finite reason.
    return false
  }
}
