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
 *
 * ── Personal-use opt-out ──────────────────────────────────────────────────
 * Ad-hoc signed builds (no Apple Developer ID) get a fresh code signature
 * on every rebuild. macOS treats each rebuild as a *new app* and prompts
 * for keychain access ("Story Studio KH wants to use your confidential
 * information stored in your keychain") — the user can't avoid the dialog
 * because the previous version's grant doesn't transfer.
 *
 * For personal-use builds where the threat model is just "my Mac running
 * my app", the 0600 file mode is sufficient. The keychain layer adds
 * protection mostly against off-machine backup leakage, which doesn't
 * apply when the secrets file never leaves the machine in the first
 * place (it lives in userData, never iCloud-synced).
 *
 * Default: safeStorage is OFF. Override with `STORY_STUDIO_FORCE_KEYCHAIN=1`
 * if you have a real Developer ID Application certificate and want the
 * extra defense-in-depth.
 *
 * If a previously-encrypted file becomes undecryptable on this machine
 * (eg the keychain identity changed after an app rebuild), the readers
 * treat the store as empty rather than throwing. The user re-enters
 * keys at app-level Settings and the next write replaces the unreadable
 * blob. No banner, no Clear-and-reset workflow.
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

/**
 * Personal-use opt-out: when this returns false, every safeStorage probe
 * short-circuits to "unavailable" — no `isEncryptionAvailable()` call is
 * made on the underlying API, so macOS never receives a keychain query
 * and never prompts the user. New writes go through the plaintext-with-
 * 0600 fallback (still provenance-stamped). See file header for rationale.
 */
function shouldUseKeychain(): boolean {
  if (process.env.STORY_STUDIO_FORCE_KEYCHAIN === '1') return true
  if (process.env.STORY_STUDIO_DISABLE_KEYCHAIN === '1') return false
  // Default: OFF for personal-use ad-hoc-signed builds.
  return false
}

export function isEncryptionAvailable(): boolean {
  if (!shouldUseKeychain()) return false
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
 *
 * Honours the personal-use opt-out: when keychain is disabled, throws
 * without ever calling into safeStorage so macOS doesn't get a
 * keychain-access request.
 */
export function encryptToBase64(plaintext: string): string {
  if (!shouldUseKeychain()) throw new Error('safeStorage disabled (personal-use opt-out)')
  const ss = getSafeStorage()
  if (!ss) throw new Error('safeStorage not available (not running in Electron?)')
  if (!ss.isEncryptionAvailable()) throw new Error('safeStorage reports encryption unavailable')
  return ss.encryptString(plaintext).toString('base64')
}

/**
 * Decrypt a base64-encoded ciphertext produced by `encryptToBase64`.
 * Throws if safeStorage is unavailable or the ciphertext is corrupt.
 *
 * Honours the personal-use opt-out: when keychain is disabled, throws
 * without ever calling into safeStorage. Existing encrypted files surface
 * via the "Secrets were stamped on a different machine — reset" banner.
 */
export function decryptFromBase64(b64: string): string {
  if (!shouldUseKeychain()) throw new Error('safeStorage disabled (personal-use opt-out)')
  const ss = getSafeStorage()
  if (!ss) throw new Error('safeStorage not available (not running in Electron?)')
  if (!ss.isEncryptionAvailable()) throw new Error('safeStorage reports encryption unavailable')
  return ss.decryptString(Buffer.from(b64, 'base64'))
}
