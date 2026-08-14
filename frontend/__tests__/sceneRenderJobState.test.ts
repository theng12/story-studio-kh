import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveActiveSceneRenderJob, type SceneRenderJob } from '../utils/scene-render-job-state.js'

const pausedSnapshot: SceneRenderJob = {
  episode_id: 'EP-SSE',
  job_id: 'scene-batch',
  status: 'paused',
  type: 'continuity_render',
}

function live(status: string): SceneRenderJob {
  return { ...pausedSnapshot, status }
}

describe('Scene Review render owner reconciliation', () => {
  test('a matching SSE job replaces a paused review snapshot through queued, running, and terminal states', () => {
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', pausedSnapshot, []).status, 'paused')
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', pausedSnapshot, [live('queued')]).status, 'queued')
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', pausedSnapshot, [live('running')]).status, 'running')
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', pausedSnapshot, [live('done')]), null)
  })

  test('continuity controls follow the matching live state and disappear on terminal SSE', () => {
    const continuityTypes = ['continuity_render', 'scene_images_batch']
    for (const [status, expectBanner, expectSpinnerAndPoll] of [
      ['paused', true, false],
      ['queued', true, true],
      ['running', true, true],
      ['cancelled', false, false],
    ] as const) {
      const owner = resolveActiveSceneRenderJob('EP-SSE', pausedSnapshot, [live(status)], continuityTypes)
      assert.equal(Boolean(owner), expectBanner, `${status} banner truth`)
      assert.equal(Boolean(owner && owner.status !== 'paused'), expectSpinnerAndPoll, `${status} spinner/poll truth`)
      assert.equal(Boolean(owner), expectBanner, `${status} continuity controls truth`)
    }
  })
})
