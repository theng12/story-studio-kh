import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUDIO_ASSEMBLY_POOLS,
  AUDIO_ASSEMBLY_STAGES,
  activeAudioAssemblyLayers,
  assembledNarrationDuration,
  audioAssemblyLayerId,
  expectedAudioAssemblyDuration,
} from '../contracts/audio-assembly.js'

test('Audio Assembly names its three stages in mixing order', () => {
  assert.deepEqual(AUDIO_ASSEMBLY_STAGES.map(stage => stage.stage), ['opening', 'narration', 'closing'])
})

test('all four pools exist, each optional pool has a channel folder, and none starts on', () => {
  assert.deepEqual(AUDIO_ASSEMBLY_POOLS.map(pool => pool.kind), ['music', 'ambience', 'effects', 'background_voice'])
  assert.equal(AUDIO_ASSEMBLY_POOLS.find(pool => pool.kind === 'music')!.folder, null)
  for (const kind of ['ambience', 'effects', 'background_voice'] as const) {
    assert.ok(AUDIO_ASSEMBLY_POOLS.find(pool => pool.kind === kind)!.folder)
  }
  for (const pool of AUDIO_ASSEMBLY_POOLS) assert.equal(pool.default_enabled, false)
})

test('the duration is shared arithmetic, and an unknown part is named rather than counted as zero', () => {
  const narration = assembledNarrationDuration({
    chapter_sec: 100, chapter_gap_sec: 6, chunk_pause_sec: 1.5, intro_clip_sec: 8, intro_gap_sec: 2,
  })
  assert.equal(narration.seconds, 117.5)
  assert.deepEqual(narration.unmeasured, [])

  const unknownIntro = assembledNarrationDuration({ chapter_sec: 100, intro_clip_sec: null, intro_gap_sec: 2 })
  assert.equal(unknownIntro.seconds, 102)
  assert.deepEqual(unknownIntro.unmeasured, ['intro clip length'])

  const full = expectedAudioAssemblyDuration({ narration_sec: 117.5, music_lead_in_sec: 8, closing_tail_sec: 5 })
  assert.equal(full.seconds, 130.5)
  assert.deepEqual(full.unmeasured, [])

  const noTail = expectedAudioAssemblyDuration({ narration_sec: 117.5, music_lead_in_sec: 8, closing_tail_sec: null })
  assert.equal(noTail.seconds, 125.5)
  assert.deepEqual(noTail.unmeasured, ['closing tail'])
})

test('a layer id is its pool and file, so a pick keeps its identity', () => {
  const first = audioAssemblyLayerId('ambience', '${PROJECT}/ambient/rain.mp3')
  assert.equal(first, audioAssemblyLayerId('ambience', '${PROJECT}/ambient/rain.mp3'))
  assert.notEqual(first, audioAssemblyLayerId('ambience', '${PROJECT}/ambient/fire.mp3'))
  assert.notEqual(first, audioAssemblyLayerId('effects', '${PROJECT}/ambient/rain.mp3'))
})

test('the ambience master switch drops its rows from the mix without deleting the picks', () => {
  const request = {
    ambience: { enabled: false },
    ambient_tracks: [{ id: 'a', source_path: '/rain.mp3', volume: 0.2, fade_in: 2, fade_out: 3 }],
    effects_tracks: [{ id: 'e', source_path: '/bell.mp3', volume: 0.1, fade_in: 0, fade_out: 0 }],
    background_voice_tracks: [
      { id: 'v1', source_path: '/crowd.mp3', volume: 0.05, fade_in: 1, fade_out: 1 },
      { id: 'v2', enabled: false, source_path: '/ignored.mp3', volume: 0.05, fade_in: 0, fade_out: 0 },
    ],
  }
  const active = activeAudioAssemblyLayers(request)
  assert.deepEqual(active.map(row => row.id), ['e', 'v1'])
  assert.deepEqual(active.map(row => row.kind), ['effects', 'background_voice'])
  // The rows are still in the request — the page keeps them for re-enabling.
  assert.equal(request.ambient_tracks.length, 1)

  const withAmbience = activeAudioAssemblyLayers({ ...request, ambience: { enabled: true } })
  assert.deepEqual(withAmbience.map(row => row.id), ['a', 'e', 'v1'])
})
