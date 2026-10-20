/**
 * GET /projects/:slug/episodes/:code/recovery-plan: a read-only view of the saved episode recovery plan,
 * so a person can see which row each node is bound to before choosing a Retry. It must never create,
 * repair or save a plan (POST recover-episode and `recoverEpisode` can).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

void test('recovery-plan GET reports each node, its row status and the dispatch state, and changes nothing on disk', async () => {
  const temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Recovery plan read' })
    const file = path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json')
    const url = `/api/projects/${project.slug}/episodes/EP0007/recovery-plan`

    const none = await request(app).get(url)
    assert.equal(none.status, 404)
    assert.match(none.body.detail, /No recovery plan is saved for EP0007/)
    await assert.rejects(fs.access(file), 'a read never creates the plans file')
    assert.equal((await request(app).get('/api/projects/no-such-project/episodes/EP0007/recovery-plan')).status, 404)

    const node = (job_id: string, extra = {}) => ({ job_id, type: 'scene_plan_run', title: 'Scene Plan', params: { model: 'saved' }, ...extra })
    const plan = (id: string, steps: Record<string, unknown>, episode_id = 'EP0007') => ({ version: 1, id, project_slug: project.slug, episode_id,
      target: 'scene_plan_run', steps, completed: ['audio_merge'], first_unresolved: 'scene_plan_run', message: 'Waiting for Scene Plan.',
      retry_source_job_ids: ['104bf236'] })
    const retired = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`old-${i}`, { ...plan(`old-${i}`, {}), target: 'audio_merge' }]))
    const store = JSON.stringify({ version: 1, plans: {
      EP0007: plan('plan-1', { scene_plan_run: node('recovery-plan-1-scene_plan_run', { dispatched: true, source_job_id: '104bf236' }) }),
      EP0008: plan('other-episode', {}, 'EP0008'),
    }, retired_plans: retired })
    await fs.writeFile(file, store)
    await jq.writeAuthoritativeJob({
      job_id: 'recovery-plan-1-scene_plan_run', project_slug: project.slug, episode_id: 'EP0007', type: 'scene_plan_run', title: 'Scene Plan',
      params: {}, status: 'error', created_at: '2026-10-20T00:00:00Z', started_at: null, finished_at: null, error: 'failed', output_lines: [],
    })

    const res = await request(app).get(url)
    assert.equal(res.status, 200)
    assert.equal(res.body.episode_id, 'EP0007')
    const [current, ...old] = res.body.plans
    assert.equal(current.id, 'plan-1')
    assert.equal(current.current, true)
    assert.equal(current.first_unresolved, 'scene_plan_run')
    assert.equal(current.dispatch_status, 'blocked')
    assert.deepEqual(current.steps, [{ step: 'scene_plan_run', job_id: 'recovery-plan-1-scene_plan_run',
      source_job_id: '104bf236', dispatched: true, status: 'error' }])
    assert.equal(old.length, 5, 'only the most recent retired plans are listed')
    assert.ok(old.every((entry: { current: boolean; id: string }) => !entry.current && entry.id !== 'other-episode'))
    assert.equal(await fs.readFile(file, 'utf8'), store, 'the plans file is byte-identical after the read')
  } finally { await (await import('../services/job-queue.js'))._waitForJobPersistenceForTesting(); await temp.cleanup() }
})
