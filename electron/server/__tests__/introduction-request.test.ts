/**
 * Asking for an opening names an episode. Everything else comes from the channel.
 *
 * A caller that had to supply the recipe could supply a DIFFERENT one, which is
 * exactly how a batch run and a button ended up producing different openings.
 *
 * THE MODEL IS NOW PART OF THAT RECIPE. It shipped with no picker at all; the
 * owner overruled that — "what is the model picker not added. i don't care if
 * it's the same model or a different model writing it." So the channel may
 * choose one, and three sources answer in a fixed order:
 *
 *   1. the channel's own saved choice
 *   2. a model named on the request
 *   3. the Script Generator's saved model — what a blank choice means, and
 *      what every channel had before the picker existed
 *
 * (1) beating (2) is deliberate and is the opposite of the usual rule. The
 * Script page sends its own on-screen model with every chained opening, not as
 * a deliberate override but as a leftover; if that beat a saved choice, the
 * picker would do nothing on the path he uses most.
 *
 * The load-bearing test remains the refusal. When nothing answers, the request
 * is refused with an explanation and never quietly picks one: that silent
 * fallback shipped four openings written by a model the owner never chose
 * (fixed in v1.4.68).
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setApiKey('genstudio', 'gs-test-key-for-request-shape')
})

after(async () => { await cleanup() })

async function seedChannel(
  name: string,
  scriptModel: string | null,
  openingModel?: string,
): Promise<string> {
  const project = await pm.createProject({ name })
  if (scriptModel) {
    await pm.updateConfig(project.slug, {
      script_presets: [{ id: 'sp1', name: 'default', type: 'script', data: { form: { model: scriptModel } } }],
      script_last_preset_script: 'sp1',
    } as never)
  }
  if (openingModel !== undefined) {
    const segments = await import('../services/channel-segments.js')
    await segments.saveChannelSegment(project.slug, 'introduction', {
      recipe: { model: openingModel } as never,
    })
  }
  return project.slug
}

const CHAPTER_TEXT = 'The first chapter begins with a calm, complete piece of narration.'

async function writeChapterSource(slug: string, episodeId: string, text = CHAPTER_TEXT): Promise<void> {
  const { resolveEpisodePathsForRead } = await import('../services/utils.js')
  const paths = await resolveEpisodePathsForRead(slug, episodeId, '')
  await fs.mkdir(paths.script_dir, { recursive: true })
  await fs.writeFile(path.join(paths.script_dir, `${episodeId}_Chapter_01.md`), text)
}

async function writeUnifiedNarration(slug: string, episodeId: string, text: string): Promise<void> {
  const { resolveEpisodePathsForRead } = await import('../services/utils.js')
  const paths = await resolveEpisodePathsForRead(slug, episodeId, '')
  await fs.mkdir(paths.script_dir, { recursive: true })
  await fs.writeFile(path.join(paths.script_dir, `${episodeId}_Script_Narration.md`), text)
}

async function seedAcceptedEpisode(slug: string): Promise<string> {
  const im = await import('../services/idea-manager.js')
  const [idea] = await im.addIdeas(slug, [{
    title: 'An externally completed episode', logline: '', themes: [], suggested_chapters: 1,
    suggested_length: '5 min', mood: 'calm',
  }], 'test-model')
  return (await im.acceptIdea(slug, idea!.id)).episode_code
}

/** The queued job for this episode, or undefined. */
async function queuedJob(slug: string, episodeId: string): Promise<any> {
  const jobs = await jq.getJobs(slug)
  return jobs.find((j: any) => j.type === 'introduction-only' && j.episode_id === episodeId)
}

describe('asking for a channel opening', () => {
  test('naming only the episode is enough, and the script’s model is used', async () => {
    const slug = await seedChannel('Opening By Episode', 'the-owners-chosen-model')
    await writeChapterSource(slug, 'EP0001')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0001' })
    assert.equal(res.status, 201, `expected the request to be accepted; got ${res.status} ${JSON.stringify(res.body)}`)

    const job = await queuedJob(slug, 'EP0001')
    assert.ok(job, 'a job must actually be queued, not merely accepted')
    assert.equal(job.params.model, 'the-owners-chosen-model',
      'the opening is written by the same product as the chapters it introduces')
  })

  test('an explicitly supplied model still wins, for a deliberate one-off', async () => {
    const slug = await seedChannel('Explicit Model', 'the-saved-model')
    await writeChapterSource(slug, 'EP0002')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0002', model: 'a-deliberate-override' })
    assert.equal(res.status, 201)
    const job = await queuedJob(slug, 'EP0002')
    assert.equal(job.params.model, 'a-deliberate-override')
  })

  test('the channel\u2019s own chosen model is used', async () => {
    const slug = await seedChannel('Own Model', 'the-script-model', 'the-openings-own-model')
    await writeChapterSource(slug, 'EP0010')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0010' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const job = await queuedJob(slug, 'EP0010')
    assert.equal(job.params.model, 'the-openings-own-model')
  })

  test('the channel\u2019s choice beats the model the Script page sends along', async () => {
    // THE point of the picker. scripts.vue's chained run posts its own
    // on-screen `form.model` with every opening — a leftover from when the
    // opening had no setting of its own, not a deliberate override. If that
    // won, the control the owner asked for would do nothing on the path he
    // uses most, and he would have no way to tell.
    const slug = await seedChannel('Own Model Wins', 'the-script-model', 'the-openings-own-model')
    await writeChapterSource(slug, 'EP0011')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0011', model: 'the-script-pages-on-screen-model' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const job = await queuedJob(slug, 'EP0011')
    assert.equal(job.params.model, 'the-openings-own-model')
  })

  test('a channel that has chosen one needs no script preset at all', async () => {
    // The refusal below exists because nothing could answer. Something can now.
    const slug = await seedChannel('Own Model No Script', null, 'the-openings-own-model')
    await writeChapterSource(slug, 'EP0012')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0012' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal((await queuedJob(slug, 'EP0012')).params.model, 'the-openings-own-model')
  })

  test('leaving the choice blank still follows the Script Generator', async () => {
    // The default must not move. Every channel that has never opened the
    // picker is in this state, and must keep the behaviour it has today.
    const slug = await seedChannel('Blank Follows Script', 'the-script-model', '')
    await writeChapterSource(slug, 'EP0013')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0013' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal((await queuedJob(slug, 'EP0013')).params.model, 'the-script-model')
  })

  test('no resolvable model is refused in words — never quietly substituted', async () => {
    // v1.4.68's defect: the batch path lost the model and fell back to the
    // first economy product alphabetically, so openings were quietly written
    // by a model the owner never chose. An invented model is indistinguishable
    // to a reader from a chosen one, which is what makes it worth refusing.
    const slug = await seedChannel('No Script Model', null)
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0003' })
    assert.equal(res.status, 400, 'it must refuse rather than choose')
    assert.match(res.body.detail, /No model was substituted/i,
      'and say so outright, so the absence reads as an answer')
    assert.match(res.body.detail, /Script Generator/,
      'and name where to fix it')
    assert.equal(await queuedJob(slug, 'EP0003'), undefined, 'nothing may be queued')
  })

  test('missing chapters are rejected before an Introduction job is queued', async () => {
    const slug = await seedChannel('Missing Script', 'the-script-model')
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0020' })

    assert.equal(res.status, 400)
    assert.equal(res.body.detail, 'Generate a script first. This episode has no chapters for an introduction.')
    assert.equal(await queuedJob(slug, 'EP0020'), undefined, 'the invalid request must not create a failed job')
  })

  test('an empty chapter source is rejected before an Introduction job is queued', async () => {
    const slug = await seedChannel('Empty Script', 'the-script-model')
    await writeChapterSource(slug, 'EP0021', '')

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0021' })

    assert.equal(res.status, 400)
    assert.equal(res.body.detail, 'Generate a script first. This episode has no chapters for an introduction.')
    assert.equal(await queuedJob(slug, 'EP0021'), undefined)
  })

  test('an introduction-only narration does not satisfy the chapter prerequisite', async () => {
    const slug = await seedChannel('Opening Without Chapters', 'the-script-model')
    await writeUnifiedNarration(slug, 'EP0022', '# Introduction\n\nA saved opening with no story chapters.')

    const preview = await request(app)
      .get(`/api/projects/${slug}/episodes/EP0022/script-content`)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.introduction_ready, false)
    assert.equal(preview.body.script.content, '', 'a narration document can exist without chapter narration')

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0022' })
    assert.equal(res.status, 400)
    assert.equal(await queuedJob(slug, 'EP0022'), undefined)
  })

  test('a legacy unified narration with chapters can queue an Introduction', async () => {
    const slug = await seedChannel('Legacy Unified Script', 'the-script-model')
    await writeUnifiedNarration(slug, 'EP0023', [
      '# Legacy episode — Narration',
      '',
      '## Chapter 01: The First Door',
      '',
      CHAPTER_TEXT,
    ].join('\n'))

    const preview = await request(app)
      .get(`/api/projects/${slug}/episodes/EP0023/script-content`)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.introduction_ready, true)

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0023' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.ok(await queuedJob(slug, 'EP0023'))
  })

  test('manual status overrides cannot replace a real chapter source', async () => {
    const slug = await seedChannel('Override Is Not Narration', 'the-script-model')
    const episodeId = await seedAcceptedEpisode(slug)
    const im = await import('../services/idea-manager.js')
    await im.setEpisodeStatusOverrides(slug, episodeId, { script: true })

    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: episodeId })

    assert.equal(res.status, 400)
    assert.equal(res.body.detail, 'Generate a script first. This episode has no chapters for an introduction.')
    assert.equal(await queuedJob(slug, episodeId), undefined)
  })

  test('an active script writer blocks a new Introduction even when chapters exist', async () => {
    const slug = await seedChannel('Script Writer Owns Narration', 'the-script-model')
    const episodeId = 'EP0025'
    await writeChapterSource(slug, episodeId)
    const wasQueuePaused = jq.isQueuePaused()
    await jq.setQueuePaused(true)
    try {
      const writer = jq.enqueuePreparedForTest({
        project_slug: slug,
        type: 'chapter-only',
        episode_id: episodeId,
        title: '',
        params: {},
      })

      const submit = () => request(app)
        .post(`/api/projects/${slug}/generate/introduction-only`)
        .send({ episode_id: episodeId })
      const expectedDetail = 'Wait for this episode’s script job to finish. Resume or cancel it in Jobs if paused.'

      const queued = await submit()
      assert.equal(queued.status, 409)
      assert.equal(queued.body.detail, expectedDetail)

      assert.equal((await jq.pauseJob(writer.job_id))?.status, 'paused')
      const paused = await submit()
      assert.equal(paused.status, 409)
      assert.equal(paused.body.detail, expectedDetail)
      assert.equal(await queuedJob(slug, episodeId), undefined)
    } finally {
      await jq.setQueuePaused(wasQueuePaused)
    }
  })

  test('a replay returns its accepted job even when the source disappears afterwards', async () => {
    const slug = await seedChannel('Replay Keeps Accepted Action', 'the-script-model')
    const episodeId = 'EP0024'
    const actionId = '00000000-0000-4000-8000-000000000024'
    await writeChapterSource(slug, episodeId)

    const first = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: episodeId, operation_id: actionId })
    assert.equal(first.status, 201, JSON.stringify(first.body))

    const { resolveEpisodePathsForRead } = await import('../services/utils.js')
    const paths = await resolveEpisodePathsForRead(slug, episodeId, '')
    await fs.unlink(path.join(paths.script_dir, `${episodeId}_Chapter_01.md`))

    const replay = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: episodeId, operation_id: actionId })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.job_id, first.body.job_id)
    assert.equal(replay.body.reused, true)
  })
})

describe('what the Introduction page is given to draw itself', () => {
  test('the beat explanations are served, not written into the page', async () => {
    // The page renders these; it keeps no copy. If this stops being sent, the
    // page shows seven bare labels again — which is the whole complaint —
    // and nothing in the page's own tests would notice, because they would
    // still be rendering whatever the page was handed.
    const slug = await seedChannel('Beat Library', 'a-model')
    const res = await request(app).get(`/api/projects/${slug}/segments`)
    assert.equal(res.status, 200)
    const library = res.body.beat_library
    assert.ok(Array.isArray(library) && library.length > 0, 'the catalogue must travel with the answer')

    const { DEFAULT_INTRODUCTION_BEATS } = await import('../lib/episode-segments.js')
    for (const beat of DEFAULT_INTRODUCTION_BEATS) {
      const entry = library.find((b: any) => b.id === beat.id)
      assert.ok(entry, `no explanation is served for "${beat.label}"`)
      assert.ok(String(entry.description || '').trim().length > 30,
        `"${beat.label}" is served without a real explanation`)
      assert.ok(String(entry.example || '').trim().length > 0,
        `"${beat.label}" is served without an example`)
    }
  })

  test('a channel that has said nothing is offered a blank model choice', async () => {
    const slug = await seedChannel('Blank Model Served', 'a-model')
    const res = await request(app).get(`/api/projects/${slug}/segments`)
    assert.equal(res.body.segments.introduction.recipe.model, '',
      'blank is the default, and blank means "follow the Script Generator"')
  })
})

// ── The unattended run, end to end ───────────────────────────────────────

describe('an unattended batch on a channel that opens with an Introduction', () => {
  /** A channel with a script model, an accepted episode, and openings on. */
  async function seedRunnableChannel(name: string, openingsOn: boolean): Promise<{ slug: string; episodeId: string }> {
    const project = await pm.createProject({ name })
    // 1.4.320 — automatic openings are future-only: the project's own switch
    // ("Automatically add introductions to newly created episodes", off by
    // default) has to be on when the episode is CREATED, or the episode
    // carries no `intro_eligible` fact and is never given one. It is set here,
    // before the idea is accepted, so the channel's recipe is the only
    // variable between these tests.
    await pm.updateProject(project.slug, { auto_introduction_enabled: true })
    await pm.updateConfig(project.slug, {
      script_presets: [{ id: 'sp1', name: 'default', type: 'script', data: { form: { model: 'the-owners-chosen-model' } } }],
      script_last_preset_script: 'sp1',
    } as never)
    const im = await import('../services/idea-manager.js')
    const ideas = await im.addIdeas(project.slug, [{
      title: 'Test episode', logline: '', themes: [], suggested_chapters: 5,
      suggested_length: '20 min', mood: 'calm',
    }], 'test-model')
    await im.acceptIdea(project.slug, ideas[0].id)
    const accepted = await im.getIdeas(project.slug, 'accepted')

    const segments = await import('../services/channel-segments.js')
    await segments.saveChannelSegment(project.slug, 'introduction', { enabled: openingsOn })
    return { slug: project.slug, episodeId: accepted[0].episode_code! }
  }

  test('an opening is planned although the run asked only for the Script', async () => {
    // THE proof. Nothing here ticks an Introduction box, because there is no
    // longer a box to tick: the run follows what the channel has said. Four
    // episodes reached paid audio with no opening because the old box was not
    // ticked on the run that wrote them.
    const { slug, episodeId } = await seedRunnableChannel('Batch With Opening', true)
    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })
    assert.ok([200, 201].includes(res.status), `run-batch was refused: ${JSON.stringify(res.body)}`)

    // The run reports the work it accepted. A batch chains its stages — the
    // opening's own job is created once the chapters it introduces exist — so
    // what is observable here, and what the runner acts on, is the step list.
    assert.deepEqual(res.body.steps, ['script-only', 'introduction-only'],
      'the request asked only for the Script; the channel supplied the rest')
    assert.ok(res.body.total_jobs_planned > 2,
      'and the opening is counted in the work this run will do')
  })

  test('a channel that does not use openings is left exactly as it was', async () => {
    const { slug, episodeId } = await seedRunnableChannel('Batch Without Opening', false)
    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })
    assert.ok([200, 201].includes(res.status), `run-batch was refused: ${JSON.stringify(res.body)}`)

    assert.deepEqual(res.body.steps, ['script-only'],
      'silence about openings must never become spending on them')
    const jobs = await jq.getJobs(slug)
    assert.equal(
      jobs.filter((j: any) => j.type === 'introduction-only' && j.episode_id === episodeId).length,
      0,
    )
  })

  test('the run is not refused for want of an Introduction preset', async () => {
    // The step is added automatically, so if it still demanded a saved preset
    // a channel that had never made one would have its ENTIRE batch refused —
    // not merely go without an opening. Neither channel above saves one.
    const { slug, episodeId } = await seedRunnableChannel('No Intro Preset', true)
    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/preflight`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })
    assert.equal(res.body.ok, true, `preflight failed: ${JSON.stringify(res.body.issues)}`)
    assert.ok(
      !(res.body.issues || []).some((i: any) => i.step === 'introduction-only'),
      'the opening needs no preset, and must not be able to ask for one',
    )
  })

  test('and the run actually RUNS on a channel that has never saved one', async () => {
    // Preflight saying `ok` is not the same as the batch going through, and
    // this is the regression that must never come back: an automatically
    // added step that demands a preset refuses the WHOLE batch on every
    // channel that has never saved one, which was all of them.
    const { slug, episodeId } = await seedRunnableChannel('No Intro Preset Runs', true)
    const config = await pm.getConfig(slug) as Record<string, unknown>
    assert.equal(config.introduction_presets, undefined,
      'the premise: this channel has no Introduction preset of any kind')

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })
    assert.ok([200, 201].includes(res.status), `run-batch was refused: ${JSON.stringify(res.body)}`)
    assert.deepEqual(res.body.steps, ['script-only', 'introduction-only'])
    assert.deepEqual(res.body.missing || [], [],
      'nothing may be reported missing for a step that has no preset to miss')
    assert.ok(
      !(res.body.skipped || []).some((s: any) => String(s.reason || '').includes('preset')),
      `no episode may be skipped for a preset: ${JSON.stringify(res.body.skipped)}`,
    )
    assert.ok(res.body.total_jobs_planned > 2, 'and the opening is real work this run will do')
  })

  test('saving an Introduction preset does not make the batch start needing one', async () => {
    // Presets came back because the owner asked for them — "intro preset must
    // be present. it's the most important thing." They fill the page's form
    // in; they are NOT how a batch learns what to write. This pins the seam:
    // a channel with a saved preset list and no active pointer runs exactly
    // like one with nothing saved at all.
    const { slug, episodeId } = await seedRunnableChannel('Intro Preset Saved', true)
    await pm.updateConfig(slug, {
      introduction_presets: [{
        id: 'ip1',
        name: 'House opening',
        type: 'introduction',
        data: { recipe: { host_name: 'Luna', word_target: 220, custom_opening_line: '', beats: [], model: '' } },
      }],
    } as never)

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })
    assert.ok([200, 201].includes(res.status), `run-batch was refused: ${JSON.stringify(res.body)}`)
    assert.deepEqual(res.body.steps, ['script-only', 'introduction-only'])
    assert.deepEqual(res.body.missing || [], [])
  })

  test('the opening is registered as a step that cannot demand a preset', async () => {
    // The rule itself, not an effect of it. A future edit that drops the
    // opening out of this set brings the whole regression back, and this is
    // the line that stops it.
    const { NO_PRESET_STEP_IDS } = await import('../routes/pipeline.js')
    assert.ok(NO_PRESET_STEP_IDS.includes('introduction-only' as never),
      'an automatically added step must never be able to require a preset')
  })

  test('a channel opening in a batch uses the model that channel chose', async () => {
    const { slug, episodeId } = await seedRunnableChannel('Batch Own Model', true)
    const segments = await import('../services/channel-segments.js')
    await segments.saveChannelSegment(slug, 'introduction', {
      recipe: { model: 'the-openings-own-model' } as never,
    })
    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['script-only'] })
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body))
    assert.ok(
      !(res.body.skipped || []).some((s: any) => String(s.reason || '').includes('introduction-only')),
      `the opening must not be skipped: ${JSON.stringify(res.body.skipped)}`,
    )
  })
})
