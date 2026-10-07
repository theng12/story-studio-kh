import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
after(() => temp.cleanup())
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')

// S15: getIdeas reuses the parsed ideas.json until the file changes; each caller gets its own copy.
test('getIdeas is served from a per-file memo, invalidated by writes, and returns independent copies', async () => {
  const project = await pm.createProject({ name: 'Ideas Memo' })
  await im.addIdeas(project.slug, [{ title: 'Alpha', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  const file = path.join(pm.getProjectDir(project.slug)!, 'ideas.json')
  const stamp = new Date('2026-10-01T00:00:00Z')
  await fs.utimes(file, stamp, stamp)
  const first = await im.getIdeas(project.slug)
  assert.equal(first[0]!.title, 'Alpha')

  // Same inode, size and mtime: the memo answers (proves no re-read).
  const raw = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, raw.replace('"Alpha"', '"Bravo"'))
  await fs.utimes(file, stamp, stamp)
  assert.equal((await im.getIdeas(project.slug))[0]!.title, 'Alpha')

  // A caller editing its result cannot change what the next caller sees.
  first[0]!.title = 'edited'
  assert.equal((await im.getIdeas(project.slug))[0]!.title, 'Alpha')

  // Any real write (here through the store's own writer) is a miss.
  await im.addIdeas(project.slug, [{ title: 'Charlie', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  assert.deepEqual((await im.getIdeas(project.slug)).map(idea => idea.title), ['Bravo', 'Charlie'])
})
