/**
 * The app-wide install queue (v1.4.152).
 *
 * Owner report 2026-09-12: no install status, and no way to know whether
 * leaving the Content Store cancels anything. The queue is now one shared
 * instance; every consumer sees the same counts; each install skips the
 * server's overview rebuild and the queue re-reads the overview once when it
 * drains. This drives the real composable against a stubbed `$fetch`.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { nextTick } from 'vue'

type Call = { path: string; options: Record<string, unknown> }
let calls: Call[] = []
let releaseInstall!: (releaseId: string) => void
const pendingInstalls = new Map<string, () => void>()
let monitoredOperation: any = null
let monitorFailures = 0
const overview = {
  phase: 'delivery_ready', origin: 'https://catalog.example.test',
  account: { accountId: 'acct_a', contentAccountId: 'content_a', availableCredits: 10, contentSpendableCredits: 10, owned: [] },
  products: [
    { productId: 'p1', entitlementFamily: 'f1', kind: 'topic_pack', title: 'Pack One', summary: '', description: '', publisherId: 'x', creditPrice: 300, free: false, owned: true, retired: false, successorProductId: null, compatible: true, compatibilityReason: null, currentRelease: { releaseId: 'rel-1', packId: 'pack-1', version: '1.0.0', archiveSha256: 'a'.repeat(64), archiveBytes: 1, archiveAvailable: true, minStoryVersion: '1.0.0', changelog: '', componentSummary: {} }, bundleComponents: [], ownedComponentCreditValue: 0, presentation: { cover: null, licenseLabel: '', tags: [] }, discount: null },
  ],
  shelves: [], attempts: [],
  capabilities: { purchase: true, receipt_verification: true, download: true, install_after_purchase: true, restore: true },
}
;(globalThis as any).$fetch = async (path: string, options: Record<string, unknown> = {}) => {
  calls.push({ path, options })
  if (path === '/api/content-store') return structuredClone(overview)
  if (path === '/api/content-store/installs/op-progress') {
    if (monitorFailures > 0) {
      monitorFailures -= 1
      throw Object.assign(new Error('temporary monitor outage'), { status: 503 })
    }
    return { operation: structuredClone(monitoredOperation) }
  }
  const install = path.match(/^\/api\/content-store\/releases\/([^/?]+)\/install(\?.*)?$/)
  if (install) {
    const releaseId = decodeURIComponent(install[1]!)
    if (releaseId === 'rel-progress') return { operation: structuredClone(monitoredOperation) }
    await new Promise<void>(resolve => { pendingInstalls.set(releaseId, resolve) })
    if (releaseId === 'rel-bad') throw Object.assign(new Error('boom'), { data: { code: 'CONTENT_PACK_SIGNATURE_INVALID', detail: 'bad' } })
    return { install: { pack_id: 'pack', version: '1.0.0', activated: true }, overview: null }
  }
  throw new Error(`Unexpected request: ${path}`)
}
releaseInstall = (releaseId: string) => { pendingInstalls.get(releaseId)?.(); pendingInstalls.delete(releaseId) }
const { _clearContentStoreSessionCacheForTests } = await import('../composables/useContentStore.js')
const { useContentInstallQueue, _resetContentInstallQueueForTests } = await import('../composables/useContentInstallQueue.js')

async function settle(): Promise<void> { for (let i = 0; i < 8; i++) { await nextTick(); await Promise.resolve() } }

beforeEach(() => {
  _clearContentStoreSessionCacheForTests(); _resetContentInstallQueueForTests(); calls = []; pendingInstalls.clear()
  monitoredOperation = null; monitorFailures = 0
})

describe('shared Content Pack install queue', () => {
  test('is one queue for every consumer, asks for installs without the overview, and refreshes once when it drains', async () => {
    const page = useContentInstallQueue()
    const strip = useContentInstallQueue()
    assert.equal(page, strip, 'the Store page and the global strip read the same queue')
    page.enqueueAll(['rel-1', 'rel-2', 'rel-bad'])
    await settle()
    assert.equal(page.batchTotal.value, 3)
    assert.equal(page.statusOf('rel-1'), 'installing')
    assert.equal(page.statusOf('rel-2'), 'queued')
    assert.equal(strip.running.value, true)
    const first = calls.find(call => call.path.includes('/releases/rel-1/install'))!
    assert.match(first.path, /[?&]overview=0(?:&|$)/, 'the queue never asks the server to rebuild the overview per pack')
    assert.equal(calls.filter(call => call.path === '/api/content-store').length, 0)

    releaseInstall('rel-1'); await settle()
    assert.equal(strip.batchDone.value, 1)
    assert.equal(page.statusOf('rel-1'), 'installed')
    releaseInstall('rel-2'); await settle()
    releaseInstall('rel-bad'); await settle()
    assert.equal(page.running.value, false)
    assert.equal(page.finished.value, true)
    assert.equal(page.batchInstalled.value, 2)
    assert.equal(page.batchFailed.value, 1)
    assert.equal(page.statusOf('rel-bad'), 'failed')
    // Exactly one overview read for the whole run.
    assert.equal(calls.filter(call => call.path === '/api/content-store').length, 1)
    // The failure's reason is kept per release, in the Store's words.
    assert.match(page.failureOf('rel-bad'), /bad|could not be installed/i)
    assert.equal(page.failures.value.length, 1)
    assert.equal(page.failures.value[0]!.releaseId, 'rel-bad')
    // A later run starts its own count.
    page.clearFinished()
    assert.equal(page.failureOf('rel-bad'), '')
    page.enqueue('rel-1'); await settle()
    assert.equal(page.batchTotal.value, 1)
    assert.equal(page.batchDone.value, 0)
    releaseInstall('rel-1'); await settle()
  })

  test('a long run re-reads the overview every eight installs, and that read is applied', async () => {
    const queue = useContentInstallQueue()
    const { useContentStore } = await import('../composables/useContentStore.js')
    const store = useContentStore()
    assert.equal(store.account.value, null, 'nothing loaded yet')
    const ids = Array.from({ length: 9 }, (_, i) => `rel-${i + 1}`)
    queue.enqueueAll(ids)
    for (const id of ids.slice(0, 8)) { await settle(); releaseInstall(id) }
    await settle()
    assert.equal(calls.filter(call => call.path === '/api/content-store').length, 1, 'one mid-run refresh after eight installs')
    assert.equal(queue.running.value, true, 'the ninth install is still in flight')
    assert.notEqual(store.account.value, null, 'the mid-run refresh was applied while the queue kept running')
    releaseInstall('rel-9'); await settle()
    assert.equal(calls.filter(call => call.path === '/api/content-store').length, 2, 'one more when the queue drains')
  })

  test('keeps the shared navigation-visible install active through a transient progress poll failure', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    monitoredOperation = {
      operationId: 'op-progress', releaseId: 'rel-progress', phase: 'queued', downloadedBytes: null, totalBytes: null,
      failure: null, install: null, updatedAt: new Date().toISOString(),
    }
    const page = useContentInstallQueue()
    const elsewhere = useContentInstallQueue()
    page.enqueue('rel-progress')
    await settle()
    assert.equal(page, elsewhere, 'leaving the Store reads the same live operation')
    assert.equal(page.statusOf('rel-progress'), 'installing')
    assert.equal(page.activeProgress.value?.phase, 'queued')

    monitorFailures = 1
    t.mock.timers.tick(1_000)
    await settle()
    assert.equal(page.statusOf('rel-progress'), 'installing', 'a transient monitor outage does not abandon the server install')
    page.enqueue('rel-progress')
    assert.equal(page.pendingCount.value, 1, 'a retry click cannot duplicate the active operation')

    monitoredOperation = {
      ...monitoredOperation, phase: 'complete',
      install: { pack_id: 'pack', version: '1.0.0', activated: true }, updatedAt: new Date().toISOString(),
    }
    t.mock.timers.tick(1_000)
    await settle()
    assert.equal(page.statusOf('rel-progress'), 'installed')
  })
})
