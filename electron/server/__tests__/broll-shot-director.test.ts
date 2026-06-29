/**
 * Tests for the scripted-broll shot director's pure pieces
 * (services/broll-shot-director.ts) — beat grouping, prompt, parse, mapping.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  cuesToBeats,
  buildShotPrompt,
  parseShotJson,
  shotJsonToPlan,
} from '../services/broll-shot-director.js'
import { planDrivesAssembly } from '../services/broll-plan.js'
import type { SrtCue } from '../lib/subtitle-builder.js'

const CUES: SrtCue[] = [
  { index: 1, start_sec: 0, end_sec: 2, text: 'Every morning' },
  { index: 2, start_sec: 2, end_sec: 4, text: 'millions stop for gas.' },
  { index: 3, start_sec: 4, end_sec: 6.5, text: 'But prices keep rising.' },
  { index: 4, start_sec: 6.5, end_sec: 8, text: 'Why?' },
]

describe('cuesToBeats', () => {
  test('groups consecutive cues into ~target-second beats', () => {
    const beats = cuesToBeats(CUES, 4)
    // first beat reaches 4s at cue 2; second beat collects the rest
    assert.equal(beats.length, 2)
    assert.equal(beats[0]!.start_sec, 0)
    assert.equal(beats[0]!.end_sec, 4)
    assert.equal(beats[0]!.line, 'Every morning millions stop for gas.')
    assert.equal(beats[1]!.line, 'But prices keep rising. Why?')
  })
  test('empty input → no beats', () => {
    assert.deepEqual(cuesToBeats([], 5), [])
  })
})

describe('buildShotPrompt', () => {
  test('lists indexed beats + asks for filmable queries + schema', () => {
    const beats = cuesToBeats(CUES, 4)
    const { system, user } = buildShotPrompt(beats, { style_hint: '1950s period' })
    assert.match(user, /\[0\] \(0\.0s–4\.0s\)/)
    assert.match(user, /There are 2 beats/)
    assert.match(system, /STOCK FOOTAGE/i)
    assert.match(system, /filmable/i)
    assert.match(system, /1950s period/)
    assert.match(user, /"queries"/)
  })
})

describe('parseShotJson', () => {
  test('handles fenced JSON', () => {
    const out = parseShotJson('```json\n{"beats":[{"index":0,"queries":["a","b"]}]}\n```')
    assert.equal(out.beats!.length, 1)
  })
  test('garbage → {}', () => {
    assert.deepEqual(parseShotJson('nope'), {})
  })
})

describe('shotJsonToPlan', () => {
  test('merges queries by index, leaves unresolved + render-safe', () => {
    const beats = cuesToBeats(CUES, 4)
    const plan = shotJsonToPlan(
      beats,
      { beats: [{ index: 0, queries: ['gas station morning', 'fuel pump', 'car at pump'] }] },
      { broll_style: 'muted 2D vector' },
    )
    assert.equal(plan.enabled, true)
    assert.equal(plan.broll_style, 'muted 2D vector')
    assert.deepEqual(plan.beats[0]!.queries, ['gas station morning', 'fuel pump', 'car at pump'])
    assert.equal(plan.beats[0]!.clip, '')
    assert.equal(plan.beats[0]!.status, 'proposed')
    assert.deepEqual(plan.beats[1]!.queries, []) // model skipped beat 1
    assert.equal(planDrivesAssembly(plan), false) // nothing resolved yet
  })
})
