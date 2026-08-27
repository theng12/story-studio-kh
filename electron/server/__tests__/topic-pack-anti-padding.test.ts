import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseContentPackDocument } from '../content-packs/schemas.js'
import type { ContentPackDocument } from '../content-packs/types.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_PATH = path.join(ROOT, 'content-packs', 'authoring-registry.json')

// A Channel Kit sells 500-1,000 UNIQUE episode ideas. Counting to 1,000 is easy; a generator
// can do it by holding one setting fixed for a subject and varying a slot in a sentence
// template. That is what habits-momentum 1.0.1 did, and it passed a human review, so the
// guard has to be a measurement rather than a reading.
//
// Three numbers separate an authored pack from a generated one:
//   scopeDiversity  - how many of a subject's 20 tuples happen at a different moment/place.
//                     A generator reuses one; an author writes twenty.
//   affixShare      - the largest share of one axis that opens or closes with the same four
//                     words. A template shows up here immediately.
//   subjectEchoShare- how often the subject's own name is glued into an episode object or
//                     mechanism. Prose that mentions the subject is fine; a fixed tag whose
//                     only job is to defeat a uniqueness check is not.
//
// Only Topic Packs pinned by the NEWEST version of a Channel Kit are measured: those are the
// ones being sold. A superseded pack drops out of scope on its own when the kit is re-pinned.
//
// Every row is a floor (or a ceiling) that the pack meets TODAY. Raise a number when a pack
// improves; never lower one to make this pass, and never delete a row.
type Bar = { minScopeDiversity: number, maxAffixShare: number, maxSubjectEchoShare: number, note?: string }

const DEFAULT_BAR: Bar = { minScopeDiversity: 19, maxAffixShare: 0.05, maxSubjectEchoShare: 0.05 }

const BARS: Record<string, Bar> = {
  // Named, visible gaps. Both predate this guard and are recorded at what they actually
  // measure, not at what we would like them to measure.
  'com.storystudio.pack.topic.night-journeys': {
    minScopeDiversity: 1,
    maxAffixShare: 0.15,
    maxSubjectEchoShare: 0.05,
    note: 'every subject IS one place, so all twenty tuples declare the same setting, and 14.8% of its evidence lenses open with the same four words; the prose is authored rather than generated, but this is the same shape padding makes and the pack should be revisited',
  },
  'com.storystudio.pack.topic.natural-world-animals': {
    minScopeDiversity: 10,
    maxAffixShare: 0.05,
    maxSubjectEchoShare: 1,
    note: 'each subject is a species and its name opens every episode object; deliberate, but it means the echo check cannot protect this pack',
  },
}

type Record_ = { pack_id: string, version: string, kind: string, source_path: string, dependencies: Array<{ pack_id: string, version: string }> }
type TopicDocument = Extract<ContentPackDocument, { kind: 'topic-pack' }>

function newer(left: string, right: string): boolean {
  const l = left.split('.').map(Number)
  const r = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((l[index] || 0) !== (r[index] || 0)) return (l[index] || 0) > (r[index] || 0)
  }
  return false
}

async function loadTopic(record: Record_): Promise<TopicDocument> {
  const contentDir = path.join(ROOT, record.source_path, 'content')
  const entries = (await readdir(contentDir)).filter(name => name.endsWith('.json'))
  assert.equal(entries.length, 1, `${record.source_path} must hold exactly one content document`)
  const document = parseContentPackDocument('topic-pack', JSON.parse(await readFile(path.join(contentDir, entries[0]!), 'utf8')))
  assert.equal(document.kind, 'topic-pack')
  return document as TopicDocument
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9']+/g) || []
}

/** The largest share of `values` that opens, or closes, with the same four words. */
function affixShare(values: string[]): { share: number, phrase: string } {
  let best = { share: 0, phrase: '' }
  for (const side of ['head', 'tail'] as const) {
    const counts = new Map<string, number>()
    for (const value of values) {
      const parts = words(value)
      if (parts.length < 4) continue
      const key = (side === 'head' ? parts.slice(0, 4) : parts.slice(-4)).join(' ')
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    for (const [phrase, count] of counts) {
      const share = count / values.length
      if (share > best.share) best = { share, phrase: `${side}: ${phrase}` }
    }
  }
  return best
}

test('every Topic Pack a Channel Kit sells reaches its idea count by authorship, not by template', async () => {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as { records: Record_[] }
  const byIdentity = new Map(registry.records.map(record => [`${record.pack_id}@${record.version}`, record]))

  const newestKits = new Map<string, Record_>()
  for (const record of registry.records) {
    if (record.kind !== 'channel-kit') continue
    const current = newestKits.get(record.pack_id)
    if (!current || newer(record.version, current.version)) newestKits.set(record.pack_id, record)
  }

  const measured: string[] = []
  for (const kit of [...newestKits.values()].sort((left, right) => left.pack_id.localeCompare(right.pack_id))) {
    const topicRecord = kit.dependencies
      .map(dependency => byIdentity.get(`${dependency.pack_id}@${dependency.version}`))
      .find(record => record?.kind === 'topic-pack')
    assert.ok(topicRecord, `${kit.pack_id}@${kit.version} must pin a Topic Pack`)

    const document = await loadTopic(topicRecord)
    const profiles = document.coverage_profiles
    // Only profile-based packs carry per-subject tuples; an independent-axis pack has no
    // per-subject shape to measure, and its capacity is guarded elsewhere.
    if (!profiles || profiles.length < 20) continue

    const bar = BARS[topicRecord.pack_id] ?? DEFAULT_BAR
    const identity = `${topicRecord.pack_id}@${topicRecord.version} (sold by ${kit.pack_id}@${kit.version})`

    let worstScopes = Number.POSITIVE_INFINITY
    let worstSubject = ''
    let echoes = 0
    let tuples = 0
    const axes = { episode_object: [] as string[], time_place_scope: [] as string[], mechanism: [] as string[], evidence_lens: [] as string[] }
    for (const profile of profiles) {
      const scopes = new Set(profile.tuples.map(tuple => tuple.time_place_scope)).size
      if (scopes < worstScopes) { worstScopes = scopes; worstSubject = profile.subject }
      const needle = profile.subject.toLowerCase()
      for (const tuple of profile.tuples) {
        tuples += 1
        if (tuple.episode_object.toLowerCase().includes(needle) || tuple.mechanism.toLowerCase().includes(needle)) echoes += 1
        for (const key of ['episode_object', 'time_place_scope', 'mechanism', 'evidence_lens'] as const) axes[key].push(tuple[key])
      }
    }

    assert.ok(
      worstScopes >= bar.minScopeDiversity,
      `${identity}: subject "${worstSubject}" reuses one setting across ${20 - worstScopes} of its tuples — ${worstScopes} distinct settings against a declared floor of ${bar.minScopeDiversity}${bar.note ? ` (${bar.note})` : ''}`,
    )

    for (const [name, values] of Object.entries(axes)) {
      const { share, phrase } = affixShare(values)
      assert.ok(
        share <= bar.maxAffixShare,
        `${identity}: ${(share * 100).toFixed(1)}% of ${name} values share the fixed phrase "${phrase}" — a template, against a declared ceiling of ${(bar.maxAffixShare * 100).toFixed(0)}%`,
      )
    }

    const echoShare = echoes / tuples
    assert.ok(
      echoShare <= bar.maxSubjectEchoShare,
      `${identity}: ${(echoShare * 100).toFixed(1)}% of tuples glue the subject name into an episode object or mechanism, against a declared ceiling of ${(bar.maxSubjectEchoShare * 100).toFixed(0)}%${bar.note ? ` (${bar.note})` : ''}`,
    )

    measured.push(identity)
  }

  assert.ok(measured.length >= 10, `this guard must still be measuring the sold Topic Packs; it measured only ${measured.length}`)
})
