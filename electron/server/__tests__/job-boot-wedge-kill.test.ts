/**
 * A row left `running` by a kill says why it stopped, on the row itself.
 *
 * The wedge watchdog SIGKILLs the process, so nothing in the dying run can write a verdict. The next
 * start already ended such a row "Interrupted by app restart" — true, but silent about the wedge. The
 * watchdog leaves exactly one incident file beside the logs, and a file newer than the row's start is
 * proof that row was in flight when it fired, so the row can say which of the two happened.
 *
 * The machine-readable `error` stays the same value the retry rule matches on; the sentence goes on
 * the row's own lines, where the operator reads it.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { getLogDir } from '../services/logger.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')

const WEDGE_LINE = /killed by its watchdog/

before(async () => {
  const t = await useTempDataDir({ retain: true, settle: () => jq._waitForJobPersistenceForTesting() })
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

/** One project whose only job was in flight when the previous process stopped. */
async function seedRunningRow(name: string, jobId: string): Promise<string> {
  const project = await pm.createProject({ name })
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString()
  await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({
    jobs: [{
      job_id: jobId,
      project_slug: project.slug,
      type: 'chapter-only',
      episode_id: 'EP001',
      title: 'in flight when the process stopped',
      status: 'running',
      created_at: startedAt,
      started_at: startedAt,
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
    }],
  }))
  return project.slug
}

describe('boot requeue names a wedge kill', () => {
  test('a row the watchdog killed says so, keeps its id, and ends retryable', async () => {
    const slug = await seedRunningRow('Wedge kill boot', 'wedge-killed-row')
    const logDir = getLogDir()
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(path.join(logDir, 'incident-20261121T000000Z.txt'), 'the watchdog fired\n')

    await jq.resumeInterruptedJobsAtBoot()

    const row = jq.getJob('wedge-killed-row')!
    assert.equal(row.job_id, 'wedge-killed-row', 'the id is kept so Retry and the next start can follow it')
    assert.equal(row.status, 'error')
    assert.equal(row.error, 'Interrupted by app restart', 'the retry rule matches this exact value')
    assert.ok(row.output_lines.some(line => WEDGE_LINE.test(line)), JSON.stringify(row.output_lines))
    assert.equal(row.project_slug, slug)
  })

  test('with no incident file the row keeps the plain sentence, never an invented cause', async () => {
    const logDir = getLogDir()
    for (const name of await fs.readdir(logDir)) {
      if (name.startsWith('incident-')) await fs.rm(path.join(logDir, name))
    }
    await seedRunningRow('Plain restart boot', 'plain-restart-row')

    await jq.resumeInterruptedJobsAtBoot()

    const row = jq.getJob('plain-restart-row')!
    assert.equal(row.status, 'error')
    assert.equal(row.error, 'Interrupted by app restart')
    assert.equal(row.output_lines.some(line => WEDGE_LINE.test(line)), false)
  })
})
