/**
 * The Introduction preview has to fill itself in.
 *
 * THE BUG THIS PINS. `generateForEpisode()` only ENQUEUES a job — its own
 * toast said "Queued. Watch it in Jobs." — and the page bumped the preview's
 * refresh key on the very next line. So `IntroductionPreview` reloaded at
 * QUEUE time, correctly found nothing on disk, and was never told again. The
 * panel then read "No introduction generated yet" until the operator reloaded
 * the page by hand. The owner: "i can't see the preview even after i click the
 * refresh. it should be automatic without me click the refresh though."
 *
 * A bumped key at queue time must not be enough to pass this file. The first
 * group exercises the real decision — which jobs are mine, which just reached
 * a terminal state, which I have already reacted to — as a pure function, so
 * "it refreshed at the wrong moment" is a failure and not a matter of reading
 * the diff carefully. The second group holds the wiring, including the two
 * things a unit test cannot see: that the queue-time bump is gone, and that no
 * timer was introduced to replace it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  INTRODUCTION_FAILED_FALLBACK,
  introductionInFlight,
  introductionJobSignal,
  settleIntroductionJobs,
  type IntroductionJobLike,
} from '../composables/useIntroductionJobWatch.js'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url)),
  'utf8',
)

const SLUG = 'terra'
const EPISODE = 'EP0007'

function job(overrides: Partial<IntroductionJobLike> & { job_id: string }): IntroductionJobLike {
  return {
    type: 'introduction-only',
    status: 'queued',
    episode_id: EPISODE,
    project_slug: SLUG,
    ...overrides,
  }
}

describe('the preview reacts to the job ending, not to it being queued', () => {
  test('a job that is only queued or running settles nothing', () => {
    const settled = new Set<string>()
    const jobs = [job({ job_id: 'a', status: 'queued' }), job({ job_id: 'b', status: 'running' })]
    assert.deepEqual(settleIntroductionJobs(jobs, SLUG, EPISODE, settled), [],
      'refreshing at queue time is the whole defect — "not yet" is not an outcome')
    assert.deepEqual([...settled].sort(), ['a', 'b'], 'unfinished jobs are now being watched')
    assert.equal(introductionInFlight(jobs, SLUG, EPISODE), true)
  })

  test('the same job reaching done settles exactly once, however often it is re-emitted', () => {
    const settled = new Set<string>()
    const running = [job({ job_id: 'a', status: 'running' })]
    assert.deepEqual(settleIntroductionJobs(running, SLUG, EPISODE, settled), [])

    const done = [job({ job_id: 'a', status: 'done' })]
    assert.deepEqual(settleIntroductionJobs(done, SLUG, EPISODE, settled), [{ job_id: 'a', outcome: 'done' }])
    // The SSE stream re-emits terminal jobs (account attribution writes after
    // the job settles); a second refresh would be harmless but a second toast
    // would not be.
    assert.deepEqual(settleIntroductionJobs(done, SLUG, EPISODE, settled), [])
    assert.equal(introductionInFlight(done, SLUG, EPISODE), false)
  })

  test('a job that had already finished when first seen is history, not news', () => {
    const settled = new Set<string>()
    const history = [
      job({ job_id: 'old-error', status: 'error', error: 'provider returned 503' }),
      job({ job_id: 'old-done', status: 'done' }),
    ]
    assert.deepEqual(settleIntroductionJobs(history, SLUG, EPISODE, settled), [],
      'replaying old results toasted and painted a stale red error on every visit')
  })

  test('a failed job is a different answer from an empty panel, and carries the reason', () => {
    const settled = new Set<string>(['a'])
    const failed = [job({ job_id: 'a', status: 'error', error: 'provider returned 503' })]
    assert.deepEqual(settleIntroductionJobs(failed, SLUG, EPISODE, settled),
      [{ job_id: 'a', outcome: 'error', message: 'provider returned 503' }])
  })

  test('a failure with no reason still says it failed rather than going quiet', () => {
    const settled = new Set<string>(['a'])
    const [transition] = settleIntroductionJobs(
      [job({ job_id: 'a', status: 'error', error: '   ' })], SLUG, EPISODE, settled)
    assert.equal(transition!.outcome, 'error')
    assert.equal(transition!.message, INTRODUCTION_FAILED_FALLBACK)
  })

  test('another episode, another project, or another job type is not mine', () => {
    const settled = new Set<string>(['a', 'b', 'c'])
    const strangers = [
      job({ job_id: 'a', status: 'done', episode_id: 'EP0008' }),
      job({ job_id: 'b', status: 'done', project_slug: 'other' }),
      job({ job_id: 'c', status: 'done', type: 'script-only' }),
    ]
    assert.deepEqual(settleIntroductionJobs(strangers, SLUG, EPISODE, settled), [])
    assert.equal(introductionInFlight(strangers, SLUG, EPISODE), false)
  })

  test('with no episode chosen nothing is mine, so nothing fires', () => {
    const settled = new Set<string>(['a'])
    assert.deepEqual(settleIntroductionJobs([job({ job_id: 'a', status: 'done' })], SLUG, '', settled), [])
  })

  test('the watched signal changes on a transition and not on progress noise', () => {
    const before = introductionJobSignal([job({ job_id: 'a', status: 'running' })], SLUG, EPISODE)
    // Same job, same status, more output — a deep watch fires here hundreds of
    // times a second and froze the sidebar once already.
    const noisier = introductionJobSignal(
      [{ ...job({ job_id: 'a', status: 'running' }), error: undefined }], SLUG, EPISODE)
    assert.equal(before, noisier)
    assert.notEqual(before, introductionJobSignal([job({ job_id: 'a', status: 'done' })], SLUG, EPISODE))
  })
})

describe('the page is wired to that decision', () => {
  test('the refresh key is not bumped when the job is merely queued', () => {
    const enqueue = page.slice(page.indexOf('async function generateForEpisode'))
    const body = enqueue.slice(0, enqueue.indexOf('\n}\n'))
    assert.match(body, /generate\/introduction-only/)
    assert.doesNotMatch(body, /previewRefreshKey\.value\s*\+/,
      'bumping at queue time reloads the panel at the one moment there is nothing to find')
  })

  test('completion is what bumps it, through the extracted decision', () => {
    assert.match(page, /settleIntroductionJobs/)
    assert.match(page, /watch\(introductionJobSignal/)
    assert.match(page, /previewRefreshKey\.value \+= 1/)
    assert.match(page, /introFailure/)
  })

  test('the page adds no finish toast of its own — the global job stream already announces it', () => {
    const watcher = page.slice(page.indexOf('watch(introductionJobSignal'))
    const body = watcher.slice(0, watcher.indexOf('\n})'))
    assert.doesNotMatch(body, /success\(|showError\(/)
  })

  test('the page cannot enqueue a generated replacement while a manual save is active', () => {
    assert.match(page, /@saving-change="onPreviewSavingChange"/)
    assert.match(page, /:generate-disabled="!canGenerateIntroduction"/)
    assert.match(page, /if \(!canGenerateIntroduction\.value\) return/)
    assert.match(page, /previewSaving.value = saving/)
    assert.match(page, /!previewSaving.value/)
  })

  test('an idle page makes no requests of its own', () => {
    assert.doesNotMatch(page, /setInterval|setTimeout\s*\(\s*[^,]*,\s*\d{3,}/,
      'the completion signal is the job stream, not a timer that runs forever')
  })
})
