/**
 * Per-project secrets store — isolates API keys from the rest of config.
 *
 * Keys live in `{PROJECTS_ROOT}/{slug}/secrets.json` (perm 0600 on POSIX)
 * rather than being mixed into `config.json`. This gives us:
 *   - A single file to lock down, exclude from backups, or swap for keychain.
 *   - No risk of keys bleeding into config-shaped logs, diffs, or exports.
 *   - A migration hook for existing projects whose keys still live in config.
 *
 * ── Schema versions ──────────────────────────────────────────────────────
 *   v1 (legacy): flat `{ openai_api_key: "sk-...", fal_api_key: "...", ... }`
 *   v2 (current): nested, multi-account:
 *     {
 *       schema_version: 2,
 *       providers: {
 *         openai: { accounts: [{ id, label, apiKey, isDefault }] },
 *         ...
 *       }
 *     }
 *
 * `readSecrets` / `writeSecrets` still read and accept the legacy flat shape —
 * they project over v2 using each provider's default account. Account-centric
 * callers use `services/secrets-accounts.ts` which operates on v2 directly.
 *
 * This is NOT end-to-end encryption. Contents remain plaintext on disk — the
 * win here is isolation + redaction. A later pass can swap this store for a
 * `keytar`-backed implementation without changing callers.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { PROJECTS_ROOT } from './project-manager.js'
import { writeJsonAtomic, withLock, readJsonOr } from '../lib/atomic-store.js'
import { isEncryptionAvailable, encryptToBase64, decryptFromBase64 } from '../lib/safe-storage.js'

// ── Machine provenance ──────────────────────────────────────────────────────
//
// If the user manually copies a project folder between their machines (rsync,
// drag-and-drop, cp -r) instead of using the Import flow, `secrets.json`
// travels intact. safeStorage-encrypted blobs are typically inert on the new
// machine (different Keychain-derived key → decrypt fails), but:
//   - on the plaintext fallback path the file is still readable as-is, and
//   - shared iCloud Keychain configurations can in rare cases decrypt a
//     foreign blob.
//
// Either way we must NOT silently activate another machine's OAuth tokens —
// the #1 correctness hazard in the personal-multi-machine threat model is
// uploading to the wrong channel. We stamp every write with a hash derived
// from the current user + userData path (stable within a machine/account,
// distinct across machines and Apple IDs) and refuse to load a store whose
// stamp doesn't match. Missing stamp = legacy file, accepted and re-stamped
// on next write.
function computeMachineProvenance(): string {
  const username = os.userInfo().username || ''
  // PROJECTS_ROOT is `<userData>/projects`; the userData path is its parent
  // and is what Electron's `app.getPath('userData')` returns. Using it rather
  // than os.hostname() avoids the "user renames their Mac" weakness.
  const userDataPath = path.dirname(PROJECTS_ROOT)
  return createHash('sha256').update(`${username}|${userDataPath}`).digest('hex')
}

// ── Providers ────────────────────────────────────────────────────────────────

/** Canonical provider ids — one per column in secrets v2.providers. */
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

/**
 * Legacy flat-key names — still exported so `redactSecrets` and any one-shot
 * log-scrubbing code can target them. Equal to `{providerId}_api_key` for
 * every entry in `SECRET_PROVIDERS`.
 */
export const SECRET_KEYS = SECRET_PROVIDERS.map(p => `${p}_api_key` as const)
export type SecretKey = typeof SECRET_KEYS[number]

export type ProjectSecrets = Partial<Record<SecretKey, string>>

// ── v2 shape ────────────────────────────────────────────────────────────────

export interface ProviderAccount {
  id: string
  label: string
  apiKey: string
  isDefault?: boolean
}

export interface ProviderAccounts {
  accounts: ProviderAccount[]
}

export interface SecretsV2 {
  schema_version: 2
  providers: Partial<Record<ProviderId, ProviderAccounts>>
}

// ── Paths ───────────────────────────────────────────────────────────────────

function secretsPath(slug: string): string {
  return path.join(PROJECTS_ROOT, slug, 'secrets.json')
}

function configPath(slug: string): string {
  return path.join(PROJECTS_ROOT, slug, 'config.json')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function providerIdFromLegacyKey(k: string): ProviderId | null {
  if (!k.endsWith('_api_key')) return null
  const p = k.slice(0, -'_api_key'.length)
  return (SECRET_PROVIDERS as readonly string[]).includes(p) ? (p as ProviderId) : null
}

function emptyV2(): SecretsV2 {
  return { schema_version: 2, providers: {} }
}

/**
 * Ensure a v2 shape. Accepts:
 *   - an empty object (fresh project)
 *   - a v1 flat shape (legacy)
 *   - a v2 nested shape (passthrough)
 * Returns a normalised v2 without writing to disk.
 */
function normaliseToV2(raw: any): { v2: SecretsV2; migrated: boolean } {
  if (raw && typeof raw === 'object' && raw.schema_version === 2 && raw.providers) {
    return { v2: raw as SecretsV2, migrated: false }
  }
  const v2 = emptyV2()
  if (!raw || typeof raw !== 'object') return { v2, migrated: false }

  let touched = false
  for (const [k, v] of Object.entries(raw)) {
    const pid = providerIdFromLegacyKey(k)
    if (!pid) continue
    if (typeof v !== 'string' || !v) continue
    v2.providers[pid] = {
      accounts: [{ id: randomUUID(), label: 'Default', apiKey: v, isDefault: true }],
    }
    touched = true
  }
  return { v2, migrated: touched }
}

/** Project a v2 store to the legacy flat `{provider}_api_key` shape. */
function projectToLegacy(v2: SecretsV2): ProjectSecrets {
  const out: ProjectSecrets = {}
  for (const pid of SECRET_PROVIDERS) {
    const bucket = v2.providers[pid]
    if (!bucket?.accounts?.length) continue
    const def = bucket.accounts.find(a => a.isDefault) ?? bucket.accounts[0]
    if (def?.apiKey) out[`${pid}_api_key` as SecretKey] = def.apiKey
  }
  return out
}

function ensureOneDefault(bucket: ProviderAccounts): void {
  if (!bucket.accounts.length) return
  const defaults = bucket.accounts.filter(a => a.isDefault)
  if (defaults.length === 1) return
  if (defaults.length === 0) {
    bucket.accounts[0].isDefault = true
    return
  }
  // More than one default — keep the first, demote the rest.
  let kept = false
  for (const a of bucket.accounts) {
    if (a.isDefault) {
      if (kept) a.isDefault = false
      else kept = true
    }
  }
}

// ── Core v2 read/write ──────────────────────────────────────────────────────

// On-disk envelope for encrypted secrets. The file is still JSON (so mode
// 0600 and atomic rename semantics carry over unchanged), but the provider
// data is base64-encoded ciphertext produced by Electron safeStorage.
//
// Legacy files written before encryption landed are unwrapped plaintext
// SecretsV2 objects; the reader accepts both shapes and the next write
// upgrades to the encrypted shape. See lib/safe-storage.ts for the why.
interface EncryptedEnvelope {
  __encrypted: true
  version: 1
  ciphertext: string
  /** sha256 of `${username}|${userData}` — see computeMachineProvenance. */
  _provenance?: string
}

function isEnvelope(raw: any): raw is EncryptedEnvelope {
  return !!raw && typeof raw === 'object' && raw.__encrypted === true
    && typeof raw.ciphertext === 'string'
}

/**
 * Inspect a raw on-disk secrets file and decide whether it belongs to this
 * machine. Legacy files (no `_provenance` field) are treated as `legacy` —
 * readers accept them, and the next write will stamp the current machine's
 * hash without invalidating anything.
 */
function classifyProvenance(raw: any): 'match' | 'legacy' | 'foreign' {
  if (!raw || typeof raw !== 'object') return 'legacy'
  const stored = typeof raw._provenance === 'string' ? raw._provenance : null
  if (!stored) return 'legacy'
  return stored === computeMachineProvenance() ? 'match' : 'foreign'
}

async function readSecretsFile(filePath: string): Promise<any> {
  const raw = await readJsonOr<any>(filePath, null)
  if (!raw) return null

  // If the file carries a provenance stamp that doesn't match this machine,
  // refuse to load. The user either moved the project folder manually, or
  // two machines share an unusual Keychain configuration — either way the
  // OAuth tokens inside were minted for a different channel context and
  // must not be silently activated here. The UI surfaces this via
  // `getSecretsProvenanceStatus` and offers a Clear-and-reset action.
  const provenance = classifyProvenance(raw)
  if (provenance === 'foreign') {
    console.warn(
      `[secrets] ignoring foreign-provenance secrets.json at ${filePath} — ` +
      `the file was written by a different machine. Reset via Settings → API Keys.`
    )
    return null
  }

  if (!isEnvelope(raw)) {
    // Plaintext shape — strip the envelope-level `_provenance` sibling
    // before handing the bag to normaliseToV2 so SecretsV2 stays clean.
    const { _provenance, ...rest } = raw as Record<string, any>
    return rest
  }
  try {
    const plain = decryptFromBase64(raw.ciphertext)
    return JSON.parse(plain)
  } catch (e: any) {
    // Decryption failed — most likely the file was restored from a backup
    // onto a new machine, so the Keychain-derived key no longer matches.
    // Treat the store as empty rather than crash the app; the user can
    // re-enter their keys. Throwing here would make the whole app
    // un-openable until the file is manually deleted.
    return null
  }
}

async function writeSecretsFile(filePath: string, value: SecretsV2): Promise<void> {
  const provenance = computeMachineProvenance()
  const plain = JSON.stringify(value)
  if (isEncryptionAvailable()) {
    const envelope: EncryptedEnvelope = {
      __encrypted: true,
      version: 1,
      ciphertext: encryptToBase64(plain),
      _provenance: provenance,
    }
    await writeJsonAtomic(filePath, envelope, { mode: 0o600 })
    return
  }
  // Fallback: test env under tsx, or a machine with no keychain. 0600 is
  // still enforced by writeJsonAtomic, so file-mode protection carries on.
  // `_provenance` rides as a top-level sibling of the v2 shape; readers
  // strip it before handing the bag off to normaliseToV2.
  await writeJsonAtomic(filePath, { ...value, _provenance: provenance }, { mode: 0o600 })
}

/**
 * Read the raw v2 secrets store, migrating from v1 on-disk if needed.
 * Internal — account-centric callers in `secrets-accounts.ts` use this.
 */
export async function readSecretsV2(slug: string): Promise<SecretsV2> {
  const p = secretsPath(slug)
  const raw = await readSecretsFile(p)
  const { v2, migrated } = normaliseToV2(raw)
  // Rewrite when: (a) we migrated v1→v2 in memory, (b) the file is v2 but
  // stored plaintext (upgrade to encrypted envelope on next write), or
  // (c) the schema_version is missing. Best-effort — a failed write here
  // shouldn't break the caller.
  const needsRewrite =
    migrated ||
    (raw && !raw.schema_version && !isEnvelope(raw)) ||
    (raw && !isEnvelope(raw) && isEncryptionAvailable())
  if (needsRewrite) {
    await withLock(p, async () => {
      await writeSecretsFile(p, v2)
    }).catch(() => {})
  }
  return v2
}

/** Atomically mutate the v2 store. The callback receives a mutable copy. */
export async function writeSecretsV2(
  slug: string,
  mutate: (v2: SecretsV2) => void | Promise<void>,
): Promise<SecretsV2> {
  const p = secretsPath(slug)
  let result: SecretsV2 = emptyV2()
  await withLock(p, async () => {
    const raw = await readSecretsFile(p)
    const { v2 } = normaliseToV2(raw)
    await mutate(v2)
    // Normalise default invariant per provider before writing.
    for (const pid of SECRET_PROVIDERS) {
      const bucket = v2.providers[pid]
      if (!bucket) continue
      if (!bucket.accounts.length) {
        delete v2.providers[pid]
        continue
      }
      ensureOneDefault(bucket)
    }
    await writeSecretsFile(p, v2)
    result = v2
  })
  return result
}

// ── Provenance status (surfaced to UI) ──────────────────────────────────────

export interface SecretsProvenanceStatus {
  /** True iff a secrets.json file exists on disk for this project. */
  present: boolean
  /**
   * True iff the file's _provenance stamp exists and does NOT match the
   * current machine. The store is treated as empty while `foreign` is true;
   * the UI should warn the user and offer a Clear-and-reset action.
   */
  foreign: boolean
}

/**
 * Inspect a project's secrets.json without going through the decryption
 * path so we can tell the UI "this file was written by a different machine"
 * without fully loading (and ignoring) the foreign data.
 */
export async function getSecretsProvenanceStatus(slug: string): Promise<SecretsProvenanceStatus> {
  const p = secretsPath(slug)
  const raw = await readJsonOr<any>(p, null)
  if (!raw) return { present: false, foreign: false }
  return {
    present: true,
    foreign: classifyProvenance(raw) === 'foreign',
  }
}

/**
 * Overwrite a project's secrets.json with an empty v2 store stamped with
 * the current machine's provenance. Used by the "Clear and reset" UI action
 * on a foreign-provenance banner, and by the Import flow to shed secrets
 * from a transferred project folder.
 */
export async function resetSecretsForCurrentMachine(slug: string): Promise<void> {
  const p = secretsPath(slug)
  await withLock(p, async () => {
    await writeSecretsFile(p, emptyV2())
  })
}

// ── Legacy-shape compat shim ────────────────────────────────────────────────

export async function readSecrets(slug: string): Promise<ProjectSecrets> {
  const v2 = await readSecretsV2(slug)
  return projectToLegacy(v2)
}

/**
 * Merge a legacy-shape `patch` into the current store. Only known keys are
 * accepted. For each `{provider}_api_key` field:
 *   - A non-empty string upserts the provider's DEFAULT account (updating the
 *     existing default's key, or creating a 'Default' account if none).
 *   - An empty string (`''`) clears the default account. Remaining accounts
 *     keep their order and the next one in the list is promoted to default.
 *   - `undefined` leaves that provider untouched.
 *
 * Multi-account callers should use `services/secrets-accounts.ts` directly.
 */
export async function writeSecrets(slug: string, patch: ProjectSecrets): Promise<void> {
  await writeSecretsV2(slug, (v2) => {
    for (const key of SECRET_KEYS) {
      if (!(key in patch)) continue
      const value = patch[key]
      if (value === undefined) continue
      const pid = providerIdFromLegacyKey(key)!
      const bucket = v2.providers[pid] ?? { accounts: [] }

      if (value === '') {
        // Clear default account only; leave any other accounts alone.
        const i = bucket.accounts.findIndex(a => a.isDefault)
        if (i >= 0) bucket.accounts.splice(i, 1)
        if (bucket.accounts.length) {
          bucket.accounts[0].isDefault = true
          v2.providers[pid] = bucket
        } else {
          delete v2.providers[pid]
        }
        continue
      }

      // Non-empty: update existing default, or create one.
      const def = bucket.accounts.find(a => a.isDefault)
      if (def) {
        def.apiKey = value
      } else {
        bucket.accounts.unshift({
          id: randomUUID(),
          label: 'Default',
          apiKey: value,
          isDefault: true,
        })
      }
      v2.providers[pid] = bucket
    }
  })
}

// ── Legacy config.json → secrets.json migration (unchanged behaviour) ───────

/**
 * One-shot migration: if a project's config.json still carries API keys
 * (older projects pre-secrets-store), move them to secrets.json and strip
 * them from config. Idempotent — a no-op once keys are already isolated.
 */
export async function migrateSecretsFromConfig(slug: string): Promise<void> {
  const cp = configPath(slug)
  if (!existsSync(cp)) return
  await withLock(cp, async () => {
    let config: any
    try {
      config = JSON.parse(await fs.readFile(cp, 'utf-8'))
    } catch {
      return // corrupt/missing — leave alone
    }

    const patch: ProjectSecrets = {}
    let configChanged = false
    for (const k of SECRET_KEYS) {
      if (k in config) {
        if (typeof config[k] === 'string' && config[k]) patch[k] = config[k]
        delete config[k]
        configChanged = true
      }
    }

    if (!configChanged) return
    if (Object.keys(patch).length > 0) await writeSecrets(slug, patch)
    await writeJsonAtomic(cp, config)
  })
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * Scrub secret-looking values from an arbitrary object tree. Use before
 * writing anything derived from user config into logs or HTTP responses.
 *
 * Redacts:
 *   - Legacy `{provider}_api_key` fields (non-empty strings).
 *   - Any `apiKey` property anywhere in the tree (v2 accounts).
 *
 * Empty strings are left untouched so "has this key?" checks still read
 * correctly (e.g. for UI `has_*` flags computed off the legacy shape).
 */
export function redactSecrets<T>(value: T): T {
  return redactInternal(value, new WeakSet()) as T
}

function redactInternal(value: any, seen: WeakSet<object>): any {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) return value.map(v => redactInternal(v, seen))

  const out: Record<string, any> = {}
  for (const k of Object.keys(value)) {
    const v = value[k]
    const isLegacyKey = (SECRET_KEYS as readonly string[]).includes(k)
    const isAccountKey = k === 'apiKey'
    if ((isLegacyKey || isAccountKey) && typeof v === 'string' && v) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = redactInternal(v, seen)
    }
  }
  return out
}
