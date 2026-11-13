/**
 * Dreamlands E2E: "Install all missing" with the Gateway unavailable failed all 168 packs one by one
 * and ended with "168 installs failed. Open the pack and try again." A failure every pack would share
 * now stops the batch with one plain message; one bad pack still lets the rest install.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { useInstallQueue } from '../composables/useInstallQueue'
import { systematicInstallFailure } from '../content-store/library-organisation'

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('a systematic failure stops the batch; the rest are not attempted', async () => {
  const tried: string[] = []
  let stop = false
  const queue = useInstallQueue(async (id) => {
    tried.push(id)
    if (id === 'a') { stop = true; throw new Error('gateway') }
  }, () => stop)
  queue.enqueueAll(['a', 'b', 'c'])
  for (let i = 0; i < 10; i++) await settle()
  assert.deepEqual(tried, ['a'])
  assert.equal(queue.statusOf('a'), 'failed')
  assert.equal(queue.statusOf('b'), 'idle')
  assert.equal(queue.running.value, false)
})

test('a one-pack failure keeps going', async () => {
  const tried: string[] = []
  const queue = useInstallQueue(async (id) => { tried.push(id); if (id === 'a') throw new Error('bad pack') }, () => false)
  queue.enqueueAll(['a', 'b', 'c'])
  for (let i = 0; i < 10; i++) await settle()
  assert.deepEqual(tried, ['a', 'b', 'c'])
})

test('which failures are systematic, in plain words', () => {
  assert.match(systematicInstallFailure({ code: 'GATEWAY_UNREACHABLE' })!, /Gateway is not answering/)
  assert.match(systematicInstallFailure({ code: 'CONTENT_STORE_SCOPE_REQUIRED', status: 401 })!, /Gateway did not accept/)
  assert.match(systematicInstallFailure({ code: 'CONTENT_STORE_UNAVAILABLE', status: 401 })!, /Gateway did not accept/)
  assert.match(systematicInstallFailure({ code: 'GATEWAY_UNREACHABLE', status: 503 })!, /not answering/)
  assert.match(systematicInstallFailure({ code: 'CONTENT_PACK_DISK_UNAVAILABLE' })!, /out of disk space/)
  assert.match(systematicInstallFailure({ code: 'x', detail: 'ENOSPC: no space left on device' })!, /out of disk space/)
  assert.equal(systematicInstallFailure({ code: 'CONTENT_PACK_SIGNATURE_INVALID' }), null)
  assert.equal(systematicInstallFailure({ code: 'release_recalled', status: 410 }), null)
  assert.equal(systematicInstallFailure(null), null)
})

test('the shared queue wires the stop and every surface shows the one message', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const queue = read('../composables/useContentInstallQueue.ts')
  assert.match(queue, /halt\.value = systematicInstallFailure\(known\) \?\? ''/)
  assert.match(queue, /\}, \(\) => halt\.value !== ''\)/)
  assert.match(read('../components/content-store/ContentLibraryView.vue'), /v-if="haltReason" class="install-all-status">Stopped early\. \{\{ haltReason \}\}/)
  assert.match(read('../components/content-store/ContentInstallStrip.vue'), /stopped early\. \{\{ queue\.haltReason\.value \}\}/)
  assert.match(read('../pages/library.vue'), /stopped early\. \{\{ installQueue\.haltReason\.value \}\}/)
})
