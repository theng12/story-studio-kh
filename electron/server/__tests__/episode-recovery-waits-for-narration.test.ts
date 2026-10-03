/**
 * Episode recovery must not run Audio Assembly while the same episode's
 * narration is still being made or replaced. Found in the Dreamlands
 * durability run 2026-10-03: a backend restart re-queued Audio Assembly for
 * EP0001 and EP0003 while their chapter re-narration jobs were mid-flight, so
 * the merge mixed old and new chapter takes and was stale on completion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

const notReady = { audio_merge: false, subtitle_sections: false, subtitle_stitch: false, scene_plan_run: false, contextual_cues: false, continuity_render: false }

function row(projectSlug: string, type: Job['type'], status: Job['status'], jobId: string): Job {
  return {
    job_id: jobId, project_slug: projectSlug, episode_id: 'EP0001', type, params: {},
    status, title: type, created_at: '2026-10-03T00:00:00Z',
    started_at: null, finished_at: null, error: status === 'error' ? 'failed' : null, output_lines: [],
  }
}

test('Audio Assembly recovery waits while the episode is being narrated, then dispatches', async () => {
  const temp = await useTempDataDir()
  try {
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Recovery waits for narration' })
    await jq.setQueuePaused(true) // keep the dispatched row queued; nothing executes
    const merge = row(project.slug, 'audio_merge', 'error', 'merge-source')
    const plan = createEpisodeRecoveryPlan([merge])
    const narration = row(project.slug, 'audio', 'running', 'narration-running')

    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Merged audio is stale' }, [merge, narration])
    assert.equal(plan.steps.audio_merge?.dispatched, undefined, 'no Audio Assembly while narration runs')
    assert.match(plan.message, /Waiting for narration/)
    assert.ok(!jq.getJob(plan.steps.audio_merge!.job_id))

    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Merged audio is stale' }, [merge, { ...narration, status: 'done' }])
    assert.equal(plan.steps.audio_merge?.dispatched, true, 'dispatches once narration has finished')
    assert.ok(jq.getJob(plan.steps.audio_merge!.job_id))
  } finally {
    const jq = await import('../services/job-queue.js')
    await jq.setQueuePaused(false)
    await temp.cleanup()
  }
})
