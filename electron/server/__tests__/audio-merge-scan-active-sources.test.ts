// Dreamlands E2E (2026-10-03): a chapter regenerated under a smaller request boundary
// leaves its old single file beside the new `_partN` files. Audio Assembly listed BOTH,
// so the merge would have played Chapter 12 twice. The active source map decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
const pm = await import('../services/project-manager.js')
const { scanEpisodeAudioAssets } = await import('../generators/audio-merge.js')

test('Audio Assembly lists only the active sources of a chapter the source map names', async () => {
  const project = await pm.createProject({ name: 'Scan Active Sources', episode_prefix: 'EP', episode_digits: 3 })
  const root = (await pm.getProjectOutputRoot(project.slug))!
  const episodeDir = path.join(root, 'EP001 - Test')
  const audioDir = path.join(episodeDir, 'EP001 - 07 Audio Assets')
  await fs.mkdir(audioDir, { recursive: true })
  for (const f of ['EP001_Chapter_01.mp3', 'EP001_Chapter_02.mp3', 'EP001_Chapter_02_part1.mp3', 'EP001_Chapter_02_part2.mp3']) {
    await fs.writeFile(path.join(audioDir, f), 'x')
  }
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({ sections: [
    { slug: 'Chapter_01', source_files: ['EP001_Chapter_01.mp3'] },
    { slug: 'Chapter_02', source_files: ['EP001_Chapter_02_part1.mp3', 'EP001_Chapter_02_part2.mp3'] },
  ] }))
  const scanned = await scanEpisodeAudioAssets(project.slug, 'EP001')
  assert.deepEqual(scanned.chapters.map(c => c.filename),
    ['EP001_Chapter_01.mp3', 'EP001_Chapter_02_part1.mp3', 'EP001_Chapter_02_part2.mp3'])
})
