import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { GenStudioContentPurchase, GenStudioContentQuote } from '../lib/genstudio-content-store.js'
import {
  CachedContentQuoteSchema,
  CachedContentRefusalSchema,
  ContentStoreDetailSchema,
  ContentStoreCommerceStateSchema,
  emptyContentStoreCommerceState,
  type CachedContentPurchase,
  type CachedContentQuote,
  type CachedContentRefusal,
  type ContentStoreCommerceState,
} from './types.js'

const STATE_MODE = 0o600
const MAX_STATE_BYTES = 16 * 1024 * 1024
const MAX_RECORDS = 200
const LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 20
const STALE_LOCK_MS = 60_000
const activeSubmissionClaims = new Set<string>()

interface CommerceLockOwner {
  token: string
  pid: number
  hostname: string
  created_at_ms: number
}

function runtimePaths() {
  const paths = getContentPackRuntimePaths()
  const statePath = path.join(paths.root, 'commerce-state.json')
  const lockPath = `${statePath}.lock`
  if (path.resolve(path.dirname(statePath)) !== path.resolve(paths.root)
    || path.resolve(path.dirname(lockPath)) !== path.resolve(paths.root)) {
    throw new Error('Content Store commerce state must live directly below its runtime root')
  }
  return { paths, statePath, lockPath }
}

export function getContentStoreStatePath(): string {
  return runtimePaths().statePath
}

async function assertSafeRoot(root: string): Promise<void> {
  assertWriteIsolatedInTests(root, 'content-store-commerce-state')
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Content Store runtime root is unsafe: ${root}`)
}

async function assertSafeOptionalFile(filePath: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Content Store ${label} is unsafe: ${filePath}`)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function parseLockOwner(raw: string): CommerceLockOwner {
  try {
    const value = JSON.parse(raw) as Partial<CommerceLockOwner>
    if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 128
      || !Number.isInteger(value.pid) || (value.pid ?? 0) <= 0
      || typeof value.hostname !== 'string' || value.hostname.length < 1 || value.hostname.length > 255
      || !Number.isSafeInteger(value.created_at_ms) || (value.created_at_ms ?? 0) < 0) {
      throw new Error('invalid lock fields')
    }
    return value as CommerceLockOwner
  } catch (error) {
    throw new Error('Content Store commerce lock is corrupt; manual recovery is required', { cause: error })
  }
}

async function readLockOwner(lockPath: string): Promise<CommerceLockOwner | null> {
  await assertSafeOptionalFile(lockPath, 'lock')
  try {
    return parseLockOwner(await fs.readFile(lockPath, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function publishLock(lockPath: string, owner: CommerceLockOwner): Promise<boolean> {
  await assertSafeOptionalFile(lockPath, 'lock')
  const temporary = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${owner.token}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', STATE_MODE)
    await handle.writeFile(`${JSON.stringify(owner)}\n`)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  try {
    await fs.link(temporary, lockPath)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(lockPath), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

async function releaseLock(lockPath: string, owner: CommerceLockOwner): Promise<void> {
  const current = await readLockOwner(lockPath)
  if (!current || current.token !== owner.token || current.hostname !== owner.hostname || current.pid !== owner.pid) return
  await fs.unlink(lockPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

function ownerIsProvenDead(owner: CommerceLockOwner): boolean {
  if (owner.hostname !== os.hostname()) {
    throw new Error(`Content Store commerce lock belongs to foreign host ${owner.hostname}; manual recovery is required`)
  }
  if (Date.now() - owner.created_at_ms < STALE_LOCK_MS) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw new Error(`Unable to prove Content Store commerce lock PID ${owner.pid} is dead`, { cause: error })
  }
}

async function recoverLockIfProvenStale(lockPath: string): Promise<boolean> {
  const observed = await readLockOwner(lockPath)
  if (!observed) return true
  if (!ownerIsProvenDead(observed)) return false
  const recoveryPath = `${lockPath}.recovery`
  if (path.resolve(path.dirname(recoveryPath)) !== path.resolve(path.dirname(lockPath))) {
    throw new Error('Content Store commerce recovery lock must live beside its canonical lock')
  }
  const guard: CommerceLockOwner = {
    token: randomUUID(), pid: process.pid, hostname: os.hostname(), created_at_ms: Date.now(),
  }
  if (!await publishLock(recoveryPath, guard)) return false
  try {
    const current = await readLockOwner(lockPath)
    if (!current || current.token !== observed.token || current.hostname !== observed.hostname || current.pid !== observed.pid) return false
    if (!ownerIsProvenDead(current)) return false
    await fs.unlink(lockPath)
    return true
  } finally {
    await releaseLock(recoveryPath, guard)
  }
}

/**
 * The ordinary promise lock protects same-process callers. The exclusive file
 * is the process boundary. A stale lock is reclaimed only when it is old, from
 * this host, and the OS proves its PID is dead while a non-stealable recovery
 * guard is held. Age by itself never authorises a second purchase submitter.
 */
async function withCommerceLock<T>(work: () => Promise<T>): Promise<T> {
  const { paths, statePath, lockPath } = runtimePaths()
  return withLock(statePath, async () => {
    await assertSafeRoot(paths.root)
    assertWriteIsolatedInTests(lockPath, 'content-store-commerce-state')
    const deadline = Date.now() + LOCK_WAIT_MS
    const owner: CommerceLockOwner = {
      token: randomUUID(), pid: process.pid, hostname: os.hostname(), created_at_ms: Date.now(),
    }
    while (true) {
      if (await publishLock(lockPath, owner)) break
      if (await recoverLockIfProvenStale(lockPath)) continue
      if (Date.now() >= deadline) throw new Error('timed out waiting for Content Store commerce state lock')
      await sleep(LOCK_RETRY_MS)
    }
    try {
      return await work()
    } finally {
      await releaseLock(lockPath, owner)
    }
  })
}

type StateRead =
  | { kind: 'missing' }
  | { kind: 'valid'; state: ContentStoreCommerceState }
  | { kind: 'invalid'; bytes: Uint8Array; oversized: boolean }
  | { kind: 'io-error'; error: unknown }

async function readStateFile(): Promise<StateRead> {
  const { paths, statePath } = runtimePaths()
  try {
    const root = await fs.lstat(paths.root)
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return { kind: 'io-error', error: new Error(`Content Store runtime root is unsafe: ${paths.root}`) }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'io-error', error }
  }
  try {
    const stat = await fs.lstat(statePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { kind: 'io-error', error: new Error(`Content Store state is unsafe: ${statePath}`) }
    }
    if (stat.size > MAX_STATE_BYTES) {
      return { kind: 'invalid', bytes: await fs.readFile(statePath), oversized: true }
    }
    const bytes = await fs.readFile(statePath)
    return {
      kind: 'valid',
      state: ContentStoreCommerceStateSchema.parse(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))),
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    if (error instanceof SyntaxError || (error && typeof error === 'object' && (error as { name?: string }).name === 'ZodError')) {
      try { return { kind: 'invalid', bytes: await fs.readFile(statePath), oversized: false } } catch (readError) {
        return { kind: 'io-error', error: readError }
      }
    }
    return { kind: 'io-error', error }
  }
}

async function ensureSafeQuarantine(): Promise<string> {
  const { paths } = runtimePaths()
  if (path.resolve(path.dirname(paths.quarantineRoot)) !== path.resolve(paths.root)) {
    throw new Error('Content Store quarantine must live directly below its runtime root')
  }
  await assertSafeRoot(paths.root)
  try {
    await fs.mkdir(paths.quarantineRoot, { mode: 0o700 })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(paths.quarantineRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Content Store quarantine directory is unsafe: ${paths.quarantineRoot}`)
  }
  return paths.quarantineRoot
}

async function quarantineInvalidState(bytes: Uint8Array, oversized: boolean): Promise<ContentStoreCommerceState> {
  const { statePath } = runtimePaths()
  const quarantineRoot = await ensureSafeQuarantine()
  const hash = createHash('sha256').update(bytes).digest('hex')
  const target = path.join(quarantineRoot, `commerce-state-${oversized ? 'oversized' : 'invalid'}-${hash}.json`)
  assertWriteIsolatedInTests(target, 'content-store-commerce-state')
  await fs.writeFile(target, bytes, { flag: 'wx', mode: STATE_MODE }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const empty = emptyContentStoreCommerceState()
  await writeJsonAtomic(statePath, empty, { mode: STATE_MODE })
  return empty
}

async function readOrResetState(): Promise<ContentStoreCommerceState> {
  const result = await readStateFile()
  if (result.kind === 'valid') return result.state
  if (result.kind === 'missing') return emptyContentStoreCommerceState()
  if (result.kind === 'io-error') throw result.error
  return quarantineInvalidState(result.bytes, result.oversized)
}

export async function readContentStoreCommerceState(): Promise<ContentStoreCommerceState> {
  const initial = await readStateFile()
  if (initial.kind === 'valid') return initial.state
  if (initial.kind === 'missing') return emptyContentStoreCommerceState()
  if (initial.kind === 'io-error') throw initial.error
  return withCommerceLock(readOrResetState)
}

async function mutateState<T>(
  mutate: (state: ContentStoreCommerceState) => T | Promise<T>,
  afterPersist?: (result: T) => void,
): Promise<T> {
  return withCommerceLock(async () => {
    const state = await readOrResetState()
    const result = await mutate(state)
    const validated = ContentStoreCommerceStateSchema.parse(state)
    if (Buffer.byteLength(JSON.stringify(validated), 'utf8') > MAX_STATE_BYTES) {
      throw new Error(`Content Store commerce journal exceeds ${MAX_STATE_BYTES} bytes; no evidence was written`)
    }
    const { statePath } = runtimePaths()
    assertWriteIsolatedInTests(statePath, 'content-store-commerce-state')
    await writeJsonAtomic(statePath, validated, { mode: STATE_MODE })
    afterPersist?.(result)
    return result
  })
}

function submissionClaimKey(quoteId: string): string {
  return `${getContentStoreStatePath()}\u0000${quoteId}`
}

/** Test-only restart seam: a new process starts with no in-memory claims. */
export function __testForgetActiveContentPurchase(quoteId: string): void {
  activeSubmissionClaims.delete(submissionClaimKey(quoteId))
}

function nowIso(): string {
  return new Date().toISOString()
}

function quoteIdentity(record: CachedContentQuote): string {
  return JSON.stringify({
    quote_id: record.quote_id,
    account_id: record.account_id,
    product_id: record.product_id,
    release_id: record.release_id,
    entitlement_family: record.entitlement_family,
    expires_at: record.expires_at,
    quote_canonical_json: record.quote_canonical_json,
    quote_signature: record.quote_signature,
    key_id: record.key_id,
    base_credit_price: record.base_credit_price,
    discount_credits: record.discount_credits,
    quoted_credits: record.quoted_credits,
    balance_before: record.balance_before,
    balance_after: record.balance_after,
    owned_components: record.owned_components,
    sufficient_credits: record.sufficient_credits,
    insufficient_reason: record.insufficient_reason,
    shortfall_credits: record.shortfall_credits,
  })
}

function recordForQuote(quote: GenStudioContentQuote, createdAt: string): CachedContentQuote {
  return CachedContentQuoteSchema.parse({
    quote_id: quote.quoteId,
    account_id: quote.accountId,
    product_id: quote.productId,
    release_id: quote.releaseId,
    entitlement_family: quote.entitlementFamily,
    expires_at: quote.expiresAt,
    quote_canonical_json: quote.signedQuote.canonicalJson,
    quote_signature: quote.quoteSignature,
    key_id: quote.keyId,
    idempotency_key: `story-content-${randomUUID()}`,
    base_credit_price: quote.baseCreditPrice,
    discount_credits: quote.discountCredits,
    quoted_credits: quote.quotedCredits,
    balance_before: quote.balanceBefore,
    balance_after: quote.balanceAfter,
    owned_components: quote.ownedComponents,
    sufficient_credits: quote.sufficientCredits,
    insufficient_reason: quote.insufficientReason,
    shortfall_credits: quote.shortfallCredits,
    status: 'quoted',
    created_at: createdAt,
    updated_at: createdAt,
  })
}

function milliseconds(value: string): number {
  return Date.parse(value)
}

function pruneForNewAttempt(state: ContentStoreCommerceState): void {
  if (Object.keys(state.attempts).length < MAX_RECORDS) return
  const candidates = Object.values(state.attempts)
    .filter(record => {
      if (record.status === 'completed') return true
      return (record.status === 'quoted' || record.status === 'refused') && milliseconds(record.expires_at) <= Date.now()
    })
    .sort((left, right) => {
      const leftGroup = left.status === 'completed' ? 1 : 0
      const rightGroup = right.status === 'completed' ? 1 : 0
      return leftGroup - rightGroup || milliseconds(left.updated_at) - milliseconds(right.updated_at)
    })
  while (Object.keys(state.attempts).length >= MAX_RECORDS && candidates.length > 0) {
    delete state.attempts[candidates.shift()!.quote_id]
  }
  if (Object.keys(state.attempts).length >= MAX_RECORDS) {
    throw new Error('Content Store commerce journal is full of in-flight evidence; no quote was saved')
  }
}

export async function saveQuotedAttempt(quote: GenStudioContentQuote): Promise<CachedContentQuote> {
  return mutateState(state => {
    const existing = state.attempts[quote.quoteId]
    const currentTime = nowIso()
    const candidate = recordForQuote(quote, existing?.created_at ?? currentTime)
    if (existing) {
      if (quoteIdentity(existing) !== quoteIdentity(candidate)) {
        throw new Error(`Content Store quote identity drift for ${quote.quoteId}`)
      }
      return existing
    }
    pruneForNewAttempt(state)
    state.attempts[quote.quoteId] = candidate
    return candidate
  })
}

function requireAttempt(state: ContentStoreCommerceState, quoteId: string): CachedContentQuote {
  const attempt = state.attempts[quoteId]
  if (!attempt) throw new Error(`Content Store quote is not saved: ${quoteId}`)
  return attempt
}

function replaceAttempt(state: ContentStoreCommerceState, next: CachedContentQuote): CachedContentQuote {
  const validated = CachedContentQuoteSchema.parse(next)
  state.attempts[next.quote_id] = validated
  return validated
}

export async function beginPurchaseAttempt(quoteId: string, accountId: string): Promise<CachedContentQuote> {
  return mutateState(state => {
    const attempt = requireAttempt(state, quoteId)
    if (attempt.account_id !== accountId) throw new Error('Content Store purchase account does not match the saved quote account')
    if (attempt.status === 'completed') throw new Error('Content Store purchase is already completed and immutable')
    if (attempt.status === 'submitting') throw new Error('Content Store purchase is already submitting')
    const { uncertain_detail: _uncertainDetail, ...retained } = attempt
    return replaceAttempt(state, { ...retained, status: 'submitting', updated_at: nowIso() })
  }, () => activeSubmissionClaims.add(submissionClaimKey(quoteId)))
}

export async function recordPurchaseUncertain(quoteId: string, detail: string): Promise<CachedContentQuote> {
  const boundedDetail = ContentStoreDetailSchema.parse(detail)
  return mutateState(state => {
    const attempt = requireAttempt(state, quoteId)
    if (attempt.status === 'completed') throw new Error('Content Store purchase is already completed and immutable')
    if (attempt.status !== 'submitting') throw new Error('Only a submitting Content Store purchase can become uncertain')
    return replaceAttempt(state, { ...attempt, status: 'uncertain', uncertain_detail: boundedDetail, updated_at: nowIso() })
  }, () => activeSubmissionClaims.delete(submissionClaimKey(quoteId)))
}

export async function recordPurchaseRefusal(
  quoteId: string,
  refusal: CachedContentRefusal,
): Promise<CachedContentQuote> {
  const result = CachedContentRefusalSchema.safeParse(refusal)
  if (!result.success) throw new Error('Content Store refusal has an unknown status/code pairing or unbounded detail', { cause: result.error })
  const bounded = result.data
  return mutateState(state => {
    const attempt = requireAttempt(state, quoteId)
    if (attempt.status === 'completed') throw new Error('Content Store purchase is already completed and immutable')
    if (attempt.status !== 'submitting') throw new Error('Only a submitting Content Store purchase can be refused')
    const { uncertain_detail: _uncertainDetail, ...retained } = attempt
    return replaceAttempt(state, {
      ...retained,
      status: 'refused',
      last_refusal: bounded,
      updated_at: nowIso(),
    })
  }, () => activeSubmissionClaims.delete(submissionClaimKey(quoteId)))
}

function cachedPurchase(purchase: GenStudioContentPurchase): CachedContentPurchase {
  return {
    purchase_id: purchase.purchaseId,
    account_id: purchase.accountId,
    credits_charged: purchase.creditsCharged,
    discount_credits: purchase.discountCredits,
    balance_before: purchase.balanceBefore,
    balance_after: purchase.balanceAfter,
    entitlement_ids: purchase.entitlementIds,
    entitlement_families: purchase.entitlementFamilies,
    product_canonical_json: purchase.product.canonicalJson,
    release_canonical_json: purchase.release.canonicalJson,
    ledger_event_key: purchase.ledgerEventKey,
    receipt: {
      receipt_canonical_json: purchase.receipt.signedReceipt.canonicalJson,
      receipt_signature: purchase.receipt.receiptSignature,
      key_id: purchase.receipt.keyId,
      verification: 'unverified_phase1',
    },
    replayed: purchase.replayed,
  }
}

export async function recordCompletedPurchase(
  quoteId: string,
  purchase: GenStudioContentPurchase,
): Promise<CachedContentQuote> {
  return mutateState(state => {
    const attempt = requireAttempt(state, quoteId)
    const completed = cachedPurchase(purchase)
    if (attempt.status === 'completed') {
      if (JSON.stringify(attempt.completed_purchase) !== JSON.stringify(completed)) {
        throw new Error('Completed Content Store purchase is immutable; purchase identity drift was refused')
      }
      return attempt
    }
    if (attempt.status !== 'submitting') throw new Error('Only a submitting Content Store purchase can complete')
    if (purchase.accountId !== attempt.account_id) throw new Error('Completed Content Store purchase account does not match the quote account')
    if (!purchase.entitlementFamilies.includes(attempt.entitlement_family)) {
      throw new Error('Completed Content Store purchase does not include the quoted entitlement family')
    }
    const { uncertain_detail: _uncertainDetail, ...retained } = attempt
    return replaceAttempt(state, {
      ...retained,
      status: 'completed',
      completed_purchase: completed,
      updated_at: nowIso(),
    })
  }, () => activeSubmissionClaims.delete(submissionClaimKey(quoteId)))
}

export async function recoverInterruptedContentPurchases(): Promise<number> {
  return mutateState(state => {
    let recovered = 0
    const updatedAt = nowIso()
    for (const [quoteId, attempt] of Object.entries(state.attempts)) {
      if (attempt.status !== 'submitting') continue
      if (activeSubmissionClaims.has(submissionClaimKey(quoteId))) continue
      state.attempts[quoteId] = CachedContentQuoteSchema.parse({
        ...attempt,
        status: 'uncertain',
        uncertain_detail: 'Story Studio restarted after purchase submission began. No replacement purchase was sent.',
        updated_at: updatedAt,
      })
      recovered += 1
    }
    return recovered
  })
}
