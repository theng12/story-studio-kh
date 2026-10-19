/**
 * Regression — 2026-10-19, MERGED-AUDIO-PRESENCE-NON-MP3 (bulk importer).
 *
 * `planDestinations` (services/episode-import.ts) renamed every imported merged
 * track to `${code}_merged_audio.mp3`, so importing a music episode's `.m4a`
 * relabelled its bytes `.mp3`. The bucket filter already admits mp3/wav/m4a
 * (ASSET_EXT), so the source extension is now kept.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

const SLUG = 'episode-import-merged-ext'
const CODE = 'EP0009'

/** A source episode folder holding the given tracks under the 08 wording. */
async function sourceEpisode(tempDir: string, trackNames: string[]): Promise<string> {
  const projectDir = path.join(tempDir, 'projects', SLUG)
  const sourceDir = path.join(tempDir, 'incoming', `${CODE} - Music Episode`)
  const mergedDir = path.join(sourceDir, '08 Audio Merge Output')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Episode import merged extension',
    episode_prefix: 'EP',
    episode_digits: 4,
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 9, recycled_numbers: [],
  }))
  for (const name of trackNames) await fs.writeFile(path.join(mergedDir, name), 'merged audio bytes')
  return sourceDir
}

async function mergedDestinations(tempDir: string, trackNames: string[]): Promise<string[]> {
  const sourceDir = await sourceEpisode(tempDir, trackNames)
  const { inspectEpisodeFolder } = await import('../services/episode-import.js')
  const inspected = await inspectEpisodeFolder(SLUG, sourceDir)
  assert.equal(inspected.ok, true, `the fixture source folder must inspect: ${inspected.error ?? ''}`)
  const planned = inspected.discovered_files.filter(file => file.bucket === 'merged_audio')
  assert.equal(planned.length, trackNames.length, 'every merged track must be planned')
  return planned.map(file => path.basename(file.dest_relative))
}

test('control: an .mp3 merged source keeps the canonical .mp3 name', async () => {
  const temp = await useTempDataDir()
  try {
    assert.deepEqual(await mergedDestinations(temp.dir, [`${CODE}_merged_audio.mp3`]), [`${CODE}_merged_audio.mp3`])
  } finally {
    await temp.cleanup()
  }
})

test('a music episode\'s .m4a merged source is not relabelled .mp3', async () => {
  const temp = await useTempDataDir()
  try {
    assert.deepEqual(await mergedDestinations(temp.dir, [`${CODE}_merged_audio.m4a`]), [`${CODE}_merged_audio.m4a`])
  } finally {
    await temp.cleanup()
  }
})

test('a second merged track is versioned and keeps its extension', async () => {
  const temp = await useTempDataDir()
  try {
    assert.deepEqual(
      await mergedDestinations(temp.dir, ['a.m4a', 'b.m4a']),
      [`${CODE}_merged_audio.m4a`, `${CODE}_merged_audio_v2.m4a`],
    )
  } finally {
    await temp.cleanup()
  }
})
