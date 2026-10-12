import assert from 'node:assert/strict'
import test from 'node:test'

test('new channels use the owner-approved lenient defaults while fixed protections stay locked', async () => {
  const { SAFETY_CHECKS, safetyModeFromConfig } = await import('../services/safety-checks.js')
  const byId = new Map(SAFETY_CHECKS.map(check => [check.id, check]))

  for (const id of [
    'scene_pictures', 'scenes_approved', 'stale_picture', 'picture_opens', 'scene_overlap',
    'narration_covered', 'scene_count', 'merged_audio_exists', 'subtitles_this_episode',
    'switched_on_inputs', 'cues_approved', 'opening_outro', 'image_pool_covers', 'final_video_whole',
  ]) {
    assert.equal(byId.get(id)?.locked, undefined, `${id} must be switchable per channel`)
  }

  for (const id of ['accepted_idea', 'retired_media', 'research_approved', 'lyrics_listen_back', 'idea_repeat']) {
    assert.equal(safetyModeFromConfig({}, id), 'warn', id)
  }
  assert.match(byId.get('retired_media')?.name || '', /costs money/i)

  for (const [id, mode] of Object.entries({
    scene_pictures: 'block', scenes_approved: 'off', stale_picture: 'off', picture_opens: 'warn',
    scene_overlap: 'off', narration_covered: 'off', scene_count: 'warn', merged_audio_exists: 'block',
    subtitles_this_episode: 'warn', switched_on_inputs: 'warn', cues_approved: 'warn', opening_outro: 'warn',
    image_pool_covers: 'warn', final_video_whole: 'block',
  })) {
    assert.equal(safetyModeFromConfig({}, id), mode, id)
  }
  for (const id of ['gateway_key', 'model_available', 'paid_not_repeated', 'private_upload', 'not_on_youtube']) {
    assert.equal(byId.get(id)?.locked, 'block', `${id} remains fixed`)
  }
})

test('an explicit channel mode wins for every newly unlocked check', async () => {
  const { safetyModeFromConfig } = await import('../services/safety-checks.js')
  for (const id of [
    'scene_pictures', 'scenes_approved', 'stale_picture', 'picture_opens', 'scene_overlap',
    'narration_covered', 'scene_count', 'merged_audio_exists', 'subtitles_this_episode',
    'switched_on_inputs', 'cues_approved', 'opening_outro', 'image_pool_covers', 'final_video_whole',
  ]) {
    assert.equal(safetyModeFromConfig({ safety_checks: { [id]: 'off' } }, id), 'off', id)
  }
})
