/**
 * Compatibility shim over the new app-level secrets store.
 *
 * Background: API keys used to live in per-project `secrets.json` files,
 * which iCloud synced across machines and produced "credentials came from
 * a different machine" warnings on every device switch. The rework moves
 * keys to a single per-machine file in userData (see app-secrets-store.ts).
 *
 * This module preserves the historical API surface — `resolveApiKey(slug,
 * providerId, accountId)`, `listAllAccounts(slug)`, etc. — so existing
 * callers (registry.ts, routes/health.ts, project-manager export, the few
 * test fixtures) keep working without change. The `slug` and `accountId`
 * arguments are accepted but IGNORED: there is now exactly zero or one
 * key per provider, app-wide. A future cleanup can drop the slug params at
 * the call sites; doing so up-front isn't worth the diff.
 */

import {
  getApiKey, setApiKey, clearApiKey, listProviderKeys,
  SECRET_PROVIDERS, type ProviderId,
} from './app-secrets-store.js'

/** UI shape — historical name, single-account semantics now. */
export interface AccountSummary {
  id: string
  label: string
  isDefault: boolean
  /** First 4 + last 4 of the key, or '' when unavailable. */
  keyMasked: string
}

export class AccountsError extends Error {
  constructor(message: string, public code: 'unknown_provider' | 'account_not_found' | 'empty_key' | 'empty_label') {
    super(message)
    this.name = 'AccountsError'
  }
}

const SINGLETON_ACCOUNT_ID = 'default'
const SINGLETON_ACCOUNT_LABEL = 'Default'

function assertKnownProvider(providerId: string): asserts providerId is ProviderId {
  if (!(SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    throw new AccountsError(`Unknown provider: ${providerId}`, 'unknown_provider')
  }
}

function summaryFor(providerId: ProviderId, keyMasked: string): AccountSummary {
  return { id: SINGLETON_ACCOUNT_ID, label: SINGLETON_ACCOUNT_LABEL, isDefault: true, keyMasked }
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Return one entry per provider. Empty array when no key configured;
 * one-element array (with id 'default') when configured.
 *
 * `_slug` ignored — kept for API compatibility with the per-project era.
 */
export async function listAllAccounts(_slug: string): Promise<Record<string, AccountSummary[]>> {
  const rows = await listProviderKeys()
  const out: Record<string, AccountSummary[]> = {}
  for (const r of rows) {
    out[r.providerId] = r.hasKey ? [summaryFor(r.providerId, r.keyMasked)] : []
  }
  return out
}

export async function listAccounts(_slug: string, providerId: string): Promise<AccountSummary[]> {
  assertKnownProvider(providerId)
  const k = await getApiKey(providerId)
  if (!k) return []
  return [summaryFor(providerId, maskKey(k))]
}

export async function resolveApiKey(
  _slug: string,
  providerId: string,
  _accountId?: string,
): Promise<{ apiKey: string; accountId: string; label: string } | null> {
  assertKnownProvider(providerId)
  const apiKey = await getApiKey(providerId)
  if (!apiKey) return null
  return { apiKey, accountId: SINGLETON_ACCOUNT_ID, label: SINGLETON_ACCOUNT_LABEL }
}

// ── Mutations ───────────────────────────────────────────────────────────────

/**
 * "Add an account" → set the (single) key for this provider. Existing key
 * is overwritten. The `label` arg is accepted for API compat but ignored.
 */
export async function addAccount(
  _slug: string,
  providerId: string,
  input: { label: string; apiKey: string },
): Promise<AccountSummary> {
  assertKnownProvider(providerId)
  const apiKey = (input.apiKey ?? '').trim()
  if (!apiKey) throw new AccountsError('API key is required', 'empty_key')
  await setApiKey(providerId, apiKey)
  return summaryFor(providerId, maskKey(apiKey))
}

/**
 * "Remove account" → clear the provider's key.
 */
export async function removeAccount(
  _slug: string,
  providerId: string,
  _accountId: string,
): Promise<void> {
  assertKnownProvider(providerId)
  await clearApiKey(providerId)
}

function maskKey(k: string): string {
  if (!k) return ''
  // Mirrors the threshold in app-secrets-store.ts:maskKey — below 12
  // chars we mask everything; otherwise show first4 and last4.
  if (k.length < 12) return '••••'
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}
