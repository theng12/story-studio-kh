import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const settings = await import('../services/app-settings.js')
const client = await import('../lib/genstudio-client.js')

const selector = (overrides: Record<string, unknown> = {}) => ({
  resolution: '1K',
  aspect_ratio: '16:9',
  width: 1280,
  height: 720,
  reference_mode: 'normal' as const,
  ...overrides,
})

const imageModel = (overrides: Record<string, unknown> = {}) => ({
  id: 'image-paid-v1',
  display_name: 'Paid image',
  available: true,
  qualification_only: false,
  chargeable: true,
  credits_per_image: 3,
  price_version: 'model-normal-v1',
  base_credits_per_image: 3,
  minimum_credits: 0,
  aspect_ratios: ['16:9'],
  default_aspect_ratio: '16:9',
  supports_reference_images: true,
  max_reference_images: 2,
  reference_strength_mode: 'none',
  supported_reference_strengths: [],
  reference_generation_credits: 8,
  reference_generation_price_version: 'model-reference-v1',
  output_options: [
    {
      resolution: '1K', aspect_ratio: '16:9', width: 1280, height: 720, is_default: true,
      credits_per_image: 4, price_version: 'normal-v1',
      reference_generation_credits: 9, reference_generation_price_version: 'reference-v1',
    },
    // Deliberately similar: matching only resolution/aspect ratio would choose
    // the wrong published rate.
    {
      resolution: '1K', aspect_ratio: '16:9', width: 1024, height: 576, is_default: false,
      credits_per_image: 5, price_version: 'normal-small-v1',
      reference_generation_credits: 10, reference_generation_price_version: 'reference-small-v1',
    },
  ],
  ...overrides,
})

void test('paid image rate resolution uses one exact output row and the selected price pair', async (suite) => {
  const policy = await import('../services/image-paid-replacement.js')
  const normal = selector()
  const guided = selector({ reference_mode: 'reference-guided' as const })
  const originalNormal = { selector: normal, references: [], referenceIdentityHash: policy.sha256CanonicalJson([]) }
  const originalGuidedReferences = [
    { role: 'episode-anchor', path: '/project/reference.png', sha256: 'a'.repeat(64) },
    { role: 'style', path: '/project/style.png', sha256: 'b'.repeat(64) },
  ]
  const originalGuided = {
    selector: guided,
    references: originalGuidedReferences,
    referenceIdentityHash: policy.sha256CanonicalJson(originalGuidedReferences),
  }

  await suite.test('uses the exact normal row and never its reference fields', () => {
    const rate = policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalNormal, request: originalNormal,
    })
    assert.deepEqual(rate, { credits: 4, priceVersion: 'normal-v1', basis: 'published-rate' })
  })

  await suite.test('uses the exact reference-guided row and never its normal fields', () => {
    const rate = policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalGuided, request: originalGuided,
    })
    assert.deepEqual(rate, { credits: 9, priceVersion: 'reference-v1', basis: 'published-rate' })
  })

  await suite.test('uses the model reference pair only when that row omits both fields', () => {
    const rows = imageModel().output_options as Array<Record<string, unknown>>
    delete rows[0]!.reference_generation_credits
    delete rows[0]!.reference_generation_price_version
    const rate = policy.resolvePaidImagePublishedRate({
      models: [imageModel({ output_options: rows })], modelId: 'image-paid-v1', original: originalGuided, request: originalGuided,
    })
    assert.deepEqual(rate, { credits: 8, priceVersion: 'model-reference-v1', basis: 'published-rate' })
  })

  for (const [label, model, candidate] of [
    ['a row with a half-published reference pair', imageModel({ output_options: [{ ...imageModel().output_options[0], reference_generation_price_version: undefined }] }), originalGuided],
    ['a model with a half-published reference fallback', imageModel({ output_options: [{ ...imageModel().output_options[0], reference_generation_credits: undefined, reference_generation_price_version: undefined }], reference_generation_price_version: undefined }), originalGuided],
    ['no matching dimensions', imageModel({ output_options: [{ ...imageModel().output_options[0], width: 1281 }] }), originalNormal],
    ['no matching aspect ratio', imageModel({ output_options: [{ ...imageModel().output_options[0], aspect_ratio: '1:1' }] }), originalNormal],
    ['no matching resolution', imageModel({ output_options: [{ ...imageModel().output_options[0], resolution: '2K' }] }), originalNormal],
    ['duplicate matching rows', imageModel({ output_options: [imageModel().output_options[0], { ...imageModel().output_options[0] }] }), originalNormal],
    ['a missing normal pair', imageModel({ output_options: [{ ...imageModel().output_options[0], price_version: undefined }] }), originalNormal],
    ['a non-finite normal credit value', imageModel({ output_options: [{ ...imageModel().output_options[0], credits_per_image: Number.NaN }] }), originalNormal],
    ['a removed model', imageModel({ id: 'other-image' }), originalNormal],
    ['a non-chargeable model', imageModel({ chargeable: false }), originalNormal],
  ] as const) {
    await suite.test(`blocks ${label}`, () => {
      assert.throws(() => policy.resolvePaidImagePublishedRate({
        models: [model], modelId: 'image-paid-v1', original: candidate, request: candidate,
      }))
    })
  }

  await suite.test('blocks any selector or ordered reference identity that differs from the original request', () => {
    assert.throws(() => policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalNormal,
      request: { ...originalNormal, selector: selector({ width: 1024 }) },
    }))
    assert.throws(() => policy.resolvePaidImagePublishedRate({
      models: [imageModel()], modelId: 'image-paid-v1', original: originalGuided,
      request: { ...originalGuided, references: [...originalGuided.references].reverse() },
    }))
  })
})

void test('paid image original identity is ordered, content-addressed, and only reuses persisted prepared facts', async () => {
  const policy = await import('../services/image-paid-replacement.js')
  const root = path.join(temp.dir, 'paid-image-identity')
  const first = path.join(root, 'first.png')
  const second = path.join(root, 'second.png')
  await mkdir(root, { recursive: true })
  await writeFile(first, 'first reference')
  await writeFile(second, 'second reference')

  const references = policy.capturePaidImageReferenceIdentity(root, [
    { role: 'style', path: first },
    { role: 'character', path: second },
  ])
  const base = { prompt: 'A sunrise over Angkor Wat.', selector: selector({ reference_mode: 'reference-guided' as const }), references: references.inputs, baseScope: 'scene:42' }
  const identity = policy.buildPaidImageOriginalIdentity(base)
  assert.equal(identity.referenceIdentityHash, references.identity_hash)
  assert.match(identity.requestScope, new RegExp(references.identity_hash))
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, selector: selector({ width: 1024, reference_mode: 'reference-guided' as const }) }).inputHash === identity.inputHash, false)
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, references: [...references.inputs].reverse() }).requestScope === identity.requestScope, false)
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, references: [{ ...references.inputs[0]!, role: 'other' }, references.inputs[1]! ] }).inputHash === identity.inputHash, false)
  assert.equal(policy.buildPaidImageOriginalIdentity({ ...base, references: [{ ...references.inputs[0]!, path: second }, references.inputs[1]! ] }).requestScope === identity.requestScope, false)
  await writeFile(first, 'changed bytes')
  const changedReferences = policy.capturePaidImageReferenceIdentity(root, [
    { role: 'style', path: first },
    { role: 'character', path: second },
  ])
  const changedIdentity = policy.buildPaidImageOriginalIdentity({ ...base, references: changedReferences.inputs })
  assert.notEqual(changedIdentity.inputHash, identity.inputHash)
  assert.notEqual(changedIdentity.requestScope, identity.requestScope)
  await writeFile(first, 'first reference')

  const prepared = {
    provider: 'genstudio', task_id: '', submitted_at: '2026-08-31T00:00:00.000Z', operation: 'image' as const,
    last_state: 'prepared', input_hash: identity.inputHash, request_scope: identity.requestScope,
    original_output_selector: base.selector,
    original_reference_inputs: references.inputs,
    original_reference_identity_hash: references.identity_hash,
    original_output_path: path.join(root, 'out.png'),
  }
  const persisted = policy.readPaidImageOriginalRequest(prepared, root)
  assert.deepEqual(persisted.selector, base.selector)
  assert.deepEqual(persisted.references, references.inputs)
  assert.equal(policy.capturePaidImageReferenceIdentity(root, []).identity_hash, policy.sha256CanonicalJson([]), 'normal work persists the canonical empty list')

  await writeFile(first, 'changed bytes')
  assert.throws(() => policy.readPaidImageOriginalRequest(prepared, root), /hash/i)
  await rm(second)
  assert.throws(() => policy.readPaidImageOriginalRequest(prepared, root), /missing/i)
  await assert.rejects(writeFile(path.join(temp.dir, 'outside.png'), 'outside').then(async () =>
    policy.capturePaidImageReferenceIdentity(root, [{ role: 'bad', path: path.join(temp.dir, 'outside.png') }]),
  ))
})

void test('force-live image catalogue reads supersede an older refresh and never fall back', async () => {
  const originalFetch = globalThis.fetch
  const apiKey = 'force-live-key'
  const pending: Array<{ resolve: (value: Response) => void; reject: (reason: unknown) => void }> = []
  let requests = 0
  const response = (credits: number, version: string) => Response.json([imageModel({ credits_per_image: credits, price_version: version })])
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    assert.match(url, /\/v1\/image\/models$/)
    requests++
    return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))
  }) as typeof globalThis.fetch

  try {
    client.clearGenStudioCatalogCache()
    await settings.setGenStudioUrl('http://127.0.0.1:43123')
    const staleA = client.listImageModelsSnapshot(apiKey)
    while (requests < 1) await new Promise(resolve => setTimeout(resolve, 0))
    const forcedB = client.listImageModelsForceLive(apiKey)
    while (requests < 2) await new Promise(resolve => setTimeout(resolve, 0))
    pending[1]!.resolve(response(12, 'new-price'))
    const forced = await forcedB
    assert.equal(forced.freshness, 'live')
    assert.equal(forced.value[0]!.credits_per_image, 12)
    pending[0]!.resolve(response(4, 'old-price'))
    await staleA
    const later = await client.listImageModelsSnapshot(apiKey)
    assert.equal(later.value[0]!.credits_per_image, 12, 'late ordinary completion must not overwrite the forced live value')
    assert.equal(requests, 2)

    client.clearGenStudioCatalogCache()
    globalThis.fetch = (async () => response(13, 'latest-price')) as typeof globalThis.fetch
    const policy = await import('../services/image-paid-replacement.js')
    const original = { selector: selector(), references: [], referenceIdentityHash: policy.sha256CanonicalJson([]) }
    const rate = await policy.resolvePaidImageForceLivePublishedRate(apiKey, {
      modelId: 'image-paid-v1', original, request: original,
    })
    assert.deepEqual(rate, { credits: 4, priceVersion: 'normal-v1', basis: 'published-rate' })

    client.clearGenStudioCatalogCache()
    await client.listImageModelsSnapshot(apiKey)
    globalThis.fetch = (async () => Response.json({ detail: 'catalog unavailable' }, { status: 503 })) as typeof globalThis.fetch
    await assert.rejects(
      policy.resolvePaidImageForceLivePublishedRate(apiKey, { modelId: 'image-paid-v1', original, request: original }),
      /could not be refreshed|unavailable/i,
      'a failed forced read must not use the warm catalogue as a stale pricing fallback',
    )
  } finally {
    globalThis.fetch = originalFetch
    client.clearGenStudioCatalogCache()
    await settings.setGenStudioUrl('')
  }
})
