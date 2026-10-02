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
})
