// boundful EP0100 (Story 1.4.277, 2026-10-10): Audio counted 21/21 chapter files, but Audio
// Assembly failed every time with "no chapter audio files were found". Season 005 held two
// "EP0100 - " folders: the episode's own (Voynich, all the audio) and a renumber leftover
// (How Aztec Star Watchers…, now EP0116, no audio). Assembly took the first code match.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
const pm = await import('../services/project-manager.js')
const { scanEpisodeAudioAssets } = await import('../generators/audio-merge.js')
const { resolveAudioDir } = await import('../generators/audio.js')

const SLUG = 'boundful-same-code'
const CODE = 'EP0100'
const TITLE = "The Bizarre Logistics of the Voynich Manuscript's Move from Prague to Rome"
const LEFTOVER = 'How Aztec Star Watchers Predicted the 1496 Eclipse'

test('Audio Assembly scans the same EP0100 folder Audio counts, not a same-code leftover', async () => {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'KH Boundless', episode_prefix: 'EP', episode_digits: 4, season_size: 20,
    season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [
      { id: 'i-100', title: TITLE, status: 'accepted', episode_code: CODE },
      { id: 'i-116', title: LEFTOVER, status: 'accepted', episode_code: 'EP0116' },
    ],
    next_episode_number: 117, recycled_numbers: [],
  }))
  const season = path.join(projDir, 'episodes', 'Season 005')
  // The leftover sorts first ("How" < "The") and has an empty audio folder.
  await fs.mkdir(path.join(season, `${CODE} - ${LEFTOVER}`, `${CODE} - 07 Audio Assets`), { recursive: true })
  const episodeDir = path.join(season, `${CODE} - ${TITLE}`)
  const audioDir = path.join(episodeDir, `${CODE} - 07 Audio Assets`)
  await fs.mkdir(audioDir, { recursive: true })
  const files = ['EP0100_Introduction.mp3', ...Array.from({ length: 20 }, (_, i) => `EP0100_Chapter_${String(i + 1).padStart(2, '0')}.mp3`)]
  for (const file of files) await fs.writeFile(path.join(audioDir, file), 'x')

  const statusDir = await resolveAudioDir(SLUG, path.join(episodeDir, `${CODE} - 01 Script`, `${CODE}_Script_Narration.md`), CODE)
  const scanned = await scanEpisodeAudioAssets(SLUG, CODE)
  assert.equal(scanned.episode_dir, episodeDir)
  assert.equal(scanned.audio_dir, statusDir)
  assert.deepEqual(scanned.chapters.map(chapter => chapter.filename), files)

  // The merged narration Assembly writes there is the one the episode status sees.
  const mergedDir = path.join(episodeDir, `${CODE} - 08 Audio Merge Output`)
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.writeFile(path.join(mergedDir, `${CODE}_merged_audio.mp3`), Buffer.alloc(2048, 1))
  const { getAudioMergeStatus } = await import('../services/asset-status.js')
  const merged = await getAudioMergeStatus(SLUG, CODE)
  assert.equal(merged.present, true, JSON.stringify(merged))
})
