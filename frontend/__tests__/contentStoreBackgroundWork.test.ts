/**
 * Content Store background work and bulk selection (v1.4.152) — source contract.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const page = read('../pages/content-store.vue')
const dialog = read('../components/content-store/ContentBatchPurchaseDialog.vue')
const layout = read('../layouts/default.vue')
const card = read('../components/content-store/ContentProductCard.vue')
const shelf = read('../components/content-store/ContentStoreShelf.vue')

describe('Content Store background work', () => {
  test('the page uses the shared install queue and the layout shows it everywhere', () => {
    assert.match(page, /const installQueue = useContentInstallQueue\(\)/)
    assert.doesNotMatch(page, /useInstallQueue\(/)
    assert.match(layout, /<ContentInstallStrip/)
    assert.match(page, /You can leave this page; installs continue\./)
  })
  test('Discover offers Select all for every purchasable pack, behind the same one-confirmation batch', () => {
    assert.match(page, /Select all \{\{ purchasableVisible\.length \}\} purchasable/)
    assert.match(page, /const purchasableVisible = computed\(\(\) => filteredProducts\.value\.filter\(product => batchSkipReason\(product\) === null\)\)/)
  })
  test('a batch purchase can be hidden while it buys, keeps buying, and reads the overview once', () => {
    assert.match(dialog, /function requestClose\(\): void \{ if \(props\.busy\) emit\('dismiss'\); else emit\('close'\) \}/)
    assert.doesNotMatch(dialog, /class="dialog-close"\s*:disabled="busy"/)
    assert.match(page, /if \(batch\.busy\.value\) \{ batch\.dismiss\(\); return \}/)
    assert.match(page, /confirm: quoteId => store\.confirmPurchase\(quoteId, \{ refreshOverview: false \}\)/)
    assert.match(page, /in the background\./)
  })
  test('every card names its queue state at the top, on Discover shelves too', () => {
    assert.match(card, /if \(props\.queueStatus === 'queued'\) return 'Queued to install'/)
    assert.match(card, /:data-queue-status="queueStatus === 'idle' \? undefined : queueStatus"/)
    assert.match(shelf, /:queue-status="queueStatusFor\(product\)"/)
  })
})
