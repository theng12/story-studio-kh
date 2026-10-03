/**
 * Formula-only campaigns have no Topic Pack subject catalogue. They reuse the
 * normal freeform Ideas operation and preserve durable campaign completion.
 * Every provider response below comes from the in-process mock GenStudio API.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
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
