/**
 * Secrets surface — split between app-level API keys and per-project
 * upload/OAuth state.
 *
 * Why this module looks like a shim
 * ---------------------------------
 * Pre-rework, every secret lived in `<projectDir>/secrets.json` (one file
 * per project). That file synced via iCloud across the user's Macs, so
 * each device-switch produced "credentials came from a different
 * machine" warnings + a Clear-and-reset prompt. Annoying, error-prone.
 *
 * Post-rework:
 *   - Provider API keys → single app-level file at
 *     `<userData>/app-secrets.json`. One key per provider, no accounts,
 *     no provenance check. Implemented in `app-secrets-store.ts`.
 *   - YouTube OAuth tokens + OAuth client credentials → still per-project
 *     (each project has its own channel/account context), but persisted
 *     in `<projectDir>/secrets.json` *without* the foreign-provenance
 *     guard. The user reconnects on each Mac if needed; no banner.
 *
 * The historical v2 shape (`{ schema_version: 2, providers, upload?,
 * upload_oauth_client? }`) is preserved across `readSecretsV2` /
 * `writeSecretsV2` so `upload-store.ts` keeps working unchanged. On write,
 * the shim splits: the `providers` field is forwarded to the app-level
 * store, everything else stays in the per-project file. On read, the two
 * are merged back into a synthetic v2 view.
 *
 * The legacy flat-shape API (`readSecrets`, `writeSecrets`) and the
 * provenance helpers (`getSecretsProvenanceStatus`,
 * `resetSecretsForCurrentMachine`) are kept as compatibility shims so
 * existing callers compile. The provenance helpers always report
 * non-foreign now.
 */

import fs from 'fs/promises'
import path from 'path'
import { getProjectDir, projectsRoot } from './project-manager.js'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'
import {
  SECRET_PROVIDERS,
  type ProviderId,
  readAppSecrets,
  writeAppSecrets,
} from './app-secrets-store.js'

export { SECRET_PROVIDERS }
export type { ProviderId }

export const SECRET_KEYS = SECRET_PROVIDERS.map(p => `${p}_api_key` as const)
export type SecretKey = typeof SECRET_KEYS[number]

export type ProjectSecrets = Partial<Record<SecretKey, string>>

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

/** Legacy project payload parser, also used by the one-time migration. */
export function parseProjectSecrets(raw: unknown): Record<string, any> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) && !('__encrypted' in raw)
    ? raw as Record<string, any> : null
}

function projectSecretsPath(slug: string): string {
  const dir = getProjectDir(slug) || path.join(projectsRoot(), slug)
  return path.join(dir, 'secrets.json')
}

async function readProjectFile(slug: string): Promise<Record<string, any>> {
  const filePath = projectSecretsPath(slug)
  const raw = await readJsonOr<any>(filePath, null)
  if (raw == null) return {}
  if (raw?.__encrypted === true) return {}
  if (raw && typeof raw === 'object') {
    // Strip stale fields from older versions; we never want to honour
    // them again.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _provenance, schema_version: _ignored, providers: _alsoIgnored, ...rest } = raw
    return rest
  }
  return {}
}

/**
 * Write the per-project file with no internal lock. Callers MUST hold
 * `withLock(projectSecretsPath(slug), ...)` themselves — this is reachable
 * from inside that same lock during writeSecretsV2, and re-entering would
 * deadlock.
 */
async function writeProjectFileLocked(slug: string, value: Record<string, any>): Promise<void> {
  const filePath = projectSecretsPath(slug)
  if ((await readJsonOr<any>(filePath, null))?.__encrypted === true) {
    await fs.rename(filePath, `${filePath}.legacy-encrypted-${Date.now()}`)
  }
  if (Object.keys(value).length === 0) {
    // Empty state holds no user content (providers live in app-secrets.json).
    await fs.rm(filePath, { force: true })
    return
  }
  await writeJsonAtomic(filePath, value, { mode: 0o600 })
}

// ── Provider-keys split ────────────────────────────────────────────────────

function appProvidersToV2Providers(): Promise<SecretsV2['providers']> {
  return readAppSecrets().then((v3) => {
    const out: SecretsV2['providers'] = {}
    for (const pid of SECRET_PROVIDERS) {
      const k = v3.providers[pid]?.apiKey
      if (!k) continue
      out[pid] = {
        accounts: [{ id: 'default', label: 'Default', apiKey: k, isDefault: true }],
      }
    }
    return out
  })
}

function v2ProvidersToAppPatch(providers: SecretsV2['providers']): Record<ProviderId, string> {
  // For each provider, take the default account's apiKey (or first if
  // no default flag set). Empty / missing → cleared.
  const out: Partial<Record<ProviderId, string>> = {}
  for (const pid of SECRET_PROVIDERS) {
    const bucket = providers[pid]
    const def = bucket?.accounts?.find(a => a.isDefault) ?? bucket?.accounts?.[0]
    out[pid] = def?.apiKey ?? ''
  }
  return out as Record<ProviderId, string>
}

// ── Public API ──────────────────────────────────────────────────────────────

function providerIdFromLegacyKey(k: string): ProviderId | null {
  if (!k.endsWith('_api_key')) return null
  const p = k.slice(0, -'_api_key'.length)
  return (SECRET_PROVIDERS as readonly string[]).includes(p) ? (p as ProviderId) : null
}

/** Legacy flat-shape read. Slug ignored — keys are app-wide. */
export async function readSecrets(_slug: string): Promise<ProjectSecrets> {
  const v3 = await readAppSecrets()
  const out: ProjectSecrets = {}
  for (const pid of SECRET_PROVIDERS) {
    const k = v3.providers[pid]?.apiKey
    if (k) out[`${pid}_api_key` as SecretKey] = k
  }
  return out
}

/** Legacy flat-shape write. Slug ignored — keys go to the app store. */
export async function writeSecrets(_slug: string, patch: ProjectSecrets): Promise<void> {
  await writeAppSecrets((v3) => {
    for (const key of SECRET_KEYS) {
      if (!(key in patch)) continue
      const value = patch[key]
      if (value === undefined) continue
      const pid = providerIdFromLegacyKey(key)!
      if (value === '') delete v3.providers[pid]
      else v3.providers[pid] = { apiKey: value }
    }
  })
}

/**
 * Synthetic v2 view: providers come from app-level, upload/OAuth fields
 * from the per-project file. Used by `upload-store.ts` (YouTube OAuth).
 */
export async function readSecretsV2(slug: string): Promise<SecretsV2> {
  const [providers, project] = await Promise.all([
    appProvidersToV2Providers(),
    readProjectFile(slug),
  ])
  const merged: SecretsV2 = { schema_version: 2, providers }
  // Merge any non-providers fields the per-project file held (upload,
  // upload_oauth_client, future extensions).
  for (const [k, v] of Object.entries(project)) {
    (merged as any)[k] = v
  }
  return merged
}

/**
 * Mutate the synthetic v2 view, then split the result back across the
 * app-level store (providers) and the per-project file (everything else).
 */
export async function writeSecretsV2(
  slug: string,
  mutate: (v2: SecretsV2) => void | Promise<void>,
): Promise<SecretsV2> {
  const filePath = projectSecretsPath(slug)
  let result: SecretsV2 = { schema_version: 2, providers: {} }
  await withLock(filePath, async () => {
    const current = await readSecretsV2(slug)
    // Snapshot the providers BEFORE mutate so we can tell which keys
    // (if any) the caller actually changed. Most v2 callers (upload-store)
    // only touch the upload/upload_oauth_client extension fields and
    // don't intend to change provider API keys at all — without this
    // snapshot, a concurrent `setApiKey` write would be silently rolled
    // back by our split-write.
    const providersBefore = v2ProvidersToAppPatch(current.providers)
    await mutate(current)
    const providersAfter = v2ProvidersToAppPatch(current.providers)

    // Apply only the per-provider DIFF to the app-level store. Providers
    // the caller didn't touch get left as-is (preserves any concurrent
    // edits that landed during this critical section).
    const providersChanged = SECRET_PROVIDERS.some(
      (pid) => providersBefore[pid] !== providersAfter[pid],
    )
    if (providersChanged) {
      await writeAppSecrets((v3) => {
        for (const pid of SECRET_PROVIDERS) {
          if (providersBefore[pid] === providersAfter[pid]) continue
          const next = providersAfter[pid]
          if (next) v3.providers[pid] = { apiKey: next }
          else delete v3.providers[pid]
        }
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { schema_version: _v, providers: _p, ...rest } = current as any
    await writeProjectFileLocked(slug, rest)
    result = current
  })
  return result
}

// ── Provenance — retained as no-ops ────────────────────────────────────────

export interface SecretsProvenanceStatus {
  present: boolean
  foreign: boolean
  decryptFailed: boolean
}

export async function getSecretsProvenanceStatus(_slug: string): Promise<SecretsProvenanceStatus> {
  // `present` reflects the app-level store now; the warning flags are
  // permanently false because the foreign-provenance flow is retired.
  const v3 = await readAppSecrets()
  const present = Object.values(v3.providers).some((b) => !!b?.apiKey)
  return { present, foreign: false, decryptFailed: false }
}

export async function resetSecretsForCurrentMachine(_slug: string): Promise<void> {
  // No-op. Individual provider keys can be cleared from the app-level
  // Settings page.
}

// ── Legacy config.json → app secrets one-shot migrator ──────────────────────

// ── Redaction helper (sanitise before logging/serialisation) ────────────────

const REDACTED = '[REDACTED]'

export function redactSecrets<T>(input: T): T {
  if (input == null || typeof input !== 'object') return input
  return walk(input as any) as T
}

function walk(node: any): any {
  if (Array.isArray(node)) return node.map(walk)
  if (!node || typeof node !== 'object') return node
  const out: any = {}
  for (const [k, v] of Object.entries(node)) {
    if (k.endsWith('_api_key') && typeof v === 'string') {
      out[k] = v ? REDACTED : ''
      continue
    }
    if (k === 'apiKey' && typeof v === 'string') {
      out[k] = v ? REDACTED : ''
      continue
    }
    out[k] = walk(v)
  }
  return out
}
