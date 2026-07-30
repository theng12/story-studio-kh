import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assignSceneMotionProfile, preferredMotionMode } from '../services/scene-motion-profile.js'
import type { SceneMotionProfile, ScenePlanEntry } from '../models/types.js'

const profile: SceneMotionProfile = {
  id: 'ambient-documentary',
  label: 'Ambient documentary',
  description: 'Test fixture',
  opening_duration_sec: 900,
  opening: { still: 20, gentle: 55, limited: 25 },
  settled: { still: 40, gentle: 50, limited: 10 },
}

function scene(id: string, start: number, text: string, scene_type?: ScenePlanEntry['scene_type']): ScenePlanEntry {
  return {
    id,
    scene_index: Number(id.replace(/\D/g, '')) || 1,
    start_sec: start,
    end_sec: start + 12,
    transcript_segment: text,
    visual_prompt: text,
    ...(scene_type ? { scene_type } : {}),
  }
}

describe('Formula-owned scene motion profiles', () => {
  it('keeps evidence views still and treats real phenomena as limited animation', () => {
    assert.equal(preferredMotionMode(scene('s1', 0, 'A geological map shows the continent moving.', 'map')), 'still')
    assert.equal(preferredMotionMode(scene('s2', 0, 'The volcano erupts and lava flows toward the sea.', 'event')), 'limited')
    assert.equal(preferredMotionMode(scene('s3', 0, 'A quiet ancient shoreline at dawn.', 'environment')), null)
  })

  it('assigns a stable scene-role-aware mix across the opening and settled phases', () => {
    const scenes = [
      scene('s1', 0, 'A geological map of the supercontinent.', 'map'),
      scene('s2', 60, 'A quiet shoreline under rising sun.', 'environment'),
      scene('s3', 120, 'The volcano erupts, sending ash across the valley.', 'event'),
      scene('s4', 960, 'A fossil specimen rests in a drawer.', 'artifact'),
      scene('s5', 1020, 'A calm lagoon at dawn.', 'environment'),
      scene('s6', 1080, 'A herd migrates through the wetland.', 'event'),
      scene('s7', 1140, 'A misty forest floor.', 'environment'),
    ]
    const first = assignSceneMotionProfile(scenes, profile)
    const firstModes = scenes.map(item => item.motion_mode)
    const second = assignSceneMotionProfile(scenes, profile, { preserveExisting: true })

    assert.equal(scenes[0].motion_mode, 'still')
    assert.equal(scenes[2].motion_mode, 'limited')
    assert.equal(scenes[3].motion_mode, 'still')
    assert.deepEqual(scenes.map(item => item.motion_mode), firstModes, 'same plan produces the same motion assignments')
    assert.equal(second.changed, 0)
    assert.equal(first.modes.still + first.modes.gentle + first.modes.limited, scenes.length)
  })
})
