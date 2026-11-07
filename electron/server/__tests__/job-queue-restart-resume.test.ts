// R2 (2026-10-07): quitting or updating Story while writing work or an upload ran left those jobs
// "Interrupted by app restart", and the Pipeline steps after them never started. Writing work keeps
// its saved answers and collects earlier requests by key; an upload resumes its saved YouTube
// session. Both are picked up at boot. Anything still interrupted lets its independent steps start.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  // Restart recovery is independent of the channel's upload window.
  jq._setUploadPacingContextForTesting(() => null)
})
after(async () => {
  jq._setUploadPacingContextForTesting(null)
  await cleanup()
})

function runningRow(slug: string, id: string, type: string, params: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    job_id: id, project_slug: slug, type, episode_id: 'EP001', title: type, status: 'running',
    created_at: now, started_at: now, finished_at: null, error: null, output_lines: [], params: { episode_id: 'EP001', ...params },
  }
}

test('writing steps and uploads running at quit are picked up again at boot', async () => {
  const project = await pm.createProject({ name: 'Restart Resume' })
  const rows = [
    runningRow(project.slug, 'restart-scene-plan', 'scene_plan_run', { stage: 'visual', model: 'studio-hub::gemma' }),
    runningRow(project.slug, 'restart-metadata', 'metadata', {}),
    runningRow(project.slug, 'restart-upload', 'youtube_upload', {}),
  ]
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: rows }))
  const executed: string[] = []
  for (const type of ['scene_plan_run', 'metadata', 'youtube_upload'] as const) {
    jq.registerExecutor(type, async job => { executed.push(job.job_id) })
  }
  await jq.getJobs(project.slug)
  await waitFor(() => rows.every(row => jq.getJob(row.job_id)?.status === 'done'), { label: 'resumed jobs finish' })
  await jq._waitForJobPersistenceForTesting()
  assert.deepEqual(executed.sort(), rows.map(row => row.job_id).sort())
  assert.match(jq.getJob('restart-upload')!.output_lines.join('\n'), /resuming the upload from its saved YouTube session/)
  assert.match(jq.getJob('restart-metadata')!.output_lines.join('\n'), /collected by its saved key/)
})

test('a step a restart still interrupts lets its independent Pipeline steps start', async () => {
  const project = await pm.createProject({ name: 'Restart Chain' })
  const row = runningRow(project.slug, 'restart-clips', 'video', {
    pipeline_step: 'motion_review',
    pipeline_chain: [
      { type: 'metadata', title: 'Finalizer', params: { pipeline_step: 'metadata', pipeline_requires: ['subtitles'] } },
      { type: 'video_assembly', title: 'Assembly', params: { pipeline_step: 'video_assembly', pipeline_requires: ['motion_review'] } },
    ],
  })
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [row] }))
  const started: string[] = []
  jq.registerExecutor('metadata', async job => { started.push(job.type) })
  await jq.getJobs(project.slug)
  const interrupted = jq.getJob(row.job_id)!
  assert.equal(interrupted.status, 'error')
  assert.equal(interrupted.error, 'Interrupted by app restart')
  await waitFor(() => started.includes('metadata'), { label: 'independent step starts' })
  const finalizer = (await jq.getJobs(project.slug)).find(job => job.type === 'metadata')!
  await waitFor(() => jq.getJob(finalizer.job_id)?.status === 'done', { label: 'independent step finishes' })
  await jq._waitForJobPersistenceForTesting()
  await waitFor(() => jq.getJob(row.job_id)!.output_lines.some(line => /kept going/.test(line)), { label: 'hand-off recorded' })
  await jq._waitForJobPersistenceForTesting()
  const settled = jq.getJob(row.job_id)!
  // The step that needs the interrupted one stays with it, so its Retry continues exactly that.
  assert.deepEqual((settled.params.pipeline_chain as Array<{ type: string }>).map(link => link.type), ['video_assembly'])
  assert.match(settled.output_lines.join('\n'), /kept going with the steps that don't need this one/)
})
