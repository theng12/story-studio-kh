/**
 * Tests for renameEpisodeFolderForTitleChange in
 * services/episode-folder-title-sync.ts.
 *
 * Coverage:
 *   - Happy path: old folder exists, new doesn't → renamed atomically
 *   - No-op: old title === new title (whitespace-only difference)
 *   - No-op: old folder doesn't exist yet (script never ran)
 *   - Refuse: destination already exists → warning, no clobber
 *   - Subfolders + their inner files survive the rename (they're code-
 *     scoped, not title-scoped, so no cascade is needed)
 *   - Asserts the title-driven path drift bug is actually closed: after
 *     rename, resolveEpisodePaths(NEW_TITLE) lands on the renamed dir.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let svc: typeof import('../services/episode-folder-title-sync.js')
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let utils: typeof import('../services/utils.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'title-sync-test'

async function makeProject(): Promise<void> {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Title Sync Demo',
    episode_prefix: 'TN', episode_digits: 4,
    season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, 
    created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(projDir, 'config.json'), JSON.stringify({}))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 1, recycled_numbers: [],
  }))
}

/** Accept an idea at a fixed code so each test starts from a known state. */
async function seed(code: string, title: string): Promise<{ idea_id: string; episode_dir: string }> {
  const [created] = await im.addIdeas(SLUG, [{
    title, logline: 'l', themes: [],
    suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
  }], 'test-model')
  const r = await im.acceptIdea(SLUG, created.id, false, { override_code: code })
  return { idea_id: created.id, episode_dir: r.episode_dir }
}

describe('episode-folder-title-sync: renameEpisodeFolderForTitleChange', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    im = await import('../services/idea-manager.js')
    svc = await import('../services/episode-folder-title-sync.js')
    utils = await import('../services/utils.js')
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    await makeProject()
  })

  test('happy path: renames the episode dir, leaves subfolders + files intact', async () => {
    const oldTitle = '7 historical cold cases'
    const newTitle = '10 historical cold cases'
    const { episode_dir: oldDir } = await seed('TN0001', oldTitle)

    // Drop a representative asset inside a code-scoped subfolder so we can
    // confirm the cascade isn't needed (subfolders use {code}, not {title}).
    const scriptSub = path.join(oldDir, 'TN0001 - 01 Script')
    await fs.mkdir(scriptSub, { recursive: true })
    await fs.writeFile(path.join(scriptSub, 'TN0001_Chapter_01.docx'), 'body-content')

    const r = await svc.renameEpisodeFolderForTitleChange(SLUG, 'TN0001', oldTitle, newTitle)
    assert.equal(r.renamed, true)
    assert.equal(existsSync(oldDir), false, 'old folder removed')
    assert.ok(r.new_dir && existsSync(r.new_dir), 'new folder exists')
    assert.equal(r.warnings.length, 0)

    // Subfolder + file moved with the parent rename.
    const newScriptSub = path.join(r.new_dir!, 'TN0001 - 01 Script')
    assert.equal(existsSync(newScriptSub), true)
    const body = await fs.readFile(path.join(newScriptSub, 'TN0001_Chapter_01.docx'), 'utf-8')
    assert.equal(body, 'body-content', 'inner files preserved')

    // Closes the original bug: resolveEpisodePaths(NEW_TITLE) now lands on
    // the renamed folder. Before the fix, this returned a path that
    // didn't exist and the next generator silently mkdir-ed a fresh empty
    // folder, stranding the script chapters in the old name.
    const resolved = await utils.resolveEpisodePaths(SLUG, 'TN0001', newTitle)
    assert.equal(resolved.episode_dir, r.new_dir)
    assert.equal(existsSync(resolved.episode_dir), true)
  })

  test('no-op when old and new titles are equal (after trim)', async () => {
    const t = '12 paradoxes explained'
    const { episode_dir } = await seed('TN0002', t)
    const r = await svc.renameEpisodeFolderForTitleChange(SLUG, 'TN0002', t, '  ' + t + ' ')
    assert.equal(r.renamed, false)
    assert.equal(existsSync(episode_dir), true, 'folder untouched on whitespace-only diff')
  })

  test('no-op when the old folder does not exist on disk yet', async () => {
    // The script never ran — the user accepted the idea, edited the title
    // immediately. acceptIdea creates the folder, so we delete it here to
    // simulate the "title edited before any generator wrote anything" path.
    const { episode_dir } = await seed('TN0003', 'placeholder title')
    await fs.rm(episode_dir, { recursive: true, force: true })

    const r = await svc.renameEpisodeFolderForTitleChange(SLUG, 'TN0003', 'placeholder title', 'final title')
    assert.equal(r.renamed, false)
    assert.equal(r.warnings.length, 0, 'absent old folder is normal, not a warning')
  })

  test('refuses to clobber when the destination folder already exists', async () => {
    // Real-world template embeds both {code} AND {title}, so two accepted
    // ideas can't naturally collide on the destination path (codes are
    // unique). The clobber case happens when a stray folder exists at the
    // destination — e.g. user manually copied one in, or a previous
    // half-completed rename left an artifact. Construct that case and
    // assert we refuse to merge.
    const { episode_dir: oldDir } = await seed('TN0004', 'Episode A')
    // Resolve where the rename WOULD land, then create a sentinel folder
    // there with a different content payload so we can verify it survived.
    const target = await utils.resolveEpisodePaths(SLUG, 'TN0004', 'Episode B')
    await fs.mkdir(target.episode_dir, { recursive: true })
    await fs.writeFile(path.join(target.episode_dir, 'stray.txt'), 'do-not-clobber')

    const r = await svc.renameEpisodeFolderForTitleChange(SLUG, 'TN0004', 'Episode A', 'Episode B')
    assert.equal(r.renamed, false)
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0]!, /already exists/i)
    // Original source untouched.
    assert.equal(existsSync(oldDir), true)
    // Stray destination preserved — refused to merge.
    const stray = await fs.readFile(path.join(target.episode_dir, 'stray.txt'), 'utf-8')
    assert.equal(stray, 'do-not-clobber')
  })

  test('returns warnings array even on success (cache invalidation, etc.)', async () => {
    // Sanity: success path still has a warnings field, just empty. Future
    // additions (external mirror, etc.) populate it without breaking the
    // shape callers depend on.
    const { episode_dir } = await seed('TN0006', 'before')
    await fs.writeFile(path.join(episode_dir, 'sentinel.txt'), 'x')
    const r = await svc.renameEpisodeFolderForTitleChange(SLUG, 'TN0006', 'before', 'after')
    assert.equal(r.renamed, true)
    assert.ok(Array.isArray(r.warnings))
    assert.ok(r.new_dir && existsSync(path.join(r.new_dir, 'sentinel.txt')))
  })
})
