/**
 * 1.4.285 — the idea upgrades inside a real Idea Campaign run, against the in-process mock Gateway.
 *
 * Golden: with every switch off (the default) the campaign makes exactly one provider call per
 * batch, the prompt carries no covered-topics block, nothing new is written beside ideas.json and
 * job.result has no upgrade fields. On: the helper builds the map first, the idea prompt carries
 * it, the watch-only check logs and rejects nothing, and one stats line is appended.
 *
 * Cannot catch: real model quality, or a real embeddings model (the mock has none, so this also
 * pins the "meaning check unavailable — word check instead" path).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const MODEL = 'mock-chat-v1'
const FORMULA = 'history-narration'

function idea(title: string) {
  return { title, logline: `${title} is examined through a concrete turning point.`, themes: ['history', title], suggested_chapters: 8, suggested_length: '40 min', mood: 'measured' }
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
  const project = await pm.createProject({ name: `Upgrades ${Math.random().toString(36).slice(2, 7)}`, niche_id: FORMULA })
  await im.addIdeas(project.slug, [idea('The Saffron Ledger and Coastal Trade'), idea('Saffron Fields of the Old Empire')], 'manual')
  const job = (id: string): any => ({
    job_id: id, project_slug: project.slug, type: 'idea_campaign', episode_id: 'ideas', title: 't', status: 'running',
    created_at: new Date().toISOString(), output_lines: [], progress: 0,
    params: { campaign_id: id, count: 1, model: MODEL, series_formula_id: FORMULA, topic_pack_ids: [] },
  })
  const chatBodies = () => service.submissions.filter(row => row.operation === 'chat').map(row => row.bodyText)
  const done = async () => { clearGenStudioCatalogCache(); await service.close(); await temp.cleanup() }
  return { pm, service, project, job, chatBodies, generateIdeaCampaign, dir: pm.getProjectDir(project.slug)!, done }
}

test('all switches off: one call, no covered block, no new files, no upgrade fields', async () => {
  const t = await setup()
  try {
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Glassblowers of Murano at Midnight')] }) })
    const run = t.job('golden-off')
    await t.generateIdeaCampaign(run)
    assert.equal(t.chatBodies().length, 1)
    assert.doesNotMatch(t.chatBodies()[0]!, /COVERED SUBJECTS|COVERED LIST|IDEA SLOTS|REAL SUBJECTS/)
    assert.equal(existsSync(path.join(t.dir, 'covered-topics.json')), false)
    assert.equal(existsSync(path.join(t.dir, 'idea-campaign-stats.jsonl')), false)
    assert.equal('upgrades' in run.result, false)
    assert.equal('duplicate_stats' in run.result, false)
    assert.equal(run.output_lines.some((line: string) => /Watch-only|Covered-topics|Meaning check/.test(line)), false)
  } finally {
    await t.done()
  }
})

test('covered map + watch-only: map built first and shown to the idea model; nothing rejected by the watch; stats appended', async () => {
  const t = await setup()
  try {
    await t.pm.updateConfig(t.project.slug, { idea_upgrades: { helper_model: MODEL, covered_map: true, semantic_dedupe: 'shadow' } } as any)
    t.service.queueScenario('chat', { outputText: JSON.stringify({ add: { subjects: [{ name: 'Saffron trade', count: 2 }], eras: [{ name: 'Old Empire', count: 1 }] } }) })
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Glassblowers of Murano at Midnight')] }) })
    const run = t.job('upgrades-on')
    await t.generateIdeaCampaign(run)

    const [helperBody, ideaBody] = t.chatBodies()
    assert.match(helperBody!, /covered-topics map/)
    assert.match(ideaBody!, /COVERED SUBJECTS — never make another episode about any of these, even from a new angle:\\nSaffron trade ×2/)
    const map = JSON.parse(readFileSync(path.join(t.dir, 'covered-topics.json'), 'utf8'))
    assert.equal(map.covered_idea_ids.length, 2)
    assert.equal(map.helper_model, MODEL)

    assert.ok(run.output_lines.some((line: string) => /Meaning check unavailable \(no embeddings model chosen\)/.test(line)))
    assert.equal(run.result.completed, 1, 'the watch never rejects')
    assert.equal(run.result.upgrades.semantic_dedupe, 'shadow')
    const stats = readFileSync(path.join(t.dir, 'idea-campaign-stats.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(stats.length, 1)
    assert.equal(stats[0].campaign_id, 'upgrades-on')
    assert.equal(stats[0].generated, 1)
    assert.equal(stats[0].kept, 1)
    assert.equal(stats[0].shadow_method, 'words')
    assert.equal(stats[0].shadow_would_reject, 0)
    assert.equal(stats[0].rejected_words, 0)
  } finally {
    await t.done()
  }
})

test('a helper model that is not offered skips the map with a plain line; the campaign still runs', async () => {
  const t = await setup()
  try {
    await t.pm.updateConfig(t.project.slug, { idea_upgrades: { helper_model: 'gone::model', covered_map: true } } as any)
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Glassblowers of Murano at Midnight')] }) })
    const run = t.job('helper-gone')
    await t.generateIdeaCampaign(run)
    assert.ok(run.output_lines.some((line: string) => /Idea helper model "gone::model" is not available/.test(line)))
    assert.equal(t.chatBodies().length, 1, 'no other model is substituted')
    assert.equal(run.result.completed, 1)
  } finally {
    await t.done()
  }
})

/** The mock Gateway has no embeddings route; this proxy adds one in front of it. */
async function withEmbeddings(baseUrl: string, vector: (text: string) => number[], down = false) {
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', async () => {
      if (req.url === '/v1/embeddings') {
        res.writeHead(down ? 503 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(down ? { code: 'NO_EMBEDDINGS_ENGINE', detail: 'none' } : { data: JSON.parse(raw).input.map((text: string, index: number) => ({ index, embedding: vector(text) })) }))
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

test('meaning check "on": a repeat by meaning is rejected and its slot made again', async () => {
  const t = await setup()
  const settings = await import('../services/app-settings.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  const proxy = await withEmbeddings(t.service.baseUrl, text => /saffron/i.test(text) ? [1, 0] : [0, 1])
  try {
    await settings.setGenStudioUrl(proxy.url)
    clearGenStudioCatalogCache()
    await t.pm.updateConfig(t.project.slug, { idea_upgrades: { semantic_dedupe: 'on', embedding_model: 'emb::test', semantic_threshold: 0.9 } } as any)
    const reworded = { ...idea('A Crimson Fortune on the Malabar Coast'), logline: 'How saffron crocus threads crossed the sea.' }
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [reworded] }) })
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Glassblowers of Murano at Midnight')] }) })
    const run = t.job('meaning-on')
    await t.generateIdeaCampaign(run)
    assert.equal(t.chatBodies().length, 2, 'the rejected slot was made again')
    assert.ok(run.output_lines.some((line: string) => /↻ Rejected near-duplicate \(meaning 1\.00 ~ "The Saffron Ledger and Coastal Trade"\): "A Crimson Fortune/.test(line)))
    assert.equal(run.result.completed, 1)
    assert.equal(run.result.duplicate_stats.rejected_meaning, 1)
    const saved = (await (await import('../services/idea-manager.js')).getIdeas(t.project.slug)).map(row => row.title)
    assert.ok(saved.includes('The Glassblowers of Murano at Midnight') && !saved.includes(reworded.title))
  } finally {
    await proxy.close()
    await t.done()
  }
})

test('meaning check "on" with the embeddings engine down: nothing is blocked, the log says the word check decided', async () => {
  const t = await setup()
  const settings = await import('../services/app-settings.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  const proxy = await withEmbeddings(t.service.baseUrl, () => [1, 0], true)
  try {
    await settings.setGenStudioUrl(proxy.url)
    clearGenStudioCatalogCache()
    await t.pm.updateConfig(t.project.slug, { idea_upgrades: { semantic_dedupe: 'on', embedding_model: 'emb::test' } } as any)
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Glassblowers of Murano at Midnight')] }) })
    const run = t.job('meaning-down')
    await t.generateIdeaCampaign(run)
    assert.equal(run.result.completed, 1)
    assert.ok(run.output_lines.some((line: string) => /Meaning check unavailable \(NO_EMBEDDINGS_ENGINE.*only the word check is rejecting/.test(line)))
  } finally {
    await proxy.close()
    await t.done()
  }
})

test('variety on (freeform): the prompt carries one slot per idea and the idea records its slot', async () => {
  const t = await setup()
  try {
    await t.pm.updateConfig(t.project.slug, { idea_upgrades: { variety_seeds: true } } as any)
    t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [idea('The Glassblowers of Murano at Midnight')] }) })
    const run = t.job('variety-on')
    await t.generateIdeaCampaign(run)
    assert.match(t.chatBodies()[0]!, /IDEA SLOTS — one per idea, in order[^]*1\. era=/)
    const [saved] = (await (await import('../services/idea-manager.js')).getIdeas(t.project.slug)).filter(row => row.campaign_id === 'variety-on')
    assert.match(String(saved!.idea_dimensions?.variety_seed), /^era=.*; region=.*; theme=.*; type=/)
  } finally {
    await t.done()
  }
})

// 1.4.300 "Idea repeat check by meaning" safety check: the channel's "on" still rejects and remakes;
// the mode only decides what happens when the campaign then ends short.
for (const mode of ['warn', 'block'] as const) {
  test(`meaning check "on", campaign left short by repeats: ${mode === 'warn' ? 'Warn saves the closest repeat with a warning' : 'Block leaves the slot empty and fails'}`, async () => {
    const t = await setup()
    const settings = await import('../services/app-settings.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    const proxy = await withEmbeddings(t.service.baseUrl, text => /saffron/i.test(text) ? [1, 0] : [0, 1])
    try {
      await settings.setGenStudioUrl(proxy.url)
      clearGenStudioCatalogCache()
      await t.pm.updateConfig(t.project.slug, {
        idea_upgrades: { semantic_dedupe: 'on', embedding_model: 'emb::test', semantic_threshold: 0.9 },
        safety_checks: { idea_repeat: mode },
      } as any)
      const reworded = { ...idea('A Crimson Fortune on the Malabar Coast'), logline: 'How saffron crocus threads crossed the sea.' }
      for (let call = 0; call < 4; call++) t.service.queueScenario('chat', { outputText: JSON.stringify({ ideas: [reworded] }) })
      const run = t.job(`meaning-short-${mode}`)
      if (mode === 'block') {
        await assert.rejects(t.generateIdeaCampaign(run), /0 of 1 ideas were saved/)
      } else {
        await t.generateIdeaCampaign(run)
        assert.equal(run.result.completed, 1)
        assert.equal(run.result.safety_warnings?.[0]?.check, 'idea_repeat')
      }
      const saved = (await (await import('../services/idea-manager.js')).getIdeas(t.project.slug)).map(row => row.title)
      assert.equal(saved.includes(reworded.title), mode === 'warn')
    } finally {
      await proxy.close()
      await t.done()
    }
  })
}
