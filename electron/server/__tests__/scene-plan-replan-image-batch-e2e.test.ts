/**
 * v1.4.374 — ONE end-to-end test for the re-plan → image batch path.
 *
 * THE INCIDENT (The Curious Why EP0006, 2026-11-01). A forced re-plan went
 * from 36 to 68 scenes. The rebuilt timeline RESTARTS the scene ids, so ids
 * 0001–0036 still had the OLD plan's pictures on disk. The next scene-image
 * batch reported "32/32 target scene(s) verified; 36 skipped" and KEPT those
 * pictures — but they had been drawn for different narration, because the new
 * plan's prompt for those ids says something else.
 *
 * The fix (services/scene-plan-staleness.ts) has three moving parts, and the
 * unit tests only ever see them apart:
 *
 *   1. the CARRY-OVER — a re-plan carries each scene's picture and clip facts
 *      forward by id, and records which prompt the picture was drawn from;
 *   2. the STALE RULE — a picture whose record differs from the prompt the
 *      scene now carries is stale, and an ABSENT record (a picture drawn
 *      before `rendered_prompt` existed) is not;
 *   3. the BATCH SELECTOR and CLIP FRESHNESS — both must read that same
 *      answer, so a changed scene is redrawn and a clip made from a stale
 *      picture is stale too.
 *
 * This test drives all of them through the REAL generator path against the
 * in-process mock Gateway: a genuine Scene Plan run, a genuine image batch,
 * a genuine forced re-plan that changes the narration and grows the scene
 * count, and then a NON-FORCED image batch — the exact sequence that lost the
 * pictures. A unit test cannot catch a rule that one caller reads and another
 * does not, which is the whole shape of this bug.
 *
 * ZERO paid calls. Nothing here touches the real GenStudio.
 *
 * WHAT IT CANNOT CATCH: the visual quality of a picture, the page's own
 * re-plan button, and anything about a real Gateway's queueing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { after } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
const service = await startMockGenStudioService()
const pm = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const settings = await import('../services/app-settings.js')
const secrets = await import('../services/app-secrets-store.js')
const genstudio = await import('../lib/genstudio-client.js')
await import('../providers/text/genstudio.js')
await import('../providers/image/genstudio.js')
const { runScenePlanJob } = await import('../generators/scene-plan.js')
const { runContinuityRenderJob, resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
const { sceneClipStaleReason } = await import('../services/scene-media-checkpoint.js')
const jq = await import('../services/job-queue.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')
const { parseSrt } = await import('../lib/subtitle-builder.js')
const { stampFromCues } = await import('../lib/scene-plan-timeline.js')

// ── Fixture ──────────────────────────────────────────────────────────────

/**
 * One SRT row per narration line. The timings are what the deterministic
 * timeline splits, so the number of scenes in the plan is the number of
 * rows here — which is how the test makes the re-plan produce MORE scenes.
 */
function srtRows(rows: Array<[number, number, string]>): string {
  const stamp = (sec: number): string =>
    `00:00:${String(Math.floor(sec)).padStart(2, '0')},${String(Math.round((sec % 1) * 1000)).padStart(3, '0')}`
  return rows.map(([start, end, text], index) => [
    String(index + 1),
    `${stamp(start)} --> ${stamp(end)}`,
    text,
    '',
  ].join('\n')).join('\n')
}

/**
 * A verified stitched timeline, exactly as the generator's integrity check
 * demands: the sidecar carries the cue count and the timeline stamp.
 */
async function writeVerifiedTimeline(
  paths: { subtitles_dir: string },
  episodeId: string,
  rows: Array<[number, number, string]>,
): Promise<string> {
  const srt = srtRows(rows)
  const stitched = path.join(paths.subtitles_dir, `${episodeId.toUpperCase()}_stitched.srt`)
  const stamp = stampFromCues(parseSrt(srt))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.writeFile(stitched, srt)
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: true,
    missing_sections: [],
    total_cues: stamp.total_cues,
    timeline: stamp,
    sections: [{ slug: 'full-track', source_srt: `${episodeId}.srt`, cues_added: stamp.total_cues }],
  }))
  return stitched
}

async function createEpisode(name: string) {
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: name, logline: 'A deterministic mock episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'quiet',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return {
    project,
    episodeId: accepted.episode_code,
    paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code),
  }
}

/** The narration the FIRST plan is built from: two lines, two scenes. */
const FIRST_NARRATION: Array<[number, number, string]> = [
  [0, 4, 'A fox crossed the snowy wood at dusk.'],
  [4, 8, 'The lantern in the clearing stayed lit.'],
]

/**
 * The narration the FORCED RE-PLAN is built from. The first line's text
 * changed (so that scene's prompt must change and its picture must be
 * redrawn) and two lines were added (so the plan grows and the scene ids
 * restart over the old range — the EP0006 shape).
 */
const SECOND_NARRATION: Array<[number, number, string]> = [
  [0, 4, 'A wolf crossed the burning moor at dusk.'],
  [4, 8, 'The lantern in the clearing stayed lit.'],
  [8, 12, 'Rain began over the ridge.'],
  [12, 16, 'The old tower answered with a bell.'],
]

function scenePlanJob(slug: string, episodeId: string, overrides: Record<string, unknown> = {}): any {
  return {
    job_id: `replan-e2e-scene-plan-${Math.random().toString(16).slice(2)}`,
    project_slug: slug,
    episode_id: episodeId,
    type: 'scene_plan_run',
    title: 'Scene Plan',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      episode_id: episodeId,
      model: 'genstudio-chat:mock-chat-v1',
      use_research: false,
      // A rhythm that cuts one scene per narration line, so the scene count
      // follows the narration exactly.
      pacing: { min_sec: 1, max_sec: 8 },
      ...overrides,
    },
  }
}

function renderJob(slug: string, episodeId: string, overrides: Record<string, unknown> = {}): any {
  return {
    job_id: `replan-e2e-render-${Math.random().toString(16).slice(2)}`,
    project_slug: slug,
    episode_id: episodeId,
    type: 'continuity_render',
    title: 'Scene images',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      episode_id: episodeId,
      model: 'mock-image-v1',
      aspect_ratio: '16:9',
      resolution: '1K',
      // The batch that lost the pictures was NOT forced.
      force: false,
      ...overrides,
    },
  }
}

/** Every scene id the Gateway was asked to write a prompt for, in order. */
function requestedSceneIds(): string[] {
  return service.submissions.filter(entry => entry.operation === 'chat' && !entry.replay)
    .flatMap(entry => (entry.parsedBody as any)?.response_format?.json_schema?.schema?.properties?.results?.items?.properties?.scene_id?.enum ?? [])
}

/** The prompt each scene was actually rendered with, as the mock received it. */
function renderedPrompts(): Array<{ prompt: string; index: number }> {
  const prompts: Array<{ prompt: string; index: number }> = []
  let index = 0
  for (const request of service.requests) {
    if (request.method !== 'POST' || request.path !== '/v1/images/generations') continue
    const body = JSON.parse(request.bodyText)
    prompts.push({ prompt: String(body.prompt || ''), index: index++ })
  }
  return prompts
}

/** The image requests the mock received, in order, with their scene prompts. */
function generationCount(): number {
  return service.requests.filter(r => r.method === 'POST' && r.path === '/v1/images/generations').length
}

const readPlan = async (planPath: string): Promise<any> => JSON.parse(await fs.readFile(planPath, 'utf8'))

/**
 * The mock's writer answer: one distinct prompt per requested scene id, each
 * naming its own scene so a prompt can be traced back to the scene it was
 * written for.
 */
function queuePromptAnswers(sceneIds: string[], revised = false): void {
  for (const _sceneId of sceneIds) {
    service.queueScenario('chat', {
      states: ['succeeded'],
      outputText: JSON.stringify({
        results: sceneIds.map(id => ({ scene_id: id, visual_prompt: `A cinematic composition ${revised ? 'revised' : 'written'} for ${id}.` })),
      }),
    })
  }
}

// ── The test ─────────────────────────────────────────────────────────────

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await service.close()
  await temp.cleanup()
})

test('a forced re-plan redraws the changed scene, keeps the unchanged one, and leaves a legacy picture alone', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)

  const { project, episodeId, paths } = await createEpisode('Re-plan carries pictures')
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')

  // ── 1. Plan the episode ────────────────────────────────────────────────
  await writeVerifiedTimeline(paths, episodeId, FIRST_NARRATION)
  const firstIds = [
    `${episodeId.toLowerCase()}-scene-0001`,
    `${episodeId.toLowerCase()}-scene-0002`,
  ]
  queuePromptAnswers(firstIds)
  const firstPlanJob = scenePlanJob(project.slug, episodeId)
  await runScenePlanJob(firstPlanJob)

  const planned = await readPlan(planPath)
  assert.equal(planned.scenes.length, 2, 'the first plan has one scene per narration line')
  assert.deepEqual(planned.scenes.map((scene: any) => scene.id), firstIds)
  assert.ok(planned.scenes.every((scene: any) => scene.visual_prompt), 'every scene has a prompt')
  assert.deepEqual(
    requestedSceneIds().sort(),
    [...firstIds].sort(),
    'the writer was asked for exactly the two scenes',
  )

  // ── 2. Draw the images ─────────────────────────────────────────────────
  service.queueScenario('image', { states: ['accepted', 'succeeded'] })
  service.queueScenario('image', { states: ['accepted', 'succeeded'] })
  const firstRender = renderJob(project.slug, episodeId)
  await runContinuityRenderJob(firstRender)

  assert.equal(generationCount(), 2, 'both scenes were drawn')
  const afterFirstRender = await readPlan(planPath)
  assert.ok(
    afterFirstRender.scenes.every((scene: any) => scene.image_path),
    'both scenes record a picture',
  )
  assert.ok(
    afterFirstRender.scenes.every((scene: any) => scene.rendered_prompt === scene.visual_prompt),
    'each picture records the prompt it was drawn from',
  )

  // A LEGACY picture: rendered before `rendered_prompt` existed, on a scene
  // the re-plan will not touch. It must not read as stale.
  const legacyScene = afterFirstRender.scenes[1]
  delete legacyScene.rendered_prompt
  await fs.writeFile(planPath, JSON.stringify(afterFirstRender, null, 2))

  // ── 3. Force a re-plan with CHANGED narration and MORE scenes ──────────
  await writeVerifiedTimeline(paths, episodeId, SECOND_NARRATION)
  const secondIds = [
    `${episodeId.toLowerCase()}-scene-0001`,
    `${episodeId.toLowerCase()}-scene-0002`,
    `${episodeId.toLowerCase()}-scene-0003`,
    `${episodeId.toLowerCase()}-scene-0004`,
  ]
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  // The unchanged narration keeps its prompt; only the other scenes need writing.
  queuePromptAnswers([secondIds[0]!, secondIds[2]!, secondIds[3]!], true)
  const forceJob = scenePlanJob(project.slug, episodeId, { force: true })
  await runScenePlanJob(forceJob)

  const replanned = await readPlan(planPath)
  assert.equal(replanned.scenes.length, 4, 'the forced re-plan produced more scenes')
  assert.deepEqual(
    replanned.scenes.map((scene: any) => scene.id),
    secondIds,
    'the scene ids restart over the old range — the EP0006 shape',
  )

  // The carry-over: the CHANGED scene still holds its old picture, but it
  // now records the prompt that picture was drawn from, so the rule can see
  // that it no longer matches.
  const changedScene = replanned.scenes.find((scene: any) => scene.id === secondIds[0])
  const unchangedScene = replanned.scenes.find((scene: any) => scene.id === secondIds[1])
  assert.ok(changedScene.image_path, 'the changed scene carried its picture forward')
  assert.equal(
    changedScene.rendered_prompt,
    `A cinematic composition written for ${secondIds[0]}.`,
    'the carried picture keeps the record of the prompt it was drawn from',
  )
  assert.notEqual(
    changedScene.visual_prompt,
    changedScene.rendered_prompt,
    'the new plan gives that scene a different prompt',
  )

  // The UNCHANGED scene: same narration, so the re-plan carried its prompt
  // too and the picture still matches it.
  assert.equal(
    unchangedScene.visual_prompt,
    unchangedScene.rendered_prompt,
    'the unchanged scene kept its prompt, so its picture still matches',
  )
  assert.equal(unchangedScene.image_path, afterFirstRender.scenes[1].image_path, 'the unchanged scene kept its picture')
  assert.equal(unchangedScene.visual_prompt, afterFirstRender.scenes[1].visual_prompt, 'the unchanged scene kept its original prompt')
  assert.deepEqual(requestedSceneIds().sort(), [secondIds[0], secondIds[2], secondIds[3]].sort(), 'only changed and new scenes were sent to the writer')

  // ── 4. A NON-FORCED image batch through the real generator ─────────────
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  service.queueScenario('image', { states: ['accepted', 'succeeded'] })
  service.queueScenario('image', { states: ['accepted', 'succeeded'] })
  service.queueScenario('image', { states: ['accepted', 'succeeded'] })
  const secondRender = renderJob(project.slug, episodeId)
  await runContinuityRenderJob(secondRender)

  const afterSecondRender = await readPlan(planPath)
  const changedAfter = afterSecondRender.scenes.find((scene: any) => scene.id === secondIds[0])
  const unchangedAfter = afterSecondRender.scenes.find((scene: any) => scene.id === secondIds[1])
  const brandNewAfter = afterSecondRender.scenes.find((scene: any) => scene.id === secondIds[3])

  // The changed scene was REDRAWN: its record now equals its prompt again.
  assert.equal(
    changedAfter.rendered_prompt,
    changedAfter.visual_prompt,
    'the changed scene was redrawn from its new prompt',
  )
  assert.notEqual(
    changedAfter.image_version,
    undefined,
    'the redrawn scene carries a fresh image stamp',
  )

  // The unchanged scene was KEPT: it still has its picture and its prompt,
  // and the batch did not spend a request on it.
  assert.equal(
    unchangedAfter.rendered_prompt,
    unchangedAfter.visual_prompt,
    'the unchanged scene still matches its prompt',
  )
  assert.equal(unchangedAfter.image_path, unchangedScene.image_path, 'the unchanged scene still has its picture')
  assert.equal(unchangedAfter.image_version, unchangedScene.image_version, 'the unchanged picture was not replaced')

  // The two NEW scenes have no picture yet, so the batch drew them too.
  assert.ok(brandNewAfter.image_path, 'the new scene was drawn')

  // Exactly THREE requests: the changed scene plus the two new ones. The
  // unchanged scene was skipped — that is the whole point of the rule.
  assert.equal(
    generationCount(),
    3,
    'the batch drew the changed scene and the two new ones, and skipped the unchanged one',
  )
  const drawnPrompts = renderedPrompts().map(entry => entry.prompt)
  assert.equal(
    drawnPrompts.filter(prompt => prompt.includes(secondIds[0])).length,
    1,
    'the changed scene was drawn once',
  )
  assert.equal(
    drawnPrompts.filter(prompt => prompt.includes(secondIds[1])).length,
    0,
    'the unchanged scene was not drawn again',
  )

  // ── 5. The LEGACY picture is not read as stale ─────────────────────────
  // The legacy scene is the one whose `rendered_prompt` was removed before
  // the re-plan. The re-plan carried a truthful record forward for it, so it
  // is judged on the record — and it is kept.
  const legacyAfter = afterSecondRender.scenes.find((scene: any) => scene.id === secondIds[1])
  assert.equal(
    legacyAfter.rendered_prompt,
    legacyAfter.visual_prompt,
    'a picture rendered before rendered_prompt existed is not read as stale',
  )

  // ── 6. Clip freshness follows the same answer ──────────────────────────
  // A clip animated from a stale picture is stale too; one animated from a
  // picture that still matches is not.
  const staleClipScene = {
    ...changedAfter,
    motion_choice: 'i2v',
    clip_path: '/clips/stale.mp4',
    clip_renderer: 'image_to_video',
    clip_source_image_version: changedAfter.image_version,
  }
  // Before the redraw the picture was stale, so its clip was too.
  const staleAtReplan = {
    ...staleClipScene,
    rendered_prompt: changedScene.rendered_prompt,
    visual_prompt: changedScene.visual_prompt,
  }
  assert.equal(
    await sceneClipStaleReason(staleAtReplan as any),
    'stale source image',
    'a clip made from a stale picture is stale',
  )

  const freshClipScene = {
    ...unchangedAfter,
    motion_choice: 'i2v',
    clip_path: '/clips/fresh.mp4',
    clip_renderer: 'image_to_video',
    clip_source_image_version: unchangedAfter.image_version,
  }
  assert.equal(
    await sceneClipStaleReason(freshClipScene as any),
    null,
    'a clip made from a picture that still matches is not stale',
  )

  // ── 7. A legacy picture that no re-plan touched is accepted ───────────
  // The same rule, read directly on a scene that never went through a
  // re-plan: no `rendered_prompt` at all means "drawn before the field
  // existed", and that stays accepted.
  const neverReplanned = {
    id: `${episodeId.toLowerCase()}-scene-0009`,
    scene_index: 9,
    start_sec: 0,
    end_sec: 5,
    visual_prompt: 'A picture of a fox in a snowy wood.',
    image_path: '/images/legacy.png',
    image_version: 'v1',
  }
  const { sceneImageStaleReason } = await import('../services/scene-plan-staleness.js')
  assert.equal(
    sceneImageStaleReason(neverReplanned as any),
    null,
    'a legacy picture that was never re-planned is not read as stale',
  )
  assert.equal(await sceneClipStaleReason({
    ...neverReplanned, motion_choice: 'i2v', clip_path: '/clips/legacy.mp4',
    clip_renderer: 'image_to_video', clip_source_image_version: neverReplanned.image_version,
  } as any), null, 'a clip from a never-replanned legacy picture is not stale')
})
