import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  generateImageWithGenStudio,
  listImageModels,
} from '../lib/genstudio-client.js'
import { shouldPauseContinuityForStall } from '../generators/continuity-render.js'

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

async function withFetch<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try { return await run() } finally { globalThis.fetch = original }
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

test('permit queues serialize one scope without holding an unrelated operation', async () => {
  const firstTextPermit = deferred<Response>()
  const firstTextEntered = deferred<void>()
  const unrelatedEntered = deferred<void>()
  let textPermitCalls = 0
  let generationCalls = 0
  const generationPermitIds: string[] = []
  const secondStates: string[] = []
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
      generationPermitIds.push(String(body.admission_permit_id))
      return Response.json(imageJob(body, `image-task-${generationCalls}`), { status: 202 })
    }
    if (/\/v1\/images\/image-task-\d+\/file$/.test(url)) return new Response(PNG)
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch, async () => {
    const first = generateImageWithGenStudio('permit-scope-key', request({ requestIdentity: 'scope-first' }))
    await firstTextEntered.promise
    const second = generateImageWithGenStudio('permit-scope-key', request({
      requestIdentity: 'scope-second',
      onQueueState: (state: string) => { secondStates.push(state) },
    }))
    const unrelated = generateImageWithGenStudio('permit-scope-key', request({
      requestIdentity: 'scope-unrelated',
      referenceAssetIds: ['asset-1'],
    }))
    let concurrencyError: unknown
    try {
      await unrelatedEntered.promise
      assert.equal(textPermitCalls, 1, 'the second same-scope permit must remain queued')
      assert.equal(secondStates[0], 'waiting_account_capacity')
      assert.equal(shouldPauseContinuityForStall({
        stallPauseRequested: false,
        inFlightCount: 1,
        pauseRequested: false,
        fleetWaitingCount: 0,
        capacityWaitingCount: 1,
        elapsedMs: 11 * 60_000,
      }), false)
      assert.equal(generationPermitIds.some(id => id.startsWith('text-permit')), false,
        'the queued follower must not make a paid request')
    } catch (error) {
      concurrencyError = error
    } finally {
      firstTextPermit.resolve(Response.json({ id: 'text-permit-1' }))
    }
    await Promise.all([first, second, unrelated])
    if (concurrencyError) throw concurrencyError
  })
  assert.equal(textPermitCalls, 2)
  assert.equal(generationCalls, 3)
  assert.deepEqual(secondStates.filter(state => state === 'waiting_account_capacity' || state === 'submitting'), [
    'waiting_account_capacity',
    'submitting',
  ])
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

test('image workers use only local fanout while permits own remote admission', async () => {
  for (const file of ['generators/continuity-render.ts', 'generators/images.ts']) {
    const source = await readFile(path.join(SERVER, file), 'utf8')
    const calls = source.match(/resolveGenStudioLocalFanout\([\s\S]{0,240}?\)/g) || []
    assert.ok(calls.length > 0, `${file} must retain bounded local fanout`)
    for (const call of calls) assert.doesNotMatch(call, /burst_concurrency_ceiling|genStudioAdmissionSnapshot/)
  }
})
