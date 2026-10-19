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
    // `stage`, and the visual stage names itself. These now carry the scenes at
    // fault, so the verdict is read through the same normaliser the queue uses.
    const { readCancellationAudit } = await import('../services/job-cancellation-auditors.js')
    assert.equal(readCancellationAudit(await auditScenePlanOutput({ ...base, params: {} })).verdict, 'repair-required')
    assert.equal(readCancellationAudit(await auditScenePlanOutput({ ...base, params: { stage: 'visual' } })).verdict, 'repair-required')
  } finally {
    await temp.cleanup()
  }
})

/**
 * AGENTS.md §8: an error must name the missing or invalid items. The post-restart reconciliation
 * used to say only "Provider output needs repair…" about a job whose own auditor had already
 * worked out exactly which scenes had no prompt (Nature EP0014, 2026-10-19).
 */
test('a repair-required scene plan names the scenes at fault', async () => {
  const temp = await useTempDataDir()
  try {
    const { auditScenePlanOutput } = await import('../boot/executors.js')
    const { readCancellationAudit } = await import('../services/job-cancellation-auditors.js')
    const { project, episodeId, paths } = await createEpisode('Scene plan repair detail')
    await writePlan(paths, {
      schema_version: 1,
      timeline_built_at: '2026-10-19T00:00:00.000Z',
      scenes: [
        { id: 'S0001', scene_index: 1, start_sec: 0, end_sec: 2, transcript_segment: 'Narration.', visual_prompt: 'A real prompt.' },
        { id: 'S0002', scene_index: 2, start_sec: 2, end_sec: 4, transcript_segment: 'More.', visual_prompt: '' },
        { id: 'S0003', scene_index: 3, start_sec: 4, end_sec: 6, transcript_segment: 'And more.', visual_prompt: '   ' },
        // Two scenes sharing one prompt are duplicates, not two complete scenes.
        { id: 'S0004', scene_index: 4, start_sec: 6, end_sec: 8, transcript_segment: 'Still more.', visual_prompt: 'A real prompt.' },
      ],
    })
    const audit = readCancellationAudit(await auditScenePlanOutput({ project_slug: project.slug, episode_id: episodeId, params: {} }))
    assert.equal(audit.verdict, 'repair-required')
    assert.ok(audit.detail, 'the detail must be present, not just the verdict')
    assert.match(audit.detail!, /^Scene plan visual prompts incomplete: 1\/4 required item\(s\) verified\./)
    assert.match(audit.detail!, /Missing visual prompts: S0002, S0003\./)
    // The FIRST occurrence of a repeated prompt stays valid; the later copy is the invalid one.
    assert.match(audit.detail!, /Invalid visual prompt: S0004 \(duplicate prompt\)\./)
    assert.match(audit.detail!, /Retry rewrites only those scenes/)
  } finally {
    await temp.cleanup()
  }
})

test('a bare verdict still normalises, so auditors that know nothing extra are unchanged', async () => {
  const { readCancellationAudit } = await import('../services/job-cancellation-auditors.js')
  assert.deepEqual(readCancellationAudit('complete'), { verdict: 'complete' })
  assert.deepEqual(readCancellationAudit('repair-required'), { verdict: 'repair-required' })
  assert.deepEqual(readCancellationAudit({ verdict: 'repair-required', detail: '  ' }), { verdict: 'repair-required' })
  assert.deepEqual(readCancellationAudit({ verdict: 'repair-required', detail: ' S0002 has no prompt. ' }),
    { verdict: 'repair-required', detail: 'S0002 has no prompt.' })
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
