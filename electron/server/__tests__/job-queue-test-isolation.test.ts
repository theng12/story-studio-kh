/**
 * Regression: a queue worker may still be finishing after a test releases its
 * temporary data directory. That delayed persistence must never fall through
 * to the machine's configured projects root.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for the delayed queue worker')
}

test('a delayed queue completion cannot write into the configured projects root after test cleanup', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-queue-isolation-'))
  const fakeHome = path.join(sandbox, 'home')
  const configuredRoot = path.join(sandbox, 'configured-projects')
  const existingSlug = 'delayed-test-job-existing'
  const missingSlug = 'delayed-test-job-new'
  const configuredProject = path.join(configuredRoot, existingSlug)
  const configuredJobs = path.join(configuredProject, 'jobs.json')
  const baseline = '{"jobs":[{"job_id":"owner-record","status":"done"}]}\n'
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const originalConsoleError = console.error
  let isolationErrors = 0
  let markIsolationRejected!: () => void
  const isolationRejected = new Promise<void>(resolve => { markIsolationRejected = resolve })

  await fs.mkdir(path.join(fakeHome, 'Library', 'Application Support', 'Story Studio KH'), { recursive: true })
  await fs.mkdir(configuredProject, { recursive: true })
  await fs.writeFile(
    path.join(fakeHome, 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json'),
    JSON.stringify({ projects_root_override: configuredRoot }),
  )
  await fs.writeFile(configuredJobs, baseline)

  process.env.HOME = fakeHome
  delete process.env.USERPROFILE
  console.error = (...args: unknown[]) => {
    if (args.some(value => String(value).includes('job-queue isolation violation'))) {
      isolationErrors++
      if (isolationErrors === 2) markIsolationRejected()
      return
    }
    originalConsoleError(...args)
  }
  const isolated = await useTempDataDir()
  let releaseExecutor!: () => void
  let markBothStarted!: () => void
  let executorsStarted = 0
  const bothExecutorsStarted = new Promise<void>(resolve => { markBothStarted = resolve })
  const executorRelease = new Promise<void>(resolve => { releaseExecutor = resolve })

  const delayedExecutor = async (): Promise<void> => {
    executorsStarted++
    if (executorsStarted === 2) markBothStarted()
    await executorRelease
  }

  try {
    const jq = await import('../services/job-queue.js')
    jq.registerExecutor('broll_autotag', delayedExecutor)
    jq.registerExecutor('composition_generate', delayedExecutor)
    const existingProjectJob = jq.enqueuePreparedForTest({
      project_slug: existingSlug,
      type: 'broll_autotag',
      episode_id: 'EP0001',
      title: 'Delayed existing-project isolation sentinel',
      params: {},
    })
    const missingProjectJob = jq.enqueuePreparedForTest({
      project_slug: missingSlug,
      type: 'composition_generate',
      episode_id: 'EP0002',
      title: 'Delayed missing-project isolation sentinel',
      params: {},
    })

    await bothExecutorsStarted
    await isolated.cleanup()
    releaseExecutor()
    await waitFor(() => (
      jq.getJob(existingProjectJob.job_id)?.status === 'done'
      && jq.getJob(missingProjectJob.job_id)?.status === 'done'
    ))
    await Promise.race([
      isolationRejected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for blocked persistence')), 2_000)),
    ])

    assert.equal(
      await fs.readFile(configuredJobs, 'utf8'), baseline,
      'test-only queue persistence must leave the configured projects root byte-identical',
    )
    assert.deepEqual(
      (await fs.readdir(configuredRoot)).sort(), [existingSlug],
      'test-only queue persistence must not create the missing configured project directory',
    )
  } finally {
    releaseExecutor?.()
    console.error = originalConsoleError
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    delete process.env.STORY_STUDIO_DATA_DIR
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})
