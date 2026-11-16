/**
 * A RESUMED render must still start its saved Final Video (PR0051).
 *
 * Production PR0051: `continuity_render` attempt 1 made 107 of 108 scenes and
 * one image came back with an UNKNOWN_OUTCOME. Auto-retry attempt 2 verified
 * that last scene and skipped the other 107 — "Done — 1/1 target scene(s)
 * verified; 107 skipped." — the parent settled `done`, and the `video_assembly`
 * link sitting in its own saved `pipeline_chain` was never started. The
 * deterministic child `pipeline-handoff-91531bc0fe58cf3612d71629` never existed.
 *
 * Every first-pass completion in the same hour chained normally, so the defect
 * is in the retry/resume path, not in the chain itself.
 *
 * The API view strips `pipeline_handoff` (`serializeJob`), so nothing here reads
 * the serialized row: the assertions are the durable MARKER and the CHILD ON
 * DISK.
 */
import { after, before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { waitFor } from './_timing.js'
import '../../../scripts/testing/loopback-supertest.mjs'

let tempDir = ''
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let wasQueuePaused = false
const fixtureProjects = new Set<string>()
const previousEnvironment = new Map(
  ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]),
)

function restoreEnvironment(): void {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function waitForPhysicalSettlement(projectSlug: string, label: string): Promise<void> {
  await waitFor(async () => {
    const jobs = await jq.getJobs(projectSlug)
    return jobs.every(job => !jq._isJobWorkerActiveForTesting(job.job_id) && job.status !== 'queued')
  }, { label })
  await jq._waitForJobPersistenceForTesting()
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the retained owner-only root is isolated')
  tempDir = await fs.mkdtemp(path.join(harnessRoot, 'pipeline-handoff-resume-retained-'))
  await fs.chmod(tempDir, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = tempDir
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  wasQueuePaused = jq.isQueuePaused()
  await jq.setQueuePaused(false)
})

after(async () => {
  try {
    if (!jq) return
    await jq.setQueuePaused(false)
    for (const projectSlug of fixtureProjects) {
      await waitForPhysicalSettlement(projectSlug, `${projectSlug} physical workers to settle before environment restore`)
    }
    await jq._waitForJobPersistenceForTesting()
    await jq.setQueuePaused(wasQueuePaused)
    await jq._waitForJobPersistenceForTesting()
  } finally {
    restoreEnvironment()
  }
})

async function retainedFixture(t: TestContext, name: string) {
  const project = await pm.createProject({ name })
  fixtureProjects.add(project.slug)
  const restorers: Array<() => void> = []
  t.after(async () => {
    for (const restore of restorers.reverse()) restore()
    await waitForPhysicalSettlement(project.slug, `${name} workers settle`)
  })
  return { project, restoreWith: (restore: () => void) => restorers.push(restore) }
}

/** The saved Final Video link, exactly as a batch captures it. */
const FINAL_VIDEO_LINK = {
  type: 'video_assembly',
  title: 'Pipeline: Final Video — PR0051',
  params: { episode_id: 'PR0051', resolution: '1080p', aspect_ratio: '16:9', pipeline_step: 'video-assembly', pipeline_requires: ['scene-images'] },
}

/** One Gateway entry per scene, in the shape the scene render records them. */
function providerEntry(index: number, state: string): Record<string, unknown> {
  const scene = String(index).padStart(4, '0')
  return {
    id: `hub-scene-${scene}`,
    operation: 'image.generation',
    state,
    dispatch_state: 'dispatched',
    model_id: 'studio-hub::demo/FLUX2-klein-4B-mlx-4bit',
    request_key: `story-scene-${scene}`,
    cancellable: false,
    cancelled: false,
  }
}

async function durableParent(slug: string, parentId: string): Promise<any> {
  const jobs = await jq.getJobs(slug)
  return jobs.find(job => job.job_id === parentId)
}

/**
 * The resume shape: attempt 1 makes 107 of 108 scenes and leaves one provider
 * entry with an unknown outcome; attempt 2 verifies the last scene and skips
 * the rest. Asserted on disk, not in the serialized row.
 */
async function runResumedRender(t: TestContext, name: string): Promise<{ slug: string; parentId: string }> {
  const f = await retainedFixture(t, name)
  const { _setJobAutoRetryDelaysForTesting } = await import('../services/job-retry-policy.js')
  _setJobAutoRetryDelaysForTesting(0)
  f.restoreWith(() => _setJobAutoRetryDelaysForTesting(null))

  const childRuns: string[] = []
  f.restoreWith(jq._setExecutorForTesting('video_assembly', async job => {
    childRuns.push(job.job_id)
    job.result = { ...(job.result || {}), complete: true }
  }))

  let attempts = 0
  f.restoreWith(jq._setExecutorForTesting('continuity_render', async (job: Job) => {
    attempts += 1
    if (attempts === 1) {
      // 107 made; scene 56 came back with an outcome the Gateway could not prove.
      job.genstudio_jobs = [
        ...Array.from({ length: 107 }, (_, i) => (i + 1 === 56 ? null : providerEntry(i + 1, 'succeeded'))).filter(Boolean),
        { ...providerEntry(56, 'failed'), recovery_required: true, recovery_state: 'unknown_outcome', failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN' },
      ] as any
      throw new Error('Scene images incomplete: 107 of 108 made; finished images are saved.')
    }
    // Attempt 2 resumes: one scene verified, 107 skipped.
    // The Gateway later confirms the held task; at this instant it is still unsettled.
    job.genstudio_jobs = Array.from({ length: 108 }, (_, i) => (i + 1 === 56
      ? { ...providerEntry(56, 'failed'), recovery_required: true, recovery_state: 'unknown_outcome', failure_code: 'PROVIDER_SUBMISSION_UNCERTAIN' }
      : providerEntry(i + 1, 'succeeded'))) as any
    job.result = { ...(job.result || {}), complete: true, completion: { label: 'Scene image generation', expected: 1, completed: 1, complete: true } }
    job.output_lines.push('Done — 1/1 target scene(s) verified; 107 skipped.')
  }))

  const parent = await jq.enqueue({
    project_slug: f.project.slug,
    type: 'continuity_render',
    episode_id: 'PR0051',
    title: 'Pipeline: Scene images — PR0051',
    params: {
      episode_id: 'PR0051',
      model: 'studio-hub::demo/FLUX2-klein-4B-mlx-4bit',
      pipeline_step: 'scene-images',
      pipeline_requires: [],
      pipeline_chain: [FINAL_VIDEO_LINK],
    },
  })

  await waitFor(async () => {
    const job = await durableParent(f.project.slug, parent.job_id)
    return !!job && (job.status === 'done' || job.status === 'error')
  }, { label: `${name}: the resumed render settles` })
  await waitForPhysicalSettlement(f.project.slug, `${name}: resumed render settles physically`)
  return { slug: f.project.slug, parentId: parent.job_id }
}

test('a resumed render starts its saved Final Video exactly once', async t => {
  const { slug, parentId } = await runResumedRender(t, 'Resumed render handoff')
  const jobs = await jq.getJobs(slug)
  const parent = jobs.find(job => job.job_id === parentId)!
  assert.equal(parent.status, 'done', `parent must settle done: ${parent.error ?? ''}`)
  assert.equal(parent.auto_retry?.attempt, 2, 'the fixture must reach attempt 2')

  // The durable marker — invisible in the API view, so read from the store.
  const durable = await jq.loadAuthoritativeJob(slug, parentId)
  const marker = (durable as any)?.pipeline_handoff
  assert.ok(marker, 'the resumed parent must keep its saved handoff marker')
  assert.equal(marker.state, 'dispatched', 'the saved handoff must be drained, not left pending')

  const children = jobs.filter(job => job.type === 'video_assembly' && job.episode_id === 'PR0051')
  assert.equal(children.length, 1, 'a resumed render starts exactly one Final Video')
  assert.equal(children[0].job_id, marker.child_job_id)
})

test('repeating the recovery pass adds no second Final Video', async t => {
  const { slug, parentId } = await runResumedRender(t, 'Resumed render repeat')
  const first = (await jq.getJobs(slug)).filter(job => job.type === 'video_assembly')
  assert.equal(first.length, 1, 'the first pass starts one Final Video')
  await jq._drainPendingPipelineHandoffForTesting(parentId)
  await jq._drainPendingPipelineHandoffForTesting(parentId)
  const second = (await jq.getJobs(slug)).filter(job => job.type === 'video_assembly')
  assert.equal(second.length, 1, 'repeating the recovery pass must not duplicate the Final Video')
})
