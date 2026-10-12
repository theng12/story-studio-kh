/**
 * Free-disk-space precheck for batch runs.
 *
 * A 20-episode 1080p/high
 * batch averages 500 MB-1 GB per episode. A nearly-full disk causes the
 * batch to fail halfway through after burning encode cost. These tests
 * pin three invariants:
 *
 *   1. `getFreeBytes('/tmp')` returns a positive number on a healthy
 *      system — confirms our `fs.statfs` call resolves to real bytes
 *      and didn't silently fall back to the 0-on-error path.
 *   2. `estimateRunBatchBytes` produces a sensible number for a
 *      10-episode 1080p/medium video_assembly batch — bounded above
 *      and below to catch arithmetic regressions.
 *   3. The `run-batch` route returns 400 when `fs.statfs` is stubbed
 *      to report insufficient space, with a body that names the
 *      shortfall so the user knows what to free up.
 *
 * The integration test stubs `fs.statfs` directly (the disk helper
 * imports it via `fs/promises`), so the route's call into
 * `getFreeBytes` returns our fake number without touching the real
 * filesystem. The original `statfs` is restored in `afterEach`.
 */

import { test, describe, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let disk: typeof import('../lib/disk.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
  pm = await import('../services/project-manager.js')
  disk = await import('../lib/disk.js')
})

after(async () => { await cleanup() })

// `fs.statfs` is on the same `fs/promises` module instance imported by
// `disk.ts`, so reassigning here is visible there. Tests that stub it
// must restore the original in afterEach.
const realStatfs = (fs as any).statfs

afterEach(() => {
  ;(fs as any).statfs = realStatfs
})

describe('getFreeBytes — real filesystem', () => {
  test('returns a positive number for /tmp', async () => {
    const free = await disk.getFreeBytes('/tmp')
    assert.ok(Number.isFinite(free), 'returns a finite number')
    assert.ok(free > 0, `expected /tmp to report free bytes, got ${free}`)
    // Should be at least 1 MB on any sane dev machine — sanity-checks that
    // we're multiplying bsize × bavail (not handing back a raw block count).
    assert.ok(free > 1024 * 1024, `free bytes ${free} should be > 1 MB`)
  })

  test('returns 0 for a non-existent path (soft-pass on error)', async () => {
    const free = await disk.getFreeBytes('/this/does/not/exist/at/all')
    assert.equal(free, 0, 'missing path is treated as unknown, not as failure')
  })
})

describe('estimateRunBatchBytes — sizing', () => {
  test('10-episode 1080p/medium video_assembly batch lands in the expected range', () => {
    const episodes = Array.from({ length: 10 }, () => ({
      durationSec: 60 * 60, // 1 hour
      resolution: '1080p',
      quality: 'medium',
    }))
    const total = disk.estimateRunBatchBytes(['video_assembly'], episodes)
    // Rule of thumb: 125 KB/s × 3600s × 1× × 1× = ~450 MB per episode.
    // 10 episodes × 450 MB × 1.5 safety = ~6.6 GB.
    const GB = 1024 * 1024 * 1024
    assert.ok(total > 4 * GB, `expected > 4 GB for 10×1080p/medium, got ${(total / GB).toFixed(2)} GB`)
    assert.ok(total < 10 * GB, `expected < 10 GB for 10×1080p/medium, got ${(total / GB).toFixed(2)} GB`)
  })

  test('quality and resolution multipliers compound', () => {
    const ep = { durationSec: 60 * 60, resolution: '1080p', quality: 'medium' }
    const epHigh = { durationSec: 60 * 60, resolution: '1080p', quality: 'high' }
    const epHigh4k = { durationSec: 60 * 60, resolution: '4k', quality: 'high' }

    const baseline = disk.estimateRunBatchBytes(['video_assembly'], [ep])
    const high = disk.estimateRunBatchBytes(['video_assembly'], [epHigh])
    const high4k = disk.estimateRunBatchBytes(['video_assembly'], [epHigh4k])

    // high quality is 2× medium, 4k is 4× 1080p — both axes must compound.
    assert.ok(high > baseline * 1.8 && high < baseline * 2.2, 'quality:high ≈ 2× medium')
    assert.ok(high4k > high * 3.5 && high4k < high * 4.5, '4k ≈ 4× 1080p at the same quality')
  })

  test('cheap steps return non-zero floor so they still count', () => {
    const total = disk.estimateRunBatchBytes(['metadata', 'image_prompts', 'script-only'], [{}])
    assert.ok(total > 0, 'cheap steps still reserve at least the tiny floor')
  })

  test('safety margin is applied on top of the raw sum', () => {
    const ep = { durationSec: 60 * 60, resolution: '1080p', quality: 'medium' }
    const withDefault = disk.estimateRunBatchBytes(['video_assembly'], [ep])
    const withNone = disk.estimateRunBatchBytes(['video_assembly'], [ep], 1)
    assert.ok(withDefault > withNone * 1.4, 'default 1.5× margin must inflate the total')
  })
})

describe('run-batch — disk-space gate', () => {
  /**
   * Seed a project with one accepted idea + a thumbnail-prompts preset so
   * findActivePreset succeeds, then we can hit run-batch and the only
   * remaining gate is the disk-space check. Metadata is intentionally not
   * used here because YouTube Finalizer now has real script + Audio Assembly
   * prerequisites that belong to its own workflow tests.
   */
  async function seedProjectWithPromptPreset(): Promise<{ slug: string; episodeId: string }> {
    const proj = await pm.createProject({ name: 'Disk Precheck Test' })
    await pm.updateConfig(proj.slug, {
      thumbnail_prompts_presets: [{ id: 'tp1', name: 'default', data: { model: 'gpt-4o' } }],
      thumbnail_prompts_last_preset: 'tp1',
      // 1.4.300 — this gate is the disk_space safety check on Block.
      safety_checks: { disk_space: 'block' },
    } as any)
    const im = await import('../services/idea-manager.js')
    const ideas = await im.addIdeas(proj.slug, [{
      title: 'Disk test episode', logline: '', themes: [], suggested_chapters: 5, suggested_length: '20 min', mood: 'calm',
    }], 'test-model')
    await im.acceptIdea(proj.slug, ideas[0].id)
    const accepted = await im.getIdeas(proj.slug, 'accepted')
    return { slug: proj.slug, episodeId: accepted[0].episode_code! }
  }

  test('returns 400 with a clear shortfall message when statfs reports insufficient space', async () => {
    const { slug, episodeId } = await seedProjectWithPromptPreset()

    // Stub statfs to report 1 KB free. Even cheap steps reserve more
    // than that thanks to TINY_STEP_BYTES, so the gate must fire.
    ;(fs as any).statfs = async () => ({ bsize: 1024, bavail: 1, blocks: 1, bfree: 1 })

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['image_prompts'] })

    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`)
    assert.match(res.body.detail, /Not enough free disk space/, 'detail names the problem')
    assert.match(res.body.detail, /Have:/, 'detail names what we have')
    assert.match(res.body.detail, /need:/, 'detail names what we need')
    assert.equal(res.body.episodes, 1, 'response carries episode count')
    assert.equal(res.body.steps, 1, 'response carries step count')
    assert.ok(res.body.required_bytes > res.body.free_bytes, 'required > free in the body')
  })

  test('passes the gate when statfs reports plenty of space', async () => {
    const { slug, episodeId } = await seedProjectWithPromptPreset()
    // 1 TB free — way more than any plausible batch.
    ;(fs as any).statfs = async () => ({ bsize: 4096, bavail: 256 * 1024 * 1024, blocks: 1, bfree: 1 })

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['image_prompts'] })

    // Should fall through to the normal 201 enqueue path.
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`)
  })

  test('soft-passes when statfs throws (unknown filesystem)', async () => {
    const { slug, episodeId } = await seedProjectWithPromptPreset()
    ;(fs as any).statfs = async () => { throw new Error('exotic FS') }

    const res = await request(app)
      .post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['image_prompts'] })

    // statfs failure must not block legitimate work.
    assert.equal(res.status, 201, `expected soft-pass 201, got ${res.status}: ${JSON.stringify(res.body)}`)
  })
})

describe('formatBytes', () => {
  test('renders human-readable units across the range', () => {
    assert.equal(disk.formatBytes(0), '0 B')
    assert.equal(disk.formatBytes(512), '512 B')
    assert.equal(disk.formatBytes(2048), '2 KB')
    assert.match(disk.formatBytes(5 * 1024 * 1024), /^5 MB$|^5\.00 MB$/)
    assert.match(disk.formatBytes(2.5 * 1024 * 1024 * 1024), /^2\.50 GB$/)
  })
})
