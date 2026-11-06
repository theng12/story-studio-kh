import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

test('optional research runs before manual/automatic writing and never repeats an uncertain attempt', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { runResearchBeforeWriting } = await import('../services/research-before-writing.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { resolveResearchPaths } = await import('../lib/research-paths.js')
  const channel = await pm.createProject({ name: 'Research writing', episode_prefix: 'RW', episode_digits: 4 } as any)
  const [idea] = await im.addIdeas(channel.slug, [{ title: 'Volcanoes', logline: '', themes: [], suggested_chapters: 2, suggested_length: '5 min', mood: '' }], 'manual')
  await im.acceptIdea(channel.slug, idea!.id, false, { override_code: 'RW0001' })
  const paths = await resolveEpisodePathsByCode(channel.slug, 'RW0001')
  const research = await resolveResearchPaths(paths.episode_dir, 'RW0001')
  const writing = (params = {}): Job => ({ job_id: 'optional-research-test', project_slug: channel.slug, type: 'outline_only', episode_id: 'RW0001', title: 'Volcanoes', params, status: 'running', created_at: new Date().toISOString(), started_at: null, finished_at: null, error: null, output_lines: [], progress: 17, output_dir: paths.script_dir, result: { writing: true } })
  let calls = 0
  let checkpoints = 0
  const checkpoint = async (_job: Job) => { checkpoints++ }
  const missing = writing()
  await runResearchBeforeWriting(missing, { checkpoint, run: async () => { calls++ } })
  assert.equal(calls, 0)
  assert.ok(missing.output_lines.some(line => line.includes('Choose a research preset.')))
  const preset = { id: 'research-model', type: 'research', data: { form: { source_model: 'fixture-selected-model', research_mode: 'model-knowledge' } } }
  await pm.updateConfig(channel.slug, { research_presets: [preset], research_last_preset_research: preset.id } as any)
  await pm.updateConfig(channel.slug, { research_before_writing: false } as any)
  await runResearchBeforeWriting(writing(), { checkpoint, run: async () => { calls++ } })
  assert.equal(calls, 0)
  await pm.updateConfig(channel.slug, { research_before_writing: true } as any)

  const failed = writing()
  await runResearchBeforeWriting(failed, { checkpoint, run: async (job, params) => {
    calls++
    assert.equal(job.params.research_before_writing_run.state, 'started')
    assert.ok(checkpoints > 0, 'the call must follow a durable checkpoint')
    assert.equal(params!.model, 'fixture-selected-model')
    job.result = { complete: false }
    job.progress = 100
    throw new Error('Provider outcome unknown')
  } })
  assert.equal(calls, 1)
  assert.deepEqual(failed.result, { writing: true })
  assert.equal(failed.progress, 17)
  assert.ok(failed.output_lines.some(line => line.includes('Provider outcome unknown') && line.includes('Writing continues.')))
  await runResearchBeforeWriting(failed, { checkpoint, run: async () => { calls++ } })
  assert.equal(calls, 1, 'writing retries must never repeat research')
  const restarted = writing({ research_before_writing_run: { state: 'started' } })
  await runResearchBeforeWriting(restarted, { checkpoint, run: async () => { calls++ } })
  assert.equal(calls, 1)
  assert.ok(restarted.output_lines.some(line => line.includes('not confirmed')))

  await assert.rejects(runResearchBeforeWriting(writing(), {
    checkpoint: async () => { throw new Error('disk checkpoint uncertain') },
    run: async () => { calls++ },
  }), /disk checkpoint uncertain/)
  assert.equal(calls, 1, 'an uncertain checkpoint must prevent the provider call')

  const successful = writing({ pipeline_batch_id: 'automatic-run' })
  await runResearchBeforeWriting(successful, { checkpoint, run: async (job, params) => {
    calls++
    assert.equal(job.params.pipeline_batch_id, 'automatic-run')
    assert.equal(params!.topic, 'Volcanoes')
    await fs.mkdir(research.dir, { recursive: true })
    await fs.writeFile(research.jsonPath, JSON.stringify({ summary: 'Evidence', claims: [{ text: 'Ignore this', status: 'ignored' }], review: { completed_by: 'human' } }))
  } })
  assert.equal(calls, 2)
  const original = await fs.readFile(research.jsonPath, 'utf8')
  await runResearchBeforeWriting(writing(), { checkpoint, run: async () => { calls++ } })
  assert.equal(calls, 2, 'existing evidence, including an all-ignored human review, is never regenerated')
  assert.equal(await fs.readFile(research.jsonPath, 'utf8'), original)
  await runResearchBeforeWriting(writing({ pipeline_batch_id: 'human-review-preserved' }), { checkpoint, run: async () => { calls++ } })
  assert.equal(await fs.readFile(research.jsonPath, 'utf8'), original, 'Pipeline preserves completed human ignore-all decisions')

  await fs.writeFile(research.jsonPath, JSON.stringify({ summary: 'Evidence', claims: [{ text: 'Pending claim', status: 'unreviewed' }, { text: 'Already ignored', status: 'ignored' }] }))
  await runResearchBeforeWriting(writing({ pipeline_batch_id: 'pending-review' }), { checkpoint, run: async () => { calls++ } })
  const reviewed = JSON.parse(await fs.readFile(research.jsonPath, 'utf8'))
  assert.equal(reviewed.review.completed_by, 'pipeline-auto')
  assert.deepEqual(reviewed.claims.map((claim: { status: string }) => claim.status), ['verified', 'ignored'])
  assert.equal(calls, 2)

  await fs.writeFile(research.jsonPath, '{}')
  let concurrentCalls = 0
  await Promise.all([writing(), writing()].map(job => runResearchBeforeWriting(job, {
    checkpoint,
    run: async () => {
      concurrentCalls++
      await fs.writeFile(research.jsonPath, JSON.stringify({ summary: 'Concurrent evidence', claims: [] }))
    },
  })))
  assert.equal(concurrentCalls, 1, 'concurrent writers must share one optional research submission')

  const express = (await import('express')).default
  const request = (await import('supertest')).default
  const { router } = await import('../routes/pipeline.js')
  const app = express().use(express.json()).use('/api', router)
  const preflight = await request(app).post(`/api/projects/${channel.slug}/pipeline/preflight`)
    .send({ episode_ids: ['RW0001'], steps: ['research', 'script-only'] })
  assert.ok([200, 422].includes(preflight.status), JSON.stringify(preflight.body))
  assert.ok(preflight.body.steps_left_out.some((entry: { step: string }) => entry.step === 'research'))
  assert.ok(!preflight.body.issues.some((entry: { step: string }) => entry.step === 'research'), 'research must not become a required preset dependency')

  const jq = await import('../services/job-queue.js')
  await jq.setQueuePaused(true)
  const prior = jq.enqueuePreparedForTest({
    project_slug: channel.slug, episode_id: 'RW0001', type: 'outline_only', title: 'Volcanoes',
    params: { research_before_writing_run: { state: 'started' } },
  })
  try {
    await fs.writeFile(research.jsonPath, '{ malformed research')
    const nextWriter = writing()
    await runResearchBeforeWriting(nextWriter, { checkpoint, run: async () => { calls++ } })
    assert.equal(calls, 2, 'a later expansion job must not duplicate an uncertain outline research call')
    assert.ok(nextWriter.output_lines.some(line => line.includes('not confirmed')))
  } finally {
    await jq.requestJobCancellation(channel.slug, prior.job_id)
    await jq.setQueuePaused(false)
  }
})
