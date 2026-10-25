/**
 * A channel's `content_language` must reach its IDEA text.
 *
 * The language boundary existed for the script, the YouTube description and the
 * paste prompt, but not for generated ideas: a Khmer channel (Komsan) got
 * English ideas because neither the freeform idea prompt nor the campaign
 * prompt ever carried the directive. This suite pins the two halves of the fix:
 *
 *   - the prompt builders add the shared directive when they are given one and
 *     stay byte-identical when they are not, and
 *   - the campaign job reads the channel's LIVE language and the prompt that is
 *     actually submitted follows it, including a change between two runs.
 *
 * Idea text is one surface, not several: the freeform branch (formula-only
 * channels, `buildFreeformIdeaPrompt`) and the coverage branch (Topic Pack
 * channels, `campaignPrompt`) both answer here.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Format, GenerateIdeasRequest, Niche } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const MODEL = 'mock-chat-v1'
const FORMULA = 'history-narration'
const ROLE_LINE = 'You generate story ideas for one channel.'
const GUIDANCE_TEXT = 'Keep every idea distinct and on-tone for the format.'

let cl: typeof import('../lib/content-language.js')
let freeform: typeof import('../services/freeform-idea-generation.js')
let ideasRoute: typeof import('../routes/ideas.js')
let campaignGen: typeof import('../generators/idea-campaign.js')

before(async () => {
  cl = await import('../lib/content-language.js')
  freeform = await import('../services/freeform-idea-generation.js')
  ideasRoute = await import('../routes/ideas.js')
  campaignGen = await import('../generators/idea-campaign.js')
})

const format = {
  idea: {
    systemPromptRole: ROLE_LINE,
    guidanceText: GUIDANCE_TEXT,
    titleShapeRules: [],
    exampleIdeas: [],
  },
  script: {
    chapterCountRange: [3, 20],
    lengthMinutesRange: [10, 90],
    defaultChapterCount: 8,
    defaultLengthMinutes: 40,
  },
} as unknown as Format

const request = { count: 2, model: MODEL } as unknown as GenerateIdeasRequest

const niche = {
  id: FORMULA,
  name: 'History Narration',
  ideaSystemPromptRole: 'You write history ideas.',
  ideaGuidanceText: 'Ground each idea in a concrete turning point.',
} as unknown as Niche

const assignment = {
  idea_key: 'subject-1',
  fingerprint: 'fp-1',
  dimensions: { 'episode-object': 'Salt roads' },
}

function campaignPrompt(languageDirectiveText?: string): string {
  return campaignGen.__ideaCampaignInternals.campaignPrompt({
    request: { campaign_id: 'c1', count: 1, model: MODEL } as any,
    format,
    niche,
    assignments: [assignment as any],
    avoid: [],
    standards: '',
    ...(languageDirectiveText === undefined ? {} : { languageDirectiveText }),
  })
}

/** A formula-only (freeform) idea campaign job: `topic_pack_ids: []` is what selects that branch. */
function job(slug: string, campaignId: string): any {
  return {
    job_id: `idea-language-${campaignId}`,
    project_slug: slug,
    type: 'idea_campaign',
    episode_id: 'ideas',
    title: 'Idea language test',
    status: 'running',
    created_at: new Date().toISOString(),
    output_lines: [],
    progress: 0,
    params: {
      campaign_id: campaignId,
      count: 1,
      model: MODEL,
      series_formula_id: FORMULA,
      topic_pack_ids: [],
      genre: 'history',
      audience: 'curious adults',
      mood: 'measured',
    },
  }
}

describe('the freeform idea prompt (ordinary generation)', () => {
  test('unset adds nothing, so the prompt is byte-identical', t => {
    t.mock.method(Math, 'random', () => 0.25)
    const omitted = freeform.buildFreeformIdeaPrompt(request, format, '', [])
    const empty = freeform.buildFreeformIdeaPrompt(request, format, '', [], undefined, undefined, '', '')
    assert.equal(empty, omitted, 'an unset language must not change one byte')
    assert.doesNotMatch(omitted, /audience-facing text/)
  })

  test('a Khmer channel carries the directive, before the guidance it outranks', () => {
    const prompt = freeform.buildFreeformIdeaPrompt(
      request, format, '', [], undefined, undefined, '', cl.languageDirective('km'),
    )
    assert.match(prompt, /Write ALL audience-facing text in Khmer \(Khmer script\)\./)
    assert.ok(prompt.indexOf('Khmer') < prompt.indexOf(GUIDANCE_TEXT),
      'the language instruction precedes the format guidance it takes precedence over')
    assert.ok(prompt.indexOf(ROLE_LINE) < prompt.indexOf('Khmer'),
      'the directive follows the role line, as the paste prompt places it')
  })

  test('an English channel carries the directive too', () => {
    const prompt = freeform.buildFreeformIdeaPrompt(
      request, format, '', [], undefined, undefined, '', cl.languageDirective('en'),
    )
    assert.match(prompt, /Write ALL audience-facing text in English\./)
  })

  test('the directive covers every text field the model returns, not just the prose', () => {
    const prompt = freeform.buildFreeformIdeaPrompt(
      request, format, '', [], undefined, undefined, '', cl.languageDirective('km'),
    )
    assert.match(prompt, /title, logline, each theme, mood and suggested_length/)
    assert.match(prompt, /Keep JSON keys and technical identifiers unchanged/)
  })
})

describe('the campaign idea prompt (Topic Pack coverage)', () => {
  test('unset adds nothing, so the prompt is byte-identical', () => {
    assert.equal(campaignPrompt(''), campaignPrompt())
    assert.doesNotMatch(campaignPrompt(), /audience-facing text/)
  })

  test('a Khmer channel carries the directive, before the reserved assignments', () => {
    const prompt = campaignPrompt(cl.languageDirective('km'))
    assert.match(prompt, /Write ALL audience-facing text in Khmer \(Khmer script\)\./)
    assert.match(prompt, /title, logline, each theme, mood and suggested_length/)
    assert.match(prompt, /Keep JSON keys and idea_key unchanged/)
    assert.ok(prompt.indexOf('Khmer') < prompt.indexOf('RESERVED ASSIGNMENTS:'),
      'the language is read as part of the job, before the subjects are satisfied')
  })

  test('an English channel carries the directive too', () => {
    assert.match(campaignPrompt(cl.languageDirective('en')), /Write ALL audience-facing text in English\./)
  })
})

describe('the paste prompt', () => {
  test('still carries the same shared directive, unchanged', () => {
    const prompt = ideasRoute.buildPastePrompt(format, undefined, '', cl.languageDirective('km'))
    assert.match(prompt, /Write ALL audience-facing text in Khmer \(Khmer script\)\./)
    assert.ok(prompt.indexOf('Khmer') < prompt.indexOf('Return a JSON array'),
      'the language instruction precedes the shape rules')
  })

  test('unset is still the legacy prompt with no directive', () => {
    assert.doesNotMatch(ideasRoute.buildPastePrompt(format), /audience-facing text/)
  })
})

// ── The live read, proved at the wire ────────────────────────────────────────
// The builder tests above prove the prompts carry a directive they are given.
// These prove the service reads the channel's language itself.
describe('the service reads the live channel language', () => {
  function idea(title: string) {
    return {
      title,
      logline: `${title} is examined through one concrete historical turning point.`,
      themes: ['history', 'turning-point'],
      suggested_chapters: 8,
      suggested_length: '40 min',
      mood: 'measured',
    }
  }

  test('a freeform batch built by the service carries the channel language', async () => {
    const temp = await useTempDataDir()
    const service = await startMockGenStudioService()
    try {
      const pm = await import('../services/project-manager.js')
      const settings = await import('../services/app-settings.js')
      const { setApiKey } = await import('../services/app-secrets-store.js')
      const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
      await import('../providers/text/genstudio.js')
      await settings.setGenStudioUrl(service.baseUrl)
      await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      clearGenStudioCatalogCache()

      const project = await pm.createProject({ name: 'Language channel', niche_id: FORMULA, content_language: 'km' })
      service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('A direct freeform idea')] }) })
      await freeform.generateFreeformIdeaBatch({
        request: { ...request, count: 1 }, format, standards: '', avoid: [], apiKeys: {},
        slug: project.slug, requestIdentity: 'language-direct-km',
      })
      const row = service.submissions.filter(r => r.operation === 'chat').at(-1)!
      const prompt = String((row.parsedBody?.input as any[])?.[0]?.content)
      assert.ok(prompt.includes(cl.languageDirective('km')), 'the Khmer directive reaches the built prompt')

      // A language the owner changes is picked up by the NEXT run, not cached.
      await pm.updateProject(project.slug, { content_language: 'en' })
      service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('A direct freeform idea')] }) })
      await freeform.generateFreeformIdeaBatch({
        request: { ...request, count: 1 }, format, standards: '', avoid: [], apiKeys: {},
        slug: project.slug, requestIdentity: 'language-direct-en',
      })
      const englishRow = service.submissions.filter(r => r.operation === 'chat').at(-1)!
      const englishPrompt = String((englishRow.parsedBody?.input as any[])?.[0]?.content)
      assert.ok(englishPrompt.includes(cl.languageDirective('en')))
      assert.doesNotMatch(englishPrompt, /Khmer \(Khmer script\)/)

      await pm.updateProject(project.slug, { content_language: null })
      service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('A direct freeform idea')] }) })
      await freeform.generateFreeformIdeaBatch({
        request: { ...request, count: 1 }, format, standards: '', avoid: [], apiKeys: {},
        slug: project.slug, requestIdentity: 'language-direct-none',
      })
      const unsetRow = service.submissions.filter(r => r.operation === 'chat').at(-1)!
      const unsetPrompt = String((unsetRow.parsedBody?.input as any[])?.[0]?.content)
      assert.doesNotMatch(unsetPrompt, /audience-facing text/, 'a cleared language adds no directive')
    } finally {
      const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
      clearGenStudioCatalogCache()
      await service.close()
      await temp.cleanup()
    }
  })
})


test('a campaign job submits the prompt in the channel language it reads live', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    const pm = await import('../services/project-manager.js')
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    await import('../providers/text/genstudio.js')
    const { generateIdeaCampaign } = await import('../generators/idea-campaign.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()

    // One project per language, so a cached read in one run cannot mask a live read in the next.
    const run = async (language: 'km' | 'en' | null, campaignId: string, title: string): Promise<string> => {
      const project = await pm.createProject({
        name: `Idea language ${campaignId}`, niche_id: FORMULA,
        ...(language ? { content_language: language } : {}),
      })
      // The chat scenario queue is shared and FIFO. Drop anything the previous run did not
      // consume, or this run is answered with the LAST run's scripted ideas — which the campaign
      // then rejects as near-duplicates of what is already saved, and refills until it gives up.
      service.clearQueuedScenarios('chat')
      const response = JSON.stringify({ ideas: [{
        title, logline: `${title} is examined through one concrete turning point.`,
        themes: ['history'], suggested_chapters: 8, suggested_length: '40 min', mood: 'measured',
      }] })
      for (let i = 0; i < 10; i++) service.queueScenario('chat', { outputText: response })
      await generateIdeaCampaign(job(project.slug, campaignId))
      const row = service.submissions.filter(r => r.operation === 'chat').at(-1)!
      assert.ok(row, 'the campaign submitted a chat request')
      return String((row.parsedBody?.input as any[])?.[0]?.content)
    }

    const khmer = await run('km', 'lang-km', 'Salt Roads of the Khmer Empire')
    assert.match(khmer, /Write ALL audience-facing text in Khmer \(Khmer script\)\./)

    const english = await run('en', 'lang-en', 'How the Telegraph Rewired Imperial News')
    assert.match(english, /Write ALL audience-facing text in English\./)
    assert.doesNotMatch(english, /Khmer \(Khmer script\)/)

    const legacy = await run(null, 'lang-none', 'Volcanic Winters and Failed Harvests')
    assert.doesNotMatch(legacy, /audience-facing text/, 'an unset language adds no directive')
  } finally {
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})
