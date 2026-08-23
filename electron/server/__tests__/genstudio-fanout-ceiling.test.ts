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

import {
  GENSTUDIO_LOCAL_ADMISSION_MAX,
  resolveGenStudioLocalFanout,
} from '../lib/genstudio-runtime.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFile(path.join(SERVER, rel), 'utf8')

describe('the width follows the account', () => {
  test('the exact case that was measured: 108 images, ceiling 128', () => {
    assert.equal(resolveGenStudioLocalFanout(108, 128), 108,
      'the whole episode goes out at once; GenStudio decides what actually runs')
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
  test('no published ceiling falls back to the old constant', () => {
    assert.equal(resolveGenStudioLocalFanout(108, undefined), GENSTUDIO_LOCAL_ADMISSION_MAX)
    assert.equal(resolveGenStudioLocalFanout(108), GENSTUDIO_LOCAL_ADMISSION_MAX)
  })

  test('a malformed or absurd ceiling is refused, not trusted', () => {
    for (const bad of [0, -5, 1.5, NaN, null, 'lots', {}]) {
      assert.equal(resolveGenStudioLocalFanout(108, bad as unknown), GENSTUDIO_LOCAL_ADMISSION_MAX,
        `ceiling ${String(bad)} must fall back rather than be believed`)
    }
  })

  test('it never returns zero, whatever it is handed', () => {
    // A zero width would stall a job for ever rather than run it slowly.
    assert.equal(resolveGenStudioLocalFanout(0, 128), 1)
    assert.equal(resolveGenStudioLocalFanout(-3, 128), 1)
  })
})

describe('every generator that fans out reads the ceiling', () => {
  test('images, scene review, video and subtitles all pass it', async () => {
    for (const [file, call] of [
      ['generators/images.ts', 'items.length'],
      ['generators/continuity-render.ts', 'scenes.length'],
      ['generators/ai-video.ts', 'prompts.length'],
      ['generators/subtitles.ts', 'sections.length'],
    ] as const) {
      const body = await read(file)
      assert.match(
        body,
        new RegExp(`resolveGenStudioLocalFanout\\(\\s*\\n?\\s*${call.replace('.', '\\.')},[\\s\\S]{0,200}?burst_concurrency_ceiling`),
        `${file} still stages a constant width instead of the account's published ceiling`,
      )
    }
  })

  test('the constant is documented as a fallback, not the normal cap', async () => {
    const body = await read('lib/genstudio-runtime.ts')
    assert.match(body, /used ONLY when GenStudio has published no ceiling/)
    assert.match(body, /It is no longer the normal cap/)
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

  test('with no ceiling AND no override, the old constant still applies', () => {
    assert.equal(resolveGenStudioLocalFanout(108, undefined, 0), GENSTUDIO_LOCAL_ADMISSION_MAX)
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
    assert.match(panel, /Images per episode at once/)
  })

  test('boot applies it, or it is a number in a file nobody reads', async () => {
    const boot = await read('boot/migrations.ts')
    assert.match(boot, /getImageFanout/)
    assert.match(boot, /setImageFanoutOverride/)
  })

  test('every fan-out site passes the override, not just some', async () => {
    for (const file of [
      'generators/images.ts', 'generators/continuity-render.ts',
      'generators/ai-video.ts', 'generators/subtitles.ts',
    ]) {
      assert.match(await read(file), /jq\.getImageFanoutOverride\(\)/,
        `${file} ignores the owner's override`)
    }
  })
})
