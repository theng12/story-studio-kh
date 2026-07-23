import assert from 'node:assert/strict'
import test from 'node:test'
import { GenStudioAdmissionPool } from '../lib/genstudio-admission.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('GenStudio admission is FIFO and never exceeds the subscription limit', async () => {
  const pool = new GenStudioAdmissionPool(async () => 3)
  const releases = Array.from({ length: 7 }, deferred)
  const started: number[] = []
  let active = 0
  let maximumActive = 0

  const jobs = releases.map((gate, index) => pool.run('scoped-key', undefined, async () => {
    started.push(index)
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await gate.promise
    active -= 1
    return index
  }))

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, [0, 1, 2])
  assert.deepEqual(pool.snapshot(), {
    active: 3,
    queued: 4,
    limit: 3,
    limitSource: 'subscription',
  })

  releases[0]!.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, [0, 1, 2, 3])

  for (const gate of releases.slice(1)) gate.resolve()
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6])
  assert.equal(maximumActive, 3)
  assert.equal(pool.snapshot().active, 0)
})

test('GenStudio admission fails closed to one slot when entitlement lookup fails', async () => {
  const pool = new GenStudioAdmissionPool(async () => {
    throw new Error('usage scope unavailable')
  })
  const firstGate = deferred()
  let secondStarted = false
  const first = pool.run('scoped-key', undefined, async () => firstGate.promise)
  const second = pool.run('scoped-key', undefined, async () => {
    secondStarted = true
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)
  assert.deepEqual(pool.snapshot(), {
    active: 1,
    queued: 1,
    limit: 1,
    limitSource: 'safe-fallback',
  })
  firstGate.resolve()
  await first
  await second
  assert.equal(secondStarted, true)
})

test('a cancelled queued GenStudio request never reaches the provider', async () => {
  const pool = new GenStudioAdmissionPool(async () => 1)
  const firstGate = deferred()
  const first = pool.run('scoped-key', undefined, async () => firstGate.promise)
  const controller = new AbortController()
  let submitted = false
  const queued = pool.run('scoped-key', controller.signal, async () => {
    submitted = true
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(queued, /Cancelled by user/)
  assert.equal(submitted, false)
  firstGate.resolve()
  await first
})
