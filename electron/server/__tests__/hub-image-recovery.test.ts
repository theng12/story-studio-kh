import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let recovery: typeof import('../services/hub-image-recovery.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects', 'recovery-project'), { recursive: true })
  recovery = await import('../services/hub-image-recovery.js')
})

after(async () => { await cleanup() })

function job(): Job {
  return {
    job_id: 'recover-1', project_slug: 'recovery-project', type: 'scene_images_batch',
    episode_id: 'EP0001', title: 'images', status: 'running',
    created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    finished_at: null, error: null, output_lines: [], params: {},
  }
}

describe('durable Studio Hub image identity', () => {
  test('persists before submit, reconnects an accepted batch, then rotates identity only after terminal failure', async () => {
    const current = job()
    const first = await recovery.prepareHubImageRecovery(current, {
      logicalId: 'scene-images:p:EP0001', targetIds: ['scene-1', 'scene-2'],
      hubUrl: 'http://hub:47873', requestIdentity: [{ prompt: 'one' }, { prompt: 'two' }],
    })
    assert.equal(first.state, 'prepared')
    assert.match(first.client_request_id, /^storystudio-image-/)

    // An ambiguous retry before the POST response reuses the exact identity.
    const replay = await recovery.prepareHubImageRecovery(current, {
      logicalId: first.logical_id, targetIds: first.target_ids,
      hubUrl: first.hub_url, requestIdentity: [{ prompt: 'one' }, { prompt: 'two' }],
    })
    assert.equal(replay.client_request_id, first.client_request_id)

    await recovery.acceptHubImageRecovery(current, first, 'hub-batch-123')
    const accepted = recovery.getHubImageRecovery(current)!
    assert.equal(accepted.state, 'accepted')
    assert.equal(accepted.batch_id, 'hub-batch-123')

    await recovery.finishHubImageRecoveryPoll(current, accepted, {
      id: 'hub-batch-123', items: [
        { index: 0, state: 'done' },
        { index: 1, state: 'error', error: 'worker failed' },
      ],
    })
    assert.equal(recovery.getHubImageRecovery(current)?.state, 'terminal')

    // The generator's disk audit narrowed the next attempt to the one missing
    // scene. A normal Retry gets a fresh identity and cannot replay the failed
    // two-item batch.
    const second = await recovery.prepareHubImageRecovery(current, {
      logicalId: first.logical_id, targetIds: ['scene-2'], hubUrl: first.hub_url,
      requestIdentity: [{ prompt: 'two' }],
    })
    assert.equal(second.attempt, 2)
    assert.notEqual(second.client_request_id, first.client_request_id)
    assert.deepEqual(second.target_ids, ['scene-2'])
  })

  test('Repair requires an accepted batch and never creates a new identity', async () => {
    const current = job()
    await assert.rejects(
      () => recovery.prepareHubImageRecovery(current, {
        logicalId: 'scene-images:p:EP0001', targetIds: ['scene-1'],
        hubUrl: 'http://hub:47873', requestIdentity: [{ prompt: 'one' }], repairOnly: true,
      }),
      /cannot find an accepted image batch/i,
    )

    const prepared = await recovery.prepareHubImageRecovery(current, {
      logicalId: 'scene-images:p:EP0001', targetIds: ['scene-1'],
      hubUrl: 'http://hub:47873', requestIdentity: [{ prompt: 'one' }],
    })
    await recovery.acceptHubImageRecovery(current, prepared, 'hub-batch-repair')
    const repair = await recovery.prepareHubImageRecovery(current, {
      logicalId: prepared.logical_id, targetIds: prepared.target_ids,
      hubUrl: prepared.hub_url, requestIdentity: [{ prompt: 'changed but not resubmitted' }], repairOnly: true,
    })
    assert.equal(repair.batch_id, 'hub-batch-repair')
    assert.equal(repair.client_request_id, prepared.client_request_id)
  })

  test('an uncertain prepared request fails closed when its body identity changed', async () => {
    const current = job()
    await recovery.prepareHubImageRecovery(current, {
      logicalId: 'scene-images:p:EP0001', targetIds: ['scene-1'],
      hubUrl: 'http://hub:47873', requestIdentity: [{ prompt: 'original' }],
    })
    await assert.rejects(
      () => recovery.prepareHubImageRecovery(current, {
        logicalId: 'scene-images:p:EP0001', targetIds: ['scene-1'],
        hubUrl: 'http://hub:47873', requestIdentity: [{ prompt: 'changed' }],
      }),
      /stopped instead of risking duplicate work/i,
    )
  })
})
