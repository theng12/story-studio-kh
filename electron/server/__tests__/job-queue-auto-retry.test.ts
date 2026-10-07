import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { waitFor as waitForCondition } from './_timing.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for queue state')
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('queue-owned local retries', () => {
  test('Gateway subtitles preserve partial evidence without automatic resubmission', async () => {
    const project = await pm.createProject({ name: 'Gateway Subtitle Recovery' })
    let attempts = 0
    let chained = 0

    jq.registerExecutor('subtitles_transcribe', async (job) => {
      attempts++
      job.result = { complete: false, missing_sections: ['Chapter_10'] }
      throw new Error('Gateway terminal failure')
    })
    jq.registerExecutor('audio_merge', async () => { chained++ })

    const queued = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'subtitles_transcribe',
      episode_id: 'EP0036',
      title: 'Local subtitles',
      params: {
        engine: 'genstudio',
        per_chapter: true,
        pipeline_chain: [{
          type: 'audio_merge',
          title: 'next',
          params: { episode_id: 'EP0036' },
        }],
      },
    })

    const settled = await waitFor(() => {
      const job = jq.getJob(queued.job_id)
      return job?.status === 'error' ? job : undefined
    })

    assert.equal(attempts, 1)
    assert.equal(chained, 0)
    assert.equal(settled.auto_retry?.eligible, false)
    assert.deepEqual((settled.result as any)?.missing_sections, ['Chapter_10'])
    assert.match(settled.output_lines.join('\n'), /Automatic retry not used/)
  })

  test('legacy OpenAI subtitle settings cannot restore automatic provider retries', async () => {
    const project = await pm.createProject({ name: 'Retired Subtitle Route' })
    let attempts = 0
    jq.registerExecutor('subtitles_transcribe', async () => {
      attempts++
      throw new Error('Legacy setting awaiting Gateway migration')
    })

    const queued = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'subtitles_transcribe',
      episode_id: 'EP0037',
      title: 'Cloud subtitles',
      params: { engine: 'openai', per_chapter: true },
    })
    const settled = await waitFor(() => {
      const job = jq.getJob(queued.job_id)
      return job?.status === 'error' ? job : undefined
    })

    assert.equal(attempts, 1)
    assert.equal(settled.auto_retry?.eligible, false)
    assert.equal(settled.auto_retry?.max_attempts, 1)
    assert.match(settled.output_lines.join('\n'), /Automatic retry not used/)
  })

  test('an attempt that finishes more items earns a fresh retry budget; three attempts without progress stop', async () => {
    const { requireJobCompletion } = await import('../services/job-completion.js')
    const realNow = Date.now
    let skipped = 0
    Date.now = () => realNow() + skipped
    // Skip the retry waits: the clock jumps a minute every 50 ms of real time.
    const clock = setInterval(() => { skipped += 60_000 }, 50)
    try {
      for (const run of [
        { name: 'progress', remaining: [4, 3, 2, 1, 0], status: 'done', attempts: 5 },
        { name: 'stall', remaining: [4, 3, 3, 3, 3, 3], status: 'error', attempts: 4 },
      ]) {
        const project = await pm.createProject({ name: `Retry budget ${run.name}` })
        let attempt = 0
        jq.registerExecutor('audio_merge', async (job) => {
          const remaining = run.remaining[attempt++]!
          requireJobCompletion(job, { label: 'Merge', expected: 10, completed: 10 - remaining })
        })
        const queued = jq.enqueuePreparedForTest({
          project_slug: project.slug, type: 'audio_merge', episode_id: 'EP0040', title: 'Merge', params: { episode_id: 'EP0040' },
        })
        await waitForCondition(() => ['done', 'error'].includes(jq.getJob(queued.job_id)?.status || ''), {
          label: `${run.name} run settles`, timeoutMs: 10_000, maxWallClockMs: Number.POSITIVE_INFINITY,
        })
        const settled = jq.getJob(queued.job_id)!
        assert.equal(settled.status, run.status, run.name)
        assert.equal(attempt, run.attempts, `${run.name}: executor runs`)
        assert.equal(settled.auto_retry?.attempt, run.attempts)
      }
    } finally {
      clearInterval(clock)
      Date.now = realNow
    }
  })

  test('an error that cannot pass on a second run skips the retry waits and says what to fix', async () => {
    const { nonRetryable } = await import('../services/job-retry-policy.js')
    const project = await pm.createProject({ name: 'Preflight stop' })
    let attempts = 0
    jq.registerExecutor('audio_merge', async () => {
      attempts++
      throw nonRetryable(new Error('the saved plan has no pacing snapshot'))
    })
    const queued = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'audio_merge', episode_id: 'EP0041', title: 'Merge', params: { episode_id: 'EP0041' },
    })
    const settled = await waitFor(() => {
      const job = jq.getJob(queued.job_id)
      return job?.status === 'error' ? job : undefined
    }, 1_500)
    assert.equal(attempts, 1, 'no 2 s / 8 s waits on a certain failure')
    assert.equal(settled.auto_retry?.exhausted, undefined)
    assert.match(settled.output_lines.join('\n'), /Automatic retry skipped: .* Fix what the error names, then press Retry/)
  })
})
