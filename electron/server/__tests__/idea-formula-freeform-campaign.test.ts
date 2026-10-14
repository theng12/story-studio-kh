/**
 * Formula-only campaigns have no Topic Pack subject catalogue. They reuse the
 * normal freeform Ideas operation and preserve durable campaign completion.
 * Every provider response below comes from the in-process mock GenStudio API.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const MODEL = 'mock-chat-v1'
const FORMULA = 'history-narration'

function idea(title: string) {
  return {
    title,
    logline: `${title} is examined through a concrete historical turning point.`,
    themes: ['history', title],
    suggested_chapters: 8,
    suggested_length: '40 min',
    mood: 'measured',
  }
}

function job(slug: string, campaignId: string, count: number): any {
  return {
    job_id: `freeform-campaign-${campaignId}`,
    project_slug: slug,
    type: 'idea_campaign',
    episode_id: 'ideas',
    title: 'Formula freeform test',
    status: 'running',
    created_at: new Date().toISOString(),
    output_lines: [],
    progress: 0,
    params: {
      campaign_id: campaignId,
      count,
      model: MODEL,
      series_formula_id: FORMULA,
      topic_pack_ids: [],
      genre: 'history',
      audience: 'curious adults',
      mood: 'measured',
    },
  }
}

async function setup() {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await import('../providers/text/genstudio.js')
  const { generateIdeaCampaign } = await import('../generators/idea-campaign.js')
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
  return {
    temp, service, pm, im, generateIdeaCampaign,
    async close() {
      clearGenStudioCatalogCache()
      await service.close()
      await temp.cleanup()
    },
  }
}

test('formula-only campaign lets the provider choose subjects outside formula examples while seeing formula-wide history', async () => {
  const env = await setup()
  try {
    const other = await env.pm.createProject({ name: 'Formula history', niche_id: FORMULA })
    await env.im.addIdeas(other.slug, [idea('Cleopatra and the Grain Fleet')], MODEL)
    const project = await env.pm.createProject({ name: 'Fresh formula campaign', niche_id: FORMULA })

    env.service.queueScenario('chat', {
      outputText: JSON.stringify({ ideas: [
        idea('The Haitian Revolution and the Price of Sugar'),
        idea('How the Telegraph Rewired Imperial News'),
      ] }),
    })
    const run = job(project.slug, 'formula-history', 2)
    await env.generateIdeaCampaign(run)

    const stored = await env.im.getIdeas(project.slug)
    assert.deepEqual(stored.map(row => row.title), [
      'The Haitian Revolution and the Price of Sugar',
      'How the Telegraph Rewired Imperial News',
    ])
    assert.ok(stored.every(row => row.campaign_id === 'formula-history'))
    assert.ok(stored.every(row => row.series_formula_id === FORMULA))
    assert.ok(stored.every(row => Array.isArray(row.topic_pack_ids) && row.topic_pack_ids.length === 0))
    const submit = env.service.submissions.find(row => row.operation === 'chat')
    assert.ok(submit)
    assert.match(String((submit.parsedBody?.input as any[])?.[0]?.content), /Cleopatra and the Grain Fleet/)
    assert.doesNotMatch(String((submit.parsedBody?.input as any[])?.[0]?.content), /RESERVED ASSIGNMENTS/)
  } finally {
    await env.close()
  }
})

test('rejected duplicate does not fill a formula-only campaign slot', async () => {
  const env = await setup()
  try {
    const project = await env.pm.createProject({ name: 'Duplicate rejection', niche_id: FORMULA })
    await env.im.addIdeas(project.slug, [idea('The Haitian Revolution and the Price of Sugar')], MODEL)

    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [
      idea('The Haitian Revolution and the Price of Sugar'),
      idea('The Suez Canal and the Global Clock'),
    ] }) })
    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [
      idea('The First Weather Map Changed Shipping'),
    ] }) })
    const run = job(project.slug, 'formula-reject', 2)
    await env.generateIdeaCampaign(run)

    const created = (await env.im.getIdeas(project.slug)).filter(row => row.campaign_id === 'formula-reject')
    assert.deepEqual(created.map(row => row.title).sort(), [
      'The First Weather Map Changed Shipping',
      'The Suez Canal and the Global Clock',
    ])
    assert.equal(env.service.submissions.filter(row => row.operation === 'chat').length, 2)
    assert.equal(run.result.completed, 2)
  } finally {
    await env.close()
  }
})

test('formula-only retry keeps completed campaign rows and submits only the shortfall', async () => {
  const env = await setup()
  try {
    const project = await env.pm.createProject({ name: 'Campaign resume', niche_id: FORMULA })
    await env.im.addIdeas(project.slug, [{
      ...idea('The Vinland Map and the North Atlantic'),
      campaign_id: 'formula-resume',
      series_formula_id: FORMULA,
      topic_pack_ids: [],
    }], MODEL, 'formula-resume')

    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [
      idea('The Library of Timbuktu and Desert Trade'),
    ] }) })
    const run = job(project.slug, 'formula-resume', 2)
    await env.generateIdeaCampaign(run)

    const campaign = (await env.im.getIdeas(project.slug)).filter(row => row.campaign_id === 'formula-resume')
    assert.equal(campaign.length, 2)
    assert.equal(campaign.filter(row => row.title === 'The Vinland Map and the North Atlantic').length, 1)
    assert.equal(env.service.submissions.filter(row => row.operation === 'chat').length, 1)
    assert.match(String(((env.service.submissions[0]?.parsedBody?.input) as any[])?.[0]?.content), /Generate exactly 1 episode ideas/)
  } finally {
    await env.close()
  }
})

test('formula-only campaign preserves pinned title-count rewriting and emoji cleanup', async () => {
  const env = await setup()
  try {
    const project = await env.pm.createProject({ name: 'Pinned formula campaign', niche_id: FORMULA })
    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [
      idea('7 Maps 🧭 That Changed the Atlantic'),
    ] }) })
    const run = job(project.slug, 'formula-pinned', 1)
    run.params.items_per_listicle = 10
    await env.generateIdeaCampaign(run)

    const [stored] = (await env.im.getIdeas(project.slug)).filter(row => row.campaign_id === 'formula-pinned')
    assert.equal(stored?.suggested_chapters, 10)
    assert.equal(stored?.title, '10 Maps That Changed the Atlantic')
  } finally {
    await env.close()
  }
})

test('campaign ignores caller-supplied internal action fields without an operation id', async () => {
  const env = await setup()
  const jq = await import('../services/job-queue.js')
  const wasPaused = jq.isQueuePaused()
  const forgedActionId = '10000000-0000-4000-8000-000000000001'
  let firstJobId = ''
  let secondJobId = ''
  await jq.setQueuePaused(true)
  try {
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const app = (await import('../app.js')).app
    const project = await request(app).post('/api/projects').send({
      name: 'Idea fresh action boundary',
      episode_prefix: 'EP',
      episode_digits: 3,
    })
    assert.equal(project.status, 201)

    const first = await request(app)
      .post(`/api/projects/${project.body.slug}/generate/ideas/campaign`)
      .send({
        count: 1,
        model: MODEL,
        generation_action: { id: forgedActionId, kind: 'fresh' },
        generation_action_fingerprint: 'caller-forged',
      })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    firstJobId = first.body.job_id
    assert.equal(jq.getJob(firstJobId)?.params.generation_action, undefined)
    assert.equal(jq.getJob(firstJobId)?.params.generation_action_fingerprint, undefined)

    await jq.requestJobCancellation(project.body.slug, firstJobId)
    assert.equal(jq.getJob(firstJobId)?.status, 'cancelled')

    const fresh = await request(app)
      .post(`/api/projects/${project.body.slug}/generate/ideas/campaign`)
      .send({ count: 1, model: MODEL, operation_id: forgedActionId })
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body))
    secondJobId = fresh.body.job_id
    assert.deepEqual(jq.getJob(secondJobId)?.params.generation_action, { id: forgedActionId, kind: 'fresh' })
  } finally {
    for (const jobId of [firstJobId, secondJobId]) {
      const job = jobId ? jq.getJob(jobId) : undefined
      if (job?.status === 'queued' || job?.status === 'paused') await jq.requestJobCancellation(job.project_slug, jobId)
      if (jobId && ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || '')) {
        jq.removeTerminalJob(jq.getJob(jobId)?.project_slug || '', jobId)
      }
    }
    await jq.setQueuePaused(wasPaused)
    await env.close()
  }
})

test('manual Idea Campaign redo keeps saved ideas and replays one source-bound action', async () => {
  const env = await setup()
  const jq = await import('../services/job-queue.js')
  const wasPaused = jq.isQueuePaused()
  let sourceJobId = ''
  let replacementJobId = ''
  const operationId = '20000000-0000-4000-8000-000000000002'
  try {
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const app = (await import('../app.js')).app
    const created = await request(app).post('/api/projects').send({
      name: 'Idea manual redo source',
      episode_prefix: 'EP',
      episode_digits: 3,
    })
    assert.equal(created.status, 201)
    const slug = created.body.slug
    await env.pm.updateProject(slug, {
      niche_id: FORMULA,
      topic_pack_ids: ['economics-ancient-civilizations'],
    } as any)
    await env.im.addIdeas(slug, [{
      ...idea('Saved before the stopped campaign'),
      campaign_id: 'stopped-campaign',
    }], MODEL, 'stopped-campaign')

    const restore = jq._setExecutorForTesting('idea_campaign', async source => {
      await jq.recordGenStudioJob(source.job_id, {
        id: `pending:${source.job_id}`,
        operation: 'chat.response',
        state: 'submitting',
        dispatch_state: 'dispatched',
        updated_at: new Date().toISOString(),
      })
      throw new Error('intentional stopped Idea Campaign')
    })
    try {
      const source = jq.enqueuePreparedForTest({
        project_slug: slug,
        type: 'idea_campaign',
        episode_id: 'ideas',
        title: 'Stopped Idea Campaign',
        params: { campaign_id: 'stopped-campaign', model: MODEL, auto_retry: false },
      })
      sourceJobId = source.job_id
      await waitFor(() => jq.getJob(sourceJobId)?.status === 'error', { label: 'Idea Campaign source to stop' })
      await waitFor(() => !jq._isJobWorkerActiveForTesting(sourceJobId), { label: 'Idea Campaign source to finish stopping' })
      await waitFor(() => jq.getJob(sourceJobId)?.genstudio_jobs?.[0]?.state === 'not_created', {
        label: 'Idea Campaign uncertain evidence to finish checkpointing',
      })
    } finally {
      restore()
    }

    const sourceEvidence = structuredClone(jq.getJob(sourceJobId)?.genstudio_jobs)
    await jq.setQueuePaused(true)
    const body = {
      count: 1,
      model: MODEL,
      creative_direction: 'Try a separate angle.',
      operation_id: operationId,
      manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
    }
    const first = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send(body)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    replacementJobId = first.body.job_id

    const sourceAfter = jq.getJob(sourceJobId)
    const replacement = jq.getJob(replacementJobId)
    assert.ok(sourceAfter?.force_abandoned)
    assert.deepEqual(sourceAfter?.genstudio_jobs, sourceEvidence)
    assert.equal(replacement?.params.manual_redo?.source_job_id, sourceJobId)
    assert.equal(replacement?.params.manual_redo?.selected_model_id, MODEL)
    assert.notEqual(replacement?.params.campaign_id, 'stopped-campaign')
    assert.equal((await env.im.getIdeas(slug)).some(row => row.title === 'Saved before the stopped campaign'), true)

    const acceptedActionFingerprint = replacement?.params.generation_action_fingerprint
    assert.match(String(acceptedActionFingerprint || ''), /^[0-9a-f]{64}$/)
    await jq.mutateAuthoritativeJob(slug, replacementJobId, current => {
      // Normal writing-job quota waits add this after admission (job-queue.ts:parkForQuota).
      current.params.quota_retry_at = '2099-01-01T00:00:00.000Z'
      return current
    })
    assert.equal(jq.getJob(replacementJobId)?.params.quota_retry_at, '2099-01-01T00:00:00.000Z')
    assert.equal(jq.getJob(replacementJobId)?.params.generation_action_fingerprint, acceptedActionFingerprint)

    const replay = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send(body)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.job_id, replacementJobId)

    await env.pm.updateProject(slug, {
      niche_id: FORMULA,
      topic_pack_ids: ['ancient-humans-environments'],
    } as any)
    const replayAfterPackChange = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send(body)
    assert.equal(replayAfterPackChange.status, 200, JSON.stringify(replayAfterPackChange.body))
    assert.equal(replayAfterPackChange.body.job_id, replacementJobId)
    const freshAgainstIncompatiblePack = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send({ ...body, operation_id: '21000000-0000-4000-8000-000000000012' })
    assert.equal(freshAgainstIncompatiblePack.status, 400, JSON.stringify(freshAgainstIncompatiblePack.body))

    await env.pm.updateProject(slug, { niche_id: 'missing-after-accept', topic_pack_ids: [] } as any)
    const replayAfterDefaultChange = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send(body)
    assert.equal(replayAfterDefaultChange.status, 200, JSON.stringify(replayAfterDefaultChange.body))
    assert.equal(replayAfterDefaultChange.body.job_id, replacementJobId)
    const freshAgainstMissingDefault = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send({ ...body, operation_id: '22000000-0000-4000-8000-000000000022' })
    assert.equal(freshAgainstMissingDefault.status, 404, JSON.stringify(freshAgainstMissingDefault.body))

    const changed = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send({ ...body, creative_direction: 'A changed request must not reuse the action.' })
    assert.equal(changed.status, 409, JSON.stringify(changed.body))
    assert.deepEqual(jq.getJob(sourceJobId)?.genstudio_jobs, sourceEvidence)
    assert.equal(env.service.submissions.length, 0, 'route admission never calls the paid provider')
  } finally {
    for (const jobId of [replacementJobId, sourceJobId]) {
      const queued = jobId ? jq.getJob(jobId) : null
      if (queued?.status === 'queued' || queued?.status === 'paused') await jq.requestJobCancellation(queued.project_slug, jobId)
      const terminal = jobId ? jq.getJob(jobId) : null
      if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) jq.removeTerminalJob(terminal.project_slug, jobId)
    }
    await jq.setQueuePaused(wasPaused)
    await env.close()
  }
})

test('manual Idea Campaign admission loss leaves its source and evidence unchanged', async () => {
  const env = await setup()
  const jq = await import('../services/job-queue.js')
  const wasPaused = jq.isQueuePaused()
  let sourceJobId = ''
  let blockerJobId = ''
  try {
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    const app = (await import('../app.js')).app
    const created = await request(app).post('/api/projects').send({ name: 'Idea manual redo collision' })
    assert.equal(created.status, 201)
    const slug = created.body.slug

    const restore = jq._setExecutorForTesting('idea_campaign', async source => {
      await jq.recordGenStudioJob(source.job_id, {
        id: `pending:${source.job_id}`,
        operation: 'chat.response',
        state: 'running',
        dispatch_state: 'dispatched',
        updated_at: new Date().toISOString(),
      })
      throw new Error('intentional stopped Idea Campaign')
    })
    try {
      const source = jq.enqueuePreparedForTest({
        project_slug: slug,
        type: 'idea_campaign',
        episode_id: 'ideas',
        params: { campaign_id: 'source', model: MODEL, auto_retry: false },
      })
      sourceJobId = source.job_id
      await waitFor(() => jq.getJob(sourceJobId)?.status === 'error', { label: 'collision source to stop' })
      await waitFor(() => !jq._isJobWorkerActiveForTesting(sourceJobId), { label: 'collision source to finish stopping' })
      await waitFor(() => jq.getJob(sourceJobId)?.genstudio_jobs?.[0]?.state === 'not_created', {
        label: 'collision source evidence to finish ordinary provider reconciliation',
      })
    } finally {
      restore()
    }
    const sourceBefore = structuredClone(jq.getJob(sourceJobId))

    await jq.setQueuePaused(true)
    const blocker = jq.enqueuePreparedForTest({
      project_slug: slug,
      type: 'idea_campaign',
      episode_id: 'ideas',
      params: { campaign_id: 'ordinary-blocker', model: MODEL, auto_retry: false },
    })
    blockerJobId = blocker.job_id
    const refused = await request(app)
      .post(`/api/projects/${slug}/generate/ideas/campaign`)
      .send({
        count: 1,
        model: MODEL,
        operation_id: '30000000-0000-4000-8000-000000000003',
        manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
      })
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(jq.getJob(sourceJobId)?.force_abandoned, undefined)
    assert.deepEqual(jq.getJob(sourceJobId)?.genstudio_jobs, sourceBefore?.genstudio_jobs)
    assert.equal(env.service.submissions.length, 0)
  } finally {
    for (const jobId of [blockerJobId, sourceJobId]) {
      const queued = jobId ? jq.getJob(jobId) : null
      if (queued?.status === 'queued' || queued?.status === 'paused') await jq.requestJobCancellation(queued.project_slug, jobId)
      const terminal = jobId ? jq.getJob(jobId) : null
      if (terminal && ['done', 'error', 'cancelled'].includes(terminal.status)) jq.removeTerminalJob(terminal.project_slug, jobId)
    }
    await jq.setQueuePaused(wasPaused)
    await env.close()
  }
})

test('formula-only shortfall keeps just-saved ideas at the front of a bounded AVOID prompt', async () => {
  const env = await setup()
  try {
    const project = await env.pm.createProject({ name: 'Bounded formula history', niche_id: FORMULA })
    await env.im.addIdeas(project.slug, [{
      ...idea('Archive record 201'),
      logline: 'Evidence item 201 documents a distinct event.',
      themes: ['archive-201', 'evidence-201'],
    }], MODEL)
    // `generated_at` is the production ordering key. Put the old record in a
    // prior write so the next 200 newest rows deliberately push it beyond the
    // prompt cap, while the complete similarity pool must still reject it.
    await new Promise(resolve => setTimeout(resolve, 5))
    const history = Array.from({ length: 200 }, (_, index) => {
      const number = index + 1
      return {
        ...idea(`Archive record ${number}`),
        logline: `Evidence item ${number} documents a distinct event.`,
        themes: [`archive-${number}`, `evidence-${number}`],
      }
    })
    await env.im.addIdeas(project.slug, history, MODEL)
    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [
      idea('Archive record 201'),
      {
        ...idea('Saffron ports reshaped coastal economies'),
        logline: 'Maritime insurance reshaped a previously unconnected coastal economy.',
        themes: ['maritime-insurance', 'coastal-economy'],
      },
    ] }) })
    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [
      {
        ...idea('Mountain observatories changed seasonal forecasts'),
        logline: 'A mountain observatory changed how communities understood seasonal weather.',
        themes: ['mountain-observatory', 'seasonal-weather'],
      },
    ] }) })

    await env.generateIdeaCampaign(job(project.slug, 'formula-avoid-order', 2))

    const submissions = env.service.submissions.filter(row => row.operation === 'chat')
    assert.equal(submissions.length, 2)
    const firstPrompt = String(((submissions[0]?.parsedBody?.input) as any[])?.[0]?.content)
    assert.doesNotMatch(firstPrompt, /Archive record 201/)
    const secondPrompt = String(((submissions[1]?.parsedBody?.input) as any[])?.[0]?.content)
    assert.match(secondPrompt, /Saffron ports reshaped coastal economies/)
    assert.equal((await env.im.getIdeas(project.slug)).filter(row => row.title === 'Archive record 201').length, 1)
    assert.equal((await env.im.getIdeas(project.slug)).filter(row => row.campaign_id === 'formula-avoid-order').length, 2)
  } finally {
    await env.close()
  }
})

test('queued freeform Ideas submit the prompt the campaign already built', async () => {
  const env = await setup()
  try {
    const formatLoader = await import('../services/format-loader.js')
    const ideas = await import('../services/freeform-idea-generation.js')
    const format = await formatLoader.getEffectiveFormat('frozen-ideas')
    env.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Saffron Ledger and Coastal Trade')] }) })

    const result = await ideas.generateFreeformIdeaBatch({
      request: { count: 1, model: MODEL, genre: 'history', audience: 'curious adults' } as any,
      format,
      standards: '',
      avoid: [],
      apiKeys: {},
      slug: 'frozen-ideas',
      requestIdentity: 'frozen-ideas:ideas:1',
      preparePrompt: () => 'FROZEN IDEAS PROMPT',
    })

    assert.equal(result[0]?.title, 'The Saffron Ledger and Coastal Trade')
    assert.match(String((env.service.submissions[0]?.parsedBody?.input as any[])?.[0]?.content), /FROZEN IDEAS PROMPT/)
    assert.equal(env.service.submissions[0]?.parsedBody?.model_id, MODEL)
  } finally {
    await env.close()
  }
})
