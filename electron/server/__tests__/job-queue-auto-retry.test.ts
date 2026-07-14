import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

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
  test('local subtitles retry partial work and chain only after recovery', async () => {
    const project = await pm.createProject({ name: 'Local Subtitle Retry' })
    let attempts = 0
    let partialWasPreserved = false
    let chained = 0

    jq.registerExecutor('subtitles_transcribe', async (job) => {
      attempts++
      if (attempts === 1) {
        partialWasPreserved = true
        job.result = { complete: false, missing_sections: ['Chapter_10'] }
        return
      }
      assert.equal(partialWasPreserved, true)
      job.result = { complete: true, missing_sections: [] }
    })
    jq.registerExecutor('audio_merge', async () => { chained++ })

    const queued = jq.enqueue({
      project_slug: project.slug,
      type: 'subtitles_transcribe',
      episode_id: 'EP0036',
      title: 'Local subtitles',
      params: {
        engine: 'voicestudio',
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
      return job?.status === 'done' ? job : undefined
    })
    await waitFor(() => chained === 1 ? chained : undefined)

    assert.equal(attempts, 2)
    assert.equal(chained, 1)
    assert.equal(settled.auto_retry?.eligible, true)
    assert.equal(settled.auto_retry?.attempt, 2)
    assert.match(settled.output_lines.join('\n'), /Local auto-retry attempt 2\/3/)
  })

  test('OpenAI subtitles fail once without automatic resubmission', async () => {
    const project = await pm.createProject({ name: 'Cloud Subtitle No Retry' })
    let attempts = 0
    jq.registerExecutor('subtitles_transcribe', async () => {
      attempts++
      throw new Error('OpenAI request failed')
    })

    const queued = jq.enqueue({
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
})
