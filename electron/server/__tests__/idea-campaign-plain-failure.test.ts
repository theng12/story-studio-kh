/**
 * Ideas audit, 2026-10-03 — Idea Campaign failures in plain English, and the
 * AVOID list sends the NEWEST history, not the oldest.
 *
 * The owner read "8/10 required item(s) verified. Missing/invalid: idea-slot-9,
 * idea-slot-10 … unused fingerprints" in Jobs. It now says how many were saved
 * and the one thing to do next. Every provider response comes from the
 * in-process mock GenStudio API.
 *
 * Cannot catch: how the Jobs page lays the message out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { __ideaCampaignInternals } from '../generators/idea-campaign.js'

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

test('campaign AVOID block carries the newest 200 titles, not the oldest', () => {
  // newest-first, as collectFormulaHistory returns it
  const avoid = Array.from({ length: 250 }, (_, i) => ({ title: `History item ${String(i).padStart(3, '0')}` }))
  const prompt = __ideaCampaignInternals.campaignPrompt({
    request: { campaign_id: 'c', count: 1 } as any,
    format: {
      idea: { systemPromptRole: 'Role.', guidanceText: 'Guide.' },
      script: { chapterCountRange: [4, 9], lengthMinutesRange: [20, 30] },
    } as any,
    niche: { id: 'n', name: 'N', description: 'N', builtin: true, schemaVersion: 1, exampleTopics: [] } as any,
    assignments: [{ idea_key: 'idea-1', fingerprint: 'f', dimensions: { subject: 'x' } }] as any,
    avoid: avoid as any,
  })
  assert.match(prompt, /History item 000/, 'the newest idea must be avoided')
  assert.match(prompt, /History item 199/)
  assert.doesNotMatch(prompt, /History item 200/, 'only the newest 200 are sent')
  assert.doesNotMatch(prompt, /History item 249/, 'the oldest must not crowd out the newest')
})

test('a short campaign keeps what it saved and fails with one plain sentence', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
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

    const project = await pm.createProject({ name: 'Short campaign', niche_id: FORMULA })
    // First call saves one idea; every later call repeats it, so the duplicate
    // gate rejects it and the campaign runs out of attempts at 1 of 2.
    for (let i = 0; i < 4; i++) {
      service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Saffron Ledger and Coastal Trade')] }) })
    }
    const run: any = {
      job_id: 'plain-failure', project_slug: project.slug, type: 'idea_campaign', episode_id: 'ideas',
      title: 't', status: 'running', created_at: new Date().toISOString(), output_lines: [], progress: 0,
      params: { campaign_id: 'plain-failure', count: 2, model: MODEL, series_formula_id: FORMULA, topic_pack_ids: [] },
    }
    await assert.rejects(() => generateIdeaCampaign(run), (error: any) => {
      assert.equal(error.message, '1 of 2 ideas were saved. Press Retry to make the 1 missing one.')
      return true
    })
    assert.equal((await im.getIdeas(project.slug)).filter(row => row.campaign_id === 'plain-failure').length, 1,
      'the saved idea is kept for Retry')
    assert.equal(run.result.completion.complete, false)
    clearGenStudioCatalogCache()
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('campaign failure text never shows slot ids, fingerprints, or a refuse-everything coverage gate', () => {
  const source = readFileSync(fileURLToPath(new URL('../generators/idea-campaign.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /coverage-slot-/)
  assert.doesNotMatch(source, /unused fingerprints/)
  assert.doesNotMatch(source, /label: 'Idea Campaign coverage plan'/)
  assert.match(source, /Your Topic Packs have no unused subjects left for the other/)
  assert.match(source, /similarityPool\.unshift\(\.\.\.savedCandidates\)/)
})

test('Retry of an Idea Campaign uses the project\'s current Topic Packs (owner decision 2026-10-03)', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Pack shortfall retry', niche_id: FORMULA })
    const original = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'idea_campaign', episode_id: 'ideas', title: 'Ideas',
      params: { campaign_id: 'pack-short', count: 10, model: MODEL, series_formula_id: FORMULA, topic_pack_ids: ['old-pack'] },
    })
    await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({
      ...job, status: 'error', finished_at: new Date().toISOString(), error: '8 of 10 ideas were saved.',
    }))
    const retried = jq.retryTerminalJob(project.slug, original.job_id)
    assert.equal('topic_pack_ids' in retried.params, false, 'the generator then reads the project\'s current packs')
    assert.equal(retried.params.campaign_id, 'pack-short', 'the same campaign keeps the ideas already saved')
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})
