/**
 * App-level secrets store.
 *
 * One file per Mac at `<userData>/app-secrets.json` (mode 0600, encrypted via
 * Electron safeStorage when keychain is enabled — personal-use builds run
 * plaintext-with-0600 by default; see lib/safe-storage.ts).
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
 *       openai:     { apiKey: '...' },
 *       anthropic:  { apiKey: '...' },
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
import { getUserDataDir } from './project-manager.js'

export const APP_SECRETS_SCHEMA_VERSION = 3 as const

export const SECRET_PROVIDERS = [
  'kie',
  'fal',
  'openai',
  'anthropic',
  'genaipro',
  'elevenlabs',
  'google',
] as const
export type ProviderId = typeof SECRET_PROVIDERS[number]

export interface AppSecretsV3 {
  schema_version: typeof APP_SECRETS_SCHEMA_VERSION
  providers: Partial<Record<ProviderId, { apiKey: string }>>
}

interface EncryptedEnvelope {
  __encrypted: true
  version: 1
  ciphertext: string
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
      if (apiKey) out.providers[k] = { apiKey }
    }
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
  return v3.providers[providerId]?.apiKey ?? ''
}

export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
  if (!isKnownProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`)
  const trimmed = apiKey.trim()
  await writeAppSecrets((v3) => {
    if (!trimmed) {
      delete v3.providers[providerId]
    } else {
      v3.providers[providerId] = { apiKey: trimmed }
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
