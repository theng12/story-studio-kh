/**
 * The merged page's API: ONE readiness answer, and a save that cannot certify a
 * stale time (v1.4.365).
 *
 * The defect this file is built around: the old Sound Design GET validated with
 * `requireResolved` while its PUT answered `validation: []`. A page could
 * therefore say "ready" for a cue the renderer would refuse, and no test of
 * either half on its own could see it — the two answers disagreed with each
 * other, not with their own rules.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let slug = ''
let episode = ''
let planPath = ''
let app: any
let request: any

const plan = {
  generated_at: '2026-10-01T00:00:00.000Z',
  total_duration_sec: 40,
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 20, transcript_segment: 'The temple stood here.', visual_prompt: 'A temple.' },
    { id: 'scene-2', scene_index: 2, start_sec: 20, end_sec: 40, transcript_segment: 'Its bells rang at dawn.', visual_prompt: 'Bells.' },
  ],
}

function label(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 4.15, end_sec: 7.65,
    title: 'The temple', kind: 'location_date', placement: 'top-right',
    template: 'documentary-label', entrance: 'fade', exit: 'dissolve', status: 'approved',
    created_at: 'now', updated_at: 'now', ...overrides,
  }
}

function sound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sound-1', kind: 'spot', label: 'bells', start_sec: 12.5,
    source: 'pool', pool_id: 'sfx', clip: 'bells.wav', gain_db: -12, status: 'approved',
    created_at: 'now', updated_at: 'now', ...overrides,
  }
}

const get = (url: string) => request(app).get(`/api/projects/${slug}/sound-and-labels${url}`)
const put = (url: string, body: unknown) => request(app).put(`/api/projects/${slug}/sound-and-labels${url}`).send(body as any)

before(async () => {
  isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Sound & Labels fixture', episode_prefix: 'EP', episode_digits: 4 })
  slug = project.slug
  await pm.updateConfig(slug, {
    contextual_cues: { enabled: true },
    sound_design: { enabled: true },
  } as any)
  const [idea] = await ideas.addIdeas(slug, [{ title: 'Sound', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  episode = (await ideas.acceptIdea(slug, idea!.id, false)).episode_code!
  const paths = await utils.resolveEpisodePathsByCodeWithSidecar(slug, episode, 'scene_plan.json')
  planPath = await utils.resolveScenePlanPath(slug, episode, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify(plan))
  ;({ app } = await import('../app.js'))
  ;({ default: request } = await import('supertest'))
})

after(async () => {
  await isolated.cleanup()
})

describe('transition settings storage', () => {
  test('channel settings are inherited and explicit episode values survive channel changes', async () => {
    const initial = await get(`/${episode}/transitions`)
    assert.equal(initial.body.settings.enabled, false)
    assert.equal((await put('/transitions/config', { settings: { enabled: true, set_id: 'whooshes' } })).status, 200)
    const inherited = await get(`/${episode}/transitions`)
    assert.equal(inherited.body.settings.enabled, true)
    assert.equal(inherited.body.settings.set_id, 'whooshes')
    assert.equal((await put(`/${episode}/transitions`, { enabled: false, set_id: 'paper-pencil' })).status, 200)
    await put('/transitions/config', { settings: { enabled: false, set_id: 'mixed' } })
    const saved = await get(`/${episode}/transitions`)
    assert.equal(saved.body.settings.enabled, false)
    assert.equal(saved.body.settings.set_id, 'paper-pencil')
  })
})

describe('one read answers for both halves', () => {
  test('the switches, the timelines, the scenes and one readiness block come back together', async () => {
    const res = await get(`/${episode}`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.config, { on_screen_text: true, sound: true })
    assert.equal(res.body.scenes.length, 2)
    assert.ok(res.body.readiness?.labels && res.body.readiness?.sound)
  })

  test('an unreviewed label is counted as NOT rendered, in the same answer that says so', async () => {
    // The old split: a page could say "ready" from a PUT that returned
    // `validation: []` while the renderer refused. One read cannot disagree
    // with itself.
    await put(`/${episode}/labels`, { cues: [label({ status: 'proposed' })] })
    const res = await get(`/${episode}`)
    assert.equal(res.body.readiness.labels.will_render, 0)
    assert.ok(res.body.readiness.labels.skipped.some((skip: any) => /awaiting review/.test(skip.detail)))
    // ...and the renderer agrees, from the same rule.
    const cues = await import('../services/contextual-cues.js')
    const resolved = cues.resolveRenderableContextualCues(
      { enabled: true }, await cues.readContextualCueTimeline(planPath), plan as any,
    )
    assert.equal(resolved.cues.length, res.body.readiness.labels.will_render)
  })

  test('a save that would draw a label outside its scene is refused, with the cue named', async () => {
    const res = await put(`/${episode}/labels`, { cues: [label({ start_sec: 18, end_sec: 24 })] })
    assert.equal(res.status, 422, JSON.stringify(res.body))
    assert.ok(res.body.issues.some((issue: any) => /inside its scene/.test(issue.detail)))
  })

  test('a save the reviewer makes is never refused over an editorial gap', async () => {
    // An unreviewed row, a long hold, a label low in the frame: all belong to
    // the reviewer. The 422 exists for defects, not for pending decisions.
    const res = await put(`/${episode}/labels`, { cues: [label({ status: 'proposed', placement: 'bottom-right', end_sec: 18 })] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
  })
})

describe('a save cannot certify a stale time', () => {
  test('saving after a Scene Plan re-run stamps the CURRENT plan', async () => {
    const out = await put(`/${episode}/sounds`, { cues: [sound()] })
    assert.equal(out.status, 200, JSON.stringify(out.body))
    const sounds = await import('../services/sound-design.js')
    const read = (await sounds.readSoundDesignTimeline(planPath))!
    assert.equal(read.source_scene_plan_generated_at, plan.generated_at)
    assert.equal(read.schema_version, 2, 'a save from now on writes v2')
  })

  test('an EXCLUDED row with stale times saves instead of 422', async () => {
    // The 422 that made an excluded cue impossible to edit or delete: every
    // rule applied to a cue the customer had already turned off.
    const res = await put(`/${episode}/sounds`, { cues: [sound(), sound({ id: 'sound-old', status: 'excluded', start_sec: 999, gain_db: 0 })] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
  })

  test('an old plan is a WARNING for unanchored rows, not a refused save', async () => {
    const res = await put(`/${episode}/labels`, { cues: [label()] })
    assert.equal(res.status, 200)
    // Rewrite the plan date so the stored timeline is now "based on an older plan".
    await fs.writeFile(planPath, JSON.stringify({ ...plan, generated_at: '2026-10-20T00:00:00.000Z' }))
    const again = await put(`/${episode}/sounds`, { cues: [sound()] })
    assert.equal(again.status, 200, 'an older plan must never make the timeline unsaveable')
  })
})

describe('fixed-path routes are not read as an episode code', () => {
  test('the config route answers on both GET and PUT', async () => {
    // This was a real bug found by running the page: `/sound-and-labels/config`
    // was declared BELOW `/sound-and-labels/:episodeId`, so Express bound "config"
    // as the episode code and answered "Invalid episode code: config". Typecheck,
    // lint and every unit test passed. The service is live.
    const read = await get('/config')
    assert.equal(read.status, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body, { on_screen_text: true, sound: true })
    const wrote = await put('/config', { on_screen_text: true })
    assert.equal(wrote.status, 200, JSON.stringify(wrote.body))
  })

  test('flipping one switch leaves the other exactly as it was', async () => {
    // Sending both back from a stale page is how one switch silently cleared
    // the other. Each writes only the key the caller names.
    const off = await put('/config', { on_screen_text: false })
    assert.equal(off.body.on_screen_text, false)
    assert.equal(off.body.sound, true, 'the unnamed switch is untouched')
    await put('/config', { on_screen_text: true })
  })

  test('a read reports a refusal instead of hiding the rows behind it', async () => {
    // A cue that escapes its scene cannot be drawn. The PAGE still gets it, plus
    // the renderer's own sentence — a 400 would hide the row that needs fixing.
    await put(`/${episode}/labels`, { cues: [label({ status: 'approved' })] })
    await fs.writeFile(planPath, JSON.stringify({
      ...plan,
      scenes: [
        { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: '', visual_prompt: '' },
        { id: 'scene-2', scene_index: 2, start_sec: 4, end_sec: 40, transcript_segment: '', visual_prompt: '' },
      ],
    }))
    const read = await get(`/${episode}`)
    assert.equal(read.status, 200, JSON.stringify(read.body))
    assert.equal(read.body.labels.cues.length, 1, 'the row is still there to fix')
    assert.match(String(read.body.readiness.labels.refuses), /inside its scene timing/)
    await fs.writeFile(planPath, JSON.stringify(plan))
  })

  test('a plan with no scene_index still names its scenes', async () => {
    // "Scene undefined" on every row came from trusting the field.
    await fs.writeFile(planPath, JSON.stringify({
      ...plan,
      scenes: plan.scenes.map(({ scene_index: _dropped, ...scene }) => scene),
    }))
    const read = await get(`/${episode}`)
    assert.deepEqual(read.body.scenes.map((scene: any) => scene.scene_index), [1, 2])
    await fs.writeFile(planPath, JSON.stringify(plan))
  })
})

describe('the retired page routes', () => {
  test('both answer 410 with the new address', async () => {
    const labels = await request(app).get(`/api/projects/${slug}/contextual-cues/${episode}`)
    assert.equal(labels.status, 410)
    assert.equal(labels.body.moved_to, '/sound-and-labels')
    const sounds = await request(app).get(`/api/projects/${slug}/sound-design/${episode}`)
    assert.equal(sounds.status, 410)
    assert.equal(sounds.body.moved_to, '/sound-and-labels')
  })

  test('the proposal route keeps its job type, so queued jobs still read', async () => {
    const res = await request(app).post(`/api/projects/${slug}/contextual-cues/${episode}/propose`)
      .send({ model: 'mock-chat-v1', density: 'restrained', placement: 'top-right', auto_approve: false, operation_id: '3f0a6f9c-0b1d-4d2e-9c3a-6e1b2a5c7d84' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.equal(res.body.type, 'contextual_cues', 'the job type is unchanged on purpose')
    // The job is left where it was put: no executor runs in this fixture, so
    // nothing paid may leave the machine. What matters is that the row a queued
    // job is read back from still says `contextual_cues` — a renamed job type
    // would orphan every job in the owner's history.
    const jq = await import('../services/job-queue.js')
    await jq._waitForJobPersistenceForTesting?.()
    const queued = (await jq.findJobs(slug, job => job.job_id === res.body.job_id))[0]
    assert.equal(queued?.type, 'contextual_cues')
    assert.equal(queued?.title, `Propose labels and sounds — ${episode}`)
  })
})
