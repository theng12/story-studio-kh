/**
 * Account-centric secrets API — adds/removes/selects accounts per provider.
 *
 * Operates on the v2 secrets shape directly (see secrets-store.ts). Callers
 * that still want the legacy single-key view use `readSecrets` / `writeSecrets`
 * from secrets-store, which project over the default account of each provider.
 *
 * Backing layer invariants — enforced inside writeSecretsV2 on every write:
 *   - Exactly one `isDefault: true` per non-empty provider bucket.
 *   - Account ids are unique within a provider.
 *   - A provider with zero accounts is removed from the `providers` map.
 */

import { randomUUID } from 'crypto'
import {
  readSecretsV2,
  writeSecretsV2,
  SECRET_PROVIDERS,
  type ProviderId,
  type ProviderAccount,
} from './secrets-store.js'

/** Shape returned to the frontend — never carries the raw key. */
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

function assertKnownProvider(providerId: string): asserts providerId is ProviderId {
  if (!(SECRET_PROVIDERS as readonly string[]).includes(providerId)) {
    throw new AccountsError(`Unknown provider: ${providerId}`, 'unknown_provider')
  }
}

function maskKey(k: string): string {
  if (!k) return ''
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

function toSummary(a: ProviderAccount): AccountSummary {
  return {
    id: a.id,
    label: a.label,
    isDefault: !!a.isDefault,
    keyMasked: maskKey(a.apiKey),
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────

/** List every provider's accounts in UI-friendly (masked) form. */
export async function listAllAccounts(
  slug: string,
): Promise<Record<string, AccountSummary[]>> {
  const v2 = await readSecretsV2(slug)
  const out: Record<string, AccountSummary[]> = {}
  for (const pid of SECRET_PROVIDERS) {
    const bucket = v2.providers[pid]
    out[pid] = bucket?.accounts?.map(toSummary) ?? []
  }
  return out
}

/** List accounts for one provider in UI-friendly (masked) form. */
export async function listAccounts(
  slug: string,
  providerId: string,
): Promise<AccountSummary[]> {
  assertKnownProvider(providerId)
  const v2 = await readSecretsV2(slug)
  const bucket = v2.providers[providerId]
  return bucket?.accounts?.map(toSummary) ?? []
}

/**
 * Look up the raw API key to use for a provider. Returns `null` when the
 * provider has no accounts. If `accountId` is omitted, picks the default
 * (or the first account if no default is set — shouldn't happen post-write
 * invariants, but we still tolerate it on read).
 *
 * Throws `account_not_found` when `accountId` is passed but unknown.
 */
export async function resolveApiKey(
  slug: string,
  providerId: string,
  accountId?: string,
): Promise<{ apiKey: string; accountId: string; label: string } | null> {
  assertKnownProvider(providerId)
  const v2 = await readSecretsV2(slug)
  const bucket = v2.providers[providerId]
  if (!bucket?.accounts?.length) return null

  const pick = accountId
    ? bucket.accounts.find(a => a.id === accountId)
    : bucket.accounts.find(a => a.isDefault) ?? bucket.accounts[0]

  if (!pick) {
    if (accountId) {
      throw new AccountsError(
        `No account ${accountId} for provider ${providerId}`,
        'account_not_found',
      )
    }
    return null
  }
  return { apiKey: pick.apiKey, accountId: pick.id, label: pick.label }
}

// ── Mutations ───────────────────────────────────────────────────────────────

/**
 * Create an account. The first account added to an empty provider is
 * auto-marked as default.
 */
export async function addAccount(
  slug: string,
  providerId: string,
  input: { label: string; apiKey: string },
): Promise<AccountSummary> {
  assertKnownProvider(providerId)
  const label = input.label?.trim()
  const apiKey = input.apiKey?.trim()
  if (!label) throw new AccountsError('Label is required', 'empty_label')
  if (!apiKey) throw new AccountsError('API key is required', 'empty_key')

  const created: ProviderAccount = {
    id: randomUUID(),
    label,
    apiKey,
    isDefault: false,
  }

  await writeSecretsV2(slug, (v2) => {
    const bucket = v2.providers[providerId] ?? { accounts: [] }
    if (!bucket.accounts.length) created.isDefault = true
    bucket.accounts.push(created)
    v2.providers[providerId] = bucket
  })

  return toSummary(created)
}

export async function updateAccount(
  slug: string,
  providerId: string,
  accountId: string,
  patch: { label?: string; apiKey?: string },
): Promise<AccountSummary> {
  assertKnownProvider(providerId)
  let updated: ProviderAccount | undefined

  await writeSecretsV2(slug, (v2) => {
    const bucket = v2.providers[providerId]
    const acc = bucket?.accounts.find(a => a.id === accountId)
    if (!acc) {
      throw new AccountsError(
        `No account ${accountId} for provider ${providerId}`,
        'account_not_found',
      )
    }
    if (patch.label !== undefined) {
      const trimmed = patch.label.trim()
      if (!trimmed) throw new AccountsError('Label cannot be empty', 'empty_label')
      acc.label = trimmed
    }
    if (patch.apiKey !== undefined) {
      const trimmed = patch.apiKey.trim()
      if (!trimmed) throw new AccountsError('API key cannot be empty', 'empty_key')
      acc.apiKey = trimmed
    }
    updated = acc
  })

  return toSummary(updated!)
}

/**
 * Remove an account. If the removed account was the default and other
 * accounts remain, the first remaining account is promoted to default.
 */
export async function removeAccount(
  slug: string,
  providerId: string,
  accountId: string,
): Promise<void> {
  assertKnownProvider(providerId)

  await writeSecretsV2(slug, (v2) => {
    const bucket = v2.providers[providerId]
    if (!bucket) {
      throw new AccountsError(
        `No account ${accountId} for provider ${providerId}`,
        'account_not_found',
      )
    }
    const i = bucket.accounts.findIndex(a => a.id === accountId)
    if (i < 0) {
      throw new AccountsError(
        `No account ${accountId} for provider ${providerId}`,
        'account_not_found',
      )
    }
    const wasDefault = !!bucket.accounts[i].isDefault
    bucket.accounts.splice(i, 1)
    if (wasDefault && bucket.accounts.length) {
      bucket.accounts[0].isDefault = true
    }
    // writeSecretsV2 prunes empty buckets.
  })
}

export async function setDefaultAccount(
  slug: string,
  providerId: string,
  accountId: string,
): Promise<void> {
  assertKnownProvider(providerId)

  await writeSecretsV2(slug, (v2) => {
    const bucket = v2.providers[providerId]
    const target = bucket?.accounts.find(a => a.id === accountId)
    if (!target) {
      throw new AccountsError(
        `No account ${accountId} for provider ${providerId}`,
        'account_not_found',
      )
    }
    for (const a of bucket!.accounts) a.isDefault = a.id === accountId
  })
}
