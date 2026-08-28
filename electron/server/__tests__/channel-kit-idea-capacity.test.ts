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
  // Measured at 1,000 rather than PROMISED_IDEAS because that is what it actually plans:
  // states-revolutions-collapse 1.0.1 carries 100 subjects x 20 authored tuples, so its
  // structural capacity is 2,000 and it saturates this test's 1,000 ceiling.
  ['com.storystudio.pack.kit.archival-ledger', 1_000],
  ['com.storystudio.pack.kit.symbolic-psychology-studio', PROMISED_IDEAS],
  // Every kit lineage now clears the promise. If a future kit does not, add it below with
  // the number it actually delivers today, and raise that number as its successor lands;
  // never lower one, and never delete a row to make this test pass.
  //
  // 2026-08-28 — archival-ledger and symbolic-psychology-studio were both RESOLVED on this
  // date and moved up into the block above. archival-ledger had been recorded as blocked
  // because the only full-sized successor then available was
  // money-debt-financial-institutions 1.0.1, which reached 1,000 the padded way the owner
  // rejected; it instead repinned at 1.0.3 to its own long-standing topic,
  // states-revolutions-collapse 1.0.1. symbolic-psychology-studio had been recorded as
  // blocked behind a returned preview-evidence gate; that gate is satisfied, and its
  // 1.0.1 successor drops the two surplus Styles and repins the Topic Pack to 1.0.1,
  // taking it from 10 planned ideas to 1,000.
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

// 2026-08-28 — the EXTRA_PIECES allowance is GONE, and nothing replaces it. It existed for
// exactly one lineage: Symbolic Psychology Studio 1.0.0 bundled two surplus Visual Styles.
// Its 1.0.1 successor drops both from the Kit's dependency closure, and each is already a
// standalone pack with its own family and SKU, so every lineage now satisfies the rule
// outright. Do not reintroduce an allowance to make a new kit pass — a five-piece Kit is
// the defect this test exists to catch.

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
    assert.deepEqual(
      [...kinds].sort(),
      [...KIT_PIECES].sort(),
      `${packId}@${kit.version} pins ${kinds.length} components (${kinds.join(', ')}); a Channel Kit is `
      + 'exactly four pieces — one Formula, one Topic Pack, one Style, one Thumbnail Recipe. Sell the '
      + 'surplus separately at 300 credits instead of bundling it.',
    )
  }
})
