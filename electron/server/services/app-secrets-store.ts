/**
 * App-level secrets store.
 *
 * One file per Mac at `<userData>/app-secrets.json` (mode 0600, encrypted via
 * Electron safeStorage by default. The owner-only plaintext fallback is used
 * only when the OS encryption service is unavailable or explicitly disabled
 * for development/recovery; see lib/safe-storage.ts.
 *
 * Replaces the per-project `secrets.json` model. Project folders may live
 * in iCloud Drive across multiple Macs, so secrets stored inside them got
 * synced and produced "credentials came from a different machine" warnings
 * on every device switch. App-level state lives in userData (never synced),
 * so each Mac has its own keys and the cross-machine warning is gone.
 *
 * Schema (v3):
 *   {
 *     schema_version: 3,
 *     providers: {
 *       genstudio:  { apiKey: '...' },
 *       ...
 *     }
 *   }
 *
 * Single key per provider — no multi-account support. (Personal-use; if a
 * future need ever justifies it, add an `accounts` array; readers and
 * writers are small enough to migrate.)
 */
import fs from 'fs/promises'
import path from 'path'
import { writeJsonAtomic, withLock, readJsonOr } from '../lib/atomic-store.js'
import { isEncryptionAvailable, encryptToBase64, decryptFromBase64 } from '../lib/safe-storage.js'
import { registerSecretForRedaction } from '../lib/redact-secrets.js'
import { getUserDataDir } from './project-manager.js'

export const APP_SECRETS_SCHEMA_VERSION = 3 as const

export const SECRET_PROVIDERS = [
  // GenStudio KH is the single generation credential.
  'genstudio',
  // Non-generation integrations remain independent from GenStudio.
  'google',
] as const
export type ProviderId = typeof SECRET_PROVIDERS[number]

export interface AppSecretsV3 {
  schema_version: typeof APP_SECRETS_SCHEMA_VERSION
  // `userSet` marks a value the user explicitly saved (vs a default that an
  // older app version carried into storage). Explicitly-saved values are
  // NEVER rewritten by the legacy-default migration — see getApiKey. This
  // is what makes the per-machine local-modal URLs (voicestudio/imagestudio)
  // fully user-controlled: whatever you Save is what the app uses.
  providers: Partial<Record<ProviderId, { apiKey: string; userSet?: boolean }>>
  /** OS-protected, append-only public-key anchors for offline Store receipts. */
  contentStoreKeyAnchors?: ContentStoreKeyAnchor[]
}

export interface ContentStoreKeyAnchor {
  origin: string
  account_id: string
  content_account_id: string
  keys: Array<{ key_id: string; public_key_base64: string }>
}

interface EncryptedEnvelope {
  __encrypted: true
  version: 1
  ciphertext: string
}

// The ordinary app-secret store intentionally supports a legacy plaintext
// fallback. Receipt anchors do not: they are the independent integrity
// boundary. Tests inject this seam explicitly because node:test has no OS
// keychain; no environment variable can enable it in a packaged build.
let contentStoreAnchorPlaintextTestSeam = false

export function setContentStoreAnchorPlaintextTestSeamForTests(enabled: boolean): void {
  contentStoreAnchorPlaintextTestSeam = enabled
}

function isEnvelope(raw: any): raw is EncryptedEnvelope {
  return !!raw && typeof raw === 'object' && raw.__encrypted === true
    && typeof raw.ciphertext === 'string'
}

function emptyV3(): AppSecretsV3 {
  return { schema_version: APP_SECRETS_SCHEMA_VERSION, providers: {} }
}

function isKnownProvider(p: string): p is ProviderId {
  return (SECRET_PROVIDERS as readonly string[]).includes(p)
}

/**
 * Path is `<userData>/app-secrets.json`. Honours STORY_STUDIO_DATA_DIR for
 * tests via `getUserDataDir()`.
 */
export function appSecretsPath(): string {
  return path.join(getUserDataDir(), 'app-secrets.json')
}

async function readFileRaw(filePath: string): Promise<any> {
  return readJsonOr<any>(filePath, null)
}

interface UnwrapResult {
  v3: AppSecretsV3
  /**
   * True iff the on-disk file was an encrypted envelope we couldn't
   * decrypt on this machine. Callers that mutate (writeAppSecrets) use
   * this to sidecar-rename the unreadable blob before overwriting, so
   * the keys aren't silently lost if keychain access is later restored.
   */
  hadUndecryptableEnvelope: boolean
}

function unwrapPayload(raw: any): UnwrapResult {
  if (raw == null) return { v3: emptyV3(), hadUndecryptableEnvelope: false }
  if (isEnvelope(raw)) {
    try {
      const plain = decryptFromBase64(raw.ciphertext)
      const parsed = JSON.parse(plain)
      return { v3: normaliseV3(parsed), hadUndecryptableEnvelope: false }
    } catch {
      // Cannot decrypt on this machine. Treat as empty rather than
      // throwing — the user can re-enter keys via the app-level
      // Settings page. We surface `hadUndecryptableEnvelope: true` so
      // the writer can preserve the original blob (sidecar rename)
      // before overwriting; otherwise a single PUT after a keychain
      // change would silently destroy the user's still-recoverable
      // keys.
      return { v3: emptyV3(), hadUndecryptableEnvelope: true }
    }
  }
  return { v3: normaliseV3(raw), hadUndecryptableEnvelope: false }
}

function normaliseV3(raw: any): AppSecretsV3 {
  const out = emptyV3()
  if (!raw || typeof raw !== 'object') return out
  const providers = raw.providers
  if (providers && typeof providers === 'object') {
    for (const [k, v] of Object.entries(providers)) {
      if (!isKnownProvider(k)) continue
      const apiKey = typeof (v as any)?.apiKey === 'string' ? (v as any).apiKey : ''
      // Preserve the `userSet` marker (an explicit Save) so getApiKey's
      // "explicit value wins" rule survives the read/normalise round-trip.
      const userSet = (v as any)?.userSet === true
      if (apiKey) {
        registerSecretForRedaction(apiKey)
        out.providers[k] = userSet ? { apiKey, userSet: true } : { apiKey }
      }
    }
  }
  if (Array.isArray(raw.contentStoreKeyAnchors)) {
    const anchors: ContentStoreKeyAnchor[] = []
    for (const value of raw.contentStoreKeyAnchors.slice(0, 20)) {
      if (!value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      if (typeof row.origin !== 'string' || typeof row.account_id !== 'string' || typeof row.content_account_id !== 'string'
        || !Array.isArray(row.keys) || row.keys.length === 0 || row.keys.length > 100) continue
      const keys = row.keys.filter((key): key is { key_id: string; public_key_base64: string } => !!key && typeof key === 'object'
        && typeof (key as Record<string, unknown>).key_id === 'string' && typeof (key as Record<string, unknown>).public_key_base64 === 'string')
      if (keys.length !== row.keys.length || new Set(keys.map(key => key.key_id)).size !== keys.length) continue
      anchors.push({ origin: row.origin, account_id: row.account_id, content_account_id: row.content_account_id, keys })
    }
    if (anchors.length) out.contentStoreKeyAnchors = anchors
  }
  return out
}

async function writeRaw(filePath: string, value: AppSecretsV3): Promise<void> {
  const plain = JSON.stringify(value)
  if (isEncryptionAvailable()) {
    const envelope: EncryptedEnvelope = {
      __encrypted: true,
      version: 1,
      ciphertext: encryptToBase64(plain),
    }
    await writeJsonAtomic(filePath, envelope, { mode: 0o600 })
    return
  }
  await writeJsonAtomic(filePath, value, { mode: 0o600 })
}

/** Read the app-level secrets. Returns an empty v3 store if missing/unreadable. */
export async function readAppSecrets(): Promise<AppSecretsV3> {
  const filePath = appSecretsPath()
  const raw = await readFileRaw(filePath)
  return unwrapPayload(raw).v3
}

/** Atomically mutate the app-level secrets store. */
export async function writeAppSecrets(
  mutate: (v3: AppSecretsV3) => void | Promise<void>,
): Promise<AppSecretsV3> {
  const filePath = appSecretsPath()
  let result = emptyV3()
  await withLock(filePath, async () => {
    const raw = await readFileRaw(filePath)
    const { v3, hadUndecryptableEnvelope } = unwrapPayload(raw)
    await mutate(v3)
    // Drop providers with empty keys.
    for (const pid of SECRET_PROVIDERS) {
      const bucket = v3.providers[pid]
      if (bucket && !bucket.apiKey) delete v3.providers[pid]
    }
    try { await fs.mkdir(path.dirname(filePath), { recursive: true }) } catch { /* race-safe */ }
    // If we're about to overwrite an envelope we couldn't decrypt on
    // this machine, sidecar-rename it first. The keychain identity
    // might become available again later (eg the user signs back into
    // the macOS account that wrote the original file), at which point
    // the backup is the only path back to those keys.
    if (hadUndecryptableEnvelope) {
      try {
        const backup = `${filePath}.bak.${Date.now()}`
        await fs.rename(filePath, backup)
        if (process.env.NODE_ENV !== 'test') {
          console.warn(`[app-secrets] preserved undecryptable envelope at ${backup} before overwrite`)
        }
      } catch { /* best-effort */ }
      // Keep only the most recent N sidecar backups so they don't
      // accumulate forever if someone toggles keychain mode repeatedly.
      await pruneOldBackups(filePath).catch(() => {})
    }
    await writeRaw(filePath, v3)
    result = v3
  })
  return result
}

function decodeContentStoreAnchorState(raw: unknown, allowPlaintextMigration: boolean): AppSecretsV3 {
  if (raw == null) return emptyV3()
  if (isEnvelope(raw)) {
    try { return normaliseV3(JSON.parse(decryptFromBase64(raw.ciphertext))) } catch {
      throw new Error('Content Store key anchor safeStorage envelope is undecryptable or tampered')
    }
  }
  if (contentStoreAnchorPlaintextTestSeam) return normaliseV3(raw)
  if (allowPlaintextMigration) {
    const migrated = normaliseV3(raw)
    // A plaintext anchor never has provenance. Preserve unrelated legacy
    // secrets solely so a successful online revalidation can migrate them.
    delete migrated.contentStoreKeyAnchors
    return migrated
  }
  throw new Error('Content Store key anchor is not protected by a safeStorage envelope')
}

async function mutateContentStoreAnchorState(
  mutate: (state: AppSecretsV3) => void | Promise<void>,
): Promise<void> {
  const filePath = appSecretsPath()
  await withLock(filePath, async () => {
    const raw = await readFileRaw(filePath)
    const state = decodeContentStoreAnchorState(raw, true)
    await mutate(state)
    try { await fs.mkdir(path.dirname(filePath), { recursive: true }) } catch { /* race-safe */ }
    if (!contentStoreAnchorPlaintextTestSeam && !isEncryptionAvailable()) {
      throw new Error('Content Store key anchor requires available OS safeStorage')
    }
    await writeRaw(filePath, state)
  })
}

/** Insert-only OS-protected key mapping; a named GenStudio key can never repoint. */
export async function recordContentStoreKeyAnchor(anchor: ContentStoreKeyAnchor): Promise<void> {
  if (!anchor.origin || !anchor.account_id || !anchor.content_account_id || !anchor.keys.length || anchor.keys.length > 100) {
    throw new Error('GenStudio Content Store key anchor is invalid')
  }
  await mutateContentStoreAnchorState(state => {
    const anchors = state.contentStoreKeyAnchors ?? []
    const existing = anchors.find(candidate => candidate.origin === anchor.origin
      && candidate.account_id === anchor.account_id && candidate.content_account_id === anchor.content_account_id)
    if (!existing) {
      if (anchors.length >= 20) throw new Error('GenStudio Content Store key-anchor capacity reached')
      anchors.push({ ...anchor, keys: anchor.keys.map(key => ({ ...key })) })
      state.contentStoreKeyAnchors = anchors
      return
    }
    for (const key of anchor.keys) {
      const pinned = existing.keys.find(candidate => candidate.key_id === key.key_id)
      if (pinned && pinned.public_key_base64 !== key.public_key_base64) {
        throw new Error(`GenStudio Content Store signing key ${key.key_id} was repointed in the OS key anchor`)
      }
      if (!pinned) existing.keys.push({ ...key })
    }
  })
}

/** Returns only the OS-protected mapping for one exact Store account/origin. */
export async function readContentStoreKeyAnchor(input: {
  origin: string
  account_id: string
  content_account_id: string
}): Promise<ContentStoreKeyAnchor | null> {
  const raw = await readFileRaw(appSecretsPath())
  if (raw == null) return null
  const anchors = decodeContentStoreAnchorState(raw, false).contentStoreKeyAnchors ?? []
  const found = anchors.find(anchor => anchor.origin === input.origin
    && anchor.account_id === input.account_id && anchor.content_account_id === input.content_account_id)
  return found ? { ...found, keys: found.keys.map(key => ({ ...key })) } : null
}

/** Maximum sidecar backups (`app-secrets.json.bak.<ts>`) to retain. */
const MAX_BACKUPS = 3

async function pruneOldBackups(filePath: string): Promise<void> {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const prefix = `${base}.bak.`
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch { return }
  const backups = entries.filter((name) => name.startsWith(prefix))
  if (backups.length <= MAX_BACKUPS) return
  // Sort by mtime descending — oldest fall off the end.
  const stamped = await Promise.all(
    backups.map(async (name) => {
      const p = path.join(dir, name)
      try {
        const st = await fs.stat(p)
        return { p, mtimeMs: st.mtimeMs }
      } catch {
        return { p, mtimeMs: 0 }
      }
    }),
  )
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const e of stamped.slice(MAX_BACKUPS)) {
    await fs.rm(e.p, { force: true }).catch(() => { /* best-effort */ })
  }
}

export async function getApiKey(providerId: string): Promise<string> {
  if (!isKnownProvider(providerId)) return ''
  const v3 = await readAppSecrets()
  const entry = v3.providers[providerId]
  const stored = entry?.apiKey ?? ''
  // v1.0.206 — an explicitly-saved value is authoritative and is NEVER
  // rewritten. This is the fix for "I saved m1 but it keeps using m4": the
  // legacy-default migration below used to override the user's saved local-
  // modal URL because that URL had once been a shipped default. Now any
  // value the user Saved (userSet) is returned verbatim.
  if (entry?.userSet) return stored
  // Legacy migration only for values that were never explicitly saved —
  // i.e. a stale default an older app version carried into storage. Only
  // the dead Tailscale-IP defaults remain in scope (see migrateLegacyDefault);
  // `.local` hostnames are legitimate per-machine choices and are left alone.
  return migrateLegacyDefault(providerId, stored)
}

/**
 * v1.0.158+ — rewrite stored URLs that match any pre-current default
 * for either local modal so existing installs migrate cleanly without
 * the user clearing-and-re-saving in Settings. User-typed URLs (any
 * shape other than a listed legacy default) are left alone so a
 * deliberate Tailscale IP / custom hostname isn't silently overwritten.
 *
 * Lives in the secrets store (not the client libs) to avoid a circular
 * import — both clients already depend on this module.
 *
 * History of the migration targets:
 *   voicestudio:
 *     v1.0.149-v1.0.157  http://100.120.246.10:47870           (Tailscale IP)
 *     v1.0.158           http://theng-macmini-m1.local:47870   (M1 Bonjour)
 *     v1.0.159+          http://theng-macmini-m4.local:47870   (M4 Bonjour — current)
 *
 *   imagestudio:
 *     v1.0.151-v1.0.157  http://100.120.246.10:47868           (Tailscale IP)
 *     v1.0.158+          http://theng-macmini-m1.local:47868   (M1 Bonjour — current)
 *
 * The M1 stays the canonical Image Studio host even after v1.0.159 split
 * Voice Studio onto the M4 — Image generation fits comfortably in M1's
 * 8 GB unified memory while VoxCPM2 doesn't, so the user runs both
 * modals simultaneously on separate Macs.
 */
// v1.0.206 — ONLY the dead Tailscale-IP defaults remain here. `.local`
// hostnames (m1/m4) are legitimate per-machine hosts the user switches
// between — migrating one to another fought the user's explicit Save, which
// was the whole bug. Those are no longer migrated; an explicit Save wins
// regardless (see getApiKey → userSet), and the only thing the migration
// still does is upgrade the truly-unreachable original Tailscale IP.
const VOICESTUDIO_LEGACY_DEFAULTS = new Set<string>([
  'http://100.120.246.10:47870',           // v1.0.149-v1.0.157 (dead Tailscale IP)
])
const IMAGESTUDIO_LEGACY_DEFAULTS = new Set<string>([
  'http://100.120.246.10:47868',           // v1.0.151-v1.0.157 (dead Tailscale IP)
])
// v1.0.207 — local-modal defaults are now empty (no universal host), so a
// stored value matching the original dead Tailscale-IP default migrates to
// EMPTY ("unconfigured") rather than to another machine's hostname. The
// user then sees the clean empty state + setup help and enters their own URL.
function migrateLegacyDefault(providerId: string, stored: string): string {
  if (providerId === 'voicestudio' && VOICESTUDIO_LEGACY_DEFAULTS.has(stored)) return ''
  if (providerId === 'imagestudio' && IMAGESTUDIO_LEGACY_DEFAULTS.has(stored)) return ''
  return stored
}

export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
  if (!isKnownProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`)
  const trimmed = apiKey.trim()
  registerSecretForRedaction(trimmed)
  await writeAppSecrets((v3) => {
    if (!trimmed) {
      delete v3.providers[providerId]
    } else {
      v3.providers[providerId] = { apiKey: trimmed, userSet: true }
    }
  })
}

export async function clearApiKey(providerId: string): Promise<void> {
  return setApiKey(providerId, '')
}

/**
 * Frontend-friendly summary — returns a row per provider with a masked-key
 * preview, so the UI can show "configured" / "missing" without ever
 * exposing the raw key.
 */
export interface ProviderKeySummary {
  providerId: ProviderId
  hasKey: boolean
  keyMasked: string
}

function maskKey(k: string): string {
  if (!k) return ''
  // Below 12 chars: full mask. The first4+last4 form leaks too much of
  // a short key (eg an 8-char test key would be 100% exposed). Real
  // provider keys are 30+ chars, so 12 is a safe lower bound that
  // still gives identifying chars on every realistic key.
  if (k.length < 12) return '••••'
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

export async function listProviderKeys(): Promise<ProviderKeySummary[]> {
  const v3 = await readAppSecrets()
  return SECRET_PROVIDERS.map((pid) => {
    const k = v3.providers[pid]?.apiKey ?? ''
    return { providerId: pid, hasKey: !!k, keyMasked: maskKey(k) }
  })
}
