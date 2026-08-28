import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseContentPackDocument } from '../content-packs/schemas.js'
import type { ContentPackDocument } from '../content-packs/types.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_PATH = path.join(ROOT, 'content-packs', 'authoring-registry.json')

// The Deep Time Field Record is authored as a wave of independent Topic components,
// one pack at a time, months apart, by different writers. Its wave proposal
// (docs/product/deep-time-field-record-wave-one-proposal.md, section 10) sets a
// boundary that only a machine can hold across that gap:
//
//   pack 1 owns THE ORGANISM AND THE EXTINCTION.
//   pack 2 owns THE OCEAN AS A SYSTEM AND ITS RECORD.
//   later packs declare their own half of the same kind of split.
//
// Marine reptiles, anoxia events and reef extinctions can honestly be written from
// either side, so "no two packs may name the same subject" is too blunt and "trust
// the author" is not a gate at all. What is checkable is the SHAPE of the treatment:
// where two packs touch the same named thing, the later pack's subject must say, in
// its own words, that it is about water, chemistry, circulation, sea level or the
// record -- not about the animal that died in it.
//
// So this gate is three rules, in increasing tolerance:
//
//   1. Identical normalised subject       -> always a defect. Never adjudicable.
//   2. Near-duplicate, or a shared named  -> must appear in ADJUDICATED with a
//      anchor (a locality, event, vessel     written reason, AND the later pack's
//      or programme name)                    subject must carry a system word.
//   3. A subject naming one of the wave's -> must carry a system word in every pack
//      declared BOUNDARY_EVENTS              except the one that owns the event.
//
// Rule 3 exists because rule 2 cannot see the hardest cases. "the end-Permian
// extinction and the Siberian Traps" and "the Meishan sections and end-Permian
// ocean chemistry" share no anchor and few words, yet they are exactly the pair
// the boundary was written for. Naming the event is the trigger; carrying a system
// word is the proof.
//
// This runs for every future Deep Time pack automatically: packs are discovered
// from the authoring registry, so pack 3 is measured against packs 1 and 2 on the
// day its record lands, with no edit here beyond adjudicating what it flags.
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE DOES NOT DO. Read this before trusting it with a new pack.
//
// A gate is only honest about its own reach. These six limits are real, each one
// is deliberate, and every one of them is somebody's job rather than the gate's.
//
// 1. IT COMPARES SUBJECTS, NEVER TUPLES. A pack could reproduce another pack's
//    two thousand tuples wholesale behind a hundred distinct subject strings and
//    nothing here would fire. Pack 2 was swept by hand instead (no pack-1 subject
//    string appears inside any pack-2 tuple; no excluded-category token appears
//    inside any tuple). Do that sweep for every new pack; it is a few lines of
//    script and it is the hole most worth watching.
//
// 2. IT CANNOT SEE THE FREE LANES AT ALL. Discovery is FAMILY_PREFIX only, so
//    every free foundation Topic is invisible. Pack 3's stated obligation is a
//    boundary against the FIRST HUMANS free foundation and its own paid depth
//    path; that boundary is entirely outside this file and needs either new
//    machinery or an argument made in the proposal.
//
// 3. BOUNDARY_EVENTS IS HAND-CURATED, AND IT IS THE ONLY RULE THAT CATCHES THE
//    HARDEST CLASS. Two subjects about the same event, sharing no anchor and few
//    words, are invisible to rules 1 and 2. Every such pair a new pack introduces
//    is unguarded until someone writes it down here. For a hominin pack that is
//    most of the risk surface: contested chronologies, named sites, named type
//    specimens. Adding entries is the work, not an afterthought.
//
// 4. SYSTEM_WORDS ENCODES PACK 2'S BOUNDARY, NOT A UNIVERSAL ONE. The question it
//    asks -- "does the borrowing subject declare itself a system or record
//    treatment?" -- is the ocean pack's half of the split. A third pack whose
//    boundary is a different shape needs its own vocabulary, which probably means
//    turning this constant into a per-pack map. That is an extension point, not a
//    defect, but it will not extend itself.
//
// 5. OCEAN AND CONTINENT NAMES ARE DELIBERATELY NOT ANCHORS. Atlantic, Pacific,
//    Tethys, Panthalassic and the continental adjectives sit in GENERIC. Admitting
//    them flagged eleven noise pairs and adjudicated nothing. The cost is real:
//    two packs may both build on "the Atlantic" and never be flagged.
//
// 6. THE RULINGS ARE HELD HONEST, SO THEY WILL BREAK ON PURPOSE. A ruling naming a
//    subject no pack authors any more fails, and so does a ruling on a pair the
//    gate no longer flags. Re-wording an adjudicated subject is therefore a
//    deliberate trip-wire: re-make the ruling, do not delete the assertion. Note
//    also `comparisons >= 10000` at the foot of the test -- with three packs that
//    should read roughly thirty thousand, and if it does not, discovery broke.
// ---------------------------------------------------------------------------

const FAMILY_PREFIX = 'com.storystudio.pack.topic.deep-time-field-record.'

/** Articles, connectives and framing verbs: present in most subjects, distinctive in none. */
const STOP = new Set(`a an the and or of in on at as its their his her it for from to by with
into over under through during between across after before out up down off than then
that this these those is are was were be been being has have had do does did
read recorded written seen shown built made using used against about`.split(/\s+/).filter(Boolean))

// Eons, eras, periods and epochs. Half of every pack in this family names one, so a
// shared period name says nothing. Stage and substage names (Hirnantian, Messinian,
// Toarcian, Capitanian) are deliberately absent: naming a stage names one interval,
// and that IS an anchor.
const CHRONO = new Set(`hadean archean archaean proterozoic phanerozoic paleozoic palaeozoic
mesozoic cenozoic caenozoic precambrian tonian cryogenian ediacaran cambrian ordovician
silurian devonian carboniferous mississippian pennsylvanian permian triassic jurassic
cretaceous paleogene palaeogene neogene quaternary paleocene palaeocene eocene oligocene
miocene pliocene pleistocene holocene anthropocene`.split(/\s+/).filter(Boolean))

// Capitalised words that name a CLASS of thing rather than a thing, plus the ocean
// and continent names. "Sea", "Basin", "Event" and "Atlantic" each appear in a dozen
// unrelated proper names across this family; admitting them as anchors would flag
// every pair and so adjudicate nothing.
const GENERIC = new Set(`sea seas ocean oceans basin basins bay gulf strait straits passage
gateway seaway current currents ridge rise bank banks reef reefs shelf platform province
formation formations group member beds bed shale shales limestone chalk clay sandstone
chert cherts sequence section sections site sites pit pits quarry mountains hills cliffs
island islands depression valley river lake crater traps field fields level event events
project program programme expedition survey drilling deep great greater lesser new old
north south east west northern southern eastern western central upper lower middle early
late first last modern ancient marine continental interior transition revolution crisis
boundary record records age epoch era period city state park world highlands
university museum institute atlantic pacific indian arctic antarctic mediterranean
caribbean american siberian european asian african australian australasian laurentian
gondwanan pangaean tethys tethyan panthalassic`.split(/\s+/).filter(Boolean))

// The vocabulary that says "this subject is about the ocean as a system, or about the
// record that reads it". Any pack that borrows another pack's named subject has to
// earn it with one of these.
const SYSTEM_WORDS = new Set(`chemistry chemical ventilation ventilated circulation overturning
oxygenation oxygenated oxygen anoxia anoxic euxinia euxinic redox sulphur isotope isotopes
isotopic eustatic eustasy sea-level salinity saline evaporite evaporites carbonate carbonates
acidification upwelling throughflow transgression transgressions regression water waters
column core cores borehole boreholes transect sediment sediments sedimentary stack lysocline
compensation factory desiccation refilling stratification thermocline bathymetry sounding
soundings ichnofacies bioturbation mixing dissolution phosphogenesis phosphorite cyclothem
cyclothems sapropel varve varved drift drifts contourite turbidite proxy proxies thermometry
correlation nutrient nutrients productivity ventilating chemocline
seabed seafloor bottom deglaciation glacio-eustasy
record records water-column seawater sea-water section sections`.split(/\s+/).filter(Boolean))

/**
 * Pairs that legitimately touch the same named thing from two sides. Every entry is a
 * ruling, not a suppression: it names both subjects, and the gate still requires the
 * later pack's subject to carry a system word, so an entry cannot be used to smuggle
 * a duplicate through. Both subjects must still exist, so a re-wording forces the
 * ruling to be re-made rather than silently kept.
 */
const ADJUDICATED: Array<{ earlier: string, later: string, why: string }> = [
  {
    earlier: 'the Western Interior Seaway and the Niobrara Chalk',
    later: 'the Western Interior Seaway and its water chemistry',
    why: 'pack 1 builds on the Niobrara chalk and the animals preserved in it; pack 2 builds on the epeiric sea\'s salinity, stratification and oxygen budget. Same body of water, different object: a chalk slab against a water column.',
  },
  {
    earlier: 'the Messinian salinity crisis and its faunas',
    later: 'the Messinian desiccation of the Mediterranean basin',
    why: 'pack 1 owns what happened to the animals; pack 2 owns the basin\'s water budget and the evaporite sequence that records it. The proposal names this pair explicitly as a boundary case.',
  },
  {
    earlier: 'the end-Ordovician extinction and the Hirnantian glaciation',
    later: 'the Hirnantian eustatic fall recorded on the shelf',
    why: 'pack 1 owns the extinction; pack 2 owns the sea-level record left on the shelf. The glaciation is the shared cause, not the shared subject.',
  },
  {
    earlier: 'the Late Devonian extinctions and the Kellwasser events',
    later: 'the Kellwasser black shales as a water-column record',
    why: 'pack 1 owns the extinction pulses; pack 2 owns the redox chemistry of the water column the black shales record. This is the anoxia-event case the proposal flagged.',
  },
]

/**
 * Events both halves of the wave may legitimately reach for. Naming one is the trigger
 * for rule 3: outside the owning pack, the subject has to declare itself a system or
 * record treatment. `owner` is the pack suffix that may name the event plainly.
 */
const BOUNDARY_EVENTS: Array<{ token: string, owner: string, note: string }> = [
  { token: 'kellwasser', owner: 'prehistoric-life-extinction', note: 'a Late Devonian extinction pulse and an anoxic event at once' },
  { token: 'hirnantian', owner: 'prehistoric-life-extinction', note: 'an extinction and a glacio-eustatic fall at once' },
  { token: 'messinian', owner: 'prehistoric-life-extinction', note: 'a faunal crisis and a basin desiccation at once' },
  { token: 'end-permian', owner: 'prehistoric-life-extinction', note: 'the largest extinction and the largest ocean chemistry excursion at once' },
  { token: 'end-triassic', owner: 'prehistoric-life-extinction', note: 'an extinction and an ocean acidification episode at once' },
  { token: 'hangenberg', owner: 'ancient-oceans-deep-sea', note: 'an end-Devonian extinction and an anoxic event at once' },
  { token: 'capitanian', owner: 'ancient-oceans-deep-sea', note: 'a mid-Permian extinction and a marine chemistry excursion at once' },
]

/**
 * Boundaries this wave holds by NOT authoring a subject at all, recorded so the
 * reasoning survives the authors. These are the categories the proposal named as
 * ambiguous where the cheaper answer was to leave them entirely to pack 1.
 */
const HELD_BY_EXCLUSION: Array<{ category: string, ownedBy: string, forbiddenIn: string, tokens: string[] }> = [
  {
    category: 'marine reptiles',
    ownedBy: 'prehistoric-life-extinction',
    forbiddenIn: 'ancient-oceans-deep-sea',
    tokens: ['ichthyosaur', 'plesiosaur', 'mosasaur', 'pliosaur', 'marine reptile'],
  },
  {
    category: 'the Permian reef complex of the Guadalupe Mountains',
    ownedBy: 'prehistoric-life-extinction',
    forbiddenIn: 'ancient-oceans-deep-sea',
    tokens: ['guadalupe', 'capitan reef', 'el capitan'],
  },
]

type Record_ = { pack_id: string, version: string, kind: string, source_path: string }
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

/** Content tokens: lowercased, de-articled, crudely singularised. */
function contentTokens(subject: string): Set<string> {
  const out = new Set<string>()
  for (const word of subject.toLowerCase().match(/[a-z0-9']+/g) || []) {
    if (STOP.has(word)) continue
    out.add(word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)
  }
  return out
}

/** The named things a subject is built on: a locality, unit, event, vessel or programme. */
function anchors(subject: string): Set<string> {
  const out = new Set<string>()
  for (const match of subject.match(/[A-Z][A-Za-z']+/g) || []) {
    const word = match.toLowerCase()
    if (CHRONO.has(word) || GENERIC.has(word)) continue
    out.add(word)
  }
  return out
}

function signature(subject: string): string {
  return [...contentTokens(subject)].sort().join(' ')
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  const union = left.size + right.size - shared
  return union === 0 ? 0 : shared / union
}

function carriesSystemWord(subject: string): boolean {
  for (const word of subject.toLowerCase().match(/[a-z0-9'-]+/g) || []) {
    if (SYSTEM_WORDS.has(word)) return true
  }
  return false
}

const NEAR_DUPLICATE = 0.35

test('no Deep Time Field Record pack authors another pack\'s subject', async () => {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as { records: Record_[] }

  const newest = new Map<string, Record_>()
  for (const record of registry.records) {
    if (record.kind !== 'topic-pack') continue
    if (!record.pack_id.startsWith(FAMILY_PREFIX)) continue
    const current = newest.get(record.pack_id)
    if (!current || newer(record.version, current.version)) newest.set(record.pack_id, record)
  }

  const packs = [...newest.values()].sort((left, right) => left.pack_id.localeCompare(right.pack_id))
  assert.ok(
    packs.length >= 2,
    `this gate exists to compare Deep Time Field Record packs against each other and found ${packs.length}; if the wave really has one pack again, say so here rather than letting the gate pass on an empty comparison`,
  )

  const loaded = await Promise.all(packs.map(async record => ({
    record,
    suffix: record.pack_id.slice(FAMILY_PREFIX.length),
    subjects: (await loadTopic(record)).subjects,
  })))

  // --- rules 1 and 2: pairwise ---
  const adjudicated = new Map(ADJUDICATED.map(entry => [`${entry.earlier} ${entry.later}`, entry]))
  const usedRulings = new Set<string>()
  let comparisons = 0
  const problems: string[] = []

  for (let i = 0; i < loaded.length; i += 1) {
    for (let j = i + 1; j < loaded.length; j += 1) {
      const earlier = loaded[i]!
      const later = loaded[j]!
      for (const a of earlier.subjects) {
        for (const b of later.subjects) {
          comparisons += 1
          const identical = signature(a) === signature(b)
          const score = jaccard(contentTokens(a), contentTokens(b))
          const shared = [...anchors(a)].filter(anchor => anchors(b).has(anchor))
          if (!identical && score < NEAR_DUPLICATE && shared.length === 0) continue

          const where = `${earlier.suffix} "${a}" vs ${later.suffix} "${b}"`
          if (identical) {
            problems.push(`${where}: the same subject written twice (identical normalised form) — this is never adjudicable`)
            continue
          }
          const forward = adjudicated.get(`${a} ${b}`)
          const backward = adjudicated.get(`${b} ${a}`)
          const ruling = forward ?? backward
          if (!ruling) {
            problems.push(
              `${where}: overlap ${(score * 100).toFixed(0)}%${shared.length ? `, shared name(s) ${shared.join(', ')}` : ''} — ` +
              'add a ruling to ADJUDICATED saying which pack owns what, or re-author one of the subjects',
            )
            continue
          }
          usedRulings.add(`${ruling.earlier} ${ruling.later}`)
          const borrower = ruling.later === b ? b : a
          if (!carriesSystemWord(borrower)) {
            problems.push(
              `${where}: adjudicated, but "${borrower}" carries no system or record word, so the ruling's own reason does not hold — ` +
              'the boundary is that the borrowing pack treats the ocean as a system, and the subject has to say so',
            )
          }
        }
      }
    }
  }

  // --- rule 3: the shared boundary events ---
  for (const event of BOUNDARY_EVENTS) {
    for (const pack of loaded) {
      if (pack.suffix === event.owner) continue
      for (const subject of pack.subjects) {
        if (!subject.toLowerCase().includes(event.token)) continue
        if (carriesSystemWord(subject)) continue
        problems.push(
          `${pack.suffix} "${subject}" names ${event.token} (${event.note}), which ${event.owner} owns, ` +
          'without declaring itself a system or record treatment',
        )
      }
    }
  }

  // --- the exclusions, held by not authoring at all ---
  for (const exclusion of HELD_BY_EXCLUSION) {
    const pack = loaded.find(entry => entry.suffix === exclusion.forbiddenIn)
    if (!pack) continue
    for (const subject of pack.subjects) {
      const lower = subject.toLowerCase()
      for (const token of exclusion.tokens) {
        if (!lower.includes(token)) continue
        problems.push(
          `${pack.suffix} "${subject}" reaches into ${exclusion.category}, which this wave left entirely to ` +
          `${exclusion.ownedBy}; either re-author it or move the category out of HELD_BY_EXCLUSION with a reason`,
        )
      }
    }
  }

  // --- the rulings must stay honest ---
  for (const entry of ADJUDICATED) {
    const earlierPack = loaded.find(pack => pack.subjects.includes(entry.earlier))
    const laterPack = loaded.find(pack => pack.subjects.includes(entry.later))
    assert.ok(
      earlierPack && laterPack,
      `ADJUDICATED names a subject no pack authors any more (${!earlierPack ? entry.earlier : entry.later}); ` +
      'a ruling that protects nothing hides the next real overlap — delete it or fix the wording',
    )
    assert.ok(
      usedRulings.has(`${entry.earlier} ${entry.later}`),
      `ADJUDICATED rules on "${entry.earlier}" vs "${entry.later}", but the gate no longer flags that pair; ` +
      'the ruling is dead weight — delete it',
    )
  }

  assert.equal(problems.length, 0, `\n  - ${problems.join('\n  - ')}\n`)
  assert.ok(comparisons >= 10000, `this gate must still be comparing whole subject lists; it made only ${comparisons} comparisons`)
})
