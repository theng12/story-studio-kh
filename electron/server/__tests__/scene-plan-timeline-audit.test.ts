/**
 * Scene Plan's "Build timeline" is a deliberately **model-free** step: it writes
 * cue-aligned scenes with real timings and empty `visual_prompt` values, and the
 * visual prompts arrive in the later `stage: 'visual'` run.
 *
 * `auditScenePlanOutput` used to fold every non-motion stage into 'visual', so a
 * timeline-only job was judged against the visual prompts it is not supposed to
 * produce: the run reported success, the audit disagreed, and the job failed
 * after three local attempts with "reported success, but re-reading its output
 * found required items missing" — while the page's own timeline was on disk and
 * correct. These cases pin the timeline's own proof and keep the visual stage's
 * requirement exactly as strict as it was.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Timeline audit fixture', logline: 'A deterministic timeline fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return {
    project,
    episodeId: accepted.episode_code,
    paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code),
  }
}

async function writePlan(
  paths: { scene_prompts_dir: string },
  plan: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify(plan))
}

test('a timeline-only run is audited on its timeline, not on the visual prompts it must not produce', async () => {
  const temp = await useTempDataDir()
  try {
    const { auditScenePlanOutput } = await import('../boot/executors.js')
    const { project, episodeId, paths } = await createEpisode('Timeline-only audit')
    await writePlan(paths, {
      schema_version: 1,
      timeline_built_at: '2026-09-22T00:00:00.000Z',
      scenes: [
        { id: 'ep-scene-0001', scene_index: 1, start_sec: 0, end_sec: 2.3, transcript_segment: 'Narration.', visual_prompt: '' },
        { id: 'ep-scene-0002', scene_index: 2, start_sec: 2.3, end_sec: 4.6, transcript_segment: 'More narration.', visual_prompt: '' },
      ],
    })
    const base = { project_slug: project.slug, episode_id: episodeId }

    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'timeline' } }), 'complete')

    // Unchanged for the runs that DO owe visual prompts: a Pipeline run omits
    // `stage`, and the visual stage names itself.
    assert.equal(await auditScenePlanOutput({ ...base, params: {} }), 'repair-required')
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'visual' } }), 'repair-required')
  } finally {
    await temp.cleanup()
  }
})

test('a timeline-only run with nothing usable to show is still repair-required', async () => {
  const temp = await useTempDataDir()
  try {
    const { auditScenePlanOutput } = await import('../boot/executors.js')
    const { project, episodeId, paths } = await createEpisode('Empty timeline audit')
    const base = { project_slug: project.slug, episode_id: episodeId }

    await writePlan(paths, { schema_version: 1, timeline_built_at: null, scenes: [] })
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'timeline' } }), 'repair-required')

    // A scene that runs backwards (or has no duration) is not a timeline.
    await writePlan(paths, {
      schema_version: 1,
      timeline_built_at: '2026-09-22T00:00:00.000Z',
      scenes: [{ id: 'ep-scene-0001', scene_index: 1, start_sec: 4, end_sec: 4, transcript_segment: 'Narration.' }],
    })
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'timeline' } }), 'repair-required')

    // Timings but no record that a timeline was built is equally unverifiable.
    await writePlan(paths, {
      schema_version: 1,
      scenes: [{ id: 'ep-scene-0001', scene_index: 1, start_sec: 0, end_sec: 2, transcript_segment: 'Narration.' }],
    })
    assert.equal(await auditScenePlanOutput({ ...base, params: { stage: 'timeline' } }), 'repair-required')
  } finally {
    await temp.cleanup()
  }
})
