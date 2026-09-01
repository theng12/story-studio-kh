/**
 * Scene Review sends the episode's ONE reference image.
 *
 * WHAT WAS BROKEN. `generators/continuity-render.ts` carried the comment
 * "Reference-image execution is intentionally absent until GenStudio publishes
 * that capability." GenStudio published it: ten of the eleven live image
 * products accept references, `lib/genstudio-client.ts` maps the capability,
 * and `providers/image/genstudio.ts` already uploads a reference and submits
 * its asset id. The generator simply never asked. Meanwhile the Character
 * Sheet's "Use episode anchor" switch wrote `use_episode_sheet` and
 * `references.sheet` to disk and NOTHING read either one, so the customer
 * could turn a feature on and watch nothing happen.
 *
 * WHY THESE TESTS LOOK LIKE THIS. Asserting that a field was set proves
 * nothing about what left the machine. Every test below drives the real
 * generator against the in-process mock GenStudio service and then reads
 * `service.requests` — the actual HTTP traffic — to decide whether a reference
 * was uploaded and whether `reference_asset_ids` reached the generation POST.
 *
 * ZERO paid calls. Nothing here touches the real GenStudio.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import {
  EPISODE_REFERENCE_FILENAMES,
  planEpisodeReference,
} from '../generators/continuity-render.js'
import { FITTED_REFERENCE_DIRNAME, fitReferenceBuffer, fitReferenceImage } from '../lib/reference-image-fit.js'
import { publishedReferenceCeiling } from '../services/image-model-resolver.js'

// ── The pure decision ────────────────────────────────────────────────────

test('the switch OFF is the only silent way to send no reference', () => {
  const off = planEpisodeReference({
    enabled: false,
    availablePaths: ['/ep/img2img-references/composition.png'],
    supportsReferences: true,
    maxReferences: 1,
    chargeable: true,
    modelName: 'nano-banana-2',
  })
  assert.equal(off.sourcePath, '')
  assert.equal(off.note, '', 'off means off — there is nothing to report')
})

test('a model publishing zero references degrades out loud, naming the model', () => {
  // FLUX.2 Klein's live shape: available, chargeable, and text-to-image only.
  // Failing the batch would be wrong (the render is perfectly possible) and so
  // would rendering silently (the customer asked for a reference and would be
  // told nothing). The only honest outcome is the render plus the reason.
  const plan = planEpisodeReference({
    enabled: true,
    availablePaths: ['/ep/img2img-references/composition.png'],
    supportsReferences: false,
    maxReferences: 0,
    chargeable: true,
    modelName: 'flux-2-klein',
  })
  assert.equal(plan.sourcePath, '', 'nothing may be attached to a 0-reference model')
  assert.match(plan.note, /flux-2-klein/, 'the note must name the model that refused')
  assert.match(plan.note, /max_reference_images: 0/)
  assert.match(plan.note, /prompt text only/i)
})

test('the switch on with nothing on disk says so instead of going quiet', () => {
  const plan = planEpisodeReference({
    enabled: true, availablePaths: [], supportsReferences: true, maxReferences: 1, chargeable: true, modelName: 'nano-banana-2',
  })
  assert.equal(plan.sourcePath, '')
  assert.match(plan.note, /composition\.png or master\.png/)
})

test('the generated composition template outranks the hand-uploaded anchor', () => {
  assert.deepEqual([...EPISODE_REFERENCE_FILENAMES], ['composition.png', 'master.png'])
  const plan = planEpisodeReference({
    enabled: true,
    availablePaths: ['/ep/img2img-references/composition.png', '/ep/img2img-references/master.png'],
    supportsReferences: true,
    maxReferences: 1,
    chargeable: true,
    modelName: 'nano-banana-2',
  })
  assert.equal(path.basename(plan.sourcePath), 'composition.png')
  assert.equal(plan.note, '')
})

// ── Fitting an app-generated reference to the published ceiling ──────────

async function png(dir: string, name: string, width: number, height: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await sharp({ create: { width, height, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .png().toFile(file)
  return file
}

test('a composition template rendered larger than the reference ceiling is fitted, not refused', async () => {
  // The real numbers: every reference-capable product publishes a 1024px
  // ceiling, and this app renders composition.png at the model's own published
  // 1K/16:9 output row — 1280x720. Without this the batch would die telling the
  // owner to resize a file the app produced for him.
  const temp = await useTempDataDir()
  try {
    const source = await png(path.join(temp.dir, 'refs'), 'composition.png', 1280, 720)
    const before = await fs.readFile(source)
    const fitted = await fitReferenceImage(source, 1024, path.join(temp.dir, 'refs', FITTED_REFERENCE_DIRNAME))
    assert.equal(fitted.resized, true)
    assert.notEqual(fitted.path, source, 'the derived copy must not overwrite the original')
    assert.deepEqual(fitted.to, { width: 1024, height: 576 }, 'aspect ratio is preserved inside the ceiling')
    const meta = await sharp(fitted.path).metadata()
    assert.equal(Math.max(meta.width!, meta.height!), 1024)
    assert.deepEqual(await fs.readFile(source), before, 'the source file is never touched')
  } finally {
    await temp.cleanup()
  }
})

test('a reference already inside the ceiling is submitted byte-for-byte', async () => {
  const temp = await useTempDataDir()
  try {
    const source = await png(path.join(temp.dir, 'refs'), 'master.png', 800, 450)
    const fitted = await fitReferenceImage(source, 1024, path.join(temp.dir, 'refs', FITTED_REFERENCE_DIRNAME))
    assert.equal(fitted.path, source)
    assert.equal(fitted.resized, false)
    assert.equal(await exists(path.join(temp.dir, 'refs', FITTED_REFERENCE_DIRNAME)), false, 'no derived copy is written')
  } finally {
    await temp.cleanup()
  }
})

test('a model publishing no ceiling gets no locally invented one', async () => {
  const temp = await useTempDataDir()
  try {
    const source = await png(path.join(temp.dir, 'refs'), 'composition.png', 4000, 2250)
    const fitted = await fitReferenceImage(source, undefined, path.join(temp.dir, 'refs', FITTED_REFERENCE_DIRNAME))
    assert.equal(fitted.path, source)
    assert.equal(fitted.resized, false)
  } finally {
    await temp.cleanup()
  }
})

// ── The upload boundary ──────────────────────────────────────────────────
//
// `fitReferenceImage` above runs at SUBMIT time, where one model is in scope.
// Only `continuity-render.ts` ever called it. `generators/images.ts` — the
// Scene and Thumbnail generator, which submits master, per-scene, character,
// thumbnail and art-style references — never did, so a phone photo uploaded
// fine and then failed every render that used it with "resize it and retry",
// on an image the customer had no tool to resize. Fitting on the way IN fixes
// every downstream path at once.

test('a phone-sized photo is fitted on upload, so every generator gets a submittable file', async () => {
  // A modern phone photo is about 4032x3024. The catalogue publishes 1024.
  const source = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: '#446688' } })
    .png().toBuffer()
  const fitted = await fitReferenceBuffer(source, 1024)
  assert.equal(fitted.resized, true)
  assert.deepEqual(fitted.from, { width: 4032, height: 3024 })
  assert.deepEqual(fitted.to, { width: 1024, height: 768 }, 'aspect ratio is preserved inside the ceiling')
  const meta = await sharp(fitted.data).metadata()
  assert.equal(Math.max(meta.width!, meta.height!), 1024)
})

test('an upload already inside the ceiling is stored byte-for-byte', async () => {
  const source = await sharp({ create: { width: 800, height: 450, channels: 3, background: '#224466' } })
    .png().toBuffer()
  const fitted = await fitReferenceBuffer(source, 1024)
  assert.equal(fitted.resized, false)
  assert.deepEqual(fitted.data, source, 're-encoding a file that already fits would change it for nothing')
})

test('no published ceiling means no locally invented one, and the bytes are stored as sent', async () => {
  const source = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: '#446688' } })
    .png().toBuffer()
  const fitted = await fitReferenceBuffer(source, undefined)
  assert.equal(fitted.resized, false)
  assert.deepEqual(fitted.data, source)
})

test('a payload that is not a decodable image is stored unchanged, not rejected here', async () => {
  // The upload route's only gate is its byte cap; the precise "corrupt or
  // incomplete" message belongs to the decode check at submit time. Throwing
  // here would turn a fit into a new upload failure the route never had.
  const junk = Buffer.from('not an image at all')
  const fitted = await fitReferenceBuffer(junk, 1024)
  assert.equal(fitted.resized, false)
  assert.deepEqual(fitted.data, junk)
})

test('the upload ceiling is the strictest published one, so any model can consume the result', () => {
  const models = [
    { supports_reference_images: true, max_reference_images: 4, reference_image_max_dimension: 2048 },
    { supports_reference_images: true, max_reference_images: 1, reference_image_max_dimension: 1024 },
    // Publishes no ceiling: contributes nothing rather than a default.
    { supports_reference_images: true, max_reference_images: 1 },
    // Cannot take references at all: its ceiling is irrelevant here.
    { supports_reference_images: false, max_reference_images: 0, reference_image_max_dimension: 256 },
  ] as never[]
  assert.equal(publishedReferenceCeiling(models), 1024,
    'the maximum would store a file the stricter half of the catalogue rejects')
  assert.equal(publishedReferenceCeiling([]), undefined)
  assert.equal(
    publishedReferenceCeiling([{ supports_reference_images: true, max_reference_images: 1 }] as never[]),
    undefined,
    'a catalogue that publishes no ceiling must not get one invented for it',
  )
})

test('a corrupt reference fails with the app\'s own message, before any scene is submitted', async () => {
  // A bare `metadata()` reads headers only, so a truncated PNG sails past it
  // and throws mid-resize with a raw sharp stack. Routing the size read
  // through the app's decode check gives the customer the message the rest of
  // the app uses — and raises it before the first charged submit.
  const temp = await useTempDataDir()
  try {
    const dir = path.join(temp.dir, 'refs')
    const good = await png(dir, 'composition.png', 1280, 720)
    const bytes = await fs.readFile(good)
    await fs.writeFile(good, bytes.subarray(0, Math.floor(bytes.length / 2)))
    await assert.rejects(
      fitReferenceImage(good, 1024, path.join(dir, FITTED_REFERENCE_DIRNAME)),
      /Reference image is corrupt or incomplete/,
    )
  } finally {
    await temp.cleanup()
  }
})

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false)
}

// ── The wire ─────────────────────────────────────────────────────────────

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Reference wiring', logline: 'A deterministic mock episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return { project, episodeId: accepted.episode_code, paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code) }
}

async function configureMockGenStudio(baseUrl: string): Promise<void> {
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
}

/**
 * Republish the mock image catalogue with real reference capability.
 *
 * The stock fixture publishes `max_reference_images: 0` — which happens to be
 * exactly FLUX.2 Klein's live shape, so the degrade test needs no patch at all.
 */
async function withReferenceCapableCatalog(
  baseUrl: string,
  overrides: Record<string, unknown>,
): Promise<() => Promise<void>> {
  const originalFetch = globalThis.fetch
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== baseUrl || !['/v1/image/models', '/v1/images/models'].includes(url.pathname)) return response
    const models = await response.json() as Array<Record<string, unknown>>
    return new Response(JSON.stringify(models.map(model => ({ ...model, ...overrides }))), {
      status: response.status, headers: { 'Content-Type': 'application/json' },
    })
  }
  clearGenStudioCatalogCache()
  return async () => { globalThis.fetch = originalFetch; clearGenStudioCatalogCache() }
}

const REFERENCE_CAPABLE = {
  supports_reference_images: true,
  supports_image_to_image: true,
  max_reference_images: 1,
  min_reference_images: 0,
  reference_image_max_dimension: 1024,
  chargeable: true,
  operations: ['image.generation', 'image.edit'],
}

/** A reference-capable product that is nonetheless not chargeable. */
const REFERENCE_CAPABLE_UNCHARGEABLE = { ...REFERENCE_CAPABLE, chargeable: false }

async function writeScenePrerequisites(
  paths: { scene_prompts_dir: string; subtitles_dir: string },
  episodeId: string,
  scenes: Array<Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nTest\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
}

function renderJob(projectSlug: string, episodeId: string, renderAttemptId?: string): any {
  return {
    job_id: `continuity-reference-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    project_slug: projectSlug,
    type: 'continuity_render',
    episode_id: episodeId,
    title: 'Reference wiring test',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', force: true,
      ...(renderAttemptId ? { render_attempt_id: renderAttemptId } : {}),
    },
  }
}

/** Every generation POST body the mock actually received. */
function generationBodies(service: { requests: Array<{ method: string; path: string; bodyText: string }> }): any[] {
  return service.requests
    .filter(r => r.method === 'POST' && r.path === '/v1/images/generations')
    .map(r => JSON.parse(r.bodyText))
}

function uploadCount(service: { requests: Array<{ method: string; path: string }> }): number {
  return service.requests.filter(r => r.method === 'POST' && r.path === '/v1/images/source-images').length
}

/** The replay identity the generation POST actually carried, in order. */
function generationKeys(
  service: { requests: Array<{ method: string; path: string; idempotencyKey: string }> },
): string[] {
  return service.requests
    .filter(r => r.method === 'POST' && r.path === '/v1/images/generations')
    .map(r => r.idempotencyKey)
}

/**
 * One deterministic Scene Review render against the mock service.
 *
 * `continuity` is written verbatim to the episode's `continuity.json`, and
 * `references` names files created under `img2img-references/` beforehand.
 */
async function render(options: {
  name: string
  continuity: Record<string, unknown>
  references?: Array<{ name: string; width: number; height: number }>
  scenes?: Array<Record<string, unknown>>
  catalogOverrides?: Record<string, unknown>
}) {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreCatalog: (() => Promise<void>) | null = null
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    if (options.catalogOverrides) {
      restoreCatalog = await withReferenceCapableCatalog(service.baseUrl, options.catalogOverrides)
    }
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { project, episodeId, paths } = await createEpisode(options.name)
    await writeScenePrerequisites(paths, episodeId, options.scenes ?? [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' },
    ])
    await fs.writeFile(
      path.join(paths.episode_dir, 'continuity.json'),
      JSON.stringify({ schema_version: 1, ...options.continuity }),
    )
    const refsDir = path.join(paths.episode_dir, 'img2img-references')
    for (const ref of options.references ?? []) await png(refsDir, ref.name, ref.width, ref.height)

    const job = renderJob(project.slug, episodeId)
    await runContinuityRenderJob(job)
    return {
      job,
      refsDir,
      uploads: uploadCount(service),
      bodies: generationBodies(service),
      keys: generationKeys(service),
      lines: job.output_lines.join('\n'),
    }
  } finally {
    if (restoreCatalog) await restoreCatalog()
    await service.close()
    await temp.cleanup()
  }
}

test('an accepted Continuity scene publishes its durable filename as the active key', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreCatalog: (() => Promise<void>) | null = null
  const originalFetch = globalThis.fetch
  let releasePoll!: () => void
  let signalPoll!: () => void
  const pollStarted = new Promise<void>(resolve => { signalPoll = resolve })
  const pollRelease = new Promise<void>(resolve => { releasePoll = resolve })
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    restoreCatalog = await withReferenceCapableCatalog(service.baseUrl, REFERENCE_CAPABLE)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      if (url.origin === service.baseUrl && method === 'GET' && /^\/v1\/images\/[^/]+$/.test(url.pathname)) {
        signalPoll()
        await pollRelease
      }
      return originalFetch(input, init)
    }

    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { proveContinuitySettlingTail } = await import('../services/job-queue.js')
    const { project, episodeId, paths } = await createEpisode('Canonical active scene key')
    const scene = { id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' }
    const filename = 'scene-001.png'
    await writeScenePrerequisites(paths, episodeId, [
      scene,
      { id: 'scene-002', scene_index: 2, visual_prompt: 'A clock in a quiet archive.' },
    ])
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1 }))
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await png(outDir, 'scene-002.png', 1, 1)
    const job = renderJob(project.slug, episodeId)
    job.params.force = false
    const renderPromise = runContinuityRenderJob(job)

    await pollStarted
    const taskId = service.submissions.find(submission => submission.operation === 'image')!.jobId
    const manifest = await readManifest(outDir)
    const active = job.item_progress?.active[0]
    const activeSnapshot = { key: active?.key, label: active?.label, state: active?.state }
    const checkpointTaskId = active?.key ? job.params.genstudio_recovery.assets[active.key].job_id : undefined
    const manifestTaskId = active?.key ? manifest.tasks[active.key]?.task_id : undefined
    job.genstudio_jobs = [{
      id: taskId,
      operation: 'image.generation',
      state: 'running',
      updated_at: new Date().toISOString(),
      request: { idempotency_key: job.params.genstudio_recovery.assets[filename].idempotency_key },
    }]
    const tailProof = await proveContinuitySettlingTail(job)
    const outputDirAtAcceptance = job.output_dir
    releasePoll()
    await renderPromise
    assert.deepEqual(
      activeSnapshot,
      { key: filename, label: 'Scene 1', state: 'running' },
      `expected active.key to be ${filename}; the legacy scene-1 key cannot directly join the checkpoint or manifest`,
    )
    assert.equal(checkpointTaskId, taskId)
    assert.equal(manifestTaskId, taskId)
    assert.equal(outputDirAtAcceptance, outDir, 'the queue proof reads the same output directory that the live render owns')
    assert.deepEqual(tailProof, {
      job_id: job.job_id,
      settling: 1,
      concurrency: 2,
      active_asset_keys: [filename],
      provider_task_ids: [taskId],
    })
  } finally {
    releasePoll?.()
    globalThis.fetch = originalFetch
    if (restoreCatalog) await restoreCatalog()
    await service.close()
    await temp.cleanup()
  }
})

test('a fleet-busy Continuity retry republishes its active canonical filename on attempt two', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  const fleetBusy = await import('../lib/genstudio-fleet-busy.js')
  const delays = fleetBusy.FLEET_BUSY_RETRY_DELAYS_MS as number[]
  const originalDelay = delays[0]!
  let releaseSecondSubmit!: () => void
  let signalSecondSubmit!: () => void
  const secondSubmitStarted = new Promise<void>(resolve => { signalSecondSubmit = resolve })
  const secondSubmitRelease = new Promise<void>(resolve => { releaseSecondSubmit = resolve })
  let generationResponses = 0
  try {
    delays[0] = 1
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', {
      states: ['failed'], failureCode: 'SITE_PLACEMENT_EXHAUSTED', reservedCredits: 7, finalCredits: 0,
    })
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      if (url.origin === service.baseUrl && method === 'POST' && url.pathname === '/v1/images/generations') {
        generationResponses++
        if (generationResponses === 2) {
          signalSecondSubmit()
          await secondSubmitRelease
        }
      }
      return response
    }
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { project, episodeId, paths } = await createEpisode('Retry active key')
    await writeScenePrerequisites(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' },
    ])
    await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1 }))
    const job = renderJob(project.slug, episodeId)
    const renderPromise = runContinuityRenderJob(job)

    await secondSubmitStarted
    const secondAttempt = job.item_progress?.active[0]
    releaseSecondSubmit()
    await renderPromise
    assert.deepEqual(
      { key: secondAttempt?.key, state: secondAttempt?.state, attempt: secondAttempt?.attempt },
      { key: 'scene-001.png', state: 'running', attempt: 1 },
      'the second provider attempt must not disappear from live progress after the first attempt cleans up',
    )
  } finally {
    releaseSecondSubmit?.()
    delays[0] = originalDelay
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('the switch ON uploads the composition template and submits its asset id', async () => {
  const result = await render({
    name: 'Reference on',
    continuity: { use_episode_sheet: true, references: { sheet: true } },
    references: [{ name: 'composition.png', width: 1280, height: 720 }],
    catalogOverrides: REFERENCE_CAPABLE,
  })
  assert.equal(result.uploads, 1, 'exactly one reference is uploaded — one scene, one reference')
  assert.equal(result.bodies.length, 1)
  assert.ok(
    Array.isArray(result.bodies[0].reference_asset_ids) && result.bodies[0].reference_asset_ids.length === 1,
    `the generation POST must carry one reference asset id, got ${JSON.stringify(result.bodies[0].reference_asset_ids)}`,
  )
  assert.match(result.lines, /Episode reference: composition\.png/)
  // The template is rendered at the published 1K output size and the ceiling is
  // 1024, so the app must have fitted its own artefact rather than failing.
  assert.match(result.lines, /resized 1280x720 → 1024x576/)
})

test('the switch OFF sends nothing, even with the reference sitting on disk', async () => {
  const result = await render({
    name: 'Reference off',
    continuity: { use_episode_sheet: false, references: { sheet: false, composition: false } },
    references: [{ name: 'composition.png', width: 800, height: 450 }],
    catalogOverrides: REFERENCE_CAPABLE,
  })
  assert.equal(result.uploads, 0, 'off must mean no upload at all')
  assert.equal(result.bodies.length, 1)
  assert.equal(result.bodies[0].reference_asset_ids, undefined)
  assert.doesNotMatch(result.lines, /Episode reference/)
})

test('a legacy sidecar carrying only the references.sheet mirror still counts as ON', async () => {
  // The Character Sheet writes both names; older episode files carry only this
  // one. Reading `use_episode_sheet` alone would ignore the customer's choice
  // on every one of them.
  const result = await render({
    name: 'Reference legacy mirror',
    continuity: { references: { sheet: true } },
    references: [{ name: 'master.png', width: 900, height: 506 }],
    catalogOverrides: REFERENCE_CAPABLE,
  })
  assert.equal(result.uploads, 1)
  assert.match(result.lines, /Episode reference: master\.png/)
})

test('FLUX.2 Klein renders the scene and says why the anchor was not used', async () => {
  // The stock mock catalogue publishes `max_reference_images: 0` — Klein's own
  // live shape. No catalogue patch: this is the unmodified refusal path.
  const result = await render({
    name: 'Reference zero capacity',
    continuity: { use_episode_sheet: true, references: { sheet: true } },
    references: [{ name: 'composition.png', width: 800, height: 450 }],
  })
  assert.equal(result.uploads, 0, 'nothing may be uploaded to a model that cannot use it')
  assert.equal(result.bodies.length, 1, 'the scene must still render')
  assert.equal(result.bodies[0].reference_asset_ids, undefined)
  assert.match(result.lines, /publishes no reference-image support/)
  assert.match(result.lines, /max_reference_images: 0/)
})

test('a reference-capable but non-chargeable product degrades instead of failing the batch', async () => {
  // The provider refuses a reference on a non-chargeable product with the same
  // error it uses for an unsupported one. Anticipating only the first refusal
  // would turn one catalogue flag into a whole failed render.
  const result = await render({
    name: 'Reference not chargeable',
    continuity: { use_episode_sheet: true, references: { sheet: true } },
    references: [{ name: 'composition.png', width: 800, height: 450 }],
    catalogOverrides: REFERENCE_CAPABLE_UNCHARGEABLE,
  })
  assert.equal(result.uploads, 0)
  assert.equal(result.bodies.length, 1, 'the scene must still render')
  assert.equal(result.bodies[0].reference_asset_ids, undefined)
  assert.match(result.lines, /not chargeable/)
})

test('a non-character scene drops the episode reference exactly as it drops the character text', async () => {
  const result = await render({
    name: 'Reference cutaway',
    continuity: { use_episode_sheet: true, references: { sheet: true } },
    references: [{ name: 'composition.png', width: 800, height: 450 }],
    scenes: [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'The guide beside the artifact.', scene_type: 'character' },
      { id: 'scene-002', scene_index: 2, visual_prompt: 'A map of the trade routes.', scene_type: 'map' },
    ],
    catalogOverrides: REFERENCE_CAPABLE,
  })
  assert.equal(result.bodies.length, 2)
  const withReference = result.bodies.filter(b => Array.isArray(b.reference_asset_ids) && b.reference_asset_ids.length)
  assert.equal(withReference.length, 1, 'only the character scene carries the reference')
  assert.match(withReference[0].prompt, /guide beside the artifact/)
  assert.equal(result.uploads, 1)
  assert.match(result.lines, /1 non-character scene\(s\) render without the episode reference/)
})

test('turning the switch on changes the saved request identity, so a retry cannot reclaim the text-only image', async () => {
  // The durable manifest reconnects to a saved GenStudio job when the scope and
  // the prompt hash match, and neither of those moves when the anchor is
  // switched on. Without the reference in that hash, flipping the switch and
  // re-rendering would hand back the previous TEXT-ONLY render "for free" while
  // the log claimed a reference had been applied.
  //
  // This has to be ONE episode rendered twice. Two episodes would differ in
  // their project slug, which is already part of the identity, and the test
  // would pass without the reference being in it at all.
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  let restoreCatalog: (() => Promise<void>) | null = null
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    restoreCatalog = await withReferenceCapableCatalog(service.baseUrl, REFERENCE_CAPABLE)
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { readManifest } = await import('../services/task-manifest.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { project, episodeId, paths } = await createEpisode('Reference identity')
    await writeScenePrerequisites(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.' },
    ])
    await png(path.join(paths.episode_dir, 'img2img-references'), 'composition.png', 800, 450)
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const continuityPath = path.join(paths.episode_dir, 'continuity.json')

    // ONE fixed attempt id across all three passes. A force re-render otherwise
    // derives its scope from the job id, and the scope is already part of the
    // recorded hash — three random job ids would produce three different hashes
    // whether or not a reference was ever involved, and this test would pass
    // while proving nothing. (It did exactly that, once.)
    const renderWith = async (continuity: Record<string, unknown>) => {
      await fs.writeFile(continuityPath, JSON.stringify({ schema_version: 1, ...continuity }))
      const job = renderJob(project.slug, episodeId, 'fixed-render-attempt')
      await runContinuityRenderJob(job)
      return {
        hash: (await readManifest(outDir)).tasks['scene-001.png']!.input_hash,
        key: generationKeys(service).at(-1)!,
        uploads: uploadCount(service),
      }
    }

    const off = await renderWith({ use_episode_sheet: false })
    const on = await renderWith({ use_episode_sheet: true, references: { sheet: true } })

    assert.equal(off.uploads, 0)
    assert.equal(on.uploads, 1, 'the second pass really did attach the reference')
    assert.notEqual(on.hash, off.hash, 'the recorded manifest hash must move when a reference is attached')
    assert.notEqual(on.key, off.key, 'a referenced render must not share a replay identity with a text-only one')

    // ...and the same prompt with the same switch position must STILL reconnect,
    // or every re-run would buy a second copy of an image already paid for.
    const again = await renderWith({ use_episode_sheet: true, references: { sheet: true } })
    assert.equal(again.hash, on.hash, 'an unchanged referenced render keeps its replay identity')
  } finally {
    if (restoreCatalog) await restoreCatalog()
    await service.close()
    await temp.cleanup()
  }
})

test('the generator submits the reference through the guarded provider seam', () => {
  // A future edit that reaches past providers/image/genstudio.ts would skip the
  // published capability, count, and pixel-ceiling checks that all run BEFORE
  // the charged POST.
  const source = readSource('../generators/continuity-render.ts')
  assert.match(source, /referenceImagePaths: requestReferences/)
  assert.doesNotMatch(source, /uploadImageSourceWithGenStudio/, 'never upload around the provider')
  assert.doesNotMatch(
    source,
    /Reference-image execution\s+\/\/ is intentionally absent/,
    'the stale "not yet published" claim must not come back',
  )
  assert.doesNotMatch(source, /max_reference_images: \d/, 'the ceiling is published, never hardcoded')
})

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}
