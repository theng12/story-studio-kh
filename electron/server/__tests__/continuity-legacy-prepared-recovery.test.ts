/**
 * A `prepared` scene-image row written before the idempotency key became
 * durable (v1.4.16x) records the request identity it reserved — `request_scope`
 * and `input_hash` — but not the key itself. The row is written BEFORE the
 * POST, so its presence never proves that POST was never sent, and nothing else
 * on disk does either: no Gateway job id, no key, no checkpoint entry naming a
 * job for that asset.
 *
 * These tests pin what may happen to such a row:
 *   - the Gateway authoritatively has no request for the identity the row
 *     reserved → the scene is rendered, under that SAME key (never a fresh
 *     identity, and never a second request for one that does exist);
 *   - the Gateway cannot confirm it, the row no longer describes this scene, or
 *     the job's own record already shows a dispatched request → held, in plain
 *     words, with nothing submitted and nothing invented on disk;
 *   - a completed/succeeded identity beside it is still recovered from its own
 *     saved task, never re-rendered and never overwritten.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const PAID_IMAGE_MODEL = 'mock-image-v1'
const FREE_FLEET_IMAGE_MODEL = 'studio-hub::mock-image-v1'
const LANTERN_PROMPT = 'A lantern in a quiet archive.'
const SECOND_PROMPT = 'A second lantern, dimmer.'

function imageCatalogRow(id: string, chargeable: boolean) {
  return {
    id, display_name: 'Mock Image', description: 'In-process PNG fixture.',
    available: true, qualification_only: false, chargeable,
    aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', default_resolution: '1K',
    output_options: [
      { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true,
        credits_per_image: chargeable ? 4 : 0, price_version: 'mock-image-price-v1' },
    ],
    supports_seed: true, supports_image_to_image: false, operations: ['image.generation'],
    max_prompt_characters: 4800, prompt_token_allowance: 1200,
    min_reference_images: 0, max_reference_images: 0,
  }
}

async function writeAuthoritativeFixture(job: any): Promise<void> {
  const queue = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  await queue._waitForJobPersistenceForTesting()
  const jobsFile = path.join(pm.getProjectDir(job.project_slug)!, 'jobs.json')
  await fs.writeFile(jobsFile, JSON.stringify({ jobs: [job] }))
  queue._forgetProjectPersistenceForTesting(job.project_slug)
}

async function createContinuityFixture(name: string, prompts: string[]) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: name, logline: 'Legacy prepared fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'neutral' }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: prompts.map((visual_prompt, index) => ({
      id: `scene-${String(index + 1).padStart(3, '0')}`, scene_index: index + 1, visual_prompt,
    })),
  }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nFixture\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({ schema_version: 1 }))
  return { project, episodeId, paths }
}

function continuityJob(name: string, project: any, episodeId: string, model: string, sceneIds: string[]) {
  const now = new Date().toISOString()
  return {
    job_id: name, project_slug: project.slug, type: 'continuity_render', episode_id: episodeId,
    title: 'Legacy prepared recovery', status: 'running', created_at: now, started_at: now, finished_at: null,
    local_execution_complete: false, error: null, output_lines: [],
    params: {
      episode_id: episodeId, model, aspect_ratio: '16:9', resolution: '1K',
      scene_ids: sceneIds, missing_only: true,
    },
  } as any
}

/**
 * The exact identity the generator derives for one scene of this fixture — the
 * same facts a real submission would have used, so a row carrying them still
 * describes the scene.
 */
async function sceneIdentity(prompt: string, baseScope: string) {
  const { buildPaidImageOriginalIdentity } = await import('../services/image-paid-replacement.js')
  return buildPaidImageOriginalIdentity({
    prompt, baseScope, references: [],
    selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' },
  })
}

/** The row a pre-v1.4.16x writer left behind: identity recorded, key not. */
function legacyPreparedRow(identity: Awaited<ReturnType<typeof sceneIdentity>>, outputPath: string) {
  return {
    provider: 'genstudio-image', task_id: '', submitted_at: '2026-08-20T00:00:00.000Z',
    input_hash: identity.inputHash, operation: 'image' as const,
    last_state: 'prepared', request_scope: identity.requestScope,
    original_output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, reference_mode: 'normal' as const },
    original_reference_inputs: [], original_reference_identity_hash: identity.referenceIdentityHash,
    original_output_path: outputPath,
  }
}

test('a legacy prepared row the Gateway has no request for is rendered under the key it reserved', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(PAID_IMAGE_MODEL, true)])
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Legacy prepared unsent', [LANTERN_PROMPT])
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const identity = await sceneIdentity(LANTERN_PROMPT, 'missing')
    await recordTaskStrict(outDir, 'scene-001.png', legacyPreparedRow(identity, outputPath))

    // The key the row's own recorded identity derives, from the same facts a
    // real submission uses. Named here only so the assertions can pin it.
    const { resolveOutputFormat } = await import('../services/generation-compression.js')
    const sceneOutputFormat = await resolveOutputFormat(project.slug, 'scene_images')
    const reservedKey = client.buildGenStudioImageIdempotencyKey({
      prompt: LANTERN_PROMPT, modelId: PAID_IMAGE_MODEL, aspectRatio: '16:9', resolution: '1K',
      requestIdentity: `${project.slug}:${episodeId}:scene:scene-001:image:${identity.requestScope}`,
      ...(sceneOutputFormat ? { outputFormat: sceneOutputFormat } : {}),
    })

    const job = continuityJob('legacy-prepared-unsent', project, episodeId, PAID_IMAGE_MODEL, ['scene-001'])
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })

    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(service.providerSubmissionCount('image'), 1, 'exactly one request: the scene was rendered, not failed and not retried')
    assert.equal(
      service.submissions[0]!.idempotencyKey, reservedKey,
      'the rebuilt key must be the identity the row reserved, never a new one',
    )
    assert.ok(
      job.output_lines.some((line: string) => /predates the recorded Gateway key/i.test(line)),
      `the job log must say why this row was rendered: ${job.output_lines.join('\n')}`,
    )
    await sharp(outputPath).stats()

    const completed = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(completed.last_state, 'succeeded')
    assert.equal(completed.idempotency_key, reservedKey, 'the reserved identity is now durable on the row')
    assert.ok(completed.task_id)
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('a legacy prepared row the Gateway cannot confirm is held, not re-requested', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    // A free-fleet model on purpose: the owner's leniency for free pictures must
    // NOT turn "I could not work out whether a request exists" into a resend.
    const model = FREE_FLEET_IMAGE_MODEL
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(model, false)])
      if (url.pathname.startsWith('/v1/images/by-idempotency-key/')) {
        return Response.json({ detail: 'temporary lookup failure' }, { status: 500 })
      }
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Legacy prepared uncertain', [LANTERN_PROMPT])
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const outputPath = path.join(outDir, 'scene-001.png')
    await fs.mkdir(outDir, { recursive: true })
    const identity = await sceneIdentity(LANTERN_PROMPT, 'missing')
    await recordTaskStrict(outDir, 'scene-001.png', legacyPreparedRow(identity, outputPath))

    const job = continuityJob('legacy-prepared-uncertain', project, episodeId, model, ['scene-001'])
    await writeAuthoritativeFixture(job)

    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 0, 'an unconfirmed reserved identity is never re-requested')
    assert.ok(
      job.output_lines.some((line: string) => /could not confirm the request that row reserved/i.test(line)),
      `the job log must name the scene and say what happened: ${job.output_lines.join('\n')}`,
    )
    const held = (await readManifest(outDir)).tasks['scene-001.png']!
    assert.equal(held.last_state, 'prepared')
    assert.equal(held.idempotency_key, undefined, 'nothing may be written to the row when the Gateway did not answer')
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('a legacy prepared row that cannot be identified, or that the job already dispatched, stays held', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(PAID_IMAGE_MODEL, true)])
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    const { project, episodeId, paths } = await createContinuityFixture('Legacy prepared held', [LANTERN_PROMPT, SECOND_PROMPT])
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const first = await sceneIdentity(LANTERN_PROMPT, 'missing')
    const second = await sceneIdentity(SECOND_PROMPT, 'missing')
    // scene-001: the row's recorded hash describes an older wording of the scene.
    await recordTaskStrict(outDir, 'scene-001.png', {
      ...legacyPreparedRow(first, path.join(outDir, 'scene-001.png')),
      input_hash: 'an-older-wording-of-this-scene',
    })
    // scene-002: the job's own checkpoint already names a provider job for it.
    await recordTaskStrict(outDir, 'scene-002.png', legacyPreparedRow(second, path.join(outDir, 'scene-002.png')))

    const job = continuityJob('legacy-prepared-held', project, episodeId, PAID_IMAGE_MODEL, ['scene-001', 'scene-002'])
    job.params.genstudio_recovery = {
      version: 1, route: 'genstudio',
      assets: {
        'scene-002.png': {
          operation: 'image', idempotency_key: 'story-image-dispatched-earlier',
          job_id: 'dispatched-earlier-job', state: 'accepted', updated_at: new Date().toISOString(),
        },
      },
    }
    await writeAuthoritativeFixture(job)

    await assert.rejects(runContinuityRenderJob(job), /incomplete/i)
    assert.equal(service.providerSubmissionCount('image'), 0, 'neither held scene may become a fresh request')
    const log = job.output_lines.join('\n')
    assert.match(log, /no longer matches the prepared image request/)
    assert.match(log, /the job's own record shows Gateway request dispatched-e… for it/)
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})

test('a completed identity beside a legacy row is recovered from its own task, and the legacy row still renders', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const { readManifest, recordTaskStrict } = await import('../services/task-manifest.js')
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([imageCatalogRow(PAID_IMAGE_MODEL, true)])
      return originalFetch(input, init)
    }
    client.clearGenStudioCatalogCache()
    await import('../providers/image/genstudio.js')

    // An accepted request that already succeeded at the Gateway: its artifact is
    // still there to reclaim.
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    let completedTaskId = ''
    await client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
      prompt: LANTERN_PROMPT, modelId: PAID_IMAGE_MODEL, aspectRatio: '16:9',
      requestIdentity: 'earlier-completed-scene-request', idempotencyKey: 'story-image-completed-earlier',
      onJobAccepted: jobId => { completedTaskId = jobId },
    })
    assert.ok(completedTaskId)
    const submissionsBeforeJob = service.providerSubmissionCount('image')

    const { project, episodeId, paths } = await createContinuityFixture('Legacy prepared beside completed', [LANTERN_PROMPT, SECOND_PROMPT])
    const outDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    await fs.mkdir(outDir, { recursive: true })
    const first = await sceneIdentity(LANTERN_PROMPT, 'missing')
    const second = await sceneIdentity(SECOND_PROMPT, 'missing')
    const completedRow = {
      ...legacyPreparedRow(first, path.join(outDir, 'scene-001.png')),
      task_id: completedTaskId, idempotency_key: 'story-image-completed-earlier', last_state: 'accepted',
    }
    await recordTaskStrict(outDir, 'scene-001.png', completedRow)
    await recordTaskStrict(outDir, 'scene-002.png', legacyPreparedRow(second, path.join(outDir, 'scene-002.png')))

    const job = continuityJob('legacy-prepared-beside-completed', project, episodeId, PAID_IMAGE_MODEL, ['scene-001', 'scene-002'])
    await writeAuthoritativeFixture(job)
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })

    assert.equal(await runContinuityRenderJob(job), undefined)
    assert.equal(
      service.providerSubmissionCount('image'), submissionsBeforeJob + 1,
      'only the legacy scene is submitted; the completed one is reclaimed, not re-rendered',
    )
    await sharp(path.join(outDir, 'scene-001.png')).stats()
    const manifest = await readManifest(outDir)
    assert.equal(manifest.tasks['scene-001.png']!.task_id, completedTaskId, 'the completed identity is preserved, never replaced')
    assert.equal(manifest.tasks['scene-001.png']!.idempotency_key, 'story-image-completed-earlier')
    assert.equal(manifest.tasks['scene-001.png']!.last_state, 'succeeded')
    assert.equal(manifest.tasks['scene-002.png']!.last_state, 'succeeded')
    assert.notEqual(manifest.tasks['scene-002.png']!.idempotency_key, undefined)
    assert.ok(
      job.output_lines.some((line: string) => /recovered task .*\(no charge\)/.test(line)),
      `the log must show the completed scene was reclaimed: ${job.output_lines.join('\n')}`,
    )
  } finally {
    globalThis.fetch = originalFetch
    const client = await import('../lib/genstudio-client.js')
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})
