import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { before, describe, test } from 'node:test'
import type { Job } from '../models/types.js'
import { assertProjectJobsSafeToRemove } from '../services/project-job-removal-guard.js'

const retainedRoot = path.resolve('_trash/test-fixtures/video-assembly-fleet-recovery')
const dataRoot = path.join(retainedRoot, `run-${process.pid}-${Date.now()}`)
process.env.STORY_STUDIO_DATA_DIR = dataRoot
let queue: typeof import('../services/job-queue.js')

function malformed(slug: string, status: Job['status'] = 'running'): Job {
  return {
    job_id: `malformed-${slug}`, project_slug: slug, type: 'video_assembly', episode_id: 'EP1', title: 'Video', status,
    created_at: '2026-10-15T00:00:00.000Z', started_at: '2026-10-15T00:00:00.000Z', finished_at: null,
    error: null, output_lines: [], params: {}, final_render_remote_wait: null as any,
    result: { video_assembly_checkpoint: { stage: 'final', version: 1 } }, pause_requested: true,
  }
}

before(async () => {
  await fs.mkdir(path.join(dataRoot, 'projects'), { recursive: true })
  queue = await import('../services/job-queue.js')
})

describe('video assembly remote-wait recovery fences', () => {
  test('boot gives marker presence priority over pause and local checkpoint recovery', async () => {
    const slug = `boot-${process.pid}`
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [malformed(slug)] }))
    let executions = 0
    const restore = queue._setExecutorForTesting('video_assembly', async () => { executions++; })
    const restored = (await queue.getJobs(slug)).find(job => job.job_id === `malformed-${slug}`)
    restore()
    assert.equal(executions, 0)
    assert.equal(restored?.status, 'running')
    assert.equal(restored?.final_render_wait?.state, 'recovery_hold')
    assert.equal(Object.hasOwn(restored || {}, 'final_render_remote_wait'), false)
    assert.equal(restored?.finished_at, null)
  })

  test('malformed terminal-looking lineage cannot be removed, cleared, retried, abandoned, or update-drained', async () => {
    const slug = `guards-${process.pid}`
    const projectDir = path.join(dataRoot, 'projects', slug)
    await fs.mkdir(projectDir, { recursive: true })
    const record = malformed(slug, 'error')
    await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [record] }))
    await assert.rejects(assertProjectJobsSafeToRemove(projectDir), { statusCode: 409 })
    let removalRan = false
    await assert.rejects(queue.withProjectJobRemovalGuard(slug, projectDir, async () => { removalRan = true }), { statusCode: 409 })
    assert.equal(removalRan, false)
    const restored = (await queue.getJobs(slug)).find(job => job.job_id === record.job_id)
    assert.equal(restored?.final_render_wait?.state, 'recovery_hold')
    assert.equal(queue.removeTerminalJob(slug, record.job_id), false)
    assert.equal(await queue.clearFinished(slug), 0)
    assert.throws(() => queue.retryTerminalJob(slug, record.job_id), /remote/i)
    await assert.rejects(queue.pauseJob(record.job_id), /remote/i)
    await assert.rejects(queue.resumeJob(record.job_id), /remote/i)
    await assert.rejects(queue.requestJobCancellation(slug, record.job_id), /remote/i)
    await assert.rejects(queue.forceAbandonJob(slug, record.job_id), /remote/i)
    assert.equal((await queue.runningJobsThatWouldNotResume()).some(job => job.job_id === record.job_id), true)
  })
})
