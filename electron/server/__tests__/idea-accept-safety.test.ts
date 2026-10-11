/**
 * Ideas audit, 2026-10-03 — Accept / batch Accept / Reset must never leave an
 * idea stranded or destroy files.
 *
 *   - A "/" in a title used to flip the idea to accepted and THEN fail to make
 *     its folder, so every later click said "already accepted".
 *   - Batch Accept stopped at the first bad idea.
 *   - "Use next available" promised the counter while Accept handed out a
 *     recycled gap.
 *   - Reset hard-deleted the episode folder.
 *
 * Cannot catch: anything visual on the page (see frontend ideasAuditFixes).
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let im: typeof import('../services/idea-manager.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
})
after(async () => { await cleanup() })
beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

const base = {
  logline: 'A line.', themes: ['a'], suggested_chapters: 5, suggested_length: '30 min', mood: 'calm',
}

async function project() {
  return pm.createProject({ name: 'Accept Safety', episode_prefix: 'EP', episode_digits: 3 })
}

async function ideasFile(slug: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(pm.getProjectDir(slug)!, 'ideas.json'), 'utf-8'))
}

describe('titles with a path separator', () => {
  test('addIdeas and updateIdea swap "/" and "\\" for a dash', async () => {
    const proj = await project()
    const [idea] = await im.addIdeas(proj.slug, [{ ...base, title: 'AC/DC and the 24/7 Tour' }], 'm')
    assert.equal(idea!.title, 'AC-DC and the 24-7 Tour')
    const updated = await im.updateIdea(proj.slug, idea!.id, { title: 'Before\\After' })
    assert.equal(updated!.title, 'Before-After')
  })

  test('a "/" title already on disk is healed at Accept instead of stranding the idea', async () => {
    const proj = await project()
    const [idea] = await im.addIdeas(proj.slug, [{ ...base, title: 'Placeholder' }], 'm')
    const store = await ideasFile(proj.slug)
    store.ideas[0].title = 'Legacy/Title'
    await fs.writeFile(path.join(pm.getProjectDir(proj.slug)!, 'ideas.json'), JSON.stringify(store))

    const result = await im.acceptIdea(proj.slug, idea!.id)
    assert.equal(result.idea.title, 'Legacy-Title')
    assert.ok(existsSync(result.episode_dir))
  })

  test('a folder that cannot be made leaves the idea new and the number unspent', async () => {
    const proj = await project()
    // ".." survives sanitising and is refused by the path resolver.
    const [idea] = await im.addIdeas(proj.slug, [{ ...base, title: '..' }], 'm')
    await assert.rejects(() => im.acceptIdea(proj.slug, idea!.id), /folder/i)
    const store = await ideasFile(proj.slug)
    assert.equal(store.ideas[0].status, 'new')
    assert.equal(store.ideas[0].episode_code, null)
    assert.equal(store.next_episode_number, 1, 'the episode number was not consumed')
  })
})

describe('batch accept', () => {
  test('one bad idea does not stop the rest; already-accepted ones are skipped, not failed', async () => {
    const proj = await project()
    const [a, bad, c, done] = await im.addIdeas(proj.slug, [
      { ...base, title: 'First' }, { ...base, title: '..' }, { ...base, title: 'Third' }, { ...base, title: 'Earlier' },
    ], 'm')
    await im.acceptIdea(proj.slug, done!.id)

    const result = await im.acceptMultipleIdeas(proj.slug, [a!.id, bad!.id, c!.id, done!.id])
    assert.deepEqual(result.accepted.map(r => r.idea.title), ['First', 'Third'])
    assert.deepEqual(result.skipped.map(r => r.title), ['Earlier'])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0]!.title, '..')
    assert.ok(result.failed[0]!.reason)
    const ideas = await im.getIdeas(proj.slug)
    assert.equal(ideas.find(i => i.id === bad!.id)!.status, 'new')
  })
})

describe('next code shown by the Accept dialog', () => {
  test('reports the recycled gap Accept will actually use, then the counter', async () => {
    const proj = await project()
    const [a, b, c] = await im.addIdeas(proj.slug, [
      { ...base, title: 'One' }, { ...base, title: 'Two' }, { ...base, title: 'Three' },
    ], 'm')
    await im.acceptIdea(proj.slug, a!.id) // EP001
    await im.acceptIdea(proj.slug, b!.id) // EP002
    await im.resetIdea(proj.slug, a!.id)  // 1 recycled, counter still 3
    assert.equal(await im.getNextEpisodeNumber(proj.slug), 3)
    assert.equal(await im.getNextAcceptNumber(proj.slug), 1)
    const r = await im.acceptIdea(proj.slug, c!.id)
    assert.equal(r.episode_code, 'EP001', 'the promised code is the one handed out')
    assert.equal(await im.getNextAcceptNumber(proj.slug), 3)
  })
})

describe('plain override-code errors', () => {
  test('wrong prefix and bad number read as one plain sentence with an example', async () => {
    const proj = await project()
    const [a] = await im.addIdeas(proj.slug, [{ ...base, title: 'x' }], 'm')
    await assert.rejects(() => im.acceptIdea(proj.slug, a!.id, false, { override_code: 'XX042' }),
      (e: any) => /must start with "EP", for example EP042/.test(e.message) && !/override_code/.test(e.message))
    await assert.rejects(() => im.acceptIdea(proj.slug, a!.id, false, { override_code: 'EPabc' }),
      (e: any) => /not a valid episode code/.test(e.message) && !/override_code/.test(e.message))
  })
})

describe('Reset moves files to the project _trash', () => {
  test('the episode folder and its files survive under _trash', async () => {
    const proj = await project()
    const [a] = await im.addIdeas(proj.slug, [{ ...base, title: 'Keep My Files' }], 'm')
    const accepted = await im.acceptIdea(proj.slug, a!.id)
    await fs.writeFile(path.join(accepted.episode_dir, 'precious.txt'), 'work')

    await im.resetIdea(proj.slug, a!.id)
    assert.equal(existsSync(accepted.episode_dir), false, 'folder left the episodes tree')
    const projectDir = pm.getProjectDir(proj.slug)!
    const rel = path.relative(projectDir, accepted.episode_dir)
    const trashed = path.join(pm.projectsRoot(), '_trash', proj.slug, rel, 'precious.txt')
    assert.equal(await fs.readFile(trashed, 'utf-8'), 'work')
    const idea = (await im.getIdeas(proj.slug)).find(i => i.id === a!.id)!
    assert.equal(idea.status, 'new')
  })

  test('media_root copy: counted in the preview, moved after the project folder, a failure is a warning', async () => {
    const proj = await project()
    const mediaRoot = path.join(tempDir, 'media-drive')
    await fs.mkdir(mediaRoot, { recursive: true })
    await pm.updateProject(proj.slug, { media_root: mediaRoot } as any)
    const [a] = await im.addIdeas(proj.slug, [{ ...base, title: 'Heavy Media' }], 'm')
    const accepted = await im.acceptIdea(proj.slug, a!.id)
    const outputRoot = path.join(pm.getProjectDir(proj.slug)!, 'episodes')
    const heavyDir = path.join(mediaRoot, path.relative(outputRoot, accepted.episode_dir))
    assert.ok(existsSync(heavyDir), 'Accept made the media_root twin')
    await fs.writeFile(path.join(accepted.episode_dir, 'script.md'), 'light')
    await fs.writeFile(path.join(heavyDir, 'clip.mp4'), 'heavy-bytes')

    const preview = await im.previewIdeaReset(proj.slug, a!.id)
    assert.equal(preview.file_count, 3, 'episode_info.json + script + the media-drive clip')
    assert.equal(preview.breakdown.video, 1)

    // Block where the media-drive copy lands (this test's "drive" is the Library's, so Story's
    // Trash) so the heavy move fails while the project folder still moves.
    await fs.mkdir(path.join(pm.projectsRoot(), '_trash', proj.slug), { recursive: true })
    await fs.writeFile(path.join(pm.projectsRoot(), '_trash', proj.slug, path.relative(mediaRoot, heavyDir).split(path.sep)[0]!), 'not a folder')
    const result = await im.resetIdea(proj.slug, a!.id)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /media folder .* could not be moved/)
    assert.equal(existsSync(accepted.episode_dir), false, 'project folder still moved')
    assert.ok(existsSync(path.join(heavyDir, 'clip.mp4')), 'media left in place, not lost')
    assert.equal((await im.getIdeas(proj.slug)).find(i => i.id === a!.id)!.status, 'new')
  })

  test('if the project folder cannot move, nothing moves and the idea stays accepted', async () => {
    const proj = await project()
    const mediaRoot = path.join(tempDir, 'media-drive-2')
    await fs.mkdir(mediaRoot, { recursive: true })
    await pm.updateProject(proj.slug, { media_root: mediaRoot } as any)
    const [a] = await im.addIdeas(proj.slug, [{ ...base, title: 'Stuck Folder' }], 'm')
    const accepted = await im.acceptIdea(proj.slug, a!.id)
    const outputRoot = path.join(pm.getProjectDir(proj.slug)!, 'episodes')
    const heavyDir = path.join(mediaRoot, path.relative(outputRoot, accepted.episode_dir))
    await fs.mkdir(path.join(pm.projectsRoot(), '_trash'), { recursive: true })
    await fs.writeFile(path.join(pm.projectsRoot(), '_trash', proj.slug), 'not a folder')

    await assert.rejects(() => im.resetIdea(proj.slug, a!.id))
    assert.ok(existsSync(accepted.episode_dir))
    assert.ok(existsSync(heavyDir), 'the media copy was not moved ahead of a failed project move')
    assert.equal((await im.getIdeas(proj.slug)).find(i => i.id === a!.id)!.status, 'accepted')
  })

  test('deleting an episode folder by code also moves it to _trash', async () => {
    const proj = await project()
    const [a] = await im.addIdeas(proj.slug, [{ ...base, title: 'Delete Me' }], 'm')
    const accepted = await im.acceptIdea(proj.slug, a!.id)
    await im.deleteEpisodeFolder(proj.slug, accepted.episode_code)
    const projectDir = pm.getProjectDir(proj.slug)!
    assert.equal(existsSync(accepted.episode_dir), false)
    assert.ok(existsSync(path.join(pm.projectsRoot(), '_trash', proj.slug, path.relative(projectDir, accepted.episode_dir))))
  })
})
