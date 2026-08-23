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
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  IMAGE_EPISODE_CONCURRENCY_DEFAULT,
  IMAGE_EPISODE_CONCURRENCY_KEY,
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
    // The BULK image work that shares a budget is: Scene Review
    // (`continuity_render`), the thumbnail generator, and the image pool.
    //
    // `scene_image_generate` is deliberately NOT here. It is Scene Review's
    // single-scene repair — one image — and it keeps its own lane so a repair
    // never queues behind three bulk renders. Sharing the budget would make the
    // cheapest, most interactive request wait for the most expensive ones.
    for (const type of ['thumb_images', 'image_pool_generate', 'continuity_render']) {
      assert.ok(decl('const IMAGE_EPISODE_TYPES').includes(`'${type}'`), `${type} missing from image group`)
    }
    for (const type of ['video', 'scene_clip_generate', 'scene_clips_batch']) {
      assert.ok(decl('const VIDEO_EPISODE_TYPES').includes(`'${type}'`), `${type} missing from video group`)
    }
    for (const type of ['audio', 'music_generate']) {
      assert.ok(decl('const AUDIO_EPISODE_TYPES').includes(`'${type}'`), `${type} missing from audio group`)
    }
  })

  test('the three kinds have SEPARATE budgets, so one cannot starve another', async () => {
    // A fifty-episode image batch must not block a single narration job behind
    // it. Audio and image do not compete for the same fleet capability.
    const body = await read('services/job-queue.ts')
    assert.match(body, /const FLEET_EPISODE_GROUPS[\s\S]{0,200}?IMAGE_EPISODE_GROUP, VIDEO_EPISODE_GROUP, AUDIO_EPISODE_GROUP/)
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
  test('it defaults to 3 — busy, with headroom', () => {
    // 1 leaves the fleet idle, which is what he just hit. 30 is the 2026-08-22
    // transcription flood, where 122 of 353 items were refused. Three episodes
    // at ~25 concurrent requests is ~75 against a 128 ceiling.
    assert.equal(IMAGE_EPISODE_CONCURRENCY_DEFAULT, 3)
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
    assert.match(panel, /Episodes making images at once/)
    assert.match(panel, /image_episode_concurrency: Number\(imageEpisodes\.value\)/)
  })
})
