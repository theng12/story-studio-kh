/**
 * A small Topic-Pack campaign for tests: a three-subject user pack on `history-narration`, every
 * subject already used once, and a duplicate-only provider. The structural pool is large (the
 * formula's axes keep producing new tuples) while the pack's SUBJECTS are spent — the shape a real
 * channel reaches (Refinanced 40/40).
 *
 * Every provider answer is an exact copy of a stored idea whose title carries every subject word, so
 * it never reads as drift and the word filter rejects it — a content rejection, not a provider failure.
 */
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

export const MODEL = 'mock-chat-v1'
export const FORMULA = 'history-narration'
export const PACK_ID = 'campaign-fixture-pack'
const SUBJECTS = ['Tea', 'Coffee', 'Mead']
const DUPLICATE = {
  title: 'Tea Coffee and Mead Houses of the Old Trade Roads',
  logline: 'Three drinks, one network of roadside houses and the merchants who kept them open.',
}

export function storyIdea(title: string, logline = `${title} is examined through a concrete turning point.`) {
  return { title, logline, themes: ['history', 'trade'], suggested_chapters: 8, suggested_length: '40 min', mood: 'measured' }
}

export async function setupPackCampaign(options: { maxSiblingsPerSubject?: number } = {}) {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const loader = await import('../services/topic-pack-loader.js')
  const planner = await import('../services/idea-campaign-planner.js')
  const niches = await import('../services/niche-loader.js')
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await import('../providers/text/genstudio.js')
  const { generateIdeaCampaign } = await import('../generators/idea-campaign.js')
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()

  await loader.ensureTopicPacksDir()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(loader.topicPackFilePath(PACK_ID), JSON.stringify({
    id: PACK_ID, name: 'Fixture drinks', description: 'Drinks through history', schemaVersion: 1,
    compatibleNicheIds: [], subjects: SUBJECTS,
    ...(options.maxSiblingsPerSubject ? { maxSiblingsPerSubject: options.maxSiblingsPerSubject } : {}),
  }))
  loader.invalidateTopicPackCache()
  const project = await pm.createProject({ name: `Pack campaign ${Math.random().toString(36).slice(2, 7)}`, niche_id: FORMULA })
  await pm.updateProject(project.slug, { topic_pack_ids: [PACK_ID] } as any)

  const niche = await niches.composeNicheWithTopicPacks((await niches.loadNiche(FORMULA))!, [PACK_ID])
  /** Exactly what the generator plans for a campaign, from the project's stored fingerprints. */
  const plan = async (campaignId: string, count: number) => planner.planIdeaAssignments({
    niche, count, seed: campaignId,
    usedFingerprints: (await im.getIdeas(project.slug)).map(row => row.idea_fingerprint).filter((value): value is string => !!value),
  })
  // One earlier idea per subject: every subject is used, and the duplicate answer repeats the first.
  const earlier = (await plan('earlier', SUBJECTS.length)).slice(0, SUBJECTS.length)
  await im.addIdeas(project.slug, earlier.map((assignment, index) => ({
    ...(index === 0 ? storyIdea(DUPLICATE.title, DUPLICATE.logline) : storyIdea(`${assignment.dimensions.subject} Stories Retold ${index}`)),
    idea_fingerprint: assignment.fingerprint, series_formula_id: FORMULA, topic_pack_ids: [PACK_ID],
  })), 'manual')

  /**
   * One duplicate answer per request, keyed to the assignments the generator will reserve (the
   * output contract only accepts the reserved keys). `perCall` is the batch size, `calls` the
   * requests the run may make.
   */
  const duplicateAnswers = (assignments: Array<{ idea_key: string }>, perCall: number, calls = 4) => {
    for (let call = 0; call < calls; call++) {
      const chunk = assignments.slice(call * perCall, (call + 1) * perCall)
      service.queueScenario('chat', { outputText: JSON.stringify({ ideas: chunk.map(item => ({ ...storyIdea(DUPLICATE.title, DUPLICATE.logline), idea_key: item.idea_key })) }) })
    }
  }
  const job = (id: string, count: number, params: Record<string, unknown> = {}): any => ({
    job_id: id, project_slug: project.slug, type: 'idea_campaign', episode_id: 'ideas', title: 't', status: 'running',
    created_at: new Date().toISOString(), output_lines: [], progress: 0,
    params: { campaign_id: id, count, model: MODEL, series_formula_id: FORMULA, topic_pack_ids: [PACK_ID], ...params },
  })
  const chatBodies = () => service.submissions.filter(row => row.operation === 'chat').map(row => row.bodyText)
  const done = async () => { clearGenStudioCatalogCache(); await service.close(); await temp.cleanup() }
  return { service, pm, im, project, plan, duplicateAnswers, job, chatBodies, generateIdeaCampaign, done }
}
