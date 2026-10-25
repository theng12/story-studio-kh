/**
 * Studio Library background work — source contract.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const page = read('../pages/library.vue')
const layout = read('../layouts/default.vue')
const card = read('../components/content-store/ContentProductCard.vue')
const shelf = read('../components/content-store/ContentStoreShelf.vue')

describe('Studio Library background work', () => {
  test('the page uses the shared install queue and the layout shows it everywhere', () => {
    assert.match(page, /const installQueue = useContentInstallQueue\(\)/)
    assert.doesNotMatch(page, /useInstallQueue\(/)
    assert.match(layout, /<ContentInstallStrip/)
    // Project pages too (audit leftovers): installs show there as well.
    assert.match(read('../layouts/dashboard.vue'), /<ContentInstallStrip class="dashboard-install-strip" \/>/)
    assert.match(page, /You can leave this page; installs continue\./)
  })
  test('the page carries no purchase or bulk-selection machinery', () => {
    assert.doesNotMatch(page, /useBatchPurchase|batchSkipReason|confirmPurchase|requestQuote/)
    assert.doesNotMatch(page, /selectedProductIds|Select all/)
    assert.doesNotMatch(page, /ContentPurchaseDialog|ContentBatchPurchaseDialog/)
  })
  test('every card names its queue state at the top, on Discover shelves too', () => {
    assert.match(card, /if \(props\.queueStatus === 'queued'\) return 'Queued to install'/)
    assert.match(card, /:data-queue-status="queueStatus === 'idle' \? undefined : queueStatus"/)
    assert.match(shelf, /:queue-status="queueStatusFor\(product\)"/)
  })
})
