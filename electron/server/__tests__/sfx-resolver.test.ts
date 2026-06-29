/**
 * Tests for the SFX resolver's pure matcher (services/sfx-resolver.ts).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, scoreCandidate, pickBest, resolvePlan, type SfxCandidate } from '../services/sfx-resolver.js'
import { normalizePlan, planAffectsRender } from '../services/sfx-plan.js'

const POOL = 'sfx1'
const CANDS: SfxCandidate[] = [
  { pool_id: POOL, filename: 'door_slam_heavy.mp3', tags: ['door', 'slam', 'wood'] },
  { pool_id: POOL, filename: 'city_night_amb.wav', tags: ['city', 'night', 'ambience', 'traffic'] },
  { pool_id: POOL, filename: 'whoosh_01.mp3', tags: ['whoosh', 'transition'] },
  { pool_id: POOL, filename: 'whoosh_02.mp3', tags: ['whoosh'] },
]

describe('tokenize', () => {
  test('drops stopwords and short tokens, lowercases', () => {
    assert.deepEqual(tokenize('The Door SLAM of a'), ['door', 'slam'])
  })
})

describe('scoreCandidate', () => {
  test('scores token overlap; exact-tag match gets a bonus', () => {
    const exactTag: SfxCandidate = { pool_id: POOL, filename: 'x.mp3', tags: ['door slam'] }
    assert.ok(scoreCandidate('door slam', exactTag) >= 2)
    assert.ok(scoreCandidate('door slam', CANDS[0]!) > 0)
    assert.equal(scoreCandidate('rocket launch', CANDS[0]!), 0)
  })
})

describe('pickBest', () => {
  test('returns the strongest match, honoring exclusions', () => {
    const first = pickBest('whoosh transition', CANDS, new Set())
    assert.equal(first!.filename, 'whoosh_01.mp3') // has both tokens
    const excluded = pickBest('whoosh transition', CANDS, new Set([`${POOL}/whoosh_01.mp3`]))
    assert.equal(excluded!.filename, 'whoosh_02.mp3')
  })
  test('no match → null', () => {
    assert.equal(pickBest('helicopter', CANDS, new Set()), null)
  })
})

describe('resolvePlan', () => {
  test('matches beds + spots, sets source/clip/status, leaves render live', () => {
    const plan = normalizePlan({
      enabled: true,
      beds: [{ label: 'city night', start_sec: 0, end_sec: 30, status: 'proposed' }],
      spots: [{ label: 'door slam', at_sec: 12, status: 'proposed' }],
    })
    const resolved = resolvePlan(plan, CANDS)
    assert.equal(resolved.beds[0]!.source, 'pool')
    assert.equal(resolved.beds[0]!.clip, 'city_night_amb.wav')
    assert.equal(resolved.beds[0]!.status, 'matched')
    assert.equal(resolved.spots[0]!.clip, 'door_slam_heavy.mp3')
    assert.equal(planAffectsRender(resolved), true)
  })

  test('spots are no-repeat: two "whoosh" spots get different files', () => {
    const plan = normalizePlan({
      enabled: true,
      spots: [
        { label: 'whoosh', at_sec: 1, status: 'proposed' },
        { label: 'whoosh', at_sec: 5, status: 'proposed' },
      ],
    })
    const resolved = resolvePlan(plan, CANDS)
    const files = resolved.spots.map(s => s.clip)
    assert.notEqual(files[0], files[1])
    assert.ok(files.every(f => f.startsWith('whoosh')))
  })

  test('unmatched cue becomes empty and does not affect render', () => {
    const plan = normalizePlan({ enabled: true, spots: [{ label: 'helicopter', at_sec: 2, status: 'proposed' }] })
    const resolved = resolvePlan(plan, CANDS)
    assert.equal(resolved.spots[0]!.status, 'empty')
    assert.equal(resolved.spots[0]!.clip, '')
    assert.equal(planAffectsRender(resolved), false)
  })

  test('user-swapped cues are respected (not re-resolved)', () => {
    const plan = normalizePlan({
      enabled: true,
      spots: [{ label: 'door slam', at_sec: 1, source: 'pool', pool_id: POOL, clip: 'my_custom.mp3', status: 'user-swapped' }],
    })
    const resolved = resolvePlan(plan, CANDS)
    assert.equal(resolved.spots[0]!.clip, 'my_custom.mp3')
    assert.equal(resolved.spots[0]!.status, 'user-swapped')
  })
})
