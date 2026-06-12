/**
 * v1.0.225 — scene-planner JSON salvage.
 *
 * A long episode's plan can exceed the model's output-token cap, truncating
 * the JSON mid-array. The planner used to silently discard the entire
 * response → "LLM returned no usable scenes". Now it salvages every COMPLETE
 * scene object that finished, so a truncated plan still yields usable scenes.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

let parsePlannerJson: (raw: string) => { scenes?: any[] }
let buildWindows: (cues: any[], windowSec: number) => Array<{ start: number; end: number; cues: any[] }>
let buildStorySoFar: (scenes: any[], live: boolean) => string

before(async () => {
  ;({ parsePlannerJson, buildWindows, buildStorySoFar } = await import('../services/scene-planner.js'))
})

const scene = (i: number) =>
  `{ "start_sec": ${i}, "end_sec": ${i + 4}, "transcript_segment": "line ${i}", "visual_prompt": "a shot, number ${i}, with {curly} and \\"quotes\\"", "boundary_reason": "beat" }`

describe('parsePlannerJson', () => {
  test('parses well-formed plan JSON', () => {
    const raw = `{ "scenes": [ ${scene(0)}, ${scene(4)} ] }`
    const r = parsePlannerJson(raw)
    assert.equal(r.scenes?.length, 2)
    assert.equal(r.scenes![0].start_sec, 0)
  })

  test('strips ```json fences', () => {
    const raw = '```json\n{ "scenes": [ ' + scene(0) + ' ] }\n```'
    assert.equal(parsePlannerJson(raw).scenes?.length, 1)
  })

  test('salvages complete scenes from a response truncated mid-object', () => {
    // 3 complete scenes, then a 4th cut off — and no closing ] or }.
    const raw = `{ "scenes": [ ${scene(0)}, ${scene(4)}, ${scene(8)}, { "start_sec": 12, "end_sec": 16, "visual_prompt": "the model ran out of tok`
    const r = parsePlannerJson(raw)
    assert.equal(r.scenes?.length, 3, 'should recover the 3 complete scenes')
    assert.equal(r.scenes![2].start_sec, 8)
  })

  test('curly braces / quotes inside prompt text do not fool the brace matcher', () => {
    const raw = `{ "scenes": [ { "start_sec": 0, "end_sec": 4, "visual_prompt": "nested {a:{b}} and a } brace" }, ${scene(4)}, { "start_sec": 8`
    const r = parsePlannerJson(raw)
    assert.equal(r.scenes?.length, 2)
    assert.ok(r.scenes![0].visual_prompt.includes('{a:{b}}'))
  })

  test('returns empty when there is nothing usable', () => {
    assert.deepEqual(parsePlannerJson('I cannot help with that.'), {})
    assert.deepEqual(parsePlannerJson(''), {})
  })
})

describe('buildWindows — chunked planning (v1.0.226)', () => {
  // Build N cues of 2s each, back-to-back from 0.
  const mkCues = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ start_sec: i * 2, end_sec: i * 2 + 2, text: `cue ${i}` }))

  test('splits a long timeline into multiple contiguous windows', () => {
    const cues = mkCues(150)               // 300s total
    const wins = buildWindows(cues, 60)    // ~60s windows
    assert.ok(wins.length >= 4, `expected several windows, got ${wins.length}`)
    // Contiguous + complete: every cue lands in exactly one window, in order.
    let count = 0
    let prevEnd = 0
    for (const w of wins) {
      assert.ok(w.start >= prevEnd - 0.001, 'windows must not overlap')
      assert.ok(w.cues.length > 0)
      count += w.cues.length
      prevEnd = w.end
    }
    assert.equal(count, 150, 'every cue assigned exactly once')
    assert.equal(wins[wins.length - 1]!.end, 300, 'last window reaches the end')
  })

  test('a short timeline yields a single window', () => {
    const wins = buildWindows(mkCues(10), 60) // 20s < 60s
    assert.equal(wins.length, 1)
    assert.equal(wins[0]!.cues.length, 10)
  })

  test('never splits a cue across windows', () => {
    const cues = mkCues(100)
    const wins = buildWindows(cues, 50)
    const allTexts = wins.flatMap(w => w.cues.map((c: any) => c.text))
    assert.equal(new Set(allTexts).size, 100, 'no cue duplicated or dropped')
  })

  test('empty cue list yields no windows', () => {
    assert.deepEqual(buildWindows([], 60), [])
  })
})

describe('buildStorySoFar — cross-segment continuity recap (v1.0.228)', () => {
  const mkScene = (i: number, vp: string) =>
    ({ start_sec: i * 4, end_sec: i * 4 + 4, visual_prompt: vp })

  test('carries the establishing shot + the last few scenes', () => {
    const scenes = Array.from({ length: 12 }, (_, i) => mkScene(i, `visual number ${i}`))
    const recap = buildStorySoFar(scenes, true)
    assert.match(recap, /Establishing shot.*visual number 0/, 'anchors to the first scene')
    assert.match(recap, /visual number 11/, 'includes the most recent scene')
    assert.doesNotMatch(recap, /visual number 3\b/, 'drops the middle (only last ~5 kept)')
  })

  test('uses selective-guide continuity wording for live (continuity-chain) mode', () => {
    const recap = buildStorySoFar([mkScene(0, 'a man in a grey hoodie at a desk')], true)
    // v1.0.336 — wording shifted from "SAME character" everywhere to a guide who
    // appears SELECTIVELY (only in character scenes).
    assert.match(recap, /SAME guide/i)
    assert.match(recap, /selectively/i)
  })

  test('uses general visual-consistency wording for non-live mode', () => {
    const recap = buildStorySoFar([mkScene(0, 'a wide desert vista')], false)
    assert.match(recap, /visual style/i)
    assert.doesNotMatch(recap, /SAME character/i)
  })

  test('ignores scenes with empty visual prompts and returns "" when none', () => {
    assert.equal(buildStorySoFar([{ start_sec: 0, end_sec: 4, visual_prompt: '' }], true), '')
  })
})
