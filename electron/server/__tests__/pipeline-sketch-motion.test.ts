/**
 * Pipeline Motion Review with Sketch Draw presets.
 *
 * Verifies:
 * 1. Pipeline preflight admits a sketch_draw preset with an empty video catalogue.
 * 2. The paid preset path still refuses a missing variant.
 * 3. The executor enqueues renderer sketch_draw with the right scene ids and skips (Still, missing image, fresh).
 * 4. Partial completion case: step is not marked done, queues only missing scenes.
 * 5. Complete completion case: step is marked done (steps_skipped_as_done), no job enqueued.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { NATIVE_SCENE_CLIP_VERSION } from '../lib/native-scene-clip-version.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'

let app: any
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let im: typeof import('../services/idea-manager.js')
let pipelineMod: typeof import('../routes/pipeline.js')
let sceneMedia: typeof import('../services/scene-media-checkpoint.js')
let utils: typeof import('../services/utils.js')
let sceneImage: typeof import('../generators/scene-image.js')
let sceneClipGen: typeof import('../generators/scene-clip.js')
let cleanup: () => Promise<void>
let wasQueuePaused = false

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  await fs.mkdir(path.join(t.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  im = await import('../services/idea-manager.js')
  pipelineMod = await import('../routes/pipeline.js')
  sceneMedia = await import('../services/scene-media-checkpoint.js')
  utils = await import('../services/utils.js')
  sceneImage = await import('../generators/scene-image.js')
  sceneClipGen = await import('../generators/scene-clip.js')

  wasQueuePaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
})

after(async () => {
  await jq.setQueuePaused(true)
  for (const project of await pm.listProjects()) {
    for (const job of await jq.getJobs(project.slug)) {
      if (!['done', 'error', 'cancelled'].includes(job.status)) {
        await jq.requestJobCancellation(project.slug, job.job_id)
      }
      jq.removeTerminalJob(project.slug, job.job_id)
    }
  }
  await jq.drainJobPersistenceForShutdown(2_000)
  if (!wasQueuePaused) await jq.setQueuePaused(false)
  await jq.drainJobPersistenceForShutdown(2_000)
  await cleanup()
})

async function seedProjectAndEpisode(name: string): Promise<{ slug: string; episodeId: string; episodeDir: string }> {
  const proj = await pm.createProject({ name })
  const ideas = await im.addIdeas(proj.slug, [{
    title: `${name} episode`, logline: '', themes: [], suggested_chapters: 3, suggested_length: '10 min', mood: 'calm',
  }], 'test-model')
  await im.acceptIdea(proj.slug, ideas[0].id)
  const accepted = await im.getIdeas(proj.slug, 'accepted')
  const episodeId = accepted[0].episode_code!

  await im.setEpisodeStatusOverrides(proj.slug, episodeId, {
    script: true,
    merged_audio: true,
  })

  const paths = await utils.resolveEpisodePathsByCode(proj.slug, episodeId)
  return { slug: proj.slug, episodeId, episodeDir: paths.episode_dir }
}

async function seedStitchedSubtitles(slug: string, episodeId: string) {
  const paths = await utils.resolveEpisodePathsByCode(slug, episodeId)
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const srtPath = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
  const metaPath = `${srtPath}.json`
  await fs.writeFile(srtPath, '1\n00:00:00,000 --> 00:00:08,000\nHello\n\n')
  await fs.writeFile(metaPath, JSON.stringify({ complete: true, sections: [] }))
}

async function makeFreshScene(slug: string, episodeId: string, id: string, index: number, windowSeconds = 4) {
  const settings = await sceneMedia.resolveSketchDrawSettings(slug, episodeId)
  const fps = settings.fps
  const frames = windowSeconds * fps
  const holdFrames = sceneMedia.sketchHoldFramesFor(settings, episodeId, id, frames)
  return {
    id,
    scene_index: index,
    start_sec: (index - 1) * windowSeconds,
    end_sec: index * windowSeconds,
    transcript_segment: `Segment ${id}`,
    visual_prompt: `Prompt for ${id}`,
    motion_prompt: `Motion for ${id}`,
    approved: true,
    motion_choice: 'clip' as const,
    clip_source_image_version: 'v1',
    clip_renderer: 'sketch_draw' as const,
    image_sha256: sha(PNG),
    clip_source_image_sha256: sha(PNG),
    clip_scene_window_seconds: windowSeconds,
    clip_sketch: {
      helper_version: NATIVE_SCENE_CLIP_VERSION,
      fps,
      frames,
      width: settings.width,
      height: settings.height,
      pen_fingerprint: settings.penFingerprint,
      hold_frames: holdFrames,
      hold_fingerprint: settings.holdFingerprint,
    },
  }
}

describe('Pipeline Motion Review with Sketch Draw', () => {
  test('presetHasNoWritingModel does not refuse sketch_draw motion_review preset', () => {
    assert.equal(
      pipelineMod.presetHasNoWritingModel('motion_review', {
        id: 'mr-sketch',
        name: 'Sketch Preset',
        data: { renderer: 'sketch_draw' },
      }),
      false,
    )
  })

  test('Pipeline preflight admits a sketch_draw preset with an empty video catalogue', async () => {
    const { slug, episodeId, episodeDir } = await seedProjectAndEpisode('Preflight Sketch Test')

    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify({ pacing: { mode: 'uniform', min_sec: 3, max_sec: 6 }, motion_scope: { mode: 'all' } }),
    )
    const planPath = await utils.resolveScenePlanPath(slug, episodeId, episodeDir)
    await fs.writeFile(
      planPath,
      JSON.stringify({ scenes: [{ id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, approved: true }] }),
    )

    await pm.updateConfig(slug, {
      motion_review_presets: [{
        id: 'mr-sketch',
        name: 'Sketch Draw',
        data: {
          renderer: 'sketch_draw',
          duration_mode: 'manual',
          auto_approve_clip: true,
          reveal: { style: 'line', mix: [] },
        },
      }],
      'motion_review_last_preset_motion-review': 'mr-sketch',
    } as any)

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/preflight`)
      .send({ episode_ids: [episodeId], steps: ['motion_review'] })

    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    const motionIssues = (res.body.issues || []).filter((i: any) => i.step === 'motion_review')
    assert.equal(motionIssues.length, 0, 'no motion_review issues in preflight')
    assert.deepEqual(res.body.eligible_episode_ids, [episodeId])
  })

  test('the paid preset path still refuses a missing variant', async () => {
    const { slug, episodeId, episodeDir } = await seedProjectAndEpisode('Paid Missing Variant')

    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify({ pacing: { mode: 'uniform', min_sec: 3, max_sec: 6 }, motion_scope: { mode: 'all' } }),
    )
    const planPath = await utils.resolveScenePlanPath(slug, episodeId, episodeDir)
    await fs.writeFile(
      planPath,
      JSON.stringify({ scenes: [{ id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, approved: true }] }),
    )

    await pm.updateConfig(slug, {
      motion_review_presets: [{
        id: 'mr-paid-bad',
        name: 'Paid Missing Variant',
        data: {
          model: 'mock-video-v1',
          aspect_ratio: '16:9',
          // missing operation, duration_seconds, resolution
        },
      }],
      'motion_review_last_preset_motion-review': 'mr-paid-bad',
    } as any)

    const preflight = await request(app)
      .post(`/api/projects/${slug}/pipeline/preflight`)
      .send({ episode_ids: [episodeId], steps: ['motion_review'] })

    assert.equal(preflight.status, 422)
    const issue = (preflight.body.issues || []).find((i: any) => i.step === 'motion_review')
    assert.ok(issue, 'preflight reports issue for missing variant')
    assert.equal(issue.code, 'invalid_preset')
    assert.match(issue.message, /published clip variant/i)

    const run = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['motion_review'] })

    assert.equal(run.status, 400)
    assert.match(run.body.detail, /Open Motion Review.*save/i)
  })

  test('executor enqueues renderer sketch_draw with the right scene ids and skips (Still, missing image, fresh)', async () => {
    const { slug, episodeId, episodeDir } = await seedProjectAndEpisode('Executor Sketch Test')

    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify({ pacing: { mode: 'uniform', min_sec: 3, max_sec: 6 }, motion_scope: { mode: 'all' } }),
    )

    const imagesDir = await sceneImage.resolveSceneImagesDir(slug, episodeId.toUpperCase(), episodeDir)
    await fs.mkdir(imagesDir, { recursive: true })
    const clipsDir = await sceneClipGen.resolveVideoAssetsDir(slug, episodeId.toUpperCase(), episodeDir)
    await fs.mkdir(clipsDir, { recursive: true })

    // scene-1: ready (approved image present, no clip yet)
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), PNG)
    const s1 = {
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4,
      transcript_segment: 'A', visual_prompt: 'P1', approved: true,
      image_path: path.join(imagesDir, 'scene-1.png'),
    }

    // scene-2: marked Still (approved image present)
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), PNG)
    const s2 = {
      id: 'scene-2', scene_index: 2, start_sec: 4, end_sec: 8,
      transcript_segment: 'B', visual_prompt: 'P2', approved: true,
      motion_choice: 'still' as const,
      image_path: path.join(imagesDir, 'scene-2.png'),
    }

    // scene-3: missing image
    const s3 = {
      id: 'scene-3', scene_index: 3, start_sec: 8, end_sec: 12,
      transcript_segment: 'C', visual_prompt: 'P3', approved: true,
      image_path: null,
    }

    // scene-4: already fresh clip
    await fs.writeFile(path.join(imagesDir, 'scene-4.png'), PNG)
    await fs.writeFile(path.join(clipsDir, 'scene-4.mp4'), Buffer.from('fake mp4 content'))
    const s4 = await makeFreshScene(slug, episodeId, 'scene-4', 4, 4)
    s4.start_sec = 12
    s4.end_sec = 16
    ;(s4 as any).image_path = path.join(imagesDir, 'scene-4.png')

    const planPath = await utils.resolveScenePlanPath(slug, episodeId, episodeDir)
    await fs.writeFile(planPath, JSON.stringify({ scenes: [s1, s2, s3, s4] }))

    await pm.updateConfig(slug, {
      motion_review_presets: [{
        id: 'mr-sketch',
        name: 'Sketch Draw',
        data: {
          renderer: 'sketch_draw',
          duration_mode: 'manual',
          auto_approve_clip: true,
        },
      }],
      'motion_review_last_preset_motion-review': 'mr-sketch',
    } as any)

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['motion_review'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 1)

    const job = jq.getJob(res.body.jobs[0].job_id)
    assert.ok(job, 'job was enqueued')
    assert.equal(job.type, 'scene_clips_batch')
    assert.equal(job.params.renderer, 'sketch_draw')
    assert.equal(job.params.model, undefined, 'no video model should be set for sketch_draw')
    assert.equal(job.params.visual_source, 'scene_plan')
    assert.equal(job.params.auto_approve_clip, true)
    // Only scene-1 should be queued; scene-2 (still), scene-3 (missing image), scene-4 (fresh) are skipped!
    assert.deepEqual(job.params.motion_scene_ids, ['scene-1'])
  })

  test('partial completion case: step is not marked done and queues only missing scene', async () => {
    const { slug, episodeId, episodeDir } = await seedProjectAndEpisode('Partial Completion Test')

    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify({ pacing: { mode: 'uniform', min_sec: 3, max_sec: 6 }, motion_scope: { mode: 'all' } }),
    )

    const imagesDir = await sceneImage.resolveSceneImagesDir(slug, episodeId.toUpperCase(), episodeDir)
    await fs.mkdir(imagesDir, { recursive: true })
    const clipsDir = await sceneClipGen.resolveVideoAssetsDir(slug, episodeId.toUpperCase(), episodeDir)
    await fs.mkdir(clipsDir, { recursive: true })

    // scene-1 has a fresh clip
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), PNG)
    await fs.writeFile(path.join(clipsDir, 'scene-1.mp4'), Buffer.from('fake mp4'))
    const s1 = await makeFreshScene(slug, episodeId, 'scene-1', 1, 4)
    ;(s1 as any).image_path = path.join(imagesDir, 'scene-1.png')

    // scene-2 has approved image but NO clip
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), PNG)
    const s2 = {
      id: 'scene-2', scene_index: 2, start_sec: 4, end_sec: 8,
      transcript_segment: 'B', visual_prompt: 'P2', approved: true,
      image_path: path.join(imagesDir, 'scene-2.png'),
    }

    const planPath = await utils.resolveScenePlanPath(slug, episodeId, episodeDir)
    await fs.writeFile(planPath, JSON.stringify({ scenes: [s1, s2] }))

    await pm.updateConfig(slug, {
      motion_review_presets: [{
        id: 'mr-sketch',
        name: 'Sketch Draw',
        data: { renderer: 'sketch_draw', duration_mode: 'manual', auto_approve_clip: true },
      }],
      'motion_review_last_preset_motion-review': 'mr-sketch',
    } as any)

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['motion_review'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 1)
    assert.equal((res.body.steps_skipped_as_done || []).length, 0, 'partial is not skipped as done')

    const job = jq.getJob(res.body.jobs[0].job_id)
    assert.equal(job?.type, 'scene_clips_batch')
    assert.equal(job?.params.renderer, 'sketch_draw')
    assert.deepEqual(job?.params.motion_scene_ids, ['scene-2'], 'only the missing scene is queued')
  })

  // seed subtitles so status.scene_plan can compute complete on disk
  test('complete completion case: step is marked done (steps_skipped_as_done), no job enqueued', async () => {
    const { slug, episodeId, episodeDir } = await seedProjectAndEpisode('Complete Completion Test')
    await seedStitchedSubtitles(slug, episodeId)

    await fs.writeFile(
      path.join(episodeDir, 'continuity.json'),
      JSON.stringify({ pacing: { mode: 'uniform', min_sec: 3, max_sec: 6 }, motion_scope: { mode: 'all' } }),
    )

    const imagesDir = await sceneImage.resolveSceneImagesDir(slug, episodeId.toUpperCase(), episodeDir)
    await fs.mkdir(imagesDir, { recursive: true })
    const clipsDir = await sceneClipGen.resolveVideoAssetsDir(slug, episodeId.toUpperCase(), episodeDir)
    await fs.mkdir(clipsDir, { recursive: true })

    // scene-1 has fresh clip
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), PNG)
    await fs.writeFile(path.join(clipsDir, 'scene-1.mp4'), Buffer.from('fake mp4 1'))
    const s1 = await makeFreshScene(slug, episodeId, 'scene-1', 1, 4)
    ;(s1 as any).image_path = path.join(imagesDir, 'scene-1.png')

    // scene-2 has fresh clip
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), PNG)
    await fs.writeFile(path.join(clipsDir, 'scene-2.mp4'), Buffer.from('fake mp4 2'))
    const s2 = await makeFreshScene(slug, episodeId, 'scene-2', 2, 4)
    s2.start_sec = 4
    s2.end_sec = 8
    ;(s2 as any).image_path = path.join(imagesDir, 'scene-2.png')

    const planPath = await utils.resolveScenePlanPath(slug, episodeId, episodeDir)
    await fs.writeFile(planPath, JSON.stringify({ scenes: [s1, s2] }))

    await pm.updateConfig(slug, {
      motion_review_presets: [{
        id: 'mr-sketch',
        name: 'Sketch Draw',
        data: { renderer: 'sketch_draw', duration_mode: 'manual', auto_approve_clip: true },
      }],
      'motion_review_last_preset_motion-review': 'mr-sketch',
    } as any)

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['motion_review'] })

    assert.equal(res.status, 201)
    assert.equal(res.body.enqueued, 0, 'no job queued when all scenes complete')
    const doneSkips = res.body.steps_skipped_as_done || []
    assert.equal(doneSkips.length, 1)
    assert.equal(doneSkips[0].step, 'motion_review')
    assert.equal(doneSkips[0].episode_id, episodeId)
    assert.ok(
      (res.body.skipped || []).some((s: any) => s.reason.includes('All selected steps already complete')),
      'episode reported in skipped array',
    )
  })
})
