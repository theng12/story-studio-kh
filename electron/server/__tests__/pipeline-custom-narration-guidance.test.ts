/**
 * A channel's custom narration guidance reaches the writer the same way from
 * Pipeline as from the Scripts page.
 *
 * THE BUG THIS GUARDS (1.4.305)
 * -----------------------------
 * A typed script preset stores the guidance at its root as `customStyleText`.
 * The Scripts page sends it as `custom_style_text`; the chunked executor reads
 * only `custom_style_text`. Pipeline's preset mapper forwarded the camelCase
 * key unchanged, so a Pipeline outline was written in the format's default
 * voice, the sidecar recorded no guidance, and expansion inherited the loss.
 *
 * Route → paused queue → real executor → loopback mock Gateway. The queue is
 * paused so nothing runs on its own; each queued job is handed to its executor
 * directly. No paid or external call is possible.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { _setAutomaticRetryForTesting } from '../services/job-retry-policy.js'
_setAutomaticRetryForTesting(false)

const GUIDANCE = 'Night Atlas voice: hushed, second person, one sensory detail per paragraph.'
const CHAPTERS = 2
const FORM = { model: 'mock-chat-v1', chapters: CHAPTERS, words_per_chapter: 5, creative_mode: 'guided', creative_direction: '' }

let app: any
let slug: string
let mock: MockGenStudioService
let jq: typeof import('../services/job-queue.js')
let episode: typeof import('../generators/episode.js')
let isolated: { cleanup: () => Promise<void> }
const episodes: Record<'manual' | 'pipeline', string> = { manual: '', pipeline: '' }

before(async () => {
  isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  mock = await startMockGenStudioService()
  app = (await import('../app.js')).app
  jq = await import('../services/job-queue.js')
  episode = await import('../generators/episode.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  await (await import('../services/app-settings.js')).setGenStudioUrl(mock.baseUrl)
  await (await import('../services/app-secrets-store.js')).setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  ;(await import('../lib/genstudio-client.js')).clearGenStudioCatalogCache()

  const project = await pm.createProject({ name: 'Custom guidance parity', episode_prefix: 'EP', episode_digits: 4 })
  slug = project.slug
  // Exactly the shape scripts.vue's usePresets snapshot saves.
  await pm.updateConfig(slug, {
    script_presets: [{ id: 'sp1', name: 'Night Atlas', type: 'script', data: { form: FORM, customStyleText: GUIDANCE } }],
    script_last_preset_script: 'sp1',
  } as any)
  for (const which of ['manual', 'pipeline'] as const) {
    const [idea] = await ideas.addIdeas(slug, [{
      title: `Guidance ${which}`, logline: '', themes: [], suggested_chapters: CHAPTERS, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    episodes[which] = (await ideas.acceptIdea(slug, idea!.id, false)).episode_code!
  }
  await jq.initializeQueuePauseState()
  await jq.setQueuePaused(true)
})

/** The jobs were run by hand, never by the paused queue; retire them so it never does. */
async function cancelQueued(): Promise<void> {
  for (const job of await jq.getJobs(slug)) {
    if (job.status === 'queued') await jq.requestJobCancellation(slug, job.job_id)
  }
  await jq._waitForJobPersistenceForTesting()
}

after(async () => {
  await cancelQueued()
  await mock.close()
  await isolated.cleanup()
})

/** The binding narrator block of the one fresh chat request a call made. */
async function narratorBlockOf(run: () => Promise<void>, outputText: string): Promise<string> {
  const before = mock.submissions.length
  mock.queueScenario('chat', { outputText })
  await run()
  await cancelQueued()
  const fresh = mock.submissions.slice(before).filter(s => s.operation === 'chat' && !s.replay)
  assert.equal(fresh.length, 1, 'exactly one writer request')
  const body = fresh[0]!.parsedBody as any
  const text = ((body?.input || body?.messages || []) as Array<{ content: string }>).map(m => m.content).join('\n\n')
  const block = text.match(/NARRATOR STYLE — binding for both outline and chapter prose:\n([\s\S]*?)(?:\n\n|$)/)?.[1]
  assert.ok(block, 'the request carries a narrator style block')
  return block
}

const outlineJson = JSON.stringify({ chapters: Array.from({ length: CHAPTERS }, (_, i) => ({
  n: i + 1, title: `Chapter ${i + 1}`, synopsis: `Synopsis ${i + 1}`, key_beats: ['a', 'b'], hook_line: `Hook ${i + 1}`,
})) })
const chaptersText = Array.from({ length: CHAPTERS }, (_, i) =>
  `## Chapter ${String(i + 1).padStart(2, '0')}: Chapter ${i + 1}\n\nQuiet lamps glow over the sleeping harbour tonight.\n`).join('\n')

async function sidecarGuidance(code: string, title: string): Promise<unknown> {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { sidecarPath } = await import('../lib/chunked-narration.js')
  const paths = await resolveEpisodePaths(slug, code, title)
  return JSON.parse(await fs.readFile(sidecarPath(paths.script_dir, code), 'utf-8')).generation_params?.custom_style_text
}

test('Pipeline and the Scripts page send the same custom guidance to outline and expansion', async () => {
  // ── Scripts page: the body submitOutline() sends, then the approve + expand.
  const manualCode = episodes.manual
  const manualTitle = 'Guidance manual'
  const outlineRes = await request(app).post(`/api/projects/${slug}/generate/outline-only`)
    .send({ ...FORM, episode_id: manualCode, title: manualTitle, custom_style_text: GUIDANCE })
  assert.equal(outlineRes.status, 201, JSON.stringify(outlineRes.body))
  const manualOutline = await narratorBlockOf(() => episode.generateOutlineOnly(jq.getJob(outlineRes.body.job_id)!), outlineJson)
  const sidecar = await request(app).get(`/api/projects/${slug}/episodes/${manualCode}/outline`).query({ title: manualTitle })
  assert.equal((await request(app).put(`/api/projects/${slug}/episodes/${manualCode}/outline`).query({ title: manualTitle })
    .send({ outline: sidecar.body.outline, approved: true })).status, 200)
  const expandRes = await request(app).post(`/api/projects/${slug}/generate/expand-chapters`)
    .send({ ...FORM, episode_id: manualCode, title: manualTitle, custom_style_text: GUIDANCE })
  assert.equal(expandRes.status, 201, JSON.stringify(expandRes.body))
  const manualExpand = await narratorBlockOf(() => episode.generateExpandChapters(jq.getJob(expandRes.body.job_id)!), chaptersText)

  // ── Pipeline: the same saved preset, through run-batch and its chain.
  const batch = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`)
    .send({ episode_ids: [episodes.pipeline], steps: ['script-only'] })
  assert.equal(batch.status, 201, JSON.stringify(batch.body))
  const head = jq.getJob(batch.body.jobs[0].job_id)!
  assert.equal(head.type, 'outline_only')
  assert.equal(head.status, 'queued', 'the paused queue must not have started the job')
  const pipelineOutline = await narratorBlockOf(() => episode.generateOutlineOnly(head), outlineJson)
  const next = (head.params.pipeline_chain as any[])[0]
  assert.equal(next.type, 'expand_chapters')
  const expandJob = { ...head, job_id: `${head.job_id}-expand`, type: next.type, params: next.params, output_lines: [] }
  const pipelineExpand = await narratorBlockOf(() => episode.generateExpandChapters(expandJob as any), chaptersText)

  assert.equal(manualOutline, GUIDANCE, 'manual outline carries the guidance')
  assert.equal(manualExpand, GUIDANCE, 'manual expansion carries the guidance')
  assert.equal(pipelineOutline, manualOutline, 'Pipeline outline must use the same guidance as a manual run')
  assert.equal(pipelineExpand, manualExpand, 'Pipeline expansion must use the same guidance as a manual run')
  // The sidecar is what expansion, resumes and later readers trust.
  assert.equal(await sidecarGuidance(episodes.pipeline, 'Guidance pipeline'), GUIDANCE)
  assert.equal(await sidecarGuidance(manualCode, manualTitle), GUIDANCE)
})

test('the script-only mapper hands the generator the key it reads', async () => {
  // Fixed in the mapper, not the executor, so jobs already queued or finished
  // keep exactly the payload they were recorded with — nothing is migrated.
  const { resolveStepParams } = await import('../routes/pipeline.js')
  const params = resolveStepParams('script-only', 'EP9999', 'T', { id: 'p', name: 'p', data: { form: FORM, customStyleText: GUIDANCE } } as any)
  assert.equal(params.custom_style_text, GUIDANCE)
  assert.equal('customStyleText' in params, false, 'the generator never reads the camelCase key')
  const legacy = resolveStepParams('script-only', 'EP9999', 'T', { id: 'p', name: 'p', data: { form: { ...FORM, customStyleText: GUIDANCE } } } as any)
  assert.equal(legacy.custom_style_text, GUIDANCE, 'a preset that kept the text inside form still works')
})
