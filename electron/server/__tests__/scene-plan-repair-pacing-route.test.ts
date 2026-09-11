import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

async function bootApp(): Promise<typeof import('../app.js').app> {
  const app = (await import('../app.js')).app
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot before repair pacing fixture setup' })
  return app
}

async function repairFixture(name: string, planPacing?: unknown) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Repair pacing fixture', logline: '', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'test')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  const planBytes = JSON.stringify({
    schema_version: 1,
    generated_at: '2026-09-11T00:00:00.000Z',
    total_duration_sec: 8,
    ...(planPacing === undefined ? {} : { pacing: planPacing }),
    scenes: [{
      id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8,
      transcript_segment: 'A complete cue.', visual_prompt: 'Keep this prompt.', approved: true,
    }],
  }, null, 2)
  await fs.writeFile(planPath, planBytes)
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:08,000\nA complete cue.\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
  return { project, episodeId, paths, planPath, planBytes }
}

test('legacy plan repair rejects explicit partial episode pacing without changing the plan', async () => {
  const temp = await useTempDataDir()
  const previousDisableListen = process.env.STORY_STUDIO_DISABLE_LISTEN
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = await bootApp()
    const fixture = await repairFixture('Legacy repair rejects partial pacing')
    await fs.writeFile(path.join(fixture.paths.episode_dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: { min_sec: 4 },
    }))
    const response = await request(app)
      .post(`/api/projects/${fixture.project.slug}/scene-plan/${fixture.episodeId}/repair-long-scenes`)
      .send({})

    assert.equal(response.status, 500, JSON.stringify(response.body))
    assert.match(response.body.detail, /pacing\.max_sec must be a finite number/i)
    assert.equal(await fs.readFile(fixture.planPath, 'utf8'), fixture.planBytes)
  } finally {
    if (previousDisableListen === undefined) delete process.env.STORY_STUDIO_DISABLE_LISTEN
    else process.env.STORY_STUDIO_DISABLE_LISTEN = previousDisableListen
    await temp.cleanup()
  }
})

test('saved plan pacing ignores a malformed current draft during repair and preserves a no-op plan', async () => {
  const temp = await useTempDataDir()
  const previousDisableListen = process.env.STORY_STUDIO_DISABLE_LISTEN
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = await bootApp()
    const fixture = await repairFixture('Saved repair ignores malformed draft', { mode: 'live', min_sec: 3, max_sec: 12 })
    await fs.writeFile(path.join(fixture.paths.episode_dir, 'continuity.json'), '{"pacing":')

    const response = await request(app)
      .post(`/api/projects/${fixture.project.slug}/scene-plan/${fixture.episodeId}/repair-long-scenes`)
      .send({})

    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.match(response.body.detail, /No scenes exceed the saved Scene Plan pacing cap/i)
    assert.equal(await fs.readFile(fixture.planPath, 'utf8'), fixture.planBytes)
  } finally {
    if (previousDisableListen === undefined) delete process.env.STORY_STUDIO_DISABLE_LISTEN
    else process.env.STORY_STUDIO_DISABLE_LISTEN = previousDisableListen
    await temp.cleanup()
  }
})
