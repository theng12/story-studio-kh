import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'mixed-scene-pool'
const CODE = 'EP0001'

describe('Video Assembly mixed scene pool', () => {
  before(async () => {
    tmp = await useTempDataDir()
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('returns classic and approved Scene Plan renders together', async () => {
    const projectDir = path.join(tmp.dir, 'projects', SLUG)
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Mixed Sources`)
    const classicDir = path.join(episodeDir, `${CODE} - 05 Scene Images`)
    const plannedDir = path.join(episodeDir, 'scene_images')

    await fs.mkdir(classicDir, { recursive: true })
    await fs.mkdir(plannedDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: SLUG,
      name: 'Mixed Scene Pool',
      output_root: './episodes',
      episode_prefix: 'EP',
      season_size: 20,
      season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }, null, 2))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [{
        id: 'idea-1',
        title: 'Mixed Sources',
        status: 'accepted',
        episode_code: CODE,
      }],
      next_episode_number: 2,
      recycled_numbers: [],
    }, null, 2))

    const classicPath = path.join(classicDir, `${CODE}_Scene01_v1.png`)
    const plannedPath = path.join(plannedDir, 'scene-planned.png')
    const unapprovedPath = path.join(plannedDir, 'scene-unapproved.png')
    await fs.writeFile(classicPath, 'classic')
    await fs.writeFile(plannedPath, 'planned')
    await fs.writeFile(unapprovedPath, 'unapproved')
    await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
      schema_version: 1,
      scenes: [
        {
          id: 'scene-planned',
          scene_index: 1,
          start_sec: 0,
          end_sec: 5,
          transcript_segment: 'One',
          visual_prompt: 'One',
          approved: true,
          image_path: plannedPath,
        },
        {
          id: 'scene-unapproved',
          scene_index: 2,
          start_sec: 5,
          end_sec: 10,
          transcript_segment: 'Two',
          visual_prompt: 'Two',
          approved: false,
          image_path: unapprovedPath,
        },
      ],
    }, null, 2))

    const { scanEpisodeAssets } = await import('../generators/video.js')
    const assets = await scanEpisodeAssets(SLUG, CODE)

    assert.deepEqual(assets.scene_sources, { classic: 1, scene_plan: 1 })
    assert.equal(assets.scenes.length, 2)
    assert.equal(assets.scenes[0]?.source, 'classic')
    assert.equal(assets.scenes[1]?.source, 'scene_plan')
    assert.equal(assets.scenes[1]?.planned_scene_index, 1)
    assert.notEqual(assets.scenes[0]?.number, assets.scenes[1]?.number)
  })
})
