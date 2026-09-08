import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  generateImageWithGenStudio,
  listImageModels,
  normalizeGenStudioProviderQueue,
  refreshGenStudioAdmission,
} from '../lib/genstudio-client.js'
import { waitFor } from './_timing.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

function imageJob(body: Record<string, unknown>, id = 'image-task-1'): Record<string, unknown> {
  return {
    id,
    state: 'succeeded',
    model_id: body.model_id,
    prompt: body.prompt,
    width: 1024,
    height: 576,
    aspect_ratio: body.aspect_ratio,
    steps: 4,
    image_url: `/v1/images/${id}/file`,
  }
}

function request(overrides: Record<string, unknown> = {}): any {
  return {
    prompt: 'A quiet illustrated forest at night',
    modelId: 'fleet-image-v1',
    aspectRatio: '16:9',
    requestIdentity: `permit-test-${Math.random()}`,
    requiresAdmissionPermit: true,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function withFetch<T>(
  fetcher: typeof fetch,
  run: () => Promise<T>,
  accountCapacity: () => Record<string, unknown> = () => ({
    credit_balance: 250,
    paid_concurrency_limit: 1,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
  }),
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).endsWith('/v1/account/overview')) {
      return Response.json(accountCapacity())
    }
    return fetcher(input, init)
  }) as typeof fetch
  try { return await run() } finally { globalThis.fetch = original }
}

function accountCapacity(width: number, permitQueueWidth = 24, permitPace = 30): Record<string, unknown> {
  return {
    credit_balance: 250,
    paid_concurrency_limit: width,
    paid_active_jobs: 0,
    // Keep one published remote queue entry occupied so the final protective
    // reserve is intact while the fixture controls permit width by queue room.
    paid_queued_jobs: 1,
    max_queued_jobs: permitQueueWidth + 1,
    generation_submissions_per_minute: permitPace,
    burst_concurrency_ceiling: width,
  }
}

test('image catalogue preserves the published admission-permit flag and leaves absence undefined', async () => {
  let catalogCall = 0
  await withFetch((async (input: any) => {
    assert.match(String(input), /\/v1\/image\/models$/)
    catalogCall++
    return Response.json([{
      id: `fleet-${catalogCall}`,
      display_name: 'Fleet',
      available: true,
      qualification_only: false,
      credits_per_image: 1,
      base_credits_per_image: 1,
      minimum_credits: 1,
      price_version: 'test',
      aspect_ratios: ['16:9'],
      default_aspect_ratio: '16:9',
      supports_reference_images: false,
      max_reference_images: 0,
      reference_strength_mode: 'none',
      supported_reference_strengths: [],
      ...(catalogCall === 1 ? { requires_admission_permit: true } : {}),
    }])
  }) as typeof fetch, async () => {
    const [published] = await listImageModels('permit-catalog-published-key')
    const [legacy] = await listImageModels('permit-catalog-legacy-key')
    assert.equal(published?.requires_admission_permit, true)
    assert.equal(legacy?.requires_admission_permit, undefined)
  })
})

test('provider queue evidence preserves each independently published fact and clears invalid fields', () => {
  assert.deepEqual(normalizeGenStudioProviderQueue({ queue_position: 2, queue_eta_seconds: 120 }), {
    queue_position: 2,
    queue_eta_seconds: 120,
    queue_reason: null,
  })
  assert.deepEqual(normalizeGenStudioProviderQueue({ queue_position: 0, queue_eta_seconds: -1, queue_reason: 'provider_pace' }), {
    queue_position: null,
    queue_eta_seconds: null,
    queue_reason: 'provider_pace',
  })
})

test('permit operation maps references exactly and paid POST carries the opaque permit', async () => {
  const permitBodies: any[] = []
  const generationBodies: any[] = []
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitBodies.push(JSON.parse(String(init?.body)))
      return Response.json({ id: `permit-${permitBodies.length}` })
    }
    if (url.endsWith('/v1/images/generations')) {
      const body = JSON.parse(String(init?.body))
      generationBodies.push(body)
      return Response.json(imageJob(body), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('permit-operation-key', request({ referenceAssetIds: ['asset-1'] }))
  })
  assert.deepEqual(permitBodies, [{ model_id: 'fleet-image-v1', operation: 'image-to-image' }])
  assert.equal(generationBodies[0]?.admission_permit_id, 'permit-1')
})

test('same-scope permit acquisition uses the live available width and preserves exact permit keys', async () => {
  const gates = Array.from({ length: 3 }, () => deferred<Response>())
  const generationGates = Array.from({ length: 3 }, () => deferred<Response>())
  const permitKeys: string[] = []
  let overviewReads = 0
  let inFlight = 0
  let maxInFlight = 0
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      const index = permitKeys.length
      permitKeys.push(new Headers(init?.headers).get('Idempotency-Key') || '')
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return gates[index]!.promise.finally(() => { inFlight-- })
    }
    if (url.endsWith('/v1/images/generations')) {
      const index = generationCalls++
      const body = JSON.parse(String(init?.body))
      return generationGates[index]!.promise.then(() =>
        Response.json(imageJob(body, `image-task-${index + 1}`), { status: 202 }))
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const jobs = ['fixed-generation-key', 'parallel-key-2', 'parallel-key-3'].map((idempotencyKey, index) =>
      generateImageWithGenStudio('permit-parallel-key', request({ idempotencyKey, requestIdentity: `parallel-${index}` })))
    try {
      await waitFor(() => permitKeys.length === 3, { label: 'three same-scope permits to enter together' })
      assert.equal(maxInFlight, 3)
      assert.ok(permitKeys.includes('story-image-permit-4ab4201451cc0b0e7101c00a06bdf69f77629bfb16e0529b840228d0a6dfe1e5'),
        'the fixed request identity retains its exact permit identity regardless of concurrent arrival order')
      gates.forEach((gate, index) => gate.resolve(Response.json({ id: `permit-${index + 1}` })))
      await waitFor(() => generationCalls === 3, { label: 'three paid requests after permit acquisition' })
      assert.equal(overviewReads, 1, 'one cached account read covers arrivals, refills, and empty cleanup')
      generationGates.forEach(gate => gate.resolve(new Response()))
      await Promise.all(jobs)
    } finally {
      gates.forEach((gate, index) => gate.resolve(Response.json({ id: `permit-${index + 1}` })))
      generationGates.forEach(gate => gate.resolve(new Response()))
      await Promise.allSettled(jobs)
    }
  }, () => {
    overviewReads++
    return accountCapacity(3)
  })
  assert.equal(generationCalls, 3)
})

test('permit replenishment remains bounded but does not collapse when every standard execution slot is occupied', async () => {
  const gates = Array.from({ length: 3 }, () => deferred<Response>())
  let permitCalls = 0
  await withFetch((async (input: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) return gates[permitCalls++]!.promise
    if (url.endsWith('/v1/images/generations')) {
      return Response.json(imageJob({ model_id: 'fleet-image-v1' }, `image-task-${permitCalls}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const jobs = ['occupied-1', 'occupied-2', 'occupied-3'].map(idempotencyKey =>
      generateImageWithGenStudio('permit-occupied-key', request({ idempotencyKey, requestIdentity: idempotencyKey })))
    try {
      await waitFor(() => permitCalls === 3, { label: 'three permits despite no free standard execution slot' })
      gates.forEach((gate, index) => gate.resolve(Response.json({ id: `permit-${index + 1}` })))
      await Promise.all(jobs)
    } finally {
      gates.forEach((gate, index) => gate.resolve(Response.json({ id: `permit-${index + 1}` })))
      await Promise.allSettled(jobs)
    }
  }, () => ({
    ...accountCapacity(50, 1_000),
    paid_active_jobs: 50,
    generation_submissions_per_minute: 60,
    burst_concurrency_ceiling: 1_000,
  }))
  assert.equal(permitCalls, 3)
})

test('one permit 429 retries alone while sibling and queued waiters continue', async () => {
  const permitKeys: string[] = []
  const events: string[] = []
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      const key = new Headers(init?.headers).get('Idempotency-Key') || ''
      permitKeys.push(key)
      events.push(`permit-${permitKeys.length}`)
      if (permitKeys.length === 1) {
        return Response.json({ code: 'ADMISSION_UNAVAILABLE', detail: 'wait' }, {
          status: 429,
          headers: { 'Retry-After': '0.05' },
        })
      }
      return Response.json({ id: `permit-${permitKeys.length}` })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      events.push(`generation-${generationCalls}`)
      return Response.json(imageJob(JSON.parse(String(init?.body)), `image-task-${generationCalls}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await Promise.all(['retry-a', 'retry-b', 'retry-c'].map(idempotencyKey =>
      generateImageWithGenStudio('permit-independent-429-key', request({ idempotencyKey, requestIdentity: idempotencyKey }))))
  }, () => accountCapacity(2))

  assert.equal(permitKeys.length, 4)
  assert.deepEqual(permitKeys.slice(0, 3).map((key, index, keys) => keys.indexOf(key) === index), [true, true, true])
  assert.equal(permitKeys[3], permitKeys[0], 'only the 429 waiter replays its original permit key')
  assert.ok(events.indexOf('generation-2') < events.indexOf('permit-4'), 'two unaffected waiters submit before the retry')
  assert.equal(generationCalls, 3)
})

test('a retrying narrow-budget permit yields its acquisition opportunity to a sibling', async () => {
  const events: string[] = []
  const keys: string[] = []
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      const key = new Headers(init?.headers).get('Idempotency-Key') || ''
      keys.push(key)
      events.push(`permit-${keys.length}`)
      if (keys.length === 1) {
        return Response.json({ code: 'ADMISSION_UNAVAILABLE', detail: 'wait' }, {
          status: 429,
          headers: { 'Retry-After': '0.05' },
        })
      }
      return Response.json({ id: `permit-${keys.length}` })
    }
    if (url.endsWith('/v1/images/generations')) {
      events.push(`generation-${events.filter(event => event.startsWith('generation-')).length + 1}`)
      return Response.json(imageJob(JSON.parse(String(init?.body)), `image-task-${events.length}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await Promise.all(['yield-a', 'yield-b'].map(idempotencyKey =>
      generateImageWithGenStudio('permit-yield-key', request({ idempotencyKey, requestIdentity: idempotencyKey }))))
  }, () => accountCapacity(1, 2))

  assert.equal(keys.length, 3)
  assert.ok(keys.some((key, index) => keys.indexOf(key) !== index),
    'the retried permit preserves its idempotency identity')
  assert.ok(events.indexOf('generation-1') < events.indexOf('permit-3'),
    'the sibling receives the released permit acquisition opportunity before the retry')
})

test('same-scope waiters enter FIFO as permit slots become available', async () => {
  const gates = Array.from({ length: 4 }, () => deferred<Response>())
  const generationPermits = new Map<string, string>()
  let permitCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      const index = permitCalls++
      return gates[index]!.promise
    }
    if (url.endsWith('/v1/images/generations')) {
      const body = JSON.parse(String(init?.body))
      const key = new Headers(init?.headers).get('Idempotency-Key') || ''
      generationPermits.set(key, String(body.admission_permit_id))
      return Response.json(imageJob(body, `image-task-${generationPermits.size}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const jobs = ['fifo-1', 'fifo-2'].map(idempotencyKey =>
      generateImageWithGenStudio('permit-fifo-key', request({ idempotencyKey, requestIdentity: idempotencyKey })))
    try {
      await waitFor(() => permitCalls === 2, { label: 'the initial two FIFO permits' })
      const thirdWaiting = deferred<void>()
      jobs.push(generateImageWithGenStudio('permit-fifo-key', request({
        idempotencyKey: 'fifo-3',
        requestIdentity: 'fifo-3',
        onQueueState: (state: string) => { if (state === 'waiting_account_capacity') thirdWaiting.resolve() },
      })))
      await thirdWaiting.promise
      jobs.push(generateImageWithGenStudio('permit-fifo-key', request({
        idempotencyKey: 'fifo-4',
        requestIdentity: 'fifo-4',
      })))
      gates[1]!.resolve(Response.json({ id: 'permit-2' }))
      await waitFor(() => permitCalls === 3, { label: 'the third FIFO permit' })
      gates[0]!.resolve(Response.json({ id: 'permit-1' }))
      await waitFor(() => permitCalls === 4, { label: 'the fourth FIFO permit' })
      gates[2]!.resolve(Response.json({ id: 'permit-3' }))
      gates[3]!.resolve(Response.json({ id: 'permit-4' }))
      await Promise.all(jobs)
    } finally {
      gates.forEach((gate, index) => gate.resolve(Response.json({ id: `permit-${index + 1}` })))
      await Promise.allSettled(jobs)
    }
  }, () => accountCapacity(2, 2))

  assert.equal(generationPermits.get('fifo-3'), 'permit-3')
  assert.equal(generationPermits.get('fifo-4'), 'permit-4')
})

test('permit width shrinks and grows from refreshed published queue room', async () => {
  const gates = Array.from({ length: 5 }, () => deferred<Response>())
  let permitQueueRoom = 3
  let permitCalls = 0
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      const index = permitCalls++
      return gates[index]!.promise
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      return Response.json(imageJob(JSON.parse(String(init?.body)), `image-task-${generationCalls}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const jobs = ['resize-1', 'resize-2', 'resize-3'].map(idempotencyKey =>
      generateImageWithGenStudio('permit-resize-key', request({ idempotencyKey, requestIdentity: idempotencyKey })))
    try {
      await waitFor(() => permitCalls === 3, { label: 'three permits at the initial width' })

      permitQueueRoom = 2
      await refreshGenStudioAdmission('permit-resize-key')
      jobs.push(generateImageWithGenStudio('permit-resize-key', request({ idempotencyKey: 'resize-4', requestIdentity: 'resize-4' })))
      gates[0]!.resolve(Response.json({ id: 'permit-1' }))
      gates[1]!.resolve(Response.json({ id: 'permit-2' }))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(permitCalls, 3, 'shrinking waits until active acquisition drops below the new width')
      gates[2]!.resolve(Response.json({ id: 'permit-3' }))
      await waitFor(() => permitCalls === 4, { label: 'one permit after the shrink drains' })

      permitQueueRoom = 3
      await refreshGenStudioAdmission('permit-resize-key')
      jobs.push(generateImageWithGenStudio('permit-resize-key', request({ idempotencyKey: 'resize-5', requestIdentity: 'resize-5' })))
      await waitFor(() => permitCalls === 5, { label: 'a second permit after the live width grows' })
      gates[3]!.resolve(Response.json({ id: 'permit-4' }))
      gates[4]!.resolve(Response.json({ id: 'permit-5' }))
      await Promise.all(jobs)
    } finally {
      gates.forEach((gate, index) => gate.resolve(Response.json({ id: `permit-${index + 1}` })))
      await Promise.allSettled(jobs)
    }
  }, () => accountCapacity(50, permitQueueRoom))
  assert.equal(generationCalls, 5)
})

test('cancellation after slot assignment releases it without requesting a permit', async () => {
  const guardEntered = deferred<void>()
  const releaseGuard = deferred<void>()
  const controller = new AbortController()
  let permitCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      return Response.json({ id: 'permit-after-cancel' })
    }
    if (url.endsWith('/v1/images/generations')) {
      return Response.json(imageJob(JSON.parse(String(init?.body))), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const cancelled = generateImageWithGenStudio('permit-slot-cancel-key', request({
      idempotencyKey: 'cancelled-slot',
      requestIdentity: 'cancelled-slot',
      signal: controller.signal,
      beforeSubmit: async () => {
        guardEntered.resolve()
        await releaseGuard.promise
      },
    }))
    await guardEntered.promise
    const follower = generateImageWithGenStudio('permit-slot-cancel-key', request({
      idempotencyKey: 'cancelled-slot-follower',
      requestIdentity: 'cancelled-slot-follower',
    }))
    controller.abort()
    releaseGuard.resolve()
    await assert.rejects(cancelled, /Cancelled by user/)
    await follower
  }, () => accountCapacity(1, 2))
  assert.equal(permitCalls, 1)
})

test('permit 429 waits locally and never reaches the paid POST before admission', async () => {
  let permitCalls = 0
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model_id: 'fleet-image-v1',
        operation: 'text-to-image',
      })
      if (permitCalls === 1) {
        assert.equal(generationCalls, 0)
        return Response.json({ code: 'ADMISSION_UNAVAILABLE', detail: 'wait' }, {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      }
      return Response.json({ id: 'permit-after-wait' })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      const body = JSON.parse(String(init?.body))
      return Response.json(imageJob(body), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('permit-429-key', request())
  })
  assert.equal(permitCalls, 2)
  assert.equal(generationCalls, 1)
})

test('a permit Retry-After longer than ten minutes stays visible, never pays early, and continues', async () => {
  const states: string[] = []
  let permitCalls = 0
  let generationCalls = 0
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  let now = Date.UTC(2026, 8, 3)
  Date.now = () => now
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    now += Number(delay || 0)
    queueMicrotask(() => callback(...args))
    return 1 as any
  }) as typeof setTimeout
  try {
    await withFetch((async (input: any, init?: any) => {
      const url = String(input)
      if (url.endsWith('/v1/images/admission/permits')) {
        permitCalls++
        if (permitCalls === 1) {
          assert.equal(generationCalls, 0)
          return Response.json({ code: 'ADMISSION_UNAVAILABLE' }, {
            status: 429,
            headers: { 'Retry-After': '601' },
          })
        }
        return Response.json({ id: 'permit-after-long-wait' })
      }
      if (url.endsWith('/v1/images/generations')) {
        assert.equal(states.at(-1), 'submitting')
        generationCalls++
        return Response.json(imageJob(JSON.parse(String(init?.body))), { status: 202 })
      }
      if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
      throw new Error(`Unexpected request ${url}`)
    }) as typeof fetch, async () => {
      await generateImageWithGenStudio('permit-long-wait-key', request({
        onQueueState: (state: string) => { states.push(state) },
      }))
    })
  } finally {
    Date.now = originalNow
    globalThis.setTimeout = originalSetTimeout
  }
  assert.ok(now - Date.UTC(2026, 8, 3) >= 601_000)
  assert.deepEqual(states.filter(state => state === 'waiting_account_capacity' || state === 'submitting'), [
    'waiting_account_capacity',
    'submitting',
  ])
  assert.equal(generationCalls, 1)
})

test('a local permit-capacity wait stops at the job deadline without requesting a permit', async () => {
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  let now = Date.UTC(2026, 8, 3)
  let permitCalls = 0
  Date.now = () => now
  globalThis.setTimeout = ((callback: (...args: any[]) => void, _delay?: number, ...args: any[]) => {
    now += 4 * 60 * 60 * 1_000 + 1
    queueMicrotask(() => callback(...args))
    return 1 as any
  }) as typeof setTimeout
  try {
    await assert.rejects(withFetch((async (input: any) => {
      if (String(input).endsWith('/v1/images/admission/permits')) permitCalls++
      throw new Error(`Unexpected request ${input}`)
    }) as typeof fetch, () => generateImageWithGenStudio('permit-local-deadline-key', request()), () => ({
      credit_balance: 250,
      paid_concurrency_limit: 1,
      paid_active_jobs: 0,
      paid_queued_jobs: 25,
      max_queued_jobs: 25,
      generation_submissions_per_minute: 30,
    })),
    /timed out while waiting for image admission permit/)
  } finally {
    Date.now = originalNow
    globalThis.setTimeout = originalSetTimeout
  }
  assert.equal(permitCalls, 0)
})

test('a permit retry rechecks the pause guard before its full Retry-After', async () => {
  let permitCalls = 0
  let guards = 0
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const startedAt = Date.UTC(2026, 8, 3)
  let now = startedAt
  Date.now = () => now
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    now += Number(delay || 0)
    queueMicrotask(() => callback(...args))
    return 1 as any
  }) as typeof setTimeout
  try {
    await assert.rejects(withFetch((async (input: any) => {
      if (!String(input).endsWith('/v1/images/admission/permits')) throw new Error(`Unexpected request ${input}`)
      permitCalls++
      return Response.json({ code: 'ADMISSION_UNAVAILABLE' }, {
        status: 429,
        headers: { 'Retry-After': '0.6' },
      })
    }) as typeof fetch, () => generateImageWithGenStudio('permit-interrupt-key', request({
      beforeSubmit: () => {
        guards++
        if (guards === 3) throw new Error('Paused by user')
      },
    }))), /Paused by user/)
  } finally {
    Date.now = originalNow
    globalThis.setTimeout = originalSetTimeout
  }
  assert.ok(now - startedAt < 600, 'the pause guard must interrupt before the provider retry-after expires')
  assert.equal(permitCalls, 1)
})

test('a queued permit follower observes cancellation while its predecessor is unresolved', async () => {
  const firstPermit = deferred<Response>()
  const firstPermitEntered = deferred<void>()
  const followerAbort = new AbortController()
  let permitCalls = 0
  const first = withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      if (permitCalls === 1) {
        firstPermitEntered.resolve()
        return firstPermit.promise
      }
      throw new Error('A cancelled follower must not request another permit')
    }
    if (url.endsWith('/v1/images/generations')) {
      return Response.json(imageJob(JSON.parse(String(init?.body))), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const leader = generateImageWithGenStudio('permit-follower-key', request({ requestIdentity: 'leader' }))
    await firstPermitEntered.promise
    const follower = generateImageWithGenStudio('permit-follower-key', request({
      requestIdentity: 'follower',
      signal: followerAbort.signal,
      onQueueState: (state: string) => {
        if (state === 'waiting_account_capacity') queueMicrotask(() => followerAbort.abort())
      },
    }))
    let followerError: unknown
    void follower.catch(error => { followerError = error })
    try {
      await waitFor(() => followerError !== undefined, {
        label: 'the queued follower to observe cancellation',
      })
      assert.ok(followerError instanceof Error)
      assert.match(followerError.message, /Cancelled by user/)
    } finally {
      firstPermit.resolve(Response.json({ id: 'permit-leader' }))
    }
    await leader
    await assert.rejects(follower, /Cancelled by user/)
    await new Promise<void>(resolve => setImmediate(resolve))
  }, () => accountCapacity(1, 24, 1))
  await first
  assert.equal(permitCalls, 1)
})

test('a queued permit follower keeps predecessor reactions bounded during repeated polling', async () => {
  const firstPermit = deferred<Response>()
  const firstPermitEntered = deferred<void>()
  let permitCalls = 0
  let guardCalls = 0
  let reactionRegistrations = 0
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const originalThen = Promise.prototype.then
  let now = Date.UTC(2026, 8, 3)
  Date.now = () => now
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    now += Number(delay || 0)
    queueMicrotask(() => callback(...args))
    return 1 as any
  }) as typeof setTimeout
  try {
    await withFetch((async (input: any, init?: any) => {
      const url = String(input)
      if (url.endsWith('/v1/images/admission/permits')) {
        permitCalls++
        if (permitCalls === 1) {
          firstPermitEntered.resolve()
          return firstPermit.promise
        }
        throw new Error('A polling-only follower must not request another permit')
      }
      if (url.endsWith('/v1/images/generations')) {
        return Response.json(imageJob(JSON.parse(String(init?.body))), { status: 202 })
      }
      if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
      throw new Error(`Unexpected request ${url}`)
    }) as typeof fetch, async () => {
      const leader = generateImageWithGenStudio('permit-reaction-key', request({ requestIdentity: 'leader' }))
      await firstPermitEntered.promise
      Promise.prototype.then = function(this: Promise<unknown>, ...args: any[]) {
        reactionRegistrations++
        return originalThen.apply(this, args as any)
      } as typeof Promise.prototype.then
      try {
        await assert.rejects(
          generateImageWithGenStudio('permit-reaction-key', request({
            requestIdentity: 'follower',
            beforeSubmit: () => {
              guardCalls++
              if (guardCalls === 48) throw new Error('Polling interrupted')
            },
          })),
          /Polling interrupted/,
        )
      } finally {
        firstPermit.resolve(Response.json({ id: 'permit-leader' }))
      }
      await leader
    }, () => accountCapacity(1, 24, 1))
  } finally {
    Date.now = originalNow
    globalThis.setTimeout = originalSetTimeout
    Promise.prototype.then = originalThen
  }
  assert.ok(guardCalls >= 48, 'the test must exercise repeated predecessor polling')
  assert.ok(reactionRegistrations <= 40,
    `predecessor reactions must stay bounded, got ${reactionRegistrations} for ${guardCalls} guard checks`)
  assert.equal(permitCalls, 1)
})

test('an unresolved permit does not hold same-scope or independent replenishment', async () => {
  const firstTextPermit = deferred<Response>()
  const firstTextEntered = deferred<void>()
  const unrelatedEntered = deferred<void>()
  let textPermitCalls = 0
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      const body = JSON.parse(String(init?.body))
      if (body.operation === 'text-to-image') {
        textPermitCalls++
        if (textPermitCalls === 1) {
          firstTextEntered.resolve()
          return firstTextPermit.promise
        }
        return Response.json({ id: 'text-permit-2' })
      }
      unrelatedEntered.resolve()
      return Response.json({ id: 'image-permit-1' })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      const body = JSON.parse(String(init?.body))
      return Response.json(imageJob(body, `image-task-${generationCalls}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const first = generateImageWithGenStudio('permit-scope-key', request({ requestIdentity: 'scope-first' }))
    await firstTextEntered.promise
    const second = generateImageWithGenStudio('permit-scope-key', request({ requestIdentity: 'scope-second' }))
    const unrelated = generateImageWithGenStudio('permit-scope-key', request({
      requestIdentity: 'scope-unrelated',
      referenceAssetIds: ['asset-1'],
    }))
    try {
      await unrelatedEntered.promise
      assert.equal(textPermitCalls, 2, 'a held permit cannot monopolize same-scope replenishment')
    } finally {
      firstTextPermit.resolve(Response.json({ id: 'text-permit-1' }))
    }
    await Promise.all([first, second, unrelated])
  }, () => accountCapacity(1))
  assert.equal(textPermitCalls, 2)
  assert.equal(generationCalls, 3)
})

test('a lost permit response replays the identical permit key and body', async () => {
  const keys: string[] = []
  const bodies: string[] = []
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      keys.push(new Headers(init?.headers).get('Idempotency-Key') || '')
      bodies.push(String(init?.body))
      if (keys.length === 1) throw new TypeError('fetch failed')
      return Response.json({ id: 'permit-replayed' })
    }
    if (url.endsWith('/v1/images/generations')) {
      const body = JSON.parse(String(init?.body))
      return Response.json(imageJob(body), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('permit-replay-key', request())
  })
  assert.equal(keys.length, 2)
  assert.ok(keys[0])
  assert.equal(keys[0], keys[1])
  assert.equal(bodies[0], bodies[1])
})

test('a permit TimeoutError replays the same idempotency key as transport ambiguity', async () => {
  const keys: string[] = []
  let permitCalls = 0
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      keys.push(new Headers(init?.headers).get('Idempotency-Key') || '')
      if (permitCalls === 1) throw new DOMException('The operation timed out', 'TimeoutError')
      return Response.json({ id: 'permit-timeout-replayed' })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      const body = JSON.parse(String(init?.body))
      return Response.json(imageJob(body), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('permit-timeout-key', request())
  })
  assert.equal(permitCalls, 2)
  assert.equal(keys[0], keys[1])
  assert.equal(generationCalls, 1)
})

test('an invalid successful permit response fails instead of becoming a capacity wait', async () => {
  const states: string[] = []
  await assert.rejects(withFetch((async (input: any) => {
    if (!String(input).endsWith('/v1/images/admission/permits')) throw new Error(`Unexpected request ${input}`)
    return new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch, () => generateImageWithGenStudio('permit-invalid-json-key', request({
    onQueueState: (state: string) => {
      states.push(state)
      if (state === 'waiting_account_capacity') throw new Error('A contract failure must not be shown as capacity')
    },
  }))), /invalid JSON/)
  assert.equal(states.includes('waiting_account_capacity'), false)
})

test('an invalid successful permit payload fails instead of becoming a capacity wait', async () => {
  const states: string[] = []
  await assert.rejects(withFetch((async (input: any) => {
    if (!String(input).endsWith('/v1/images/admission/permits')) throw new Error(`Unexpected request ${input}`)
    return Response.json({ id: '   ' })
  }) as typeof fetch, () => generateImageWithGenStudio('permit-invalid-payload-key', request({
    onQueueState: (state: string) => {
      states.push(state)
      if (state === 'waiting_account_capacity') throw new Error('A contract failure must not be shown as capacity')
    },
  }))), /invalid image admission permit/)
  assert.equal(states.includes('waiting_account_capacity'), false)
})

test('permit queue-state persistence failure does not become a capacity wait', async () => {
  const states: string[] = []
  await assert.rejects(withFetch((async (input: any) => {
    if (!String(input).endsWith('/v1/images/admission/permits')) throw new Error(`Unexpected request ${input}`)
    return Response.json({ id: 'permit-persistence' })
  }) as typeof fetch, () => generateImageWithGenStudio('permit-persistence-key', request({
    onQueueState: (state: string) => {
      states.push(state)
      if (state === 'submitting') throw new TypeError('permit state persistence failed')
      if (state === 'waiting_account_capacity') throw new Error('A persistence failure must not be shown as capacity')
    },
  }))), /permit state persistence failed/)
  assert.equal(states.includes('waiting_account_capacity'), false)
})

test('a submitting TimeoutError callback fails immediately without capacity retry', async () => {
  let permitCalls = 0
  let generationCalls = 0
  const states: string[] = []
  await assert.rejects(withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      return Response.json({ id: 'permit-callback-timeout' })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      return Response.json(imageJob(JSON.parse(String(init?.body))), { status: 202 })
    }
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, () => generateImageWithGenStudio('permit-callback-timeout-key', request({
    onQueueState: (state: string) => {
      states.push(state)
      if (state === 'submitting') throw new DOMException('callback timed out', 'TimeoutError')
      if (state === 'waiting_account_capacity') throw new Error('A callback failure must not be shown as capacity')
    },
  }))), /callback timed out/)
  assert.equal(permitCalls, 1)
  assert.equal(generationCalls, 0)
  assert.equal(states.includes('waiting_account_capacity'), false)
})

test('a failed-state TimeoutError from a non-retryable permit response never becomes a capacity retry', async () => {
  let permitCalls = 0
  let generationCalls = 0
  const states: string[] = []
  await assert.rejects(withFetch((async (input: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      return Response.json({ detail: 'permit request is not accepted' }, { status: 400 })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      throw new Error('A paid generation request must not be made')
    }
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, () => generateImageWithGenStudio('permit-failed-callback-timeout-key', request({
    onQueueState: (state: string) => {
      states.push(state)
      if (state === 'failed') throw new DOMException('failed callback timed out', 'TimeoutError')
      if (state === 'waiting_account_capacity') throw new Error('A failed callback must not be shown as capacity')
    },
  }))), /failed callback timed out/)
  assert.equal(permitCalls, 1)
  assert.equal(generationCalls, 0)
  assert.equal(states.includes('waiting_account_capacity'), false)
})

test('an uncertain paid submission reuses one permit and the identical paid request', async () => {
  let permitCalls = 0
  const generationKeys: string[] = []
  const generationBodies: string[] = []
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      return Response.json({ id: 'permit-stays-bound' })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationKeys.push(new Headers(init?.headers).get('Idempotency-Key') || '')
      generationBodies.push(String(init?.body))
      if (generationBodies.length === 1) throw new TypeError('response lost after send')
      return Response.json(imageJob(JSON.parse(String(init?.body))), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('generation-uncertain-key', request())
  })
  assert.equal(permitCalls, 1, 'elapsed time or transport uncertainty must not buy another permit')
  assert.equal(generationBodies.length, 2)
  assert.equal(generationKeys[0], generationKeys[1])
  assert.equal(generationBodies[0], generationBodies[1])
})

test('only an authoritative uncharged permit rejection acquires a fresh permit', async () => {
  const permitKeys: string[] = []
  const generationKeys: string[] = []
  const generationBodies: any[] = []
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitKeys.push(new Headers(init?.headers).get('Idempotency-Key') || '')
      return Response.json({ id: `permit-${permitKeys.length}` })
    }
    if (url.endsWith('/v1/images/generations')) {
      generationKeys.push(new Headers(init?.headers).get('Idempotency-Key') || '')
      const body = JSON.parse(String(init?.body))
      generationBodies.push(body)
      if (generationBodies.length === 1) {
        return Response.json({ code: 'ADMISSION_PERMIT_INVALID', detail: 'expired before dispatch' }, { status: 409 })
      }
      return Response.json(imageJob(body), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('permit-replacement-key', request())
  })
  assert.equal(permitKeys.length, 2)
  assert.notEqual(permitKeys[0], permitKeys[1])
  assert.equal(generationKeys[0], generationKeys[1], 'paid retry identity must remain immutable')
  const [{ admission_permit_id: firstPermit, ...firstBody }, { admission_permit_id: secondPermit, ...secondBody }] = generationBodies
  assert.deepEqual(firstBody, secondBody)
  assert.equal(firstPermit, 'permit-1')
  assert.equal(secondPermit, 'permit-2')
})

test('pause is rechecked after permit and before the paid POST', async () => {
  let guards = 0
  let generationCalls = 0
  await assert.rejects(withFetch((async (input: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) return Response.json({ id: 'permit-before-pause' })
    if (url.endsWith('/v1/images/generations')) generationCalls++
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, () => generateImageWithGenStudio('permit-pause-key', request({
    beforeSubmit: () => {
      guards++
      if (guards === 2) throw new Error('Paused by user')
    },
  }))), /Paused by user/)
  assert.equal(guards, 2)
  assert.equal(generationCalls, 0)
})

test('catalogue absence keeps the legacy direct path without a permit request', async () => {
  let permitCalls = 0
  let generationCalls = 0
  await withFetch((async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/images/admission/permits')) {
      permitCalls++
      throw new Error('Legacy path must not request a permit')
    }
    if (url.endsWith('/v1/images/generations')) {
      generationCalls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.admission_permit_id, undefined)
      return Response.json(imageJob(body), { status: 202 })
    }
    if (url.endsWith('/v1/images/image-task-1/file')) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    await generateImageWithGenStudio('permit-legacy-key', request({ requiresAdmissionPermit: undefined }))
  })
  assert.equal(permitCalls, 0)
  assert.equal(generationCalls, 1)
})

test('all production image entry paths forward the published permit requirement', async () => {
  const [provider, styles, lettering] = await Promise.all([
    readFile(path.join(SERVER, 'providers/image/genstudio.ts'), 'utf8'),
    readFile(path.join(SERVER, 'routes/style-preview.ts'), 'utf8'),
    readFile(path.join(SERVER, 'routes/lettering-previews.ts'), 'utf8'),
  ])
  for (const [label, source] of [['provider', provider], ['style preview', styles], ['lettering preview', lettering]] as const) {
    assert.match(source, /requiresAdmissionPermit:\s*\w+\.requires_admission_permit/, `${label} must forward permit policy`)
  }
})

test('every queued image generator exposes permit-capacity waiting on its exact item', async () => {
  const [types, provider, continuity, images, scene, pool, composition] = await Promise.all([
    readFile(path.join(SERVER, 'providers/types.ts'), 'utf8'),
    readFile(path.join(SERVER, 'providers/image/genstudio.ts'), 'utf8'),
    readFile(path.join(SERVER, 'generators/continuity-render.ts'), 'utf8'),
    readFile(path.join(SERVER, 'generators/images.ts'), 'utf8'),
    readFile(path.join(SERVER, 'generators/scene-image.ts'), 'utf8'),
    readFile(path.join(SERVER, 'generators/image-pool-generate.ts'), 'utf8'),
    readFile(path.join(SERVER, 'generators/composition-template.ts'), 'utf8'),
  ])
  assert.match(types, /onQueueState\?:[\s\S]{0,400}waiting_account_capacity/)
  assert.match(types, /onQueueState\?:[\s\S]{0,400}submitting/)
  assert.match(provider, /onQueueState:/)
  for (const [label, source] of [
    ['continuity', continuity], ['images', images], ['scene image', scene],
    ['image pool', pool], ['composition', composition],
  ] as const) {
    assert.match(source, /onQueueState:/, `${label} must expose permit waiting`)
  }
  assert.match(continuity, /capacityWaitingCount:\s*capacityWaiting\.size/)
  assert.match(continuity, /waiting_account_capacity[\s\S]{0,400}capacityWaiting/)
})

test('adaptive one/two-lane tail stays local and never treats account overview as image authority', async () => {
  const source = await readFile(path.join(SERVER, 'services/job-queue.ts'), 'utf8')
  const start = source.indexOf('async function attemptAdaptiveImageTailAdmission')
  const end = source.indexOf('/** Request one event-driven', start)
  assert.ok(start >= 0 && end > start)
  const admission = source.slice(start, end)
  assert.doesNotMatch(admission, /refreshGenStudioAdmission|GenStudioAdmissionSnapshot|hasVerifiedGenStudioAdmission/)
  assert.match(admission, /pumpImageEpisodeGroup\(base \+ 1\)/)
  assert.match(source, /setImageEpisodeConcurrency\(n: number\)/)
})

test('shared image provider composes queue pause with any paid replacement guard', async () => {
  const source = await readFile(path.join(SERVER, 'providers/image/genstudio.ts'), 'utf8')
  assert.match(source, /currentJobId\(\)/)
  assert.match(source, /throwIfPauseRequested\(jobId\)/)
  assert.match(source, /await request\.beforeSubmit\?\.\(\)/)
  assert.match(source, /beforeSubmit:\s*assertSubmitAllowed/)
})

test('image workers use keyed live fanout while permits own remote admission', async () => {
  for (const file of ['generators/continuity-render.ts', 'generators/images.ts']) {
    const source = await readFile(path.join(SERVER, file), 'utf8')
    const calls = source.match(/resolveGenStudioLocalFanout\([\s\S]{0,240}?\)/g) || []
    assert.ok(calls.length > 0, `${file} must retain bounded local fanout`)
    for (const call of calls) assert.match(call, /burst_concurrency_ceiling|admission\./)
    assert.match(source, /refreshGenStudioAdmission\(/)
  }
})
