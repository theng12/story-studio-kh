/**
 * Anchors — a label and a sound follow the words they belong to (v1.4.365).
 *
 * The owner's complaint was exact: cues "start at scene start +0.15 s for
 * 3.5 s, not when the word is spoken", and a Scene Plan re-run left them on a
 * clock nobody was listening to any more.
 *
 * Every case below pins a specific behaviour a regression would break, and each
 * one names the defect it is guarding rather than restating the code.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorPhraseAt,
  reconcileAnchoredCues,
  resolveAnchoredStart,
  type CueTiming,
} from '../contracts/cue-anchor.js'
import { describeAnchorMoves, hasAnchorMoves, reanchorLabels, reanchorSounds } from '../services/sound-cue-anchors.js'
import type { ContextualCueTimeline, ScenePlan, SoundDesignTimeline } from '../models/types.js'
import { DEFAULT_SOUND_DESIGN_SETTINGS } from '../services/sound-design.js'

/** Two scenes, three subtitle cues in the first. */
const plan = {
  generated_at: 'now', total_duration_sec: 40,
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 20, transcript_segment: '', visual_prompt: '' },
    { id: 'scene-2', scene_index: 2, start_sec: 20, end_sec: 40, transcript_segment: '', visual_prompt: '' },
  ],
} as unknown as ScenePlan

const subtitles: CueTiming[] = [
  { start_sec: 0.5, end_sec: 4.5, text: 'The temple was built in the ninth century.' },
  { start_sec: 5, end_sec: 9, text: 'Its walls carry a thousand carved faces.' },
  { start_sec: 21, end_sec: 25, text: 'The temple was abandoned after the flood.' },
]

describe('Resolving a spoken anchor', () => {
  test('a phrase lands where the narration says it, not at a fixed offset', () => {
    const at = resolveAnchoredStart({ anchor_word: 'a thousand carved faces' }, plan.scenes[0], subtitles)
    assert.equal(at.source, 'word')
    // Third word of five in a 4s cue: ~1.6s in, so ~6.6s on the episode clock.
    assert.ok(at.start_sec > 6.4 && at.start_sec < 7.2, `expected ~6.6s, got ${at.start_sec}`)
    // The old behaviour would have put this at 0.15s. That is the whole defect.
    assert.ok(at.start_sec > 1, 'it must not be pinned to the scene start')
  })

  test('the SAME phrase in a LATER scene resolves to that scene', () => {
    // "The temple was…" appears twice. A resolver that scanned the whole
    // episode would drag a scene-2 cue back to 0.5s and overlap scene 1.
    const at = resolveAnchoredStart({ anchor_word: 'The temple was' }, plan.scenes[1], subtitles)
    assert.equal(at.source, 'word')
    assert.ok(at.start_sec >= 21, `expected a scene-2 time, got ${at.start_sec}`)
  })

  test('a phrase that appears nowhere falls back to the scene offset, and SAYS so', () => {
    const at = resolveAnchoredStart({ anchor_word: 'a phrase nobody says', anchor_offset_sec: 4 }, plan.scenes[0], subtitles)
    assert.equal(at.source, 'scene-offset')
    assert.equal(at.start_sec, 4)
  })

  test('no anchor at all falls back to the scene start, reported as such', () => {
    const at = resolveAnchoredStart({}, plan.scenes[1], subtitles)
    assert.equal(at.source, 'scene-start')
    assert.equal(at.start_sec, 20)
  })

  test('a scene that is gone is reported, never placed at zero as if it were real', () => {
    // AGENTS.md §6: "the answer is none" and "I could not work it out" must not
    // be the same value. `missing_scene` is the difference.
    const at = resolveAnchoredStart({ anchor_word: 'temple' }, undefined, subtitles)
    assert.equal(at.missing_scene, true)
  })

  test('an offset past the end of its scene is clamped into it', () => {
    const at = resolveAnchoredStart({ anchor_offset_sec: 900 }, plan.scenes[0], subtitles)
    assert.ok(at.start_sec <= 20, 'a cue may not be placed past the end of the scene it belongs to')
  })
})

describe('Re-anchoring a whole timeline', () => {
  const cues = [
    { id: 'a', scene_id: 'scene-1', anchor_word: 'carved faces', start_sec: 0.15, end_sec: 3.65, title: 'Faces' },
    { id: 'b', scene_id: 'scene-2', anchor_word: 'after the flood', start_sec: 20.15, end_sec: 23.65, title: 'Flood' },
    { id: 'c', scene_id: 'scene-removed', start_sec: 1, end_sec: 3, title: 'Orphan' },
  ] as any[]

  test('moves anchored cues and reports every move', () => {
    const result = reconcileAnchoredCues(cues, plan, subtitles)
    const a = result.cues.find(cue => cue.id === 'a')!
    assert.ok(a.start_sec > 1, `the word anchor must move it, got ${a.start_sec}`)
    // Length is the reviewer's decision and is preserved.
    assert.equal(Number((a.end_sec - a.start_sec).toFixed(3)), 3.5)
    assert.equal(result.moved.length, 2, 'both anchored cues moved; the orphan did not')
  })

  test('an orphaned cue is KEPT and reported, never dropped behind the customer', () => {
    const result = reconcileAnchoredCues(cues, plan, subtitles)
    assert.ok(result.cues.some(cue => cue.id === 'c'), 'the row still exists')
    assert.deepEqual(result.orphaned.map(cue => cue.id), ['c'])
  })

  test('a cue already at its anchor does not move, so a stable plan writes nothing', () => {
    const steady = [{ id: 'x', scene_id: 'scene-2', anchor_offset_sec: 2, start_sec: 22, end_sec: 25.5, title: 'Steady' }] as any[]
    const result = reconcileAnchoredCues(steady, plan, subtitles)
    assert.equal(result.moved.length, 0)
  })

  test('the same plan plus the same captions is idempotent', () => {
    const once = reconcileAnchoredCues(cues, plan, subtitles).cues
    const twice = reconcileAnchoredCues(once, plan, subtitles).cues
    assert.deepEqual(twice.map(cue => cue.start_sec), once.map(cue => cue.start_sec))
  })

  test('a v1 cue with no anchor keeps the seconds it was saved with', () => {
    const v1 = [{ id: 'v1', scene_id: 'scene-1', start_sec: 7.25, end_sec: 10, title: 'Legacy' }] as any[]
    const result = reconcileAnchoredCues(v1, plan, subtitles)
    assert.equal(result.cues[0]!.start_sec, 7.25, 'nothing rewrites a stored v1 time to compensate')
    assert.equal(result.moved.length, 0)
  })
})

describe('Both halves re-anchor from one read', () => {
  const labelTimeline: ContextualCueTimeline = {
    schema_version: 2, generated_at: 'now', source_scene_plan_generated_at: plan.generated_at,
    cues: [{ id: 'cue-scene-1', scene_id: 'scene-1', anchor_word: 'carved faces', start_sec: 0.15, end_sec: 3.65, title: 'Faces', kind: 'historical_context', placement: 'top-right', template: 'documentary-label', entrance: 'fade', exit: 'fade', status: 'approved', created_at: 'now', updated_at: 'now' }],
  }
  const soundTimeline: SoundDesignTimeline = {
    schema_version: 2, generated_at: 'now', source_scene_plan_generated_at: plan.generated_at,
    settings: { ...DEFAULT_SOUND_DESIGN_SETTINGS },
    cues: [{ id: 'sound-scene-1', kind: 'spot', label: 'bells', scene_id: 'scene-1', anchor_word: 'carved faces', start_sec: 0.15, clip: 'bells.wav', pool_id: 'sfx', source: 'pool', gain_db: -12, status: 'approved', created_at: 'now', updated_at: 'now' }],
  }

  test('a label and a sound on the same words land on the same second', () => {
    const labels = reanchorLabels(labelTimeline, plan, subtitles).timeline!
    const sounds = reanchorSounds(soundTimeline, plan, subtitles).timeline!
    assert.equal(labels.cues[0]!.start_sec, sounds.cues[0]!.start_sec)
    assert.ok(labels.cues[0]!.start_sec > 1)
  })

  test('the moves are described in the customer’s own words, not ids', () => {
    const labels = reanchorLabels(labelTimeline, plan, subtitles)
    const sounds = reanchorSounds(soundTimeline, plan, subtitles)
    const moves = {
      label: { moved: labels.moves.map(item => ({ id: item.cue.id, title: item.cue.title, from: item.from, to: item.to })), orphaned: [] },
      sound: { moved: sounds.moves.map(item => ({ id: item.cue.id, label: item.cue.label, from: item.from, to: item.to })), orphaned: [] },
    }
    assert.equal(hasAnchorMoves(moves), true)
    const lines = describeAnchorMoves(moves)
    assert.ok(lines.some(line => /Label "Faces" moved/.test(line)))
    assert.ok(lines.some(line => /Sound "bells" moved/.test(line)))
    assert.ok(!lines.some(line => line.includes('cue-scene-1')), 'internal ids are never shown')
  })

  test('nothing to move reports nothing', () => {
    assert.equal(hasAnchorMoves({ label: { moved: [], orphaned: [] }, sound: { moved: [], orphaned: [] } }), false)
  })
})

describe('anchorPhraseAt', () => {
  test('keeps a short, findable run of words and drops punctuation', () => {
    assert.equal(anchorPhraseAt('The temple, built in 967, still stands.'), 'The temple built in')
  })

  test('an empty text is an empty phrase, never a single space', () => {
    assert.equal(anchorPhraseAt('   '), '')
  })
})
