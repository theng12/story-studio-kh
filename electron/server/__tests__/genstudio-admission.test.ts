import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenStudioAdmissionPool,
  type GenStudioAccountCapacity,
} from '../lib/genstudio-admission.js'

const capacity = (
  overrides: Partial<GenStudioAccountCapacity> = {},
): GenStudioAccountCapacity => ({
  credit_balance: 250,
  paid_concurrency_limit: 3,
  paid_active_jobs: 0,
  paid_queued_jobs: 0,
  max_queued_jobs: 25,
  generation_submissions_per_minute: 30,
  ...overrides,
})

test('insufficient credits reject same-key waiters without touching another key', async () => {
  const pool = new GenStudioAdmissionPool(async apiKey => capacity({
    credit_balance: apiKey === 'low-key' ? 76 : 20_000,
    paid_concurrency_limit: 1,
  }))
  const activeGate = deferred()
  const active = pool.run('low-key', undefined, async () => activeGate.promise)
  let sameKeySubmitted = false
  let fullKeySubmitted = false
  const sameKey = pool.run('low-key', undefined, async () => { sameKeySubmitted = true })
  const fullKey = pool.run('full-key', undefined, async () => { fullKeySubmitted = true })

  await new Promise(resolve => setImmediate(resolve))
  pool.noteInsufficientCredits('low-key', new Error('insufficient credits'))

  await assert.rejects(sameKey, /insufficient credits/)
  assert.equal(sameKeySubmitted, false)
  assert.equal(fullKeySubmitted, true, 'an unrelated key keeps its own admission capacity')

  activeGate.resolve()
  await active
  await fullKey
  assert.equal(fullKeySubmitted, true)
})

test('a 402 cannot race another queued same-key request into dispatch', async () => {
  const entered: Array<() => void> = []
  const pool = new GenStudioAdmissionPool(async () => ({
    credit_balance: 76,
    paid_concurrency_limit: 1,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 100,
    generation_submissions_per_minute: 120,
  }))
  let submissions = 0
  const run = () => pool.run('low-key', undefined, async () => {
    submissions++
    await new Promise<void>(resolve => entered.push(resolve))
  })
  const first = run()
  const second = run()
  const third = run()
  await new Promise(resolve => setImmediate(resolve))
  pool.noteInsufficientCredits('low-key', new Error('insufficient credits'))
  for (const resolve of entered) resolve()
  await Promise.allSettled([first, second, third])

  assert.equal(submissions, 1, 'only the already-dispatched request may settle')
  await assert.rejects(run(), /insufficient credits/)
  assert.equal(submissions, entered.length, 'no held request may enter work')
})

test('held key stays blocked until an authoritative balance increase', async () => {
  let balance = 76
  let reads = 0
  const pool = new GenStudioAdmissionPool(async () => {
    reads += 1
    return capacity({ credit_balance: balance })
  }, 60_000, 10)
  await pool.refreshNow('same-key')
  pool.noteInsufficientCredits('same-key', new Error('add credits, then Retry'))

  let unchangedSubmitted = false
  await assert.rejects(
    pool.run('same-key', undefined, async () => { unchangedSubmitted = true }),
    /add credits, then Retry/,
  )
  assert.equal(unchangedSubmitted, false)

  balance = 2_000
  let replenishedSubmitted = false
  await pool.run('same-key', undefined, async () => { replenishedSubmitted = true })

  assert.equal(replenishedSubmitted, true)
  assert.ok(reads >= 3, 'held admission performs a fresh authoritative balance read')
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('each API key preserves its own FIFO order while using independent capacity slots', async () => {
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
  assert.equal(started.length, operations.length)
  assert.deepEqual(
    started.filter(operation => ['chat', 'tts', 'video'].includes(operation)),
    ['chat', 'tts', 'video'],
  )
  assert.deepEqual(
    started.filter(operation => ['image', 'transcription'].includes(operation)),
    ['image', 'transcription'],
  )
  const firstSnapshot = pool.snapshot('first-key')
  const secondSnapshot = pool.snapshot('second-key-same-account')
  assert.equal(firstSnapshot.local_waiting + secondSnapshot.local_waiting, 0)
  assert.equal(firstSnapshot.submitting + secondSnapshot.submitting, 5)
  assert.equal(firstSnapshot.paid_concurrency_limit, 3)

  for (const gate of releases) gate.resolve()
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4])
  assert.equal(pool.snapshot('first-key').submitting + pool.snapshot('second-key-same-account').submitting, 0)
})

test('an exhausted key does not throttle an unrelated key', async () => {
  const pool = new GenStudioAdmissionPool(async apiKey => capacity({
    paid_concurrency_limit: apiKey === 'key-a' ? 1 : 2,
    generation_submissions_per_minute: apiKey === 'key-a' ? 1 : 2,
  }))
  const firstGate = deferred()
  const secondKeyGates = [deferred(), deferred()]
  const started: string[] = []
  const controller = new AbortController()
  const first = pool.run('key-a', undefined, async () => {
    started.push('key-a-1')
    await firstGate.promise
  })
  const blocked = pool.run('key-a', controller.signal, async () => {
    started.push('key-a-2')
  })
  const secondKeyJobs = secondKeyGates.map((gate, index) => pool.run('key-b', undefined, async () => {
    started.push(`key-b-${index + 1}`)
    await gate.promise
  }))

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['key-a-1', 'key-b-1', 'key-b-2'])
  assert.equal(pool.snapshot('key-a').submitting, 1)
  assert.equal(pool.snapshot('key-a').local_waiting, 1)
  assert.equal(pool.snapshot('key-a').submissions_in_window, 1)
  assert.equal(pool.snapshot('key-b').submitting, 2)
  assert.equal(pool.snapshot('key-b').local_waiting, 0)
  assert.equal(pool.snapshot('key-b').submissions_in_window, 2)

  controller.abort()
  await assert.rejects(blocked, /Cancelled by user/)
  firstGate.resolve()
  for (const gate of secondKeyGates) gate.resolve()
  await Promise.all([first, ...secondKeyJobs])
})

test('capacity snapshots stay isolated when API keys publish different bursts', async () => {
  const pool = new GenStudioAdmissionPool(async apiKey => capacity({
    paid_concurrency_limit: apiKey === 'key-a' ? 1 : 5,
    burst_concurrency_ceiling: apiKey === 'key-a' ? 2 : 8,
  }))

  await pool.refreshNow('key-a')
  assert.equal(pool.snapshot('key-a').burst_concurrency_ceiling, 2)
  await pool.refreshNow('key-b')
  assert.equal(pool.snapshot('key-b').burst_concurrency_ceiling, 8)
  assert.equal(pool.snapshot('key-a').burst_concurrency_ceiling, 2)
  assert.equal(pool.snapshot('key-a').paid_concurrency_limit, 1)
  assert.equal(pool.snapshot('key-b').paid_concurrency_limit, 5)
})

test('the live dispatch width uses available standard lanes capped by the published burst', async () => {
  let overview = capacity({
    paid_concurrency_limit: 5,
    paid_active_jobs: 2,
    burst_concurrency_ceiling: 2,
  })
  const pool = new GenStudioAdmissionPool(async () => overview)

  await pool.refreshNow('permit-width-key')
  assert.equal(await pool.currentDispatchLimit('permit-width-key'), 2)

  overview = capacity({
    paid_concurrency_limit: 5,
    paid_active_jobs: 4,
    burst_concurrency_ceiling: 8,
  })
  await pool.refreshNow('permit-width-key')
  assert.equal(await pool.currentDispatchLimit('permit-width-key'), 1)
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
  assert.equal(pool.snapshot('one-account-key').queue_near_capacity, true)
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
  assert.equal(pool.snapshot('scoped-key').submitting, 1)
  assert.equal(pool.snapshot('scoped-key').local_waiting, 1)
  assert.equal(pool.snapshot('scoped-key').limitSource, 'safe-fallback')
  assert.equal(pool.snapshot('scoped-key').capacity_verified, false)
  assert.equal(pool.snapshot('scoped-key').generation_submissions_per_minute, 5)
  firstGate.resolve()
  await first
  await second
  assert.equal(secondStarted, true)
})

for (const [value, label] of [
  [null, 'null'],
  ['', 'an empty string'],
  [false, 'false'],
  [0, 'zero'],
  [-1, 'a negative value'],
  [0.5, 'a fraction below one'],
  [7.5, 'a non-whole number above one'],
  ['999', 'a numeric string'],
  [Number.NaN, 'NaN'],
] as const) {
  test(`GenStudio admission falls back to five for ${label} submission rate`, async () => {
    const pool = new GenStudioAdmissionPool(async () => capacity({
      generation_submissions_per_minute: value as number,
    }))

    await pool.refreshNow('malformed-overview-key')

    assert.equal(pool.snapshot('malformed-overview-key').limitSource, 'account-overview')
    assert.equal(pool.snapshot('malformed-overview-key').capacity_verified, false)
    assert.equal(pool.snapshot('malformed-overview-key').generation_submissions_per_minute, 5)
  })
}

test('GenStudio admission preserves a valid published submission rate', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({
    generation_submissions_per_minute: 7,
  }))

  await pool.refreshNow('published-overview-key')

  assert.equal(pool.snapshot('published-overview-key').generation_submissions_per_minute, 7)
  assert.equal(pool.snapshot('published-overview-key').capacity_verified, true)
})

test('GenStudio admission preserves valid capacity display facts without admitting above standard lanes', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({
    paid_concurrency_limit: 1,
    burst_concurrency_ceiling: 4,
    service_tier: {
      current: {
        code: 'tier_1', display_name: '$5 tier', threshold_cents: 500,
        paid_concurrency_limit: 1, max_queued_jobs: 25,
        generation_submissions_per_minute: 30, max_api_keys: 2,
      },
      ladder: {
        code: 'tier_1', display_name: '$5 tier', threshold_cents: 500,
        paid_concurrency_limit: 1, max_queued_jobs: 25,
        generation_submissions_per_minute: 30, max_api_keys: 2,
      },
      overridden: false,
      lifetime_paid_cents: 500,
      next_tier: null,
      cents_to_next_tier: null,
    },
  }))
  const firstGate = deferred()
  const started: number[] = []
  const first = pool.run('capacity-key', undefined, async () => {
    started.push(1)
    await firstGate.promise
  })
  const controller = new AbortController()
  const second = pool.run('capacity-key', controller.signal, async () => { started.push(2) })

  await new Promise(resolve => setImmediate(resolve))

  const snapshot = pool.snapshot('capacity-key') as any
  assert.equal(snapshot.burst_concurrency_ceiling, 4)
  assert.equal(snapshot.service_tier.current.display_name, '$5 tier')
  assert.deepEqual(started, [1])

  controller.abort()
  await assert.rejects(second, /Cancelled by user/)
  firstGate.resolve()
  await first
})

test('GenStudio admission omits malformed capacity display facts and fallback metadata', async () => {
  const malformed = new GenStudioAdmissionPool(async () => capacity({
    burst_concurrency_ceiling: 0,
    service_tier: { current: { display_name: '$5 tier' } } as any,
  }))
  await malformed.refreshNow('malformed-display-key')
  assert.equal((malformed.snapshot('malformed-display-key') as any).burst_concurrency_ceiling, undefined)
  assert.equal((malformed.snapshot('malformed-display-key') as any).service_tier, undefined)

  const fallback = new GenStudioAdmissionPool(async () => { throw new Error('offline') })
  await fallback.refreshNow('fallback-display-key')
  assert.equal((fallback.snapshot('fallback-display-key') as any).burst_concurrency_ceiling, undefined)
  assert.equal((fallback.snapshot('fallback-display-key') as any).service_tier, undefined)
})

test('a malformed published submission rate admits five requests before rate limiting the sixth', async () => {
  const pool = new GenStudioAdmissionPool(async () => capacity({
    paid_concurrency_limit: 10,
    generation_submissions_per_minute: 0,
  }))
  const gates = Array.from({ length: 5 }, deferred)
  const started: number[] = []
  const controller = new AbortController()
  const jobs = Array.from({ length: 6 }, (_, index) => pool.run(
    'malformed-rate-key',
    index === 5 ? controller.signal : undefined,
    async () => {
      started.push(index)
      await gates[index]!.promise
    },
  ))

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  assert.equal(pool.snapshot('malformed-rate-key').submissions_in_window, 5)
  assert.equal(pool.snapshot('malformed-rate-key').local_waiting, 1)

  controller.abort()
  await assert.rejects(jobs[5], /Cancelled by user/)
  for (const gate of gates) gate.resolve()
  await Promise.all(jobs.slice(0, 5))
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
  const second = pool.run('same-account', controller.signal, async () => {
    secondSubmitted = true
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(submissions, 1)
  assert.equal(secondSubmitted, false)
  assert.equal(pool.snapshot('same-account').submissions_in_window, 1)
  assert.equal(pool.snapshot('same-account').local_waiting, 1)

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
  const transcription = pool.run('same-account', undefined, async () => {
    transcriptionSubmitted = true
  })
  await new Promise(resolve => setImmediate(resolve))

  const releaseError = new Error('GenStudio release is not generation-ready')
  pool.noteGlobalFailure(releaseError, 60_000)

  await assert.rejects(image, /not generation-ready/)
  await assert.rejects(transcription, /not generation-ready/)
  assert.equal(imageSubmitted, false)
  assert.equal(transcriptionSubmitted, false)
  assert.equal(pool.snapshot('same-account').submissions_blocked, true)
  assert.match(pool.snapshot('same-account').submission_block_reason || '', /not generation-ready/)

  firstGate.resolve()
  await first
})
