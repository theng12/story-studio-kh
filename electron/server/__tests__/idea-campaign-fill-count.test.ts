/**
 * Idea Campaign count truth, found in production 2026-10-20 (Brain Wise 3b980c16 attempt 2 reported
 * "91 of 75, -16 missing" while 74 ideas were on disk).
 *
 * The "idea repeat" warn-fill saves meaning-repeats under one fixed batch identity (the campaign id).
 * `addIdeas` returns the WHOLE set under an identity, so a second attempt's fill handed back the first
 * attempt's fill rows too. They were counted again, inflating `completed` past the disk.
 *
 * Cannot catch: real embeddings, real model wording.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const MODEL = 'mock-chat-v1'
const FORMULA = 'history-narration'

const idea = (title: string, logline = `${title} is examined through a concrete turning point.`) =>
  ({ title, logline, themes: ['history', title], suggested_chapters: 8, suggested_length: '40 min', mood: 'measured' })

const SEED = idea('The Saffron Ledger and Coastal Trade', 'Saffron moves along the coast.')
const FRESH = [
  idea('The Glassblowers of Murano at Midnight'),
  idea('Lighthouse Keepers of the Hebrides Storm'),
  idea('Medieval Cartographers and the Phantom Island'),
]
// Reworded saffron ideas: the word filter keeps them, the meaning check rejects them as repeats.
const REPEATS = [
  idea('A Crimson Fortune on the Malabar Coast', 'How saffron crocus threads crossed the sea.'),
  idea('Spice Caravans Across the Deccan Plateau', 'Saffron caravans cross the high plateau.'),
  idea('Harvesting Gold in the Kashmir Valleys', 'Saffron harvests in the high valleys.'),
]

/** Saffron texts share one vector (a repeat); every fresh title gets its own axis (never a repeat). */
function vector(text: string): number[] {
  if (/saffron/i.test(text)) return [1, 0, 0, 0]
  const axis = [/Glassblowers/, /Lighthouse/, /Cartographers/].findIndex(pattern => pattern.test(text))
  return axis < 0 ? [0, 0, 0, 1] : Array.from({ length: 4 }, (_, i) => (i === axis + 1 ? 1 : 0))
}

async function withEmbeddings(baseUrl: string) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', async () => {
      if (req.url === '/v1/embeddings') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: JSON.parse(raw).input.map((text: string, index: number) => ({ index, embedding: vector(text) })) }))
        return
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'content-length', 'connection'].includes(key))) as Record<string, string>
      const upstream = await fetch(`${baseUrl}${req.url}`, { method: req.method, headers, body: raw || undefined })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('a second attempt\'s warn-fill counts only its own rows: completed equals the campaign\'s saved ideas', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const proxy = await withEmbeddings(service.baseUrl)
  try {
    const pm = await import('../services/project-manager.js')
    const im = await import('../services/idea-manager.js')
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    await import('../providers/text/genstudio.js')
    const { generateIdeaCampaign } = await import('../generators/idea-campaign.js')
    await settings.setGenStudioUrl(proxy.url)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    clearGenStudioCatalogCache()

    const project = await pm.createProject({ name: 'Fill count', niche_id: FORMULA })
    await im.addIdeas(project.slug, [SEED], 'manual')
    await pm.updateConfig(project.slug, { idea_upgrades: { semantic_dedupe: 'on', embedding_model: 'emb::test', semantic_threshold: 0.9 } } as any)
    const reply = (...ideas: unknown[]) => service.queueScenario('chat', { outputText: JSON.stringify({ ideas }) })
    // Each attempt may make four requests. Attempt 1 saves two fresh ideas, sees one repeat, then
    // only word-rejected duplicates; attempt 2 sees one more repeat and saves nothing else.
    reply(FRESH[0], REPEATS[0]); reply(FRESH[1]); reply(FRESH[0]); reply(FRESH[0])
    reply(REPEATS[1]); reply(FRESH[0]); reply(FRESH[0]); reply(FRESH[0])

    const run: any = {
      job_id: 'fill-count', project_slug: project.slug, type: 'idea_campaign', episode_id: 'ideas',
      title: 't', status: 'running', created_at: new Date().toISOString(), output_lines: [], progress: 0,
      params: { campaign_id: 'fill-count', count: 4, model: MODEL, series_formula_id: FORMULA, topic_pack_ids: [] },
    }
    const owned = async () => (await im.getIdeas(project.slug)).filter(row => row.campaign_id === 'fill-count')

    // Attempt 1: 2 saved + 1 warn-fill = 3 of 4, so it fails short.
    await assert.rejects(() => generateIdeaCampaign(run), /3 of 4 ideas were saved/)
    assert.equal((await owned()).length, 3)
    const afterFirst = new Set((await owned()).map(row => row.id))

    // Attempt 2: 0 saved + 1 warn-fill = 4 on disk, exactly the target.
    await generateIdeaCampaign(run)
    const onDisk = await owned()
    assert.equal(onDisk.length, 4)
    assert.equal(run.result.completed, onDisk.length, 'completed is the campaign\'s distinct saved ideas, not the batch identity\'s whole set')
    assert.equal(run.result.created_idea_ids.length, 1, 'only this attempt\'s row')
    assert.equal(run.result.created_idea_ids.some((id: string) => afterFirst.has(id)), false, 'no row from the first attempt is counted again')
    clearGenStudioCatalogCache()
  } finally {
    await proxy.close()
    await service.close()
    await temp.cleanup()
  }
})
