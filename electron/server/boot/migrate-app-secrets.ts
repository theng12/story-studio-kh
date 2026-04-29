/**
 * One-shot migration: lift provider API keys out of every per-project
 * `secrets.json` into the app-level store at `<userData>/app-secrets.json`.
 *
 * Why: per-project secrets used to live inside project folders, which the
 * user's iCloud Drive synced across Macs. Moving keys to userData makes
 * them per-machine and stops the cross-machine "credentials came from a
 * different machine" warnings.
 *
 * Behaviour:
 *   - Idempotent. A flag in `<userData>/migrations.json` records that the
 *     run completed; subsequent boots short-circuit.
 *   - Per-provider, "first non-empty key wins". If the user already has
 *     a key configured at app level, project-level values are NOT used to
 *     overwrite it.
 *   - Per-project: after lifting any provider keys, the per-project
 *     `secrets.json` is rewritten WITHOUT the `providers` field. If
 *     non-providers state (YouTube OAuth tokens, OAuth client creds)
 *     is present, the file stays. If nothing's left, it's deleted —
 *     stops iCloud from carrying the now-empty stub.
 *   - Foreign-provenance / undecryptable files are skipped silently.
 *     The user just re-enters their keys at app level on each Mac.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'
import { isEncryptionAvailable, encryptToBase64, decryptFromBase64 } from '../lib/safe-storage.js'
import {
  getUserDataDir,
  PROJECTS_ROOT,
} from '../services/project-manager.js'
import { listLinkedProjects } from '../services/linked-projects.js'
import {
  SECRET_PROVIDERS,
  writeAppSecrets,
} from '../services/app-secrets-store.js'

const MIGRATION_KEY = 'app_secrets_v3_lift_from_projects'

interface MigrationsFile {
  [key: string]: { ranAt: string }
}

function migrationsPath(): string {
  return path.join(getUserDataDir(), 'migrations.json')
}

async function alreadyDone(): Promise<boolean> {
  const data = await readJsonOr<MigrationsFile>(migrationsPath(), {} as MigrationsFile)
  return !!data?.[MIGRATION_KEY]
}

async function markDone(): Promise<void> {
  const p = migrationsPath()
  await withLock(p, async () => {
    const data = await readJsonOr<MigrationsFile>(p, {} as MigrationsFile) ?? {}
    data[MIGRATION_KEY] = { ranAt: new Date().toISOString() }
    await writeJsonAtomic(p, data)
  })
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

interface ReadResult {
  providers: Partial<Record<typeof SECRET_PROVIDERS[number], string>>
  /** Whatever non-providers fields the file held (upload, upload_oauth_client, etc.). */
  rest: Record<string, any>
  ok: boolean
}

async function readProjectSecrets(filePath: string): Promise<ReadResult> {
  const raw = await readJsonOr<any>(filePath, null)
  if (raw == null) return { providers: {}, rest: {}, ok: false }

  let payload: any
  if (isEnvelope(raw)) {
    try {
      payload = JSON.parse(decryptFromBase64(raw.ciphertext))
    } catch {
      // Foreign-machine envelope or post-keychain-rotation — skip.
      return { providers: {}, rest: {}, ok: false }
    }
  } else {
    // Plaintext payload. Strip the legacy `_provenance` sibling and any
    // schema_version field; we don't need them in the migrated output.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _provenance, ...rest } = raw
    payload = rest
  }
  if (!payload || typeof payload !== 'object') return { providers: {}, rest: {}, ok: false }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { providers, schema_version: _v, ...rest } = payload as any
  const flatProviders: ReadResult['providers'] = {}

  // v2 multi-account shape: providers.{pid}.accounts[].apiKey (default first)
  if (providers && typeof providers === 'object') {
    for (const pid of SECRET_PROVIDERS) {
      const bucket = providers[pid]
      const accounts = Array.isArray(bucket?.accounts) ? bucket.accounts : []
      const def = accounts.find((a: any) => a?.isDefault) ?? accounts[0]
      if (def && typeof def.apiKey === 'string' && def.apiKey) {
        flatProviders[pid] = def.apiKey
      }
    }
  }
  // Legacy v1 flat shape: `{provider}_api_key` at the top level (rare).
  for (const pid of SECRET_PROVIDERS) {
    const flatKey = `${pid}_api_key`
    if (typeof payload[flatKey] === 'string' && payload[flatKey] && !flatProviders[pid]) {
      flatProviders[pid] = payload[flatKey]
    }
    // Don't carry the legacy flat key into `rest` — it'd just rot.
    delete (rest as any)[flatKey]
  }
  return { providers: flatProviders, rest, ok: true }
}

async function writeProjectFileEncrypted(filePath: string, value: Record<string, any>): Promise<void> {
  const isEmpty = Object.keys(value).length === 0
  if (isEmpty) {
    await fs.rm(filePath, { force: true })
    return
  }
  if (isEncryptionAvailable()) {
    const envelope: EncryptedEnvelope = {
      __encrypted: true,
      version: 1,
      ciphertext: encryptToBase64(JSON.stringify(value)),
    }
    await writeJsonAtomic(filePath, envelope, { mode: 0o600 })
    return
  }
  await writeJsonAtomic(filePath, value, { mode: 0o600 })
}

async function listProjectDirs(): Promise<string[]> {
  const dirs: string[] = []
  // Default location.
  if (existsSync(PROJECTS_ROOT)) {
    try {
      const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue
        dirs.push(path.join(PROJECTS_ROOT, e.name))
      }
    } catch { /* permission / race */ }
  }
  // Linked projects (custom folders the user added via the UI).
  try {
    const linked = await listLinkedProjects()
    for (const info of linked) {
      if (info.exists && info.path) dirs.push(info.path)
    }
  } catch { /* best-effort */ }
  return dirs
}

export async function migrateAppSecrets(): Promise<{
  scanned: number
  liftedProviders: string[]
  rewrittenFiles: number
  removedFiles: number
  skipped: number
}> {
  if (await alreadyDone()) {
    return { scanned: 0, liftedProviders: [], rewrittenFiles: 0, removedFiles: 0, skipped: 0 }
  }

  const summary = { scanned: 0, liftedProviders: [] as string[], rewrittenFiles: 0, removedFiles: 0, skipped: 0 }
  const aggregated: Partial<Record<typeof SECRET_PROVIDERS[number], string>> = {}

  const dirs = await listProjectDirs()
  for (const dir of dirs) {
    summary.scanned++
    const filePath = path.join(dir, 'secrets.json')
    if (!existsSync(filePath)) continue

    const result = await readProjectSecrets(filePath).catch(() => null)
    if (!result || !result.ok) {
      summary.skipped++
      continue
    }

    // Aggregate provider keys — first non-empty wins.
    for (const pid of SECRET_PROVIDERS) {
      const k = result.providers[pid]
      if (k && !aggregated[pid]) aggregated[pid] = k
    }

    // Rewrite the per-project file without the providers. If nothing's
    // left, the writer removes the file.
    await writeProjectFileEncrypted(filePath, result.rest).catch(() => {})
    if (Object.keys(result.rest).length === 0) summary.removedFiles++
    else summary.rewrittenFiles++
  }

  if (Object.keys(aggregated).length > 0) {
    await writeAppSecrets((v3) => {
      for (const pid of SECRET_PROVIDERS) {
        const k = aggregated[pid]
        if (!k) continue
        // Don't overwrite a key the user has already set at app level.
        if (!v3.providers[pid]?.apiKey) {
          v3.providers[pid] = { apiKey: k }
          summary.liftedProviders.push(pid)
        }
      }
    })
  }

  await markDone()
  return summary
}
