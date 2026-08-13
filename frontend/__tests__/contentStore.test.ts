import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'

const completeOverview = {
  phase: 'commerce_core' as const,
  account: {
    accountId: 'acct_a',
    contentAccountId: 'content_acct_a',
    availableCredits: 2_400,
    contentSpendableCredits: 1_650,
    owned: [],
  },
  products: [
    {
      productId: 'formula', entitlementFamily: 'formula.family', kind: 'series_formula' as const,
      title: 'Archive Formula', summary: 'A repeatable documentary structure.',
      description: 'Long-form production guidance.', publisherId: 'Story Studio',
      creditPrice: 400, free: false, owned: false, retired: false,
      successorProductId: null, compatible: true, compatibilityReason: null,
      currentRelease: {
        releaseId: 'rel_formula', packId: 'pack_formula', version: '1.0.0',
        archiveSha256: 'a'.repeat(64), archiveBytes: 4_096,
        minStoryVersion: '1.0.834', changelog: 'First release.', componentSummary: {},
      },
      bundleComponents: [], ownedComponentCreditValue: 0,
    },
  ],
  attempts: [],
  capabilities: {
    purchase: true, receipt_verification: false, download: false,
    install_after_purchase: false, restore: false,
  },
}

let calls: Array<{ path: string; options: Record<string, unknown> }> = []
let handler: (path: string, options: Record<string, unknown>) => unknown

;(globalThis as any).$fetch = async (path: string, options: Record<string, unknown> = {}) => {
  calls.push({ path, options })
  return handler(path, options)
}

const { useContentStore } = await import('../composables/useContentStore.js')

beforeEach(() => {
  calls = []
  handler = path => {
    if (path === '/api/content-store') return structuredClone(completeOverview)
    throw new Error(`Unexpected request: ${path}`)
  }
})

describe('useContentStore explicit commerce state machine', () => {
  test('loads only on explicit refresh and never polls or purchases on its own', async () => {
    const store = useContentStore()
    assert.equal(calls.length, 0)

    await store.refresh()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.path, '/api/content-store')
    assert.deepEqual(store.account.value, completeOverview.account)
    assert.deepEqual(store.products.value, completeOverview.products)

    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 1, 'the Store must not poll or retry commerce calls')
  })

  test('requests one exact quote only after the customer asks', async () => {
    const quoted = {
      quote_id: 'cq_1', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    handler = (path, options) => {
      if (path === '/api/content-store/quotes') {
        assert.equal(options.method, 'POST')
        assert.deepEqual(options.body, { product_id: 'formula', release_id: 'rel_formula' })
        return quoted
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    const result = await store.requestQuote('formula', 'rel_formula')
    assert.deepEqual(result, quoted)
    assert.deepEqual(store.attempts.value, [quoted])
    assert.equal(calls.length, 1)
  })

  test('replays an uncertain purchase only after explicit Retry and keeps the same attempt', async () => {
    const quoted = {
      quote_id: 'cq_1', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    let purchaseCalls = 0
    handler = (path) => {
      if (path === '/api/content-store') return { ...structuredClone(completeOverview), attempts: [quoted] }
      if (path.endsWith('/purchase')) {
        purchaseCalls += 1
        if (purchaseCalls === 1) {
          const error: any = new Error('uncertain')
          error.data = {
            code: 'CONTENT_PURCHASE_OUTCOME_UNCERTAIN', status: 'uncertain',
            detail: 'Story Studio did not receive GenStudio\'s answer. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.',
          }
          throw error
        }
        return {
          ...quoted, status: 'completed', ownership: 'owned_not_installed',
          credits_charged: 380, replayed: true, receipt_verification: 'unverified_phase1',
        }
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    await assert.rejects(store.confirmPurchase('cq_1'))
    assert.equal(store.attempts.value[0]?.status, 'uncertain')
    assert.equal(purchaseCalls, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(purchaseCalls, 1, 'an uncertain outcome must never retry automatically')

    const completed = await store.confirmPurchase('cq_1')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.replayed, true)
    assert.equal(purchaseCalls, 2)
  })

  test('shows final purchase balance and reconciles the account strip without another purchase POST', async () => {
    const quoted = {
      quote_id: 'cq_discount', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    const completed = {
      ...quoted, status: 'completed' as const, balance_after: 1_350,
      ownership: 'owned_not_installed' as const, credits_charged: 300,
      replayed: false, receipt_verification: 'unverified_phase1' as const,
    }
    let purchaseCalls = 0
    let overviewCalls = 0
    handler = path => {
      if (path === '/api/content-store') {
        overviewCalls += 1
        if (overviewCalls === 1) return { ...structuredClone(completeOverview), attempts: [quoted] }
        return {
          ...structuredClone(completeOverview),
          account: { ...structuredClone(completeOverview.account), contentSpendableCredits: 1_350 },
          attempts: [completed],
        }
      }
      if (path.endsWith('/purchase')) {
        purchaseCalls += 1
        return completed
      }
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    const result = await store.confirmPurchase('cq_discount')
    assert.equal(result.balance_after, 1_350)
    assert.equal(store.attempts.value[0]?.balance_after, 1_350)
    assert.equal(store.account.value?.contentSpendableCredits, 1_350)
    assert.equal(purchaseCalls, 1)
    assert.equal(overviewCalls, 2)
  })

  test('keeps completed ownership visible when the post-purchase account refresh fails', async () => {
    const quoted = {
      quote_id: 'cq_refresh_failure', account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
      entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
      base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
      balance_before: 1_650, balance_after: 1_250, owned_components: [],
      sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
    }
    const completed = {
      ...quoted, status: 'completed' as const, balance_after: 1_350,
      ownership: 'owned_not_installed' as const, credits_charged: 300,
      replayed: false, receipt_verification: 'unverified_phase1' as const,
    }
    let overviewCalls = 0
    handler = path => {
      if (path === '/api/content-store') {
        overviewCalls += 1
        if (overviewCalls === 1) return { ...structuredClone(completeOverview), attempts: [quoted] }
        throw new Error('post-purchase account refresh unavailable')
      }
      if (path.endsWith('/purchase')) return completed
      throw new Error(`Unexpected request: ${path}`)
    }

    const store = useContentStore()
    await store.refresh()
    const result = await store.confirmPurchase('cq_refresh_failure')
    assert.equal(result.status, 'completed')
    assert.equal(store.attempts.value[0]?.status, 'completed')
    assert.equal(store.error.value, null)
  })

  for (const refusal of [
    { status: 402, code: 'insufficient_credits' },
    { status: 503, code: 'signing_unavailable' },
  ]) {
    test(`retries refused ${refusal.status} ${refusal.code} only after an explicit click`, async () => {
      const quoted = {
        quote_id: `cq_${refusal.status}`, account_id: 'acct_a', product_id: 'formula', release_id: 'rel_formula',
        entitlement_family: 'formula.family', expires_at: '2026-08-14T10:15:00Z', status: 'quoted' as const,
        base_credit_price: 400, discount_credits: 0, quoted_credits: 400,
        balance_before: 1_650, balance_after: 1_250, owned_components: [],
        sufficient_credits: true, insufficient_reason: null, shortfall_credits: 0,
      }
      let purchaseCalls = 0
      handler = path => {
        if (path === '/api/content-store') return { ...structuredClone(completeOverview), attempts: [quoted] }
        if (path.endsWith('/purchase')) {
          purchaseCalls += 1
          if (purchaseCalls === 1) {
            const error: any = new Error(refusal.code)
            error.status = refusal.status
            error.data = { code: refusal.code, detail: `${refusal.code} detail`, status: 'refused' }
            throw error
          }
          return {
            ...quoted, status: 'completed', ownership: 'owned_not_installed', credits_charged: 400,
            replayed: false, receipt_verification: 'unverified_phase1',
          }
        }
        throw new Error(`Unexpected request: ${path}`)
      }

      const store = useContentStore()
      await store.refresh()
      await assert.rejects(store.confirmPurchase(quoted.quote_id))
      assert.equal(store.attempts.value[0]?.status, 'refused')
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(purchaseCalls, 1)
      await store.confirmPurchase(quoted.quote_id)
      assert.equal(purchaseCalls, 2)
    })
  }

  test('preserves exact refusal and scope details for the page', async () => {
    handler = () => {
      const error: any = new Error('scope')
      error.status = 401
      error.data = {
        code: 'CONTENT_STORE_SCOPE_REQUIRED',
        detail: 'The active GenStudio key was not accepted for required content:purchase access.',
      }
      throw error
    }
    const store = useContentStore()
    await assert.rejects(store.confirmPurchase('cq_1'))
    assert.equal(store.error.value?.status, 401)
    assert.equal(store.error.value?.code, 'CONTENT_STORE_SCOPE_REQUIRED')
    assert.match(store.error.value?.detail || '', /content:purchase/)
  })
})

describe('Content Store renderer contract', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/content-store.vue', import.meta.url)), 'utf8')
  const card = readFileSync(fileURLToPath(new URL('../components/content-store/ContentProductCard.vue', import.meta.url)), 'utf8')
  const dialog = readFileSync(fileURLToPath(new URL('../components/content-store/ContentPurchaseDialog.vue', import.meta.url)), 'utf8')
  const home = readFileSync(fileURLToPath(new URL('../pages/index.vue', import.meta.url)), 'utf8')
  const dashboard = readFileSync(fileURLToPath(new URL('../layouts/dashboard.vue', import.meta.url)), 'utf8')

  test('shows only remote products with Discover and Owned views and the healthy empty state', () => {
    assert.match(page, /role="tablist"/)
    assert.match(page, /label: 'Discover'/)
    assert.match(page, /label: 'Owned'/)
    assert.match(page, /The Content Store is ready, but no packs have been published yet\./)
    assert.doesNotMatch(page + card, /starter entries|preview gallery|license terms|>Download<|>Install<|>Restore<|portal URL/i)
  })

  test('describes Phase 1 as permanent ownership without promising pack delivery', () => {
    assert.match(page, /permanently owned by your GenStudio account/)
    assert.doesNotMatch(page, /delivered by GenStudio/i)
  })

  test('presents total and content-spendable balances as distinct account facts', () => {
    assert.match(page, /contentSpendableCredits/)
    assert.match(page, /availableCredits/)
    assert.match(page, /Spendable on content/)
    assert.match(page, /Total available/)
  })

  test('covers every product kind and blocks incompatible checkout', () => {
    for (const label of ['Series Formula', 'Topic Pack', 'Visual Style', 'Thumbnail Recipe', 'Niche Bundle']) {
      assert.match(card, new RegExp(label))
    }
    assert.match(card, /compatibilityReason/)
    assert.match(card, /See exact quote/)
    assert.match(card, /Get permanently/)
    assert.doesNotMatch(card, /@click="[^\"]*purchase/i)
  })

  test('shows exact quote ceiling, discount, balances, expiry, and safe insufficient-credit action', () => {
    assert.match(dialog, /Permanent ownership for this GenStudio account/)
    assert.match(dialog, /Base price/)
    assert.match(dialog, /Owned-content discount/)
    assert.match(dialog, /Maximum deduction/)
    assert.match(dialog, /Content-spendable balance/)
    assert.match(dialog, /After purchase/)
    assert.match(dialog, /final charge may be lower/i)
    assert.match(dialog, /shortfall_credits|shortfallCredits/)
    assert.match(dialog, /to="\/usage"/)
    assert.match(dialog, /View credits/)
  })

  test('uses shared Modal with a non-spending initial focus target and truthful Phase 1 outcomes', () => {
    assert.match(dialog, /<Modal/)
    assert.match(dialog, /ref="cancelButton"/)
    assert.match(dialog, /cancelButton\.value\?\.focus/)
    assert.match(dialog, /Owned in GenStudio · not installed on this Mac/)
    assert.match(dialog, /Receipt cached · verification arrives with Phase 2/)
    assert.match(dialog, /No replacement was sent/)
    assert.match(dialog, /Retry this purchase/)
    assert.match(dialog, /store is not open yet/i)
    assert.match(dialog, /credits_charged|creditsCharged/)
    assert.match(dialog, /attempt\.status === 'refused'/)
    assert.doesNotMatch(dialog, /No purchase was sent/)
    assert.match(dialog, /refused before any debit or ownership change/)
  })

  test('keeps the quote trigger focusable while its request is in flight so Modal can restore focus', () => {
    assert.match(card, /:aria-busy="busy \? 'true' : undefined"/)
    assert.doesNotMatch(card, /:disabled="busy"/)
  })

  test('adds global and project navigation without disturbing the existing mobile trap', () => {
    assert.match(home, /to="\/content-store"[^>]*>Content Store</)
    assert.match(dashboard, /to="\/content-store"[^>]*>Content Store</)
    assert.match(dashboard, /closeMobileNav/)
    assert.match(dashboard, /focusableSidebarItems/)
  })
})
