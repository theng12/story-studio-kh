import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
})

after(async () => { await cleanup() })

async function addEpisode(slug: string, title: string): Promise<string> {
  const [idea] = await ideas.addIdeas(slug, [{
    title, logline: '', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await ideas.acceptIdea(slug, idea!.id, false)
  return accepted.episode_code
}

const commonDone = {
  script: true,
  thumb_prompts: true,
  thumbnails: true,
  audio: true,
  merged_audio: true,
  subtitles: true,
  metadata: true,
  video_assembly: true,
}

test('episode rows derive visual source and completion from each episode branch', async () => {
  const project = await pm.createProject({ name: 'Mixed completion rows' })
  const sceneCode = await addEpisode(project.slug, 'Scene Plan complete')
  const poolCode = await addEpisode(project.slug, 'Image Pool complete')
  const unreadyPoolCode = await addEpisode(project.slug, 'Image Pool unready')

  await ideas.setEpisodeStatusOverrides(project.slug, sceneCode, {
    ...commonDone, character_sheet: true, scene_plan: true, scene_review: true, broll_picked: false,
  })
  await ideas.setEpisodeStatusOverrides(project.slug, poolCode, {
    ...commonDone, scene_plan: false, scene_review: false, broll_picked: true,
  })
  await ideas.setEpisodeStatusOverrides(project.slug, unreadyPoolCode, {
    ...commonDone, scene_plan: true, scene_review: true, broll_picked: false,
  })

  for (const code of [poolCode, unreadyPoolCode]) {
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await fs.writeFile(path.join(paths.episode_dir, 'broll-selection.json'), JSON.stringify({
      schema_version: 1,
      episode_code: code,
      source: 'image_pool',
    }))
  }

  const response = await request(app).get(`/api/projects/${project.slug}/episodes?refresh=1`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const byCode = new Map(response.body.map((row: any) => [row.episode_code, row]))
  const scene = byCode.get(sceneCode) as any
  const pool = byCode.get(poolCode) as any
  const unreadyPool = byCode.get(unreadyPoolCode) as any

  assert.equal(scene.visual_source, 'scene_plan')
  assert.equal(scene.status.visual_source, 'scene_plan')
  assert.equal(scene.status.all_done, true)

  assert.equal(pool.visual_source, 'image_pool')
  assert.equal(pool.status.visual_source, 'image_pool')
  assert.equal(pool.status.all_done, true, 'Scene Plan artifacts do not hold an Image Pool row back')

  assert.equal(unreadyPool.status.all_done, false,
    'an Image Pool row requires its own selected-image readiness even when old Scene Plan artifacts exist')
})
