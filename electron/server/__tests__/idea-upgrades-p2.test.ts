/**
 * 1.4.293 idea upgrades, phases 2 and 3: more variety per batch (#4), self-growing Topic Packs
 * (#3) and real sources from Wikipedia (#5). Fake helper models, fake embedders and a fake
 * fetch — no network, no paid call.
 *
 * Cannot catch: how good the subjects a real helper model proposes are, whether a real Wikipedia
 * category is on-brand, or how the Ideas page lays the grown list out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { renderRealSubjectsBlock, renderVarietyBlock, varietySlots } from '../services/freeform-idea-generation.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'
import { keepArticle, WIKIPEDIA_USER_AGENT } from '../services/reference-pool.js'
import { mergeIdeaUpgrades, normalizeCategories, IDEA_UPGRADE_DEFAULTS } from '../services/idea-upgrades.js'
import type { Niche, TopicPack } from '../models/types.js'

// ── #4 variety ────────────────────────────────────────────────────────────────

test('variety slots: no era, region, theme or story type repeats inside a batch of 10', () => {
  const slots = varietySlots(10)
  for (const key of ['era', 'region', 'theme', 'type'] as const) {
    assert.equal(new Set(slots.map(slot => slot[key])).size, 10, key)
  }
  assert.ok(varietySlots(4, ['trade', 'war', 'famine', 'ritual']).every(slot => ['trade', 'war', 'famine', 'ritual'].includes(slot.theme)), 'the formula’s own themes win when it has enough')
  assert.match(renderVarietyBlock(slots), /^IDEA SLOTS — one per idea, in order[^\n]*\n1\. era=/)
  assert.equal(renderVarietyBlock([]), '', 'off = no block')
  assert.equal(renderRealSubjectsBlock([]), '')
})

function pack(id: string, subjects: string[]): TopicPack {
  return { id, name: id, description: '', builtin: false, schemaVersion: 1, compatibleNicheIds: [], subjects }
}

test('spreadPacks: subjects come round-robin across packs; same fingerprints; off keeps the old order', () => {
  const niche = {
    id: 'f', name: 'F', description: '', builtin: true, schemaVersion: 1, kind: 'series-formula', exampleTopics: [],
    activeTopicPacks: [pack('drinks', ['tea', 'coffee', 'mead']), pack('food', ['bread', 'rice', 'salt']), pack('objects', ['lamp', 'key', 'coin'])],
  } as unknown as Niche
  const usedFingerprints = planIdeaAssignments({ niche, count: 2, seed: 'old' }).slice(0, 2).map(row => row.fingerprint) // tea, coffee used
  const plain = planIdeaAssignments({ niche, count: 6, usedFingerprints, seed: 's' })
  const spread = planIdeaAssignments({ niche, count: 6, usedFingerprints, seed: 's', spreadPacks: true })
  assert.deepEqual(plain.slice(0, 3).map(row => row.dimensions.subject), ['mead', 'bread', 'rice'], 'pack by pack')
  assert.deepEqual(spread.slice(0, 3).map(row => row.topic_pack_id), ['drinks', 'food', 'objects'], 'every pack before any second subject')
  assert.deepEqual(spread.slice(0, 7).map(row => row.dimensions.subject), ['mead', 'bread', 'lamp', 'rice', 'key', 'salt', 'coin'])
  assert.deepEqual(new Set(spread.map(row => row.fingerprint)), new Set(plain.map(row => row.fingerprint)))
})

// ── settings ──────────────────────────────────────────────────────────────────

test('new switches are off by default; categories are normalised and validated', () => {
  assert.equal(IDEA_UPGRADE_DEFAULTS.variety_seeds, false)
  assert.equal(IDEA_UPGRADE_DEFAULTS.grow_packs, false)
  assert.equal(IDEA_UPGRADE_DEFAULTS.real_sources, false)
  assert.deepEqual(IDEA_UPGRADE_DEFAULTS.reference_categories, [])
  assert.deepEqual(normalizeCategories(['spices', 'Category:Spices', ' category: Ancient Roman roads ', 7]), ['Category:Spices', 'Category:Ancient Roman roads'])
  assert.equal(mergeIdeaUpgrades({ ...IDEA_UPGRADE_DEFAULTS }, { reference_categories: 'Spices' }), 'reference_categories: a list of Wikipedia category names.')
  const merged = mergeIdeaUpgrades({ ...IDEA_UPGRADE_DEFAULTS }, { grow_packs: true, reference_categories: ['Teas'] })
  assert.ok(typeof merged === 'object' && merged.grow_packs && merged.reference_categories[0] === 'Category:Teas')
})

// ── #5 reference pool ─────────────────────────────────────────────────────────

function wikiPage(title: string, extra: Record<string, unknown> = {}) {
  return { ns: 0, title, description: `about ${title}`, ...extra }
}

function fakeWikipedia(pages: unknown[], options: { failFirst?: number; failAll?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  let failures = options.failFirst || 0
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers })
    if (options.failAll || failures-- > 0) return new Response('slow down', { status: 429 })
    return new Response(JSON.stringify({ query: { pages } }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

test('reference pool filters lists, disambiguation pages, other namespaces and the head article', () => {
  const category = 'Category:Spices'
  assert.equal(keepArticle(wikiPage('Saffron'), category), true)
  assert.equal(keepArticle(wikiPage('List of spices'), category), false)
  assert.equal(keepArticle(wikiPage('Mace (disambiguation)'), category), false)
  assert.equal(keepArticle(wikiPage('Pepper', { pageprops: { disambiguation: '' } }), category), false)
  assert.equal(keepArticle(wikiPage('Spice'), category), false)
  assert.equal(keepArticle({ ns: 14, title: 'Category:Chili peppers' }, category), false)
})

test('reference pool: no network without categories; polite, cached, backs off on 429, falls back to the cache', async () => {
  const temp = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const { getReferencePool } = await import('../services/reference-pool.js')
    const project = await pm.createProject({ name: 'Reference pool' })
    const never = (async () => { throw new Error('no network expected') }) as unknown as typeof fetch
    const none = await getReferencePool(project.slug, [], { deps: { fetch: never } })
    assert.equal(none.pool, null)
    assert.match(none.note, /nothing fetched/)

    let clock = 1_000_000
    const sleeps: number[] = []
    const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); clock += ms } })
    const wiki = fakeWikipedia([wikiPage('Saffron'), wikiPage('List of spices'), wikiPage('Nutmeg')], { failFirst: 1 })
    const first = await getReferencePool(project.slug, ['Category:Spices', 'Category:Teas'], { deps: deps(wiki.fetchImpl) })
    assert.deepEqual(first.pool!.items.map(item => [item.title, item.category, item.url]), [
      ['Saffron', 'Category:Spices', 'https://en.wikipedia.org/wiki/Saffron'],
      ['Nutmeg', 'Category:Spices', 'https://en.wikipedia.org/wiki/Nutmeg'],
    ], 'provenance kept; the same article from a second category is not repeated')
    assert.equal(wiki.calls.length, 3, '429 retried once, then one request per category')
    assert.ok(sleeps.some(ms => ms >= 2000), 'backed off after the 429')
    assert.ok(sleeps.filter(ms => ms < 2000).every(ms => ms <= 1000) && sleeps.length >= 2, 'at most one request a second')
    for (const call of wiki.calls) {
      assert.equal(call.headers['User-Agent'], WIKIPEDIA_USER_AGENT)
      assert.ok(call.url.startsWith('https://en.wikipedia.org/w/api.php?'))
    }
    assert.doesNotMatch(WIKIPEDIA_USER_AGENT, /@|mailto|vengtheng|fannv/i, 'no personal data in the User-Agent')

    const cached = await getReferencePool(project.slug, ['Category:Teas', 'Category:Spices'], { deps: deps(never) })
    assert.equal(cached.fetched, false)
    assert.match(cached.note, /cached/)

    const down = fakeWikipedia([], { failAll: true })
    const fallback = await getReferencePool(project.slug, ['Category:Spices'], { force: true, deps: deps(down.fetchImpl) })
    assert.equal(fallback.pool!.items.length, 2, 'Wikipedia down: the cached list is used')
    assert.match(fallback.note, /not reachable .* using the cached list/)
  } finally {
    await temp.cleanup()
  }
})

// ── #3 grown packs ────────────────────────────────────────────────────────────

async function growSetup() {
  const temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const loader = await import('../services/topic-pack-loader.js')
  const grow = await import('../services/topic-pack-grow.js')
  const grownPack = await import('../services/grown-pack.js')
  const supply = await import('../services/idea-supply.js')
  const settings = await import('../services/app-settings.js')
  await loader.ensureTopicPacksDir()
  const original = { id: 'drinks-test', name: 'Drinks', description: 'Drinks through history', schemaVersion: 1, compatibleNicheIds: [], subjects: ['Tea', 'Coffee', 'Mead'] }
  const originalFile = loader.topicPackFilePath(original.id)
  await fs.writeFile(originalFile, JSON.stringify(original))
  const project = await pm.createProject({ name: `Grow ${Math.random().toString(36).slice(2, 7)}`, niche_id: 'history-narration' })
  await pm.updateProject(project.slug, { topic_pack_ids: [original.id] } as any)
  const set = (upgrades: Record<string, unknown>) => pm.updateConfig(project.slug, { idea_upgrades: { helper_model: 'helper::m', ...upgrades } } as any)
  const answer = (names: string[]) => ({ checkModel: async () => {}, callModel: async () => JSON.stringify({ subjects: names.map(name => ({ name, why_it_fits: 'fits' })) }) })
  const hash = () => createHash('sha256').update(readFileSync(originalFile)).digest('hex')
  return { temp, pm, grow, grownPack, supply, settings, project, set, answer, hash, originalFile, dir: pm.getProjectDir(project.slug)! }
}

test('idea helpers read live language for grown and covered text; category lookup keys stay English', async () => {
  const t = await growSetup()
  try {
    await t.set({ grow_packs: true })
    const covered = await import('../services/covered-topics.js')
    const { languageDirective } = await import('../lib/content-language.js')
    for (const [index, language] of (['km', 'en', null] as const).entries()) {
      await t.pm.updateProject(t.project.slug, { content_language: language })
      let growPrompt = ''
      const grown = await t.grow.growTopicPack(t.project.slug, {
        trigger: 'manual', deps: {
          checkModel: async () => {},
          callModel: async (_model, prompt) => {
            growPrompt = prompt
            return JSON.stringify({ subjects: [{ name: `New subject ${index}`, why_it_fits: 'Fits this channel' }] })
          },
        },
      })
      assert.equal(grown.added.length, 1)
      let mapPrompt = ''
      const result = await covered.updateCoveredMap({
        slug: t.project.slug, helperModel: 'helper::m', formulaId: 'history-narration',
        channelName: 'Language channel', history: [{ id: `history-${index}`, title: `Subject ${index}` }],
        deps: {
          checkModel: async () => {},
          callModel: async (_model, prompt) => {
            mapPrompt = prompt
            return JSON.stringify({ add: { subjects: [{ name: `Subject ${index}`, count: 1 }] } })
          },
        },
      })
      assert.equal(result.added, 1)
      for (const prompt of [growPrompt, mapPrompt]) {
        if (language) assert.ok(prompt.includes(languageDirective(language)))
        else assert.doesNotMatch(prompt, /audience-facing text/)
      }
      let categoryPrompt = ''
      const categories = await t.grow.suggestReferenceCategories(t.project.slug, {
        checkModel: async () => {},
        callModel: async (_model, prompt) => {
          categoryPrompt = prompt
          return JSON.stringify({ categories: ['Category:Spices'] })
        },
      })
      assert.deepEqual(categories, ['Category:Spices'])
      assert.match(categoryPrompt, /English Wikipedia category names/)
      assert.doesNotMatch(categoryPrompt, /audience-facing text/)
    }
  } finally {
    await t.temp.cleanup()
  }
})

test('grow: add-only into the channel’s own pack; originals untouched; .topic-packs backed up first', async () => {
  const t = await growSetup()
  try {
    await t.set({ grow_packs: true })
    const before = t.hash()
    const result = await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: t.answer(['Saffron Tea', 'tea', 'Kvass', 'X', 'Kvass']) })
    assert.deepEqual(result.added.map(entry => [entry.subject, entry.source, entry.model]), [['Saffron Tea', 'model', 'helper::m'], ['Kvass', 'model', 'helper::m']], 'existing, too short and repeated names are dropped')
    assert.equal(t.hash(), before, 'the original pack file is byte-identical')
    const pack = await t.grownPack.readGrownPack(t.project.slug)
    assert.deepEqual(pack!.subjects, ['Saffron Tea', 'Kvass'])
    assert.ok(readdirSync(path.join(t.dir, '_backups')).some(name => name.startsWith('topic-packs-')))
    const second = await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: t.answer(['Mate']) })
    assert.deepEqual(second.added.map(entry => entry.subject), ['Mate'])
    assert.deepEqual((await t.grownPack.readGrownPack(t.project.slug))!.subjects, ['Saffron Tea', 'Kvass', 'Mate'], 'add-only')
  } finally {
    await t.temp.cleanup()
  }
})

test('grow: a removed subject is never added again; an empty answer fails loudly and writes nothing', async () => {
  const t = await growSetup()
  try {
    await t.set({ grow_packs: true })
    await assert.rejects(t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: t.answer([]) }), (error: any) => error.statusCode === 422 && /nothing was added/.test(error.message))
    assert.equal(await t.grownPack.readGrownPack(t.project.slug), null, 'no file written')
    await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: t.answer(['Kvass', 'Mate']) })
    await t.grownPack.rejectGrownSubject(t.project.slug, 'kvass')
    const pack = await t.grownPack.readGrownPack(t.project.slug)
    assert.deepEqual(pack!.subjects, ['Mate'])
    assert.deepEqual(pack!.grown.rejected.map(row => row.subject), ['Kvass'])
    const again = await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: t.answer(['Kvass', 'Sbiten']) })
    assert.deepEqual(again.added.map(entry => entry.subject), ['Sbiten'])
  } finally {
    await t.temp.cleanup()
  }
})

test('grow: same-meaning subjects are left out when an embeddings model is set; a down model never substitutes', async () => {
  const t = await growSetup()
  try {
    await t.set({ grow_packs: true, embedding_model: 'emb::m' })
    const embed = async (texts: string[]) => texts.map(text => /tea/i.test(text) ? [1, 0, 0] : /kvass/i.test(text) ? [0, 0, 1] : [0, 1, 0])
    const result = await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: { ...t.answer(['Green Tea Ceremony', 'Kvass']), embed } })
    assert.deepEqual(result.added.map(entry => entry.subject), ['Kvass'])
    assert.ok(result.notes.some(note => /same thing as an existing subject/.test(note)))
    await assert.rejects(
      t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: { checkModel: async () => { throw new Error('gone') }, callModel: async () => { throw new Error('must not be called') } } }),
      (error: any) => error.statusCode === 503 && /helper::m" is not available/.test(error.message),
    )
  } finally {
    await t.temp.cleanup()
  }
})

test('grow with real sources: only Wikipedia candidates are kept, with their category and link', async () => {
  const t = await growSetup()
  try {
    await t.pm.updateProject(t.project.slug, { content_language: 'km' })
    await t.set({ grow_packs: true, real_sources: true, reference_categories: ['Category:Russian drinks'] })
    const wiki = fakeWikipedia([wikiPage('Kvass'), wikiPage('Sbiten'), wikiPage('Tea')])
    let prompt = ''
    const deps = {
      checkModel: async () => {},
      callModel: async (_model: string, text: string) => { prompt = text; return JSON.stringify({ subjects: [{ name: 'kvass' }, { name: 'Invented Drink' }] }) },
      referenceDeps: { fetch: wiki.fetchImpl, sleep: async () => {} },
    }
    const result = await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps })
    assert.match(prompt, /CANDIDATES FROM WIKIPEDIA — choose ONLY from these/)
    assert.match(prompt, /Write ALL audience-facing text in Khmer/)
    assert.match(prompt, /copy name unchanged; write why_it_fits in the channel language/)
    assert.doesNotMatch(prompt, /- Tea —/, 'an existing subject is not offered as a candidate')
    assert.deepEqual(result.added.map(entry => [entry.subject, entry.source, entry.source_url]), [['Kvass', 'wikipedia:Category:Russian drinks', 'https://en.wikipedia.org/wiki/Kvass']])
    assert.ok(result.notes.some(note => /not on the Wikipedia list/.test(note)))
  } finally {
    await t.temp.cleanup()
  }
})

test('grown pack counts only while the switch is on; auto-grow runs once a day and stops after three weak runs', async () => {
  const t = await growSetup()
  try {
    await t.set({ grow_packs: true, low_unused_subjects: 30 })
    await t.grow.growTopicPack(t.project.slug, { trigger: 'manual', deps: t.answer(['Kvass', 'Mate']) })
    const on = await t.supply.computeIdeaSupply(t.project.slug)
    assert.equal(on!.unused_subjects.kind === 'measured' && on!.unused_subjects.total, 5)
    await t.set({ grow_packs: false })
    const off = await t.supply.computeIdeaSupply(t.project.slug)
    assert.equal(off!.unused_subjects.kind === 'measured' && off!.unused_subjects.total, 3, 'switch off: the grown file is ignored')

    await t.set({ grow_packs: true, low_unused_subjects: 30 })
    const sent: string[] = []
    const send = async (payload: { title: string }) => { sent.push(payload.title) }
    const today = new Date()
    assert.deepEqual(await t.grow.runAutoGrow(send, today, undefined, t.answer(['Sbiten'])), [], 'already ran today (the manual run counts)')

    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    await t.settings.setAppSetting('idea_grow_runs', { [t.project.slug]: { runs: [{ at: day(3), trigger: 'auto', added: 1 }, { at: day(2), trigger: 'auto', added: 0 }, { at: day(1), trigger: 'auto', added: 4 }] } })
    assert.deepEqual(await t.grow.runAutoGrow(send, today, undefined, t.answer(['Sbiten'])), [t.project.slug])
    assert.deepEqual(sent, [`${t.project.name}: stopped growing Topic Pack subjects`])
    await t.grow.runAutoGrow(send, today, undefined, t.answer(['Sbiten']))
    assert.equal(sent.length, 1, 'the stop is announced once')
    assert.equal((await t.grownPack.readGrownPack(t.project.slug))!.subjects.includes('Sbiten'), false)

    await t.settings.setAppSetting('idea_grow_runs', { [t.project.slug]: { runs: [{ at: day(1), trigger: 'auto', added: 12 }] } })
    await t.grow.runAutoGrow(send, today, undefined, t.answer(['Sbiten']))
    assert.match(sent.at(-1)!, /1 new Topic Pack subject$/)
    assert.equal(existsSync(t.originalFile), true)
  } finally {
    await t.temp.cleanup()
  }
})
