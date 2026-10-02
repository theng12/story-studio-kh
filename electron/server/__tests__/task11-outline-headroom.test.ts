import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Job } from '../models/types.js'
import type { TextGenerationRequest, TextProvider } from '../providers/types.js'
import { useTempDataDir } from './_helpers.js'

const MODEL = 'genstudio-chat-test-outline-headroom-v1'
let cleanup: () => Promise<void>
let providerCalls = 0
let generateOutlineOnly: typeof import('../generators/episode.js')['generateOutlineOnly']
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')

function outlineResponse(count: number): string {
  return JSON.stringify(Array.from({ length: count }, (_, index) => ({
    n: index + 1,
    title: `Chapter ${index + 1}`,
    synopsis: `A distinct chapter ${index + 1} synopsis.`,
    key_beats: [`Beat ${index + 1}A`, `Beat ${index + 1}B`],
  })))
}

function outlineJob(projectSlug: string, episodeId: string, title: string, suffix: string): Job {
  return {
    job_id: `headroom-${suffix}`,
    project_slug: projectSlug,
    episode_id: episodeId,
    type: 'outline_only',
    title: 'Outline headroom regression',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      episode_id: episodeId,
      title,
      model: MODEL,
      chapters: 10,
      words_per_chapter: 100,
      total_words: 1_000,
      length: 20,
    },
  } as Job
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  ;({ generateOutlineOnly } = await import('../generators/episode.js'))
  const { registry } = await import('../providers/registry.js')
  const provider: TextProvider = {
    meta: { id: 'genstudio', name: 'Fake the Gateway', apiKeyField: 'genstudio_api_key' as any },
    supportsModel: model => model === `genstudio-chat:${MODEL}`,
    async callText(req: TextGenerationRequest): Promise<string> {
      if (!req.outputContract) throw new Error('The headroom fixture permits outline calls only.')
      providerCalls++
      return outlineResponse(11)
    },
  }
  registry.registerText(provider)
})

after(async () => cleanup())

test('generateOutlineOnly accepts a cached valid headroom outline without another provider call', async () => {
  const project = await pm.createProject({ name: 'Cached outline headroom' })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Eleven useful chapters',
    logline: 'A disposable cached-outline fixture.',
    themes: [],
    suggested_chapters: 10,
    suggested_length: '20 min',
    mood: 'neutral',
  }], MODEL)
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)

  try {
    await generateOutlineOnly(outlineJob(project.slug, accepted.episode_code, accepted.idea.title, 'seed'))
  } catch (error) {
    if (!/extra outline chapters/i.test(error instanceof Error ? error.message : String(error))) throw error
  }
  assert.equal(providerCalls, 1, 'the seed call writes one valid 11-for-10 outline')
  providerCalls = 0

  const cached = outlineJob(project.slug, accepted.episode_code, accepted.idea.title, 'cached')
  await generateOutlineOnly(cached)

  assert.equal(providerCalls, 0, 'the accepted cached outline must not be regenerated or billed again')
  assert.match(cached.output_lines.join('\n'), /Outline loaded from cache: 11 chapter slots/)
})
