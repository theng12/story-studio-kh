import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

// CJ0001 (2026-10-25): Scene Plan on a music episode failed three retries on a stitched SRT a music
// episode never has. It now refuses once, plainly, pointing at Episode Builder.
test('Scene Plan refuses a music episode up front, without retrying or touching its plan', async () => {
  const temp = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { MUSIC_EPISODE_FILENAME } = await import('../services/music-episode-store.js')
    const { isNonRetryableError } = await import('../services/job-retry-policy.js')
    const { runScenePlanJob } = await import('../generators/scene-plan.js')

    const project = await pm.createProject({ name: 'Music scene plan', episode_prefix: 'CJ', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Fog lifting', logline: 'A test.', themes: [],
      suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
    }], 'mock-chat-v1')
    assert.ok(idea)
    const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await fs.writeFile(path.join(paths.episode_dir, MUSIC_EPISODE_FILENAME), '{}')

    const job: any = {
      job_id: 'scene-plan-music-job', project_slug: project.slug, episode_id: accepted.episode_code,
      type: 'scene_plan_run', title: 'Scene Plan', status: 'running',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null,
      output_lines: [], params: { episode_id: accepted.episode_code, stage: 'visual', model: 'genstudio-chat:mock-chat-v1' },
    }
    await assert.rejects(runScenePlanJob(job), (error: Error) => {
      assert.match(error.message, /music episode.*Episode Builder/)
      assert.doesNotMatch(error.message, /ENOENT/)
      assert.equal(isNonRetryableError(error), true)
      return true
    })
    await assert.rejects(fs.stat(path.join(paths.scene_prompts_dir, 'scene_plan.json')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})
