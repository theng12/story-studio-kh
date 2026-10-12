import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'mixed-scene-pool'
const CODE = 'EP0001'

describe('Video Assembly authoritative Scene Plan pool', () => {
  before(async () => {
    tmp = await useTempDataDir()
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('ignores retired numbered pools and reports exact Scene Plan readiness', async () => {
    const projectDir = path.join(tmp.dir, 'projects', SLUG)
    const episodeDir = path.join(projectDir, 'episodes', 'Season 001', `${CODE} - Mixed Sources`)
    const classicDir = path.join(episodeDir, `${CODE} - 05 Scene Images`)
    const plannedDir = path.join(episodeDir, 'scene_images')

    await fs.mkdir(classicDir, { recursive: true })
    await fs.mkdir(plannedDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: SLUG,
      name: 'Mixed Scene Pool',
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
      generated_at: new Date().toISOString(),
      total_duration_sec: 15,
      research_used: false,
      opening_mode: 'from-start',
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
        {
          id: 'scene-missing',
          scene_index: 3,
          start_sec: 10,
          end_sec: 15,
          transcript_segment: 'Three',
          visual_prompt: 'Three',
          approved: false,
        },
      ],
    }, null, 2))
    const subtitlesDir = path.join(episodeDir, `${CODE} - 09 Subtitles Output`)
    const stitchedPath = path.join(subtitlesDir, `${CODE}_stitched.srt`)
    await fs.mkdir(subtitlesDir, { recursive: true })
    await fs.writeFile(stitchedPath, '1\n00:00:00,000 --> 00:00:15,000\nNarration\n')
    await fs.writeFile(`${stitchedPath}.json`, JSON.stringify({
      complete: true,
      missing_sections: [],
      sections: [{ slug: 'Introduction', source_srt: `${CODE}_Introduction.srt`, cues_added: 1 }],
    }))

    const { scanEpisodeAssets } = await import('../generators/video.js')
    const assets = await scanEpisodeAssets(SLUG, CODE)

    assert.deepEqual(assets.scene_sources, { classic: 0, scene_plan: 2 })
    assert.deepEqual(assets.scene_plan_coverage, {
      total: 3,
      ready: 1,
      missing: [{ id: 'scene-missing', scene_index: 3 }],
      unapproved: [{ id: 'scene-unapproved', scene_index: 2 }],
      stale: [],
    })
    assert.equal(assets.scenes.length, 2)

    // Both plan scenes surface in scene_index order, each carrying its approval
    // flag so the UI can still distinguish reviewed (approved) from unreviewed.
    assert.equal(assets.scenes[0]?.source, 'scene_plan')
    assert.equal(assets.scenes[0]?.planned_scene_index, 1)
    assert.equal(assets.scenes[0]?.plan_scene_id, 'scene-planned')
    assert.equal(assets.scenes[0]?.approved, true)
    assert.equal(assets.scenes[1]?.source, 'scene_plan')
    assert.equal(assets.scenes[1]?.planned_scene_index, 2)
    assert.equal(assets.scenes[1]?.approved, false)

    assert.equal(assets.scene_plan_timing?.complete, false)
    assert.equal(assets.scene_plan_timing?.approved, 1)

    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const { app } = await import('../app.js')
    const guarded = await request(app)
      .post(`/api/projects/${SLUG}/generate/video-assembly`)
      .send({
        episode_id: CODE,
      })
    assert.equal(guarded.status, 409)
    assert.match(guarded.body.detail, /missing image/i)
  })
})
