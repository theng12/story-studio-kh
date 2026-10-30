/**
 * Every image evidence record rewrites the project's whole jobs.json. The image wait loop must
 * record only when the job's state, routing status or provider queue changed — the same guard
 * the other five wait loops use — not on every unchanged poll.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioState } from './fixtures/mock-genstudio-service.js'

test('unchanged image polls save nothing; a state change saves once', { timeout: 120_000 }, async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const settings = await import('../services/app-settings.js')
  const previousUrl = await settings.getGenStudioUrl()
  const client = await import('../lib/genstudio-client.js')
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  try {
    await settings.setGenStudioUrl(service.baseUrl)
    client.clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Image Poll Guard' })

    /** jobs.json writes made while one image is polled through `states`. */
    // §8 admission reads the episode code the way the resolver does
    // (`storedEpisodeNumber`: letters then digits). This fixture only needs
    // three distinct, code-shaped ids.
    let episodeSeq = 0
    const writesFor = async (label: string, states: MockGenStudioState[]): Promise<{ writes: number, polls: number }> => {
      service.queueScenario('image', { states })
      let measured = { writes: -1, polls: 0 }
      const done = new Promise<void>(resolve => {
        jq.registerExecutor('scene_image_generate', async () => {
          await jq._waitForJobPersistenceForTesting()
          jq._resetJobPersistenceCountersForTesting()
          const before = service.requests.length
          await client.generateImageWithGenStudio(MOCK_GENSTUDIO_FULL_KEY, {
            prompt: 'a lighthouse', modelId: 'mock-image-v1', aspectRatio: '16:9', requestIdentity: `poll-guard:${label}`,
          } as any)
          await jq._waitForJobPersistenceForTesting()
          measured = {
            writes: jq._getJobPersistenceCountersForTesting().atomic_writes,
            polls: service.requests.slice(before).filter(r => r.method === 'GET' && /^\/v1\/images\/mock-image-\d+$/.test(r.path)).length,
          }
          resolve()
        })
      })
      await jq.enqueue({ project_slug: project.slug, type: 'scene_image_generate', episode_id: `EP${++episodeSeq}`, title: label })
      await done
      return measured
    }

    const short = await writesFor('short', ['accepted', 'running', 'succeeded'])
    const long = await writesFor('long', ['accepted', 'running', 'running', 'running', 'running', 'succeeded'])
    const direct = await writesFor('direct', ['accepted', 'succeeded'])
    assert.equal(long.polls - short.polls, 3, 'the long run polls three more unchanged times')
    assert.ok(short.writes > 0)
    assert.equal(long.writes, short.writes, 'three unchanged polls must not save the job again')
    assert.equal(short.writes - direct.writes, 1, 'one state change (accepted → running) saves exactly once')
  } finally {
    await jq._waitForJobPersistenceForTesting()
    await settings.setGenStudioUrl(previousUrl).catch(() => {})
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})
