import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { contentPackDocumentToNiche, contentPackDocumentToTopicPack } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { useTempDataDir } from './_helpers.js'

// The Deep Time Field Record wave proposal (docs/product/deep-time-field-record-wave-one-proposal.md,
// section 10) refused to let pack 3 be authored until TWO contracts existed:
//
//   1. a dating-dispute posture AT LEAST AS STRICT as pack 1's, because hominin
//      chronologies are contested more often than they are settled; and
//   2. an explicit boundary against the FIRST HUMANS free foundation and its own
//      approved paid depth path, so the two lanes do not author into each other.
//
// Both are mechanical -- they are declarations this pack can be held to -- so both are
// written here as gates rather than as prose in a document nobody runs. The wave's
// third boundary, pack 3 against packs 1 and 2, is already held by the committed
// cross-pack overlap gate, which discovers packs from the authoring registry and
// picked pack 3 up on the day its record landed. This file does not repeat it.
//
// The pack's own half of the wave's split is:
//
//   pack 1 owns THE ORGANISM AND THE EXTINCTION.
//   pack 2 owns THE OCEAN AS A SYSTEM AND ITS RECORD.
//   pack 3 owns THE HOMININ EVIDENCE RECORD: the specimen, the site, the date, the dispute.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PACK = path.join(ROOT, 'content-packs/paid/deep-time-field-record/topic/human-origins-ancient-worlds/content/topic-pack.json')
const FORMULA = path.join(ROOT, 'content-packs/free-starters/formula/deep-time-documentary/content/series-formula.json')

type TopicDocument = Extract<ContentPackDocument, { kind: 'topic-pack' }>
type FormulaDocument = Extract<ContentPackDocument, { kind: 'series-formula' }>

async function loadPack(): Promise<TopicDocument> {
  const document = parseContentPackDocument('topic-pack', JSON.parse(await readFile(PACK, 'utf8')))
  assert.equal(document.kind, 'topic-pack')
  return document as TopicDocument
}

const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

// ---------------------------------------------------------------------------
// CONTRACT 1: the dating-dispute posture
// ---------------------------------------------------------------------------
//
// Pack 1's posture, in its own exclusions, is "Do not present a contested date,
// affinity or extinction mechanism as settled", enforced editorially by keeping
// disputes in the evidence lens. This pack is held to the same shape BY MACHINE,
// which is what "at least as strict" has to mean if it is to mean anything:
//
//   - hedging vocabulary is BANNED outright from `mechanism` and `time_place_scope`;
//   - it is PERMITTED in `evidence_lens`, and only there;
//   - a lens that hedges must also be a NAMED-RECORD COMPARISON -- it has to set one
//     record, method or dataset against another, rather than simply sounding unsure.
//
// The third rule is the one that makes this stricter than pack 1. "may be older than
// the Kibish tuffs" is a hedge dressed as evidence; "the argon ages on Tuff E set
// against the faunal correlation" is a comparison. Only the second is allowed to carry
// a dispute, so an author cannot satisfy the contract by moving vague wording into the
// lens and leaving it vague.

const HEDGES = [
  'probably', 'perhaps', 'may ', 'may be', 'might', 'possibly', 'arguably', 'thought to',
  'believed to', 'controversial', 'disputed', 'contested', 'debated', 'likely', 'unclear',
  'uncertain', 'some argue', 'if confirmed', 'claimed to', 'purported', 'alleged',
]

/**
 * The vocabulary of a named-record comparison: one record set against another.
 *
 * Widened once, against two real lenses this rule flagged that were doing exactly what the
 * contract asks. "adhering sediment matched TO the terrace beds it was claimed to have come
 * from" names both records; it just used a preposition the list did not carry. "the
 * reconstruction disputed at the time by Arthur Keith using THOSE SAME FRAGMENTS" names the
 * opposing reading and the material it rests on. Both are comparisons. What the rule must
 * still reject is a lens that hedges and points at nothing -- "the age is disputed and the
 * specimen may be older than the excavators reported" -- and the mutation set proves it does.
 */
const COMPARISON = [
  'set against', 'against the', 'compared with', 'compared against', 'compared to',
  'alongside the', 'versus', 'read against', 'weighed against', 'measured against',
  'checked against', 'tested against', 'matched against', 'matched to', 'traced to',
  'cross-checked', 'reconciled with', 'disagree', 'disagrees', 'disagreement',
  'conflict', 'conflicts', 'competing', 'two sets', 'both series',
  'the same layer', 'the same sample', 'the same section', 'the same core',
  'same fragments', 'same material', 'same specimen', 'same bones', 'same teeth',
  'independent', 'replicate', 'replicated', 'redated', 'revision', 'revised',
  'restudy', 'reanalysis', 're-examination', 're-excavation', 'reinterpretation',
]

function containsAny(value: string, needles: string[]): string | null {
  const lower = value.toLowerCase()
  for (const needle of needles) if (lower.includes(needle)) return needle
  return null
}

test('contract 1: a contested date, affinity or attribution appears only in the evidence lens, as a named-record comparison', async () => {
  const document = await loadPack()
  const problems: string[] = []

  for (const profile of document.coverage_profiles ?? []) {
    for (const tuple of profile.tuples) {
      for (const axis of ['mechanism', 'time_place_scope', 'episode_object'] as const) {
        const hit = containsAny(tuple[axis], HEDGES)
        if (hit) {
          problems.push(
            `"${profile.subject}" hedges in ${axis} with "${hit}": ${tuple[axis]} -- ` +
            'a contested date, affinity or attribution belongs in the evidence lens, never asserted or hedged elsewhere',
          )
        }
      }
      const hedged = containsAny(tuple.evidence_lens, HEDGES)
      if (hedged && !containsAny(tuple.evidence_lens, COMPARISON)) {
        problems.push(
          `"${profile.subject}" hedges in evidence_lens with "${hedged}" but names no competing record: ${tuple.evidence_lens} -- ` +
          'the contract allows a dispute in the lens only as a named-record comparison, not as vague wording moved into a safer field',
        )
      }
    }
  }

  assert.equal(problems.length, 0, `\n  - ${problems.slice(0, 25).join('\n  - ')}\n  (${problems.length} total)\n`)
})

// ---------------------------------------------------------------------------
// CONTRACT 2: the boundary against the First Humans lane
// ---------------------------------------------------------------------------
//
// Two lanes can honestly reach for the same prehistoric material, and the store sells
// them separately:
//
//   FIRST HUMANS owns the LIVED PROBLEM. Its free foundation is Survival Problems
//   ("surviving winter", "making a stone tool"), and its approved paid depth path is
//   Environments & Climate, Social Life & Belief, Tools & Technology -- all of which
//   already exist as built-in Topic Packs. Every one of those subjects is an
//   experience with no named site, no specimen and no date.
//
//   DEEP TIME pack 3 owns the EVIDENCE AND ITS CHRONOLOGY: a named fossil, a named
//   site or layer, a named dating method, a named controversy.
//
// That is a checkable difference rather than an editorial preference, so it is checked
// two ways: no subject may collide with the other lane's subjects, and every subject
// must name an evidence anchor. The second rule is the load-bearing one -- it is what
// stops this pack from drifting into "how ancient humans coped with winter" one
// subject at a time.
//
// The legacy built-in `deep-time-human-origins` carries the SAME NAME as this pack and
// is live in the free Deep Time niche today. The wave's no-legacy-rebilling rule
// (proposal section 4) says the paid pack shares no authored bytes with it, so it is
// compared here too.

const OTHER_LANE: Array<{ label: string, file: string }> = [
  {
    label: 'the First Humans free foundation (Survival Problems)',
    file: 'content-packs/free-starters/topic/ancient-humans-survival-v1.0.1/content/topic-pack.json',
  },
  {
    label: "First Humans' approved paid depth path: Environments & Climate",
    file: 'electron/server/topic-packs/ancient-humans-environments.json',
  },
  {
    label: "First Humans' approved paid depth path: Social Life & Belief",
    file: 'electron/server/topic-packs/ancient-humans-social-life.json',
  },
  {
    label: "First Humans' approved paid depth path: Tools & Technology",
    file: 'electron/server/topic-packs/ancient-humans-technology.json',
  },
  {
    label: 'the legacy built-in of the same name, deep-time-human-origins',
    file: 'electron/server/topic-packs/deep-time-human-origins.json',
  },
]

const STOP = new Set(`a an the and or of in on at as its their his her it for from to by with
into over under through during between across after before out up down off than then that this
these those is are was were be been being has have had do does did`.split(/\s+/).filter(Boolean))

function tokens(subject: string): Set<string> {
  const out = new Set<string>()
  for (const word of subject.toLowerCase().match(/[a-z0-9']+/g) || []) {
    if (STOP.has(word)) continue
    out.add(word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)
  }
  return out
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  const union = left.size + right.size - shared
  return union === 0 ? 0 : shared / union
}

/** A site, a specimen, a unit, a method, a dispute, an expedition, a collection. */
const EVIDENCE_ANCHORS = new Set(`cave caves gorge shelter rockshelter site sites locality deposits
deposit bed beds layer layers member sediments sediment breccia breccias tuff sands silt terrace dome
quarry workings chamber cranium crania skull skulls calvaria calvarium mandible maxilla jaw teeth tooth
femur femora tibia metatarsal foot hyoid skeleton skeletons remains fossil fossils specimen specimens
assemblage assemblages sample burial burials footprint footprints artefact artefacts tools handaxe spears
points beads ochre eggshell paintings art rings hearths cutmarks bones bone floor floors collection
collections monograph excavations excavation record records sequence sequences genome genomes dna dating
dates chronology correlation calibration provenance forgery project programme expedition survey type`
  .split(/\s+/).filter(Boolean))

test('contract 2: Human Origins does not author into the First Humans lane, and every subject is evidence-anchored', async () => {
  const document = await loadPack()
  const problems: string[] = []

  for (const entry of OTHER_LANE) {
    const raw = JSON.parse(await readFile(path.join(ROOT, entry.file), 'utf8')) as { subjects?: string[] }
    const theirs = raw.subjects ?? []
    assert.ok(theirs.length > 0, `${entry.file} must still carry a subject list for this boundary to mean anything`)
    for (const ours of document.subjects) {
      for (const other of theirs) {
        const score = jaccard(tokens(ours), tokens(other))
        if (score >= 0.35) {
          problems.push(
            `"${ours}" overlaps ${(score * 100).toFixed(0)}% with "${other}" from ${entry.label} -- ` +
            'the lanes are sold separately; re-author this subject around its site, specimen or dating record',
          )
        }
      }
    }
  }

  // The positive half. First Humans owns the lived problem; this pack owns the record,
  // so every subject has to name something excavated, catalogued, dated or published.
  for (const subject of document.subjects) {
    const words = new Set(subject.toLowerCase().match(/[a-z]+/g) || [])
    if (![...words].some(word => EVIDENCE_ANCHORS.has(word))) {
      problems.push(
        `"${subject}" names no site, specimen, unit, method, collection or dispute -- ` +
        'an unanchored subject is a First Humans subject wearing a Deep Time label',
      )
    }
  }

  assert.equal(problems.length, 0, `\n  - ${problems.slice(0, 25).join('\n  - ')}\n  (${problems.length} total)\n`)
})

// ---------------------------------------------------------------------------
// House style: the casing rules this family had to learn
// ---------------------------------------------------------------------------
//
// Section 9 of the proposal records that binomial nomenclature broke the inherited
// half-lowercase rule (`Homo erectus` is correct and looks exactly like the defect
// `Indian ocean`), and that informal chronostratigraphic modifiers are lowercase by
// convention. Both carve-outs are reproduced here so the rule catches the real defect
// and not the correct spelling, and so the modifier casing stays internally consistent.

const BINOMIAL_GENERA = new Set([
  'homo', 'australopithecus', 'paranthropus', 'ardipithecus', 'orrorin', 'sahelanthropus',
  'kenyanthropus', 'pan', 'gorilla', 'denisova',
])

test('house style: proper names are fully capitalised, binomials are not treated as defects, and modifier casing is consistent', async () => {
  const document = await loadPack()
  const values: string[] = []
  for (const profile of document.coverage_profiles ?? []) {
    for (const tuple of profile.tuples) {
      values.push(tuple.episode_object, tuple.time_place_scope, tuple.mechanism, tuple.evidence_lens)
    }
  }
  values.push(...document.subjects)

  // The half-lowercase rule is a CONSISTENCY check, not a pattern match, and this is the
  // second time this family has had to learn that. Section 9 records the first: the
  // inherited `[A-Z][a-z]+ [a-z]+` rule fired on every correctly written binomial, and
  // needed an explicit allowlist. The same shape of false positive appears again here for a
  // different reason -- a proper noun followed by a common noun used descriptively is
  // ordinary English, not a defect. "the Sterkfontein valley dolomites", "the Malapa
  // chamber", "the Harts River valley" and "early Pleistocene lake margin beds" are all
  // correct, and a generic pattern flags all of them.
  //
  // What IS a defect is writing one formal name both ways: "Olduvai Gorge" in one tuple and
  // "Olduvai gorge" in another. That is checkable without a dictionary of proper names, and
  // it is what this now measures. A pack that consistently uses the lowercase descriptive
  // form is left alone; a pack that cannot make up its mind is not.
  const GENERIC_TAIL = /^(Cave|Gorge|Valley|River|Basin|Shelter|Rift|Sea|Lake|Mountains|Island|Desert|Plateau|Delta|Gallery|Chamber|Terrace|Karst|Dome|Grotto|Formation|Member)$/i
  const casedBy = new Map<string, Set<string>>()
  for (const value of values) {
    for (const match of value.matchAll(/\b([A-Z][a-z]+) ([A-Za-z]+)\b/g)) {
      const [, head, tail] = match
      if (BINOMIAL_GENERA.has(head!.toLowerCase())) continue // Genus species, correct by convention
      if (!GENERIC_TAIL.test(tail!)) continue
      const key = `${head} ${tail.toLowerCase()}`
      casedBy.set(key, (casedBy.get(key) ?? new Set()).add(tail!))
    }
  }
  const splitNames = [...casedBy.entries()].filter(([, forms]) => forms.size > 1)
  assert.equal(splitNames.length, 0,
    'a formal name is written both ways; pick one casing and keep it (write "Olduvai Gorge" everywhere, ' +
    `not "Olduvai gorge" in one tuple and "Olduvai Gorge" in another):\n  - ${
      splitNames.map(([key, forms]) => `${key} appears as ${[...forms].join(' and ')}`).join('\n  - ')}`)

  // One casing per modifier-and-period pair, kept for the whole document.
  const casings = new Map<string, Set<string>>()
  for (const value of values) {
    for (const match of value.matchAll(/\b([Ee]arly|[Mm]iddle|[Ll]ate|[Uu]pper|[Ll]ower) (Pleistocene|Pliocene|Holocene|Miocene|Palaeolithic|Paleolithic|Palaeozoic)\b/g)) {
      const key = `${match[1]!.toLowerCase()} ${match[2]}`
      casings.set(key, (casings.get(key) ?? new Set()).add(match[1]!))
    }
  }
  const split = [...casings.entries()].filter(([, forms]) => forms.size > 1)
  assert.equal(split.length, 0,
    `a modifier-and-period pair is written both ways; pick one and keep it: ${
      split.map(([key, forms]) => `${key} (${[...forms].join(', ')})`).join('; ')}`)
})

// ---------------------------------------------------------------------------
// Capacity, measured through the planner the app actually uses
// ---------------------------------------------------------------------------

test('the pack plans its full 2,000 lifetime assignments against the free Deep Time Formula, and fails closed past them', async () => {
  const document = await loadPack()
  const formulaDocument = parseContentPackDocument('series-formula', JSON.parse(await readFile(FORMULA, 'utf8'))) as FormulaDocument
  const formula = contentPackDocumentToNiche(formulaDocument)
  const pack = contentPackDocumentToTopicPack(document)
  const niche = { ...formula, activeTopicPacks: [pack] }

  const assignments = planIdeaAssignments({ niche, count: 2000, seed: 'deep-time-human-origins-full' })
  assert.equal(assignments.length, 2000, 'the pack must plan exactly its 2,000 authored assignments')
  assert.equal(new Set(assignments.map(item => item.fingerprint)).size, 2000, 'every assignment must be distinct')

  const bySubject = new Map<string, number>()
  for (const assignment of assignments) {
    const subject = assignment.dimensions.subject!
    bySubject.set(subject, (bySubject.get(subject) ?? 0) + 1)
    assert.ok(assignment.dimensions['episode-object'])
    assert.ok(assignment.dimensions['time-place-scope'])
    assert.ok(assignment.dimensions.mechanism)
    assert.ok(assignment.dimensions['evidence-lens'])
  }
  assert.equal(bySubject.size, 100)
  assert.ok([...bySubject.values()].every(count => count === 20), 'every subject contributes exactly its 20 authored siblings')

  // Deterministic: the same seed replays the same plan.
  const replay = planIdeaAssignments({ niche, count: 2000, seed: 'deep-time-human-origins-full' })
  assert.deepEqual(replay.map(item => item.fingerprint), assignments.map(item => item.fingerprint))

  // Fails CLOSED rather than repeating. Asking for 2,001 must refuse outright: the pack
  // sells 2,000 non-repeating assignments, and quietly handing back a repeated episode
  // object or mechanism would be the failure this claim exists to rule out.
  assert.throws(
    () => planIdeaAssignments({ niche, count: 2001, seed: 'deep-time-human-origins-overrun' }),
    /cannot plan the requested campaign without repeating/,
    'the pack must refuse a 2,001st assignment rather than repeat an object or mechanism',
  )
})

// ---------------------------------------------------------------------------
// The authored shape the proposal sells
// ---------------------------------------------------------------------------

test('the authored document is 100 x 20 with every axis value distinct and every scope carrying a place and an interval', async () => {
  const document = await loadPack()
  assert.equal(document.subjects.length, 100)
  assert.equal(new Set(document.subjects).size, 100)
  assert.equal(document.coverage_profiles?.length, 100)

  const axes = { episode_object: [] as string[], time_place_scope: [] as string[], mechanism: [] as string[], evidence_lens: [] as string[] }
  for (const profile of document.coverage_profiles ?? []) {
    assert.equal(profile.tuples.length, 20, `${profile.subject} must carry 20 authored tuples`)
    assert.equal(new Set(profile.tuples.map(tuple => tuple.time_place_scope)).size, 20,
      `${profile.subject} must place its 20 tuples at 20 distinct settings`)
    for (const tuple of profile.tuples) {
      for (const key of ['episode_object', 'time_place_scope', 'mechanism', 'evidence_lens'] as const) axes[key].push(tuple[key])
    }
  }

  for (const [name, values] of Object.entries(axes)) {
    assert.equal(values.length, 2000)
    assert.equal(new Set(values.map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-'))).size, 2000,
      `every ${name} must be distinct after slug()`)
  }

  // Every scope names a place AND an interval.
  //
  // This ruler was CALIBRATED, not guessed, and the first two versions of it were wrong in
  // the same direction. A narrow rule reported 480 misses here, then 60% of pack 1 and 46%
  // of pack 2 -- two packs whose own checker records zero. That is the signature of a short
  // ruler, not of worse content: it could not read "Cryogenian", "Neoarchean", "about 635
  // million years ago", "14,300 cal BP", "the Anglian" or "the Neronian phase", every one of
  // which names a time. So the vocabulary below is the honest definition of an interval, and
  // it is deliberately wide: a numeric age in any unit and phrasing, a chronostratigraphic
  // name at any rank, a marine isotope stage, a magnetochron, a regional glacial stage, an
  // archaeological industry, or a calendar year for the archival and history-of-science
  // scopes this pack legitimately carries.
  //
  // What it still refuses is the actual defect: a lithostratigraphic unit standing alone.
  // "the Aramis Member of the Sagantole Formation" names a rock body, not a time.
  const INTERVAL = new RegExp([
    String.raw`\d[\d.,]*\s*(?:million|billion|thousand)?\s*(?:cal|calibrated|radiocarbon|uncalibrated)?\s*(?:years?\s*)?(?:ka|Ma|Ga|kyr|myr|yr|years?|BP|bp|AD|BC|CE|BCE)`,
    String.raw`\d[\d.,]*\s*(?:million|billion|thousand)`,
    String.raw`(?:1[5-9]\d{2}|20[0-2]\d)s?`,
    'Hadean|Archaean|Archean|Eoarchaean|Eoarchean|Palaeoarchaean|Paleoarchean|Mesoarchaean|Mesoarchean|Neoarchaean|Neoarchean',
    'Proterozoic|Palaeoproterozoic|Paleoproterozoic|Mesoproterozoic|Neoproterozoic',
    'Phanerozoic|Palaeozoic|Paleozoic|Mesozoic|Cenozoic|Caenozoic|Precambrian',
    'Siderian|Rhyacian|Orosirian|Statherian|Calymmian|Ectasian|Stenian|Tonian|Cryogenian|Ediacaran',
    'Cambrian|Ordovician|Silurian|Devonian|Carboniferous|Mississippian|Pennsylvanian|Permian',
    'Triassic|Jurassic|Cretaceous|Palaeogene|Paleogene|Neogene|Quaternary',
    'Palaeocene|Paleocene|Eocene|Oligocene|Miocene|Pliocene|Pleistocene|Holocene|Anthropocene',
    'Hirnantian|Messinian|Toarcian|Capitanian|Maastrichtian|Campanian|Turonian|Cenomanian',
    'Zanclean|Piacenzian|Gelasian|Calabrian|Chibanian|Serravallian|Langhian|Burdigalian|Aquitanian',
    String.raw`MIS\s*\d+|OIS\s*\d+|Marine\s+Isotope\s+Stage\s*\d+|Oxygen\s+Isotope\s+Stage\s*\d+`,
    String.raw`Brunhes|Matuyama|Jaramillo|Olduvai\s+subchron|subchron|chron`,
    'Palaeolithic|Paleolithic|Mesolithic|Neolithic|Epipalaeolithic',
    'Acheulean|Oldowan|Mousterian|Aurignacian|Chatelperronian|Gravettian|Magdalenian|Solutrean',
    String.raw`Clovis|Howiesons|Still\s*Bay|Sangoan|Lupemban|Natufian|Ahmarian|Uluzzian|Szeletian|Bohunician|Micoquian`,
    'Neronian|Post-Neronian|Protoaurignacian|Proto-Aurignacian',
    String.raw`(?:Earlier|Early|Middle|Later|Late)\s+Stone\s+Age|Stone\s+Age|Iron\s+Age|Bronze\s+Age`,
    'Anglian|Hoxnian|Wolstonian|Ipswichian|Devensian|Cromerian|Beestonian|Pastonian',
    'Weichselian|Saalian|Eemian|Elsterian|Holsteinian',
    String.raw`(?:first|second|third|fourth|fifth)\s+millennium|millennium`,
    'glacial|interglacial|interstadial|stadial|deglaciation|glaciation',
  ].map(part => `(?:${part})`).join('|'), 'i')
  const missing = axes.time_place_scope.filter(scope => !INTERVAL.test(scope))
  assert.equal(missing.length, 0,
    `every time_place_scope must name a geological or archaeological interval; ${missing.length} do not:\n  - ${missing.slice(0, 10).join('\n  - ')}`)
})
