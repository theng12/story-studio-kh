/**
 * 1.4.292 — Free Up Space moved channel TN0162–TN0170's chapter audio to Trash
 * after upload; the next restart's recovery sweep queued Audio Assembly for all
 * nine and each failed 3/3 ("required audio file(s) are missing"). Retired media
 * is intentionally absent: automatic recovery must not queue work for it, while an
 * owner request made after the cleanup still rebuilds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

const notReady = { audio_merge: false, subtitle_sections: false, subtitle_stitch: false, scene_plan_run: false, contextual_cues: false, continuity_render: false }

test('recovery does not rebuild media Free Up Space retired, unless the owner asks afterwards', async () => {
  const temp = await useTempDataDir()
  try {
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const jq = await import('../services/job-queue.js')
    const pm = await import('../services/project-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const project = await pm.createProject({ name: 'Recovery skips retired media' })
    await jq.setQueuePaused(true)
    const { episode_dir, audio_dir } = await resolveEpisodePathsByCode(project.slug, 'EP0001')
    await fs.mkdir(episode_dir, { recursive: true })
    const cleanedAt = new Date(Date.now() - 60_000).toISOString()
    const proof = { platform: 'youtube', video_id: 'v1', operation_id: 'op', channel_id: 'ch', uploaded_at: cleanedAt }
    await fs.writeFile(path.join(episode_dir, 'local_media_cleanup.json'), JSON.stringify({
      version: 1, project_slug: project.slug, episode_code: 'EP0001', updated_at: cleanedAt,
      entries: [{ entry_id: 'e1', source_path: path.join(audio_dir, 'EP0001_chapter_01.mp3'), relative_path: 'EP0001_chapter_01.mp3',
        category: 'chapter_audio', bytes: 10, bytes_reclaimed: 10, sha256: 'a'.repeat(64), preview_id: 'p', operation_id: 'op',
        mode: 'remove', outcome: 'removed', recorded_at: cleanedAt, updated_at: cleanedAt, upload_proof: proof }],
    }))
    const merge: Job = { job_id: 'merge-done', project_slug: project.slug, episode_id: 'EP0001', type: 'audio_merge', params: {},
      status: 'done', title: 'audio_merge', created_at: '2026-10-01T00:00:00Z', started_at: null, finished_at: null, error: null, output_lines: [] }
    const plan = createEpisodeRecoveryPlan([merge])

    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: '11 required audio file(s) are missing' }, [merge])
    assert.ok(!jq.getJob(plan.steps.audio_merge!.job_id), 'automatic recovery queued Audio Assembly over retired audio')
    assert.match(plan.message, /Free Up Space/)

    plan.owner_requested_at = new Date().toISOString()
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Merged audio is stale' }, [merge])
    assert.ok(jq.getJob(plan.steps.audio_merge!.job_id), 'an owner request after the cleanup still rebuilds')
  } finally {
    const jq = await import('../services/job-queue.js')
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})
