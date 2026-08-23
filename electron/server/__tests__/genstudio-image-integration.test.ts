import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildImageModelConfig,
  defaultPublishedOutputOption,
  resolveConfiguredAspectRatio,
  resolveConfiguredOutputOption,
  resolveImageModelConfig,
} from '../services/image-model-resolver.js'
import { resolveTranscriptionLanguage } from '../generators/subtitles.js'
import { hashStylePreviewKey } from '../services/style-preview-cache.js'
import { hashPreviewKey } from '../services/image-preview-cache.js'
import { listImageModels } from '../lib/genstudio-client.js'
import { registry } from '../providers/registry.js'
import '../providers/image/genstudio.js'

/**
 * One published catalogue row. Only fields GenStudio actually emits appear by
 * default; per-test overrides add the optional capability fields so the
 * readers are pinned against a real payload shape rather than an invented one.
 */
function publishedModel(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'genstudio-image-fast-v1',
    display_name: 'FLUX Fast',
    available: true,
    qualification_only: false,
    credits_per_image: 4,
    minimum_credits: 4,
    price_version: '2026-07-01',
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

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

/** Real on-disk references — the uploader reads the bytes before dispatch. */
function referenceFixtures(count: number): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-image-refs-'))
  return Array.from({ length: count }, (_, index) => {
    const file = path.join(dir, `reference-${index + 1}.png`)
    writeFileSync(file, TINY_PNG)
    return file
  })
}

/** Minimal GenStudio stub: catalogue, admission, upload, generation, artifact. */
function stubGenStudio(models: any[]) {
  const calls = { catalog: 0, generations: 0, uploads: 0, bodies: [] as any[] }
  const fetchStub = async (input: any, init?: any) => {
    const url = String(input)
    if (url.endsWith('/v1/image/models')) {
      calls.catalog++
      return Response.json(models)
    }
    if (url.endsWith('/v1/account/overview')) {
      return Response.json({
        credit_balance: 100,
        credits_used_30d: 0,
        subscription_plan_name: 'Test',
        paid_concurrency_limit: 25,
        paid_active_jobs: 0,
        paid_queued_jobs: 0,
        max_queued_jobs: 100,
        generation_submissions_per_minute: 100,
      })
    }
    if (url.endsWith('/v1/images/source-images')) {
      calls.uploads++
      return Response.json({
        id: `asset-${calls.uploads}`, media_type: 'image/png',
        byte_size: TINY_PNG.length, width: 1, height: 1, expires_at: '',
      })
    }
    if (url.endsWith('/v1/images/generations')) {
      calls.generations++
      const body = JSON.parse(String(init?.body || '{}'))
      calls.bodies.push(body)
      const id = `stub-image-${calls.generations}`
      return Response.json({
        id, state: 'succeeded', model_id: body.model_id, prompt: body.prompt,
        width: 1024, height: 576, aspect_ratio: body.aspect_ratio, steps: 4,
        image_url: `/v1/images/${id}/file`,
      }, { status: 202 })
    }
    if (/\/v1\/images\/stub-image-\d+\/file$/.test(url)) {
      return new Response(TINY_PNG, { headers: { 'Content-Type': 'image/png' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  return { fetchStub, calls }
}

async function withGenStudio<T>(
  models: any[],
  run: (calls: ReturnType<typeof stubGenStudio>['calls']) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  const { fetchStub, calls } = stubGenStudio(models)
  globalThis.fetch = fetchStub as any
  try { return await run(calls) } finally { globalThis.fetch = originalFetch }
}

// ── The resolver reads the live catalogue ─────────────────────────────────

test('the image model resolver reads the live catalogue instead of synthesising capabilities', async () => {
  await withGenStudio([publishedModel({
    supports_reference_images: true,
    max_reference_images: 4,
    aspect_ratios: ['21:9', '1:1'],
    default_aspect_ratio: '21:9',
  })], async (calls) => {
    const model = await resolveImageModelConfig(
      { image_models: {} }, 'genstudio-image-fast-v1', 'resolver-live-catalog-key',
    )
    assert.equal(model?.provider, 'genstudio-image')
    assert.equal(model?.api_model, 'genstudio-image-fast-v1')
    // Published, not hardcoded.
    assert.equal(model?.supports_reference_images, true)
    assert.equal(model?.max_reference_images, 4)
    assert.deepEqual(model?.aspect_ratios, ['21:9', '1:1'])
    assert.equal(model?.default_aspect_ratio, '21:9')
    assert.equal(model?.credits_per_image, 4)
    // The invented step fields are gone from Story Studio's config entirely.
    assert.equal((model?.provider_params as any)?.default_steps, undefined)
    assert.equal((model as any)?.default_steps, undefined)
    assert.equal((model as any)?.min_steps, undefined)
    assert.equal((model as any)?.max_steps, undefined)
    // The capability flags reach provider_params, which is what generators read.
    assert.equal((model?.provider_params as any)?.supports_reference_images, true)
    assert.equal((model?.provider_params as any)?.max_reference_images, 4)
    assert.equal(calls.catalog, 1)
  })
})

test('a model publishing supports_reference_images false is reported as reference-free', async () => {
  await withGenStudio([publishedModel()], async () => {
    const model = await resolveImageModelConfig(
      { image_models: {} }, 'genstudio-image-fast-v1', 'resolver-no-references-key',
    )
    assert.equal(model?.supports_reference_images, false)
    assert.equal(model?.max_reference_images, 0)
    assert.equal((model?.provider_params as any)?.supports_reference_images, false)
  })
})

test('a model absent from the live catalogue does not resolve', async () => {
  await withGenStudio([publishedModel()], async () => {
    const model = await resolveImageModelConfig(
      { image_models: {} }, 'genstudio-image-retired-v9', 'resolver-missing-model-key',
    )
    assert.equal(model, undefined)
  })
})

test('prompt caps come from max_prompt_characters and are absent when unpublished', () => {
  const capped = buildImageModelConfig(
    { image_models: {} }, 'genstudio-image-fast-v1', publishedModel({ max_prompt_characters: 1_200 }),
  )
  assert.equal(capped.prompt_char_cap, 1_200)
  // No published cap means no cap — never a 4,000-character invention.
  const uncapped = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel())
  assert.equal(uncapped.prompt_char_cap, undefined)
})

test('unpublished capability fields stay undefined rather than defaulting', async () => {
  await withGenStudio([publishedModel()], async () => {
    const [bare] = await listImageModels('capabilities-bare-key')
    assert.equal(bare?.max_prompt_characters, undefined)
    assert.equal(bare?.min_reference_images, undefined)
    assert.equal(bare?.supports_seed, undefined)
    assert.equal(bare?.supports_image_to_image, undefined)
    assert.equal(bare?.operations, undefined)
  })
  await withGenStudio([publishedModel({
    max_prompt_characters: 900,
    min_reference_images: 2,
    supports_seed: false,
    supports_image_to_image: true,
    operations: ['image.generation', 'image.edit'],
  })], async () => {
    const [published] = await listImageModels('capabilities-published-key')
    assert.equal(published?.max_prompt_characters, 900)
    assert.equal(published?.min_reference_images, 2)
    assert.equal(published?.supports_seed, false)
    assert.equal(published?.supports_image_to_image, true)
    assert.deepEqual(published?.operations, ['image.generation', 'image.edit'])
  })
})

test('a published min_reference_images floor travels into the resolved config', () => {
  const config = buildImageModelConfig({ image_models: {} }, 'genstudio-image-edit-v1', publishedModel({
    supports_reference_images: true, max_reference_images: 3, min_reference_images: 1,
  }))
  assert.equal(config.min_reference_images, 1)
  assert.equal((config.provider_params as any)?.min_reference_images, 1)
  // Absent stays absent — a saved project must not see an invented floor.
  const plain = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel())
  assert.equal(plain.min_reference_images, undefined)
})

// ── Aspect ratios ─────────────────────────────────────────────────────────

test('aspect ratios default from the catalogue and reject unpublished values', () => {
  const config = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel({
    aspect_ratios: ['9:16', '1:1'], default_aspect_ratio: '9:16',
  }))
  assert.equal(resolveConfiguredAspectRatio(config, undefined), '9:16')
  assert.equal(resolveConfiguredAspectRatio(config, ''), '9:16')
  assert.equal(resolveConfiguredAspectRatio(config, '1:1'), '1:1')
  assert.throws(() => resolveConfiguredAspectRatio(config, '16:9'), /does not support 16:9/)
})

test('a saved config with no published ratios still resolves the caller value', () => {
  // Degradation path for projects saved before the published fields existed.
  const legacy = { label: 'Legacy', credits_per_image: 0, endpoint: '', poll: '', type: 'jobs', api_model: 'x' }
  assert.equal(resolveConfiguredAspectRatio(legacy as any, '4:3'), '4:3')
})

// ── Published output options ──────────────────────────────────────────────

const OUTPUT_OPTIONS = [
  { resolution: '1K', aspect_ratio: '16:9', width: 1920, height: 1080, is_default: true, credits_per_image: 4 },
  { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: false, credits_per_image: 4 },
  { resolution: '2K', aspect_ratio: '16:9', width: 2560, height: 1440, is_default: false, credits_per_image: 9 },
]

test('published output options reach the resolved config row for row', () => {
  const config = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel({
    output_options: OUTPUT_OPTIONS, default_resolution: '1K',
  }))
  assert.equal(config.default_resolution, '1K')
  assert.equal(config.output_options?.length, 3)
  assert.equal(config.output_options?.[2]?.credits_per_image, 9)
  // A model publishing none keeps the field absent, which is what makes the
  // resolution control disappear instead of a ladder being invented for it.
  const bare = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel())
  assert.equal(bare.output_options, undefined)
})

test('an output option resolves by (resolution, aspect_ratio) and refuses unpublished pairs', () => {
  const config = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel({
    output_options: OUTPUT_OPTIONS, default_resolution: '1K',
  }))
  assert.equal(resolveConfiguredOutputOption(config, '16:9', '2K')?.width, 2560)
  // 2K exists only at 16:9. The pair is the row; rows are never recombined.
  assert.throws(() => resolveConfiguredOutputOption(config, '1:1', '2K'), /does not publish 2K at 1:1/)
  // Nothing requested falls to the flagged default within the chosen ratio.
  assert.equal(resolveConfiguredOutputOption(config, '16:9', undefined)?.resolution, '1K')
  assert.equal(resolveConfiguredOutputOption(config, '1:1', undefined)?.resolution, '1K')
})

test('a model with no published output options degrades to aspect ratio alone', () => {
  const config = buildImageModelConfig({ image_models: {} }, 'genstudio-image-fast-v1', publishedModel())
  assert.equal(resolveConfiguredOutputOption(config, '16:9', undefined), undefined)
  // A legacy saved config predating the field behaves identically.
  const legacy = { label: 'Legacy', credits_per_image: 0, endpoint: '', poll: '', type: 'jobs', api_model: 'x' }
  assert.equal(resolveConfiguredOutputOption(legacy as any, '16:9', undefined), undefined)
})

test('the default row is flagged, then the published pair — never chosen by position', () => {
  assert.equal(defaultPublishedOutputOption(OUTPUT_OPTIONS, '1K', '16:9')?.width, 1920)
  const unflagged = OUTPUT_OPTIONS.map(row => ({ ...row, is_default: false }))
  assert.equal(defaultPublishedOutputOption(unflagged, '2K', '16:9')?.width, 2560)
  // Neither flagged nor matching the published pair: no row wins by position.
  assert.equal(defaultPublishedOutputOption(unflagged, '4K', '16:9'), undefined)
})

test('a chosen resolution reaches the wire, and no size instruction contradicts it', async () => {
  await withGenStudio([publishedModel({
    output_options: OUTPUT_OPTIONS, default_resolution: '1K',
  })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'output-option-key',
      aspectRatio: '16:9',
      resolution: '2K',
      // A legacy render-size pair must NOT also travel: two size instructions
      // could bill a combination other than the one the customer was shown.
      width: 512,
      height: 288,
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
    })
    assert.equal(calls.bodies[0]?.resolution, '2K')
    assert.equal(calls.bodies[0]?.width, undefined)
    assert.equal(calls.bodies[0]?.height, undefined)
  })
})

test('a model publishing no output options still sends no resolution at all', async () => {
  await withGenStudio([publishedModel()], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'no-output-option-key',
      aspectRatio: '16:9',
      width: 512,
      height: 288,
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
    })
    assert.equal('resolution' in (calls.bodies[0] || {}), false)
    // Today's behaviour is untouched for these models.
    assert.equal(calls.bodies[0]?.width, 512)
  })
})

test('an unpublished aspect ratio is never submitted', async () => {
  await withGenStudio([publishedModel({ aspect_ratios: ['1:1'], default_aspect_ratio: '1:1' })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'unpublished-ratio-key',
      aspectRatio: '21:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'unpublished-ratio',
    }), /does not support 21:9/)
    assert.equal(calls.generations, 0)
  })
})

test('an empty aspect ratio submits the model default rather than a hardcoded 16:9', async () => {
  await withGenStudio([publishedModel({ aspect_ratios: ['9:16'], default_aspect_ratio: '9:16' })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'default-ratio-key',
      aspectRatio: '',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'default-ratio',
    })
    assert.equal(calls.bodies[0].aspect_ratio, '9:16')
  })
})

// ── Availability is checked on every submit path ──────────────────────────

test('an unavailable model is blocked on the plain text2img path', async () => {
  await withGenStudio([publishedModel({ available: false })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'unavailable-text2img-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'unavailable-text2img',
    }), /currently unavailable/)
    assert.equal(calls.generations, 0)
  })
})

test('a qualification-only model is blocked on the plain text2img path', async () => {
  await withGenStudio([publishedModel({ qualification_only: true })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'qualification-text2img-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'qualification-text2img',
    }), /qualification-only/)
    assert.equal(calls.generations, 0)
  })
})

// ── References ───────────────────────────────────────────────────────────

test('a model publishing supports_reference_images submits its references', async () => {
  await withGenStudio([publishedModel({
    supports_reference_images: true, max_reference_images: 4,
  })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'references-supported-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: referenceFixtures(2),
      idempotencyIdentity: 'references-supported',
    })
    assert.equal(calls.uploads, 2)
    assert.equal(calls.bodies[0].reference_asset_ids.length, 2)
  })
})

test('references are sliced to the published max_reference_images', async () => {
  await withGenStudio([publishedModel({
    supports_reference_images: true, max_reference_images: 2,
  })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'references-sliced-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: referenceFixtures(3),
      idempotencyIdentity: 'references-sliced',
    })
    // Exactly the published ceiling — never the old single-reference slice,
    // and never more than the model declared room for.
    assert.equal(calls.uploads, 2)
    assert.equal(calls.bodies[0].reference_asset_ids.length, 2)
  })
})

test('a model publishing no reference support refuses references instead of billing text2img', async () => {
  await withGenStudio([publishedModel({
    supports_reference_images: false, max_reference_images: 0,
  })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'references-unsupported-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: referenceFixtures(1),
      idempotencyIdentity: 'references-unsupported',
    }), /does not support private reference-image generation/)
    assert.equal(calls.generations, 0)
    assert.equal(calls.uploads, 0)
  })
})

test('a submission below a published min_reference_images floor is refused before any charge', async () => {
  await withGenStudio([publishedModel({
    supports_reference_images: true, max_reference_images: 3, min_reference_images: 2,
  })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'min-references-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: referenceFixtures(1),
      idempotencyIdentity: 'min-references',
    }), /requires at least 2 reference image\(s\)/)
    // Refused before the upload AND before the charged POST.
    assert.equal(calls.uploads, 0)
    assert.equal(calls.generations, 0)
  })
})

test('the published floor is satisfied by enough references and the render proceeds', async () => {
  await withGenStudio([publishedModel({
    supports_reference_images: true, max_reference_images: 3, min_reference_images: 2,
  })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'min-references-met-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: referenceFixtures(2),
      idempotencyIdentity: 'min-references-met',
    })
    assert.equal(calls.generations, 1)
    assert.equal(calls.bodies[0].reference_asset_ids.length, 2)
  })
})

// ── Seed ─────────────────────────────────────────────────────────────────

test('seed is forwarded when GenStudio publishes nothing about seeds', async () => {
  await withGenStudio([publishedModel()], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'seed-unpublished-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      seed: 1234,
      idempotencyIdentity: 'seed-unpublished',
    })
    assert.equal(calls.bodies[0].seed, 1234)
  })
})

test('seed is omitted from the request when supports_seed is published false', async () => {
  await withGenStudio([publishedModel({ supports_seed: false })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'seed-unsupported-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      seed: 4321,
      idempotencyIdentity: 'seed-unsupported',
    })
    assert.equal(calls.generations, 1)
    assert.equal('seed' in calls.bodies[0], false)
  })
})

test('seed travels when supports_seed is published true', async () => {
  await withGenStudio([publishedModel({ supports_seed: true })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'seed-supported-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      seed: 4321,
      idempotencyIdentity: 'seed-supported',
    })
    assert.equal(calls.bodies[0].seed, 4321)
  })
})

// ── Prompt ceiling ───────────────────────────────────────────────────────

test('a prompt over the published max_prompt_characters is refused before any charge', async () => {
  await withGenStudio([publishedModel({ max_prompt_characters: 40 })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'x'.repeat(41),
      apiKey: 'prompt-cap-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'prompt-cap',
    }), /accepts up to 40 prompt characters/)
    assert.equal(calls.generations, 0)
  })
})

test('a published cap above the old fixed 4,000 ceiling is honoured end to end', async () => {
  // Regression pin: the transport used to refuse any prompt over 4,000
  // characters, which would have silently overruled a model publishing 4,800.
  await withGenStudio([publishedModel({ max_prompt_characters: 4_800 })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'x'.repeat(4_500),
      apiKey: 'prompt-cap-high-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'prompt-cap-high',
    })
    assert.equal(calls.generations, 1)
    await assert.rejects(provider.generateImage({
      prompt: 'x'.repeat(4_801),
      apiKey: 'prompt-cap-high-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'prompt-cap-high-over',
    }), /accepts up to 4,800 prompt characters/)
    assert.equal(calls.generations, 1)
  })
})

test('an unpublished prompt ceiling leaves the provider as the only judge', async () => {
  // No published cap and a long prompt: Story Studio must not invent a limit,
  // and must not divide prompt_token_allowance by a made-up characters/token.
  await withGenStudio([publishedModel({ prompt_token_allowance: 12 })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'x'.repeat(3_000),
      apiKey: 'prompt-uncapped-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'prompt-uncapped',
    })
    assert.equal(calls.generations, 1)
  })
})

test('no image request carries a steps field', async () => {
  await withGenStudio([publishedModel()], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'no-steps-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-fast-v1',
      providerParams: { provider: 'genstudio-image' },
      idempotencyIdentity: 'no-steps',
    })
    assert.equal('steps' in calls.bodies[0], false)
    assert.deepEqual(Object.keys(calls.bodies[0]).sort(), ['aspect_ratio', 'model_id', 'prompt'])
  })
})

// ── Transcription language ───────────────────────────────────────────────

test('transcription refuses stale auto-detect selections before it can submit paid work', () => {
  const model = {
    id: 'gs-transcribe-v1',
    display_name: 'Published languages only',
    language: 'multilingual',
    supported_languages: ['en', 'km'],
    supports_language_auto_detect: false,
  }
  assert.equal(resolveTranscriptionLanguage(model as any, 'km'), 'km')
  assert.throws(
    () => resolveTranscriptionLanguage(model as any, undefined),
    /has not published auto-detect/i,
  )
  assert.throws(
    () => resolveTranscriptionLanguage(model as any, 'auto'),
    /has not published auto-detect/i,
  )
  assert.throws(
    () => resolveTranscriptionLanguage(model as any, 'th'),
    /does not publish th/i,
  )
})

// ── Regression pins ──────────────────────────────────────────────────────

test('scene renders actually submit their resolved reference images', () => {
  // Regression pin: `resolveSceneReferenceImages()` was defined and never
  // called, so every img2img reference the UI collected for a scene was
  // dropped and the render was billed as text2img.
  const source = readFileSync(new URL('../generators/images.ts', import.meta.url), 'utf8')
  assert.match(source, /const sceneReferences = supportsReferences/)
  assert.match(source, /resolveSceneReferenceImages\(scene\)/)
  assert.match(source, /referenceImagePaths: sceneReferences/)
  // And the capability text is read from the resolved model, not a constant.
  assert.match(source, /modelConfig\.supports_reference_images === true/)
  assert.doesNotMatch(source, /does NOT support references/)
})

test('the image provider carries no invented step or capability constants', () => {
  const provider = readFileSync(new URL('../providers/image/genstudio.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(provider, /min_steps|max_steps/)
  assert.doesNotMatch(provider, /referenceImagePaths\?\.\[0\]/)
  assert.doesNotMatch(provider, /aspectRatio \|\| '16:9'/)
  assert.match(provider, /publishedAvailabilityProblem/)

  const resolver = readFileSync(new URL('../services/image-model-resolver.ts', import.meta.url), 'utf8')
  assert.match(resolver, /listImageModels/)
  assert.doesNotMatch(resolver, /default_steps|min_steps|max_steps/)
  assert.doesNotMatch(resolver, /prompt_char_cap: 4/)
  assert.doesNotMatch(resolver, /supports_reference_images: false/)
})

test('the image preview route caps prompts from the catalogue, not a fixed number', () => {
  const source = readFileSync(new URL('../routes/image-preview.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /z\.string\(\)\.min\(1\)\.max\(8000\)/)
  assert.match(source, /modelConfig\.prompt_char_cap/)
  assert.match(source, /resolveConfiguredAspectRatio/)
})

test('no image submit boundary defaults an aspect ratio to a hardcoded 16:9', () => {
  for (const file of [
    '../generators/images.ts',
    '../generators/scene-image.ts',
    '../generators/composition-template.ts',
    '../generators/continuity-render.ts',
    '../generators/image-pool-generate.ts',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /aspect_ratio \|\| '16:9'/, file)
    assert.doesNotMatch(source, /aspectRatio \|\| '16:9'/, file)
    assert.match(source, /resolveConfiguredAspectRatio/, file)
  }
})

// ── Untouched behaviour ──────────────────────────────────────────────────

test('style preview cache keeps its old addresses and still separates seeds', () => {
  const base = {
    styleTag: 'textured paper collage',
    modelId: 'genstudio-image-fast-v1',
    aspectRatio: '16:9',
    variantId: 'style-proof',
  }
  // Recorded from the build that still threaded an imageSteps value. Every
  // preview it cached used 4 (the catalogue fallback), so freezing that key
  // segment keeps previously rendered pixels reachable instead of orphaning
  // the cache and billing a fresh render for them.
  assert.equal(hashStylePreviewKey(base), 'fc80c23c9cfe540a')
  assert.notEqual(
    hashStylePreviewKey({ ...base, seed: 12 }),
    hashStylePreviewKey({ ...base, seed: 13 }),
  )
})

test('image preview cache keeps its old addresses too', () => {
  assert.equal(hashPreviewKey({
    prompt: 'A calm river at dusk.',
    modelId: 'genstudio-image-fast-v1',
    aspectRatio: '16:9',
  }), '398b6257d36f9f18')
})

test('style previews use one GenStudio-only proof and no direct provider fallback', () => {
  const source = readFileSync(new URL('../routes/style-preview.ts', import.meta.url), 'utf8')

  assert.match(source, /'style-proof'/)
  assert.match(source, /listImageModels/)
  assert.match(source, /generateImageWithGenStudio/)
  assert.doesNotMatch(source, /resolveImageModelConfig/)
  assert.doesNotMatch(source, /resolveApiKeyForProvider/)
  assert.doesNotMatch(source, /registry\.getImageProvider/)
  assert.doesNotMatch(source, /landscape:|character:|interior:|action:|closeup:/)
})
