import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { computeEpisodeIntroLeadInSec } from '../lib/intro-lead-in.js'

let root: string

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-intro-lead-in-'))
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('manual subtitle re-stitch lead-in resolution', () => {
  test('returns zero when no merged audio exists instead of inventing an offset', async () => {
    const episodeDir = path.join(root, 'episode')
    const mergedDir = path.join(episodeDir, 'merged')
    await fs.mkdir(mergedDir, { recursive: true })
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: [{ slug: 'Chapter_01', duration_s: 10 }],
      gap_duration_s: 1,
    }))

    assert.equal(
      await computeEpisodeIntroLeadInSec(episodeDir, mergedDir, 'EP0012'),
      0,
    )
  })

  test('ignores a different episode merged file in the same folder', async () => {
    const episodeDir = path.join(root, 'wrong-code')
    const mergedDir = path.join(episodeDir, 'merged')
    await fs.mkdir(mergedDir, { recursive: true })
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: [{ slug: 'Chapter_01', duration_s: 10 }],
      gap_duration_s: 1,
    }))
    await fs.writeFile(path.join(mergedDir, 'EP9999_merged_audio.mp3'), 'not audio')

    assert.equal(
      await computeEpisodeIntroLeadInSec(episodeDir, mergedDir, 'EP0012'),
      0,
    )
  })
})
