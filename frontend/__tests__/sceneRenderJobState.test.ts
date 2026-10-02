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

  test('a terminal cached batch falls through to a newer active batch for the same episode', () => {
    const continuityTypes = ['continuity_render', 'scene_images_batch']
    for (const terminal of ['cancelled', 'done']) {
      for (const status of ['queued', 'running']) {
        const newer = { ...pausedSnapshot, job_id: `new-${status}`, status }
        const owner = resolveActiveSceneRenderJob('EP-SSE', pausedSnapshot, [live(terminal), newer], continuityTypes)
        assert.equal(owner?.job_id, newer.job_id, `${terminal} batch must yield to queued/running successor`)
        assert.equal(owner?.status, status, 'successor drives banner, spinner, poll, and continuity controls')
      }
    }
  })

  test('a single-scene regenerate owns the episode render state while it runs', () => {
    const single = { episode_id: 'EP-SSE', job_id: 'one-image', type: 'scene_image_generate' }
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', null, [{ ...single, status: 'running' }])?.job_id, 'one-image')
    assert.equal(resolveActiveSceneRenderJob('EP-SSE', null, [{ ...single, status: 'error' }]), null)
  })
})
