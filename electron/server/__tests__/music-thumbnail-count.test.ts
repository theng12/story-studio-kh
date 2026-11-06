import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

test('music thumbnail options use the requested count, bounded only by this episode’s scenes', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const music = await import('../services/music-episode-store.js')
  const { resolveScenePlanPath } = await import('../services/utils.js')
  const { writeMusicThumbnailPrompts } = await import('../services/music-episode-thumbnail.js')
  const { toMdPath } = await import('../lib/episode-artifacts.js')
  const channel = await pm.createProject({ name: 'Music thumbnail counts', episode_prefix: 'MC', episode_digits: 4 })
  const projectDir = pm.getProjectDir(channel.slug)!
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'mix', title: 'Evening music', status: 'accepted', episode_code: 'MC0001' }],
    next_episode_number: 2, recycled_numbers: [],
  }))
  const doc = await music.newEpisodeDoc(channel.slug, 'MC0001')
  doc.settings.scenes.title_on_scene = false
  const episodeDir = await music.episodeDirFor(channel.slug, 'MC0001')
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.writeFile(path.join(episodeDir, music.MUSIC_EPISODE_FILENAME), JSON.stringify(doc))
  const planPath = await resolveScenePlanPath(channel.slug, 'MC0001', episodeDir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify({ scenes: Array.from({ length: 8 }, (_, i) => ({
    id: `scene-${i + 1}`, scene_index: i + 1, visual_prompt: `Distinct landscape ${i + 1}`,
  })) }))

  const starting = await writeMusicThumbnailPrompts(channel.slug, 'MC0001')
  assert.equal(starting.requested, 3)
  assert.equal(starting.count, 3)
  const extended = await writeMusicThumbnailPrompts(channel.slug, 'MC0001', { count: 10, overwrite: true })
  assert.equal(extended.requested, 10)
  assert.equal(extended.count, 8, 'all eight scenes remain available above the former six-option ceiling')
  const markdownPath = toMdPath(extended.path)
  const original = await fs.readFile(markdownPath, 'utf8')
  assert.equal((original.match(/^## Thumbnail /gm) || []).length, 8)
  assert.match(original, /Distinct landscape 8/)
  const kept = await writeMusicThumbnailPrompts(channel.slug, 'MC0001', { count: 1 })
  assert.equal(kept.written, false)
  assert.equal(await fs.readFile(markdownPath, 'utf8'), original, 'changing the requested count never backfills existing prompts')
})
