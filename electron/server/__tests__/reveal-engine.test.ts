/**
 * The reveal engine's own rules, tested without FFmpeg.
 *
 * Four things are load-bearing enough to be pinned here, and each of them is a
 * way an episode goes wrong silently rather than loudly:
 *
 *   1. **The chain arithmetic.** `xfade` advances the timeline by the
 *      right-hand input's whole length, so a plan whose durations are even
 *      slightly wrong produces a clip that is shorter than the timeline
 *      allocated it — narration drifts against the picture scenes later.
 *   2. **Determinism.** Same seed, same plan, byte for byte. This project's
 *      method depends on same-input-same-output, and a reroll of one scene must
 *      not resequence the rest.
 *   3. **The randomisation rules** — no immediate repeats, a cap per effect,
 *      coherence modes, and duration never randomised.
 *   4. **The graph is closed**: every label an FFmpeg filter references is
 *      produced exactly once. An unclosed label fails at render time, after the
 *      images have been generated — the most expensive place to find a typo.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultSceneReveal,
  mergeSceneReveal,
  normalizeSceneReveal,
  resolveRevealTiming,
} from '../contracts/scene-reveal.js'
import {
  BUILT_IN_SCENE_REVEALS,
  DEFAULT_REVEAL_POOL,
  builtInReveal,
} from '../contracts/scene-reveal-presets.js'
import {
  assertStagesAdvance,
  compileSceneReveal,
  ffmpegColour,
  planRevealStages,
} from '../lib/reveal-compiler.js'
import { REVEAL_PACES, paceSettings, planSceneHold } from '../lib/reveal-pacing.js'
import { planEpisodeReveals, rerollSceneReveal } from '../lib/reveal-selection.js'

const TIMING = {
  reveal_seconds: 1.2,
  hold_seconds: 6.8,
  total_seconds: 8,
  micro_event_offsets: [4.0],
  source: 'preset' as const,
}

const COMPILE_OPTS = { w: 1280, h: 720, fps: 24, timing: TIMING }

describe('reveal chain arithmetic', () => {
  test('a wipe with no layers is two stages, and the field only lasts the transition', () => {
    const doc = builtInReveal('reveal-rows')!.document
    const stages = planRevealStages(doc, TIMING)
    assert.equal(stages.length, 3, 'field, picture, one micro-event tint')
    const [field, picture, tint] = stages as [typeof stages[0], typeof stages[0], typeof stages[0]]
    assert.equal(field.kind, 'field')
    assert.equal(field.segment, TIMING.reveal_seconds, 'the field is alone for the whole arrival')
    assert.equal(field.duration, TIMING.reveal_seconds)
    assert.equal(picture.kind, 'picture')
    assert.equal(picture.offset, 0, 'with no layers the picture arrives from t=0')
    assert.equal(picture.duration, TIMING.reveal_seconds)
    // The picture's stream runs from its own transition to the end of the NEXT
    // one — the micro-event's — because that is the arithmetic FFmpeg counts.
    assert.equal(picture.segment, tint.offset + tint.duration)
    assert.equal(tint.kind, 'tint')
    assert.equal(tint.segment, TIMING.total_seconds - tint.offset, 'the last stage carries the rest')
  })

  test('palette layers divide the reveal window and the picture keeps the hold', () => {
    const doc = builtInReveal('reveal-palette-dawn')!.document
    const timing = { ...TIMING, reveal_seconds: 2, hold_seconds: 6, total_seconds: 8, micro_event_offsets: [] }
    const stages = planRevealStages(doc, timing)
    const layers = stages.filter(stage => stage.kind === 'layer')
    assert.equal(layers.length, 2, 'the Dawn preset is two layers')
    // The reveal window is the sum of every TRANSITION's length: each layer's,
    // plus the picture's own — a picture with no transition would just appear.
    const revealWindow = [...layers, stages.find(stage => stage.kind === 'picture')!]
      .reduce((sum, stage) => sum + stage.duration, 0)
    assert.ok(Math.abs(revealWindow - 2) < 0.002, `reveal window is ${revealWindow}s, expected 2s`)
    // And a stage's stream runs until the next transition finishes, because
    // that is what `xfade` counts.
    for (const stage of layers) {
      const next = stages[stages.findIndex(candidate => candidate.offset > stage.offset)]!
      assert.ok(Math.abs(stage.segment - (next.offset + next.duration - stage.offset)) < 0.002,
        `${stage.kind} at ${stage.offset}s has a ${stage.segment}s stream`)
    }
    const picture = stages.find(stage => stage.kind === 'picture')!
    assert.ok(picture.offset > 0, 'the picture arrives after the layers')
    assert.ok(picture.duration > 0, 'and it has a transition of its own')
    assert.ok(Math.abs(picture.segment - (timing.total_seconds - picture.offset)) < 0.002)
  })

  test('an overlapping or over-long plan is refused by name', () => {
    assert.throws(
      () => assertStagesAdvance([
        { kind: 'field', transition: '', duration: 1, segment: 1, offset: 0 },
        { kind: 'picture', transition: 'wipe-left', duration: 1, segment: 3, offset: 0 },
        // A micro-event beginning inside the picture's own transition.
        { kind: 'tint', transition: 'fade', duration: 0.6, segment: 2, offset: 0.5 },
      ], 4),
      /overlapping transitions/,
    )
    assert.throws(
      () => assertStagesAdvance([
        { kind: 'field', transition: '', duration: 4, segment: 4, offset: 0 },
        { kind: 'picture', transition: 'wipe-left', duration: 3, segment: 3, offset: 4 },
      ], 5),
      /trimmed mid-transition/,
    )
    // And a chain that ends short of its window is refused too: `xfade` would
    // happily produce a shorter clip, and the timeline would not know.
    assert.throws(
      () => assertStagesAdvance([
        { kind: 'field', transition: '', duration: 1, segment: 1, offset: 0 },
        { kind: 'picture', transition: 'wipe-left', duration: 1, segment: 2.5, offset: 1 },
      ], 6),
      /short of its window/,
    )
  })

  test('durations are milliseconds, so two compiles are identical strings', () => {
    const doc = builtInReveal('reveal-palette-ember')!.document
    const timing = { ...TIMING, reveal_seconds: 1.333333, hold_seconds: 5.666, total_seconds: 7 }
    const first = compileSceneReveal(doc, { ...COMPILE_OPTS, timing })
    const second = compileSceneReveal(doc, { ...COMPILE_OPTS, timing })
    assert.deepEqual(first.filters, second.filters)
    // The reveal's own numbers are milliseconds. (`zoompan`'s ramp term prints
    // ten decimals on purpose — it is a per-frame increment, and its bytes are
    // pinned by the effect-registry goldens, so it is not this test's business.)
    for (const filter of first.filters) {
      for (const match of filter.matchAll(/(?:duration|offset)=([0-9.]+)/g)) {
        assert.ok(/^\d+(\.\d{1,3})?$/.test(match[1]!),
          `unrounded duration/offset ${match[1]} in: ${filter}`)
      }
    }
  })
})

describe('the compiled graph', () => {
  test('an xfade chain out of a colour field, plus the drift', () => {
    const doc = builtInReveal('reveal-rows')!.document
    const compiled = compileSceneReveal(doc, COMPILE_OPTS)
    const graph = compiled.filters.join(';')
    assert.match(graph, /color=c=0x0b0d10:s=1280x720:r=24:d=1\.2/)
    assert.match(graph, /xfade=transition=hlslice:duration=1\.2:offset=0/)
    assert.match(graph, /zoompan=/, 'the hold drifts through the still-camera engine')
    assert.ok(graph.trim().endsWith('[vout]'), graph.slice(-40))
  })

  test('every label is produced exactly once, and none is left unclosed', () => {
    for (const preset of BUILT_IN_SCENE_REVEALS) {
      const compiled = compileSceneReveal(preset.document, COMPILE_OPTS)
      const produced = new Set<string>()
      const consumed = new Set<string>()
      // Parse by statement, not by character: leading labels are the filter's
      // INPUTS, and every label after the filter name is an output (one for
      // most filters, N for `split`).
      for (const statement of compiled.filters.join(';').split(';')) {
        const leading = /^((?:\[[^\]]+\])+)?(.*)$/s.exec(statement)!
        const inputs = [...(leading[1] ?? '').matchAll(/\[([^\]]+)\]/g)].map(match => match[1]!)
        const outputs = [...leading[2]!.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]!)
        for (const name of outputs) {
          assert.ok(!produced.has(name), `${preset.id}: label [${name}] produced twice`)
          produced.add(name)
        }
        for (const name of inputs) {
          if (name !== '0:v') consumed.add(name)
        }
      }
      for (const name of consumed) {
        assert.ok(produced.has(name), `${preset.id}: [${name}] is consumed but never produced`)
      }
      assert.ok(produced.has(compiled.output), `${preset.id}: no ${compiled.output}`)
    }
  })

  test('the field colour is an FFmpeg literal, not a CSS hex', () => {
    assert.equal(ffmpegColour('#0B0D10'), '0x0b0d10')
    assert.ok(!compileSceneReveal(builtInReveal('reveal-centre')!.document, COMPILE_OPTS)
      .filters.join(';').includes('#0b0d10'))
  })

  test('an unsupported non-empty transition throws before FFmpeg', () => {
    const doc = mergeSceneReveal(defaultSceneReveal(), { transition: 'not-a-real-transition' })
    assert.throws(
      () => compileSceneReveal(doc, COMPILE_OPTS),
      /unsupported transition 'not-a-real-transition'/,
    )
  })

  test('a preset whose document.transition is a raw xfade keyword compiles that keyword, not fade', () => {
    // Presets store raw xfade keywords (`diagtl`); the registry uses kebab-case ids (`diag-tl`).
    const doc = builtInReveal('reveal-draw-on')!.document
    assert.equal(doc.transition, 'diagtl')
    const graph = compileSceneReveal(doc, COMPILE_OPTS).filters.join(';')
    assert.match(graph, /xfade=transition=diagtl:/)
  })

  test('palette layers with raw xfade keywords compile their own transitions', () => {
    const doc = builtInReveal('reveal-palette-dawn')!.document
    const graph = compileSceneReveal(doc, { ...COMPILE_OPTS, timing: {
      ...TIMING, reveal_seconds: 2, hold_seconds: 6, total_seconds: 8, micro_event_offsets: [],
    } }).filters.join(';')
    assert.match(graph, /xfade=transition=wipeup:/)
    assert.match(graph, /xfade=transition=diagtr:/)
  })

  test('a lights-up reveal takes its field from the picture itself', () => {
    const doc = builtInReveal('reveal-lights-up')!.document
    const graph = compileSceneReveal(doc, COMPILE_OPTS).filters.join(';')
    assert.match(graph, /\[fieldsrc\]scale=1280:720/)
    assert.match(graph, /eq=brightness=-/)
    assert.match(graph, /tpad=stop_mode=clone/)
    assert.ok(!graph.includes('color=c=0x000000'), 'no flat colour field for an image field')
  })
})

describe('reveal timing', () => {
  test('fit-to-narration takes a share of the line and clamps to its band', () => {
    const doc = builtInReveal('reveal-rows')!.document
    const short = resolveRevealTiming(doc, { window_seconds: 8, narration_seconds: 2 })
    assert.equal(short.reveal_seconds, 0.8, '40% of a 2 s line')
    // A long line does NOT stretch the arrival: the pace chose that length.
    const long = resolveRevealTiming(doc, { window_seconds: 20, narration_seconds: 30 })
    assert.equal(long.reveal_seconds, doc.timing.seconds, 'the pace sets the norm')
    // And a long line still cannot be all entrance.
    assert.ok(long.hold_seconds >= 0.2)
  })

  test('a scene is never all entrance', () => {
    const doc = builtInReveal('reveal-rows')!.document
    const resolved = resolveRevealTiming(doc, { window_seconds: 1.4 })
    assert.ok(resolved.reveal_seconds <= 0.7 + 0.001, 'at most half the window')
    assert.ok(resolved.hold_seconds >= 0.2)
  })

  test('the hold drifts, and the contract keeps it in the 3–8% band', () => {
    const tooStill = normalizeSceneReveal({ ...defaultSceneReveal(), hold: { drift_pct: 0 } })
    assert.equal(tooStill.hold.drift_pct, 3, 'a freeze is not a hold')
    const tooFast = normalizeSceneReveal({ ...defaultSceneReveal(), hold: { drift_pct: 40 } })
    assert.equal(tooFast.hold.drift_pct, 8)
  })
})

describe('pacing', () => {
  test('every pace lands inside its own band, and Slow holds longer than Fast', () => {
    for (const pace of REVEAL_PACES) {
      const settings = paceSettings(pace)
      // No narration here: a long line deliberately overrides the band, and that
      // is asserted on its own below.
      const plan = planSceneHold({ pace, window_seconds: 100 })
      assert.ok(plan.total_seconds >= settings.min_total_seconds - 0.001, `${pace} below its floor`)
      assert.ok(plan.total_seconds <= settings.max_total_seconds + 0.001, `${pace} above its ceiling`)
      assert.ok(plan.reveal_seconds >= 0.4)
      assert.ok(plan.hold_seconds > 0.2)
    }
    const fast = planSceneHold({ pace: 'fast', window_seconds: 100 })
    const slow = planSceneHold({ pace: 'slow', window_seconds: 100 })
    assert.ok(slow.hold_seconds > fast.hold_seconds, 'the image-count saving is in Slow')
  })

  test('a narration line longer than the band wins', () => {
    const plan = planSceneHold({ pace: 'fast', window_seconds: 30, narration_seconds: 9 })
    assert.ok(plan.total_seconds >= 9, `a 9 s line cannot be cut to ${plan.total_seconds}s`)
  })

  test('the hold snaps to a narration line, but only when it is nearly there', () => {
    const near = planSceneHold({
      pace: 'slow', window_seconds: 11.2, snap: { narration_line_ends: [11.0] },
    })
    assert.equal(near.snapped_to, 'narration-line')
    assert.equal(near.total_seconds, 11)

    const far = planSceneHold({
      pace: 'slow', window_seconds: 11.2, snap: { narration_line_ends: [13.9] },
    })
    assert.notEqual(far.snapped_to, 'narration-line', 'a line 2.7 s away is not the same moment')
  })

  test('micro-events are staged inside the hold, never in the arrival', () => {
    const plan = planSceneHold({ pace: 'documentary', window_seconds: 14, narration_seconds: 12 })
    assert.ok(plan.micro_event_offsets.length >= 1, 'Documentary stages events')
    for (const at of plan.micro_event_offsets) {
      assert.ok(at > plan.reveal_seconds, `an event at ${at}s lands during the arrival`)
      assert.ok(at < plan.total_seconds - 0.2, `an event at ${at}s lands past the clip`)
    }
    const sorted = [...plan.micro_event_offsets].sort((a, b) => a - b)
    assert.deepEqual(plan.micro_event_offsets, sorted, 'events are in order')
  })

  test('a preset that wants no micro-events stays quiet at the busiest pace', () => {
    const plan = planSceneHold({
      pace: 'documentary', window_seconds: 16,
      doc: builtInReveal('reveal-draw-on')!.document,
    })
    assert.deepEqual(plan.micro_event_offsets, [])
  })
})

describe('randomisation rules', () => {
  const scenes = Array.from({ length: 12 }, (_, index) => ({
    scene_id: `scene-${index + 1}`,
    scene_index: index,
    act_index: Math.floor(index / 4),
  }))

  test('same seed, same plan — twice, and byte for byte', () => {
    const first = planEpisodeReveals({ scenes, seed: 1234, coherence: 'scene' })
    const second = planEpisodeReveals({ scenes, seed: 1234, coherence: 'scene' })
    assert.deepEqual(first, second)
  })

  test('no immediate repeats, and every pick comes from the pool', () => {
    const plan = planEpisodeReveals({ scenes, seed: 99, coherence: 'scene' })
    for (let i = 1; i < plan.length; i++) {
      assert.notEqual(plan[i]!.preset_id, plan[i - 1]!.preset_id, `scene ${i + 1} repeats its neighbour`)
    }
    for (const entry of plan) {
      assert.ok(DEFAULT_REVEAL_POOL.includes(entry.preset_id), `${entry.preset_id} is not in the pool`)
    }
  })

  test('a cap per effect is honoured', () => {
    const plan = planEpisodeReveals({ scenes, seed: 7, coherence: 'scene', cap_per_effect: 1 })
    const counts = new Map<string, number>()
    for (const entry of plan) counts.set(entry.preset_id, (counts.get(entry.preset_id) ?? 0) + 1)
    // Six presets, twelve scenes, cap 1: two passes, two uses each, and the
    // second pass is reported rather than silent.
    assert.equal(counts.size, DEFAULT_REVEAL_POOL.length, 'every pool entry gets its turn')
    for (const [id, count] of counts) {
      assert.equal(count, 2, `${id} used ${count} times under a cap of 1 per pass`)
    }
    assert.ok(plan.some(entry => entry.capped_around), 'the new pass is reported')
    for (let i = 1; i < plan.length; i++) {
      assert.notEqual(plan[i]!.preset_id, plan[i - 1]!.preset_id,
        'a new pass still may not repeat its neighbour')
    }
  })

  test('per-scene derivation: one scene rerolled leaves the others alone', () => {
    const before = planEpisodeReveals({ scenes, seed: 4242, coherence: 'scene' })
    const reroll = rerollSceneReveal({
      scenes, seed: 4242, coherence: 'scene', scene_id: 'scene-5', current_preset_id: before[4]!.preset_id,
    })
    assert.ok(reroll, 'a reroll returns a choice')
    assert.notEqual(reroll!.preset_id, before[4]!.preset_id, 'and it is a different one')
    const after = planEpisodeReveals({
      scenes, seed: 4242, coherence: 'scene',
      overrides: [{ scene_id: 'scene-5', preset_id: reroll!.preset_id, reroll: 1 }],
    })
    assert.equal(after[4]!.preset_id, reroll!.preset_id)
    for (const index of [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11]) {
      assert.equal(after[index]!.preset_id, before[index]!.preset_id,
        `scene ${index + 1} moved when scene 5 was rerolled`)
    }
  })

  test('an override wins, and is marked as stored rather than derived', () => {
    const plan = planEpisodeReveals({
      scenes, seed: 5, coherence: 'scene',
      overrides: [{ scene_id: 'scene-3', preset_id: 'reveal-radial' }],
    })
    assert.equal(plan[2]!.preset_id, 'reveal-radial')
    assert.equal(plan[2]!.source, 'override')
    assert.equal(plan[1]!.source, 'derived')
  })

  test('coherence: one look per episode, and one per act', () => {
    const fixed = planEpisodeReveals({ scenes, seed: 11, coherence: 'episode' })
    assert.equal(new Set(fixed.map(entry => entry.preset_id)).size, 1, 'one effect for the episode')

    const perAct = planEpisodeReveals({ scenes, seed: 11, coherence: 'act' })
    const acts = new Map<number, Set<string>>()
    for (const [index, entry] of perAct.entries()) {
      const act = Math.floor(index / 4)
      if (!acts.has(act)) acts.set(act, new Set())
      acts.get(act)!.add(entry.preset_id)
    }
    for (const [act, ids] of acts) {
      assert.equal(ids.size, 1, `act ${act} changed look mid-act: ${[...ids].join(', ')}`)
    }
    assert.ok(new Set([...acts.values()].map(set => [...set][0])).size > 1,
      'acts are allowed to differ, or the mode is just `fixed`')
  })

  test('an empty pool falls back to the default reveal rather than failing', () => {
    const plan = planEpisodeReveals({ scenes: scenes.slice(0, 2), seed: 1, coherence: 'scene', pool: { ids: [] } })
    assert.equal(plan.length, 2)
    for (const entry of plan) assert.ok(entry.preset_id)
  })
})
