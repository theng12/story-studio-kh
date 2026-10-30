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
//   subjectEchoShare- the largest repeated opening or closing frame that carries a normalized
//                     whole-subject marker in an episode object or mechanism. Ordinary factual
//                     nouns are fine; a repeated subject tag used to defeat uniqueness is not.
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

type Record_ = {
  pack_id: string
  version: string
  kind: string
  status: string
  source_path: string
  dependencies: Array<{ pack_id: string, version: string }>
  stocking_proposal?: { family?: { id?: string, status?: string }, sku?: { id?: string, status?: string } }
}
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

async function loadTopicAt(sourcePath: string): Promise<TopicDocument> {
  const document = parseContentPackDocument(
    'topic-pack',
    JSON.parse(await readFile(path.join(ROOT, sourcePath, 'content', 'topic-pack.json'), 'utf8')),
  )
  assert.equal(document.kind, 'topic-pack')
  return document as TopicDocument
}

test('subject echo frames catch the historical glued tag without rejecting factual subject nouns', async () => {
  const [padded, clean, drinks, everyday] = await Promise.all([
    loadTopicAt('content-packs/free-starters/topic/habits-momentum-v1.0.1'),
    loadTopicAt('content-packs/free-starters/topic/habits-momentum-v1.0.2'),
    loadTopicAt('content-packs/sleep-history/topic/drinks-and-spices-histories'),
    loadTopicAt('content-packs/sleep-history/topic/everyday-object-histories'),
  ])

  assert.equal(subjectEchoFrameShare(padded.coverage_profiles!, 'mechanism').share, 0.1)
  assert.ok(subjectEchoFrameShare(clean.coverage_profiles!, 'mechanism').share <= 0.05)
  assert.ok(subjectEchoFrameShare(drinks.coverage_profiles!, 'episode_object').share <= 0.05)
  assert.ok(subjectEchoFrameShare(drinks.coverage_profiles!, 'mechanism').share <= 0.05)
  assert.ok(subjectEchoFrameShare(everyday.coverage_profiles!, 'episode_object').share <= 0.05)
  assert.ok(subjectEchoFrameShare(everyday.coverage_profiles!, 'mechanism').share <= 0.05)
  assert.equal(markWholeSubject('a barrel of wines', 'wine'), 'a barrel of wines')
  assert.equal(markWholeSubject('salted meat for a voyage', 'salt'), 'salted meat for a voyage')
})

/** The largest share of `values` that opens, or closes, with the same four words. */
function affixShare(
  values: string[],
  accepts: (phrase: string) => boolean = () => true,
): { share: number, phrase: string } {
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
      if (!accepts(phrase)) continue
      const share = count / values.length
      if (share > best.share) best = { share, phrase: `${side}: ${phrase}` }
    }
  }
  return best
}

const SUBJECT_MARKER = 'subjectmarker'

function markWholeSubject(value: string, subject: string): string {
  const subjectWords = words(subject)
  if (!subjectWords.length) return value
  const valueWords = words(value)
  const marked: string[] = []
  for (let index = 0; index < valueWords.length;) {
    const matches = subjectWords.every((word, offset) => valueWords[index + offset] === word)
    if (matches) {
      marked.push(SUBJECT_MARKER)
      index += subjectWords.length
    } else {
      marked.push(valueWords[index]!)
      index += 1
    }
  }
  return marked.join(' ')
}

function subjectEchoFrameShare(
  profiles: NonNullable<TopicDocument['coverage_profiles']>,
  axis: 'episode_object' | 'mechanism',
): { share: number, phrase: string } {
  const values = profiles.flatMap(profile => profile.tuples.map(tuple => markWholeSubject(tuple[axis], profile.subject)))
  // This is deliberately a template guard, not semantic inference: it catches repeated edge
  // frames such as “This setup is for <subject>”, but not a mid-field tag or a paraphrase.
  return affixShare(values, phrase => phrase.split(' ').includes(SUBJECT_MARKER))
}

test('every Topic Pack we sell reaches its idea count by authorship, not by template', async () => {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as { records: Record_[] }
  const activeRecords = registry.records.filter(record => record.status !== 'retired')
  const byIdentity = new Map(activeRecords.map(record => [`${record.pack_id}@${record.version}`, record]))

  const newestKits = new Map<string, Record_>()
  for (const record of activeRecords) {
    if (record.kind !== 'channel-kit') continue
    const current = newestKits.get(record.pack_id)
    if (!current || newer(record.version, current.version)) newestKits.set(record.pack_id, record)
  }

  // What is SOLD is what this guard has to measure, and a Channel Kit is only one of the
  // ways we sell a Topic Pack. The Archival Ledger and the Deep Time Field Record sell
  // their Topic components independently, each as its own catalog identity, so none of
  // them was pinned by any kit and none of them was measured here -- six paid packs
  // carrying 12,000 authored tuples sat outside the padding guard entirely while it
  // reported green. A pack sold on its own is still a pack sold.
  //
  // The registry says which those are: a record carrying a `stocking_proposal` is one
  // whose family and SKU are being proposed for the store on their own.
  const targets: Array<{ record: Record_, soldBy: string }> = []
  for (const kit of [...newestKits.values()].sort((left, right) => left.pack_id.localeCompare(right.pack_id))) {
    const topicRecord = kit.dependencies
      .map(dependency => byIdentity.get(`${dependency.pack_id}@${dependency.version}`))
      .find(record => record?.kind === 'topic-pack')
    assert.ok(topicRecord, `${kit.pack_id}@${kit.version} must pin a Topic Pack`)
    targets.push({ record: topicRecord, soldBy: `sold by ${kit.pack_id}@${kit.version}` })
  }

  const newestTopics = new Map<string, Record_>()
  for (const record of activeRecords) {
    if (record.kind !== 'topic-pack') continue
    if (!record.stocking_proposal) continue
    const current = newestTopics.get(record.pack_id)
    if (!current || newer(record.version, current.version)) newestTopics.set(record.pack_id, record)
  }
  const alreadyMeasured = new Set(targets.map(target => `${target.record.pack_id}@${target.record.version}`))
  for (const record of [...newestTopics.values()].sort((left, right) => left.pack_id.localeCompare(right.pack_id))) {
    if (alreadyMeasured.has(`${record.pack_id}@${record.version}`)) continue
    targets.push({ record, soldBy: 'sold on its own as an independent Topic component' })
  }

  const measured: string[] = []
  for (const target of targets) {
    const topicRecord = target.record
    const document = await loadTopic(topicRecord)
    const profiles = document.coverage_profiles
    // Only profile-based packs carry per-subject tuples; an independent-axis pack has no
    // per-subject shape to measure, and its capacity is guarded elsewhere.
    if (!profiles || profiles.length < 20) continue

    const bar = BARS[topicRecord.pack_id] ?? DEFAULT_BAR
    const identity = `${topicRecord.pack_id}@${topicRecord.version} (${target.soldBy})`

    let worstScopes = Number.POSITIVE_INFINITY
    let worstSubject = ''
    const axes = { episode_object: [] as string[], time_place_scope: [] as string[], mechanism: [] as string[], evidence_lens: [] as string[] }
    for (const profile of profiles) {
      const scopes = new Set(profile.tuples.map(tuple => tuple.time_place_scope)).size
      if (scopes < worstScopes) { worstScopes = scopes; worstSubject = profile.subject }
      for (const tuple of profile.tuples) {
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

    for (const axis of ['episode_object', 'mechanism'] as const) {
      const { share, phrase } = subjectEchoFrameShare(profiles, axis)
      assert.ok(
        share <= bar.maxSubjectEchoShare,
        `${identity}: ${(share * 100).toFixed(1)}% of ${axis} values share the subject-tag frame "${phrase}" — a template, against a declared ceiling of ${(bar.maxSubjectEchoShare * 100).toFixed(0)}%${bar.note ? ` (${bar.note})` : ''}`,
      )
    }

    measured.push(identity)
  }

  assert.ok(measured.length >= 10, `this guard must still be measuring the sold Topic Packs; it measured only ${measured.length}`)
})
