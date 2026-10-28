/**
 * Choosing a sound, and crediting it (v1.4.365).
 *
 * Two things this pins that a looser test would miss:
 *
 *   * `selectSound` returning `null` is a REAL answer ("no match"), not a
 *     failure — a wrong sound is worse than silence, and a resolver that
 *     always picks its first candidate would still pass a test written only
 *     against the happy path.
 *   * A credit is recorded from what the clip published and for nothing else.
 *     A pool clip has no licence on disk, so a credit for one would be an
 *     invention, and the publish record would carry a licence nobody granted.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeSoundRanker,
  applySound,
  formatSoundCredits,
  selectSound,
  setSoundRanker,
  soundCreditsFor,
  type SoundCandidate,
  type SoundRanker,
} from '../services/sound-resolver.js'
import type { SoundDesignCue } from '../models/types.js'

function candidate(overrides: Partial<SoundCandidate> = {}): SoundCandidate {
  return {
    source: 'pool', key: 'sfx', label: 'temple-bells.wav',
    description: 'temple bells distant stone', ...overrides,
  }
}

function cue(overrides: Partial<SoundDesignCue> = {}): SoundDesignCue {
  return {
    id: 'sound-1', kind: 'spot', label: 'temple bells', start_sec: 10,
    source: 'pool', clip: '', gain_db: -12, status: 'proposed',
    created_at: 'now', updated_at: 'now', ...overrides,
  }
}

describe('Choosing a sound', () => {
  test('picks the clip the moment actually describes', () => {
    const chosen = selectSound('temple bells at dawn', 'spot', [
      candidate({ label: 'traffic.wav', description: 'city traffic cars' }),
      candidate(),
    ])
    assert.equal(chosen?.candidate.label, 'temple-bells.wav')
  })

  test('no match is NO SOUND, not the first candidate', () => {
    // A resolver that returned its first candidate would pass every happy-path
    // test and put a car horn under a temple.
    const chosen = selectSound('a sound nobody recorded', 'spot', [candidate({ label: 'traffic.wav', description: 'city traffic' })])
    assert.equal(chosen, null)
  })

  test('an empty candidate list is no sound, not a crash', () => {
    assert.equal(selectSound('temple bells', 'spot', []), null)
  })

  test('a bed is never filled from a spot, because the kinds do not mix', () => {
    // Half a second of a bell is not an ambient bed; the resolver must not
    // treat "some audio" as "the right audio".
    const short = selectSound('temple bells', 'bed', [candidate({ label: 'temple-bells.wav', description: 'temple bells' })])
    assert.equal(short, null, 'a candidate with no measured length cannot be a bed')
    const long = selectSound('temple bells', 'bed', [
      candidate({ label: 'temple-bells.wav', description: 'temple bells', duration_sec: 30 }),
    ])
    assert.equal(long?.candidate.label, 'temple-bells.wav')
  })

  test('the P4 ranker overrides order but cannot invent a candidate', () => {
    const chosen: SoundRanker = {
      id: 'test-ranker',
      rank: (_moment, candidates) => [...candidates].reverse(),
    }
    setSoundRanker(chosen)
    try {
      assert.equal(activeSoundRanker(), 'test-ranker')
      const picked = selectSound('anything at all', 'spot', [
        candidate({ label: 'first.wav', description: 'anything at all' }),
        candidate({ label: 'second.wav', description: 'nothing' }),
      ])
      // The ranker reorders, but the score still decides who wins — a ranker
      // cannot score a non-matching clip into the mix.
      assert.equal(picked?.candidate.label, 'first.wav')
    } finally { setSoundRanker(null) }
  })

  test('a ranker that throws is skipped rather than failing the proposal', () => {
    setSoundRanker({ id: 'broken', rank: () => { throw new Error('no model loaded') } })
    try {
      const picked = selectSound('temple bells', 'spot', [candidate()])
      assert.equal(picked?.candidate.label, 'temple-bells.wav', 'the lexical fallback still picks')
    } finally { setSoundRanker(null) }
  })
})

describe('Recording what a cue uses', () => {
  test('a pool cue records its pool and filename and NO credit', () => {
    const applied = applySound(cue(), candidate())
    assert.equal(applied.source, 'pool')
    assert.equal(applied.pool_id, 'sfx')
    assert.equal(applied.clip, 'temple-bells.wav')
    assert.equal(applied.credit, undefined, 'a pool clip publishes no licence, so none is invented')
  })

  test('a gateway cue records its sha and the credit it published', () => {
    const applied = applySound(cue(), candidate({
      source: 'gateway', key: 'a'.repeat(64), label: 'Temple Bells', description: 'bells',
      credit: { licence: 'cc0', author: 'Someone', source_url: 'https://example.test/x', title: 'Temple Bells' },
    }))
    assert.equal(applied.source, 'gateway')
    assert.equal(applied.clip, 'a'.repeat(64))
    assert.equal(applied.pool_id, undefined)
    assert.equal(applied.credit?.licence, 'cc0')
    assert.equal(applied.credit?.author, 'Someone')
  })

  test('a bed with no end takes the chosen clip’s measured length', () => {
    const applied = applySound(cue({ kind: 'bed', end_sec: undefined }), candidate({ duration_sec: 25 }))
    assert.equal(applied.end_sec, 35)
  })
})

describe('Per-clip credits', () => {
  const licensed = (clip: string, overrides: Partial<SoundDesignCue> = {}) => cue({
    id: clip, clip, source: 'gateway', status: 'approved',
    credit: { licence: 'by', author: 'Ada', source_url: 'https://example.test/a', title: clip },
    ...overrides,
  })

  test('the same clip used twice is ONE credit', () => {
    const credits = soundCreditsFor([licensed('aaa'), licensed('aaa', { start_sec: 40 })])
    assert.equal(credits.length, 1)
  })

  test('two different clips are two credits, in start order', () => {
    const credits = soundCreditsFor([licensed('bbb', { start_sec: 40 }), licensed('aaa', { start_sec: 5 })])
    assert.deepEqual(credits.map(row => row.clip), ['aaa', 'bbb'])
  })

  test('a cue with no credit contributes none — never a placeholder', () => {
    assert.deepEqual(soundCreditsFor([cue({ clip: 'temple-bells.wav', credit: undefined })]), [])
  })

  test('the printed line names the licence, the author and the source page', () => {
    const [line] = formatSoundCredits([licensed('aaa')])
    assert.match(line!, /"aaa" by Ada \(BY\)/)
    assert.match(line!, /https:\/\/example\.test\/a/)
  })
})
