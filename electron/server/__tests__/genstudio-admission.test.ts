import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenStudioAdmissionPool,
  type GenStudioAccountCapacity,
} from '../lib/genstudio-admission.js'

const capacity = (
  overrides: Partial<GenStudioAccountCapacity> = {},
): GenStudioAccountCapacity => ({
  paid_concurrency_limit: 3,
  paid_active_jobs: 0,
  paid_queued_jobs: 0,
  max_queued_jobs: 25,
  generation_submissions_per_minute: 30,
  relaxed_concurrency_limit: 1,
  ...overrides,
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('one FIFO scheduler is shared across modalities and API keys', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity())
  const releases = Array.from({ length: 5 }, deferred)
  const started: string[] = []
  const operations = ['chat', 'image', 'tts', 'transcription', 'video']

  const jobs = releases.map((gate, index) => pool.run(
    index % 2 ? 'second-key-same-account' : 'first-key',
    undefined,
    async () => {
      started.push(operations[index]!)
      await gate.promise
      return index
    },
  ))

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['chat', 'image', 'tts'])
  assert.equal(pool.snapshot().local_waiting, 2)
  assert.equal(pool.snapshot().submitting, 3)
  assert.equal(pool.snapshot().paid_concurrency_limit, 3)

  releases[0]!.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['chat', 'image', 'tts', 'transcription'])

  for (const gate of releases.slice(1)) gate.resolve()
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4])
  assert.equal(pool.snapshot().submitting, 0)
})

test('account queue backpressure pauses new submissions until overview refreshes', async () => {
  let reads = 0
  const pool = new GenStudioAdmissionPool(async () => {
    reads += 1
    return reads === 1
      ? capacity({ paid_queued_jobs: 24, max_queued_jobs: 25 })
      : capacity({ paid_queued_jobs: 5, max_queued_jobs: 25 })
  }, 60_000, 10)
  const states: string[] = []
  let submitted = false
  const job = pool.run('one-account-key', undefined, async () => {
    submitted = true
  }, state => { states.push(state) })

  await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(submitted, false)
  assert.equal(pool.snapshot().queue_near_capacity, true)
  assert.ok(states.includes('waiting_account_capacity'))

  await pool.refreshNow('one-account-key')
  await job
  assert.equal(submitted, true)
})

test('GenStudio admission fails closed when account overview is unavailable', async () => {
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
  assert.equal(pool.snapshot().submitting, 1)
  assert.equal(pool.snapshot().local_waiting, 1)
  assert.equal(pool.snapshot().limitSource, 'safe-fallback')
  firstGate.resolve()
  await first
  await second
  assert.equal(secondStarted, true)
})

test('a cancelled locally queued request never reaches GenStudio', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({ paid_concurrency_limit: 1 }))
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

test('accepted remote work releases local submission capacity immediately', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({ paid_concurrency_limit: 1 }))
  const firstAccepted = deferred()
  const secondAccepted = deferred()
  const started: number[] = []
  const first = pool.run('key', undefined, async () => {
    started.push(1)
    firstAccepted.resolve()
    return { state: 'accepted' }
  })
  await firstAccepted.promise
  const second = pool.run('key', undefined, async () => {
    started.push(2)
    secondAccepted.resolve()
    return { state: 'accepted' }
  })
  await secondAccepted.promise
  await Promise.all([first, second])
  assert.deepEqual(started, [1, 2])
})

test('rolling account submission limit prevents local bursts across every modality', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({
    paid_concurrency_limit: 10,
    generation_submissions_per_minute: 1,
  }))
  let submissions = 0
  await pool.run('same-account', undefined, async () => {
    submissions += 1
    return { state: 'accepted' }
  })

  const controller = new AbortController()
  let secondSubmitted = false
  const second = pool.run('another-key-same-account', controller.signal, async () => {
    secondSubmitted = true
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(submissions, 1)
  assert.equal(secondSubmitted, false)
  assert.equal(pool.snapshot().submissions_in_window, 1)
  assert.equal(pool.snapshot().local_waiting, 1)

  controller.abort()
  await assert.rejects(second, /Cancelled by user/)
})

test('one account-wide release failure rejects every unsent modality', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({ paid_concurrency_limit: 1 }))
  const firstGate = deferred()
  const first = pool.run('same-account', undefined, async () => firstGate.promise)
  let imageSubmitted = false
  let transcriptionSubmitted = false
  const image = pool.run('same-account', undefined, async () => {
    imageSubmitted = true
  })
  const transcription = pool.run('another-key-same-account', undefined, async () => {
    transcriptionSubmitted = true
  })
  await new Promise(resolve => setImmediate(resolve))

  const releaseError = new Error('GenStudio release is not generation-ready')
  pool.noteGlobalFailure(releaseError, 60_000)

  await assert.rejects(image, /not generation-ready/)
  await assert.rejects(transcription, /not generation-ready/)
  assert.equal(imageSubmitted, false)
  assert.equal(transcriptionSubmitted, false)
  assert.equal(pool.snapshot().submissions_blocked, true)
  assert.match(pool.snapshot().submission_block_reason || '', /not generation-ready/)

  firstGate.resolve()
  await first
})
