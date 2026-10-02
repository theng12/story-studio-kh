/**
 * v1.4.40 — how wide one job may run: read from the account, not guessed.
 *
 * MEASURED 2026-08-23. The owner asked whether his 41 fleet machines were all
 * working during a 50-episode Scene Review batch. They were not:
 *
 *   one episode of 108 images running EXACTLY 50
 *   GenStudio: 49 running, 1 dispatched, ZERO queued
 *   his account's published burst ceiling: 128
 *
 * Nothing was full, nothing was throttling, nothing was waiting. Story Studio
 * simply never offered more than fifty, because fifty was a constant in
 * genstudio-runtime.ts. Two thirds of his paid capacity sat unused, and the
 * only symptom was a batch that took longer than it needed to.
 *
 * Staging more is safe BY CONSTRUCTION: GenStudio owns admission. It runs what
 * it can and queues the rest, so Story cannot flood it — it can only fail to
 * offer enough work. The honest width is therefore what the account publishes.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFile(path.join(SERVER, rel), 'utf8')

describe('the width follows the account', () => {
  test('the exact Scene Review case that was measured: 108 images, keyed burst 128', () => {
    assert.equal(resolveGenStudioLocalFanout(108, 128), 108,
      'the whole episode goes out at once; The Gateway decides what actually runs')
  })

  test('a bigger episode than the ceiling is capped at the ceiling', () => {
    assert.equal(resolveGenStudioLocalFanout(400, 128), 128)
  })

  test('a small episode is never padded up to the ceiling', () => {
    assert.equal(resolveGenStudioLocalFanout(7, 128), 7)
  })

  test('a raised ceiling raises the width with nothing to remember', () => {
    // His fleet grows most weeks. When GenStudio raises the ceiling, this
    // follows on its own — that is the point of reading it rather than
    // storing another number he has to maintain.
    assert.equal(resolveGenStudioLocalFanout(500, 256), 256)
  })
})

describe('unknown stays conservative, never unlimited', () => {
  test('no published ceiling stages one item until capacity is known', () => {
    assert.equal(resolveGenStudioLocalFanout(108, undefined), 1)
    assert.equal(resolveGenStudioLocalFanout(108), 1)
  })

  test('a malformed or absurd ceiling is refused, not trusted', () => {
    for (const bad of [0, -5, 1.5, NaN, null, '128', 'lots', {}]) {
      assert.equal(resolveGenStudioLocalFanout(108, bad as unknown), 1,
        `ceiling ${String(bad)} must stay conservative rather than be guessed`)
    }
  })

  test('it never returns zero, whatever it is handed', () => {
    // A zero width would stall a job for ever rather than run it slowly.
    assert.equal(resolveGenStudioLocalFanout(0, 128), 1)
    assert.equal(resolveGenStudioLocalFanout(-3, 128), 1)
  })
})

describe('every generator uses the keyed publication for its staging workload', () => {
  test('video and subtitles stage from their keyed account ceiling', async () => {
    for (const [file, call] of [
      ['generators/ai-video.ts', 'prompts.length'],
      ['generators/subtitles.ts', 'sections.length'],
    ] as const) {
      const body = await read(file)
      assert.match(
        body,
        new RegExp(`resolveGenStudioLocalFanout\\(\\s*\\n?\\s*${call.replace('.', '\\.')},[\\s\\S]{0,200}?burst_concurrency_ceiling`),
        `${file} still stages a constant width instead of the account's published ceiling`,
      )
      assert.match(body, /refreshGenStudioAdmission\(/, `${file} must refresh the keyed advisory before staging`)
      assert.doesNotMatch(body, /jq\.getImageFanoutOverride\(\)/, `${file} must not reuse the image dial`)
    }
  })

  test('image workers use the keyed live burst as local staging only because permits own remote admission', async () => {
    for (const [file, call] of [
      ['generators/images.ts', 'items.length'],
      ['generators/continuity-render.ts', 'scenes.length'],
    ] as const) {
      const body = await read(file)
      assert.match(
        body,
        new RegExp(`resolveGenStudioLocalFanout\\(\\s*\\n?\\s*${call.replace('.', '\\.')},\\s*\\n?\\s*admission\\.burst_concurrency_ceiling,`),
      )
      assert.match(body, /refreshGenStudioAdmission\(/)
    }
  })

  test('unknown capacity is documented as conservative staging', async () => {
    const body = await read('lib/genstudio-runtime.ts')
    assert.match(body, /Unknown capacity stays conservative/)
    assert.doesNotMatch(body, /GENSTUDIO_LOCAL_ADMISSION_MAX/)
  })
})

describe('the owner can override it in either direction', () => {
  test('an explicit number wins over the published ceiling', () => {
    // Lower, to leave headroom for something else.
    assert.equal(resolveGenStudioLocalFanout(108, 128, 20), 20)
  })

  test('it may also go HIGHER than the ceiling', () => {
    // Staging more than GenStudio will start is safe — it queues the surplus
    // rather than refusing it — so the setting is not clamped to the ceiling.
    assert.equal(resolveGenStudioLocalFanout(400, 128, 300), 300)
  })

  test('an override never pads a small episode', () => {
    assert.equal(resolveGenStudioLocalFanout(7, 128, 300), 7)
  })

  test('"auto" (0 / absent / junk) falls back to the published ceiling', () => {
    for (const auto of [0, undefined, null, 'auto', NaN, -1]) {
      assert.equal(resolveGenStudioLocalFanout(108, 128, auto as unknown), 108,
        `override ${String(auto)} must mean "follow the account"`)
    }
  })

  test('with no ceiling AND no override, staging remains conservative', () => {
    assert.equal(resolveGenStudioLocalFanout(108, undefined, 0), 1)
  })
})

describe('the override is reachable, not just present', () => {
  test('it is a stored setting with a route and a screen', async () => {
    const settings = await read('services/app-settings.ts')
    assert.match(settings, /IMAGE_FANOUT_KEY = 'image_fanout_per_episode'/)
    assert.match(settings, /export async function setImageFanout/)
    const route = await read('routes/app-settings.ts')
    assert.match(route, /image_fanout_per_episode: await getImageFanout\(\)/)
    assert.match(route, /jq\.setImageFanoutOverride/, 'it must apply to the live queue, not only store')
    const panel = await readFile(
      path.join(SERVER, '..', '..', 'frontend', 'components', 'ThisMacSettings.vue'), 'utf8')
    assert.match(panel, /Cloud requests per episode at once/)
  })

  test('the screen names the image fan-outs this dial governs, not unrelated modalities', async () => {
    const panel = await readFile(
      path.join(SERVER, '..', '..', 'frontend', 'components', 'ThisMacSettings.vue'), 'utf8')
    const field = panel.slice(panel.indexOf("key: 'imageFanout'"))
      .slice(0, panel.slice(panel.indexOf("key: 'imageFanout'")).indexOf('choices:'))
    assert.match(field, /image/i)
    assert.match(field, /thumbnail/i)
    assert.doesNotMatch(field, /subtitle/i)
    assert.doesNotMatch(field, /video/i)
    assert.doesNotMatch(field, /continuity/i)
  })

  test('boot applies it, or it is a number in a file nobody reads', async () => {
    const boot = await read('boot/migrations.ts')
    assert.match(boot, /getImageFanout/)
    assert.match(boot, /setImageFanoutOverride/)
  })

  test('only image fan-outs pass the image override', async () => {
    for (const file of ['generators/images.ts', 'generators/continuity-render.ts']) {
      assert.match(await read(file), /jq\.getImageFanoutOverride\(\)/,
        `${file} ignores the owner's override`)
    }
    for (const file of ['generators/ai-video.ts', 'generators/subtitles.ts']) {
      assert.doesNotMatch(await read(file), /jq\.getImageFanoutOverride\(\)/,
        `${file} must not inherit the image override`)
    }
  })
})
