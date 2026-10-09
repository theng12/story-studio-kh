/**
 * 1.4.265 — a prompt update (services/app-update.ts) waits only for running jobs that a restart
 * would NOT continue. `runningJobsThatWouldNotResume` answers with the boot scan's own rule
 * (`bootRecoveryKind`), so the two cannot disagree: a Video Assembly with its checkpoint and an
 * Audio Assembly resume; a Video Assembly with no checkpoint yet and a music video do not.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'
import { waitFor } from './_timing.js'
import { createVideoAssemblyCheckpoint, setVideoAssemblyCheckpoint } from '../lib/video-assembly-checkpoint.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})
after(async () => { await cleanup() })

test('the update waits for running jobs that would not resume, and only for those', async () => {
  const proj = await pm.createProject({ name: 'PROMPT-UPDATE' })
  const releases: Array<() => void> = []
  const live = new Map<string, Job>()
  const hold = (job: Job) => { live.set(job.episode_id, job); return new Promise<void>(resolve => releases.push(resolve)) }
  jq.registerExecutor('video_assembly', hold)
  jq.registerExecutor('audio_merge', hold)
  jq.registerExecutor('music_video', hold)
  for (const [type, episode] of [['video_assembly', 'EP1'], ['audio_merge', 'EP2'], ['music_video', 'EP3']] as const) {
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type, episode_id: episode, title: `${type} ${episode}`, params: {} })
  }
  await waitFor(() => live.size === 3, { label: 'all three running' })
  const waitedFor = async () => (await jq.runningJobsThatWouldNotResume()).map(job => job.type).sort()

  assert.deepEqual(await waitedFor(), ['music_video', 'video_assembly'],
    'a Video Assembly that has not saved its checkpoint yet would start over, so it is waited for; Audio Assembly is not')

  const assembly = live.get('EP1')!
  setVideoAssemblyCheckpoint(assembly, createVideoAssemblyCheckpoint(assembly, await getWorkTempDir(proj.slug, 'EP1'), 'a'.repeat(64)))
  assert.deepEqual(await waitedFor(), ['music_video'], 'with its checkpoint it resumes after the restart; a music video still does not')

  while (releases.length) releases.shift()!()
  await waitFor(async () => (await jq.runningJobsThatWouldNotResume()).length === 0, { label: 'nothing left to wait for' })
  await waitFor(() => jq.getQueueStats(proj.slug).running === 0, { label: 'the jobs to finish' })
  await jq._waitForJobPersistenceForTesting()
})
