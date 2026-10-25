/**
 * The model a thumbnail step runs with — resolved BEFORE a job exists.
 *
 * Production, 2026-10-25: four Thumbnail Prompts jobs (b5746909, 58144b5f,
 * 6fa0d7c4, b6e2c75a) were ADMITTED with no model and failed instantly inside
 * their generator. Manu's channel had `thumbnail_prompts_presets: []` and
 * `thumbnail_prompts_last_preset: null`; the job then read an empty model and
 * died. The operator got a failed job, never the one sentence that would have
 * helped: choose a model.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   - A Thumbnail Prompts preset with no model is NOT a usable preset: the
 *     Pipeline leaves the step out and says so, in plain words, naming the page
 *     to open. Nothing is enqueued, so nothing fails a minute later.
 *   - A saved preset's model IS used: the enqueue routes resolve it from
 *     `thumbnail_prompts_presets` / `thumbnail_generator_presets` (AGENTS §7)
 *     before admission, and the job carries it.
 *   - When neither the request nor the preset names a model, the request is
 *     refused with a plain message and NO JOB ROW is created.
 *   - Story Studio never substitutes a model (AGENTS §1).
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup?.() })

/** A project with one accepted episode. */
async function episodeProject(name: string): Promise<{ slug: string, episodeId: string }> {
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const ideas = await import('../services/idea-manager.js')
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'The Hidden System',
    logline: 'Fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  const episodeId = (await ideas.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP001' })).episode_code
  return { slug: project.slug, episodeId }
}

/** Replace the channel's stored thumbnail presets with exactly `presets`. */
async function setThumbnailPresets(
  slug: string,
  which: 'thumbnail_prompts' | 'thumbnail_generator',
  presets: Array<Record<string, unknown>>,
): Promise<void> {
  const file = path.join(pm.projectsRoot(), slug, 'config.json')
  const config = JSON.parse(await fs.readFile(file, 'utf-8'))
  config[`${which}_presets`] = presets
  config[`${which}_last_preset`] = presets.length ? (presets[presets.length - 1] as any).id : null
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf-8')
}

const imagePromptJobs = async (slug: string, episodeId: string) =>
  (await jq.getJobs(slug)).filter(job => job.type === 'image_prompts' && job.episode_id === episodeId)
const thumbnailImageJobs = async (slug: string, episodeId: string) =>
  (await jq.getJobs(slug)).filter(job => job.type === 'thumb_images' && job.episode_id === episodeId)

/**
 * Stop an admitted job as soon as its row has been asserted.
 *
 * These tests are about what was ADMITTED, not what runs: leaving the job live
 * would let it start after this file's sandbox is gone, which produces teardown
 * noise that looks like a failure and has nothing to do with the rule.
 */
async function cancelAdmitted(slug: string, jobId: string): Promise<void> {
  await request(app).post(`/api/projects/${slug}/jobs/${jobId}/cancel`).send({})
}

// ── The preset/model reader ─────────────────────────────────────────────────

describe('the preset readers agree on where a thumbnail model lives', () => {
  test('a typed preset, a flat preset and the legacy prompt_model are all read', async () => {
    const { thumbnailPromptsModelFromPreset, thumbnailGeneratorModelFromPreset } = await import('../services/thumbnail-presets.js')
    assert.equal(thumbnailPromptsModelFromPreset({ data: { form: { model: 'writer-typed' } } }), 'writer-typed')
    assert.equal(thumbnailPromptsModelFromPreset({ model: 'writer-flat' }), 'writer-flat')
    assert.equal(thumbnailPromptsModelFromPreset({ data: { prompt_model: 'writer-legacy' } }), 'writer-legacy')
    assert.equal(thumbnailPromptsModelFromPreset({ data: { form: {} } }), '', 'no model is no model')
    assert.equal(thumbnailGeneratorModelFromPreset({ data: { form: { model: 'image-typed' } } }), 'image-typed')
    assert.equal(thumbnailGeneratorModelFromPreset({}), '')
  })

  test('the STEP keys are the §7 keys', async () => {
    const { THUMBNAIL_PRESET_KEYS } = await import('../services/thumbnail-presets.js')
    const { PRESET_KEYS } = await import('../routes/pipeline.js')
    for (const step of ['image_prompts', 'thumb_images'] as const) {
      assert.equal(THUMBNAIL_PRESET_KEYS[step].list, PRESET_KEYS[step].list, `${step} preset list key`)
      assert.deepEqual(THUMBNAIL_PRESET_KEYS[step].activeKeys, PRESET_KEYS[step].activeKeys, `${step} active key`)
    }
  })

  test('the active preset is the pointed-at one, then last-used, then the newest', async () => {
    const { activeThumbnailPreset } = await import('../services/thumbnail-presets.js')
    const config = {
      thumbnail_prompts_presets: [
        { id: 'a', data: { form: { model: 'model-a' } } },
        { id: 'b', data: { form: { model: 'model-b' } } },
      ],
      thumbnail_prompts_last_preset: 'a',
    }
    assert.equal((activeThumbnailPreset(config, 'image_prompts') as any)?.id, 'a')
    assert.equal((activeThumbnailPreset({ ...config, thumbnail_prompts_last_preset: 'gone' }, 'image_prompts') as any)?.id, 'b',
      'a pointer to a deleted preset falls through to the newest')
    assert.equal(activeThumbnailPreset({ thumbnail_prompts_presets: [] }, 'image_prompts'), null)
    assert.equal(activeThumbnailPreset(null, 'image_prompts'), null)
  })

  test('a model-less preset is reported as model-less for BOTH thumbnail steps', async () => {
    const { presetHasNoWritingModel } = await import('../routes/pipeline.js')
    assert.equal(presetHasNoWritingModel('image_prompts', { id: 'p', data: { form: { thumb_count: 3 } } } as any), true)
    assert.equal(presetHasNoWritingModel('thumb_images', { id: 'p', data: { form: { aspect_ratio: '16:9' } } } as any), true)
    assert.equal(presetHasNoWritingModel('image_prompts', { id: 'p', data: { form: { model: 'w' } } } as any), false)
    assert.equal(presetHasNoWritingModel('thumb_images', { id: 'p', data: { form: { model: 'i' } } } as any), false)
  })
})

// ── Pipeline preflight ─────────────────────────────────────────────────────

describe('Pipeline preflight refuses a thumbnail step with no model, before admission', () => {
  test('the Thumbnail Prompts step is left out with a plain message, and no job exists', async () => {
    const { slug, episodeId } = await episodeProject('Preflight No Model')
    await setThumbnailPresets(slug, 'thumbnail_prompts', [{
      id: 'preset-no-model', name: 'Count only', data: { form: { thumb_count: 3 } },
    }])

    const preflight = await request(app)
      .post(`/api/projects/${slug}/pipeline/preflight`)
      .send({ episode_ids: [episodeId], steps: ['image_prompts'] })
    assert.ok([200, 422].includes(preflight.status), JSON.stringify(preflight.body))
    const leftOut = (preflight.body.steps_left_out || []).find((row: any) => row.step === 'image_prompts')
    assert.ok(leftOut, 'the step is left out of the run')
    assert.match(leftOut.reason, /writing model/i, 'the reason names what is missing')
    assert.match(leftOut.reason, /Thumbnail Prompts page/, 'the reason says where to choose one')
    assert.deepEqual(await imagePromptJobs(slug, episodeId), [], 'no job row was created')
  })

  test('a preset that NAMES a model is not left out', async () => {
    const { slug, episodeId } = await episodeProject('Preflight With Model')
    await setThumbnailPresets(slug, 'thumbnail_prompts', [{
      id: 'preset-with-model', name: 'Ready', data: { form: { thumb_count: 3, model: 'writer-in-preset' } },
    }])

    const preflight = await request(app)
      .post(`/api/projects/${slug}/pipeline/preflight`)
      .send({ episode_ids: [episodeId], steps: ['image_prompts'] })
    assert.ok([200, 422].includes(preflight.status), JSON.stringify(preflight.body))
    const leftOut = (preflight.body.steps_left_out || []).find((row: any) => row.step === 'image_prompts')
    assert.equal(leftOut, undefined, 'a preset with a model is usable')
  })

  test('the Thumbnail Generator step is left out when its preset names no image model', async () => {
    const { slug, episodeId } = await episodeProject('Preflight Render No Model')
    await setThumbnailPresets(slug, 'thumbnail_generator', [{
      id: 'preset-no-model', name: 'Look only', data: { form: { aspect_ratio: '16:9' } },
    }])

    const preflight = await request(app)
      .post(`/api/projects/${slug}/pipeline/preflight`)
      .send({ episode_ids: [episodeId], steps: ['thumb_images'] })
    assert.ok([200, 422].includes(preflight.status), JSON.stringify(preflight.body))
    const leftOut = (preflight.body.steps_left_out || []).find((row: any) => row.step === 'thumb_images')
    assert.ok(leftOut, 'the step is left out of the run')
    assert.match(leftOut.reason, /image model/i, 'it asks for an IMAGE model, not a writing model')
    assert.deepEqual(await thumbnailImageJobs(slug, episodeId), [], 'no job row was created')
  })
})

// ── The enqueue routes ─────────────────────────────────────────────────────

describe('the Thumbnail Prompts queue path resolves the saved preset, or refuses', () => {
  test('no preset and no model → refused in plain words, with NO job row', async () => {
    const { slug, episodeId } = await episodeProject('Queue No Model')
    await setThumbnailPresets(slug, 'thumbnail_prompts', [])

    const response = await request(app)
      .post(`/api/projects/${slug}/generate/image-prompts`)
      .send({ episode_id: episodeId, mode: 'thumbnails', model: '' })
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.match(response.body.detail, /writing model/i)
    assert.match(response.body.detail, /Thumbnail Prompts page/)
    assert.deepEqual(await imagePromptJobs(slug, episodeId), [], 'nothing was admitted')
  })

  test('an empty request model uses the saved preset\'s model', async () => {
    const { slug, episodeId } = await episodeProject('Queue Uses Preset')
    await setThumbnailPresets(slug, 'thumbnail_prompts', [{
      id: 'preset-with-model', name: 'Ready', data: { form: { thumb_count: 3, model: 'writer-in-preset' } },
    }])

    const response = await request(app)
      .post(`/api/projects/${slug}/generate/image-prompts`)
      .send({ episode_id: episodeId, mode: 'thumbnails', model: '' })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    const jobs = await imagePromptJobs(slug, episodeId)
    assert.equal(jobs.length, 1, 'exactly one job was admitted')
    assert.equal((jobs[0].params as any).model, 'writer-in-preset', 'the job carries the preset\'s model')
    await cancelAdmitted(slug, jobs[0].job_id)
  })

  test('an explicit request model wins over the preset', async () => {
    const { slug, episodeId } = await episodeProject('Queue Explicit Model')
    await setThumbnailPresets(slug, 'thumbnail_prompts', [{
      id: 'preset-with-model', name: 'Ready', data: { form: { model: 'writer-in-preset' } },
    }])

    const response = await request(app)
      .post(`/api/projects/${slug}/generate/image-prompts`)
      .send({ episode_id: episodeId, mode: 'thumbnails', model: 'writer-chosen-now' })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    const jobs = await imagePromptJobs(slug, episodeId)
    assert.equal((jobs[0].params as any).model, 'writer-chosen-now')
    await cancelAdmitted(slug, jobs[0].job_id)
  })
})

describe('the Thumbnail Generator queue path resolves the saved preset, or refuses', () => {
  test('no generator preset and no model → refused in plain words, with NO job row', async () => {
    const { slug, episodeId } = await episodeProject('Render Queue No Model')
    await setThumbnailPresets(slug, 'thumbnail_generator', [])

    const response = await request(app)
      .post(`/api/projects/${slug}/generate/images`)
      .send({ episode_id: episodeId, mode: 'thumbs', model: '' })
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.match(response.body.detail, /image model/i)
    assert.match(response.body.detail, /Thumbnail Generator page/)
    assert.deepEqual(await thumbnailImageJobs(slug, episodeId), [], 'nothing was admitted')
  })

  test('an empty request model uses the saved generator preset\'s model', async () => {
    const { slug, episodeId } = await episodeProject('Render Queue Uses Preset')
    await setThumbnailPresets(slug, 'thumbnail_generator', [{
      id: 'preset-with-model', name: 'Ready', data: { form: { model: 'image-in-preset', aspect_ratio: '16:9' } },
    }])

    const response = await request(app)
      .post(`/api/projects/${slug}/generate/images`)
      .send({ episode_id: episodeId, mode: 'thumbs', model: '' })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    const jobs = await thumbnailImageJobs(slug, episodeId)
    assert.equal(jobs.length, 1, 'exactly one job was admitted')
    assert.equal((jobs[0].params as any).model, 'image-in-preset', 'the job carries the preset\'s image model')
    await cancelAdmitted(slug, jobs[0].job_id)
  })
})
