import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { isNonRetryableError } from '../services/job-retry-policy.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
const service = await startMockGenStudioService()
const pm = await import('../services/project-manager.js')
const ideas = await import('../services/idea-manager.js')
const settings = await import('../services/app-settings.js')
const secrets = await import('../services/app-secrets-store.js')
const genstudio = await import('../lib/genstudio-client.js')
const { parseSrt } = await import('../lib/subtitle-builder.js')
const { stampFromCues } = await import('../lib/scene-plan-timeline.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')
const { resolveStepParams } = await import('../routes/pipeline.js')
await import('../providers/text/genstudio.js')
const { runScenePlanJob, subtitleCoverageGapError } = await import('../generators/scene-plan.js')

let fixtureNumber = 0
let jobNumber = 0

interface Fixture {
  project: Awaited<ReturnType<typeof pm.createProject>>
  episodeId: string
  title: string
  paths: Awaited<ReturnType<typeof resolveEpisodePathsByCode>>
  planPath: string
  preservedId: string
  missingId: string
  preservedPrompt: string
  paidCheckpoint: string
  imagePath: string
  imageVersion: string
}

const cueRows = (shiftSec = 0): string => [
  ['1', shiftSec, shiftSec + 1, 'The first archived room.'],
  ['2', shiftSec + 1, shiftSec + 2, 'Its lantern remains lit.'],
  ['3', shiftSec + 2, shiftSec + 3, 'A second room opens.'],
  ['4', shiftSec + 3, shiftSec + 4, 'Dust turns in the light.'],
].flatMap(([number, start, end, text]) => [
  number,
  `00:00:${String(Math.floor(Number(start))).padStart(2, '0')},${Number(start) % 1 ? '500' : '000'} --> 00:00:${String(Math.floor(Number(end))).padStart(2, '0')},${Number(end) % 1 ? '500' : '000'}`,
  text,
  '',
]).join('\n')

async function writeVerifiedTimeline(fixture: Pick<Fixture, 'paths' | 'episodeId'>, shiftSec = 0) {
  const srt = cueRows(shiftSec)
  const stitched = path.join(fixture.paths.subtitles_dir, `${fixture.episodeId}_stitched.srt`)
  const stamp = stampFromCues(parseSrt(srt))
  await fs.mkdir(fixture.paths.subtitles_dir, { recursive: true })
  await fs.writeFile(stitched, srt)
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: true,
    missing_sections: [],
    total_cues: stamp.total_cues,
    timeline: stamp,
    sections: [{ slug: 'full-track', source_srt: `${fixture.episodeId}.srt`, cues_added: stamp.total_cues }],
  }))
  return { stitched, stamp }
}

async function seedFixture(planOverrides: Record<string, unknown> = {}): Promise<Fixture> {
  fixtureNumber++
  const title = `Continuation ${fixtureNumber}`
  const project = await pm.createProject({
    name: `Task 11 Scene Plan ${fixtureNumber}`,
    episode_prefix: 'EP',
    episode_digits: 4,
  })
  const [idea] = await ideas.addIdeas(project.slug, [{ title, logline: 'A continuation fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'quiet' }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  const timeline = await writeVerifiedTimeline({ paths, episodeId })
  const preservedId = `${episodeId.toLowerCase()}-scene-0001`
  const missingId = `${episodeId.toLowerCase()}-scene-0002`
  const preservedPrompt = 'An approved paid prompt that ordinary continuation must not replace.'
  const imagePath = path.join(paths.episode_dir, 'scene_images', `${preservedId}.png`)
  await fs.mkdir(path.dirname(imagePath), { recursive: true })
  await fs.writeFile(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))
  const imageVersion = '2026-09-20T04:05:06.000Z'
  const paidCheckpoint = 'chat-response-paid-checkpoint-11c'
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    generated_at: '2026-09-20T04:00:00.000Z',
    timeline_built_at: '2026-09-20T03:59:00.000Z',
    planner_model: 'deterministic-timeline',
    source_stitched_srt: path.basename(timeline.stitched),
    source_timeline: timeline.stamp,
    total_duration_sec: 4,
    research_used: false,
    planning_stage: 'visual',
    pacing: { min_sec: 1, max_sec: 3 },
    opening_mode: 'from-start',
    opening_reserved_sec: 0,
    opening_source: 'measured',
    visual_prompt_batch_id: paidCheckpoint,
    scenes: [{
      id: preservedId,
      scene_index: 1,
      start_sec: 0,
      end_sec: 2,
      transcript_segment: 'The first archived room. Its lantern remains lit.',
      visual_prompt: preservedPrompt,
      approved: true,
      image_path: imagePath,
      rendered_prompt: preservedPrompt,
      image_version: imageVersion,
    }, {
      id: missingId,
      scene_index: 2,
      start_sec: 2,
      end_sec: 4,
      transcript_segment: 'A second room opens. Dust turns in the light.',
      visual_prompt: '',
    }],
    ...planOverrides,
  }, null, 2))
  return {
    project, episodeId, title, paths, planPath,
    preservedId, missingId, preservedPrompt, paidCheckpoint, imagePath, imageVersion,
  }
}

function pipelineJob(fixture: Fixture, overrides: Record<string, unknown> = {}): any {
  const params = resolveStepParams('scene_plan', fixture.episodeId, fixture.title, {
    id: 'scene-plan',
    name: 'Scene Plan',
    type: 'scene-plan',
    data: {
      model: 'mock-chat-v1',
      use_research: false,
      prompt_pack_size: 50,
    },
  })
  assert.equal('stage' in params, false, 'ordinary Pipeline Scene Plan params intentionally omit stage')
  return {
    job_id: `task11-scene-plan-${++jobNumber}`,
    project_slug: fixture.project.slug,
    episode_id: fixture.episodeId,
    type: 'scene_plan_run',
    title: 'Pipeline Scene Plan',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      ...params,
      // runBatch adds these to every first link before enqueueing it. Keeping
      // them here makes this the ordinary Pipeline executor shape, including
      // the one Jobs uses to recognize implicit visual-prompt work.
      pipeline_chain: [],
      pipeline_batch_id: `task11-batch-${fixtureNumber}`,
      pacing: { min_sec: 1, max_sec: 3 },
      motion_scope: { mode: 'off' },
      motion_level: 2,
      ...overrides,
    },
  }
}

function queuePromptResult(sceneIds: string[]): void {
  service.queueScenario('chat', {
    states: ['succeeded'],
    outputText: JSON.stringify({
      results: sceneIds.map(sceneId => ({
        scene_id: sceneId,
        visual_prompt: `A new cinematic prompt written only for ${sceneId}.`,
      })),
    }),
  })
}

function chatSubmissions() {
  return service.submissions.filter(submission => submission.operation === 'chat' && !submission.replay)
}

before(async () => {
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  genstudio.clearGenStudioCatalogCache()
})

after(async () => {
  await service.close()
  await temp.cleanup()
})

test('ordinary Pipeline continuation preserves approved partial Scene Plan state and submits only missing IDs', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  const originalImage = await fs.readFile(fixture.imagePath)
  queuePromptResult([fixture.missingId])
  // Current broken behavior rebuilds both rows, so its automatic repair asks
  // for the formerly approved row too. Keeping this second response available
  // makes the RED fail on preservation, not on an unrelated empty mock queue.
  queuePromptResult([fixture.preservedId])

  await runScenePlanJob(pipelineJob(fixture))

  const saved = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  assert.deepEqual(saved.scenes.map((scene: any) => scene.id), [fixture.preservedId, fixture.missingId])
  const preserved = saved.scenes[0]
  assert.equal(preserved.visual_prompt, fixture.preservedPrompt)
  assert.equal(preserved.approved, true)
  assert.equal(preserved.image_path, fixture.imagePath)
  assert.equal(preserved.rendered_prompt, fixture.preservedPrompt)
  assert.equal(preserved.image_version, fixture.imageVersion)
  assert.deepEqual(await fs.readFile(fixture.imagePath), originalImage)
  assert.equal(saved.timeline_built_at, '2026-09-20T03:59:00.000Z')
  assert.equal(saved.visual_prompt_batch_id, fixture.paidCheckpoint)
  assert.equal(saved.scenes[1].visual_prompt, `A new cinematic prompt written only for ${fixture.missingId}.`)

  const submissions = chatSubmissions()
  assert.equal(submissions.length, 1)
  assert.match(submissions[0]!.bodyText, new RegExp(fixture.missingId))
  assert.doesNotMatch(submissions[0]!.bodyText, new RegExp(fixture.preservedId))
})

test('explicit timeline and force requests remain intentional whole-plan rebuilds', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const timelineFixture = await seedFixture()
  await runScenePlanJob(pipelineJob(timelineFixture, { stage: 'timeline' }))
  const timelinePlan = JSON.parse(await fs.readFile(timelineFixture.planPath, 'utf8'))
  assert.equal(timelinePlan.scenes[0].visual_prompt, '')
  assert.equal(timelinePlan.scenes[0].approved, undefined)
  assert.equal(timelinePlan.scenes[0].image_path, undefined)
  assert.equal(timelinePlan.visual_prompt_batch_id, undefined)
  assert.equal(chatSubmissions().length, 0)

  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const forceFixture = await seedFixture()
  queuePromptResult([forceFixture.preservedId, forceFixture.missingId])
  await runScenePlanJob(pipelineJob(forceFixture, { force: true }))
  const forcePlan = JSON.parse(await fs.readFile(forceFixture.planPath, 'utf8'))
  assert.equal(forcePlan.scenes[0].visual_prompt, `A new cinematic prompt written only for ${forceFixture.preservedId}.`)
  assert.equal(forcePlan.scenes[0].approved, undefined)
  assert.equal(forcePlan.scenes[0].image_path, undefined)
  assert.equal(forcePlan.visual_prompt_batch_id, undefined)
  assert.equal(chatSubmissions().length, 1)
})

test('ordinary continuation still asks for a rebuild when the timeline moved more than re-aligning can absorb', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  await writeVerifiedTimeline(fixture, 0.5) // 4.5 s of captions under a 4 s plan: 89 % < 90 %
  queuePromptResult([fixture.preservedId, fixture.missingId])
  const before = await fs.readFile(fixture.planPath, 'utf8')

  await assert.rejects(
    runScenePlanJob(pipelineJob(fixture)),
    error => error instanceof Error && /rebuild.*timeline/i.test(error.message),
  )

  assert.equal(await fs.readFile(fixture.planPath, 'utf8'), before)
  assert.equal(chatSubmissions().length, 0)
})

// 1.4.296 — mineepod EP0006 stopped on "had 264 caption(s) and now has 265"; an older plan with no
// stamp stopped the same way. Both are now re-aligned to today's captions and the run carries on.
for (const kind of ['one more caption', 'unstamped'] as const) {
  test(`ordinary continuation re-aligns a plan with ${kind} timeline and carries on, keeping reviewed work`, async () => {
    service.reset()
    genstudio.clearGenStudioCatalogCache()
    const fixture = await seedFixture(kind === 'unstamped' ? { source_timeline: undefined } : {})
    if (kind === 'one more caption') {
      const stitched = path.join(fixture.paths.subtitles_dir, `${fixture.episodeId}_stitched.srt`)
      // The last caption is split in two: one more caption, same narration length.
      const srt = cueRows().replace('00:00:03,000 --> 00:00:04,000\nDust turns in the light.',
        '00:00:03,000 --> 00:00:03,500\nDust turns\n\n5\n00:00:03,500 --> 00:00:04,000\nin the light.')
      const stamp = stampFromCues(parseSrt(srt))
      await fs.writeFile(stitched, srt)
      await fs.writeFile(`${stitched}.json`, JSON.stringify({
        complete: true, missing_sections: [], total_cues: stamp.total_cues, timeline: stamp,
        sections: [{ slug: 'full-track', source_srt: `${fixture.episodeId}.srt`, cues_added: stamp.total_cues }],
      }))
    }
    queuePromptResult([fixture.missingId])
    const job = pipelineJob(fixture)

    await runScenePlanJob(job)

    assert.ok(job.output_lines.some((line: string) => /Re-aligned 2\/2 scene\(s\) to the current captions and carried on/.test(line)), job.output_lines.join('\n'))
    const saved = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
    assert.equal(saved.scenes[0].visual_prompt, fixture.preservedPrompt)
    assert.equal(saved.scenes[0].approved, true)
    assert.equal(saved.scenes[1].visual_prompt, `A new cinematic prompt written only for ${fixture.missingId}.`)
    assert.ok(saved.source_timeline?.sha256)
    assert.equal(chatSubmissions().length, 1)
  })
}

for (const entry of [{
    label: 'pacing',
    overrides: { pacing: { min_sec: 8, max_sec: 12 } },
  }, {
    label: 'opening',
    overrides: { opening_mode: 'branded-opening', opening_reserved_sec: 5, opening_source: 'measured' },
  }, {
    label: 'missing pacing snapshot',
    overrides: { pacing: undefined },
  }, {
    label: 'unmeasured legacy opening',
    overrides: { opening_source: undefined },
  }, {
    label: 'empty plan',
    overrides: { scenes: [] },
  }]) {
  test(`ordinary continuation refuses ${entry.label} incompatibility without touching the plan`, async () => {
    service.reset()
    genstudio.clearGenStudioCatalogCache()
    const fixture = await seedFixture(entry.overrides)
    queuePromptResult([fixture.preservedId, fixture.missingId])
    const before = await fs.readFile(fixture.planPath, 'utf8')

    const job = pipelineJob(fixture)
    await assert.rejects(
      runScenePlanJob(job),
      error => error instanceof Error && /rebuild.*timeline/i.test(error.message)
        // Running again reads the same plan and stops here again: no retry waits.
        && isNonRetryableError(error),
      `${entry.label} incompatibility must require an intentional timeline rebuild`,
    )
    assert.deepEqual((job.result as any)?.attention, { kind: 'scene_plan_rebuild', workspace: 'scene-plan', episode_id: job.episode_id },
      'Jobs offers the one-click Rebuild Timeline')

    assert.equal(await fs.readFile(fixture.planPath, 'utf8'), before)
    assert.equal(chatSubmissions().length, 0)
  })
}

test('ordinary continuation of a complete compatible plan makes no provider submission', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  const plan = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  plan.scenes[1].visual_prompt = 'A fully completed view of the second room.'
  // Edited scene IDs must survive; they need not equal deterministic split IDs.
  plan.scenes[0].id = 'reviewed-custom-scene-id'
  await fs.writeFile(fixture.planPath, JSON.stringify(plan))

  await runScenePlanJob(pipelineJob(fixture))

  const saved = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  assert.equal(saved.scenes[0].id, 'reviewed-custom-scene-id')
  assert.equal(saved.scenes[0].visual_prompt, fixture.preservedPrompt)
  assert.equal(saved.scenes[0].approved, true)
  assert.equal(saved.scenes[1].visual_prompt, 'A fully completed view of the second room.')
  assert.equal(saved.visual_prompt_batch_id, fixture.paidCheckpoint)
  assert.equal(chatSubmissions().length, 0)
})

test('ordinary Pipeline builds a missing plan and completes its visual prompts', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  await fs.unlink(fixture.planPath)
  queuePromptResult([fixture.preservedId, fixture.missingId])

  await runScenePlanJob(pipelineJob(fixture))

  const saved = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  assert.deepEqual(saved.scenes.map((scene: any) => scene.id), [fixture.preservedId, fixture.missingId])
  assert.equal(saved.scenes[0].visual_prompt, `A new cinematic prompt written only for ${fixture.preservedId}.`)
  assert.equal(saved.scenes[1].visual_prompt, `A new cinematic prompt written only for ${fixture.missingId}.`)
  assert.equal(chatSubmissions().length, 1)
})

test('ordinary continuation refuses a malformed saved plan and leaves its bytes untouched', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  const broken = '{"scenes":['
  await fs.writeFile(fixture.planPath, broken)

  await assert.rejects(runScenePlanJob(pipelineJob(fixture)), /rebuild.*timeline/i)

  assert.equal(await fs.readFile(fixture.planPath, 'utf8'), broken)
  assert.equal(chatSubmissions().length, 0)
})

test('a provider refusal keeps approved work and ordinary Retry submits only the missing scene', async () => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  service.setAccountOverviewForKey(MOCK_GENSTUDIO_FULL_KEY, { credit_balance: 1_000 })
  await genstudio.refreshGenStudioAdmission(MOCK_GENSTUDIO_FULL_KEY)
  const fixture = await seedFixture()
  const originalFetch = globalThis.fetch
  let refusedPosts = 0
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url === `${service.baseUrl}/v1/chat/responses` && method === 'POST') {
      refusedPosts++
      return Response.json({ detail: 'Insufficient credits' }, { status: 402 })
    }
    return originalFetch(input, init)
  }
  try {
    await assert.rejects(runScenePlanJob(pipelineJob(fixture)), genstudio.isGenStudioInsufficientCredits)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(refusedPosts, 1)
  const partial = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  assert.equal(partial.scenes[0].visual_prompt, fixture.preservedPrompt)
  assert.equal(partial.scenes[0].approved, true)
  assert.equal(partial.visual_prompt_batch_id, fixture.paidCheckpoint)
  assert.equal(partial.scenes[1].visual_prompt, '')

  // Restoring fetch is not a top-up: admission correctly retains the 402
  // until the account reports more credits. Prove that gate, then replenish
  // the fake account through its existing public overview fixture.
  await assert.rejects(runScenePlanJob(pipelineJob(fixture)), genstudio.isGenStudioInsufficientCredits)
  assert.equal(chatSubmissions().length, 0)
  service.setAccountOverviewForKey(MOCK_GENSTUDIO_FULL_KEY, { credit_balance: 2_000 })
  queuePromptResult([fixture.missingId])
  await runScenePlanJob(pipelineJob(fixture))

  const saved = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
  assert.equal(saved.scenes[0].visual_prompt, fixture.preservedPrompt)
  assert.equal(saved.scenes[0].approved, true)
  assert.equal(saved.scenes[1].visual_prompt, `A new cinematic prompt written only for ${fixture.missingId}.`)
  assert.equal(chatSubmissions().length, 1)
  assert.doesNotMatch(chatSubmissions()[0]!.bodyText, new RegExp(fixture.preservedId))
})

for (const location of ['current', 'legacy'] as const) {
  test(`ordinary continuation refuses a ${location} plan stat error instead of rebuilding`, async t => {
    service.reset()
    genstudio.clearGenStudioCatalogCache()
    const fixture = await seedFixture()
    const legacyPath = path.join(fixture.paths.episode_dir, 'scene_plan.json')
    const before = await fs.readFile(fixture.planPath, 'utf8')
    // A current-path error must not select and overwrite the legacy fallback.
    await fs.writeFile(legacyPath, before)
    if (location === 'legacy') await fs.unlink(fixture.planPath)
    const blocked = location === 'current' ? fixture.planPath : legacyPath
    const stat = fs.stat.bind(fs)
    t.mock.method(fs, 'stat', async (file: any, ...args: any[]) => {
      if (String(file) === blocked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return stat(file, ...args)
    })
    queuePromptResult([fixture.missingId])

    await assert.rejects(runScenePlanJob(pipelineJob(fixture)), /cannot safely continue.*permission denied/i)

    assert.equal(await fs.readFile(blocked, 'utf8'), before)
    assert.equal(await fs.readFile(legacyPath, 'utf8'), before)
    if (location === 'legacy') await assert.rejects(fs.readFile(fixture.planPath), { code: 'ENOENT' })
    assert.equal(chatSubmissions().length, 0)
  })
}

test('ordinary continuation refuses an unreadable saved plan without overwriting it', async t => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  const before = await fs.readFile(fixture.planPath, 'utf8')
  const readFile = fs.readFile.bind(fs)
  const readMock = t.mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
    if (String(file) === fixture.planPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return readFile(file, ...args)
  })

  await assert.rejects(runScenePlanJob(pipelineJob(fixture)), /cannot safely continue.*permission denied/i)

  readMock.mock.restore()
  assert.equal(await fs.readFile(fixture.planPath, 'utf8'), before)
  assert.equal(chatSubmissions().length, 0)
})

test('ordinary first-run planning refuses to overwrite a plan that appears before the locked write', async t => {
  service.reset()
  genstudio.clearGenStudioCatalogCache()
  const fixture = await seedFixture()
  const before = await fs.readFile(fixture.planPath, 'utf8')
  const stat = fs.stat.bind(fs)
  let firstLookup = true
  t.mock.method(fs, 'stat', async (file: any, ...args: any[]) => {
    if (String(file) === fixture.planPath && firstLookup) {
      firstLookup = false
      throw Object.assign(new Error('not present yet'), { code: 'ENOENT' })
    }
    return stat(file, ...args)
  })
  queuePromptResult([fixture.missingId])

  await assert.rejects(runScenePlanJob(pipelineJob(fixture)), error => error instanceof Error
    && /plan appeared.*retry/i.test(error.message) && !isNonRetryableError(error))

  assert.equal(await fs.readFile(fixture.planPath, 'utf8'), before)
  assert.equal(chatSubmissions().length, 0)
})

test('a subtitle coverage gap says which button to press and skips the retry waits', () => {
  const error = subtitleCoverageGapError({ gap_sec: 37.6, previous_end_sec: 17.9, next_start_sec: 55.5, section_slugs: ['Chapter_03'] })
  assert.ok(isNonRetryableError(error), 'retrying cannot add cues')
  assert.match(error.message, /press “Re-transcribe Chapter 03” \(or “Re-narrate Chapter 3” if the narration is silent there\), then press Retry/)
  assert.match(subtitleCoverageGapError({ gap_sec: 40, previous_end_sec: 0, next_start_sec: 40, section_slugs: [] }).message,
    /press “Re-transcribe” on the chapter it lists/)
})
