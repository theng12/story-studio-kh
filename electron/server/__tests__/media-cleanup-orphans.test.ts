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
import { TRASH_INDEX } from '../lib/trash-move.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'

let cleanup: typeof import('../services/episode-media-cleanup.js')
let orphans: typeof import('../services/media-cleanup-orphans.js')
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let pathsService: typeof import('../services/utils.js')
let trashModule: typeof import('../services/trash.js')
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
  trashModule = await import('../services/trash.js')
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

/**
 * What the check must never do is answer "nothing stranded" because it could not
 * look. Three ways production found that happening: a read that failed and was
 * swallowed, a record sitting past the Trash listing's own cap, and an original
 * that Story's Trash retention has already handed to the macOS Trash.
 *
 * The handoff runs on the owner's schedule (7 days, or 20 GB, oldest first),
 * NOT on `auto_cleanup_enabled`, so originals leave Story's Trash without anyone
 * asking. About 175 GB of shrink originals were in `_trash` when this was written.
 */
describe('a scan that could not look says so', () => {
  const trashIndexFile = () => path.join(pm.projectsRoot(), '_trash', TRASH_INDEX)
  const macTrashFor = (dir: string) => path.join(dir, '.Trash')

  /** Index lines as an older build wrote a handoff: the mark alone, no size, no location. */
  async function markHandedOffInTheOldShape(id: string, from: string, to: string): Promise<void> {
    await fs.appendFile(trashIndexFile(), `${JSON.stringify({
      id, from, to, kind: 'images', removed: 'macos-trash', at: new Date().toISOString(),
    })}\n`)
  }

  /**
   * Records this check never looks at — a different kind, so the walk passes them
   * by — written newer than the real one, so the real record sits past
   * `listTrash`'s 2,000-item page. `real` of them are real files (the listing only
   * counts what exists); the rest only bloat the index.
   */
  async function appendFillerRecords(real: number, phantom: number, at: Date): Promise<void> {
    const dir = path.join(pm.projectsRoot(), '_trash', SLUG, 'EP0009', 'final_video')
    await fs.mkdir(dir, { recursive: true })
    const lines: string[] = []
    for (let index = 0; index < real + phantom; index += 1) {
      const name = `filler${String(index).padStart(5, '0')}.mp4`
      const to = path.join(dir, name)
      if (index < real) await fs.writeFile(to, name)
      lines.push(JSON.stringify({ id: `filler-${index}`, from: `/nowhere/${name}`, to, kind: 'final_video', at: at.toISOString() }))
    }
    await fs.appendFile(trashIndexFile(), `${lines.join('\n')}\n`)
  }

  async function strandedOrphan(slug = 'EP0001') {
    const episode = await seedEpisode(slug)
    const scene = path.join(episode.paths.bg_dir, 's001.png')
    await scenePng(scene)
    await runStrandingShrink(episode.paths.bg_dir)
    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    const item = scan.body.orphan.items[0]
    assert.ok(item, 'the stranded original is an orphan before the handoff')
    return { episode, scene, item }
  }

  test('an unreadable scene-image subtree is a failed read, not a clean scan', async () => {
    // A scene image in a subfolder of the scene folder: its Trash copy lands under
    // the same relative path, so one unreadable subtree hides it completely.
    const episode = await seedEpisode('EP0001')
    const nested = path.join(episode.paths.bg_dir, 'nested')
    await fs.mkdir(nested, { recursive: true })
    await scenePng(path.join(nested, 's002.png'))
    await runStrandingShrink(nested)
    const subtree = path.join(path.dirname(trashFile('EP0001', 'x.png')), 'nested')
    assert.equal(existsSync(subtree), true, 'the stranded copy is in its own subtree')

    await fs.chmod(subtree, 0o000)
    try {
      const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
      assert.equal(scan.body.orphan.count, 0, 'nothing under it could be checked')
      assert.equal(scan.body.scan_complete, false, 'a read that saw nothing must never read as clean')
      assert.ok(scan.body.read_failures >= 1, 'the failed read is counted')
      assert.match(scan.body.scan_note, /could not be read/)
    } finally {
      await fs.chmod(subtree, 0o755)
    }

    const back = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(back.body.read_failures, 0)
    assert.equal(back.body.scan_complete, true, 'the same check is complete once the subtree is readable')
    assert.equal(back.body.orphan.count, 1, 'and it finds the original it could not see a moment ago')
  })

  test('an orphan whose record sits past the Trash listing cap is still found, and is restorable', async () => {
    const { scene, item } = await strandedOrphan()
    // 2,100 newer records: `listTrash` pages the newest 2,000, so this orphan's own
    // record is past that page. The index itself is the lookup, not the page.
    await appendFillerRecords(2_100, 0, new Date(Date.now() + 3_600_000))

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.orphan.count, 1, 'a record past the listing cap is not a missing record')
    assert.equal(scan.body.unknown.count, 0, 'and it is not mistaken for one nobody recorded')
    assert.equal(scan.body.orphan.items[0].working_path, scene)
    assert.ok(scan.body.orphan.items[0].trash_item_id, 'it can still be put back')
    assert.equal(scan.body.scan_complete, true)

    const restored = await request(api()).post('/api/library/media-cleanup/orphans/restore')
      .send({ id: scan.body.orphan.items[0].trash_item_id }).expect(200)
    assert.equal(restored.body.restored_to, scene)
    assert.equal(restored.body.episode_code, 'EP0001')
    assert.equal(item.bytes, (await fs.stat(scene)).size, 'the original is the file that came back')
  })

  test('a twenty-thousand-record Trash index is scanned completely', async () => {
    const { scene } = await strandedOrphan()
    await appendFillerRecords(2_001, 18_000, new Date(Date.now() + 3_600_000))

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.orphan.count, 1, 'the whole index is read, not the newest page of it')
    assert.equal(scan.body.orphan.items[0].working_path, scene)
    assert.equal(scan.body.scan_complete, true, 'and a big index is not itself an incomplete scan')
  })

  test('an absent Trash folder is not a failed read', async () => {
    await seedEpisode('EP0001')
    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.read_failures, 0)
    assert.equal(scan.body.scan_complete, true)
    assert.equal(scan.body.projects_scanned, scan.body.projects_total)
    assert.equal(scan.body.orphan.count, 0)
  })

  test('an original handed over in the old shape is reported as moved, location unknown', async () => {
    const { scene, item } = await strandedOrphan()
    // What the handoff used to leave behind: the mark, and nothing about where the
    // file went. The original is out of Story's Trash and out of reach here.
    const macTrash = macTrashFor(tmp.dir)
    await fs.mkdir(macTrash, { recursive: true })
    await fs.rename(item.trash_path, path.join(macTrash, path.basename(item.trash_path)))
    await markHandedOffInTheOldShape(item.trash_item_id, item.working_path, item.trash_path)

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.orphan.count, 0, 'it is not in Story\'s Trash any more, so it cannot be put back from there')
    assert.equal(scan.body.unknown.count, 1)
    const moved = scan.body.unknown.items[0]
    assert.equal(moved.working_path, scene, 'its working path is still known')
    assert.equal(moved.trash_path, item.trash_path)
    assert.match(moved.note, /macOS Trash/)
    assert.match(moved.note, /location is unknown/)
    assert.equal(moved.trash_item_id, undefined, 'nothing to restore from Story\'s Trash')
    assert.equal(scan.body.scan_complete, false, 'never a silent clean')
    assert.match(scan.body.scan_note, /macOS Trash/)
  })

  test('a handoff records where the original went, and the check reports that location', async () => {
    const { scene, item } = await strandedOrphan()
    const macTrash = macTrashFor(tmp.dir)
    await fs.mkdir(macTrash, { recursive: true })
    const releaseSeam = trashModule._setMacTrashDirForTests(() => macTrash)
    try {
      // The real handoff, with the Mac's own Trash standing in for the real one.
      const moved = await trashModule.moveToMacTrash([item.trash_item_id], { count: 1, bytes: item.bytes },
        async file => { await fs.rename(file, path.join(macTrash, path.basename(file))) })
      assert.equal(moved.moved, 1, JSON.stringify(moved.errors))
      const landed = path.join(macTrash, path.basename(item.trash_path))
      assert.equal(existsSync(landed), true)

      const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
      assert.equal(scan.body.unknown.count, 1)
      const said = scan.body.unknown.items[0]
      assert.equal(said.working_path, scene)
      assert.equal(said.macos_trash_path, landed, 'the handoff recorded where it went — checked by exact name and size')
      assert.equal(said.bytes, item.bytes, 'and what the file was: the size it had when it was handed over')
      assert.ok(said.mtime_ms > 0, 'and when it was last written')
      assert.match(said.note, /macOS Trash/)
      assert.equal(scan.body.scan_complete, false, 'a file Story handed to the Mac\'s Trash is never claimed complete')

      // Where it went is not the same as being able to put it back: the record is a
      // receipt for the owner, and the id is not offered.
      assert.equal(said.trash_item_id, undefined)
    } finally { releaseSeam() }
  })

  test('a handoff that cannot tell where the file landed claims no location, and the check says so', async () => {
    const { item } = await strandedOrphan()
    const macTrash = macTrashFor(tmp.dir)
    await fs.mkdir(macTrash, { recursive: true })
    // Something already holds that exact name in the Mac's Trash, so the hand-over
    // renames the file and where it landed cannot be told.
    await fs.writeFile(path.join(macTrash, path.basename(item.trash_path)), 'another file entirely')
    const releaseSeam = trashModule._setMacTrashDirForTests(() => macTrash)
    try {
      const moved = await trashModule.moveToMacTrash([item.trash_item_id], { count: 1, bytes: item.bytes },
        async file => { await fs.rename(file, path.join(macTrash, `${path.basename(file)} 2`)) })
      assert.equal(moved.moved, 1, JSON.stringify(moved.errors))

      const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
      assert.equal(scan.body.unknown.count, 1)
      assert.equal(scan.body.unknown.items[0].macos_trash_path, undefined, 'nothing is claimed when the name was taken')
      assert.match(scan.body.unknown.items[0].note, /location is unknown/)
      assert.equal(scan.body.scan_complete, false)
    } finally { releaseSeam() }
  })

  test('a scene image whose record names a different working path is ambiguous, and is not offered back', async () => {
    const { item } = await strandedOrphan()
    // A record that disagrees with the episode's own scene folder: putting the file
    // back at a guessed path is worse than leaving it where it is.
    await fs.appendFile(trashIndexFile(), `${JSON.stringify({
      id: item.trash_item_id, from: '/somewhere/else/s001.png', to: item.trash_path, kind: 'images', at: new Date().toISOString(),
    })}\n`)

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.ambiguous.count, 1)
    assert.equal(scan.body.orphan.count, 0)
    assert.equal(scan.body.ambiguous.items[0].trash_item_id, undefined)
    assert.match(scan.body.ambiguous.items[0].note, /somewhere/)
    const refusal = await request(api()).post('/api/library/media-cleanup/orphans/restore')
      .send({ id: item.trash_item_id }).expect(409)
    assert.match(refusal.body.detail, /not stranded/)
  })

  test('an original deleted for good from Story\'s Trash is reported, never a silent clean', async () => {
    const { scene, item } = await strandedOrphan()
    const deleted = await trashModule.deletePermanently([item.trash_item_id], { count: 1, bytes: item.bytes })
    assert.equal(deleted.deleted, 1, JSON.stringify(deleted.errors))

    const scan = await request(api()).get('/api/library/media-cleanup/orphans').expect(200)
    assert.equal(scan.body.orphan.count, 0)
    assert.equal(scan.body.unknown.count, 1)
    assert.equal(scan.body.unknown.items[0].working_path, scene)
    assert.match(scan.body.unknown.items[0].note, /[Dd]eleted for good/)
    assert.equal(scan.body.scan_complete, false, 'the scene is gone and the answer must not read as clean')
  })
})
