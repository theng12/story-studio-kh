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

test('Pipeline episode pills show a failed or running step and explain the icons visibly', () => {
  const pipeline = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)),
    'utf8',
  )
  assert.match(pipeline, /episodeStepJobStates\(queueJobs\.value/)
  assert.match(pipeline, /stepJobState\(step\.id, ep\)/)
  assert.match(pipeline, /class="pill-legend/)
  assert.match(pipeline, /only the later steps that need it wait/)
})

test('Scene Review waiting on unapproved scenes says so on the Board (TN0329)', async () => {
  const { awaitingApprovalLabel } = await import('../utils/episode-step-jobs.js')
  assert.equal(awaitingApprovalLabel(1), 'Waiting for your approval (1 scene)')
  assert.equal(awaitingApprovalLabel(3), 'Waiting for your approval (3 scenes)')
  assert.equal(awaitingApprovalLabel(0), '')
  assert.equal(awaitingApprovalLabel(undefined), '')
  assert.match(board, /awaitingApprovalLabel\(ep\.status\?\.scene_review_awaiting_approval\)/)
  assert.match(board, /\|\| \(approvalWait\(ep, col\) \? 'waiting' : 'pending'\)/, 'a running or failed job still wins')
  assert.match(board, /waiting: '⏸'/)
  assert.match(board, /approvalWait\(ep, col\) \|\| 'pending'/, 'the cell title carries the wording')
})
