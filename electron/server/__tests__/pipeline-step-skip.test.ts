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
    scene_plan: false, scene_review: false,
    script: false, introduction: false,
    scene_prompts: false, thumb_prompts: false,
    metadata: false,
    images: false, thumbnails: false,
    audio: false, merged_audio: false,
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

  test('image_prompts requires BOTH scene + thumb prompts', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: true }), 'image_prompts'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: false }), 'image_prompts'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'image_prompts'), false)
  })

  test('images requires BOTH scene images + thumbnails', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ images: true, thumbnails: true }), 'images'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ images: true, thumbnails: false }), 'images'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ images: false, thumbnails: true }), 'images'), false)
  })

  test('audio / audio_merge / metadata / video each track their status field', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ audio: true }), 'audio'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ merged_audio: true }), 'audio_merge'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ metadata: true }), 'metadata'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ video: true }), 'video'), true)
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

async function seedProjectWithAcceptedIdea(): Promise<{ slug: string; episodeId: string }> {
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
  return { slug: proj.slug, episodeId: ep.episode_code! }
}

describe('run-batch — step skip behaviour', () => {
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
