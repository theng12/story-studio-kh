/**
 * Per-step idempotency for the batch-pipeline route.
 *
 * The user-facing goal: selecting all 7 core steps on a half-complete
 * episode should queue only the missing ones. These tests pin:
 *   - `isStepAlreadyDone(status, step)` truth table per step
 *   - `run-batch` skips done steps and reports them in `steps_skipped_as_done`
 *   - `force: true` bypasses the skip regardless of status
 *   - an episode with ALL selected steps done lands in the episode-level
 *     `skipped` array with reason "All selected steps already complete"
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import type { EpisodeStatus } from '../services/asset-status.js'

// IMPORTANT: isStepAlreadyDone is pulled in dynamically inside `before()`
// — if we static-imported `../routes/pipeline.js` at the top of this file,
// that import would cascade-load `../services/project-manager.js`, which
// evaluates `PROJECTS_ROOT = resolveProjectsRoot()` AT MODULE-LOAD TIME,
// BEFORE `useTempDataDir()` can set `STORY_STUDIO_DATA_DIR`. The result
// was 6 leaked "Pipeline Skip Test" projects in the user's real
// `~/Library/Application Support/Story Studio KH/projects/` folder on
// every test run. All test-dependent modules must be dynamic-imported
// from inside `before()` to guarantee env-first initialization.
let isStepAlreadyDone: typeof import('../routes/pipeline.js').isStepAlreadyDone

function fullStatus(overrides: Partial<EpisodeStatus> = {}): EpisodeStatus {
  return {
    research: false,
    scene_plan: false, contextual_cues: false, scene_review: false, motion_review: false,
    character_sheet: false,
    broll_picked: false,
    script: false, introduction: false,
    scene_prompts: false, thumb_prompts: false,
    metadata: false,
    images: false, thumbnails: false,
    audio: false, merged_audio: false,
    subtitles: false,
    video: false,
    video_assembly: false,
    ...overrides,
  }
}

describe('isStepAlreadyDone — truth table', () => {
  test('script-only tracks status.script', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ script: true }), 'script-only'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ script: false }), 'script-only'), false)
  })

  test('introduction-only tracks status.introduction', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ introduction: true }), 'introduction-only'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ introduction: false }), 'introduction-only'), false)
  })

  test('image_prompts tracks thumbnail prompts only', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'image_prompts'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: false }), 'image_prompts'), false)
  })

  test('image_prompts is thumbnail-only for every live visual source', () => {
    for (const visualSource of ['timestamp-driven', 'continuity-chain', 'narrated-scenes']) {
      const format = { visualSource } as any
      assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'image_prompts', format), true)
      assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: false }), 'image_prompts', format), false)
    }
  })

  test('thumb_images tracks thumbnails without legacy scene images', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ images: false, thumbnails: true }), 'thumb_images'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ images: true, thumbnails: false }), 'thumb_images'), false)
  })

  test('audio / audio_merge / metadata each track their status field', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ audio: true }), 'audio'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ merged_audio: true }), 'audio_merge'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ metadata: true }), 'metadata'), true)
  })

  test('video_assembly tracks status.video_assembly (final render file present)', () => {
    // After the 2026 pending-inclusion change, video_assembly behaves
    // like every other step: the status flag flips true when a
    // `{code}_final_video.*` file exists in the video_dir. The truth
    // table must honour that so the batch doesn't re-queue a completed
    // final render.
    const done = fullStatus({ video_assembly: true })
    assert.equal(isStepAlreadyDone(done, 'video_assembly'), true)
    assert.equal(isStepAlreadyDone(fullStatus(), 'video_assembly'), false)
  })

  // v1.0.363 — audio-paced format steps, now batchable.
  test('subtitles / scene plan / contextual cues / scene review / character sheet track their status field', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ subtitles: true }), 'subtitles'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ subtitles: false }), 'subtitles'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_plan: true }), 'scene_plan'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ contextual_cues: true }), 'contextual_cues'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ contextual_cues: false }), 'contextual_cues'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_review: true }), 'scene_review'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ character_sheet: true }), 'character_sheet'), true)
  })

})

// ── Integration: run-batch response shape ────────────────────────────────

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  // Late-bind the isStepAlreadyDone reference — pipeline.ts has already
  // been loaded by now (via app.ts transitively), which is fine because
  // useTempDataDir already rewrote STORY_STUDIO_DATA_DIR before this runs.
  const pipelineMod = await import('../routes/pipeline.js')
  isStepAlreadyDone = pipelineMod.isStepAlreadyDone
})

after(async () => { await cleanup() })

async function seedProjectWithAcceptedIdea(
  withFinalizerPrerequisites = true,
): Promise<{ slug: string; episodeId: string }> {
  const proj = await pm.createProject({ name: 'Pipeline Skip Test' })
  // Persist at least one metadata preset so findActivePreset resolves —
  // the batch route rejects with 400 otherwise. Use the `metadata` step
  // (simplest, single-typed key) for the integration checks below.
  await pm.updateConfig(proj.slug, {
    metadata_presets: [{ id: 'mp1', name: 'default', data: { model: 'gpt-4o' } }],
    metadata_last_preset: 'mp1',
  } as any)
  // Accept an idea so run-batch can resolve the episode_code → title.
  const im = await import('../services/idea-manager.js')
  const ideas = await im.addIdeas(proj.slug, [{
    title: 'Test episode', logline: '', themes: [], suggested_chapters: 5, suggested_length: '20 min', mood: 'calm',
  }], 'test-model')
  await im.acceptIdea(proj.slug, ideas[0].id)
  const accepted = await im.getIdeas(proj.slug, 'accepted')
  const ep = accepted[0]
  // YouTube Finalizer is now a late-stage operation. These skip-behaviour
  // tests exercise metadata itself, so give their synthetic episode the two
  // prerequisite completion signals that a real run gets from Script and
  // Audio Assembly.
  if (withFinalizerPrerequisites) {
    await im.setEpisodeStatusOverrides(proj.slug, ep.episode_code!, {
      script: true,
      merged_audio: true,
    })
  }
  return { slug: proj.slug, episodeId: ep.episode_code! }
}

function enableMockVideoCatalog(
  service: Awaited<ReturnType<typeof startMockGenStudioService>>,
): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== service.baseUrl || !['/v1/video/models', '/v1/videos/models'].includes(url.pathname)) return response
    const models = await response.json() as Array<Record<string, unknown>>
    return new Response(JSON.stringify(models.map(model => ({
      ...model,
      available: true,
      variants: [{
        operation: 'image-to-video',
        duration_seconds: 8, resolution: '1080p', credits_per_video: 90,
        minimum_credits: 90, price_version: 'mock-video-price-v1',
      }],
    }))), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  }
  return () => { globalThis.fetch = originalFetch }
}

describe('run-batch — step skip behaviour', () => {
  test('targeted YouTube Finalizer refuses missing Audio Assembly and queues nothing', async () => {
    const { slug, episodeId } = await seedProjectWithAcceptedIdea(false)
    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['metadata'] })

    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Nothing was started/)
    assert.ok(
      (res.body.issues || []).some((issue: any) =>
        issue.code === 'missing_prerequisite'
        && issue.step === 'metadata'
        && ['script-only', 'audio_merge'].includes(issue.message.match(/needs ([\w-]+)/)?.[1]),
      ),
      'preflight names the missing finalizer prerequisite',
    )
    const jq = await import('../services/job-queue.js')
    const jobs = await jq.getJobs(slug)
    assert.equal(
      jobs.filter(job => job.episode_id === episodeId && job.type === 'metadata').length,
      0,
      'no finalizer job is queued before its dependencies are complete',
    )
  })

  test('the queued finalizer rejects before provider work and legacy early routes are retired', async () => {
    const { slug, episodeId } = await seedProjectWithAcceptedIdea(false)
    const queued = await request(app)
      .post(`/api/projects/${slug}/generate/metadata`)
      .send({
        episode_id: episodeId,
        title: 'Test episode',
        model: 'test-model',
      })
    assert.equal(queued.status, 409)
    assert.equal(queued.body.code, 'YOUTUBE_FINALIZER_AUDIO_REQUIRED')

    const legacy = await request(app)
      .post(`/api/projects/${slug}/generate/metadata/description`)
      .send({ episode_id: episodeId })
    assert.equal(legacy.status, 410)
    assert.equal(legacy.body.code, 'LEGACY_METADATA_ROUTE_RETIRED')
  })

  test('returns steps_skipped_as_done entries when a step\'s output exists', async () => {
    const { slug, episodeId } = await seedProjectWithAcceptedIdea()
    // Materialise a metadata file so computeEpisodeStatus reports metadata
    // as done for this episode. The folder walk looks for "metadata" or
    // "description" in the subfolder name + .txt/.json/.md content.
    const outputRoot = await pm.getProjectOutputRoot(slug)
    if (!outputRoot) throw new Error('project output root missing')
    // Walk to find the episode folder (createProject + acceptIdea should have made one).
    const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => [])
    let episodeDir = ''
    for (const e of entries) {
      if (e.isDirectory() && e.name.includes(episodeId)) {
        episodeDir = path.join(outputRoot, e.name); break
      }
      if (e.isDirectory()) {
        const sub = await fs.readdir(path.join(outputRoot, e.name), { withFileTypes: true }).catch(() => [])
        for (const s of sub) {
          if (s.isDirectory() && s.name.includes(episodeId)) { episodeDir = path.join(outputRoot, e.name, s.name); break }
        }
      }
    }
    if (!episodeDir) throw new Error(`episode dir not found for ${episodeId}`)
    const metaDir = path.join(episodeDir, `${episodeId} - 02 Metadata`)
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(path.join(metaDir, 'description.txt'), 'stub')

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['metadata'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 0, 'no job queued because metadata already done')
    assert.equal(res.body.total_jobs_planned, 0)
    const skipped = res.body.skipped || []
    const doneSkips = res.body.steps_skipped_as_done || []
    assert.equal(doneSkips.length, 1, 'reports metadata as skipped-as-done')
    assert.equal(doneSkips[0].episode_id, episodeId)
    assert.equal(doneSkips[0].step, 'metadata')
    assert.ok(skipped.some((s: any) => s.reason.includes('All selected steps already complete')),
      'episode lands in episode-level skipped when every step is done')
  })

  test('force: true disables the skip even when status reports complete', async () => {
    const { slug, episodeId } = await seedProjectWithAcceptedIdea()
    // Materialise metadata so status.metadata would normally be true.
    const outputRoot = await pm.getProjectOutputRoot(slug)
    if (!outputRoot) throw new Error('project output root missing')
    const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => [])
    let episodeDir = ''
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.includes(episodeId)) { episodeDir = path.join(outputRoot, e.name); break }
      const sub = await fs.readdir(path.join(outputRoot, e.name), { withFileTypes: true }).catch(() => [])
      for (const s of sub) {
        if (s.isDirectory() && s.name.includes(episodeId)) { episodeDir = path.join(outputRoot, e.name, s.name); break }
      }
    }
    if (!episodeDir) throw new Error(`episode dir not found for ${episodeId}`)
    const metaDir = path.join(episodeDir, `${episodeId} - 02 Metadata`)
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(path.join(metaDir, 'description.txt'), 'stub')

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['metadata'], force: true })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 1, 'force re-runs even completed steps')
    assert.equal(res.body.total_jobs_planned, 1)
    assert.equal((res.body.steps_skipped_as_done || []).length, 0)
    assert.equal(res.body.force, true)
  })

  test('step with no existing output queues normally', async () => {
    const { slug, episodeId } = await seedProjectWithAcceptedIdea()
    // No metadata materialised — status.metadata is false, step should run.
    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['metadata'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 1)
    assert.equal(res.body.total_jobs_planned, 1)
    assert.equal((res.body.steps_skipped_as_done || []).length, 0)
  })
})

// ── v1.0.363 — script-only expansion + character-sheet inline apply ───────

/** Walk the project output root to find the on-disk episode folder. */
async function findEpisodeDir(slug: string, episodeId: string): Promise<string> {
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('project output root missing')
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.includes(episodeId)) return path.join(outputRoot, e.name)
    const sub = await fs.readdir(path.join(outputRoot, e.name), { withFileTypes: true }).catch(() => [])
    for (const s of sub) {
      if (s.isDirectory() && s.name.includes(episodeId)) return path.join(outputRoot, e.name, s.name)
    }
  }
  throw new Error(`episode dir not found for ${episodeId}`)
}

describe('run-batch — v1.0.363 audio-paced wiring', () => {
  test('Motion Review Pipeline requires a saved exact variant and forwards it to the durable batch job', async () => {
    const service = await startMockGenStudioService()
    let restoreVideoCatalog: (() => void) | undefined
    try {
      assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
      assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
      const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
      clearGenStudioCatalogCache()
      restoreVideoCatalog = enableMockVideoCatalog(service)

      const legacy = await seedProjectWithAcceptedIdea()
      await pm.updateConfig(legacy.slug, {
        motion_review_presets: [{ id: 'mr-old', name: 'Old Motion', data: { model: 'mock-video-v1', aspect_ratio: '16:9' } }],
        'motion_review_last_preset_motion-review': 'mr-old',
      } as any)
      const refused = await request(app)
        .post(`/api/projects/${legacy.slug}/pipeline/run-batch`)
        .send({ episode_ids: [legacy.episodeId], steps: ['motion_review'] })
      assert.equal(refused.status, 400)
      assert.match(refused.body.detail, /Open Motion Review.*save/i)
      const jq = await import('../services/job-queue.js')
      assert.equal((await jq.getJobs(legacy.slug)).length, 0)

      const current = await seedProjectWithAcceptedIdea()
      await pm.updateConfig(current.slug, {
        motion_review_presets: [{ id: 'mr-current', name: 'Current Motion', data: {
          model: 'mock-video-v1', aspect_ratio: '16:9', operation: 'image-to-video', duration_seconds: 8, resolution: '1080p',
        } }],
        'motion_review_last_preset_motion-review': 'mr-current',
      } as any)
      const queued = await request(app)
        .post(`/api/projects/${current.slug}/pipeline/run-batch`)
        .send({ episode_ids: [current.episodeId], steps: ['motion_review'] })
        .expect(201)
      const job = jq.getJob(queued.body.jobs[0].job_id)
      assert.equal(job?.type, 'scene_clips_batch')
      assert.equal(job?.params.operation, 'image-to-video')
      assert.equal(job?.params.duration_seconds, 8)
      assert.equal(job?.params.resolution, '1080p')
    } finally {
      restoreVideoCatalog?.()
      await service.close()
    }
  })

  test('subtitles rejects an unsupported preset language before enqueueing a job', async () => {
    const service = await startMockGenStudioService()
    try {
      assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
      assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)
      const proj = await pm.createProject({ name: 'Pipeline Transcription Contract Test' })
      await pm.updateConfig(proj.slug, {
        subtitles_generator_presets: [{
          id: 'stt1', name: 'Unsupported language', data: { model: 'mock-whisper-v1', language: 'km' },
        }],
        subtitles_generator_last_preset: 'stt1',
      } as any)
      const im = await import('../services/idea-manager.js')
      const ideas = await im.addIdeas(proj.slug, [{
        title: 'Transcription test', logline: '', themes: [], suggested_chapters: 1, suggested_length: '1 min', mood: 'calm',
      }], 'test-model')
      await im.acceptIdea(proj.slug, ideas[0].id)
      const episodeId = (await im.getIdeas(proj.slug, 'accepted'))[0].episode_code!

      const res = await request(app)
        .post(`/api/projects/${proj.slug}/pipeline/run-batch`)
        .send({ episode_ids: [episodeId], steps: ['subtitles'] })

      assert.equal(res.status, 400)
      assert.match(res.body.detail, /does not publish km/i)
      assert.match(res.body.detail, /Nothing was started/i)
      const jq = await import('../services/job-queue.js')
      assert.equal((await jq.getJobs(proj.slug)).length, 0, 'invalid language must not enter the queue')
      assert.equal(service.providerSubmissionCount('transcription'), 0, 'catalog validation must not submit paid work')
    } finally {
      await service.close()
    }
  })

  test('script-only expands into outline_only → expand_chapters (auto-approved)', async () => {
    const proj = await pm.createProject({ name: 'Pipeline Skip Test' })
    // A typed script preset so findActivePreset resolves the script step.
    await pm.updateConfig(proj.slug, {
      script_presets: [{ id: 'sp1', name: 'default', type: 'script', data: { form: { model: 'gpt-4o', chapters: 5 }, customStyleText: '' } }],
      script_last_preset_script: 'sp1',
    } as any)
    const im = await import('../services/idea-manager.js')
    const ideas = await im.addIdeas(proj.slug, [{
      title: 'Test episode', logline: '', themes: [], suggested_chapters: 5, suggested_length: '20 min', mood: 'calm',
    }], 'test-model')
    await im.acceptIdea(proj.slug, ideas[0].id)
    const episodeId = (await im.getIdeas(proj.slug, 'accepted'))[0].episode_code!

    const res = await request(app)
      .post(`/api/projects/${proj.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })

    assert.equal(res.status, 201)
    // ONE chain head enqueued, but the chain holds TWO jobs (outline + expand).
    assert.equal(res.body.enqueued, 1, 'one chain head')
    assert.equal(res.body.total_jobs_planned, 2, 'script-only expands into 2 jobs')
    assert.equal(res.body.jobs[0].type, 'outline_only', 'chain head is the outline build')

    // The head job's pipeline_chain must carry expand_chapters next, and both
    // must be auto-approved (unattended — no human at the outline review gate).
    const jq = await import('../services/job-queue.js')
    const headJob = jq.getJob(res.body.jobs[0].job_id)
    assert.ok(headJob, 'head job present in queue')
    assert.equal(headJob!.params.auto_approve, true, 'outline build is auto-approved')
    const chain = headJob!.params.pipeline_chain as any[]
    assert.equal(chain[0].type, 'expand_chapters', 'next link expands the chapters')
    assert.equal(chain[0].params.auto_approve, true, 'expansion is auto-approved')
  })

  test('script-only resumes an approved partial outline without rebuilding it', async () => {
    const proj = await pm.createProject({ name: 'Pipeline Partial Script Repair Test' })
    await pm.updateConfig(proj.slug, {
      script_presets: [{ id: 'sp1', name: 'default', type: 'script', data: { form: { model: 'gpt-4o', chapters: 5 }, customStyleText: '' } }],
      script_last_preset_script: 'sp1',
    } as any)
    const im = await import('../services/idea-manager.js')
    const ideas = await im.addIdeas(proj.slug, [{
      title: 'Partial episode', logline: '', themes: [], suggested_chapters: 5, suggested_length: '20 min', mood: 'calm',
    }], 'test-model')
    await im.acceptIdea(proj.slug, ideas[0].id)
    const episodeId = (await im.getIdeas(proj.slug, 'accepted'))[0].episode_code!
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const paths = await resolveEpisodePaths(proj.slug, episodeId, 'Partial episode')
    const { writeImportedOutline } = await import('../lib/chunked-narration.js')
    await writeImportedOutline(
      paths.script_dir,
      episodeId,
      Array.from({ length: 5 }, (_, i) => ({ title: `Chapter ${i + 1}` })),
    )
    await fs.writeFile(path.join(paths.script_dir, `${episodeId}_Script_Narration.md`), '# partial narration')
    for (let n = 1; n <= 4; n++) {
      await fs.writeFile(
        path.join(paths.script_dir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}.md`),
        `## Chapter ${n}: Chapter ${n}\n\nBody`,
      )
    }

    const res = await request(app)
      .post(`/api/projects/${proj.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 1)
    assert.equal(res.body.total_jobs_planned, 1, 'repair queues only expansion')
    assert.equal(res.body.jobs[0].type, 'expand_chapters')
    const jq = await import('../services/job-queue.js')
    const repairJob = jq.getJob(res.body.jobs[0].job_id)
    assert.match(repairJob?.title || '', /repair chapters/)
  })

  test('character_sheet applies the continuity_page preset inline (no job)', async () => {
    const proj = await pm.createProject({ name: 'Pipeline Skip Test' })
    await pm.updateConfig(proj.slug, {
      continuity_page_presets: [{
        id: 'cp1', name: 'anchor', type: 'continuity-page',
        data: { schema_version: 1, anchor_character_ids: ['c1'], style_bible: 'test bible' },
      }],
      'continuity_page_last_preset_continuity-page': 'cp1',
    } as any)
    const im = await import('../services/idea-manager.js')
    const ideas = await im.addIdeas(proj.slug, [{
      title: 'Test episode', logline: '', themes: [], suggested_chapters: 5, suggested_length: '20 min', mood: 'calm',
    }], 'test-model')
    await im.acceptIdea(proj.slug, ideas[0].id)
    const episodeId = (await im.getIdeas(proj.slug, 'accepted'))[0].episode_code!

    const res = await request(app)
      .post(`/api/projects/${proj.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['character_sheet'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.character_sheets_applied, 1, 'config applied for the episode')
    assert.equal(res.body.enqueued, 0, 'character_sheet is not a job')
    // Applied, NOT skipped — the inline write counts as work done.
    assert.equal((res.body.skipped || []).length, 0, 'not recorded as skipped')

    // continuity.json must exist with the preset's anchor data.
    const episodeDir = await findEpisodeDir(proj.slug, episodeId)
    const raw = await fs.readFile(path.join(episodeDir, 'continuity.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    assert.deepEqual(cfg.anchor_character_ids, ['c1'])
    assert.equal(cfg.style_bible, 'test bible')
    assert.equal(cfg.schema_version, 1)
  })
})

// Regression: every Pipeline step must enqueue under a JobType that has a real
// queue lane. The run-batch loop casts `step as JobType`, which silently
// compiles even when a step id ≠ its generator's JobType — that shipped a bug
// where Scene Review (id 'scene_review', job 'continuity_render'), Scene Plan,
// Subtitles and the timestamp assemble step all threw "Cannot read 'pending' of
// undefined" inside jq.enqueue and surfaced to the user as "always errors out".
describe('every pipeline step maps to a real job-queue lane', () => {
  let VALID_STEPS: typeof import('../routes/pipeline.js').VALID_STEPS
  let jobTypeForStep: typeof import('../routes/pipeline.js').jobTypeForStep
  let knownJobTypes: typeof import('../services/job-queue.js').knownJobTypes

  before(async () => {
    ;({ VALID_STEPS, jobTypeForStep } = await import('../routes/pipeline.js'))
    ;({ knownJobTypes } = await import('../services/job-queue.js'))
  })

  test('each step (except inline character_sheet) resolves to an enqueueable lane', () => {
    const lanes = new Set<string>(knownJobTypes())
    for (const step of VALID_STEPS) {
      // character_sheet is applied inline (continuity.json write), never enqueued.
      if (step === 'character_sheet') continue
      const jobType = jobTypeForStep(step)
      assert.ok(
        lanes.has(jobType),
        `step '${step}' → jobType '${jobType}' has no queue lane (jq.enqueue would throw)`,
      )
    }
  })

  test('the mismatched modern steps map to their generator job types', () => {
    assert.equal(jobTypeForStep('scene_review'), 'continuity_render')
    assert.equal(jobTypeForStep('scene_plan'), 'scene_plan_run')
    assert.equal(jobTypeForStep('subtitles'), 'subtitles_transcribe')
  })

  test('retired scene prompt/image/video steps are not accepted', () => {
    assert.ok(!VALID_STEPS.includes('scene_prompts' as any))
    assert.ok(!VALID_STEPS.includes('scene_images' as any))
    assert.ok(!VALID_STEPS.includes('video' as any))
  })
})

test('unified assembly requires reviewed scenes but not optional Motion Review', async () => {
  const { prerequisitesForStep } = await import('../routes/pipeline.js')
  assert.deepEqual(prerequisitesForStep('video_assembly'), ['scene_review', 'audio_merge'])
  assert.ok(!prerequisitesForStep('video_assembly').includes('motion_review'))
})

test('YouTube Finalizer requires measured audio timing but treats subtitles as warning-only', async () => {
  const { prerequisitesForStep } = await import('../routes/pipeline.js')
  assert.deepEqual(prerequisitesForStep('metadata'), ['script-only', 'audio_merge'])
  assert.ok(!prerequisitesForStep('metadata').includes('subtitles'))
})

test('enabled contextual cues place a review gate between Scene Plan and Scene Review', async () => {
  const { prerequisitesForStep } = await import('../routes/pipeline.js')
  assert.deepEqual(prerequisitesForStep('contextual_cues'), ['scene_plan'])
  assert.deepEqual(prerequisitesForStep('scene_review', true), ['scene_plan', 'contextual_cues'])
  assert.deepEqual(prerequisitesForStep('scene_review', false), ['scene_plan'])
})
