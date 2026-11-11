/**
 * Three published fields Story Studio parsed but never acted on.
 *
 * 1. `controls[]` — the legal field set for a language product. Sampling
 *    parameters and the system turn now travel only when the product
 *    publishes them, and `top_p` never travels at all.
 * 2. `generates_audio` — a video product that bills for its own soundtrack.
 *    Carried through the transport so the picker can disclose it.
 * 3. `reference_image_max_dimension` — a published pixel ceiling, enforced
 *    before a reference is uploaded instead of after.
 *
 * ZERO paid calls: every response below is a hand-written envelope served by
 * a local fetch stub. Nothing here touches GenStudio.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  buildGenStudioChatIdempotencyKey,
  callChatWithGenStudio,
  listVideoModels,
  productPublishesControl,
} from '../lib/genstudio-client.js'
import { registry } from '../providers/registry.js'
import '../providers/image/genstudio.js'

// ── Shared local stub ────────────────────────────────────────────────────

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
  }
}

/** One language product publishing exactly `controls`. */
function chatCatalog(controls: string[], id: string) {
  return [{
    id,
    display_name: 'Writer Under Test',
    available: true,
    qualification_only: false,
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    controls,
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
  }]
}

/** Capture the single submitted body for a product publishing `controls`. */
async function submitOnce(
  controls: string[],
  request: Record<string, unknown>,
  id: string,
): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | null = null
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(chatCatalog(controls, id))
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'job_controls_1', operation: 'chat.response', model_id: id,
          state: 'succeeded', output_text: '{"ok":true}', output_retained: true,
          finish_reason: 'stop', failure_code: null, routing_status_code: null,
          credit_cost: 1, remaining_credits: 10, idempotent_replay: false,
        }, { status: 202 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    // The catalogue snapshot is cached per (base URL, API key). A distinct key
    // per case keeps each scenario reading its OWN published `controls`.
    await callChatWithGenStudio(`controls-key-${id}`, {
      modelId: id,
      system: '',
      userMessage: 'Write something.',
      outputContract: { mode: 'json_object' },
      ...request,
    } as any)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(body, 'expected exactly one submission')
  return body!
}

// ── 1. controls[] gates what goes on the wire ────────────────────────────

test('a published temperature control is sent; an unpublished one is not', async () => {
  const withControl = await submitOnce(
    ['temperature', 'max_output_tokens'],
    { temperature: 0.35 },
    'writer-temp-published',
  )
  assert.equal(withControl.temperature, 0.35)

  const withoutControl = await submitOnce(
    ['max_output_tokens'],
    { temperature: 0.35 },
    'writer-temp-unpublished',
  )
  assert.ok(
    !('temperature' in withoutControl),
    'temperature must not be sent to a product that does not publish the control',
  )
  // The output allowance is not a sampling parameter and still travels.
  assert.equal(typeof withoutControl.max_output_tokens, 'number')
})

test('top_p is never sent, published or not', async () => {
  for (const controls of [['temperature'], ['temperature', 'top_p', 'max_output_tokens']]) {
    const body = await submitOnce(controls, {}, `writer-topp-${controls.length}`)
    assert.ok(!('top_p' in body), `top_p must never reach the wire (controls: ${controls.join(',')})`)
  }
})

test('system text folds into the user turn when system_instruction is unpublished', async () => {
  const published = await submitOnce(
    ['system_instruction', 'temperature'],
    { system: 'You are a narrator.', userMessage: 'Describe the sea.' },
    'writer-system-published',
  )
  const publishedTurns = published.input as Array<{ role: string; content: string }>
  assert.deepEqual(publishedTurns.map(turn => turn.role), ['system', 'user'])
  assert.match(publishedTurns[0]!.content, /^You are a narrator\./)
  assert.equal(publishedTurns[1]!.content, 'Describe the sea.')

  const folded = await submitOnce(
    ['temperature'],
    { system: 'You are a narrator.', userMessage: 'Describe the sea.' },
    'writer-system-unpublished',
  )
  // The instruction is still delivered — it just is not a field the product
  // never advertised. Nothing creative is dropped: the same system text (plus
  // whatever output-contract wrapper it carried) leads the single user turn.
  const foldedTurns = folded.input as Array<{ role: string; content: string }>
  assert.deepEqual(foldedTurns.map(turn => turn.role), ['user'])
  assert.match(foldedTurns[0]!.content, /^You are a narrator\./)
  assert.ok(
    foldedTurns[0]!.content.endsWith('\n\nDescribe the sea.'),
    'the user message must still be the last thing the model reads',
  )
})

test('productPublishesControl treats an empty list as "publishes nothing"', () => {
  assert.equal(productPublishesControl({ controls: [] }, 'temperature'), false)
  assert.equal(productPublishesControl({ controls: ['temperature'] }, 'temperature'), true)
  assert.equal(productPublishesControl({ controls: ['temperature'] }, 'system_instruction'), false)
  assert.equal(productPublishesControl({ controls: undefined as any }, 'top_p'), false)
})

/**
 * FROZEN KEYS — do not "update" these strings without the same reasoning a
 * change here demands: a change is a double-charge risk, not a test that
 * needs refreshing.
 *
 * Recorded from the v1.0.768 build (HEAD 25f3b59) BEFORE `top_p` left the
 * wire. The digest still carries `temperature` and a frozen `top_p: 1`, so a
 * retry that crosses THAT upgrade replays the in-flight job instead of
 * submitting — and billing — a second one.
 *
 * The first two values below moved once, deliberately, in the fix for the
 * v1.0.788 idempotency defect (see `wireFormatDigestComponent` in
 * genstudio-client.ts): both requests omit `outputContract`/`jsonObject` and
 * so default to `prose`, and `prose` is now the one mode whose digest
 * includes the wire `response_format`. That is the fix — a prose retry must
 * NOT collide with a request shape GenStudio will never see again. The third
 * value (`jsonObject: true`) is untouched on purpose: JSON Object's wire
 * format has not changed, so its key must not move, or a JSON-mode job still
 * in flight at GenStudio when this fix ships would get double-submitted.
 *
 * THEY MOVED A SECOND TIME, DELIBERATELY (2026-09-26): prose now sends NO
 * `response_format` at all, because a Studio Hub lane refuses the explicit
 * `{"type":"text"}` object with a 422 — every chapter expansion on the local
 * model failed on it (STORY-2 acceptance run). The digest component follows
 * the wire, so both prose values below are the new ones and the JSON-mode
 * value is STILL byte-identical to the v1.0.768 record — which is the
 * property this test exists to protect. Same reasoning as v1.0.788: a prose
 * job that failed terminally under the old wire must not compute the same key
 * under the new one, or its key stays blocked forever against a request shape
 * that can never match again.
 */
test('chat idempotency keys are byte-identical to the pre-change build', () => {
  assert.equal(
    buildGenStudioChatIdempotencyKey({
      modelId: 'genstudio-chat:pinned-product',
      system: 'You are a Story Studio narrator.',
      userMessage: 'Write one line about the sea.',
    } as any),
    'story-chat-a2c26b7e291e49a5aa632d6d871a15ec1709607e9e96e1a',
  )
  assert.equal(
    buildGenStudioChatIdempotencyKey({
      modelId: 'pinned-product',
      system: '',
      userMessage: 'Plain user turn only.',
      temperature: 0.35,
    } as any),
    'story-chat-b3ed6d24aab2d7989f388638511ab341200127d2029e10c',
  )
  // The exact shape routes/vision.ts used to send, including its old
  // `topP: 1` — the key must not move now that the field is gone. JSON
  // Object mode also has no `response_format` digest component (see above),
  // so this value is IDENTICAL to the one recorded from the v1.0.768 build.
  assert.equal(
    buildGenStudioChatIdempotencyKey({
      modelId: 'pinned-product',
      system: 'S',
      userMessage: 'U',
      temperature: 0.2,
      maxOutputTokens: 1200,
      jsonObject: true,
    } as any),
    'story-chat-6c6ed6947779e15273b40f5d1f6dbe098453a70885cd9b0',
  )
})

test('no caller passes topP and no chat body carries top_p', () => {
  const client = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  const vision = readFileSync(new URL('../routes/vision.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /request\.topP/)
  assert.doesNotMatch(vision, /topP\s*:/)
})

test('no call site invents an output allowance of its own', () => {
  // The class guard for the same rule, applied to the answer length. `maxOutputTokens` and
  // the wire's `max_tokens` both name an EXACT number, and a number of ours cannot follow what
  // the selected product publishes: it goes stale when the product changes, and
  // `prepareChatSubmission` REFUSES one above the published limit — before any request is
  // made, so the workflow fails with nothing to show for it. A tier (`outputBudget`) derives
  // the figure from the published ceiling instead and cannot overshoot; see
  // `services/output-token-budget.ts`.
  //
  // `routes/vision.ts` carried the last one — the thumbnail-reference analysis named 1,200
  // tokens. A vision product publishing less could not run that analysis AT ALL, and one
  // publishing more had its composition JSON cut short with `finish_reason: length`, which
  // GenStudio refuses to settle.
  //
  // WHAT THIS CANNOT CATCH: a literal hidden behind an expression — `{ max_tokens:
  // Math.min(derived, 2_048) }` is the shape that used to sit in the paid scene-prompt repair,
  // and a scan for a bare number never sees it. That site is guarded behaviourally instead, by
  // `scene-prompt-auto-repair-generator.test.ts` asserting the budget that reaches the wire.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!relative.endsWith('.ts') || relative.startsWith('__tests__')) continue
    const source = readFileSync(path.join(root, relative), 'utf8')
    if (/maxOutputTokens:\s*\d|max_tokens:\s*\d/.test(source)) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], 'declare a tier (outputBudget) instead of a number of our own')
})

// ── 2. generates_audio survives the transport ────────────────────────────

test('published generates_audio is carried through; an absent one stays null', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json([
      {
        id: 'video-loud', display_name: 'Video Loud', available: true,
        modes: ['image-to-video'], aspect_ratios: ['16:9'], generates_audio: true,
        variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'v1' }],
      },
      {
        id: 'video-silent', display_name: 'Video Silent', available: true,
        modes: ['image-to-video'], aspect_ratios: ['16:9'], generates_audio: false,
        variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'v1' }],
      },
      {
        id: 'video-unsaid', display_name: 'Video Unsaid', available: true,
        modes: ['image-to-video'], aspect_ratios: ['16:9'],
        variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'v1' }],
      },
    ])
    const models = await listVideoModels('video-audio-key')
    assert.equal(models.find(model => model.id === 'video-loud')?.generates_audio, true)
    assert.equal(models.find(model => model.id === 'video-silent')?.generates_audio, false)
    // Not published is NOT "no audio". Null, so the picker says nothing.
    assert.equal(models.find(model => model.id === 'video-unsaid')?.generates_audio, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the video model picker discloses a charged audio track it will not use', () => {
  const page = readFileSync(
    new URL('../../../frontend/pages/projects/[slug]/motion-review.vue', import.meta.url),
    'utf8',
  )
  // Only an explicit published `true` triggers the disclosure.
  assert.match(page, /generates_audio === true/)
  assert.match(page, /GENERATED_AUDIO_DISCLOSURE/)
  assert.match(page, /selectedVideoModelAudioNotice/)
  // It must say the charge is real and the assembled episode will not carry it.
  assert.match(page, /you are charged for it/)
  assert.match(page, /assembled episode/)
})

test('video assembly documents why every prepared clip drops audio', () => {
  const generator = readFileSync(new URL('../generators/video.ts', import.meta.url), 'utf8')
  assert.match(generator, /Why every prepared clip carries `-an`/)
  const sceneClip = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(sceneClip, /'-an'/)
})

// ── 3. reference_image_max_dimension is enforced before upload ───────────

/** One published image row that accepts references. */
function imageModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'genstudio-image-ref-v1',
    display_name: 'Reference Renderer',
    available: true,
    qualification_only: false,
    credits_per_image: 4,
    minimum_credits: 4,
    price_version: '2026-07-01',
    chargeable: true,
    aspect_ratios: ['16:9'],
    default_aspect_ratio: '16:9',
    supports_reference_images: true,
    max_reference_images: 2,
    reference_strength_mode: 'none',
    supported_reference_strengths: [],
    ...overrides,
  }
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==',
  'base64',
)

/** Write a real decodable PNG of an exact size. */
async function writeReference(width: number, height: number): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-ref-dim-'))
  const file = path.join(dir, `ref-${width}x${height}.png`)
  await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 30, b: 40 } },
  }).png().toFile(file)
  return file
}

/** Catalogue + admission + upload + generation, all local. */
async function withImageGenStudio<T>(
  models: unknown[],
  run: (calls: { uploads: number; generations: number }) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  const calls = { uploads: 0, generations: 0 }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/image/models')) return Response.json(models)
    if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
    if (url.endsWith('/v1/images/source-images')) {
      calls.uploads += 1
      return Response.json({
        id: `asset-${calls.uploads}`, media_type: 'image/png',
        byte_size: TINY_PNG.length, width: 1, height: 1, expires_at: '',
      })
    }
    if (url.endsWith('/v1/images/generations')) {
      calls.generations += 1
      const body = JSON.parse(String(init?.body || '{}'))
      const id = `stub-image-${calls.generations}`
      return Response.json({
        id, state: 'succeeded', model_id: body.model_id, prompt: body.prompt,
        width: 1024, height: 576, aspect_ratio: body.aspect_ratio,
        image_url: `/v1/images/${id}/file`,
      }, { status: 202 })
    }
    if (/\/v1\/images\/stub-image-\d+\/file$/.test(url)) {
      return new Response(TINY_PNG, { headers: { 'Content-Type': 'image/png' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof globalThis.fetch
  try { return await run(calls) } finally { globalThis.fetch = originalFetch }
}

test('an oversized reference is refused before it is uploaded or billed', async () => {
  const oversized = await writeReference(96, 40)
  await withImageGenStudio([imageModel({ reference_image_max_dimension: 64 })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await assert.rejects(provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'ref-dimension-too-big-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-ref-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: [oversized],
      idempotencyIdentity: 'ref-dimension-too-big',
    } as any), /up to 64px on the longest side[\s\S]*96x40px/)
    // Nothing left the machine: no upload, no charged generation.
    assert.equal(calls.uploads, 0)
    assert.equal(calls.generations, 0)
  })
})

test('a reference inside the published dimension is uploaded and generated', async () => {
  const fitting = await writeReference(64, 32)
  await withImageGenStudio([imageModel({ reference_image_max_dimension: 64 })], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'ref-dimension-ok-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-ref-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: [fitting],
      idempotencyIdentity: 'ref-dimension-ok',
    } as any)
    assert.equal(calls.uploads, 1)
    assert.equal(calls.generations, 1)
  })
})

test('a model publishing no dimension gets no invented ceiling', async () => {
  const huge = await writeReference(512, 256)
  await withImageGenStudio([imageModel()], async (calls) => {
    const provider = registry.getImageProvider('genstudio-image')!
    await provider.generateImage({
      prompt: 'A calm river at dusk.',
      apiKey: 'ref-dimension-unpublished-key',
      aspectRatio: '16:9',
      modelId: 'genstudio-image-ref-v1',
      providerParams: { provider: 'genstudio-image' },
      referenceImagePaths: [huge],
      idempotencyIdentity: 'ref-dimension-unpublished',
    } as any)
    // GenStudio said nothing, so Story Studio says nothing and lets the
    // boundary decide. It must NOT fall back to some local number.
    assert.equal(calls.uploads, 1)
    assert.equal(calls.generations, 1)
  })
})

test('the image provider enforces the published reference dimension before upload', () => {
  const provider = readFileSync(new URL('../providers/image/genstudio.ts', import.meta.url), 'utf8')
  const enforcement = provider.indexOf('reference_image_max_dimension')
  const upload = provider.indexOf('uploadImageSourceWithGenStudio(request.apiKey')
  assert.ok(enforcement > 0, 'the published dimension must be read')
  assert.ok(upload > 0, 'the reference upload call must still exist')
  assert.ok(enforcement < upload, 'the check must run BEFORE the upload, not after it')
  // No invented ceiling when GenStudio publishes nothing.
  assert.match(provider, /Number\.isInteger\(maxReferenceDimension\)/)
  assert.match(provider, /No request or credit charge was made/)
})

test('the local byte cap stays, and stays labelled as a local bound', () => {
  const route = readFileSync(new URL('../routes/image-references.ts', import.meta.url), 'utf8')
  assert.match(route, /const MAX_IMAGE_BYTES = 10 \* 1024 \* 1024/)
  assert.match(route, /LOCAL storage bound only/)
})

test('the image model picker shows the reference dimension it will enforce', () => {
  const picker = readFileSync(
    new URL('../../../frontend/components/ImageModelPicker.vue', import.meta.url),
    'utf8',
  )
  assert.match(picker, /referenceDimensionNotice/)
  assert.match(picker, /reference_image_max_dimension/)
  // Shown only in reference mode, and only when a real number is published.
  assert.match(picker, /imageMode !== 'img2img'/)
  assert.match(picker, /limit <= 0\) return ''/)
})

// ── 4. A published SWITCH: the lane's boolean parameters ─────────────────
//
// `generates_audio` above says the product makes a soundtrack. It says nothing
// about whether a caller may ask for a clip WITHOUT one — that is a separate
// published fact, measured 2026-09-27 when a local Studio Hub video lane began
// publishing `audio` (default true, with the lane's own note) and the gateway
// relayed it on the video row. These tests pin the three statements apart:
// a switch, a lane that publishes none, and an entry that cannot be read.

test('published video switches are carried through, and a lane with none carries no key', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json([
      {
        id: 'video-switch', display_name: 'Video Switch', available: true,
        modes: ['image-to-video'], aspect_ratios: ['16:9'], generates_audio: true,
        controls: [
          { name: 'audio', type: 'boolean', default: true, note: 'the lane its own sentence' },
          // An unsupported type stays visible so Motion Review can refuse with an update notice;
          // the nameless and typeless rows below could not be rendered or sent at all.
          { name: 'seed', type: 'integer', default: -1 },
          { name: '   ', type: 'boolean', default: false },
          { type: 'boolean', default: true },
        ],
        variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'v1' }],
      },
      {
        id: 'video-no-switch', display_name: 'Video No Switch', available: true,
        modes: ['image-to-video'], aspect_ratios: ['16:9'], generates_audio: true,
        variants: [{ operation: 'image-to-video', duration_seconds: 5, resolution: '720p', credits_per_video: 12, minimum_credits: 12, price_version: 'v1' }],
      },
    ])
    const models = await listVideoModels('video-switch-key')
    const withSwitch = models.find(model => model.id === 'video-switch')
    assert.deepEqual(withSwitch?.controls, [
      // Name, type and the lane's own default and note — nothing coerced, nothing added. The
      // unsupported `integer` is kept (type intact, default coerced to null because it is not a
      // boolean), which is what makes Motion Review refuse the model rather than silently ignore it.
      { name: 'audio', type: 'boolean', default: true, note: 'the lane its own sentence' },
      { name: 'seed', type: 'integer', default: null, note: null },
    ])
    // Absent is not an empty list: a lane that publishes no switch must be
    // distinguishable from one whose switches were all unreadable, because a
    // surface renders a control for the first and nothing for either.
    assert.equal('controls' in (models.find(model => model.id === 'video-no-switch') || {}), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the audio switch changes the idempotency key, because it changes what is bought', async () => {
  const { buildGenStudioVideoIdempotencyKey } = await import('../lib/genstudio-client.js')
  const base = {
    prompt: 'a harbour at dawn',
    modelId: 'local-video-lane',
    sourceSha256: 'a'.repeat(64),
    aspectRatio: '11:7',
    operation: 'image-to-video',
    durationSeconds: 4,
    resolution: '448p',
  }
  const unstated = buildGenStudioVideoIdempotencyKey(base)
  const on = buildGenStudioVideoIdempotencyKey({ ...base, audio: true })
  const off = buildGenStudioVideoIdempotencyKey({ ...base, audio: false })
  // All three are different requests: "the lane defaulted" must not replay the
  // job that was asked to write a track, and a silent retry must not re-attach
  // to it either.
  assert.notEqual(unstated, on)
  assert.notEqual(unstated, off)
  assert.notEqual(on, off)
  // And the same request is still the same key.
  assert.equal(off, buildGenStudioVideoIdempotencyKey({ ...base, audio: false }))
})

test('a silent request reaches the wire, and an unstated one sends no field at all', async () => {
  const { generateVideoWithGenStudio } = await import('../lib/genstudio-client.js')
  const calls: Array<{ path: string, body: any }> = []
  const originalFetch = globalThis.fetch
  const temp = mkdtempSync(path.join(tmpdir(), 'story-audio-switch-'))
  const source = path.join(temp, 'scene.png')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(source, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))
  try {
    globalThis.fetch = async (input: any, init: any) => {
      const url = String(typeof input === 'string' ? input : input?.url || input)
      // The source-image upload is multipart; only the JSON submissions are read here.
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      calls.push({ path: new URL(url).pathname, body })
      if (url.includes('/v1/videos/source-images')) return Response.json({ id: 'asset-1' })
      if (url.includes('/v1/videos/generations')) {
        return Response.json({
          id: 'job-1', state: 'succeeded', model_id: 'video-switch', credits: 0, remaining_credits: 0,
          outputs: [{ asset_id: 'clip-1', url: 'http://127.0.0.1:1/clip.mp4' }],
        })
      }
      return Response.json({ paid_concurrency_limit: 5, paid_active_jobs: 0, paid_queued_jobs: 0, max_queued_jobs: 25, generation_submissions_per_minute: 30 })
    }
    const submit = (audio?: boolean) => generateVideoWithGenStudio('video-switch-key', {
      prompt: 'a harbour at dawn',
      modelId: 'video-switch',
      sourceImagePath: source,
      aspectRatio: '16:9',
      operation: 'image-to-video',
      durationSeconds: 5,
      resolution: '720p',
      ...(typeof audio === 'boolean' ? { audio } : {}),
    })
    await submit(false)
    const silent = calls.filter(call => call.path === '/v1/videos/generations').at(-1)
    assert.equal(silent?.body?.audio, false, 'the OFF half of the switch is the whole point of it')
    await submit(undefined)
    const unstated = calls.filter(call => call.path === '/v1/videos/generations').at(-1)
    assert.equal('audio' in (unstated?.body || {}), false,
      'sending `true` on every request would override a lane whose default is the other way')
  } finally {
    globalThis.fetch = originalFetch
  }
})
