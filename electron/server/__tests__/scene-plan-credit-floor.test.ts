import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

test('Scene Plan stops at the first credit refusal without repairs or later packs', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache, isGenStudioInsufficientCredits } = await import('../lib/genstudio-client.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    await import('../providers/text/genstudio.js')
    const { runScenePlanJob } = await import('../generators/scene-plan.js')

    const project = await pm.createProject({ name: 'Scene plan credit floor', episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Credit floor', logline: 'A test.', themes: [],
      suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
    }], 'mock-chat-v1')
    assert.ok(idea)
    const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)

    await fs.mkdir(paths.subtitles_dir, { recursive: true })
    const stitched = path.join(paths.subtitles_dir, `${accepted.episode_code}_stitched.srt`)
    await fs.writeFile(stitched, [
      '1', '00:00:00,000 --> 00:00:01,000', 'First scene.', '',
      '2', '00:00:01,000 --> 00:00:02,000', 'Second scene.', '',
      '3', '00:00:02,000 --> 00:00:03,000', 'Third scene.', '',
    ].join('\n'))
    await fs.writeFile(`${stitched}.json`, JSON.stringify({
      complete: true,
      missing_sections: [],
      sections: [{ slug: 'full-track', source_srt: `${accepted.episode_code}.srt`, cues_added: 3 }],
    }))

    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      timeline_built_at: new Date().toISOString(),
      planner_model: 'deterministic-timeline',
      source_stitched_srt: path.basename(stitched),
      total_duration_sec: 3,
      research_used: false,
      planning_stage: 'timeline',
      scenes: [0, 1, 2].map(index => ({
        id: `scene-${index + 1}`,
        scene_index: index + 1,
        start_sec: index,
        end_sec: index + 1,
        transcript_segment: `${['First', 'Second', 'Third'][index]} scene.`,
        visual_prompt: '',
      })),
    }, null, 2))

    await settings.setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()

    let chatPosts = 0
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (url.endsWith('/v1/chat/responses') && method === 'POST') {
        chatPosts++
        return Response.json({ detail: 'Insufficient credits' }, { status: 402 })
      }
      return originalFetch(input, init)
    }

    const job: any = {
      job_id: 'scene-plan-credit-floor-job',
      project_slug: project.slug,
      episode_id: accepted.episode_code,
      type: 'scene_plan_run',
      title: 'Scene Plan',
      status: 'running',
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      output_lines: [],
      params: {
        episode_id: accepted.episode_code,
        stage: 'visual',
        model: 'genstudio-chat:mock-chat-v1',
        use_research: false,
        prompt_pack_size: 1,
      },
    }

    await assert.rejects(
      runScenePlanJob(job),
      error => isGenStudioInsufficientCredits(error),
    )
    assert.equal(chatPosts, 1)
    assert.equal(job.output_lines.some((line: string) => line.includes('prompt repair')), false)
    const plan = JSON.parse(await fs.readFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), 'utf8'))
    assert.deepEqual(plan.scenes.map((scene: any) => scene.visual_prompt), ['', '', ''])
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
    await temp.cleanup()
  }
})

test('Scene Plan restart auditing is stage-aware and requires every requested prompt', async () => {
  const temp = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { auditScenePlanOutput } = await import('../boot/executors.js')
    const project = await pm.createProject({ name: 'Scene plan restart audit', episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Restart audit', logline: 'A test.', themes: [],
      suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
    }], 'mock-chat-v1')
    assert.ok(idea)
    const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    const scenes = [{
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 1,
      transcript_segment: 'First.', visual_prompt: 'A distinct archival first scene.',
      motion_mode: 'gentle', motion_prompt: 'A slow drift.',
    }, {
      id: 'scene-2', scene_index: 2, start_sec: 1, end_sec: 2,
      transcript_segment: 'Second.', visual_prompt: '',
      motion_mode: 'still', motion_prompt: '',
    }]
    await fs.writeFile(planPath, JSON.stringify({
      schema_version: 1, generated_at: new Date().toISOString(), total_duration_sec: 2,
      research_used: false, planning_stage: 'visual', scenes,
    }))
    const base = {
      project_slug: project.slug,
      episode_id: accepted.episode_code,
      params: { episode_id: accepted.episode_code, stage: 'visual' },
    }
    // The verdict now travels with the scenes at fault, so read it the way the queue does.
    const { readCancellationAudit } = await import('../services/job-cancellation-auditors.js')
    assert.equal(readCancellationAudit(await auditScenePlanOutput(base)).verdict, 'repair-required')
    scenes[1]!.visual_prompt = 'A distinct archival second scene.'
    await fs.writeFile(planPath, JSON.stringify({
      schema_version: 1, generated_at: new Date().toISOString(), total_duration_sec: 2,
      research_used: false, planning_stage: 'visual', scenes,
    }))
    assert.equal(await auditScenePlanOutput(base), 'complete')
    assert.equal(await auditScenePlanOutput({ ...base, params: { ...base.params, stage: 'motion' } }), 'complete')
  } finally {
    await temp.cleanup()
  }
})

test('saved motion snapshots ignore a later Still choice without broadening to another scene', async () => {
  const temp = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { auditSceneClips, auditScenePlanOutput } = await import('../boot/executors.js')
    const project = await pm.createProject({ name: 'Still motion audit', episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Still snapshot', logline: 'A test.', themes: [],
      suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
    }], 'mock-chat-v1')
    assert.ok(idea)
    const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
      schema_version: 1, generated_at: new Date().toISOString(), total_duration_sec: 2,
      research_used: false, planning_stage: 'motion', scenes: [{
        id: 'saved-scene', scene_index: 1, start_sec: 0, end_sec: 1,
        transcript_segment: 'Saved.', visual_prompt: 'A saved scene.', motion_prompt: '', motion_choice: 'still',
      }, {
        id: 'unscoped-scene', scene_index: 2, start_sec: 1, end_sec: 2,
        transcript_segment: 'Unscoped.', visual_prompt: 'An unscoped scene.', motion_prompt: '', motion_choice: 'clip',
      }],
    }))

    const params = { episode_id: accepted.episode_code, stage: 'motion', motion_scene_ids: ['saved-scene'] }
    const job = { project_slug: project.slug, episode_id: accepted.episode_code, params }
    assert.equal(await auditScenePlanOutput(job), 'complete')
    assert.equal(await auditSceneClips(job), 'complete')
    assert.deepEqual(params.motion_scene_ids, ['saved-scene'])
  } finally {
    await temp.cleanup()
  }
})
