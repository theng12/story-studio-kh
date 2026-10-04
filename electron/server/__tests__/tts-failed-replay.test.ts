/**
 * A narration part's key is derived from the part, so when Story's record of an earlier FAILED
 * request is gone (a lost accept answer, a removed `.task-manifest.json`), "Generate missing"
 * re-POSTs that key and the Gateway answers with the OLD failed job: the part failed in a second
 * with the old night's error (tts-comparison re-run, 2026-10-04 09:39). Same rule as chat
 * (`chat-failed-replay.test.ts`): a settled, free replayed failure is re-sent once under the
 * identity the run's own retry derives from the dead job (`nextTtsRouteRetryIdentity`). Anything
 * that charged or may still settle keeps its key: that guard is
 * the shared `replayedSettledChatFailure`, pinned in `chat-failed-replay.test.ts` (this mock always
 * settles a failure at zero, so it cannot express a charged one).
 *
 * Runs against the in-process mock GenStudio service: zero network, zero spend.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
const client = await import('../lib/genstudio-client.js')
const { nextTtsRouteRetryIdentity } = await import('../services/tts-capacity-retry.js')

const request = (accepted: string[] = []) => ({
  text: 'This speech exists only inside the deterministic mock service.',
  voiceId: 'mock-voice', modelId: 'mock-tts-model', maxInputCharacters: 12_000, speed: 1,
  requestIdentity: 'proj:EP0001:audio:Chapter_01.mp3',
  onJobAccepted: (_id: string, key: string) => { accepted.push(key) },
})

void test('narration replays of an earlier failure', async (suite) => {
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const settings = await import('../services/app-settings.js')
  await settings.setGenStudioUrl(service.baseUrl)
  try {
    await suite.test('a free settled failure is sent fresh once, under the retry identity derived from the dead job', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['failed'], failureCode: 'PROVIDER_FAILED' })
      const first = await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'a.mp3'), request() as any)
        .then(() => null, (error: any) => error)
      assert.ok(first?.jobId, 'the first night failed')
      assert.equal(service.providerSubmissionCount('tts'), 1, 'a new job that fails is not a replay: no second job')

      // The record is gone: the re-run sends the part's own key again.
      const accepted: string[] = []
      const out = path.join(temp.dir, 'b.mp3')
      await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, out, request(accepted) as any)
      assert.ok(existsSync(out), 'the part was made')
      assert.equal(service.providerSubmissionCount('tts'), 2, 'one new job, not a replayed failure')
      const derived = nextTtsRouteRetryIdentity(request().requestIdentity, first.jobId)
      assert.deepEqual(accepted, [client.buildGenStudioSubmission({ ...request(), requestIdentity: derived } as any).idempotencyKey],
        'Story records the key the Gateway accepted, so a restart reattaches instead of buying a third')
    })

    await suite.test('a pinned key (a resume, a deliberate action\'s Retry) is never moved', async () => {
      service.reset()
      service.queueScenario('tts', { states: ['failed'], failureCode: 'PROVIDER_FAILED' })
      const identity = { ...request(), requestIdentity: 'proj:EP0001:audio:Chapter_02.mp3:regenerate:action-1' }
      const pinned = { ...identity, idempotencyKey: client.buildGenStudioSubmission(identity as any).idempotencyKey }
      await client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'c.mp3'), pinned as any).catch(() => null)
      await assert.rejects(client.generateTtsToFile(MOCK_GENSTUDIO_FULL_KEY, path.join(temp.dir, 'd.mp3'), pinned as any))
      assert.equal(service.providerSubmissionCount('tts'), 1, 'the Retry replays the action, as promised')
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
