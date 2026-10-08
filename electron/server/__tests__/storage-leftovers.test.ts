/**
 * Storage visibility: leftovers offered for _trash (audio-quality copies,
 * failed-render scratch), motion clips counted, free disk and _trash sizes,
 * and the cross-drive move that used to fs.rm its source.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let utils: typeof import('../services/utils.js')
const savedTmp = process.env.TMPDIR

before(async () => {
  tmp = await useTempDataDir()
  // Render scratch lives under os.tmpdir(); keep it inside this test's folder.
  process.env.TMPDIR = path.join(tmp.dir, 'os-tmp')
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  utils = await import('../services/utils.js')
})
after(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = savedTmp
  await tmp.cleanup()
})

async function project(name: string) {
  const created = await pm.createProject({ name })
  const [idea] = await im.addIdeas(created.slug, [{ title: 'One', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  await im.acceptIdea(created.slug, idea!.id, false)
  const code = (await im.getIdeas(created.slug, 'accepted'))[0]!.episode_code!
  const paths = await utils.resolveEpisodePathsByCode(created.slug, code)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  return { slug: created.slug, code, paths, projectDir: pm.getProjectDir(created.slug)! }
}

async function write(file: string, bytes: number) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, Buffer.alloc(bytes, 1))
}

describe('leftovers offered in Free up space', () => {
  test('audio-quality copies once settled, failed-render scratch while idle; both move to _trash, never deleted', async () => {
    const leftovers = await import('../services/storage-leftovers.js')
    const { getWorkTempRoot, sanitizeWorkTempSegment } = await import('../lib/work-tempdir.js')
    const p = await project('Leftovers')
    const candidates = path.join(p.paths.episode_dir, '.audio-quality-candidates')
    const checks = path.join(p.paths.episode_dir, '.audio-quality-checks')
    for (const id of ['done', 'waiting', 'orphan']) await write(path.join(candidates, id, 'audio', 'a.mp3'), 100)
    await write(path.join(checks, 'waiting', 'audio', 'a.mp3'), 50)
    await write(path.join(checks, 'busy', 'audio', 'a.mp3'), 0)
    const action = (id: string, state: string, extra: object = {}) => ({
      action_id: id, scope_fingerprint: 'scope', source_fingerprint: 'source', created_at: new Date().toISOString(),
      sections: ['ch1'], source_files: { ch1: ['a.mp3'] }, mode: 'check_and_repair', verification_credit_ceiling: 10, state, ...extra,
    })
    const check = (state: string) => ({ active_check: { model_id: 'asr', staging_dir: 'x', state, quotes: { ch1: { id: 'q', audio_hash: 'h' } } } })
    await fs.writeFile(path.join(p.paths.episode_dir, 'audio_quality.json'), JSON.stringify({
      version: 1, chapters: {},
      actions: {
        done: action('done', 'fixed'),
        waiting: action('waiting', 'needs_approval', check('no_issue_detected')),
        busy: action('busy', 'confirmed', check('checking')),
        garbled: { action_id: 'garbled', state: 'fixed' },
      },
    }))
    await write(path.join(candidates, 'garbled', 'audio', 'a.mp3'), 10)
    const scratch = path.join(getWorkTempRoot(), sanitizeWorkTempSegment(p.slug), sanitizeWorkTempSegment(p.code), '.tmp_1700000000000')
    await write(path.join(scratch, 'scene_0001.mp4'), 300)

    const listed = await leftovers.listStorageLeftovers(p.slug)
    const offered = listed.map(item => path.relative(p.paths.episode_dir, item.path).replace(/^(\.\.\/)+/, '')).sort()
    assert.deepEqual(listed.map(item => item.path).sort(), [
      path.join(candidates, 'done'), path.join(candidates, 'orphan'), path.join(checks, 'waiting'), scratch,
    ].sort(), offered.join(', '))
    assert.equal(listed.find(item => item.kind === 'render_scratch')!.bytes, 300)

    // A job running for the episode protects every one of its folders.
    leftovers._leftoverHooks.getJobs = async () => [{ episode_id: p.code, status: 'running' }]
    assert.deepEqual(await leftovers.listStorageLeftovers(p.slug), [])
    leftovers._leftoverHooks.getJobs = async () => []

    const result = await leftovers.trashStorageLeftovers(p.slug, [scratch, path.join(candidates, 'done'), path.join(candidates, 'waiting')])
    assert.equal(result.moved.length, 2)
    assert.deepEqual(result.left.map(item => item.path), [path.join(candidates, 'waiting')])
    assert.ok(!existsSync(scratch) && !existsSync(path.join(candidates, 'done')))
    for (const item of result.moved) {
      assert.ok(item.to.startsWith(path.join(p.projectDir, '_trash')), item.to)
      assert.ok(existsSync(item.to), 'the folder waits in _trash')
    }
    assert.ok(existsSync(path.join(candidates, 'waiting', 'audio', 'a.mp3')), 'an unsettled repair keeps its candidate')
  })
})

describe('what is using space', () => {
  test('counts the motion clips folder and reports free disk and _trash sizes', async () => {
    const { auditProjectStorage, storageSpaceSummary } = await import('../services/storage-audit.js')
    const p = await project('Space One')
    const other = await project('Space Two')
    await write(path.join(p.paths.video_assets_dir, `${p.code}_Scene01_v1.mp4`), 4000)
    await write(path.join(p.projectDir, '_trash', p.code, 'images', 'x.png'), 700)
    await write(path.join(other.projectDir, '_trash', 'y.png'), 900)
    const { appTrashDir } = await import('../services/app-update.js')
    await write(path.join(appTrashDir(), 'Story Studio KH.app-1.4.260', 'z'), 300)

    const audit = await auditProjectStorage(p.slug)
    const row = audit.episodes.find(entry => entry.episode_code === p.code)!
    assert.equal(row.bytes_per_scene_clips, 4000, '"11 Video Assets" is counted')
    assert.equal(audit.project_bytes_per_scene_clips, 4000)
    assert.ok(row.bytes_total >= 4000)

    const space = await storageSpaceSummary(p.slug)
    assert.ok(typeof space.free_bytes === 'number' && space.free_bytes > 0, 'a real measurement, never 0 for unknown')
    assert.equal(space.project_trash_bytes, 700)
    assert.ok(space.library_trash_bytes >= 1600, String(space.library_trash_bytes))
    assert.equal(space.app_trash_bytes, 300, 'the self-emptying Trash Folder is its own figure')
    assert.deepEqual(audit.space.project_trash_bytes, 700)
  })
})

describe('a folder move that crosses drives', () => {
  test('moves its source to _trash on its own drive instead of deleting it', async () => {
    const { trashCopiedSourceSync } = await import('../lib/trash-move.js')
    const projectDir = path.join(tmp.dir, 'cross', 'project')
    const library = path.join(tmp.dir, 'cross', 'library')
    const inProject = path.join(projectDir, 'episodes', 'Season 1', 'EP0001 - A')
    const inLibrary = path.join(library, 'Season 1', 'EP0002 - B')
    const elsewhere = path.join(tmp.dir, 'cross', 'loose', 'EP0003 - C')
    for (const dir of [inProject, inLibrary, elsewhere]) await write(path.join(dir, 'file.txt'), 5)

    assert.equal(trashCopiedSourceSync(inProject, projectDir, 'demo', library),
      path.join(projectDir, '_trash', 'moved', 'episodes', 'Season 1', 'EP0001 - A'))
    assert.equal(trashCopiedSourceSync(inLibrary, projectDir, 'demo', library),
      path.join(library, '_trash', 'demo', 'moved', 'Season 1', 'EP0002 - B'))
    assert.equal(trashCopiedSourceSync(elsewhere, projectDir, 'demo'),
      path.join(tmp.dir, 'cross', 'loose', '_trash', 'demo', 'EP0003 - C'))
    for (const dir of [inProject, inLibrary, elsewhere]) assert.ok(!existsSync(dir))
  })

  test('renumber, compact and reseason no longer fs.rm the copied source', async () => {
    for (const file of ['episode-renumber.ts', 'upload-compact.ts', 'upload-reseason.ts']) {
      const source = await fs.readFile(path.join(import.meta.dirname, '..', 'services', file), 'utf8')
      assert.doesNotMatch(source, /copyDirRecursive\([^)]*\)\s*\n\s*await fs\.rm\(/, file)
      assert.match(source, /trashCopiedSourceSync\(/, file)
    }
  })
})
