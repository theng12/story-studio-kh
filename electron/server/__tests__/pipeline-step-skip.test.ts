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
    scene_plan: false, scene_review: false, motion_review: false,
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

  test('thumbnail and scene prompt steps are independent', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'image_prompts'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: false }), 'image_prompts'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: false }), 'scene_prompts'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'scene_prompts'), false)
  })

  test('image_prompts is thumbnail-only for every format', () => {
    const timestampFormat = { visualSource: 'timestamp-driven' } as any
    const sentenceScenesFormat = { visualSource: 'scene-images', sceneAlignment: 'sentence' } as any
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'image_prompts', timestampFormat), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: false, thumb_prompts: true }), 'image_prompts', sentenceScenesFormat), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_prompts: true, thumb_prompts: false }), 'image_prompts', timestampFormat), false)
  })

  test('scene_images and thumb_images are independent', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ images: true, thumbnails: false }), 'scene_images'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ images: false, thumbnails: true }), 'scene_images'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ images: false, thumbnails: true }), 'thumb_images'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ images: true, thumbnails: false }), 'thumb_images'), false)
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

  // v1.0.363 — audio-paced format steps, now batchable.
  test('subtitles / scene_plan / scene_review / character_sheet track their status field', () => {
    assert.equal(isStepAlreadyDone(fullStatus({ subtitles: true }), 'subtitles'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ subtitles: false }), 'subtitles'), false)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_plan: true }), 'scene_plan'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ scene_review: true }), 'scene_review'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ character_sheet: true }), 'character_sheet'), true)
  })

  test('timestamp_assemble shares the final-video flag with video_assembly', () => {
    // The timestamp/continuity final render lands as the same final-video
    // file every format's reconciler keys video_assembly off of — so a
    // completed timestamp render must read as done and not re-queue.
    assert.equal(isStepAlreadyDone(fullStatus({ video_assembly: true }), 'timestamp_assemble'), true)
    assert.equal(isStepAlreadyDone(fullStatus({ video_assembly: false }), 'timestamp_assemble'), false)
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

  test('the mismatched steps map to their generator job types', () => {
    assert.equal(jobTypeForStep('scene_review'), 'continuity_render')
    assert.equal(jobTypeForStep('scene_plan'), 'scene_plan_run')
    assert.equal(jobTypeForStep('subtitles'), 'subtitles_transcribe')
    assert.equal(jobTypeForStep('timestamp_assemble'), 'timestamp_video_assemble')
    assert.equal(jobTypeForStep('scene_prompts'), 'image_prompts')
  })
})

test('timestamp assembly does not require optional Motion Review', async () => {
  const { prerequisitesForStep } = await import('../routes/pipeline.js')
  assert.deepEqual(prerequisitesForStep('timestamp_assemble'), ['scene_review', 'audio_merge'])
  assert.ok(!prerequisitesForStep('timestamp_assemble').includes('motion_review'))
})
