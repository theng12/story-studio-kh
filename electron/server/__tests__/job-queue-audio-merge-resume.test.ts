// Dreamlands E2E (2026-10-03): restarting Story mid Audio Assembly left the job
// "Interrupted by app restart"; the owner had to find it and press Generate again.
// Audio Assembly is local FFmpeg work with no provider request, so it re-runs on boot.
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
})
after(async () => { await cleanup() })

test('a running Audio Assembly is re-run after a restart, not left "Interrupted"', async () => {
  const project = await pm.createProject({ name: 'Audio Merge Resume' })
  const row = {
    job_id: 'audio-merge-resume', project_slug: project.slug, type: 'audio_merge', episode_id: 'EP001',
    title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
    started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [], params: {},
  }
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [row] }))
  const executed: string[] = []
  jq.registerExecutor('audio_merge', async job => { executed.push(job.job_id) })
  await jq.getJobs(project.slug)
  await waitFor(() => jq.getJob(row.job_id)?.status === 'done', { label: 'resumed audio merge finishes' })
  assert.deepEqual(executed, [row.job_id])
  assert.equal(jq.getJob(row.job_id)?.status, 'done')
  assert.notEqual(jq.getJob(row.job_id)?.error, 'Interrupted by app restart')
})
