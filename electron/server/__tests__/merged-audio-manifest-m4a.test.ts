/**
 * Regression — 2026-10-19, MERGED-AUDIO-PRESENCE-NON-MP3 (manifest audit).
 *
 * `auditMergedAudio` (services/manifest-audit.ts) matched the merged track with
 * its own `.mp3`-only regex and, when nothing matched, reported the hardcoded
 * `${code}_merged_audio.mp3` as missing. A music episode writes exactly
 * `${code}_merged_audio.m4a` (generators/music-episode-build.ts:225), so the
 * audit told the owner an existing required output was absent — the same defect
 * `inspectAudioMergeAtPaths` had.
 *
 * The `.mp3` case is the POSITIVE CONTROL: it must read present before and after
 * the fix, so a broken fixture cannot masquerade as a green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

const SLUG = 'merged-audio-manifest-m4a'
const CODE = 'EP0001'

/** One accepted episode whose merged-audio folder holds exactly one track. */
async function seed(tempDir: string, trackName: string): Promise<void> {
  const projectDir = path.join(tempDir, 'projects', SLUG)
  const episodeDir = path.join(projectDir, 'episodes', `${CODE} - Music Episode`)
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Merged audio manifest audit',
    episode_prefix: 'EP',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', title: 'Music Episode', status: 'accepted', episode_code: CODE }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  await fs.writeFile(path.join(mergedDir, trackName), 'merged audio bytes')
}

async function mergedStage(tempDir: string, trackName: string) {
  await seed(tempDir, trackName)
  const { auditAssets } = await import('../services/manifest-audit.js')
  const report = await auditAssets(SLUG)
  const episode = report.episodes.find(row => row.episode_code === CODE)
  assert.ok(episode, 'the fixture episode must be audited')
  return episode.stages.find(stage => stage.stage === 'merged_audio')!
}

test('control: an .mp3 merged track reads present (fixture is live)', async () => {
  const temp = await useTempDataDir()
  try {
    const stage = await mergedStage(temp.dir, `${CODE}_merged_audio.mp3`)
    assert.deepEqual(
      { outcome: stage.outcome, started: stage.started, present: stage.present, missing: stage.missing },
      { outcome: 'measured', started: true, present: 1, missing: [] },
    )
  } finally {
    await temp.cleanup()
  }
})

test('RED: a music episode\'s .m4a merged track is not reported missing', async () => {
  const temp = await useTempDataDir()
  try {
    const stage = await mergedStage(temp.dir, `${CODE}_merged_audio.m4a`)
    assert.equal(stage.present, 1, 'the merged track on disk must be counted')
    assert.deepEqual(stage.missing, [], 'a track the canonical rule accepts must not be reported missing')
    assert.equal(stage.started, true)
  } finally {
    await temp.cleanup()
  }
})

test('RED: a .wav merged track is not reported missing', async () => {
  const temp = await useTempDataDir()
  try {
    const stage = await mergedStage(temp.dir, `${CODE}_merged_audio.wav`)
    assert.equal(stage.present, 1)
    assert.deepEqual(stage.missing, [])
  } finally {
    await temp.cleanup()
  }
})
