/**
 * A jobs.json write that fails before its first await must not wedge the project's writer.
 * It used to leave `state.writing` set to a settled promise, so every later write for that
 * project waited forever (and the test drain helper spun on it as a microtask loop).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms).unref()),
])

test('a refused jobs.json write does not stop the next write for that project', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Writer Recovers' })
    const job = { job_id: 'writer-recovers', project_slug: project.slug, type: 'metadata', status: 'done', title: 'first',
      params: {}, output_lines: [], created_at: '2026-10-07T00:00:00.000Z' } as unknown as Job
    await jq.writeAuthoritativeJob(job)

    // With no claimed data dir the isolation check refuses this write synchronously, before the
    // writer's first await (and before anything touches disk).
    delete process.env.STORY_STUDIO_DATA_DIR
    await assert.rejects(within(jq.mutateAuthoritativeJob(project.slug, job.job_id, row => ({ ...row, title: 'refused' })), 5_000, 'the refused write'),
      /isolation violation/)
    process.env.STORY_STUDIO_DATA_DIR = temp.dir

    await within(jq.mutateAuthoritativeJob(project.slug, job.job_id, row => ({ ...row, title: 'second' })), 5_000, 'the next write')
    const onDisk = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'jobs.json'), 'utf8')) as { jobs: Job[] }
    assert.equal(onDisk.jobs.find(row => row.job_id === job.job_id)?.title, 'second')
    await within(jq._waitForJobPersistenceForTesting(), 5_000, 'the persistence drain')
  } finally {
    process.env.STORY_STUDIO_DATA_DIR = temp.dir
    await temp.cleanup()
  }
})
