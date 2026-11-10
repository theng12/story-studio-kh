/**
 * v1.4.31 — a Motion Review clip refused for want of a free machine waits and
 * asks again instead of being dropped.
 *
 * WHY THIS GENERATOR. GenStudio places every job on a fleet machine, and with
 * none free it settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED` after a
 * fifteen-minute placement window. Two operations have already lost work to it
 * silently: transcription dropped 122 of 353 items in one burst, and TTS dropped
 * 5 over three days that nobody noticed for nine, because the only symptom is a
 * missing asset a later manual retry quietly fills in. Motion Review is worse
 * than either, on two counts. `generateSceneClipsBatchJob` runs every non-still
 * scene through `generateSceneClipJob` inside ONE queue job with no per-scene
 * catch, so a single refusal does not drop one clip — it ends the whole
 * episode's run. And video is the most expensive thing the app buys, so the
 * work being thrown away is the most valuable work there is.
 *
 * WHY RESUBMITTING IS SAFE, AND WHY NOTHING ELSE IS. GenStudio raises this code
 * from one place, having already held the job in a fifteen-minute placement
 * window, and states there what became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. The argument does not extend one inch further. A provider that WAS
 * engaged may already have rendered the clip, and resubmitting over it charges
 * the owner twice for the priciest asset in the app — the single worst outcome
 * this change can have. A "Repair & Retry all" button was removed in v1.0.114
 * for exactly that, which is why the refusals below matter more than the one
 * case that is allowed.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { generateSceneClipJob, generateSceneClipsBatchJob, sceneClipFleetBusyRetryPlan } from '../generators/scene-clip.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioImageTerminalFailureError,
  GenStudioTtsTerminalFailureError,
  GenStudioVideoTerminalFailureError,
} from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { tinyVideoBytes, twoSecondVideoBytes } from './fixtures/tiny-video.js'

/** A settled GenStudio job with the reservation released whole — the free case. */
function settledJob(over: Record<string, unknown>) {
  return {
    id: 'vid-job', state: 'failed', cancelled: false,
    reserved_credits: 240, settled_credits: 0, released_credits: 240,
    ...over,
  } as any
}

const videoFailure = (over: Record<string, unknown>) =>
  new GenStudioVideoTerminalFailureError(settledJob(over))

test('the modality this generator guards on is the one the video error carries', () => {
  // Read, not assumed. `GenStudioVideoTerminalFailureError` builds its base with
  // `super('video', job, …)`, and Motion Review produces VIDEO — not the
  // `'image'` its still-image neighbours pass. Getting this wrong in the
  // permissive direction would let a busy IMAGE queue licence a resubmission of
  // the most expensive asset in the app.
  assert.equal(videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }).modality, 'video')
})

test('(a) a busy fleet with the money returned earns another attempt', () => {
  // Both codes mean the same thing — no machine was free — and neither means
  // the clip is impossible. Dropping it here costs the owner a manual re-run of
  // an entire episode's motion pass, because the batch has no per-scene catch.
  for (const failure_code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
    const plan = sceneClipFleetBusyRetryPlan(videoFailure({ failure_code }), 1)
    assert.ok(plan, `${failure_code} must earn another attempt`)
    assert.match(plan.reason, /high demand right now/i)
  }
})

test('(b) legacy or missing settlement does not decide; the code and the job state do', () => {
  // Story no longer tracks credits — the error's credit fields are null — so a
  // legacy payload's settled/released numbers can neither grant nor deny an
  // attempt. Only the failure code, cancellation, modality and the
  // unknown-outcome hold decide.
  for (const over of [
    { failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 240, released_credits: 0 },
    { failure_code: 'SITE_CAPACITY_UNAVAILABLE', settled_credits: 12, released_credits: 228 },
    {
      failure_code: 'SITE_PLACEMENT_EXHAUSTED',
      reserved_credits: undefined, settled_credits: undefined, released_credits: undefined,
    },
  ]) {
    const plan = sceneClipFleetBusyRetryPlan(videoFailure(over), 1)
    assert.ok(plan, `${JSON.stringify(over)} must not deny the attempt by itself`)
  }
  assert.equal(
    videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }).settledCredits, null,
    'the error publishes no settlement to decide on',
  )
})

test('(b2) an unknown-outcome hold is never resubmitted', () => {
  // The gateway may still be holding a result that has not landed; a busy code
  // on such a job must not buy a second clip.
  for (const over of [{ recovery_state: 'unknown_outcome' }, { recovery_required: true }]) {
    assert.equal(
      sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', ...over }), 1),
      null,
      JSON.stringify(over),
    )
  }
})

test('(c) an unrelated failure is never retried as if the fleet were merely busy', () => {
  // A real fault repeats. Three backoffs would turn a clear, immediate error
  // into ten minutes of silence followed by the same clear error — worse for the
  // owner than failing at once, and it teaches him to distrust the log.
  for (const failure_code of ['CLOUD_PROVIDER_FAILED', 'CONTENT_BLOCKED', 'CLOUD_SUBMISSION_UNCERTAIN', null, '']) {
    assert.equal(
      sceneClipFleetBusyRetryPlan(videoFailure({ failure_code }), 1),
      null,
      `${String(failure_code)} is not a capacity problem`,
    )
  }
  // Not even a declined ROUTE, which `generators/images.ts` does retry on its
  // own seconds-long schedule. Motion Review has never had that retry, and
  // reusing that generator's `imageRetryPlan` to save a few lines would have
  // smuggled a second behaviour change — on the priciest modality — into a fix
  // about a busy fleet.
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), 1),
    null,
  )
  // Nor anything that is not a settled GenStudio failure at all — a socket
  // hang-up says nothing about whether a worker took the job.
  assert.equal(sceneClipFleetBusyRetryPlan(new Error('socket hang up'), 1), null)
  assert.equal(sceneClipFleetBusyRetryPlan(null, 1), null)
  assert.equal(sceneClipFleetBusyRetryPlan(undefined, 1), null)
})

test('(d) a cancelled job is never resubmitted', () => {
  // Cancellation is the owner's instruction. A cancelled video job settles
  // through the same `cancelled` boolean as every other modality
  // (`waitForVideoJob` throws on `state === 'failed' || cancelled === true`), so
  // the shared guard sees it; asking for the clip again would be the app
  // overruling him.
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true }), 1),
    null,
  )
  assert.equal(
    sceneClipFleetBusyRetryPlan(videoFailure({ failure_code: 'SITE_CAPACITY_UNAVAILABLE', cancelled: true }), 1),
    null,
  )
})

test('(e) a busy queue in another modality is not licence to resubmit a clip', () => {
  // A saturated TTS or image queue says nothing about whether THIS clip's
  // credits came back, which is why the modality is passed to the shared guard
  // rather than left to match anything. The image case is the one that would
  // actually happen here: this generator sits beside two image generators that
  // pass `'image'`, and an episode renders stills and clips in the same run.
  const busy = { failure_code: 'SITE_PLACEMENT_EXHAUSTED' }
  assert.equal(
    sceneClipFleetBusyRetryPlan(new GenStudioTtsTerminalFailureError(settledJob(busy)), 1),
    null,
  )
  assert.equal(
    sceneClipFleetBusyRetryPlan(new GenStudioImageTerminalFailureError(settledJob(busy)), 1),
    null,
  )
})

test('the waits are the shared minutes-long schedule, and they run out', () => {
  // GenStudio declares a busy fleet only AFTER a fifteen-minute placement
  // window, so a clip reaching here has already queued a long time and the fleet
  // is genuinely saturated. A two-second retry would rejoin the same jam and
  // burn the attempt for nothing.
  const busy = videoFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })
  for (let attemptNum = 1; attemptNum <= FLEET_BUSY_RETRY_DELAYS_MS.length; attemptNum++) {
    const plan = sceneClipFleetBusyRetryPlan(busy, attemptNum)
    assert.ok(plan)
    assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1])
    assert.ok(plan.waitMs >= 30_000, 'a fleet wait is never a couple of seconds')
    assert.equal(plan.maxAttempts, FLEET_BUSY_RETRY_DELAYS_MS.length + 1)
  }
  // Bounded by the shared schedule's own length: after the last delay the clip
  // fails exactly as it does today. An unbounded wait would hold an episode's
  // motion pass open against a wall forever and is a worse failure than the one
  // being fixed.
  assert.equal(sceneClipFleetBusyRetryPlan(busy, FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null)
  assert.equal(sceneClipFleetBusyRetryPlan(busy, 99), null)
})

test('the clip waits under the owner\'s control and resubmits under a DERIVED identity', () => {
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')

  // The rule is the shared one, not a local copy that can drift away from the
  // other generators that must agree about what is free to retry.
  assert.match(source, /from '\.\.\/lib\/genstudio-fleet-busy\.js'/)
  assert.match(source, /isFleetBusyFailure\(e, 'video'\)/)

  // Cancel and Pause are read at all three moments that matter: the top of every
  // attempt, before committing to a wait, and again after minutes have passed.
  // The wait itself polls in short slices, so a stop pressed four minutes into a
  // five-minute wait is honoured in seconds rather than at the end of it.
  assert.match(source, /Cancel is re-read at the top of EVERY attempt/)
  assert.match(source, /if \(jq\.isCancelled\(job\.job_id\)\) throw new Error\('Cancelled by user'\)/)
  assert.match(source, /if \(retryPlan && failedTaskId && !jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)
  assert.match(source, /await waitForFleetCapacity\(retryPlan\.waitMs\)/)
  assert.match(source, /Math\.min\(2_000, deadline - Date\.now\(\)\)/)
  assert.match(source, /if \(!jq\.isCancelled\(job\.job_id\) && !jq\.isPauseRequested\(job\.job_id\)\) \{/)

  // IDENTITY. A settled-failed GenStudio job can never be reopened — replaying
  // its idempotency key returns the same failure forever — so every attempt
  // needs a new one. It is DERIVED, not minted: this file already persisted the
  // failed job id before the wait, and the same entry is mirrored into the
  // in-memory `savedEntry` EXACTLY as written, then promoted through the same
  // deterministic `resolveGenStudioRetryScope` a manual Retry uses. A crash
  // between the wait and the resubmission therefore replays the identical
  // request instead of buying a second clip.
  assert.match(source, /const failedEntry = clipManifestEntry\(\{/)
  assert.match(source, /await recordTask\(outDir, manifestKey, failedEntry\)/)
  assert.match(source, /savedEntry = failedEntry/)
  assert.match(source, /const retry = resolveGenStudioRetryScope\(savedEntry, 'missing', isTerminalGenStudioClipTaskFailure\)/)
  assert.doesNotMatch(source, /randomUUID/)
  assert.doesNotMatch(source, /Math\.random/)

  // The new identity is on disk BEFORE the paid POST of the retry — the whole
  // reason a lost submit response replays instead of buying a second clip.
  assert.match(source, /Persist the request identity BEFORE the POST/)
  assert.match(source, /await recordTaskStrict\(outDir, manifestKey, clipManifestEntry\(\{\n\s+task_id: recoveryEntry\?\.task_id \|\| '',\n\s+last_state: preparedState,/)

  // Said in words the owner can read in the job output, and it says the part he
  // would otherwise have to take on faith: this cost him nothing.
  assert.match(source, /nothing was charged and the credits were returned/)
})

test('no stall watchdog can cancel this generator\'s own retry', () => {
  // continuity-render.ts had to suppress a 10-minute stall pause while waiting,
  // because a busy fleet is exactly the condition that trips it. Motion Review
  // has no such timer — it owns no interval, and `jq.pauseJobForStall` has
  // exactly one caller in the app, which is continuity-render — so there is
  // nothing to suppress. This test fails the day one is added here without
  // teaching it about the wait.
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /pauseJobForStall|setInterval/)
})

test('a batch audits saved clips before declaring no work and reports deleted requested scenes', () => {
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')
  const batch = source.slice(source.indexOf('export async function generateSceneClipsBatchJob'))

  const earlyReturn = batch.slice(batch.indexOf('if (!ready.length)'), batch.indexOf('const originalParams'))
  assert.match(earlyReturn, /auditSceneClipCompletion\(planPath, requiredIds, clipsDir, expectedDurations[,)]/,
    'a non-empty, corrupt or wrong-duration saved file must fail completion rather than return success')
  assert.match(batch, /const requiredIds: string\[\] = requestedSceneIds \? \[\.\.\.requestedSceneIds\] : \[\]/,
    'a map entry whose Scene Plan row was deleted must remain a missing required item')
})

test('a Follow narration batch preserves its hold mode for each child clip', () => {
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')
  const batch = source.slice(source.indexOf('export async function generateSceneClipsBatchJob'))

  assert.match(batch, /job\.params = \{\s*\.\.\.job\.params,/,
    'per-scene child params must retain duration_mode from the durable parent request')
  assert.match(source, /params\.duration_mode === 'follow_narration' \|\| scene\.fill_mode === 'hold'\s*\? \{ shortfall_mode: 'hold' as const \}/,
    'each Follow child must checkpoint final-frame hold for assembly')
})

test('a rejected replacement candidate leaves the active clip untouched', () => {
  const source = readFileSync(new URL('../generators/scene-clip.ts', import.meta.url), 'utf8')
  const downloadAt = source.indexOf('await downloadVideo(')
  // The local Sketch Draw path checkpoints earlier in the file; bound the slice after the download.
  const download = source.slice(downloadAt, source.indexOf('await checkpointSceneClip(', downloadAt))

  assert.match(download, /candidatePath/,
    'provider bytes must land beside, never directly on top of, the active clip')
  assert.match(download, /assertPlayableSceneClip\(candidatePath, durationSeconds\)/,
    'candidate media must qualify before promotion')
  assert.match(download, /await fs\.rename\(candidatePath, outPath\)/,
    'only a qualified candidate may atomically replace the active clip')
})

test('a Follow narration batch dispatches each saved duration, persists hold receipts, and keeps an active clip on a rejected replacement', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')

    await settings.setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    service.setVideoModels([{
      id: 'mock-video-v1', display_name: 'Mock Video', available: true,
      modes: ['image-to-video'], aspect_ratios: ['16:9'],
      variants: [
        { operation: 'image-to-video', duration_seconds: 1, resolution: '720p', credits_per_video: 10, minimum_credits: 10, price_version: 'mock-v1' },
        { operation: 'image-to-video', duration_seconds: 2, resolution: '720p', credits_per_video: 20, minimum_credits: 20, price_version: 'mock-v1' },
      ],
    }])
    clearGenStudioCatalogCache()
    service.queueScenario('video', { videoArtifact: tinyVideoBytes() })
    service.queueScenario('video', { videoArtifact: twoSecondVideoBytes() })

    const project = await pm.createProject({ name: 'Follow batch requests exact durations', episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Two duration clips', logline: 'A local mocked provider fixture.', themes: [],
      suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
    }], 'mock-chat-v1')
    assert.ok(idea)
    const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
    const episodeId = accepted.episode_code
    const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
    const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
    const imageDir = await resolveSceneImagesDir(project.slug, episodeId, paths.episode_dir)
    const firstImage = path.join(imageDir, 'scene-one.png')
    const secondImage = path.join(imageDir, 'scene-two.png')
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.mkdir(imageDir, { recursive: true })
    await Promise.all([
      fs.writeFile(firstImage, Buffer.from('mock-scene-image-one')),
      fs.writeFile(secondImage, Buffer.from('mock-scene-image-two')),
    ])
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    await fs.writeFile(planPath, JSON.stringify({ scenes: [
      { id: 'scene-one', scene_index: 1, start_sec: 0, end_sec: 0.7, approved: true, image_path: firstImage, motion_prompt: 'A still moon rises.' },
      { id: 'scene-two', scene_index: 2, start_sec: 0.7, end_sec: 2.1, approved: true, image_path: secondImage, motion_prompt: 'Clouds move past the moon.' },
    ] }))

    const job: any = {
      job_id: 'follow-duration-batch', project_slug: project.slug, type: 'scene_clip_batch',
      episode_id: episodeId, title: 'Follow duration test', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, error: null, output_lines: [],
      params: {
        episode_id: episodeId, model: 'mock-video-v1', operation: 'image-to-video',
        aspect_ratio: '16:9', resolution: '720p', duration_mode: 'follow_narration',
        scene_durations: {
          'scene-one': { duration_seconds: 1, narration_duration_seconds: 0.7 },
          'scene-two': { duration_seconds: 2, narration_duration_seconds: 1.4 },
        },
      },
    }
    await generateSceneClipsBatchJob(job)

    const submitted = service.submissions.filter(entry => entry.operation === 'video' && !entry.replay)
    assert.deepEqual(submitted.map(entry => ({
      duration: entry.parsedBody?.duration_seconds,
      resolution: entry.parsedBody?.resolution,
      mode: entry.parsedBody?.mode,
    })), [
      { duration: 1, resolution: '720p', mode: 'image-to-video' },
      { duration: 2, resolution: '720p', mode: 'image-to-video' },
    ])
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8'))
    assert.deepEqual(saved.scenes.map((scene: any) => ({
      id: scene.id,
      requested: scene.clip_requested_duration_seconds,
      measured: scene.clip_duration_seconds,
      shortfall: scene.clip_shortfall_mode,
    })), [
      { id: 'scene-one', requested: 1, measured: 1, shortfall: 'hold' },
      { id: 'scene-two', requested: 2, measured: 2, shortfall: 'hold' },
    ])

    const activePath = saved.scenes[0].clip_path
    const activeBytes = await fs.readFile(activePath)
    saved.scenes[0].motion_prompt = 'The moon now rises through windblown clouds.'
    await fs.writeFile(planPath, JSON.stringify(saved))
    service.queueScenario('video', { videoArtifact: Buffer.from('invalid replacement artifact') })
    const replacement = {
      ...job,
      job_id: 'follow-duration-replacement',
      output_lines: [],
      params: {
        ...job.params,
        scene_id: 'scene-one',
        scene_durations: {
          'scene-one': { duration_seconds: 1, narration_duration_seconds: 0.7 },
        },
      },
    }
    await assert.rejects(generateSceneClipJob(replacement), /Scene clip needs review/)
    assert.deepEqual(await fs.readFile(activePath), activeBytes,
      'a rejected provider artifact must leave the previous active clip intact')
    assert.ok((await fs.readdir(path.dirname(activePath))).some(name =>
      name.startsWith('.scene-one.follow-duration-replacement.candidate.mp4')),
    'the rejected candidate remains available for review')
  } finally {
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})
