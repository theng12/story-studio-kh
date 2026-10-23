/**
 * The Scene Plan visual-prompt BODY budget.
 *
 * A stored visual_prompt is not what the image model receives: the scene
 * renderer appends the anchor character descriptors and the Style Bible to
 * every prompt (generators/continuity-render.ts), and the planner/rewrite
 * writers prepend the style clause as a lead. Before this, Scene Plan told the
 * writer the model's FULL character limit, so a compliant prompt could still
 * be refused at submit time by the 1.4.348 guard.
 *
 * These tests exercise the REAL route and generator code paths, not helpers:
 *   - the run route still enqueues creative_direction and avoid_legible_text;
 *   - the live catalogue selection is stored with the job;
 *   - a lost-response retry with the same operation_id is REUSED, including the
 *     selection-only body shape;
 *   - a 1.4.348 job's numeric allowance is kept and never called published;
 *   - the render overhead is reserved regardless of the project's format;
 *   - a ceiling the assembly alone exceeds is refused, TYPED, through the
 *     batched regenerate path before any provider request;
 *   - a hand-written body that exactly fills the budget fits when composed by
 *     the renderer's own composition, and one more character does not.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
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
const { runScenePlanJob } = await import('../generators/scene-plan.js')
const jq = await import('../services/job-queue.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')
const { createCharacter } = await import('../services/character-manager.js')
const { router } = await import('../routes/scene-plan.js')
const {
  measureAssemblyOverhead, PromptAssemblyTooLargeError, promptCharacterCount,
} = await import('../services/prompt-char-cap.js')
const { composeSceneRenderPrompt, readSceneRenderAssembly, sceneRenderAssemblyParts } = await import('../services/scene-prompt-assembly.js')
const { isNonRetryableError } = await import('../services/job-retry-policy.js')

const app = express().use(express.json()).use('/api', router)

const CHARACTER_NAME = 'Kosal'
const CHARACTER_DESCRIPTION = 'A calm monk in a saffron robe'
const STYLE_BIBLE = 'Ink wash.'
const PUBLISHED_CAP = 4_800

let sequence = 0

/** The exact text the renderer appends, written out from its composition. */
const RENDER_OVERHEAD = ('\n\nCharacter details — ' + `${CHARACTER_NAME}: ${CHARACTER_DESCRIPTION}` + '.').length
  + ('\n\nStyle: ' + STYLE_BIBLE).length
/** `leadWithStyle` prepends the style clause plus a space (the clause ends in '.'). */
const STYLE_LEAD = `${STYLE_BIBLE} `.length

async function fixture(opts: { scenePrompts?: string[]; format?: string } = {}) {
  sequence++
  const project = await pm.createProject({ name: `Prompt Budget ${sequence}`, episode_prefix: 'EP', episode_digits: 4 })
  if (opts.format) {
    // format_overrides live on the PROJECT meta, not config.json.
    await pm.updateProject(project.slug, { format_overrides: { visualSource: opts.format } } as any)
  }
  // The automatic fallback would write plain prompts and hide the failure we
  // are asserting on; these tests always provide a usable answer.
  await pm.updateConfig(project.slug, { safety_checks: { scene_prompts: 'block' } } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Prompt budget', logline: 'x', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'quiet',
  }], 'test')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${accepted.episode_code}_stitched.srt`)
  await fs.writeFile(stitched, ['1', '00:00:00,000 --> 00:00:04,000', 'Opening.', ''].join('\n'))
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: true, missing_sections: [], sections: [{ slug: 'full', source_srt: 'full.srt', cues_added: 1 }],
  }))

  await createCharacter(project.slug, {
    name: CHARACTER_NAME, description: CHARACTER_DESCRIPTION, scope: 'project',
  })
  await fs.writeFile(path.join(paths.episode_dir, 'continuity.json'), JSON.stringify({
    schema_version: 1,
    anchor_character_ids: ['kosal'],
    style_bible: STYLE_BIBLE,
    use_episode_sheet: false,
  }))

  const promptFor = (id: string) => opts.scenePrompts?.find(entry => entry.startsWith(id)) || ''
  const scenes = [1, 2].map((index) => {
    const id = `s${index}`
    return {
      id,
      scene_index: index,
      start_sec: index - 1,
      end_sec: index,
      transcript_segment: `Narration for ${id}.`,
      visual_prompt: promptFor(id),
    }
  })
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    generated_at: '2026-10-23T00:00:00.000Z',
    timeline_built_at: '2026-10-23T00:00:00.000Z',
    planner_model: 'deterministic-timeline',
    source_stitched_srt: path.basename(stitched),
    total_duration_sec: scenes.length,
    research_used: false,
    planning_stage: 'visual',
    scenes,
  }, null, 2))
  return { slug: project.slug, episodeId: accepted.episode_code, paths, planPath }
}

function job(f: Awaited<ReturnType<typeof fixture>>, params: Record<string, unknown>, id: string): any {
  return {
    job_id: id,
    project_slug: f.slug,
    episode_id: f.episodeId,
    type: 'scene_plan_run',
    title: 'Scene prompt budget',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: { episode_id: f.episodeId, model: 'genstudio-chat:mock-chat-v1', use_research: false, ...params },
  }
}

/** Every message the writer saw, joined — the provider may fold the system turn. */
function writerText(): string {
  const chat = service.submissions.find(entry => entry.operation === 'chat' && !entry.replay)
  assert.ok(chat, 'a writer request was submitted')
  return ((chat!.parsedBody?.input as Array<{ content?: unknown }> | undefined) || [])
    .map(message => String(message?.content ?? ''))
    .join('\n')
}

function chatSubmissions() {
  return service.submissions.filter(entry => entry.operation === 'chat' && !entry.replay)
}

before(async () => {
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  genstudio.clearGenStudioCatalogCache()
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await service.close()
  await temp.cleanup()
})

describe('the renderer composition is the one the budget measures', () => {
  test('a body that exactly fills the budget fits when the RENDERER composes it', () => {
    const characters = [{ name: CHARACTER_NAME, description: CHARACTER_DESCRIPTION }]
    const overhead = measureAssemblyOverhead(sceneRenderAssemblyParts(characters, STYLE_BIBLE, true))
    assert.equal(overhead.characters, RENDER_OVERHEAD, 'the measured reserve is the text the renderer appends')

    const body = 'x'.repeat(PUBLISHED_CAP - overhead.characters)
    const assembled = composeSceneRenderPrompt(body, characters, STYLE_BIBLE, true)
    assert.equal(promptCharacterCount(assembled), PUBLISHED_CAP, 'fits exactly')
    const oneMore = composeSceneRenderPrompt(`${body}x`, characters, STYLE_BIBLE, true)
    assert.equal(promptCharacterCount(oneMore), PUBLISHED_CAP + 1, 'one more character is over')
  })
})

describe('the generator hands the writer the body budget', () => {
  test('a live selection reserves the Style Bible and character text — for a non-continuity format too', async () => {
    service.reset()
    // The renderer is the only scene-image path and appends these layers for
    // EVERY project. A budget gated on `continuity-chain` would under-reserve
    // here and the writer would produce a prompt the renderer refuses.
    const f = await fixture({ scenePrompts: ['s1 existing prompt'], format: 'timestamp-driven' })
    service.queueScenario('chat', {
      states: ['succeeded'],
      outputText: JSON.stringify({ results: [{ scene_id: 's2', visual_prompt: 'A hall lit by one lamp.' }] }),
    })
    const run = job(f, {
      stage: 'visual',
      regenerate_empty_prompts: true,
      auto_repair_missing_prompts: true,
      prompt_pack_size: 50,
      prompt_char_cap_selection: 'auto',
      intended_image_model: 'mock-image-v1',
      // A per-run style the WRITER sees. The renderer ignores it and appends
      // the episode's Style Bible, so the reserve must be measured on THAT text.
      style_prompt: 'Oil paint.',
    }, `budget-live-${sequence}`)
    await runScenePlanJob(run)

    const expectedBody = PUBLISHED_CAP - RENDER_OVERHEAD
    const text = writerText()
    assert.match(text, new RegExp(`${expectedBody.toLocaleString()} is a hard ceiling`),
      'the writer is given the body budget, not the assembled ceiling')
    assert.match(text, /4,800 characters/, 'the instruction still names the model\'s published ceiling')
    assert.match(text, /character descriptions and Style Bible text the render appends/)
    assert.ok(run.output_lines.some((line: string) => line.includes(expectedBody.toLocaleString())),
      'the job log states the body budget it gave the writer')
  })

  test('a corrupt continuity file still reserves the Style Bible the renderer WILL append', async () => {
    const f = await fixture()
    await pm.updateConfig(f.slug, { default_style_bible: 'Oil paint.' } as any)
    await fs.writeFile(path.join(f.paths.episode_dir, 'continuity.json'), '{ not json')
    const assembly = await readSceneRenderAssembly(f.slug, f.paths.episode_dir)
    assert.deepEqual(assembly.characters, [], 'a corrupt continuity file means no anchors, exactly as the renderer reads it')
    assert.equal(assembly.styleBible, 'Oil paint.',
      'the project default the renderer falls back to is still counted — never a silent zero')
  })

  test('a 1.4.348 numeric allowance is kept, and never described as published', async () => {
    service.reset()
    const f = await fixture({ scenePrompts: ['s1 existing prompt'] })
    service.queueScenario('chat', {
      states: ['succeeded'],
      outputText: JSON.stringify({ results: [{ scene_id: 's2', visual_prompt: 'A hall lit by one lamp.' }] }),
    })
    // Exactly the shape a job queued by 1.4.348 has: a numeric ceiling plus the
    // intended model, and NO selection. Re-resolving it would discard it.
    const run = job(f, {
      stage: 'visual',
      regenerate_empty_prompts: true,
      auto_repair_missing_prompts: true,
      prompt_pack_size: 50,
      prompt_char_cap: 3_000,
      intended_image_model: 'mock-image-v1',
    }, `budget-legacy-${sequence}`)
    await runScenePlanJob(run)

    const expectedBody = 3_000 - RENDER_OVERHEAD
    const text = writerText()
    assert.match(text, new RegExp(`${expectedBody.toLocaleString()} is a hard ceiling`),
      'the saved numeric ceiling is still enforced')
    assert.match(text, /a limit saved with the run, not a figure read live from the image model/)
    assert.doesNotMatch(text, /4,800/, 'the live catalogue figure is not substituted for the saved allowance')
    assert.ok(run.output_lines.some((line: string) => line.includes('saved with this run, not a live published figure')),
      'the job log does not claim the saved number is published')
  })

  test('an assembly larger than the ceiling is refused TYPED through the batched path, before any request', async () => {
    service.reset()
    const f = await fixture({ scenePrompts: ['s1 existing prompt', 's2 existing prompt'] })
    const run = job(f, {
      regenerate_prompt_scene_ids: ['s1', 's2'],
      // The renderer's own text (the Style Bible plus the character layer) is
      // already longer than this ceiling, so no body can fit.
      prompt_char_cap_selection: 10,
      intended_image_model: 'mock-image-v1',
    }, `budget-too-large-${sequence}`)

    await assert.rejects(runScenePlanJob(run), (error: any) => {
      assert.ok(error instanceof PromptAssemblyTooLargeError, 'the refusal keeps its type through the batch')
      assert.equal(isNonRetryableError(error), true, 'retrying cannot change a deterministic refusal')
      assert.equal(error.cap, 10)
      // The write path reserves the style lead it prepends AND the render
      // layers, so that is the overhead the refusal names.
      assert.equal(error.overhead, RENDER_OVERHEAD + STYLE_LEAD)
      return true
    })
    assert.equal(chatSubmissions().length, 0, 'no prompt request was made')
  })
})

describe('the routes carry the selection and replay exactly', () => {
  test('the run route still enqueues creative direction, legible-text policy, and the cap selection', async () => {
    service.reset()
    const f = await fixture()
    await pm.updateConfig(f.slug, {
      scene_plan_presets: [{
        id: 'scene-budget', name: 'Budget', type: 'scene-plan',
        data: {
          model: 'mock-chat-v1',
          use_research: false,
          intended_image_model: 'mock-image-v1',
          prompt_char_cap: 'auto',
          creative_direction: { profile: 'editorial', intensity: 3, strategies: ['documentary'], recurring_motifs: 'sea glass' },
          avoid_legible_text: true,
        },
      }],
      'scene_plan_last_preset_scene-plan': 'scene-budget',
    } as any)

    await jq.setQueuePaused(true)
    let jobId = ''
    try {
      const created = await request(app)
        .post(`/api/projects/${f.slug}/scene-plan/${f.episodeId}/run`)
        .send({ stage: 'visual', title: 'Budget', operation_id: crypto.randomUUID() })
        .expect(201)
      jobId = created.body.job_id
      const params = created.body.params
      assert.equal(params.creative_direction?.profile, 'editorial', 'creative direction is not dropped')
      assert.equal(params.avoid_legible_text, true, 'the legible-text policy is not dropped')
      assert.equal(params.prompt_char_cap_selection, 'auto', 'the selection travels with the job')
      assert.equal(params.intended_image_model, 'mock-image-v1')
      assert.equal(params.prompt_char_cap, PUBLISHED_CAP, 'the admission receipt is still recorded')
    } finally {
      if (jobId) {
        await jq.requestJobCancellation(f.slug, jobId)
        jq.removeTerminalJob(f.slug, jobId)
      }
      await jq.setQueuePaused(false)
    }
  })

  test('a lost-response retry with the same operation_id is REUSED, selection-only body included', async () => {
    service.reset()
    const f = await fixture({ scenePrompts: ['s1 existing prompt', 's2 existing prompt'] })
    // A second episode for the numeric-shape case: the duplicate guard is per
    // episode and job type, so one queued job would hide the second enqueue.
    const numericFixture = await fixture({ scenePrompts: ['s1 existing prompt', 's2 existing prompt'] })
    const url = `/api/projects/${f.slug}/scene-plan/${f.episodeId}/regenerate-prompt`
    const numericUrl = `/api/projects/${numericFixture.slug}/scene-plan/${numericFixture.episodeId}/regenerate-prompt`
    await jq.setQueuePaused(true)
    const jobIds: Array<{ slug: string; id: string }> = []
    try {
      // The selection-only shape is the one two separate parsers used to
      // fingerprint differently (stored job: numeric cap absent, retry: a
      // different key set), turning a lost response into a 409.
      const body = {
        scene_ids: ['s1'],
        model: 'genstudio-chat:mock-chat-v1',
        prompt_char_cap_selection: 'auto',
        intended_image_model: 'mock-image-v1',
        operation_id: crypto.randomUUID(),
      }
      const first = await request(app).post(url).send(body).expect(201)
      jobIds.push({ slug: f.slug, id: first.body.job_id })
      assert.equal(first.body.params.prompt_char_cap_selection, 'auto')
      assert.equal(first.body.params.intended_image_model, 'mock-image-v1')

      const retry = await request(app).post(url).send(body).expect(200)
      assert.equal(retry.body.reused, true, 'the same request is reused, not refused')
      assert.equal(retry.body.job_id, first.body.job_id)

      // A genuinely different selection on the same operation_id is still a 409.
      await request(app).post(url).send({ ...body, prompt_char_cap_selection: 'none' }).expect(409)

      // The numeric shape (an older client) also round-trips.
      const numericBody = {
        scene_ids: ['s2'],
        model: 'genstudio-chat:mock-chat-v1',
        prompt_char_cap: 4_200,
        operation_id: crypto.randomUUID(),
      }
      const numericFirst = await request(app).post(numericUrl).send(numericBody).expect(201)
      jobIds.push({ slug: numericFixture.slug, id: numericFirst.body.job_id })
      assert.equal(numericFirst.body.params.prompt_char_cap, 4_200)
      const numericRetry = await request(app).post(numericUrl).send(numericBody).expect(200)
      assert.equal(numericRetry.body.reused, true)
    } finally {
      for (const { slug, id } of jobIds) {
        await jq.requestJobCancellation(slug, id)
        jq.removeTerminalJob(slug, id)
      }
      await jq.setQueuePaused(false)
    }
  })
})
