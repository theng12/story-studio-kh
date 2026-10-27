/**
 * A GenStudio product answers to more than one name.
 *
 * GenStudio is republishing its image and video catalogues under each
 * product's owner-defined `customer_handle` rather than its raw internal id:
 *
 *   genstudio-image-studio-v1  →  gpt-image-2
 *   genstudio-image-pro-v1     →  nano-banana-pro
 *   google-veo-3.1-v1          →  veo-3-1
 *
 * Submit accepts either form, so the rename is backwards compatible on the
 * wire. It is NOT automatically backwards compatible inside Story Studio,
 * which held saved presets against the raw id and compared them with
 * `item.id === modelId`. That equality test resolves nothing once the listing
 * publishes the handle, and it fails at GENERATION time rather than in a
 * picker — the owner discovers it after asking for a render, not before.
 *
 * These tests pin the resolution rule: a saved identifier resolves to its
 * product by ANY identifier that product publishes, and both forms land on the
 * same catalogue row.
 *
 * ZERO paid calls — every response is a hand-written fixture served from a
 * stubbed `globalThis.fetch`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findGenStudioProduct,
  genStudioProductAliases,
  isGenStudioProduct,
} from '../contracts/genstudio-product-identity.js'
import { listImageModels, listVideoModels } from '../lib/genstudio-client.js'
import { resolveJobAutoRetryPolicy } from '../services/job-retry-policy.js'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'
import { registry } from '../providers/registry.js'
import '../providers/image/genstudio.js'
import '../providers/video/genstudio.js'

// ── Fixtures ───────────────────────────────────────────────────────────────

const RAW_IMAGE_ID = 'genstudio-image-studio-v1'
const IMAGE_HANDLE = 'gpt-image-2'
const RAW_VIDEO_ID = 'google-veo-3.1-v1'
const VIDEO_HANDLE = 'veo-3-1'

/**
 * One published image row AFTER the rename: `id` carries the handle, and the
 * superseded raw id travels as a published back-reference.
 */
function renamedImageModel(overrides: Record<string, unknown> = {}): any {
  return {
    id: IMAGE_HANDLE,
    legacy_ids: [RAW_IMAGE_ID],
    display_name: 'GPT Image 2',
    available: true,
    qualification_only: false,
    credits_per_image: 9,
    minimum_credits: 9,
    price_version: '2026-08-01',
    chargeable: true,
    aspect_ratios: ['16:9', '1:1'],
    default_aspect_ratio: '16:9',
    supports_reference_images: false,
    max_reference_images: 0,
    reference_strength_mode: 'none',
    supported_reference_strengths: [],
    ...overrides,
  }
}

function renamedVideoModel(overrides: Record<string, unknown> = {}): any {
  return {
    id: VIDEO_HANDLE,
    legacy_ids: [RAW_VIDEO_ID],
    display_name: 'Veo 3.1',
    available: true,
    modes: ['image-to-video'],
    aspect_ratios: ['16:9'],
    variants: [{
      operation: 'image-to-video',
      duration_seconds: 5,
      resolution: '720p',
      credits_per_video: 120,
      minimum_credits: 120,
      price_version: '2026-08-01',
    }],
    ...overrides,
  }
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

function sourceImage(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-handle-src-'))
  const file = path.join(dir, 'source.png')
  writeFileSync(file, TINY_PNG)
  return file
}

/** Minimal GenStudio stub covering the image and video submit paths. */
function stubGenStudio(images: any[], videos: any[]) {
  const calls = { imageBodies: [] as any[], videoBodies: [] as any[] }
  const fetchStub = async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/image/models')) return Response.json(images)
    if (url.endsWith('/v1/videos/models')) return Response.json(videos)
    if (url.endsWith('/v1/account/overview')) {
      return Response.json({
        credit_balance: 10_000, credits_used_30d: 0, subscription_plan_name: 'Test',
        paid_concurrency_limit: 25, paid_active_jobs: 0, paid_queued_jobs: 0,
        max_queued_jobs: 100, generation_submissions_per_minute: 100,
      })
    }
    if (url.endsWith('/v1/images/source-images') || url.endsWith('/v1/videos/source-images')) {
      return Response.json({
        id: 'asset-1', media_type: 'image/png',
        byte_size: TINY_PNG.length, width: 1, height: 1, expires_at: '',
      })
    }
    if (url.endsWith('/v1/images/generations')) {
      const body = JSON.parse(String(init?.body || '{}'))
      calls.imageBodies.push(body)
      return Response.json({
        id: 'stub-image-1', state: 'succeeded', model_id: body.model_id,
        prompt: body.prompt, width: 1024, height: 576,
        aspect_ratio: body.aspect_ratio, steps: 4,
        image_url: '/v1/images/stub-image-1/file',
      }, { status: 202 })
    }
    if (url.endsWith('/v1/videos/generations')) {
      const body = JSON.parse(String(init?.body || '{}'))
      calls.videoBodies.push(body)
      // Deliberately refused AFTER resolution succeeded. The contract under
      // test is "the saved identifier found its product"; simulating the whole
      // clip pipeline would test the pipeline, not the resolution.
      // 400, not 503: a retryable status would make this test spend seconds in
      // backoff proving nothing. Resolution has already happened by this point.
      return Response.json({ detail: 'STUB_REACHED_SUBMIT' }, { status: 400 })
    }
    if (/\/v1\/images\/stub-image-1\/file$/.test(url)) {
      return new Response(TINY_PNG, { headers: { 'Content-Type': 'image/png' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  return { fetchStub, calls }
}

async function withGenStudio<T>(
  images: any[],
  videos: any[],
  run: (calls: { imageBodies: any[]; videoBodies: any[] }) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  const { fetchStub, calls } = stubGenStudio(images, videos)
  globalThis.fetch = fetchStub as any
  try { return await run(calls) } finally { globalThis.fetch = originalFetch }
}

// ── 1. The resolution rule itself ──────────────────────────────────────────

test('a product is found by its id, its customer handle, and its published legacy id', () => {
  const catalog = [
    { id: IMAGE_HANDLE, customer_handle: IMAGE_HANDLE, legacy_ids: [RAW_IMAGE_ID] },
    { id: 'nano-banana-pro', legacy_ids: ['genstudio-image-pro-v1'] },
  ]

  const byHandle = findGenStudioProduct(catalog, IMAGE_HANDLE)
  const byRawId = findGenStudioProduct(catalog, RAW_IMAGE_ID)

  assert.ok(byHandle, 'the handle must resolve')
  assert.ok(byRawId, 'the superseded raw id must still resolve')
  // Not merely "both succeeded" — both must be the SAME catalogue row.
  assert.strictEqual(byRawId, byHandle)
  assert.strictEqual(byRawId, catalog[0])

  // And it does not over-match: a different product is not swept up.
  assert.strictEqual(findGenStudioProduct(catalog, 'genstudio-image-pro-v1'), catalog[1])
  assert.equal(findGenStudioProduct(catalog, 'never-published'), undefined)
  assert.equal(findGenStudioProduct(catalog, ''), undefined)
})

test('an exact id always wins over another product claiming it as a legacy id', () => {
  // A stale legacy_ids entry must never shadow the product that owns the id.
  const owner = { id: 'flux-2-klein' }
  const claimant = { id: 'flux-2-pro', legacy_ids: ['flux-2-klein'] }
  assert.strictEqual(findGenStudioProduct([claimant, owner], 'flux-2-klein'), owner)
})

test('aliases keep their published casing, and matching ignores case and padding', () => {
  const model = {
    id: IMAGE_HANDLE,
    // Same string as `id` bar its casing: one identifier, so one alias.
    customer_handle: 'GPT-Image-2',
    legacy_ids: ['GenStudio-Image-Studio-V1'],
  }
  // Display code uses these as label keys, so the PUBLISHED casing survives
  // verbatim, and a case-only duplicate is folded away rather than repeated.
  assert.deepEqual(genStudioProductAliases(model), [IMAGE_HANDLE, 'GenStudio-Image-Studio-V1'])
  // Matching, unlike display, is case- and padding-insensitive, so a preset
  // saved with different casing still finds its product.
  assert.equal(isGenStudioProduct(model, `  ${RAW_IMAGE_ID}  `), true)
  assert.equal(isGenStudioProduct(model, IMAGE_HANDLE.toUpperCase()), true)
  assert.equal(isGenStudioProduct(model, 'something-else'), false)
  assert.equal(isGenStudioProduct(model, ''), false)
})

// ── 2. The identifiers have to survive the transport ───────────────────────

test('published product identifiers are carried through the catalogue parser', async () => {
  await withGenStudio([renamedImageModel({ customer_handle: IMAGE_HANDLE })], [renamedVideoModel()], async () => {
    const [image] = await listImageModels('transport-image-key')
    // The parsers build explicit object literals, so a field they do not name
    // is dropped. If these are lost here, no downstream resolution can work.
    assert.equal(image?.id, IMAGE_HANDLE)
    assert.equal(image?.customer_handle, IMAGE_HANDLE)
    assert.deepEqual(image?.legacy_ids, [RAW_IMAGE_ID])

    const [video] = await listVideoModels('transport-video-key')
    assert.equal(video?.id, VIDEO_HANDLE)
    assert.deepEqual(video?.legacy_ids, [RAW_VIDEO_ID])
  })
})

// ── 3. Image: both forms generate, and they are one product ────────────────

test('a preset holding the OLD raw image id still generates after the rename', async () => {
  await withGenStudio([renamedImageModel()], [], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    const result = await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'image-legacy-id-key',
      aspectRatio: '16:9',
      modelId: RAW_IMAGE_ID,
      providerParams: { provider: 'genstudio-image' },
    } as any)
    assert.ok(result, 'the render completed')
    assert.equal(calls.imageBodies.length, 1)
    // The saved value travels UNCHANGED: GenStudio accepts either form, and
    // rewriting it would change the idempotency identity of an accepted job.
    assert.equal(calls.imageBodies[0]?.model_id, RAW_IMAGE_ID)
  })
})

test('the same product selected by its NEW handle generates too', async () => {
  await withGenStudio([renamedImageModel()], [], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'image-handle-key',
      aspectRatio: '16:9',
      modelId: IMAGE_HANDLE,
      providerParams: { provider: 'genstudio-image' },
    } as any)
    assert.equal(calls.imageBodies.length, 1)
    assert.equal(calls.imageBodies[0]?.model_id, IMAGE_HANDLE)
  })
})

test('both identifiers resolve to ONE product, not two paths that happen to work', async () => {
  // Proven through the resolver that builds the render config: if these were
  // different rows they would carry different published capabilities.
  const viaHandle = await withGenStudio([renamedImageModel()], [], () =>
    resolveImageModelConfig({ image_models: {} }, IMAGE_HANDLE, 'same-product-handle-key'))
  const viaRawId = await withGenStudio([renamedImageModel()], [], () =>
    resolveImageModelConfig({ image_models: {} }, RAW_IMAGE_ID, 'same-product-raw-key'))

  assert.ok(viaHandle, 'handle resolves to a render config')
  assert.ok(viaRawId, 'raw id resolves to a render config')
  assert.equal(viaRawId?.label, viaHandle?.label)
  assert.equal(viaRawId?.credits_per_image, viaHandle?.credits_per_image)
  assert.deepEqual(viaRawId?.aspect_ratios, viaHandle?.aspect_ratios)
  // The clinching detail: resolving the SUPERSEDED id yields the catalogue's
  // own current identity, so the two are demonstrably one row.
  assert.equal(viaRawId?.api_model, IMAGE_HANDLE)
  assert.equal(viaHandle?.api_model, IMAGE_HANDLE)
  assert.equal(viaHandle?.label, 'GPT Image 2')
  assert.equal(viaHandle?.credits_per_image, 9)
})

test('an identifier the catalogue never published is still refused', async () => {
  await withGenStudio([renamedImageModel()], [], async () => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(
      provider.generateImage({
        prompt: 'A calm river at dusk.',
        apiKey: 'image-unknown-key',
        aspectRatio: '16:9',
        modelId: 'genstudio-image-retired-v9',
        providerParams: { provider: 'genstudio-image' },
      } as any),
      /no longer available/,
    )
  })
})

// ── 4. Video has the same shape ────────────────────────────────────────────

/**
 * Resolution is what is under test. Before the fix the saved raw id never
 * finds its row and the provider refuses with "does not currently publish";
 * after it, resolution succeeds and the request reaches the submit stub.
 */
async function videoSubmitOutcome(modelId: string, apiKey: string): Promise<string> {
  return withGenStudio([], [renamedVideoModel()], async () => {
    const provider = registry.getVideoProvider('genstudio-video')!
    try {
      await provider.generateVideo({
        mode: 'frames',
        startImagePath: sourceImage(),
        prompt: 'The river drifts.',
        apiKey,
        aspectRatio: 'landscape',
        numberOfVideos: 1,
        modelId,
        providerParams: { provider: 'genstudio-video', operation: 'image-to-video' },
      } as any)
      return 'succeeded'
    } catch (error: any) {
      return String(error?.message || error)
    }
  })
}

test('a saved OLD raw video id still resolves to its product after the rename', async () => {
  const outcome = await videoSubmitOutcome(RAW_VIDEO_ID, 'video-legacy-id-key')
  assert.doesNotMatch(
    outcome,
    /does not currently publish an available image-to-video model/,
    'the saved raw id must resolve rather than be reported as unpublished',
  )
})

test('the same video product selected by its NEW handle resolves too', async () => {
  const outcome = await videoSubmitOutcome(VIDEO_HANDLE, 'video-handle-key')
  assert.doesNotMatch(outcome, /does not currently publish an available image-to-video model/)
})

test('an unpublished video identifier is still refused', async () => {
  const outcome = await videoSubmitOutcome('google-veo-9.9-v1', 'video-unknown-key')
  assert.match(outcome, /does not currently publish an available video model/)
})

// ── 5. Retry classification survives the rename ────────────────────────────

test('a paid GenStudio image job stays manual-only under either identifier', () => {
  const reason = /never submitted twice/
  for (const model of [RAW_IMAGE_ID, IMAGE_HANDLE, 'nano-banana-pro', 'flux-2-klein']) {
    const policy = resolveJobAutoRetryPolicy({ type: 'scene_image_generate', params: { model } } as any)
    assert.equal(policy.eligible, false, `${model} must not auto-retry`)
    assert.match(
      policy.reason, reason,
      `${model} must be classified as charged Gateway work, not fall through to the generic reason`,
    )
  }
})

test('local Image Studio work is still the one image case that auto-retries', () => {
  const local = resolveJobAutoRetryPolicy({
    type: 'scene_image_generate', params: { model: 'imagestudio:some/repo' },
  } as any)
  assert.equal(local.eligible, true)
  assert.match(local.reason, /your own hardware/)
})
