/**
 * Stranded scene images: the check that finds a scene image a shrink moved into
 * Story's Trash and never replaced, and the explicit restore that puts one back.
 *
 * The live case (production, 2026-10-20): an all-channel `shrink_images` run
 * reported `failed_count: 2`. The swap moves the original to `_trash` first, so
 * when the swap and its rollback both fail the working path is empty and the only
 * copy of the scene is in a folder the owner empties after seven days. The run's
 * own reasons are gone; the originals are not, and this is how they are found.
 *
 * A zero here must never mean two things (AGENTS §6): `scan_complete` says whether
 * the answer covers everything, so "nothing is stranded" and "this scan could not
 * tell" never look the same.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import express from 'express'
import sharp from 'sharp'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitForValue } from './_timing.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'

let cleanup: typeof import('../services/episode-media-cleanup.js')
let orphans: typeof import('../services/media-cleanup-orphans.js')
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let pathsService: typeof import('../services/utils.js')
let router: typeof import('../routes/media-cleanup.js').router
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'chan-a'

before(async () => {
  tmp = await useTempDataDir()
  cleanup = await import('../services/episode-media-cleanup.js')
  orphans = await import('../services/media-cleanup-orphans.js')
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  pathsService = await import('../services/utils.js')
  router = (await import('../routes/media-cleanup.js')).router
})

beforeEach(async () => {
  await tmp.cleanup()
  tmp = await useTempDataDir()
  cleanup._resetMediaCleanupStateForTests()
  const dir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Channel A', episode_prefix: 'EP', episode_digits: 4, season_size: 20,
    season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: DEFAULT_SUBFOLDER_NAMES, created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(dir, 'config.json'), '{}')
  await fs.writeFile(path.join(dir, 'ideas.json'), JSON.stringify({ ideas: [], next_episode_number: 1, recycled_numbers: [] }))
})

after(async () => { await tmp.cleanup() })
afterEach(() => { cleanup._resetMediaCleanupStateForTests() })

async function seedEpisode(code: string, title = `Episode ${code}`) {
  const [idea] = await im.addIdeas(SLUG, [{
    title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test')
  await im.acceptIdea(SLUG, idea!.id, false, { override_code: code })
  const paths = await pathsService.resolveEpisodePathsByCode(SLUG, code)
  await fs.mkdir(paths.bg_dir, { recursive: true })
  return { code, title, paths }
}

async function scenePng(file: string): Promise<void> {
  // Soft-noise "photo": compresses well as JPEG, badly as PNG, like a generated scene.
  await sharp({ create: { width: 96, height: 96, channels: 3, background: '#203040', noise: { type: 'gaussian', mean: 128, sigma: 24 } } })
    .blur(1.5).png().toFile(file)
}

const api = () => { const app = express(); app.use(express.json()); app.use('/api', router); return app }
const trashFile = (code: string, name: string) => path.join(pm.projectsRoot(), '_trash', SLUG, code, 'images', 'scene_images', name)

/** An all-channel shrink run, to completion, with whatever the caller wants the swap to do. */
async function shrinkRun(hooks: Parameters<typeof cleanup._setMediaCleanupHooksForTests>[0] = {}) {
  const restore = cleanup._setMediaCleanupHooksForTests(hooks)
  try {
    const startedPreview = await cleanup.startLibraryMediaCleanupPreview('shrink_images')
    const preview = await waitForValue(() => {
      const current = cleanup.getLibraryMediaCleanupOperation(startedPreview.operation_id)
      return current && ['completed', 'failed', 'stopped'].includes(current.status) ? current : null
    }, { label: 'all-channel shrink preview' })
    assert.equal(preview.status, 'completed', preview.error)
    const startedRun = await cleanup.startLibraryMediaCleanupRun({ preview_id: preview.library_preview!.preview_id })
    return await waitForValue(() => {
      const current = cleanup.getLibraryMediaCleanupOperation(startedRun.operation_id)
      return current && ['completed', 'failed', 'stopped'].includes(current.status) ? current : null
    }, { timeoutMs: 30_000, label: 'all-channel shrink run' })
  } finally { restore() }
}

/**
 * A shrink whose swap cannot complete and cannot be undone: the scene folder is
 * read-only for the one swap, so the compressed image cannot take the original's
 * place and the original cannot be put back. That is exactly the state production
 * was left in. The hook is synchronous on purpose — the swap must stay inside one
 * event-loop turn.
 */
async function runStrandingShrink(folder: string) {
  try {
    const run = await shrinkRun({ beforeCompressedSwap: () => { chmodSync(folder, 0o555) } })
    assert.equal(run.status, 'completed', run.error)
    assert.equal(run.result?.failed_count, 1, 'the swap failed and could not be rolled back')
  } finally {
    await fs.chmod(folder, 0o755)
  }
}

describe('stranded scene images', () => {
  test('a stranded original is listed as an orphan and comes back through the Trash restore', async () => {
    const episode = await seedEpisode('EP0001')
    const scene = path.join(episode.paths.bg_dir, 's001.png')
    await scenePng(scene)
    const original = await fs.readFile(scene)

    await runStrandingShrink(episode.paths.bg_dir)
    assert.equal(existsSync(scene), false, 'the working path is empty: the original never came back')

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.scan_complete, true, scan.body.scan_note)
    assert.equal(scan.body.projects_scanned, scan.body.projects_total)
    assert.equal(scan.body.orphan.count, 1)
    assert.equal(scan.body.resolved.count, 0)
    const item = scan.body.orphan.items[0]
    assert.equal(item.project_slug, 'chan-a')
    assert.equal(item.episode_code, 'EP0001')
    assert.equal(item.working_path, scene)
    assert.equal(item.trash_path, trashFile('EP0001', 's001.png'))
    assert.equal(item.bytes, original.length, 'the size of the file that is really in the Trash')
    assert.ok(item.mtime_ms > 0, 'and when the Trash file was last written')
    assert.ok(item.trash_item_id, 'the id the restore route takes')

    const restored = await request(api()).post('/api/library/media-cleanup/orphans/restore')
      .send({ id: item.trash_item_id }).expect(200)
    assert.equal(restored.body.restored_to, scene)
    assert.equal(restored.body.project_slug, 'chan-a')
    assert.equal(restored.body.episode_code, 'EP0001')
    assert.deepEqual(await fs.readFile(scene), original, 'the original bytes are back at the working path')

    // The same check now answers a different, complete zero — not the same zero.
    const after = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(after.body.scan_complete, true)
    assert.equal(after.body.orphan.count, 0)
    assert.equal(after.body.resolved.count, 0)
    assert.equal(after.body.scanned, 0, 'nothing is left in the Trash for this check to classify')
    assert.equal(existsSync(item.trash_path), false, 'the Trash copy moved back, it was not copied')
  })

  test('a scene image that was replaced normally is resolved, not stranded', async () => {
    const episode = await seedEpisode('EP0001')
    const scene = path.join(episode.paths.bg_dir, 's001.png')
    await scenePng(scene)

    const run = await shrinkRun()
    assert.equal(run.status, 'completed', run.error)

    const bytes = await fs.readFile(scene)
    assert.equal(bytes[0], 0xff, 'the JPEG took its place')

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.orphan.count, 0, 'a replaced scene is never offered back')
    assert.equal(scan.body.resolved.count, 1)
    assert.equal(scan.body.scan_complete, true, 'and this zero comes from a scan that saw everything')
    assert.equal(scan.body.resolved.items[0].trash_path, trashFile('EP0001', 's001.png'))
    assert.equal(scan.body.resolved.items[0].trash_item_id, undefined, 'nothing to restore for a resolved file')
    assert.match(scan.body.resolved.items[0].note, /already holds a file/)
  })

  test('restore refuses when the working path has been filled again, and moves nothing', async () => {
    const episode = await seedEpisode('EP0001')
    const scene = path.join(episode.paths.bg_dir, 's001.png')
    await scenePng(scene)

    await runStrandingShrink(episode.paths.bg_dir)
    const listed = (await request(api()).get('/api/library/media-cleanup/orphans').expect(200)).body.orphan.items[0]
    assert.ok(listed, 'the stranded original is listed first')

    // Something new took the working path since the check was drawn.
    await scenePng(scene)
    const refusal = await request(api()).post('/api/library/media-cleanup/orphans/restore')
      .send({ id: listed.trash_item_id }).expect(409)
    assert.match(refusal.body.detail, /already holds a file/, 'the refusal says what is in the way')
    assert.equal(existsSync(listed.trash_path), true, 'the Trash copy is still there')
    assert.deepEqual((await fs.readFile(scene)).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'and the PNG that arrived is untouched')
    const after = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(after.body.orphan.count, 0)
    assert.equal(after.body.resolved.count, 1)
  })

  test('a scene image in the Trash with no record of the move is listed as unknown, and the scan says it is incomplete', async () => {
    const episode = await seedEpisode('EP0001')
    // Written straight into the scene-image Trash folder: no `.trash-index.jsonl`
    // line, so nothing says where it came from and Restore cannot put it back.
    const unrecorded = trashFile('EP0001', 's042.png')
    await fs.mkdir(path.dirname(unrecorded), { recursive: true })
    await fs.writeFile(unrecorded, 'a scene nobody recorded')

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.orphan.count, 0, 'it is found, and it is not offered back')
    assert.equal(scan.body.unknown.count, 1, 'the file is classified, never silently skipped')
    assert.equal(scan.body.unknown.items[0].working_path, path.join(episode.paths.bg_dir, 's042.png'),
      'its scene folder still says where it belongs')
    assert.equal(scan.body.unknown.items[0].bytes, 'a scene nobody recorded'.length)
    assert.equal(scan.body.scan_complete, false, 'so a zero here cannot read as "clean"')
    assert.match(scan.body.scan_note, /unknown/i)
  })

  test('a channel whose Trash cannot be read makes the scan incomplete, not empty', async () => {
    const episode = await seedEpisode('EP0001')
    const scene = path.join(episode.paths.bg_dir, 's001.png')
    await scenePng(scene)
    await runStrandingShrink(episode.paths.bg_dir)

    const trashRoot = path.join(pm.projectsRoot(), '_trash', SLUG)
    await fs.chmod(trashRoot, 0o000)
    try {
      const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
      assert.equal(scan.body.orphan.count, 0, 'a read that saw nothing')
      assert.equal(scan.body.scan_complete, false, 'must not be the same answer as a clean scan')
      assert.match(scan.body.scan_note, /could not be read/)
      assert.equal(scan.body.projects_scanned, scan.body.projects_total - 1, 'and the count says which channel was missed')
    } finally {
      await fs.chmod(trashRoot, 0o755)
    }

    const back = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(back.body.orphan.count, 1, 'the same check finds it again once the folder is readable')
    assert.equal(back.body.scan_complete, true)
  })

  test('an id the check did not list is refused', async () => {
    await assert.rejects(() => orphans.restoreStrandedSceneImage('not-a-listed-id'), /not one this check offers to put back/)
    const empty = await request(api()).post('/api/library/media-cleanup/orphans/restore').send({}).expect(400)
    assert.match(empty.body.detail, /Choose one of the scene images/)
  })
})
