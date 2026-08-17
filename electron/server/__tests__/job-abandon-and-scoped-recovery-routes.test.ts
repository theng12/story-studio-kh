/**
 * v1.2.8 — the two HTTP surfaces the escape hatch and the targeted recovery
 * depend on.
 *
 * `POST …/jobs/:id/abandon` exists because every other exit refused. It must
 * therefore never refuse on the same grounds, and the assertion below is
 * deliberately made against a job whose ordinary Cancel and Delete both 409.
 *
 * `GET …/assets-audit?episode=` exists because Repair is a search tool and the
 * user often already knows the answer. Scoping must return that episode and
 * only that episode — the whole point is not scanning the rest.
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
let im: typeof import('../services/idea-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
})

after(async () => { await cleanup() })

describe('force-abandon route', () => {
  test('abandons a job that Cancel and Delete both refuse, and says what it did not do', async () => {
    const project = await pm.createProject({ name: 'Abandon route' })
    const wedged = {
      job_id: 'wedged-route-job',
      project_slug: project.slug,
      type: 'scene_plan_run',
      episode_id: 'EP0055',
      title: 'Scene Plan',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
      // The shape that produced the dead end: an accepted provider task Story
      // Studio cannot prove terminal, plus a stored reconciliation error.
      genstudio_jobs: [{
        id: 'chat-accepted', operation: 'chat.response', state: 'accepted',
        updated_at: new Date().toISOString(),
      }],
      reconciliation_error: 'GenStudio status check is waiting (HTTP 404: GenStudio KH request failed: not found)',
    }
    await fs.writeFile(
      path.join(tempDir, 'projects', project.slug, 'jobs.json'),
      JSON.stringify({ jobs: [wedged] }),
    )

    // Establish the dead end before proving the way out of it.
    const cancel = await request(app).post(`/api/projects/${project.slug}/jobs/wedged-route-job/cancel`).send({})
    assert.equal(cancel.status, 409)
    const remove = await request(app).delete(`/api/projects/${project.slug}/jobs/wedged-route-job`)
    assert.equal(remove.status, 409)

    const abandon = await request(app).post(`/api/projects/${project.slug}/jobs/wedged-route-job/abandon`).send({})
    assert.equal(abandon.status, 200)
    assert.equal(abandon.body.job.status, 'cancelled')
    assert.ok(abandon.body.job.force_abandoned)
    assert.deepEqual(abandon.body.job.force_abandoned.unsettled, ['chat.response chat-accepted'])
    // Provider evidence survives untouched — abandoning is a statement about
    // Story Studio, never about GenStudio.
    assert.equal(abandon.body.job.genstudio_jobs.length, 1)
    assert.equal(abandon.body.job.genstudio_jobs[0].state, 'accepted')

    // And the row is now removable, which it was not sixty milliseconds ago.
    const removeAgain = await request(app).delete(`/api/projects/${project.slug}/jobs/wedged-route-job`)
    assert.equal(removeAgain.status, 200)
  })

  test('a job that does not exist is still a 404, not a silent success', async () => {
    const project = await pm.createProject({ name: 'Abandon route missing' })
    const res = await request(app).post(`/api/projects/${project.slug}/jobs/ghost/abandon`).send({})
    assert.equal(res.status, 404)
  })
})

describe('scoped asset audit', () => {
  test('?episode= returns only that episode; omitting it still returns the whole project', async () => {
    const project = await pm.createProject({ name: 'Scoped audit' })
    const added = await im.addIdeas(project.slug, ['First story', 'Second story', 'Third story'].map(title => ({
      title, logline: `${title} logline`, themes: ['test'],
      suggested_chapters: 2, suggested_length: 'short', mood: 'calm',
    })), 'test-model')
    const codes: string[] = []
    for (const idea of added) {
      const accepted = await im.acceptIdea(project.slug, idea.id)
      if (accepted.idea.episode_code) codes.push(accepted.idea.episode_code)
    }
    assert.equal(codes.length, 3, 'fixture needs three accepted episodes with codes')

    const all = await request(app).get(`/api/projects/${project.slug}/assets-audit`)
    assert.equal(all.status, 200)
    assert.equal(all.body.episodes.length, 3)

    const one = await request(app).get(`/api/projects/${project.slug}/assets-audit?episode=${codes[1]}`)
    assert.equal(one.status, 200)
    assert.deepEqual(one.body.episodes.map((row: any) => row.episode_id), [codes[1]])

    // An unknown code is an empty result, never a fallback to the whole library.
    const none = await request(app).get(`/api/projects/${project.slug}/assets-audit?episode=EP9999`)
    assert.equal(none.status, 200)
    assert.deepEqual(none.body.episodes, [])
  })
})
