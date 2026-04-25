/**
 * Electron safeStorage wrapper with a plaintext fallback.
 *
 * Threat it addresses: §5.7 of the security audit — `secrets.json` is stored
 * plaintext on disk at 0600. Time Machine / iCloud / OneDrive back it up
 * (often to off-machine storage). A restore onto a different machine — or a
 * leaked backup — exposes every provider API key in clear text.
 *
 * safeStorage encrypts with a key derived from the user's login session (on
 * macOS: Keychain; on Windows: DPAPI; on Linux: libsecret / gnome-keyring).
 * The ciphertext is tied to the machine + user, so a backup that lands
 * anywhere else is useless even if the file itself is intact.
 *
 * Fallback: in non-Electron environments (tests run under tsx, CI without
 * a graphical session) `safeStorage` may be absent or report
 * `isEncryptionAvailable() === false`. In those cases we return the payload
 * unchanged — callers must continue to rely on the 0600 file mode for
 * protection. This keeps the test suite working without a mock Electron
 * runtime, and keeps the production path encrypted.
 */

import { createRequire } from 'module'

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

function loadSafeStorage(): ElectronSafeStorage | null {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as { safeStorage?: ElectronSafeStorage }
    return electron?.safeStorage ?? null
  } catch {
    return null
  }
}

// Cache the module handle but re-check availability each call — availability
// depends on `app.whenReady()` having fired and on the OS-level keychain
// being reachable, which is a runtime state, not a module-load state.
let cached: ElectronSafeStorage | null | undefined

function getSafeStorage(): ElectronSafeStorage | null {
  if (cached === undefined) cached = loadSafeStorage()
  return cached
}

export function isEncryptionAvailable(): boolean {
  const ss = getSafeStorage()
  if (!ss) return false
  try {
    return ss.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Encrypt a string using Electron's safeStorage. Returns base64. Throws if
 * encryption is not available — callers that want a plaintext fallback must
 * check `isEncryptionAvailable()` first.
 */
export function encryptToBase64(plaintext: string): string {
  const ss = getSafeStorage()
  if (!ss) throw new Error('safeStorage not available (not running in Electron?)')
  if (!ss.isEncryptionAvailable()) throw new Error('safeStorage reports encryption unavailable')
  return ss.encryptString(plaintext).toString('base64')
}

/**
 * Decrypt a base64-encoded ciphertext produced by `encryptToBase64`.
 * Throws if safeStorage is unavailable or the ciphertext is corrupt.
 */
export function decryptFromBase64(b64: string): string {
  const ss = getSafeStorage()
  if (!ss) throw new Error('safeStorage not available (not running in Electron?)')
  if (!ss.isEncryptionAvailable()) throw new Error('safeStorage reports encryption unavailable')
  return ss.decryptString(Buffer.from(b64, 'base64'))
}
