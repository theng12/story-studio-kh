/**
 * "Create Another Version" takes can be made active ("Use This Version").
 *
 * Dreamlands E2E 2026-10-03: a re-made EP0002 Ch12 take was saved as
 * `_part1…8.mp3` beside the defective single-file take, and nothing anywhere
 * could make it the active one.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let versions: typeof import('../services/audio-versions.js')
let root: string

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  versions = await import('../services/audio-versions.js')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-versions-'))
})
after(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await cleanup()
})

async function episode(name: string, files: string[], selector?: unknown) {
  const projectDir = path.join(root, name)
  const episodeDir = path.join(projectDir, 'episodes', 'EP0002 - Glasshouse')
  const audioDir = path.join(episodeDir, 'EP0002 - 07 Audio Assets')
  await fs.mkdir(audioDir, { recursive: true })
  for (const file of files) await fs.writeFile(path.join(audioDir, file), `audio:${file}`)
  if (selector) await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify(selector))
  return { projectDir, episodeDir, audioDir }
}

describe('narration takes', () => {
  test('groups a chapter\'s files into takes in part order, ignoring other chapters', () => {
    const takes = versions.groupChapterTakes('EP0002', 'Chapter_12', [
      'EP0002_Chapter_12.mp3', 'EP0002_Chapter_12_part10.mp3', 'EP0002_Chapter_12_part2.mp3', 'EP0002_Chapter_12_part1.mp3',
      'EP0002_Chapter_12_v2.mp3', 'EP0002_Chapter_13.mp3', 'notes.txt',
    ])
    assert.deepEqual(takes.map(t => [t.version, t.files]), [
      [1, ['EP0002_Chapter_12.mp3']],
      [1, ['EP0002_Chapter_12_part1.mp3', 'EP0002_Chapter_12_part2.mp3', 'EP0002_Chapter_12_part10.mp3']],
      [2, ['EP0002_Chapter_12_v2.mp3']],
    ])
  })

  test('Use This Version selects the new parts take and moves the old take to the project _trash', async () => {
    const ep = await episode('with-selector', ['EP0002_Chapter_12.mp3', 'EP0002_Chapter_12_part1.mp3', 'EP0002_Chapter_12_part2.mp3'], {
      sections: [{ slug: 'Chapter_12', source_file: 'EP0002_Chapter_12.mp3', source_files: ['EP0002_Chapter_12.mp3'] }],
    })
    const before = await versions.listChapterTakes(ep.episodeDir, ep.audioDir, 'EP0002', 'Chapter_12')
    assert.deepEqual(before.map(t => t.active), [true, false])
    const parts = ['EP0002_Chapter_12_part1.mp3', 'EP0002_Chapter_12_part2.mp3']
    const result = await versions.useChapterTake({ ...ep, code: 'EP0002', slug: 'Chapter_12', files: parts })
    assert.deepEqual(result, { active: parts, trashed: ['EP0002_Chapter_12.mp3'] })
    const selector = JSON.parse(await fs.readFile(path.join(ep.episodeDir, 'audio_chapters.json'), 'utf8'))
    assert.deepEqual(selector.sections[0].source_files, parts)
    const trashed = path.join(ep.projectDir, '_trash', path.relative(ep.projectDir, path.join(ep.audioDir, 'EP0002_Chapter_12.mp3')))
    assert.equal(await fs.readFile(trashed, 'utf8'), 'audio:EP0002_Chapter_12.mp3')
    const after = await versions.listChapterTakes(ep.episodeDir, ep.audioDir, 'EP0002', 'Chapter_12')
    assert.deepEqual(after.map(t => [t.files.length, t.active]), [[2, true]])
  })

  test('before Audio Assembly, the chosen _v2 take takes over the base name', async () => {
    const ep = await episode('no-selector', ['EP0002_Chapter_04.mp3', 'EP0002_Chapter_04_v2.mp3'])
    const result = await versions.useChapterTake({ ...ep, code: 'EP0002', slug: 'Chapter_04', files: ['EP0002_Chapter_04_v2.mp3'] })
    assert.deepEqual(result, { active: ['EP0002_Chapter_04.mp3'], trashed: ['EP0002_Chapter_04.mp3'] })
    assert.equal(await fs.readFile(path.join(ep.audioDir, 'EP0002_Chapter_04.mp3'), 'utf8'), 'audio:EP0002_Chapter_04_v2.mp3')
    await assert.rejects(fs.stat(path.join(ep.audioDir, 'EP0002_Chapter_04_v2.mp3')))
  })

  test('a take that is not on disk is refused and nothing moves', async () => {
    const ep = await episode('gone', ['EP0002_Chapter_01.mp3'])
    await assert.rejects(
      versions.useChapterTake({ ...ep, code: 'EP0002', slug: 'Chapter_01', files: ['EP0002_Chapter_01_v2.mp3'] }),
      /no longer in the audio folder/,
    )
    assert.ok(await fs.stat(path.join(ep.audioDir, 'EP0002_Chapter_01.mp3')))
  })

  test('the Audio page lists takes and offers Use This Version', async () => {
    const route = await fs.readFile(new URL('../routes/audio.ts', import.meta.url), 'utf8')
    assert.match(route, /audio-sections\/:section\/use-version/)
    assert.match(route, /takes_count: groupChapterTakes\(/)
    const selector = await fs.readFile(new URL('../../../frontend/components/AudioChapterSelector.vue', import.meta.url), 'utf8')
    assert.match(selector, />Use This Version<\/button>/)
    assert.match(selector, /v-if="\(s\.takes_count \|\| 0\) > 1"/)
  })
})
