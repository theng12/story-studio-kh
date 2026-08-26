/**
 * v1.4.73 — asking for an opening names an episode and nothing else.
 *
 * The Introduction page has no model picker and no title field. That is a
 * deliberate absence, not a missing control: the opening is written with the
 * model already chosen for the chapters it introduces, and it belongs to an
 * episode the app can already name. A caller that had to supply either could
 * supply a DIFFERENT one, which is exactly how a batch run and a button ended
 * up producing different openings.
 *
 * The load-bearing test here is the last one. When no model can be resolved,
 * the request is refused with an explanation. It must never quietly pick one:
 * that silent fallback shipped four openings written by a model the owner
 * never chose (fixed in v1.4.68), and the refusal is the floor under this
 * redesign rather than a redundant precaution.
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

async function seedChannel(name: string, scriptModel: string | null): Promise<string> {
  const project = await pm.createProject({ name })
  if (scriptModel) {
    await pm.updateConfig(project.slug, {
      script_presets: [{ id: 'sp1', name: 'default', type: 'script', data: { form: { model: scriptModel } } }],
      script_last_preset_script: 'sp1',
    } as never)
  }
  return project.slug
}

/** The queued job for this episode, or undefined. */
async function queuedJob(slug: string, episodeId: string): Promise<any> {
  const jobs = await jq.getJobs(slug)
  return jobs.find((j: any) => j.type === 'introduction-only' && j.episode_id === episodeId)
}

describe('asking for a channel opening', () => {
  test('naming only the episode is enough, and the script’s model is used', async () => {
    const slug = await seedChannel('Opening By Episode', 'the-owners-chosen-model')
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
    const res = await request(app)
      .post(`/api/projects/${slug}/generate/introduction-only`)
      .send({ episode_id: 'EP0002', model: 'a-deliberate-override' })
    assert.equal(res.status, 201)
    const job = await queuedJob(slug, 'EP0002')
    assert.equal(job.params.model, 'a-deliberate-override')
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
})
