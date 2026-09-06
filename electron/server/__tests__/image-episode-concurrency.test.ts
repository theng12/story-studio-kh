/**
 * v1.4.39 — how many episodes may generate images at once.
 *
 * MEASURED ON THE OWNER'S OWN BATCH, 2026-08-23. He queued 50 Scene Review jobs
 * at 100+ images an episode and asked whether all his machines were working.
 * They were not:
 *
 *   74 fleet workers online, 21 busy, 51 idle
 *   a location connected that morning: 20 workers online, ONE busy
 *   GenStudio: 25 jobs running against a burst ceiling of 128
 *
 * Neither the fleet nor GenStudio was the limit. Story Studio ran the episodes
 * ONE AT A TIME, because `groupLimit()` returns 1 for every type outside the LLM
 * and subtitle groups — a single boolean slot per lane. Fifty queued episodes
 * were strictly serial, and each episode's internal fan-out was the only
 * parallelism in the whole system.
 *
 * This is the THIRD lane with the same story (subtitles 1.4.23, writing 1.4.27),
 * and the first found by measuring rather than by the owner reporting a failure.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

import {
  IMAGE_EPISODE_CONCURRENCY_DEFAULT,
  IMAGE_EPISODE_CONCURRENCY_KEY,
  getImageEpisodeConcurrency,
  setImageEpisodeConcurrency,
} from '../services/app-settings.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFile(path.join(SERVER, rel), 'utf8')

describe('every kind of fleet work is pipelined, not just images', () => {
  test('SCENE REVIEW is in the image group — 1.4.39 missed it', async () => {
    // The owner had 50 `continuity_render` jobs queued when he asked why his
    // machines were idle, and the first version of this fix did not include
    // that type. It would have missed the exact batch that prompted it. He
    // found that, not a test.
    const body = await read('services/job-queue.ts')
    const group = body.slice(body.indexOf('const IMAGE_EPISODE_TYPES'))
    const decl = group.slice(0, group.indexOf('])'))
    assert.ok(decl.includes("'continuity_render'"),
      'Scene Review buys images from the fleet and must pipeline like the rest')
  })

  test('every type that buys from the fleet belongs to a group', async () => {
    const body = await read('services/job-queue.ts')
    const decl = (marker: string) => {
      const from = body.slice(body.indexOf(marker))
      return from.slice(0, from.indexOf('])'))
    }
    // v1.4.41 — `scene_images` and `images` went with the retired generator.
    // v1.4.49 — `thumb_images` moved to its OWN lane: it usually buys from a
    // cloud API while Scene Review buys from the local fleet, so three
    // thumbnail episodes must not consume the budget the fleet is waiting on.
    //
    // `scene_image_generate` is deliberately NOT here. It is Scene Review's
    // single-scene repair — one image — and it keeps its own lane so a repair
    // never queues behind three bulk renders. Sharing the budget would make the
    // cheapest, most interactive request wait for the most expensive ones.
    for (const type of ['image_pool_generate', 'continuity_render']) {
      assert.ok(decl('const IMAGE_EPISODE_TYPES').includes(`'${type}'`), `${type} missing from image group`)
    }
    assert.ok(!decl('const IMAGE_EPISODE_TYPES').includes("'thumb_images'"),
      'thumbnails share no budget with the local fleet')
    assert.ok(decl('const THUMBNAIL_EPISODE_TYPES').includes("'thumb_images'"))
    for (const type of ['video', 'scene_clip_generate', 'scene_clips_batch']) {
      assert.ok(decl('const VIDEO_EPISODE_TYPES').includes(`'${type}'`), `${type} missing from video group`)
    }
    for (const type of ['audio', 'music_generate']) {
      assert.ok(decl('const AUDIO_EPISODE_TYPES').includes(`'${type}'`), `${type} missing from audio group`)
    }
  })

  test('the reason scene_image_generate is excluded sits WHERE THE SET IS EDITED', async () => {
    // Proposed as a missing entry twice now (2026-08-23, 2026-08-26), both times
    // on the premise that "Generate all missing" fans out one job per scene.
    // It does not. The reason lived only down here in the test file, twenty
    // lines below the assertion each reader actually opened, so it was missed
    // both times. It now lives beside the declaration as well — because that is
    // the line someone is looking at when they decide to add a type.
    const body = await read('services/job-queue.ts')
    const preamble = body.slice(0, body.indexOf('const IMAGE_EPISODE_TYPES'))
    const reason = preamble.slice(preamble.lastIndexOf('/**'))
    assert.match(reason, /scene_image_generate/,
      'the exclusion must be explained next to the set, not only in this file')
    assert.match(reason, /generate-missing/,
      'the explanation must name the route whose behaviour the decision rests on')
  })

  test('the bulk path enqueues ONE render, which is why the small type stays out', async () => {
    // The load-bearing fact. If "Generate all missing" ever goes back to
    // queueing a job per scene, `scene_image_generate` becomes the largest
    // fan-out in the app and its own lane becomes the 2026-08-23 bug again.
    // This is the assertion that makes that change impossible to land quietly.
    const routes = await read('routes/scene-review.ts')
    const handler = routes.slice(routes.indexOf("/generate-missing'"))
    const body = handler.slice(0, handler.indexOf("/generate-missing-clips'"))
    assert.match(body, /enqueueMissingScenes\(/,
      'generate-missing must batch into one continuity_render, not one job per scene')
    const helper = routes.slice(routes.indexOf('async function enqueueMissingScenes'), routes.indexOf("/generate-missing'"))
    assert.match(helper, /enqueueContinuityRender\(/,
      'the shared missing-image handler must enqueue one continuity_render')
    assert.doesNotMatch(body, /type: 'scene_image_generate'[^,]*,\s*\n\s*episode_id/,
      'generate-missing must not enqueue per-scene scene_image_generate jobs')
  })

  test('the three kinds have SEPARATE budgets, so one cannot starve another', async () => {
    // A fifty-episode image batch must not block a single narration job behind
    // it. Audio and image do not compete for the same fleet capability.
    const body = await read('services/job-queue.ts')
    assert.match(body, /const FLEET_EPISODE_GROUPS[\s\S]{0,200}?IMAGE_EPISODE_GROUP, THUMBNAIL_EPISODE_GROUP, VIDEO_EPISODE_GROUP, AUDIO_EPISODE_GROUP/)
    assert.match(body, /if \(FLEET_EPISODE_GROUPS\.has\(group\)\) return imageEpisodeConcurrency/,
      'one dial, applied per kind')
  })

  test('local-only work is deliberately excluded', async () => {
    // music_video, broll_normalize and video_assembly are CPU on this Mac, not
    // fleet capacity. Running three at once would fight the machine the owner
    // is working on.
    const body = await read('services/job-queue.ts')
    const from = body.slice(body.indexOf('const IMAGE_EPISODE_TYPES'))
    const decls = from.slice(0, from.indexOf('function fleetEpisodeTypesFor'))
    for (const local of ['music_video', 'broll_normalize', 'video_assembly']) {
      assert.ok(!decls.includes(`'${local}'`), `${local} is local work and must not take a fleet slot`)
    }
  })

  test('types within one kind share a budget rather than getting a lane each', async () => {
    // Five image lanes of three would be fifteen episodes, and the number
    // nobody set is the one that bites.
    const body = await read('services/job-queue.ts')
    assert.match(body, /if \(IMAGE_EPISODE_TYPES\.has\(type\)\) return IMAGE_EPISODE_GROUP/)
    assert.match(body, /if \(THUMBNAIL_EPISODE_TYPES\.has\(type\)\) return THUMBNAIL_EPISODE_GROUP/)
    assert.match(body, /if \(VIDEO_EPISODE_TYPES\.has\(type\)\) return VIDEO_EPISODE_GROUP/)
    assert.match(body, /if \(AUDIO_EPISODE_TYPES\.has\(type\)\) return AUDIO_EPISODE_GROUP/)
  })

  test('a freed slot can be taken by any image type, not just the one that finished', async () => {
    const body = await read('services/job-queue.ts')
    assert.match(body, /else if \(FLEET_EPISODE_GROUPS\.has\(group\)\) for \(const t of fleetEpisodeTypesFor\(group\)\) pump\(t\)/)
  })

  test('the group is pumped and released like the other budgeted groups', async () => {
    const body = await read('services/job-queue.ts')
    // Both the launcher and the slot release must recognise it, or slots leak
    // and the lane wedges at zero.
    assert.equal(
      (body.match(/group === SUBTITLE_TRANSCRIBE_GROUP \|\| FLEET_EPISODE_GROUPS\.has\(group\)/g) || []).length,
      2,
      'pump() and releaseSlot() must both treat it as a budgeted group',
    )
  })
})

describe('the number is the owner\'s, not the code\'s', () => {
  test('a fresh or missing scene-image setting uses 2 while a saved 3 remains 3', async () => {
    const isolated = await useTempDataDir()
    try {
      assert.equal(IMAGE_EPISODE_CONCURRENCY_DEFAULT, 2)
      assert.equal(await getImageEpisodeConcurrency(), 2, 'missing settings use the recommended value')
      await setImageEpisodeConcurrency(3)
      assert.equal(await getImageEpisodeConcurrency(), 3, 'an explicit previous choice is never rewritten')
    } finally {
      await isolated.cleanup()
    }
  })

  test('custom scene-image settings use the existing whole-number 1–50 contract', async () => {
    const isolated = await useTempDataDir()
    try {
      for (const value of [2, 1, 50]) {
        assert.equal(await setImageEpisodeConcurrency(value), value)
        assert.equal(await getImageEpisodeConcurrency(), value)
      }
      await assert.rejects(() => setImageEpisodeConcurrency(0), /whole number between 1 and 50/)
      await assert.rejects(() => setImageEpisodeConcurrency(51), /whole number between 1 and 50/)
    } finally {
      await isolated.cleanup()
    }
  })

  test('it is a stored setting with a stable key', () => {
    assert.equal(IMAGE_EPISODE_CONCURRENCY_KEY, 'image_episode_concurrency')
  })

  test('the queue starts at 1, so an unapplied setting changes nothing', async () => {
    // Today's behaviour exactly. boot reads the stored value and raises it;
    // a build that never applies it is unchanged rather than surprising.
    const body = await read('services/job-queue.ts')
    assert.match(body, /let imageEpisodeConcurrency = 1/)
  })

  test('boot applies it, or the setting is a number in a file nobody reads', async () => {
    const body = await read('boot/migrations.ts')
    assert.match(body, /getImageEpisodeConcurrency/)
    assert.match(body, /setImageEpisodeConcurrency\(n\)/)
    assert.match(body, /episodes generating images at once/)
  })

  test('the route reads AND writes it, and applies it to the live queue', async () => {
    const body = await read('routes/app-settings.ts')
    assert.match(body, /image_episode_concurrency: await getImageEpisodeConcurrency\(\)/)
    assert.match(body, /jq\.setImageEpisodeConcurrency\(n\)/,
      'storing it without applying it means the change does nothing until a restart')
  })

  test('it has a screen — the last two settings did not, and that was the bug', async () => {
    const panel = await readFile(
      path.join(SERVER, '..', '..', 'frontend', 'components', 'ThisMacSettings.vue'), 'utf8')
    assert.match(panel, /Episodes making scene images at once/, 'the owner must be able to see the setting')
    // v1.4.44 — assert the LABEL and the request field, not the internal ref
    // name. The 1.4.42 panel rewrite moved these to one reactive object and
    // this assertion started matching a variable that no longer existed. The
    // setting still worked; only the copy of the source in the test was stale.
    assert.match(panel, /image_episode_concurrency: Number\(models\.imageEpisodes\)/,
      'and the screen must actually send it')
  })
})

/**
 * v1.4.49 — thumbnails are their own lane.
 *
 * The owner, looking at his own job list: "i just realized that thumbnail and
 * scene review share the same lane. they shouldn't because thumbnail usually
 * is me using cloud api while for the scene review i'll usually use my local
 * flux 2 klein. can we split the 2 so a 3 thumbnail generation doesn't block
 * my local fleet?"
 *
 * Right, and the 1.4.41 comment already contained the principle without going
 * far enough: separate budgets exist because two kinds of work do not compete
 * for the same capacity. Three thumbnail episodes on a cloud API consumed the
 * whole image budget while forty-one local machines waited for a slot they
 * were never going to take.
 */
describe('thumbnails do not spend the local fleet\'s budget', () => {
  test('thumb_images is in its own group, not the image group', async () => {
    const body = await read('services/job-queue.ts')
    const decl = (marker: string) => {
      const from = body.slice(body.indexOf(marker))
      return from.slice(0, from.indexOf('])'))
    }
    assert.ok(decl('const THUMBNAIL_EPISODE_TYPES').includes("'thumb_images'"))
    assert.ok(!decl('const IMAGE_EPISODE_TYPES').includes("'thumb_images'"))
    // And Scene Review keeps the lane it needs.
    assert.ok(decl('const IMAGE_EPISODE_TYPES').includes("'continuity_render'"))
  })

  test('it has its own budget, read before the shared fleet number', async () => {
    const body = await read('services/job-queue.ts')
    // Order matters: the thumbnail check must come FIRST, or the shared
    // `FLEET_EPISODE_GROUPS` branch would answer for it and the split would be
    // cosmetic.
    assert.match(
      body,
      /if \(group === THUMBNAIL_EPISODE_GROUP\) return thumbnailEpisodeConcurrency\n\s*if \(FLEET_EPISODE_GROUPS\.has\(group\)\) return imageEpisodeConcurrency/,
    )
  })

  test('a freed thumbnail slot pumps thumbnails, not scene renders', async () => {
    const body = await read('services/job-queue.ts')
    assert.match(body, /if \(group === THUMBNAIL_EPISODE_GROUP\) return THUMBNAIL_EPISODE_TYPES/)
  })

  test('the number is stored, applied at boot, routed, and on the screen', async () => {
    const settings = await read('services/app-settings.ts')
    assert.match(settings, /THUMBNAIL_EPISODE_CONCURRENCY_KEY = 'thumbnail_episode_concurrency'/)
    assert.match(settings, /export async function setThumbnailEpisodeConcurrency/)
    const boot = await read('boot/migrations.ts')
    assert.match(boot, /setThumbnailEpisodeConcurrency\(thumbs\)/)
    const route = await read('routes/app-settings.ts')
    assert.match(route, /thumbnail_episode_concurrency: await getThumbnailEpisodeConcurrency\(\)/)
    assert.match(route, /jq\.setThumbnailEpisodeConcurrency\(n\)/,
      'storing it without applying it means the change does nothing until a restart')
    const panel = await readFile(
      path.join(SERVER, '..', '..', 'frontend', 'components', 'ThisMacSettings.vue'), 'utf8')
    assert.match(panel, /Episodes making thumbnails at once/)
    assert.match(panel, /thumbnail_episode_concurrency: Number\(models\.thumbnailEpisodes\)/)
  })

  test('the two lanes are described as separate on screen, not as one', async () => {
    const panel = await readFile(
      path.join(SERVER, '..', '..', 'frontend', 'components', 'ThisMacSettings.vue'), 'utf8')
    // The old help text said "Scene Review, Thumbnails and Image Pool share
    // this", which is now false and would send him to the wrong dial.
    assert.ok(!panel.includes('Scene Review, Thumbnails and Image Pool share this'))
    assert.match(panel, /Thumbnails have their own number below/)
  })
})

/**
 * v1.4.81 — WHO GETS THE LANES BACK after a restart.
 *
 * MEASURED ON THE OWNER'S OWN BATCH, 2026-08-29. He queued 44 Scene Review jobs
 * at 11:06, three started on his three lanes, and he force-quit at 11:14 to see
 * what would happen. On relaunch he had SIX running against three lanes:
 *
 *   DK0054/55/56  started 04:06:54Z — interrupted, still showing `running`
 *   DK0057/58/59  started 04:35:41Z — brand new, two seconds after boot
 *
 * `groupActive` is in-memory and resets to zero on boot, and the interrupted
 * three had been parked on the reconcile-only path, which takes no slot by
 * design. So the scheduler saw three empty lanes and filled them with never-
 * started episodes, while the interrupted ones — holding ~254 images he had
 * already paid for — sat there making no progress at all.
 *
 * The fix is not a scheduler change. Interrupted image jobs now rejoin
 * `pending` during load, BEFORE the boot pump runs, so ordinary FIFO hands them
 * their lanes back first. This test is the proof, and it is behavioural on
 * purpose: the rest of this file reads source text, but "who actually starts"
 * is not a claim source text can settle.
 */
describe('after a restart the interrupted episodes get the lanes back first', () => {
  let tempDir: string
  let cleanup: () => Promise<void>
  let jq: typeof import('../services/job-queue.js')
  let pm: typeof import('../services/project-manager.js')

  before(async () => {
    const t = await useTempDataDir()
    tempDir = t.dir
    cleanup = t.cleanup
    pm = await import('../services/project-manager.js')
    jq = await import('../services/job-queue.js')
  })

  after(async () => {
    jq.setImageEpisodeConcurrency(IMAGE_EPISODE_CONCURRENCY_DEFAULT)
    await cleanup()
  })

  test('never-started episodes wait while the interrupted ones resume', async () => {
    jq.setImageEpisodeConcurrency(3)
    const project = await pm.createProject({ name: 'Restart Lane Order' })
    const jobsFile = path.join(tempDir, 'projects', project.slug, 'jobs.json')

    const started: string[] = []
    const releases: Array<() => void> = []
    let draining = false
    jq.registerExecutor('continuity_render', async (job) => {
      started.push(job.job_id)
      if (draining) return
      await new Promise<void>(resolve => releases.push(resolve))
    })

    const at = (seconds: number) => new Date(Date.UTC(2026, 7, 29, 4, 6, seconds)).toISOString()
    // Written in the order the owner's own jobs.json holds them: creation order,
    // so the three that had already started come first.
    const interrupted = ['DK0054', 'DK0055', 'DK0056'].map((episode, index) => ({
      job_id: `interrupted-${episode}`,
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: episode,
      title: `[batch] scene_review — ${episode}`,
      status: 'running',
      created_at: at(54 + index),
      started_at: at(54 + index),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
      remote_cancellations: {},
      // Finished while the app was dead, and never downloaded. This is the work
      // that must not queue behind a fresh episode. Settled evidence only, so
      // the job runs to completion here without scheduling provider polling
      // this test has no business exercising.
      genstudio_jobs: [
        { id: `job_${episode}_paid`, operation: 'image.generation', state: 'succeeded', updated_at: at(58) },
      ],
    }))
    const neverStarted = ['DK0057', 'DK0058', 'DK0059'].map((episode, index) => ({
      job_id: `never-started-${episode}`,
      project_slug: project.slug,
      type: 'continuity_render',
      episode_id: episode,
      title: `[batch] scene_review — ${episode}`,
      status: 'queued',
      created_at: at(57 + index),
      started_at: null,
      finished_at: null,
      error: null,
      output_lines: [],
      params: {},
      remote_cancellations: {},
    }))
    await writeFile(jobsFile, JSON.stringify({ jobs: [...interrupted, ...neverStarted] }))

    await jq.getJobs(project.slug)
    await waitFor(() => started.length >= 3, { label: 'three image lanes to be claimed' })

    // Three lanes, six candidates. The interrupted three take all three.
    assert.deepEqual([...started].sort(), [
      'interrupted-DK0054', 'interrupted-DK0055', 'interrupted-DK0056',
    ])
    // And the fresh episodes are still waiting their turn, which is the whole
    // point: he saw six running against three lanes, and now cannot.
    for (const episode of ['DK0057', 'DK0058', 'DK0059']) {
      assert.equal(jq.getJob(`never-started-${episode}`)?.status, 'queued')
    }

    // Drain before the temp data dir is torn down: a job still finishing after
    // cleanup would try to persist into a directory that no longer exists.
    draining = true
    for (const release of releases) release()
    const allIds = [...interrupted, ...neverStarted].map(job => job.job_id)
    await waitFor(
      () => allIds.every(id => ['done', 'error', 'cancelled'].includes(jq.getJob(id)?.status || '')),
      { label: 'every queued render to reach a terminal status before teardown' },
    )
  })
})
