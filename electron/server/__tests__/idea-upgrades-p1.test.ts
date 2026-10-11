/**
 * 1.4.285 idea upgrades, phase 1: duplicate watch (#2), covered-topics map (#1), supply counter and
 * alerts (#6), per-channel settings. Fake embedders and helper models; no network.
 *
 * Cannot catch: how well a real embeddings model separates repeats (see the offline calibration
 * next to the plan), or how the Ideas page lays the banner out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { coreTitle, isTooSimilar, titleWrapperSegments, watchDuplicates } from '../services/idea-similarity.js'
import { mergeCovered, renderCoveredBlock, type CoveredMap } from '../services/covered-topics.js'
import { subjectUseByPack } from '../services/idea-campaign-planner.js'
import { IDEA_UPGRADE_DEFAULTS, mergeIdeaUpgrades, readIdeaUpgrades } from '../services/idea-upgrades.js'
import type { IdeaSupply } from '../services/idea-supply.js'

// ── #2 duplicate watch ────────────────────────────────────────────────────────

const SUFFIX = ' | Soothing Bedtime Adventures'
const pool = [
  { title: `The Lighthouse Keeper's Cat${SUFFIX}`, logline: 'A cat guards a lamp.' },
  { title: `A Lantern for the Snow Fox${SUFFIX}`, logline: 'A fox finds light.' },
  { title: `The Tea Merchant's Quiet Barge${SUFFIX}`, logline: 'A barge drifts upriver.' },
  { title: 'The Mystery of the Voynich Manuscript', logline: 'An unreadable book.' },
]

test('a shared channel title wrapper is not what makes two stories alike', () => {
  const wrappers = titleWrapperSegments(pool.map(item => item.title))
  assert.ok(wrappers.has('soothing bedtime adventures'))
  assert.equal(coreTitle(`The Orchard Owl${SUFFIX}`, wrappers), 'The Orchard Owl')
  assert.equal(coreTitle('Daily Prayer | Morning Peace', new Set(), 'Daily Prayer | '), 'Morning Peace')
})

test('watch-only word check: a new story that shares only the suffix is not flagged; a reworded repeat is', async () => {
  const fresh = { title: `The Orchard Owl Counts Stars${SUFFIX}`, logline: 'An owl counts stars over an orchard.' }
  const repeat = { title: 'The Lighthouse Keepers Cat', logline: 'A cat guards a lamp.' }
  const result = await watchDuplicates([fresh, repeat], pool, { threshold: 0.86 })
  assert.equal(result.method, 'words')
  assert.equal(result.fallback_reason, 'no embeddings model chosen')
  assert.deepEqual(result.hits.map(hit => hit.candidate.title), [repeat.title])
})

test('watch-only meaning check uses cosine against history and the earlier ideas of the batch', async () => {
  const vector = (text: string): number[] => /voynich/i.test(text) ? [1, 0, 0] : /owl/i.test(text) ? [0, 1, 0] : [0, 0, 1]
  let calls = 0
  const embed = async (texts: string[]) => { calls++; return texts.map(vector) }
  const cache = new Map<string, number[]>()
  const reworded = { title: 'Who Wrote the Voynich Codex?', logline: 'A cipher nobody reads.' }
  const owlA = { title: 'Owl Night', logline: 'An owl.' }
  const owlB = { title: 'Another Owl Night', logline: 'An owl again.' }
  const result = await watchDuplicates([reworded, owlA, owlB], pool, { embed, threshold: 0.9, vectorCache: cache })
  assert.equal(result.method, 'meaning')
  assert.deepEqual(result.hits.map(hit => [hit.candidate.title, hit.matched.title]), [
    [reworded.title, 'The Mystery of the Voynich Manuscript'],
    [owlB.title, owlA.title],
  ])
  assert.deepEqual(result.nearest.map(row => [row.candidate.title, row.score]), [
    [reworded.title, 1], [owlA.title, 0], [owlB.title, 1],
  ], 'every candidate carries its nearest score, kept or not')
  await watchDuplicates([owlA], pool, { embed, threshold: 0.9, vectorCache: cache })
  assert.equal(calls, 1, 'texts already embedded in this run are not sent again')
})

test('calibration fixture: the 0.78 default separates measured BGE paraphrases from different topics', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/idea-meaning-calibration.json', import.meta.url), 'utf8'))
  const threshold = IDEA_UPGRADE_DEFAULTS.semantic_threshold
  assert.equal(threshold, 0.78)
  const different = fixture.pairs.filter((pair: any) => pair.kind === 'different')
  const sameSubject = fixture.pairs.filter((pair: any) => pair.kind === 'paraphrase' && !/Bookbinder/.test(pair.a))
  assert.ok(different.length >= 4 && sameSubject.length >= 3)
  for (const pair of different) assert.ok(pair.score < threshold, `different topics stay under: ${pair.score}`)
  for (const pair of sameSubject) assert.ok(pair.score >= threshold, `a reworded subject is caught: ${pair.score}`)
  // Known miss, documented: two different Bookbinder stories score ~0.68 — same recurring character,
  // different story. The covered-topics map, not this check, is what stops that kind of repeat.
  assert.ok(fixture.pairs.some((pair: any) => /Bookbinder/.test(pair.a) && pair.kind === 'paraphrase' && pair.score < threshold))
})

test('an embeddings failure falls back to the improved word check and says why; nothing throws', async () => {
  const result = await watchDuplicates([{ title: 'The Lighthouse Keepers Cat', logline: 'A cat guards a lamp.' }], pool, {
    embed: async () => { throw new Error('NO_EMBEDDINGS_ENGINE: no Mac offers it') },
    threshold: 0.86,
  })
  assert.equal(result.method, 'words')
  assert.match(result.fallback_reason || '', /NO_EMBEDDINGS_ENGINE/)
  assert.equal(result.hits.length, 1)
})

test('the existing word filter is unchanged (it still flags the shared-suffix pair the watch ignores)', async () => {
  const owl = { title: `Owl${SUFFIX}` }
  const fox = { title: `Fox${SUFFIX}` }
  assert.equal(isTooSimilar(owl, fox), true)
  assert.equal((await watchDuplicates([owl], [fox, ...pool], { threshold: 0.86 })).hits.length, 0)
})

// ── #1 covered-topics map ─────────────────────────────────────────────────────

test('covered map merges by name and adds counts; render differs for freeform and pack channels', () => {
  let entries = mergeCovered({ subjects: [], people: [], places: [], eras: [], angles: [] }, {
    subjects: [{ name: 'Voynich manuscript', count: 2 }, { name: 'Roman roads' }], people: [{ name: 'Wilfrid Voynich' }],
  })
  entries = mergeCovered(entries, { subjects: [{ name: 'voynich manuscript', count: 1 }, { name: '  ' }], bogus: [{ name: 'x' }] })
  assert.deepEqual(entries.subjects, [{ name: 'Voynich manuscript', count: 3 }, { name: 'Roman roads', count: 1 }])
  const map: CoveredMap = { schema: 1, formula_id: 'f', helper_model: 'm', built_at: '', covered_idea_ids: [], entries }
  const freeform = renderCoveredBlock(map, 'freeform')
  assert.match(freeform, /COVERED SUBJECTS — never make another episode about any of these, even from a new angle:\nVoynich manuscript ×3; Roman roads/)
  assert.match(freeform, /People: Wilfrid Voynich/)
  const pack = renderCoveredBlock(map, 'pack')
  assert.match(pack, /within your assigned subject, pick a focus/)
  assert.doesNotMatch(pack, /never make another episode/)
  assert.equal(renderCoveredBlock(null, 'freeform'), '')
})

test('covered map: delta only, a helper failure keeps the map, an unavailable model is said plainly', async () => {
  const temp = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const { updateCoveredMap, readCoveredMap, trashCoveredMap } = await import('../services/covered-topics.js')
    const project = await pm.createProject({ name: 'Covered map' })
    const history = Array.from({ length: 160 }, (_, i) => ({ id: `idea-${i}`, title: `Title ${i}` }))
    const prompts: string[] = []
    const deps = {
      checkModel: async () => {},
      callModel: async (_model: string, prompt: string) => {
        prompts.push(prompt)
        return JSON.stringify({ add: { subjects: [{ name: 'Saffron', count: 1 }] } })
      },
    }
    const base = { slug: project.slug, helperModel: 'helper-x', formulaId: 'f', channelName: 'Covered', history, deps }
    const first = await updateCoveredMap(base)
    assert.equal(first.added, 160)
    assert.equal(prompts.length, 2, '150 ideas per helper call')
    assert.deepEqual(first.map!.entries.subjects, [{ name: 'Saffron', count: 2 }])

    const again = await updateCoveredMap(base)
    assert.equal(again.added, 0)
    assert.equal(prompts.length, 2, 'nothing already folded in is sent again')

    const failing = await updateCoveredMap({ ...base, history: [{ id: 'new-1', title: 'New' }, ...history], deps: { ...deps, callModel: async () => 'not json' } })
    assert.match(failing.note, /kept as it was/)
    assert.equal((await readCoveredMap(project.slug))!.covered_idea_ids.length, 160, 'the saved map is untouched')

    const missing = await updateCoveredMap({ ...base, history: [{ id: 'new-1', title: 'New' }], deps: { ...deps, checkModel: async () => { throw new Error('gone') } } })
    assert.match(missing.note, /Idea helper model "helper-x" is not available/)

    const trashed = await trashCoveredMap(project.slug)
    assert.ok(trashed && trashed.includes(`${path.sep}_trash${path.sep}`))
    assert.equal(await readCoveredMap(project.slug), null)
    assert.ok(JSON.parse(await fs.readFile(trashed!, 'utf8')).entries, 'the old map is kept in _trash')
  } finally {
    await temp.cleanup()
  }
})

// ── #6 supply ─────────────────────────────────────────────────────────────────

test('unused subjects per pack come from the planner fingerprints, and 0 is a real 0', () => {
  const niche: any = {
    id: 'formula', name: 'F', activeTopicPacks: [
      { id: 'drinks', name: 'Drinks', subjects: ['Tea', 'Coffee', 'Cocoa'] },
      { id: 'food', name: 'Food', subjects: ['Bread'] },
    ],
  }
  const used = [
    'formula|drinks|coverage-angle=origin|subject=tea',
    'formula|drinks|subject=coffee-beans', // a different subject that only starts the same
    'formula|food|subject=bread',
    'other-formula|drinks|subject=cocoa',
  ]
  assert.deepEqual(subjectUseByPack(niche, used), [
    { id: 'drinks', name: 'Drinks', unused: 2, total: 3 },
    { id: 'food', name: 'Food', unused: 0, total: 1 },
  ])
})

test('supply for a freeform channel: subjects are not-applicable, never 0; waiting and pace are counted', async () => {
  const temp = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const im = await import('../services/idea-manager.js')
    const { computeIdeaSupply } = await import('../services/idea-supply.js')
    const project = await pm.createProject({ name: 'Freeform supply', niche_id: 'history-narration' })
    const ideas = await im.addIdeas(project.slug, Array.from({ length: 4 }, (_, i) => ({
      title: `Idea ${i}`, logline: 'l', themes: [], suggested_chapters: 5, suggested_length: '30 min', mood: '',
    })), 'manual')
    for (const idea of ideas.slice(0, 3)) await im.acceptIdea(project.slug, idea.id, false)
    const supply = (await computeIdeaSupply(project.slug))!
    assert.equal(supply.mode, 'freeform')
    assert.equal(supply.unused_subjects.kind, 'not-applicable')
    assert.equal(supply.waiting_ideas, 1)
    assert.equal(supply.accepted_last_30d, 3)
    assert.equal(supply.days_left, 10)
    assert.equal(supply.status, 'low', '10 days is under the 14-day default')
    assert.equal(supply.supply_alerts, false, 'alerts are off by default')

    const none = await pm.createProject({ name: 'No formula' })
    const noFormula = (await computeIdeaSupply(none.slug))!
    assert.equal(noFormula.mode, 'no-formula')
    assert.equal(noFormula.status, 'ok', 'an empty manual channel is not "out of ideas"')
  } finally {
    await temp.cleanup()
  }
})

test('alerts: opt-in only, only when the status gets worse, at most once per channel per day', async () => {
  const temp = await useTempDataDir()
  try {
    const { runIdeaSupplyAlerts } = await import('../services/idea-supply.js')
    const row = (slug: string, status: IdeaSupply['status'], supply_alerts = true): IdeaSupply => ({
      slug, name: slug, mode: 'freeform', unused_subjects: { kind: 'not-applicable', reason: '' }, ignored_packs: [],
      waiting_ideas: 0, accepted_last_30d: 0, days_left: null, status, reasons: ['r'], thresholds: { low_unused_subjects: 30, low_days_of_ideas: 14 }, supply_alerts,
    })
    const sent: string[] = []
    const send = async (payload: { title: string }) => { sent.push(payload.title) }
    const day1 = new Date(2026, 9, 11, 9)
    const day2 = new Date(2026, 9, 12, 9)
    assert.deepEqual(await runIdeaSupplyAlerts(send, day1, [row('a', 'low'), row('b', 'low', false), row('c', 'ok')]), ['a'])
    assert.deepEqual(await runIdeaSupplyAlerts(send, day1, [row('a', 'empty')]), [], 'not twice on one day')
    assert.deepEqual(await runIdeaSupplyAlerts(send, day2, [row('a', 'low')]), [], 'no repeat while it stays low')
    assert.deepEqual(await runIdeaSupplyAlerts(send, day2, [row('a', 'empty')]), ['a'], 'low → empty on a new day')
    assert.deepEqual(await runIdeaSupplyAlerts(send, day2, [row('a', 'ok')]), [])
    assert.deepEqual(await runIdeaSupplyAlerts(send, new Date(2026, 9, 13, 9), [row('a', 'low')]), ['a'], 'ok → low again')
    assert.equal(sent.length, 3)
    assert.match(sent[0]!, /a: ideas are running low/)
  } finally {
    await temp.cleanup()
  }
})

// ── settings ──────────────────────────────────────────────────────────────────

test('every switch is off by default; "on" for the meaning check is refused in this release', () => {
  assert.deepEqual(readIdeaUpgrades({}), IDEA_UPGRADE_DEFAULTS)
  assert.deepEqual(readIdeaUpgrades({ idea_upgrades: { covered_map: 'yes', semantic_dedupe: 'on' } }), IDEA_UPGRADE_DEFAULTS)
  assert.match(String(mergeIdeaUpgrades(IDEA_UPGRADE_DEFAULTS, { semantic_dedupe: 'on' })), /watch-only/)
  assert.match(String(mergeIdeaUpgrades(IDEA_UPGRADE_DEFAULTS, { nope: true })), /not an idea upgrade setting/)
  assert.match(String(mergeIdeaUpgrades(IDEA_UPGRADE_DEFAULTS, { semantic_threshold: 2 })), /out of range/)
  const merged = mergeIdeaUpgrades(IDEA_UPGRADE_DEFAULTS, { covered_map: true, helper_model: ' anthropic-direct::claude-haiku-5-5 ' })
  assert.equal(typeof merged, 'object')
  assert.equal((merged as any).helper_model, 'anthropic-direct::claude-haiku-5-5')
  assert.equal((merged as any).semantic_dedupe, 'off', 'untouched fields keep their value')
})

test('settings route: partial update, one-time backup on the first switch, readable back', async () => {
  const temp = await useTempDataDir()
  try {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const pm = await import('../services/project-manager.js')
    const { router } = await import('../routes/ideas.js')
    const app = express().use(express.json()).use(router)
    const project = await pm.createProject({ name: 'Upgrade settings' })
    const off = await request(app).get(`/projects/${project.slug}/ideas/upgrades`)
    assert.deepEqual(off.body.settings, IDEA_UPGRADE_DEFAULTS)
    const on = await request(app).put(`/projects/${project.slug}/ideas/upgrades`).send({ semantic_dedupe: 'shadow', supply_alerts: true })
    assert.equal(on.status, 200, JSON.stringify(on.body))
    assert.ok(on.body.backup_dir)
    assert.ok((await fs.readdir(on.body.backup_dir)).includes('config.json'))
    const again = await request(app).put(`/projects/${project.slug}/ideas/upgrades`).send({ low_days_of_ideas: 7 })
    assert.equal(again.body.backup_dir, null, 'only the first switch-on backs up')
    assert.deepEqual({ ...again.body.settings }, { ...IDEA_UPGRADE_DEFAULTS, semantic_dedupe: 'shadow', supply_alerts: true, low_days_of_ideas: 7 })
    assert.equal((await request(app).put(`/projects/${project.slug}/ideas/upgrades`).send({ semantic_dedupe: 'on' })).status, 400)
    const supply = await request(app).get(`/projects/${project.slug}/ideas/supply`)
    assert.equal(supply.status, 200)
    assert.equal(supply.body.supply_alerts, true)

    // Import paths: watch-only — the repeat is reported, and still saved.
    const first = await request(app).post(`/projects/${project.slug}/ideas`).send({ title: 'The Mystery of the Voynich Manuscript', logline: 'An unreadable book.' })
    assert.deepEqual(first.body.duplicate_watch.would_reject, [])
    const repeat = await request(app).post(`/projects/${project.slug}/ideas`).send({ title: 'The Mystery of the Voynich Manuscript Explained', logline: 'An unreadable book.' })
    assert.equal(repeat.status, 200)
    assert.equal(repeat.body.duplicate_watch.method, 'words')
    assert.equal(repeat.body.duplicate_watch.would_reject.length, 1)
    const pasted = await request(app).post(`/projects/${project.slug}/ideas/import-paste`).send({ json: JSON.stringify([
      { title: 'Voynich Manuscript Mystery', logline: 'An unreadable book.', themes: ['cipher'], suggested_chapters: 5, suggested_length: '30 min', mood: 'calm' },
    ]) })
    assert.equal(pasted.body.imported, 1)
    assert.equal(pasted.body.duplicate_watch.would_reject.length, 1)
    const im = await import('../services/idea-manager.js')
    assert.equal((await im.getIdeas(project.slug)).length, 3, 'nothing was rejected')
    const stats = (await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'idea-campaign-stats.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(stats.map(line => [line.kind, line.source, line.shadow_would_reject]), [['import', 'manual', 0], ['import', 'manual', 1], ['import', 'paste-import', 1]])

    await request(app).put(`/projects/${project.slug}/ideas/upgrades`).send({ semantic_dedupe: 'off' })
    const quiet = await request(app).post(`/projects/${project.slug}/ideas`).send({ title: 'The Mystery of the Voynich Manuscript' })
    assert.equal('duplicate_watch' in quiet.body, false, 'off means no check at all')
  } finally {
    await temp.cleanup()
  }
})

test('meaning watch through the Gateway embeddings route: Authorization only, nearest score reported, 503 falls back', async () => {
  const temp = await useTempDataDir()
  const http = await import('node:http')
  const seen: Array<{ path: string; headers: Record<string, unknown>; body: any }> = []
  let down = false
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      seen.push({ path: req.url || '', headers: req.headers, body })
      if (down) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'NO_EMBEDDINGS_ENGINE', detail: 'No Mac offers it' })); return }
      const vector = (text: string) => /voynich/i.test(text) ? [0.8, 0.6, 0] : [0, 0, 1]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: body.input.map((text: string, index: number) => ({ object: 'embedding', index, embedding: vector(text) })) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const settings = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const pm = await import('../services/project-manager.js')
    const { watchImportedIdeas } = await import('../generators/idea-campaign.js')
    await settings.setGenStudioUrl(`http://127.0.0.1:${(server.address() as any).port}`)
    await setApiKey('genstudio', 'gsk_test_embeddings')
    const project = await pm.createProject({ name: 'Meaning watch' })
    await pm.updateConfig(project.slug, { idea_upgrades: { semantic_dedupe: 'shadow', embedding_model: 'studio-hub::bge-test' } } as any)
    const im = await import('../services/idea-manager.js')
    await im.addIdeas(project.slug, [{ title: 'The Voynich Manuscript', logline: 'An unreadable book.', themes: [], suggested_chapters: 5, suggested_length: '30 min', mood: '' }], 'manual')

    const result = (await watchImportedIdeas(project.slug, 'manual', [{ title: 'Who Wrote the Voynich Codex?', logline: 'A cipher.' }, { title: 'Glass of Murano', logline: 'Venetian glass.' }]))!
    assert.equal(result.method, 'meaning')
    assert.equal(result.threshold, 0.78)
    assert.deepEqual(result.nearest.map(row => [row.title, row.matched, row.score]), [
      ['Who Wrote the Voynich Codex?', 'The Voynich Manuscript', 1],
      ['Glass of Murano', 'The Voynich Manuscript', 0],
    ])
    assert.equal(result.would_reject.length, 1)
    const call = seen.find(row => row.path === '/v1/embeddings')!
    assert.equal(call.body.model, 'studio-hub::bge-test')
    assert.equal(call.headers.authorization, 'Bearer gsk_test_embeddings')
    assert.equal(call.headers['x-caller'], undefined, 'no machine or owner name leaves with the texts')

    down = true
    const fallback = (await watchImportedIdeas(project.slug, 'manual', [{ title: 'The Voynich Manuscript Again', logline: 'An unreadable book.' }]))!
    assert.equal(fallback.method, 'words')
    assert.match(fallback.fallback_reason || '', /NO_EMBEDDINGS_ENGINE/)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await temp.cleanup()
  }
})
