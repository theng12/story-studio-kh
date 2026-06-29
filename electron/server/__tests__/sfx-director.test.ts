/**
 * Tests for the SFX director's pure pieces (services/sfx-director.ts) — no live
 * model. Covers prompt construction, tolerant JSON parsing, and the mapping to
 * an unresolved (render-safe) plan.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderTranscript,
  buildDirectorPrompt,
  parseDirectorJson,
  directorJsonToPlan,
} from '../services/sfx-director.js'
import { planAffectsRender } from '../services/sfx-plan.js'
import type { SrtCue } from '../lib/subtitle-builder.js'

const CUES: SrtCue[] = [
  { index: 1, start_sec: 0, end_sec: 4, text: 'Every morning millions stop for gas.' },
  { index: 2, start_sec: 4, end_sec: 9.5, text: 'And then the door slammed shut.' },
]

describe('prompt building', () => {
  test('user prompt carries the timed transcript + total duration + schema', () => {
    const { system, user } = buildDirectorPrompt(CUES, { intensity: 'moderate' })
    assert.match(user, /Total duration: 9\.5s/)
    assert.match(user, /\[0\.0s–4\.0s\] Every morning millions stop for gas\./)
    assert.match(user, /"beds"/)
    assert.match(user, /"spots"/)
    // sparseness instruction present in the system prompt
    assert.match(system, /sparse/i)
    assert.match(system, /Return ONLY a JSON object/)
  })

  test('visual hints are included when provided', () => {
    const { user } = buildDirectorPrompt(CUES, { visual_hints: [{ at_sec: 1, label: 'gas station at night' }] })
    assert.match(user, /On-screen visuals/)
    assert.match(user, /gas station at night/)
  })

  test('renderTranscript collapses whitespace', () => {
    const out = renderTranscript([{ index: 1, start_sec: 1, end_sec: 2, text: 'a\n  b   c' }])
    assert.equal(out, '[1.0s–2.0s] a b c')
  })
})

describe('tolerant JSON parse', () => {
  test('plain JSON', () => {
    assert.deepEqual(parseDirectorJson('{"beds":[],"spots":[]}'), { beds: [], spots: [] })
  })
  test('fenced JSON with prose preamble', () => {
    const raw = 'Sure!\n```json\n{ "beds": [], "spots": [{"label":"door slam","at_sec":7}] }\n```'
    const out = parseDirectorJson(raw)
    assert.equal(out.spots!.length, 1)
    assert.equal(out.spots![0].label, 'door slam')
  })
  test('garbage → empty object (never throws)', () => {
    assert.deepEqual(parseDirectorJson('no json here'), {})
    assert.deepEqual(parseDirectorJson(''), {})
  })
})

describe('directorJsonToPlan', () => {
  test('maps cues, clamps timestamps to [0,total], drops zero-length beds & label-less cues', () => {
    const plan = directorJsonToPlan(
      {
        beds: [
          { label: 'city night', start_sec: -5, end_sec: 999 }, // clamps to 0..total
          { label: 'zero', start_sec: 3, end_sec: 3 },          // dropped (no span)
          { label: '', start_sec: 0, end_sec: 2 },               // dropped (no label)
        ],
        spots: [
          { label: 'door slam', at_sec: 7 },
          { at_sec: 2 }, // dropped (no label)
        ],
      },
      9.5,
    )
    assert.equal(plan.beds.length, 1)
    assert.equal(plan.beds[0]!.start_sec, 0)
    assert.equal(plan.beds[0]!.end_sec, 9.5)
    assert.equal(plan.spots.length, 1)
    assert.equal(plan.spots[0]!.label, 'door slam')
  })

  test('proposed plan is UNRESOLVED — does not affect the render until clips are filled', () => {
    const plan = directorJsonToPlan({ spots: [{ label: 'door slam', at_sec: 7 }] }, 10)
    assert.equal(plan.enabled, true)
    assert.equal(plan.spots[0]!.source, '')      // unresolved
    assert.equal(plan.spots[0]!.clip, '')
    assert.equal(plan.spots[0]!.status, 'proposed')
    assert.equal(planAffectsRender(plan), false) // <-- the safety guarantee
  })

  test('empty/garbage parse → empty plan', () => {
    const plan = directorJsonToPlan({}, 10)
    assert.deepEqual(plan.beds, [])
    assert.deepEqual(plan.spots, [])
  })
})
