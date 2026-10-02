import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { episodeStepJobStates, statusFieldForJob } from '../utils/episode-step-jobs.js'

const board = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/board.vue', import.meta.url)),
  'utf8',
)

test('the latest job per episode step decides running / failed; a later success clears a failure', () => {
  const states = episodeStepJobStates([
    { type: 'thumb_images', status: 'error', episode_id: 'EP1', created_at: '2026-10-01T00:00:00Z', error: 'No credits left\nstack' },
    { type: 'audio', status: 'running', episode_id: 'EP1', created_at: '2026-10-01T00:00:00Z' },
    { type: 'audio_merge', status: 'error', episode_id: 'EP1', created_at: '2026-10-01T00:00:00Z' },
    { type: 'audio_merge', status: 'done', episode_id: 'EP1', created_at: '2026-10-02T00:00:00Z' },
    { type: 'expand_chapters', status: 'cancelled', episode_id: 'EP1', created_at: '2026-10-02T00:00:00Z' },
  ])
  assert.deepEqual(states.get('EP1:thumbnails'), { state: 'failed', error: 'No credits left' })
  assert.equal(states.get('EP1:audio')?.state, 'active')
  assert.equal(states.has('EP1:merged_audio'), false)
  assert.equal(states.has('EP1:script'), false)
})

test('job types map onto the Board status fields', () => {
  assert.equal(statusFieldForJob({ type: 'continuity_render', status: 'error' }), 'scene_review')
  assert.equal(statusFieldForJob({ type: 'subtitles_transcribe', status: 'error' }), 'subtitles')
  assert.equal(statusFieldForJob({ type: 'image_prompts', status: 'error', params: { mode: 'thumbnails' } }), 'thumb_prompts')
  assert.equal(statusFieldForJob({ type: 'image_prompts', status: 'error', params: { mode: 'scenes' } }), null)
})

test('the Board shows failed and running steps, says why, and does not hide its controls', () => {
  assert.match(board, /episodeStepJobStates\(jobs\.value/)
  assert.match(board, /failed: '✕'/)
  assert.match(board, /last attempt failed/)
  assert.match(board, /Failed only/)
  // A failed episode read is not an empty project.
  assert.match(board, /Could not read this project's episodes/)
  // A search finds finished episodes even while Needs work only is on.
  assert.match(board, /needsWorkOnly\.value && !searchActive\.value/)
  // Visible one-line hints, not tooltip-only meaning.
  assert.match(board, /class="board-hint"/)
  assert.doesNotMatch(board, /\.ep-import \{[^}]*opacity: 0;/)
})
