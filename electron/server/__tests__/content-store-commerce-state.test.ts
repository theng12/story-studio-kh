import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import {
  beginPurchaseAttempt,
  claimPurchaseAttempt,
  getContentStoreStatePath,
  readContentStoreCommerceState,
  recordCompletedPurchase,
  recordPurchaseRefusal,
  recordPurchaseUncertain,
  recoverInterruptedContentPurchases,
  saveQuotedAttempt,
  recordVerifiedContentRestore,
  resolveVerifiedContentStoreSigningKey,
} from '../content-store/commerce-state.js'
import type { CachedContentRefusal } from '../content-store/types.js'
import { canonicalizeContentStoreObject, parseContentStorePurchase, parseContentStoreQuote } from '../lib/genstudio-content-store.js'
import { useTempDataDir } from './_helpers.js'
import {
  appSecretsPath,
  readContentStoreKeyAnchor,
  recordContentStoreKeyAnchor,
  setContentStoreAnchorPlaintextTestSeamForTests,
} from '../services/app-secrets-store.js'

const SIGNATURE = Buffer.alloc(64, 7).toString('base64')
const HASH = 'a'.repeat(64)
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function cleanupCurrent(): Promise<void> {
  const current = cleanup
  cleanup = undefined
  await current?.()
}

async function isolate() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return { temp, paths: getContentPackRuntimePaths() }
}

function runWorker(workerPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], { env, stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`commerce worker exited ${code}: ${stderr}`)))
  })
}

function startLiveSubmitWorker(workerPath: string, env: NodeJS.ProcessEnv): {
  child: ReturnType<typeof spawn>
  ready: Promise<void>
  exited: Promise<void>
} {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.includes('READY\n')) resolve()
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (!stdout.includes('READY\n')) reject(new Error(`submit worker exited ${code}: ${stderr}`))
    })
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 || child.killed ? resolve() : reject(new Error(`submit worker exited ${code}: ${stderr}`)))
  })
  return { child, ready, exited }
}

function signedQuote(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'genstudio.content.quote.v1', key_id: 'key-1', quote_id: 'cq_test', account_id: 'acct_a',
    product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', release_id: 'crel_a',
    release_version: '1.0.0', archive_sha256: HASH, base_credit_price: 400,
    discount_credits: 100, entitlement_families: ['com.storystudio.test'], bundle_closure: [],
    operator_discount: null, operator_discount_credits: 0, quoted_credits: 300, owned_components: [],
    issued_at: '2026-08-14T10:00:00Z', expires_at: '2099-08-14T10:15:00Z', ...overrides,
  }
}

function quote(overrides: Record<string, unknown> = {}) {
  const signed = signedQuote(overrides.quote && typeof overrides.quote === 'object'
    ? overrides.quote as Record<string, unknown>
    : {})
  return parseContentStoreQuote({
    quote: signed, quote_signature: SIGNATURE, quote_id: signed.quote_id, key_id: signed.key_id,
    expires_at: signed.expires_at, account_id: signed.account_id, product_id: signed.product_id,
    entitlement_family: signed.entitlement_family, release_id: signed.release_id,
    base_credit_price: signed.base_credit_price, discount_credits: signed.discount_credits,
    entitlement_families: signed.entitlement_families, bundle_closure: signed.bundle_closure,
    operator_discount: signed.operator_discount, operator_discount_credits: signed.operator_discount_credits,
    quoted_credits: signed.quoted_credits, balance_before: 5000, balance_after: 4700,
    owned_components: signed.owned_components, sufficient_credits: true,
    insufficient_reason: null, shortfall_credits: 0,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'quote')),
  })
}

function release() {
  return {
    release_id: 'crel_a', pack_id: 'com.storystudio.test', version: '1.0.0', archive_sha256: HASH,
    archive_bytes: 4096, min_story_version: '1.0.834', changelog: 'First release.',
    component_summary: { count: 1 },
  }
}

function purchase(overrides: Record<string, unknown> = {}) {
  const receipt = {
    typ: 'genstudio.content.receipt.v1', key_id: 'key-1', receipt_id: 'crc_a',
    purchase_id: 'cpur_a', quote_id: 'cq_test', account_id: 'acct_a', entitlement_families: ['com.storystudio.test'],
    granted_families: ['com.storystudio.test'], previously_owned_families: [], bundle_closure: [],
    base_credit_price: 400, component_discount_credits: 100,
    operator_discount: null, operator_discount_credits: 0,
    product: { product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', title: 'Test Formula' },
    release: release(), credits_charged: 300, issued_at: '2026-08-14T10:01:00Z',
  }
  return parseContentStorePurchase({
    purchase_id: 'cpur_a', account_id: 'acct_a', credits_charged: 300, discount_credits: 100,
    base_credit_price: 400, component_discount_credits: 100,
    operator_discount: null, operator_discount_credits: 0,
    balance_before: 5000, balance_after: 4700, entitlement_ids: ['cent_a'],
    entitlement_families: ['com.storystudio.test'], granted_families: ['com.storystudio.test'],
    previously_owned_families: [], bundle_closure: [], product: receipt.product, release: receipt.release,
    ledger_event_key: 'content-purchase:cpur_a',
    receipt: { receipt, receipt_signature: SIGNATURE, key_id: 'key-1' }, replayed: false,
    ...overrides,
  })
}

const refusals: CachedContentRefusal[] = [
  {
    status: 402, code: 'insufficient_credits', detail: 'Not enough content-spendable credits.',
    required_credits: 300, available_credits: 50, shortfall_credits: 250,
  },
  { status: 404, code: 'product_unavailable', detail: 'Product unavailable.' },
  { status: 404, code: 'release_unavailable', detail: 'Release unavailable.' },
  { status: 409, code: 'already_owned', detail: 'Already owned.' },
  { status: 409, code: 'quote_rejected', detail: 'Quote rejected.' },
  { status: 503, code: 'signing_unavailable', detail: 'Signing unavailable.' },
]

describe('Content Store commerce state', () => {
  test('persists only already-verified restore evidence and never a bearer grant', async () => {
    await isolate()
    await recordVerifiedContentRestore({
      account_id: 'acct_a',
      content_account_id: 'content-acct_a',
      genstudio_origin: 'https://api.genstudio.example',
      key_id: 'content-key-1',
      public_key_base64: Buffer.alloc(32, 4).toString('base64'),
      receipt_canonical_json: '{"account_id":"acct_a","typ":"genstudio.content.restore.v1"}',
      receipt_signature: SIGNATURE,
      verified_at: new Date().toISOString(),
    })
    const state = await readContentStoreCommerceState()
    assert.equal(state.verified_restore?.account_id, 'acct_a')
    assert.equal(state.verified_restore?.key_id, 'content-key-1')
    assert.doesNotMatch(JSON.stringify(state), /download_url|grant_signature|gsk_/i)
  })

  test('fails closed when a previously pinned GenStudio key id is repointed', async () => {
    await isolate()
    const restore = {
      account_id: 'acct_a', content_account_id: 'content-acct_a', genstudio_origin: 'https://api.genstudio.example',
      key_id: 'content-key-1', public_key_base64: Buffer.alloc(32, 4).toString('base64'),
      receipt_canonical_json: '{"account_id":"acct_a","typ":"genstudio.content.restore.v1"}',
      receipt_signature: SIGNATURE, verified_at: new Date().toISOString(),
      key_history: [{ key_id: 'content-key-1', public_key_base64: Buffer.alloc(32, 4).toString('base64') }],
    }
    await recordVerifiedContentRestore(restore)
    await assert.rejects(recordVerifiedContentRestore({
      ...restore,
      public_key_base64: Buffer.alloc(32, 5).toString('base64'),
      key_history: [{ key_id: 'content-key-1', public_key_base64: Buffer.alloc(32, 5).toString('base64') }],
    }), /repointed/i)
  })

  test('rejects a journal receipt and key replacement under the same key id when offline', async () => {
    await isolate()
    const trusted = generateKeyPairSync('ed25519')
    const rogue = generateKeyPairSync('ed25519')
    const keyId = 'content-key-anchor'
    const publicBase64 = (key: typeof trusted.publicKey) => {
      const der = key.export({ format: 'der', type: 'spki' })
      return der.subarray(der.byteLength - 32).toString('base64')
    }
    const payload = { typ: 'genstudio.content.restore.v1', key_id: keyId, account_id: 'acct_a', content_account_id: 'acct_a', entitlement_families: [] }
    const canonical = canonicalizeContentStoreObject(payload).canonicalJson
    await recordVerifiedContentRestore({
      account_id: 'acct_a', content_account_id: 'acct_a', genstudio_origin: 'https://api.genstudio.example', key_id: keyId,
      public_key_base64: publicBase64(trusted.publicKey), receipt_canonical_json: canonical,
      receipt_signature: sign(null, Buffer.from(canonical), trusted.privateKey).toString('base64'), verified_at: new Date().toISOString(),
      key_history: [{ key_id: keyId, public_key_base64: publicBase64(trusted.publicKey) }],
    })
    await fs.rm(appSecretsPath())
    await assert.rejects(resolveVerifiedContentStoreSigningKey({
      accountId: 'acct_a', origin: 'https://api.genstudio.example', keyId,
    }), /OS-backed.*anchor|online revalidation/i)
    await recordVerifiedContentRestore({
      account_id: 'acct_a', content_account_id: 'acct_a', genstudio_origin: 'https://api.genstudio.example', key_id: keyId,
      public_key_base64: publicBase64(trusted.publicKey), receipt_canonical_json: canonical,
      receipt_signature: sign(null, Buffer.from(canonical), trusted.privateKey).toString('base64'), verified_at: new Date().toISOString(),
      key_history: [{ key_id: keyId, public_key_base64: publicBase64(trusted.publicKey) }],
    })
    const journal = JSON.parse(await fs.readFile(getContentStoreStatePath(), 'utf8'))
    journal.verified_restore.public_key_base64 = publicBase64(rogue.publicKey)
    journal.verified_restore.key_history = [{ key_id: keyId, public_key_base64: publicBase64(rogue.publicKey) }]
    journal.verified_restore.receipt_signature = sign(null, Buffer.from(canonical), rogue.privateKey).toString('base64')
    await fs.writeFile(getContentStoreStatePath(), `${JSON.stringify(journal)}\n`, { mode: 0o600 })
    await assert.rejects(resolveVerifiedContentStoreSigningKey({
      accountId: 'acct_a', origin: 'https://api.genstudio.example', keyId,
    }), /anchor|disagrees/i)
  })

  test('requires a decryptable safeStorage envelope for production anchor reads and writes', async () => {
    await isolate()
    const anchor = {
      origin: 'https://api.genstudio.example', account_id: 'acct_a', content_account_id: 'acct_a',
      keys: [{ key_id: 'key_anchor', public_key_base64: Buffer.alloc(32, 9).toString('base64') }],
    }
    const previousForce = process.env.STORY_STUDIO_FORCE_KEYCHAIN
    process.env.STORY_STUDIO_FORCE_KEYCHAIN = '1'
    setContentStoreAnchorPlaintextTestSeamForTests(false)
    try {
      await fs.writeFile(appSecretsPath(), JSON.stringify({ schema_version: 3, providers: {}, contentStoreKeyAnchors: [anchor] }))
      await assert.rejects(readContentStoreKeyAnchor({
        origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
      }), /safeStorage envelope/i)
      await assert.rejects(recordContentStoreKeyAnchor(anchor), /requires available OS safeStorage/i)
      await fs.writeFile(appSecretsPath(), JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'tampered-not-a-real-envelope' }))
      await assert.rejects(readContentStoreKeyAnchor({
        origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
      }), /undecryptable|tampered/i)
    } finally {
      if (previousForce === undefined) delete process.env.STORY_STUDIO_FORCE_KEYCHAIN
      else process.env.STORY_STUDIO_FORCE_KEYCHAIN = previousForce
      setContentStoreAnchorPlaintextTestSeamForTests(true)
    }
  })

  test('persists one 0600 journal with a durable bounded idempotency key', async () => {
    const { paths } = await isolate()
    const saved = await saveQuotedAttempt(quote())
    assert.equal(getContentStoreStatePath(), path.join(paths.root, 'commerce-state.json'))
    assert.match(saved.idempotency_key, /^story-content-[0-9a-f-]+$/)
    assert.ok(saved.idempotency_key.length >= 8 && saved.idempotency_key.length <= 128)
    assert.equal((await fs.stat(getContentStoreStatePath())).mode & 0o777, 0o600)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.idempotency_key, saved.idempotency_key)
  })

  test('concurrent saves of one exact quote preserve the same key and canonical bytes', async () => {
    await isolate()
    const exact = quote()
    const saved = await Promise.all(Array.from({ length: 12 }, () => saveQuotedAttempt(exact)))
    assert.equal(new Set(saved.map(row => row.idempotency_key)).size, 1)
    assert.equal(new Set(saved.map(row => row.quote_canonical_json)).size, 1)
    assert.equal(Object.keys((await readContentStoreCommerceState()).attempts).length, 1)
  })

  test('refuses quote identity drift without changing the original evidence', async () => {
    await isolate()
    const original = await saveQuotedAttempt(quote())
    await assert.rejects(saveQuotedAttempt(quote({ quote_signature: Buffer.alloc(64, 8).toString('base64') })), /identity drift/i)
    await assert.rejects(saveQuotedAttempt(quote({ quote: { account_id: 'acct_other' } })), /identity drift/i)
    await assert.rejects(saveQuotedAttempt(quote({ quote: { future_signed_fact: 'changed' } })), /identity drift/i)
    assert.deepEqual((await readContentStoreCommerceState()).attempts.cq_test, original)
  })

  test('permits explicit quoted to submitting to refused to submitting to completed using one key', async () => {
    await isolate()
    const quoted = await saveQuotedAttempt(quote())
    assert.equal((await beginPurchaseAttempt('cq_test', 'acct_a')).status, 'submitting')
    const refused = await recordPurchaseRefusal('cq_test', refusals[0])
    assert.equal(refused.status, 'refused')
    const retry = await beginPurchaseAttempt('cq_test', 'acct_a')
    assert.equal(retry.status, 'submitting')
    assert.equal(retry.idempotency_key, quoted.idempotency_key)
    const completed = await recordCompletedPurchase('cq_test', purchase())
    assert.equal(completed.status, 'completed')
    assert.equal(completed.idempotency_key, quoted.idempotency_key)
    assert.equal(completed.last_refusal?.code, 'insufficient_credits')
  })

  test('retains every bounded published refusal shape without changing the key', async () => {
    await isolate()
    for (const [index, refusal] of refusals.entries()) {
      const quoteId = `cq_${index}`
      const saved = await saveQuotedAttempt(quote({ quote: { quote_id: quoteId } }))
      await beginPurchaseAttempt(quoteId, 'acct_a')
      const result = await recordPurchaseRefusal(quoteId, refusal)
      assert.deepEqual(result.last_refusal, refusal)
      assert.equal(result.idempotency_key, saved.idempotency_key)
      assert.equal((await beginPurchaseAttempt(quoteId, 'acct_a')).idempotency_key, saved.idempotency_key)
    }
    await assert.rejects(
      recordPurchaseRefusal('cq_0', { status: 503, code: 'quote_rejected', detail: 'wrong pairing' } as unknown as CachedContentRefusal),
      /refusal|pair/i,
    )
    await assert.rejects(
      recordPurchaseRefusal('cq_0', { status: 503, code: 'signing_unavailable', detail: 'x'.repeat(2049) }),
      /detail|2048|too big/i,
    )
  })

  test('explicit recovery marks prior submitting work uncertain and performs no network action', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    assert.equal(await recoverInterruptedContentPurchases(), 0)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'submitting')
  })

  test('does not recover another live process submission but recovers it after that owner exits', async () => {
    const { temp } = await isolate()
    await saveQuotedAttempt(quote())
    const workerPath = path.join(temp.dir, 'content-store-live-submit-worker.mts')
    const testDirectory = path.dirname(fileURLToPath(import.meta.url))
    const stateModule = pathToFileURL(path.resolve(testDirectory, '../content-store/commerce-state.ts')).href
    await fs.writeFile(workerPath, [
      `import { beginPurchaseAttempt } from ${JSON.stringify(stateModule)};`,
      "await beginPurchaseAttempt('cq_test', 'acct_a');",
      "process.stdout.write('READY\\n');",
      'const timer = setInterval(() => {}, 1000);',
      "process.once('SIGTERM', () => { clearInterval(timer); process.exit(0) });",
    ].join('\n'))
    const worker = startLiveSubmitWorker(workerPath, {
      ...process.env, STORY_STUDIO_DATA_DIR: temp.dir, STORY_STUDIO_DISABLE_LISTEN: '1',
    })
    try {
      await worker.ready
      assert.equal(await recoverInterruptedContentPurchases(), 0)
      assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'submitting')
    } finally {
      worker.child.kill('SIGTERM')
      await worker.exited
    }
    assert.equal(await recoverInterruptedContentPurchases(), 1)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'uncertain')
  })

  test('grants submitting ownership to exactly one concurrent caller', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => beginPurchaseAttempt('cq_test', 'acct_a')))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    for (const result of results.filter(result => result.status === 'rejected')) {
      assert.match(String((result as PromiseRejectedResult).reason), /already submitting/i)
    }
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'submitting')
  })

  test('returns one claimed purchase and durable followers under a simultaneous claim race', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimPurchaseAttempt('cq_test', 'acct_a')))
    assert.equal(claims.filter(result => result.outcome === 'claimed').length, 1)
    assert.equal(claims.filter(result => result.outcome === 'existing-submitting').length, 11)
    assert.equal(new Set(claims.map(result => result.attempt.idempotency_key)).size, 1)
  })

  test('records bounded uncertainty and allows only an explicit caller to resubmit', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const uncertain = await recordPurchaseUncertain('cq_test', 'No response was received.')
    assert.equal(uncertain.status, 'uncertain')
    await assert.rejects(recordPurchaseUncertain('cq_test', 'x'.repeat(2049)), /detail|2048|too big/i)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'uncertain')
    assert.equal((await beginPurchaseAttempt('cq_test', 'acct_a')).status, 'submitting')
  })

  test('keeps completed purchase and exact unverified receipt immutable', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const first = await recordCompletedPurchase('cq_test', purchase())
    assert.equal(first.completed_purchase?.receipt.verification, 'unverified_phase1')
    assert.equal(first.completed_purchase?.receipt.receipt_canonical_json, purchase().receipt.signedReceipt.canonicalJson)
    const replay = await recordCompletedPurchase('cq_test', purchase())
    assert.deepEqual(replay, first)
    await assert.rejects(recordCompletedPurchase('cq_test', purchase({ replayed: true })), /completed|immutable|identity drift/i)
    await assert.rejects(beginPurchaseAttempt('cq_test', 'acct_a'), /completed/i)
  })

  test('checks account and entitlement identity before changing status', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await assert.rejects(beginPurchaseAttempt('cq_test', 'acct_other'), /account/i)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'quoted')
    await beginPurchaseAttempt('cq_test', 'acct_a')
    await assert.rejects(recordCompletedPurchase('cq_test', purchase({
      account_id: 'acct_other',
      receipt: {
        receipt: {
          typ: 'genstudio.content.receipt.v1', key_id: 'key-1', receipt_id: 'crc_a', purchase_id: 'cpur_a', quote_id: 'cq_test',
          account_id: 'acct_other', entitlement_families: ['com.storystudio.test'],
          granted_families: ['com.storystudio.test'], previously_owned_families: [], bundle_closure: [],
          base_credit_price: 400, component_discount_credits: 100, operator_discount: null, operator_discount_credits: 0,
          product: { product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', title: 'Test Formula' },
          release: release(), credits_charged: 300, issued_at: '2026-08-14T10:01:00Z',
        },
        receipt_signature: SIGNATURE, key_id: 'key-1',
      },
    })), /account/i)
    const wrongFamily = purchase()
    wrongFamily.entitlementFamilies = ['com.storystudio.other']
    await assert.rejects(recordCompletedPurchase('cq_test', wrongFamily), /entitlement/i)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'submitting')
  })

  test('refuses a same-account signed receipt whose immutable quote identity differs before completion', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const wrongQuote = purchase({ receipt: {
      receipt: {
        typ: 'genstudio.content.receipt.v1', key_id: 'key-1', receipt_id: 'crc_a', purchase_id: 'cpur_a', quote_id: 'cq_different',
        account_id: 'acct_a', entitlement_families: ['com.storystudio.test'],
        granted_families: ['com.storystudio.test'], previously_owned_families: [], bundle_closure: [],
        base_credit_price: 400, component_discount_credits: 100, operator_discount: null, operator_discount_credits: 0,
        product: { product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', title: 'Test Formula' },
        release: release(), credits_charged: 300, issued_at: '2026-08-14T10:01:00Z',
      }, receipt_signature: SIGNATURE, key_id: 'key-1',
    } })
    assert.equal(wrongQuote.quoteId, 'cq_different')
    await assert.rejects(recordCompletedPurchase('cq_test', wrongQuote), /quote_id|saved quote/i)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'submitting')
  })

  test('binds completed product, release, conveyed families, and closure to the durable quote without comparing price facts', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const wrongProduct = purchase()
    wrongProduct.product.value.product_id = 'cprod_different'
    await assert.rejects(recordCompletedPurchase('cq_test', wrongProduct), /product|release/i)
    const wrongRelease = purchase()
    wrongRelease.release.value.release_id = 'crel_different'
    await assert.rejects(recordCompletedPurchase('cq_test', wrongRelease), /product|release/i)
    const wrongFamilies = purchase()
    wrongFamilies.entitlementFamilies = ['com.storystudio.different']
    await assert.rejects(recordCompletedPurchase('cq_test', wrongFamilies), /entitlement families/i)
    const wrongClosure = purchase()
    wrongClosure.bundleClosure = [{
      position: 0, productId: 'cprod_component', entitlementFamily: 'com.storystudio.component',
      releaseId: 'crel_component', version: '1.0.0', archiveSha256: HASH,
    }]
    await assert.rejects(recordCompletedPurchase('cq_test', wrongClosure), /bundle closure/i)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'submitting')
  })

  test('settles a legacy non-bundle attempt once while retaining its original quote bytes and identity key', async () => {
    await isolate()
    const saved = await saveQuotedAttempt(quote())
    const originalCanonicalQuote = saved.quote_canonical_json
    const originalIdempotencyKey = saved.idempotency_key
    const rawState = JSON.parse(await fs.readFile(getContentStoreStatePath(), 'utf8')) as {
      attempts: Record<string, Record<string, unknown>>
    }
    delete rawState.attempts.cq_test!.entitlement_families
    delete rawState.attempts.cq_test!.bundle_closure
    const legacySignedQuote = JSON.parse(rawState.attempts.cq_test!.quote_canonical_json as string) as Record<string, unknown>
    delete legacySignedQuote.entitlement_families
    delete legacySignedQuote.bundle_closure
    const legacyCanonicalQuote = JSON.stringify(legacySignedQuote)
    rawState.attempts.cq_test!.quote_canonical_json = legacyCanonicalQuote
    await fs.writeFile(getContentStoreStatePath(), `${JSON.stringify(rawState)}\n`, { mode: 0o600 })

    const legacy = (await readContentStoreCommerceState()).attempts.cq_test!
    assert.notEqual(legacy.quote_canonical_json, originalCanonicalQuote)
    assert.equal(legacy.quote_canonical_json, legacyCanonicalQuote)
    assert.equal(legacy.idempotency_key, originalIdempotencyKey)
    assert.equal(legacy.entitlement_families, undefined)
    assert.equal(legacy.bundle_closure, undefined)
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const wrongProduct = purchase()
    wrongProduct.product.value.product_id = 'cprod_different'
    await assert.rejects(recordCompletedPurchase('cq_test', wrongProduct), /product|release/i)
    const completed = await recordCompletedPurchase('cq_test', purchase())
    const replay = await recordCompletedPurchase('cq_test', purchase())
    assert.equal(completed.idempotency_key, originalIdempotencyKey)
    assert.deepEqual(replay, completed)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.quote_canonical_json, legacyCanonicalQuote)
    assert.equal((await readContentStoreCommerceState()).attempts.cq_test.status, 'completed')
  })

  test('accepts canonical signed quote bytes with preserved Python numeric lexemes', async () => {
    await isolate()
    const exact = quote({ quote: {
      future_signed_fact: { integral_float: 1, negative_zero: 0, small: 1e-7, large: 1e20 },
    } })
    const javascriptNumbers = '"future_signed_fact":{"integral_float":1,"large":100000000000000000000,"negative_zero":0,"small":1e-7}'
    const pythonNumbers = '"future_signed_fact":{"integral_float":1.0,"large":1e+20,"negative_zero":-0.0,"small":1e-07}'
    assert.match(exact.signedQuote.canonicalJson, new RegExp(javascriptNumbers.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    exact.signedQuote.canonicalJson = exact.signedQuote.canonicalJson.replace(javascriptNumbers, pythonNumbers)

    const saved = await saveQuotedAttempt(exact)
    const submitting = await beginPurchaseAttempt('cq_test', 'acct_a')

    assert.equal(submitting.status, 'submitting')
    assert.equal(submitting.quote_canonical_json, saved.quote_canonical_json)
    assert.match(submitting.quote_canonical_json, /"integral_float":1\.0,"large":1e\+20,"negative_zero":-0\.0,"small":1e-07/)
  })

  test('still rejects mutated identity and non-canonical saved quote bytes', async () => {
    await isolate()
    const mutated = quote()
    mutated.signedQuote.canonicalJson = mutated.signedQuote.canonicalJson.replace('"product_id":"cprod_a"', '"product_id":"cprod_other"')
    await saveQuotedAttempt(mutated)
    await assert.rejects(beginPurchaseAttempt('cq_test', 'acct_a'), /product_id|journal identity/i)

    await cleanupCurrent()
    await isolate()
    const nonCanonical = quote()
    nonCanonical.signedQuote.canonicalJson = nonCanonical.signedQuote.canonicalJson.replace('{"account_id"', '{ "account_id"')
    await saveQuotedAttempt(nonCanonical)
    await assert.rejects(beginPurchaseAttempt('cq_test', 'acct_a'), /not canonical/i)
  })

  test('quarantines malformed and oversized journals using a safe direct child', async () => {
    const { paths } = await isolate()
    await fs.mkdir(paths.root, { recursive: true })
    const invalid = '{"schema_version":1,"attempts":{},"api_key":"gsk_secret"}\n'
    await fs.writeFile(getContentStoreStatePath(), invalid, { mode: 0o600 })
    assert.deepEqual(await readContentStoreCommerceState(), { schema_version: 1, attempts: {} })
    const hash = createHash('sha256').update(invalid).digest('hex')
    assert.equal(
      await fs.readFile(path.join(paths.quarantineRoot, `commerce-state-invalid-${hash}.json`), 'utf8'),
      invalid,
    )

    await fs.writeFile(getContentStoreStatePath(), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), { mode: 0o600 })
    assert.deepEqual(await readContentStoreCommerceState(), { schema_version: 1, attempts: {} })
    assert.ok((await fs.readdir(paths.quarantineRoot)).some(name => name.startsWith('commerce-state-oversized-')))
  })

  test('serialises parallel mutations without losing distinct quote records', async () => {
    await isolate()
    await Promise.all(Array.from({ length: 40 }, (_, index) => saveQuotedAttempt(quote({ quote: { quote_id: `cq_parallel_${index}` } }))))
    assert.equal(Object.keys((await readContentStoreCommerceState()).attempts).length, 40)
  })

  test('serialises quote saves across Node processes', async () => {
    const { temp } = await isolate()
    const workerPath = path.join(temp.dir, 'content-store-commerce-worker.mts')
    const testDirectory = path.dirname(fileURLToPath(import.meta.url))
    const stateModule = pathToFileURL(path.resolve(testDirectory, '../content-store/commerce-state.ts')).href
    const parserModule = pathToFileURL(path.resolve(testDirectory, '../lib/genstudio-content-store.ts')).href
    await fs.writeFile(workerPath, [
      `import { saveQuotedAttempt } from ${JSON.stringify(stateModule)};`,
      `import { parseContentStoreQuote } from ${JSON.stringify(parserModule)};`,
      `const HASH=${JSON.stringify(HASH)}; const SIGNATURE=${JSON.stringify(SIGNATURE)};`,
      'const id = process.env.CONTENT_STORE_WORKER_ID;',
      "const quote_id = `cq_process_${id}`;",
      "const quote={typ:'genstudio.content.quote.v1',key_id:'key-1',quote_id,account_id:'acct_a',product_id:'cprod_a',entitlement_family:'com.storystudio.test',release_id:'crel_a',release_version:'1.0.0',archive_sha256:HASH,base_credit_price:400,discount_credits:100,entitlement_families:['com.storystudio.test'],bundle_closure:[],operator_discount:null,operator_discount_credits:0,quoted_credits:300,owned_components:[],issued_at:'2026-08-14T10:00:00Z',expires_at:'2099-08-14T10:15:00Z'};",
      "await saveQuotedAttempt(parseContentStoreQuote({quote,quote_signature:SIGNATURE,quote_id,key_id:'key-1',expires_at:quote.expires_at,account_id:'acct_a',product_id:'cprod_a',entitlement_family:'com.storystudio.test',release_id:'crel_a',base_credit_price:400,discount_credits:100,entitlement_families:quote.entitlement_families,bundle_closure:quote.bundle_closure,operator_discount:quote.operator_discount,operator_discount_credits:0,quoted_credits:300,balance_before:5000,balance_after:4700,owned_components:[],sufficient_credits:true,insufficient_reason:null,shortfall_credits:0}));",
    ].join('\n'))
    await Promise.all(Array.from({ length: 12 }, (_, index) => runWorker(workerPath, {
      ...process.env,
      STORY_STUDIO_DATA_DIR: temp.dir,
      CONTENT_STORE_WORKER_ID: index < 6 ? 'same' : String(index),
      STORY_STUDIO_DISABLE_LISTEN: '1',
    })))
    const attempts = (await readContentStoreCommerceState()).attempts
    assert.equal(Object.keys(attempts).length, 7)
    assert.equal(Object.values(attempts).filter(row => row.quote_id === 'cq_process_same').length, 1)
  })

  test('recovers a stale commerce lock only when its local PID is proven dead', async () => {
    const { paths } = await isolate()
    await fs.mkdir(paths.root, { recursive: true })
    const lockPath = `${getContentStoreStatePath()}.lock`
    await fs.writeFile(lockPath, JSON.stringify({
      token: 'dead-owner',
      pid: 999_999_999,
      hostname: os.hostname(),
      created_at_ms: Date.now() - 120_000,
    }), { mode: 0o600 })
    assert.equal((await saveQuotedAttempt(quote())).status, 'quoted')
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' })
  })

  test('fails closed when a stale-lock recovery guard is a symlink', async () => {
    const { temp, paths } = await isolate()
    await fs.mkdir(paths.root, { recursive: true })
    const lockPath = `${getContentStoreStatePath()}.lock`
    await fs.writeFile(lockPath, JSON.stringify({
      token: 'dead-owner', pid: 999_999_999, hostname: os.hostname(), created_at_ms: Date.now() - 120_000,
    }), { mode: 0o600 })
    const outside = path.join(temp.dir, 'outside-recovery-guard')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, `${lockPath}.recovery`)
    await assert.rejects(saveQuotedAttempt(quote()), /lock.*unsafe|unsafe.*lock|symbolic/i)
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside')
  })

  test('fails closed for runtime-root, state, lock, and quarantine symlinks', async () => {
    {
      const { temp, paths } = await isolate()
      const outside = path.join(temp.dir, 'outside-root')
      await fs.mkdir(outside)
      await fs.symlink(outside, paths.root)
      await assert.rejects(saveQuotedAttempt(quote()), /root.*unsafe|unsafe.*root/i)
      await cleanupCurrent()
    }
    {
      const { temp, paths } = await isolate()
      await fs.mkdir(paths.root, { recursive: true })
      const outside = path.join(temp.dir, 'outside-state')
      await fs.writeFile(outside, '{}')
      await fs.symlink(outside, getContentStoreStatePath())
      await assert.rejects(readContentStoreCommerceState(), /state.*unsafe|unsafe.*state|symbolic/i)
      await cleanupCurrent()
    }
    {
      const { temp, paths } = await isolate()
      await fs.mkdir(paths.root, { recursive: true })
      const outside = path.join(temp.dir, 'outside-lock')
      await fs.writeFile(outside, '{}')
      await fs.symlink(outside, `${getContentStoreStatePath()}.lock`)
      await assert.rejects(saveQuotedAttempt(quote()), /lock.*unsafe|unsafe.*lock|symbolic/i)
      await cleanupCurrent()
    }
    {
      const { temp, paths } = await isolate()
      await fs.mkdir(paths.root, { recursive: true })
      const outside = path.join(temp.dir, 'outside-quarantine')
      await fs.mkdir(outside)
      await fs.symlink(outside, paths.quarantineRoot)
      await fs.writeFile(getContentStoreStatePath(), '{"bad":true}', { mode: 0o600 })
      await assert.rejects(readContentStoreCommerceState(), /quarantine.*unsafe|unsafe.*quarantine/i)
      assert.deepEqual(await fs.readdir(outside), [])
    }
  })

  test('strict schema rejects credential, fingerprint, path, and unknown fields', async () => {
    await isolate()
    const saved = await saveQuotedAttempt(quote())
    const state = await readContentStoreCommerceState()
    for (const field of ['api_key', 'masked_key', 'key_fingerprint', 'credential_hash', 'install_path']) {
      await fs.writeFile(getContentStoreStatePath(), JSON.stringify({
        ...state,
        attempts: { cq_test: { ...saved, [field]: field === 'install_path' ? '/tmp/pack' : 'gsk_secret' } },
      }), { mode: 0o600 })
      assert.deepEqual(await readContentStoreCommerceState(), { schema_version: 1, attempts: {} })
    }
  })

  test('prunes only safe old records and never drops submitting or uncertain evidence', async () => {
    await isolate()
    for (let index = 0; index < 200; index += 1) {
      const quoteId = `cq_limit_${index}`
      await saveQuotedAttempt(quote({ quote: { quote_id: quoteId, expires_at: '2020-01-01T00:00:00Z' } }))
      if (index === 0) await beginPurchaseAttempt(quoteId, 'acct_a')
      if (index === 1) {
        await beginPurchaseAttempt(quoteId, 'acct_a')
        await recordPurchaseUncertain(quoteId, 'Interrupted.')
      }
    }
    await saveQuotedAttempt(quote({ quote: { quote_id: 'cq_new' } }))
    const state = await readContentStoreCommerceState()
    assert.equal(Object.keys(state.attempts).length, 200)
    assert.equal(state.attempts.cq_limit_0.status, 'submitting')
    assert.equal(state.attempts.cq_limit_1.status, 'uncertain')
    assert.ok(state.attempts.cq_new)
  })

  test('prunes old completed evidence against the journal byte budget before refusing a new quote', async () => {
    const { paths } = await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const completed = await recordCompletedPurchase('cq_test', purchase())
    const padding = JSON.stringify({ padding: 'x'.repeat(820_000) })
    const attempts = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
      const quoteId = `cq_large_${index}`
      return [quoteId, {
        ...completed,
        quote_id: quoteId,
        idempotency_key: `story-content-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        quote_canonical_json: padding,
        created_at: `2026-08-14T00:00:${String(index).padStart(2, '0')}.000Z`,
        updated_at: `2026-08-14T00:00:${String(index).padStart(2, '0')}.000Z`,
        completed_purchase: {
          ...completed.completed_purchase!,
          purchase_id: `cpur_large_${index}`,
          receipt: { ...completed.completed_purchase!.receipt, receipt_canonical_json: padding },
        },
      }]
    }))
    await fs.writeFile(getContentStoreStatePath(), `${JSON.stringify({ schema_version: 1, attempts })}\n`, { mode: 0o600 })
    const before = (await fs.stat(getContentStoreStatePath())).size
    assert.ok(before < 16 * 1024 * 1024, `fixture must begin below journal limit, got ${before}`)
    const next = quote({ quote: { quote_id: 'cq_after_large', future_padding: ['y'.repeat(200_000), 'z'.repeat(200_000)] } })
    await saveQuotedAttempt(next)
    const state = await readContentStoreCommerceState()
    assert.ok(state.attempts.cq_after_large)
    assert.ok(Object.keys(state.attempts).length < 11, 'old completed evidence should be pruned to make safe byte headroom')
    assert.ok((await fs.stat(getContentStoreStatePath())).size <= 16 * 1024 * 1024)
    assert.equal((await fs.stat(paths.root)).isDirectory(), true)
  })

  test('budgets the exact pretty-printed journal bytes used by the atomic writer', async () => {
    await isolate()
    await saveQuotedAttempt(quote())
    await beginPurchaseAttempt('cq_test', 'acct_a')
    const completed = await recordCompletedPurchase('cq_test', purchase())
    const attempts: Record<string, typeof completed> = {}
    for (let index = 0; index < 170; index += 1) {
      const quoteId = `cq_boundary_${index}`
      attempts[quoteId] = {
        ...completed,
        quote_id: quoteId,
        idempotency_key: `story-content-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        quote_canonical_json: JSON.stringify({ padding: '' }),
        completed_purchase: {
          ...completed.completed_purchase!,
          purchase_id: `cpur_boundary_${index}`,
        },
      }
    }
    const seeded = { schema_version: 1 as const, attempts }
    const rawBudget = Math.floor((16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(seeded), 'utf8') - 1) / 170)
    for (const attempt of Object.values(attempts)) {
      attempt.quote_canonical_json = JSON.stringify({ padding: 'x'.repeat(rawBudget) })
    }
    assert.ok(Buffer.byteLength(JSON.stringify(seeded), 'utf8') < 16 * 1024 * 1024)
    assert.ok(Buffer.byteLength(`${JSON.stringify(seeded, null, 2)}\n`, 'utf8') > 16 * 1024 * 1024)
    await fs.writeFile(getContentStoreStatePath(), `${JSON.stringify(seeded)}\n`, { mode: 0o600 })

    const saved = await saveQuotedAttempt(quote({ quote: { quote_id: 'cq_after_boundary' } }))
    assert.equal(saved.quote_id, 'cq_after_boundary')
    assert.ok((await fs.stat(getContentStoreStatePath())).size <= 16 * 1024 * 1024)
    assert.ok((await readContentStoreCommerceState()).attempts.cq_after_boundary)
  })

  test('quarantines a sparse oversized journal without reading it into a full memory buffer', async () => {
    const { paths } = await isolate()
    await fs.mkdir(paths.root, { recursive: true })
    const handle = await fs.open(getContentStoreStatePath(), 'w', 0o600)
    try { await handle.truncate(256 * 1024 * 1024) } finally { await handle.close() }
    const before = process.memoryUsage().rss
    assert.deepEqual(await readContentStoreCommerceState(), { schema_version: 1, attempts: {} })
    const growth = process.memoryUsage().rss - before
    assert.ok(growth < 64 * 1024 * 1024, `oversized quarantine allocated ${growth} bytes of RSS`)
    assert.ok((await fs.readdir(paths.quarantineRoot)).some(name => name.startsWith('commerce-state-oversized-')))
  })
})
