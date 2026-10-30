import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TRANSITION_SETS, placeTransitionSounds, resolveTransitionSet, transitionClipKey, type TransitionClip } from '../services/transition-sounds.js'
import type { ScenePlan } from '../models/types.js'

const clips: TransitionClip[] = ['soft whoosh', 'bright whoosh', 'click'].map(label => ({ source: 'pool', pool_id: 'sounds', clip: `${label}.wav`, label, tags: [] }))
const plan = { generated_at: 'now', scenes: Array.from({ length: 16 }, (_, i) => ({ id: `scene-${i}`, start_sec: i * 5, end_sec: (i + 1) * 5 })) } as ScenePlan

test('sets resolve live, honour pins and exclusions, and report missing clips', () => {
  const set = { ...DEFAULT_TRANSITION_SETS[1]!, pinned: [{ ...clips[2]! }, { source: 'pool' as const, pool_id: 'sounds', clip: 'gone.wav', label: 'Gone' }], excluded: [transitionClipKey(clips[0]!)] }
  const result = resolveTransitionSet(set, clips)
  assert.deepEqual(result.clips.map(clip => clip.label).sort(), ['bright whoosh', 'click'])
  assert.deepEqual(result.missing, ['Gone'])
  assert.deepEqual(resolveTransitionSet(set, []).clips, [])
})

test('placements repeat, shuffle, avoid repeats, and follow moved scenes', () => {
  const first = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  assert.equal(first.length, 15)
  assert.deepEqual(first, placeTransitionSounds(plan, 'episode', 0, clips, -12))
  assert.notDeepEqual(first.map(cue => cue.clip), placeTransitionSounds(plan, 'episode', 1, clips, -12).map(cue => cue.clip))
  assert.ok(first.every((cue, i) => !i || cue.clip !== first[i - 1]!.clip))
  const moved = { ...plan, scenes: plan.scenes.map(scene => ({ ...scene, start_sec: scene.start_sec + 2, end_sec: scene.end_sec + 2 })) }
  assert.equal(placeTransitionSounds(moved, 'episode', 0, clips, -12)[0]!.start_sec, first[0]!.start_sec + 2)
  assert.deepEqual(placeTransitionSounds(plan, 'episode', 0, [], -12), [])
})
