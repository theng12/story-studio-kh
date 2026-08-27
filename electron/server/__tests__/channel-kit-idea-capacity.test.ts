import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { contentPackDocumentToNiche, contentPackDocumentToTopicPack } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_PATH = path.join(ROOT, 'content-packs', 'authoring-registry.json')

// A Channel Kit is sold on the promise of 500-1,000 unique episode ideas. That promise is
// kept by the Topic Pack the kit pins, so a kit that pins a starter-sized Topic Pack ships a
// sample rather than a product. This table is the floor for the newest version of every kit
// lineage; a kit still below 500 is a named, visible gap, not a silent one.
const PROMISED_IDEAS = 500

const KIT_FLOORS: Array<[packId: string, floor: number, note?: string]> = [
  ['com.storystudio.pack.kit.wild-worlds', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.human-behavior', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.build-momentum', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.sleep-journeys', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.calm-mind', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.first-humans', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.a-life-as', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.history-explained', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.deep-time', PROMISED_IDEAS],
  ['com.storystudio.pack.kit.business-explained', PROMISED_IDEAS],
  // Below: kits still pinned to a starter-sized Topic Pack. The number is what the kit
  // actually delivers today. Raise it to PROMISED_IDEAS as each successor lands; never
  // lower one, and never delete a row to make this test pass.
  //
  // 2026-08-27 — both were investigated and both are BLOCKED, not merely unstarted. A
  // full-sized successor Topic Pack does sit in the registry for each, and repinning
  // either kit to it is a two-line change, so it is worth writing down why that change
  // must not be made yet:
  //
  //   archival-ledger  — money-debt-financial-institutions 1.0.1 plans 1,000 ideas, but
  //     46 of its 100 subjects fall below the anti-padding scope-diversity floor of 19
  //     (worst subject: 10 distinct settings across its 20 tuples). It reaches 1,000 the
  //     way habits-momentum 1.0.1 did, which the owner rejected. It is also one of
  //     sixteen successors bound to a single atomic coordinator receipt, so it cannot be
  //     advanced to `authored` on its own. See topic-pack-anti-padding.test.ts and
  //     topic-pack-1000-successors.test.ts, which both fail the moment the kit repins.
  //
  //   symbolic-psychology-studio — its 1.0.1 successor sources are held behind a returned
  //     preview-evidence gate with `registry_transition_allowed: false`. See
  //     symbolic-psychology-studio-wave-1-source.test.ts.
  ['com.storystudio.pack.kit.symbolic-psychology-studio', 10, 'six-piece kit governed by its own wave plan'],
  ['com.storystudio.pack.kit.archival-ledger', 100, 'paid kit; its five Topic Pack successors are owner work in progress'],
]

type Record_ = {
  pack_id: string
  version: string
  kind: string
  source_path: string
  status: string
  dependencies: Array<{ pack_id: string, version: string }>
}

function newerVersion(left: string, right: string): boolean {
  const l = left.split('.').map(Number)
  const r = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((l[index] || 0) !== (r[index] || 0)) return (l[index] || 0) > (r[index] || 0)
  }
  return false
}

async function loadDocument(record: Record_, kind: ContentPackDocument['kind']): Promise<ContentPackDocument> {
  const contentDir = path.join(ROOT, record.source_path, 'content')
  const entries = (await readdir(contentDir)).filter(name => name.endsWith('.json'))
  assert.equal(entries.length, 1, `${record.source_path} must hold exactly one content document`)
  return parseContentPackDocument(kind, JSON.parse(await readFile(path.join(contentDir, entries[0]!), 'utf8')))
}

function measureCapacity(niche: unknown, seed: string, ceiling: number): number {
  let low = 1
  let high = ceiling
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    let planned = 0
    try {
      planned = planIdeaAssignments({ niche, count: middle, seed } as never).slice(0, middle).length
    } catch {
      planned = 0
    }
    if (planned >= middle) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

test('every Channel Kit lineage keeps the idea capacity its newest version promises', async () => {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as { records: Record_[] }
  const byIdentity = new Map(registry.records.map(record => [`${record.pack_id}@${record.version}`, record]))

  const newest = new Map<string, Record_>()
  for (const record of registry.records) {
    if (record.kind !== 'channel-kit') continue
    const current = newest.get(record.pack_id)
    if (!current || newerVersion(record.version, current.version)) newest.set(record.pack_id, record)
  }

  assert.deepEqual(
    [...newest.keys()].sort(),
    KIT_FLOORS.map(([packId]) => packId).sort(),
    'every Channel Kit lineage must declare an idea-capacity floor; a new kit needs a row here',
  )

  for (const [packId, floor, note] of KIT_FLOORS) {
    const kit = newest.get(packId)!
    const components = kit.dependencies.map(dependency => byIdentity.get(`${dependency.pack_id}@${dependency.version}`)!)
    const formulaRecord = components.find(record => record?.kind === 'series-formula')
    const topicRecord = components.find(record => record?.kind === 'topic-pack')
    assert.ok(formulaRecord, `${packId}@${kit.version} must pin a Series Formula`)
    assert.ok(topicRecord, `${packId}@${kit.version} must pin a Topic Pack`)

    const formula = await loadDocument(formulaRecord, 'series-formula')
    const topic = await loadDocument(topicRecord, 'topic-pack')
    assert.equal(formula.kind, 'series-formula')
    assert.equal(topic.kind, 'topic-pack')

    const niche = contentPackDocumentToNiche(formula)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(topic)]
    const measured = measureCapacity(niche, `channel-kit-idea-capacity:${packId}@${kit.version}`, 1_000)

    assert.ok(
      measured >= floor,
      `${packId}@${kit.version} plans only ${measured} unique ideas from ${topicRecord.pack_id}@${topicRecord.version}, below its declared floor of ${floor}${note ? ` (${note})` : ''}`,
    )
    assert.ok(
      measured <= floor || floor === PROMISED_IDEAS,
      `${packId}@${kit.version} now plans ${measured} ideas; raise its floor toward ${PROMISED_IDEAS} rather than leaving the gap recorded as ${floor}`,
    )
  }
})

// The owner's rule, unchanged since the kits went on sale: a Channel Kit is exactly four
// pieces at 1,200 credits — one Series Formula, one Topic Pack, one Visual Style, one
// Thumbnail Recipe. Anything extra is split out and sold on its own at 300 credits; there
// is no such thing as a five-piece Kit. Symbolic Psychology Studio 1.0.0 shipped six for
// months without anything noticing, because the registry's own validator only checks that
// each of the four kinds is PRESENT, never that nothing else rode along. This checks the
// count and the shape, so the next surplus component is caught the day it is pinned.
const KIT_PIECES = ['series-formula', 'topic-pack', 'visual-style', 'thumbnail-recipe'] as const

// The one lineage that breaks the rule today, recorded at what it actually pins rather
// than at what it should. Symbolic Psychology Studio 1.0.0 bundles two extra Visual
// Styles; both are already registered as standalone packs with their own family and SKU,
// so the repair is to drop them from the Kit's dependency closure — which is part of the
// 1.0.1 wave held behind that lineage's preview-evidence gate. Never add a row here to
// make a new kit pass; a five-piece Kit is the defect this test exists to catch.
const EXTRA_PIECES: Record<string, readonly string[]> = {
  'com.storystudio.pack.kit.symbolic-psychology-studio': ['visual-style', 'visual-style'],
}

test('every Channel Kit lineage ships exactly four pieces, one of each kind', async () => {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as { records: Record_[] }
  const byIdentity = new Map(registry.records.map(record => [`${record.pack_id}@${record.version}`, record]))

  const newest = new Map<string, Record_>()
  for (const record of registry.records) {
    if (record.kind !== 'channel-kit') continue
    const current = newest.get(record.pack_id)
    if (!current || newerVersion(record.version, current.version)) newest.set(record.pack_id, record)
  }
  assert.ok(newest.size > 0, 'the registry must hold at least one Channel Kit')

  for (const [packId, kit] of newest) {
    const kinds = kit.dependencies.map(dependency => byIdentity.get(`${dependency.pack_id}@${dependency.version}`)?.kind)
    const allowed = [...KIT_PIECES, ...(EXTRA_PIECES[packId] ?? [])]
    assert.deepEqual(
      [...kinds].sort(),
      allowed.sort(),
      `${packId}@${kit.version} pins ${kinds.length} components (${kinds.join(', ')}); a Channel Kit is `
      + 'exactly four pieces — one Formula, one Topic Pack, one Style, one Thumbnail Recipe. Sell the '
      + 'surplus separately at 300 credits instead of bundling it.',
    )
  }
})
