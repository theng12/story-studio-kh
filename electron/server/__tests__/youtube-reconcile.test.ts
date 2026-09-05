import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  analyzeYouTubeReconcile,
  type LocalEpisode,
  type RemoteVideo,
} from '../services/youtube-reconcile.js'

function analyze(episodes: LocalEpisode[], videos: RemoteVideo[]) {
  return analyzeYouTubeReconcile({ episodes, videos })
}

function candidateFor(result: ReturnType<typeof analyze>, episode: string) {
  return result.candidates.find(candidate => candidate.episode_code === episode)
}

describe('reconcile matching', () => {
  test('a recorded video id links itself; nothing weaker does', () => {
    const exact = analyze(
      [{ episode_code: 'EP0001', recorded_video_id: 'video-1', title: 'A' }],
      [{ video_id: 'video-1', title: 'Completely Different' }],
    )
    assert.equal(candidateFor(exact, 'EP0001')?.evidence, 'stored_video_id')
    assert.equal(candidateFor(exact, 'EP0001')?.auto_linkable, true)

    const receipt = analyze(
      [{ episode_code: 'EP0001', receipt_video_id: 'video-1' }],
      [{ video_id: 'video-1' }],
    )
    assert.equal(candidateFor(receipt, 'EP0001')?.evidence, 'upload_receipt')
    assert.equal(candidateFor(receipt, 'EP0001')?.auto_linkable, true)
  })

  test('every inference requires confirmation, whatever its rank', () => {
    const cases: Array<[string, LocalEpisode[], RemoteVideo[], string]> = [
      ['unique_episode_code',
        [{ episode_code: 'EP0007' }],
        [{ video_id: 'video-a', title: 'Something EP0007 Something' }],
        'a code in a title is an inference'],
      ['exact_title',
        [{ episode_code: 'EP0001', title: 'The Same Title' }],
        [{ video_id: 'video-a', title: 'the same title' }],
        'identical titles are still an inference'],
      ['strong_title_similarity',
        [{ episode_code: 'EP0001', title: 'The Quiet Deep Ocean Story' }],
        [{ video_id: 'video-a', title: 'The Quiet Deep Ocean Story Remastered' }],
        'similar is not the same'],
      ['publication_proximity',
        [{ episode_code: 'EP0001', scheduled_for: '2026-09-01T10:00:00.000Z' }],
        [{ video_id: 'video-a', published_at: '2026-09-01T12:00:00.000Z' }],
        'timing is circumstantial'],
      ['duration_similarity',
        [{ episode_code: 'EP0001', duration_seconds: 1000 }],
        [{ video_id: 'video-a', duration_seconds: 1000 }],
        'length is circumstantial'],
    ]
    for (const [expected, episodes, videos, why] of cases) {
      const result = analyze(episodes, videos)
      const candidate = candidateFor(result, episodes[0]!.episode_code)
      assert.equal(candidate?.evidence, expected, expected)
      assert.equal(candidate?.auto_linkable, false, why)
      assert.equal(typeof candidate?.reason, 'string')
      assert.equal(candidate!.reason.length > 0, true, `${expected} explains itself`)
    }
  })

  test('an episode code is a whole token, not a substring', () => {
    // EP0001 must not match a video titled "...EP00012...".
    const result = analyze(
      [{ episode_code: 'EP0001' }],
      [{ video_id: 'video-a', title: 'Chapter EP00012 Continues' }],
    )
    assert.equal(candidateFor(result, 'EP0001'), undefined)
    assert.deepEqual(result.local_only, ['EP0001'])
  })

  test('a code claimed by two videos is not unique, so it does not match on code', () => {
    const result = analyze(
      [{ episode_code: 'EP0001' }],
      [
        { video_id: 'video-a', title: 'EP0001 first cut' },
        { video_id: 'video-b', title: 'EP0001 second cut' },
      ],
    )
    assert.equal(result.candidates.length, 0, 'not unique means not evidence')
    assert.deepEqual(result.local_only, ['EP0001'])
  })

  test('two episodes contesting one video suppress auto-linking on BOTH', () => {
    // Even a recorded fact is suppressed: linking either automatically would
    // pick a winner nobody chose.
    const result = analyze(
      [
        { episode_code: 'EP0001', recorded_video_id: 'video-1' },
        { episode_code: 'EP0002', recorded_video_id: 'video-1' },
      ],
      [{ video_id: 'video-1' }],
    )
    assert.equal(result.candidates.length, 2)
    assert.equal(result.candidates.every(candidate => candidate.auto_linkable === false), true)
    assert.equal(result.duplicates.some(d => d.kind === 'video' && d.id === 'video-1'), true)
  })

  test('one episode matching two videos is a duplicate needing review', () => {
    const result = analyze(
      [{ episode_code: 'EP0001', title: 'Shared Title' }],
      [
        { video_id: 'video-a', title: 'Shared Title' },
        { video_id: 'video-b', title: 'Shared Title' },
      ],
    )
    assert.equal(result.duplicates.some(d => d.kind === 'episode' && d.id === 'EP0001'), true)
    assert.equal(result.candidates.every(candidate => candidate.auto_linkable === false), true)
  })

  test('unmatched things are reported as their own kind of unmatched', () => {
    const result = analyze(
      [{ episode_code: 'EP0001', title: 'Only Local' }],
      [{ video_id: 'video-orphan', title: 'Only Remote' }],
    )
    assert.deepEqual(result.candidates, [])
    assert.deepEqual(result.local_only, ['EP0001'])
    assert.deepEqual(result.youtube_only, ['video-orphan'])
  })

  test('titles are compared on structure, not on a flattened form', () => {
    // The Phase 5 lesson: a normalisation that flattens hides a difference.
    // Two genuinely different titles must not collapse into one match.
    const result = analyze(
      [{ episode_code: 'EP0001', title: 'Whales' }],
      [{ video_id: 'video-a', title: 'Whales and Dolphins of the Deep Atlantic Ocean' }],
    )
    assert.equal(candidateFor(result, 'EP0001'), undefined, 'a short title inside a long one is not a match')
  })

  test('candidates come back strongest first', () => {
    const result = analyze(
      [
        { episode_code: 'EP0002', title: 'Exact One' },
        { episode_code: 'EP0001', recorded_video_id: 'video-1' },
      ],
      [
        { video_id: 'video-1' },
        { video_id: 'video-2', title: 'Exact One' },
      ],
    )
    assert.equal(result.candidates[0]?.evidence, 'stored_video_id')
    assert.equal(result.candidates[0]!.rank < result.candidates[1]!.rank, true)
  })

  test('every candidate carries the spec-s own state name, not only a rank', () => {
    const exact = analyze(
      [{ episode_code: 'EP0001', recorded_video_id: 'video-1' }],
      [{ video_id: 'video-1' }],
    )
    assert.equal(candidateFor(exact, 'EP0001')?.state, 'exact_match_available')

    const probable = analyze(
      [{ episode_code: 'EP0001', title: 'The Same Title' }],
      [{ video_id: 'video-a', title: 'The Same Title' }],
    )
    assert.equal(candidateFor(probable, 'EP0001')?.state, 'probable_match')

    const weak = analyze(
      [{ episode_code: 'EP0001', duration_seconds: 1000 }],
      [{ video_id: 'video-a', duration_seconds: 1000 }],
    )
    assert.equal(candidateFor(weak, 'EP0001')?.state, 'needs_review')

    const contested = analyze(
      [{ episode_code: 'EP0001', title: 'Shared' }],
      [{ video_id: 'video-a', title: 'Shared' }, { video_id: 'video-b', title: 'Shared' }],
    )
    assert.equal(contested.candidates.every(candidate => candidate.state === 'possible_duplicate'), true)
  })

  test('nothing to reconcile is empty on every axis, not an error', () => {
    const result = analyze([], [])
    assert.deepEqual(result.candidates, [])
    assert.deepEqual(result.local_only, [])
    assert.deepEqual(result.youtube_only, [])
    assert.deepEqual(result.duplicates, [])
  })
})
