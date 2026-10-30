import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TRANSITION_SETS, effectiveTransitionSettings, placeTransitionSounds, resolveTransitionSet, transitionClipKey, type TransitionClip } from '../services/transition-sounds.js'
import type { ScenePlan } from '../models/types.js'

const clips: TransitionClip[] = ['soft whoosh', 'bright whoosh', 'click'].map(label => ({ source: 'pool', pool_id: 'sounds', clip: `${label}.wav`, label, tags: [] }))
const plan = { generated_at: 'now', scenes: Array.from({ length: 16 }, (_, i) => ({ id: `scene-${i}`, start_sec: i * 5, end_sec: (i + 1) * 5 })) } as ScenePlan

test('episodes inherit channel settings unless they explicitly override them', () => {
  assert.equal(effectiveTransitionSettings(undefined, undefined).enabled, false)
  assert.deepEqual(effectiveTransitionSettings({ enabled: true, set_id: 'whooshes', gain_db: -18 }, undefined), { enabled: true, set_id: 'whooshes', gain_db: -18 })
  assert.deepEqual(effectiveTransitionSettings({ enabled: true, set_id: 'mixed' }, { enabled: false, set_id: 'paper-pencil' }), { enabled: false, set_id: 'paper-pencil', gain_db: -12 })
})

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

test('empty set returns no cues and reports empty', () => {
  const emptySet = { ...DEFAULT_TRANSITION_SETS[0]!, terms: ['nonexistent-term-xyz'] }
  const resolved = resolveTransitionSet(emptySet, [])
  assert.deepEqual(resolved.clips, [])
  assert.deepEqual(placeTransitionSounds(plan, 'episode', 0, resolved.clips, -12), [])
})

test('pinned missing clip is reported by name, not silently substituted', () => {
  const missingClip = { source: 'pool' as const, pool_id: 'sounds', clip: 'missing.wav', label: 'Missing Clip' }
  const set = { ...DEFAULT_TRANSITION_SETS[0]!, pinned: [missingClip] }
  const resolved = resolveTransitionSet(set, clips)
  assert.ok(resolved.missing.includes('Missing Clip'))
  assert.ok(!resolved.clips.some(c => c.clip === 'missing.wav'))
})

test('credits include transition cues when placed', () => {
  const creditedClip: TransitionClip = {
    source: 'gateway', clip: 'abc123', label: 'Test Sound', tags: [],
    credit: { title: 'Test Sound', author: 'Test Author', licence: 'CC-BY', licence_version: '4.0', source_url: 'https://example.com' }
  }
  const placed = placeTransitionSounds(plan, 'episode', 0, [creditedClip, clips[0]!], -12)
  assert.ok(placed.some(cue => cue.credit?.title === 'Test Sound'))
  assert.ok(placed.every(cue => cue.status === 'approved'))
})

test('transition cues have deterministic IDs for re-run isolation', () => {
  const first = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  const second = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  assert.deepEqual(first.map(c => c.id), second.map(c => c.id))
  assert.ok(first.every(cue => cue.id.startsWith('transition:')))
})

test('transition cues are stored separately from scene SFX by ID prefix', () => {
  const placed = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  assert.ok(placed.every(cue => cue.id.startsWith('transition:')))
  assert.ok(placed.every(cue => cue.kind === 'spot'))
  assert.ok(placed.every(cue => cue.scene_id))
})

test('channel-level change does not rewrite episode override', () => {
  const channelSettings = { enabled: true, set_id: 'mixed', gain_db: -18 }
  const episodeOverride = { enabled: false, set_id: 'whooshes', gain_db: -12 }
  const effective = effectiveTransitionSettings(channelSettings, episodeOverride)
  assert.deepEqual(effective, episodeOverride)
  const channelChange = { enabled: false, set_id: 'paper-pencil', gain_db: -15 }
  const stillEpisodeOverride = effectiveTransitionSettings(channelChange, episodeOverride)
  assert.deepEqual(stillEpisodeOverride, episodeOverride)
})

test('transition cues merge with regular sound design cues for mixing', () => {
  const transitionCues = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  const regularCue = {
    id: 'sfx:scene-0', kind: 'spot' as const, label: 'Regular SFX', scene_id: 'scene-0',
    anchor_offset_sec: 0, start_sec: 0, source: 'pool' as const, pool_id: 'sounds',
    clip: 'regular.wav', gain_db: -10, status: 'approved' as const,
    created_at: '', updated_at: ''
  }
  const merged = [regularCue, ...transitionCues]
  assert.equal(merged.length, 16)
  assert.equal(merged.filter(c => c.id.startsWith('transition:')).length, 15)
  assert.equal(merged.filter(c => c.id.startsWith('sfx:')).length, 1)
})

test('empty clips array returns no cues without error', () => {
  const placed = placeTransitionSounds(plan, 'episode', 0, [], -12)
  assert.deepEqual(placed, [])
  assert.equal(placed.length, 0)
})

test('transition cues do not interfere with scene SFX IDs', () => {
  const transitionCues = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  const sfxCues = plan.scenes.slice(0, 3).map(scene => ({
    id: `sfx:${scene.id}`, kind: 'spot' as const, label: 'Scene SFX', scene_id: scene.id,
    anchor_offset_sec: 0, start_sec: scene.start_sec, source: 'pool' as const,
    pool_id: 'sounds', clip: 'sfx.wav', gain_db: -10, status: 'approved' as const,
    created_at: '', updated_at: ''
  }))
  const allIds = [...sfxCues, ...transitionCues].map(c => c.id)
  const uniqueIds = new Set(allIds)
  assert.equal(uniqueIds.size, allIds.length)
})

test('transition placement handles single-scene episode gracefully', () => {
  const singleScene = { generated_at: 'now', scenes: [{ id: 'scene-0', start_sec: 0, end_sec: 10 }] } as ScenePlan
  const placed = placeTransitionSounds(singleScene, 'episode', 0, clips, -12)
  assert.equal(placed.length, 0)
})

test('shuffle seed produces different selections for same episode', () => {
  const shuffle0 = placeTransitionSounds(plan, 'episode', 0, clips, -12)
  const shuffle1 = placeTransitionSounds(plan, 'episode', 1, clips, -12)
  const shuffle2 = placeTransitionSounds(plan, 'episode', 2, clips, -12)
  assert.notDeepEqual(shuffle0.map(c => c.clip), shuffle1.map(c => c.clip))
  assert.notDeepEqual(shuffle1.map(c => c.clip), shuffle2.map(c => c.clip))
})

test('a clip tagged sfx stays out of a cut pool unless it is pinned, and a clip tagged transition joins Mixed', () => {
  const library: TransitionClip[] = [
    { source: 'gateway', clip: 'a', label: 'A pencil writing fast on paper', tags: ['sfx', 'pencil'] },
    { source: 'gateway', clip: 'b', label: 'A tape measure lock', tags: ['transition'] },
  ]
  const mixed = DEFAULT_TRANSITION_SETS.find(set => set.id === 'mixed')!
  assert.deepEqual(resolveTransitionSet(mixed, library).clips.map(clip => clip.clip), ['b'])
  const pinned = { ...mixed, pinned: [{ source: 'gateway' as const, clip: 'a', label: 'pinned' }] }
  assert.deepEqual(resolveTransitionSet(pinned, library).clips.map(clip => clip.clip), ['a', 'b'])
})
