import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SCENE_PACING,
  parseSavedScenePlanPacing,
  parseScenePacing,
  pacingBandAt,
} from '../contracts/pacing.js'

import { splitScenesBySentence } from '../services/scene-planner.js'
import { buildSentenceSidecar } from '../lib/sentence-timing.js'

test('sentence scenes require every chapter and use stitched episode offsets', () => {
  const chapters = { sections: [{ slug: 'a', duration_s: 4 }, { slug: 'b', duration_s: 3 }], gap_duration_s: 2 }
  const narration = [{ slug: 'a', text: 'Hi. A longer sentence.' }, { slug: 'b', text: 'Last sentence.' }]
  const sidecar = { schemaVersion: 1, ...buildSentenceSidecar(chapters.sections, narration) }
  const timeline = { complete: true, sections: [{ slug: 'a', duration_sec: 4, offset_sec: 5 }, { slug: 'b', duration_sec: 3, offset_sec: 11 }] }
  const input = { chapters, narration, sidecar, timeline, opening_sec: 0, idGen: (i: number) => String(i) }
  const scenes = splitScenesBySentence(input)
  assert.equal(scenes.length, 3)
  assert.deepEqual(scenes.map(s => s.transcript_segment), ['Hi.', 'A longer sentence.', 'Last sentence.'])
  assert.equal(scenes[2]!.start_sec, 11)
  assert.equal(scenes[1]!.end_sec, 11)
  assert.throws(() => splitScenesBySentence({ ...input, sidecar: null }), /audio_sentences.json is missing or invalid/)
  assert.throws(() => splitScenesBySentence({ ...input, sidecar: { ...sidecar, sections: sidecar.sections.slice(0, 1) } }), /missing one or more audio chapters/)
  assert.throws(() => splitScenesBySentence({ ...input, sidecar: { ...sidecar, sections: [{ ...sidecar.sections[0]!, sentences: sidecar.sections[0]!.sentences.slice(0, 1) }, sidecar.sections[1]!] } }), /incomplete/)
  assert.throws(() => splitScenesBySentence({ ...input, timeline: { ...timeline, sections: [timeline.sections[0]!, { ...timeline.sections[1]!, offset_sec: 10 }] } }), /chapter offset/)
})

test('sentence choice is opt-in and old rhythms remain unchanged', () => {
  assert.deepEqual(parseScenePacing({ min_sec: 4, max_sec: 8 }), { min_sec: 4, max_sec: 8 })
  assert.deepEqual(parseScenePacing({ min_sec: 4, max_sec: 8, one_scene_per_sentence: false }), { min_sec: 4, max_sec: 8 })
  assert.deepEqual(parseScenePacing({ min_sec: 4, max_sec: 8, one_scene_per_sentence: true }), { min_sec: 4, max_sec: 8, one_scene_per_sentence: true })
})

describe('scene pacing contract', () => {
  test('keeps the current 1–3 second uniform default and legacy uniform shape', () => {
    assert.deepEqual(DEFAULT_SCENE_PACING, { min_sec: 1, max_sec: 3 })
    assert.deepEqual(parseScenePacing(undefined), { min_sec: 1, max_sec: 3 })
    assert.deepEqual(parseScenePacing({ min_sec: 4, max_sec: 8 }), { min_sec: 4, max_sec: 8 })
  })

  test('normalizes three ordered periods and derives the compatibility band from period zero', () => {
    const pacing = parseScenePacing({
      mode: 'variable',
      min_sec: 50,
      max_sec: 60,
      periods: [
        { start_sec: 0, end_sec: 20, min_sec: 1, max_sec: 3 },
        { start_sec: 20, end_sec: 50, min_sec: 3, max_sec: 6 },
        { start_sec: 50, end_sec: null, min_sec: 6, max_sec: 12 },
      ],
    })

    assert.deepEqual(pacing, {
      mode: 'variable',
      min_sec: 1,
      max_sec: 3,
      periods: [
        { start_sec: 0, end_sec: 20, min_sec: 1, max_sec: 3 },
        { start_sec: 20, end_sec: 50, min_sec: 3, max_sec: 6 },
        { start_sec: 50, end_sec: null, min_sec: 6, max_sec: 12 },
      ],
    })
    assert.deepEqual(pacingBandAt(pacing, 49.999), { min_sec: 3, max_sec: 6 })
    assert.deepEqual(pacingBandAt(pacing, 50), { min_sec: 6, max_sec: 12 })
  })

  test('converts an explicit legacy opening/settled rhythm to two editable periods', () => {
    assert.deepEqual(parseScenePacing({
      min_sec: 2,
      max_sec: 4,
      opening_duration_sec: 30,
      settled_min_sec: 8,
      settled_max_sec: 12,
    }), {
      mode: 'variable',
      min_sec: 2,
      max_sec: 4,
      periods: [
        { start_sec: 0, end_sec: 30, min_sec: 2, max_sec: 4 },
        { start_sec: 30, end_sec: null, min_sec: 8, max_sec: 12 },
      ],
      opening_duration_sec: 30,
      settled_min_sec: 8,
      settled_max_sec: 12,
    })
  })

  test('normalizes an actual legacy documentary plan before timeline lookup', () => {
    const pacing = parseSavedScenePlanPacing({
      mode: 'documentary',
      min_sec: 2,
      max_sec: 4,
      opening_duration_sec: 30,
      settled_min_sec: 8,
      settled_max_sec: 12,
      periods: [
        { start_sec: 0, end_sec: 30, min_sec: 2, max_sec: 4 },
        { start_sec: 30, end_sec: null, min_sec: 8, max_sec: 12 },
      ],
    })

    assert.equal(pacing.mode, 'variable')
    assert.deepEqual(pacingBandAt(pacing, 29.999), { min_sec: 2, max_sec: 4 })
    assert.deepEqual(pacingBandAt(pacing, 30), { min_sec: 8, max_sec: 12 })
  })

  test('accepts the inclusive 1–60 second band boundaries', () => {
    assert.deepEqual(parseScenePacing({ min_sec: 1, max_sec: 60 }), { min_sec: 1, max_sec: 60 })
  })

  test('rejects malformed explicit state with a field-specific error', () => {
    assert.throws(
      () => parseScenePacing({ min_sec: 0, max_sec: 3 }),
      /pacing\.min_sec must be between 1 and 60 seconds/,
    )
    assert.throws(
      () => parseScenePacing({ min_sec: 3, max_sec: 61 }),
      /pacing\.max_sec must be between 1 and 60 seconds/,
    )
    assert.throws(
      () => parseScenePacing({ min_sec: 4, max_sec: 3 }),
      /pacing\.max_sec must be greater than or equal to pacing\.min_sec/,
    )
    assert.throws(
      () => parseScenePacing({ min_sec: 2, max_sec: 4, opening_duration_sec: 30 }),
      /legacy opening pacing must include opening_duration_sec, settled_min_sec, and settled_max_sec/,
    )
  })

  test('rejects variable gaps, overlaps, non-final to-end markers, and missing final to-end', () => {
    const period = (start_sec: number, end_sec: number | null) => ({
      start_sec, end_sec, min_sec: 1, max_sec: 3,
    })
    assert.throws(
      () => parseScenePacing({ mode: 'variable', periods: [period(0, 10), period(11, null)] }),
      /pacing\.periods\[1\]\.start_sec must equal the previous period's end_sec \(10\)/,
    )
    assert.throws(
      () => parseScenePacing({ mode: 'variable', periods: [period(0, 10), period(9, null)] }),
      /pacing\.periods\[1\]\.start_sec must equal the previous period's end_sec \(10\)/,
    )
    assert.throws(
      () => parseScenePacing({ mode: 'variable', periods: [period(0, null), period(10, null)] }),
      /only the final pacing period may use end_sec: null/,
    )
    assert.throws(
      () => parseScenePacing({ mode: 'variable', periods: [period(0, 10)] }),
      /final pacing period must use end_sec: null/,
    )
  })
})
