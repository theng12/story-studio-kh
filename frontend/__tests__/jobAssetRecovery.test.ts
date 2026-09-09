import assert from 'node:assert/strict'
import test from 'node:test'

import { describeEpisodeAssetRecovery, recoverEpisodeAssets } from '../utils/job-asset-recovery.js'

test('targeted recovery uses only free endpoints and keeps queued images separate from recovered audio', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const progress: string[] = []
  const result = await recoverEpisodeAssets('my project', 'SS0077', async (path, body) => {
    calls.push({ path, body })
    if (path.endsWith('/assets/repair-all')) {
      return {
        audited_episode_codes: ['SS0077'],
        enqueued: [{ episode_id: 'SS0077', job_id: 'images-1', type: 'images_repair' }],
        skipped: [{ episode_id: 'SS0077', modality: 'images', reason: 'already queued/running' }],
        audio_repair_candidates: ['SS0077'],
      }
    }
    return { recovered: 3, still_missing: 2, total_expected: 5 }
  }, message => progress.push(message))

  assert.deepEqual(calls, [
    { path: '/projects/my%20project/assets/repair-all', body: { episode_codes: ['SS0077'] } },
    { path: '/projects/my%20project/episodes/SS0077/audio-repair', body: {} },
  ])
  assert.deepEqual(progress, [
    'Checking this episode’s saved images and audio…',
    'Recovering this episode’s saved audio…',
  ])
  assert.deepEqual(result, {
    episodeId: 'SS0077', imageJobIds: ['images-1'], imagesQueued: 1, imagesAlreadyPending: 1,
    audioAttempted: true, audio: { recovered: 3, stillMissing: 2, totalExpected: 5 },
  })
  assert.equal(
    describeEpisodeAssetRecovery(result),
    'Audio: 3 recovered, 2 still missing. 1 image repair job queued. 1 image repair job already pending.',
  )
  assert.equal(calls.filter(call => /generate|retry|pipeline|plan/.test(call.path)).length, 0)
})

test('an unaccepted episode stops before any audio follow-up', async () => {
  const calls: string[] = []
  await assert.rejects(
    recoverEpisodeAssets('project', 'SS0077', async path => {
      calls.push(path)
      return { audited_episode_codes: [], enqueued: [], skipped: [], audio_repair_candidates: [] }
    }),
    /was not accepted in this project/,
  )
  assert.deepEqual(calls, ['/projects/project/assets/repair-all'])
})

test('a malformed or cross-episode audit never starts audio recovery', async () => {
  for (const audit of [
    null,
    { audited_episode_codes: ['SS0077'], enqueued: 'nope', skipped: [], audio_repair_candidates: ['SS0077'] },
    { audited_episode_codes: ['SS0077'], enqueued: [{ episode_id: 'SS0088', job_id: 'wrong' }], skipped: [], audio_repair_candidates: ['SS0077'] },
    { audited_episode_codes: ['SS0077'], enqueued: [], skipped: [{ episode_id: 'SS0088' }], audio_repair_candidates: ['SS0077'] },
    { audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: ['SS0088'] },
    { audited_episode_codes: ['SS0077', 'SS0088'], enqueued: [], skipped: [], audio_repair_candidates: [] },
  ]) {
    const calls: string[] = []
    await assert.rejects(recoverEpisodeAssets('project', 'SS0077', async path => {
      calls.push(path)
      return audit
    }))
    assert.deepEqual(calls, ['/projects/project/assets/repair-all'])
  }
})

test('unknown audio counts stay unknown, and no queued work does not claim the episode is complete', async () => {
  const result = await recoverEpisodeAssets('project', 'SS0077', async path => {
    if (path.endsWith('/assets/repair-all')) {
      return { audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: ['SS0077'] }
    }
    return { recovered: null, still_missing: null, total_expected: null }
  })
  assert.equal(result.audio, null)
  assert.equal(result.imagesQueued, 0)
  assert.equal(
    describeEpisodeAssetRecovery(result),
    'Audio recovery returned no verified counts.',
  )
  assert.doesNotMatch(describeEpisodeAssetRecovery(result), /0 recovered|complete/i)
})

test('duplicate target candidates make one audio request, and an audio error remains visible', async () => {
  const calls: string[] = []
  const result = await recoverEpisodeAssets('project', 'SS0077', async path => {
    calls.push(path)
    if (path.endsWith('/assets/repair-all')) {
      return { audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: ['SS0077', 'SS0077'] }
    }
    return { recovered: 1, still_missing: 0, total_expected: 1 }
  })
  assert.equal(calls.filter(path => path.endsWith('/audio-repair')).length, 1)
  assert.deepEqual(result.audio, { recovered: 1, stillMissing: 0, totalExpected: 1 })

  await assert.rejects(
    recoverEpisodeAssets('project', 'SS0077', async path => {
      if (path.endsWith('/assets/repair-all')) {
        return { audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: ['SS0077'] }
      }
      throw new Error('provider history unavailable')
    }),
    /provider history unavailable/,
  )
})

test('no accepted asset gaps uses the explicit unfinished-step fallback', async () => {
  const result = await recoverEpisodeAssets('project', 'SS0077', async () => ({
    audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: [],
  }))
  assert.equal(
    describeEpisodeAssetRecovery(result),
    'No missing audio or thumbnail files were found. Retry the unfinished step if needed.',
  )
})

test('invalid project or episode targets do not make a request', async () => {
  const post = async () => { throw new Error('must not post') }
  for (const [project, episode] of [['', 'SS0077'], ['_app_', 'SS0077'], ['project', ''], ['project', '_app_']]) {
    await assert.rejects(recoverEpisodeAssets(project, episode, post))
  }
})
