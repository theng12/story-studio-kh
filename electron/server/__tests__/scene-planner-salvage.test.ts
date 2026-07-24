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
let assignDensityToUntagged: (scenes: any[], density: number) => void
let splitScenesDeterministically: (opts: any) => any[]
let splitCueForStrictVisualPacing: (cue: any, maxSec: number) => any[]
let repairOverlongScenesDeterministically: (opts: any) => any

before(async () => {
  ;({ parsePlannerJson, buildWindows, buildStorySoFar, assignDensityToUntagged, splitScenesDeterministically, splitCueForStrictVisualPacing, repairOverlongScenesDeterministically } = await import('../services/scene-planner.js'))
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

describe('strict continuity pacing', () => {
  const longCue = {
    index: 1,
    start_sec: 0,
    end_sec: 6.4,
    text: 'A storm gathered over the dark sea while the crew watched the horizon.',
  }

  test('splits an over-long subtitle cue at word boundaries and preserves timing coverage', () => {
    const pieces = splitCueForStrictVisualPacing(longCue, 4)
    assert.equal(pieces.length, 2)
    assert.equal(pieces[0]!.start_sec, 0)
    assert.equal(pieces[pieces.length - 1]!.end_sec, 6.4)
    assert.ok(pieces.every(piece => piece.end_sec - piece.start_sec <= 4.0001))
    assert.equal(pieces.map(piece => piece.text).join(' '), longCue.text)
    assert.ok(pieces[0]!.text.endsWith('sea'), 'the nearest safe word boundary is used')
  })

  test('makes the selected maximum strict in the deterministic timeline', () => {
    const scenes = splitScenesDeterministically({
      cues: [longCue], min_sec: 1, max_sec: 4, target_sec: 2.5,
    })
    assert.ok(scenes.every(scene => scene.end_sec - scene.start_sec <= 4.0001))
    assert.equal(scenes.map(scene => scene.transcript_segment).join(' '), longCue.text)
  })

  test('does not cut a one-word cue mid-word merely to meet the maximum', () => {
    const pieces = splitCueForStrictVisualPacing({ index: 1, start_sec: 0, end_sec: 6, text: 'Thunderclap' }, 4)
    assert.equal(pieces.length, 1)
    assert.equal(pieces[0]!.text, 'Thunderclap')
  })

  test('repairs an existing out-of-range scene that contains one long subtitle cue', () => {
    const repaired = repairOverlongScenesDeterministically({
      scenes: [{ id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6.4, transcript_segment: longCue.text, visual_prompt: 'existing prompt' }],
      cues: [longCue], threshold_sec: 4, min_sec: 1, max_sec: 4,
    })
    assert.equal(repaired.repairedCount, 1)
    assert.equal(repaired.scenes.length, 2)
    assert.ok(repaired.scenes.every((scene: any) => scene.end_sec - scene.start_sec <= 4.0001))
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

describe('assignDensityToUntagged — guide cast density (v1.0.337)', () => {
  const mkScenes = (n: number): any[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, scene_index: i + 1 }))
  const count = (scenes: any[], t: string): number => scenes.filter(s => s.scene_type === t).length

  test('0% → no character scenes; every scene is a non-character type', () => {
    const scenes = mkScenes(12)
    assignDensityToUntagged(scenes, 0)
    assert.equal(count(scenes, 'character'), 0)
    assert.ok(scenes.every(s => ['event', 'environment', 'map', 'artifact'].includes(s.scene_type)))
  })

  test('100% → every scene is a character scene', () => {
    const scenes = mkScenes(12)
    assignDensityToUntagged(scenes, 100)
    assert.equal(count(scenes, 'character'), 12)
  })

  test('40% → roughly 40% character, scattered (no 3-in-a-row clusters)', () => {
    const scenes = mkScenes(20)
    assignDensityToUntagged(scenes, 40)
    assert.equal(count(scenes, 'character'), 8, '40% of 20 = 8 character scenes')
    // even-spread accumulator never places 3 character scenes back-to-back
    let run = 0
    for (const s of scenes) {
      run = s.scene_type === 'character' ? run + 1 : 0
      assert.ok(run < 3, 'character scenes should be scattered, not clustered')
    }
  })

  test('leaves already-tagged scenes untouched (single-pass LLM / user override)', () => {
    const scenes: any[] = [
      { id: 'a', scene_type: 'event' },
      { id: 'b' },                       // untagged
      { id: 'c', scene_type: 'character' },
    ]
    assignDensityToUntagged(scenes, 100)
    assert.equal(scenes[0].scene_type, 'event', 'pre-tagged event kept despite 100% density')
    assert.equal(scenes[2].scene_type, 'character')
    assert.equal(scenes[1].scene_type, 'character', 'only the untagged scene was assigned')
  })
})
