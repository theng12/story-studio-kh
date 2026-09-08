/**
 * The Baroque Myth collection — three standalone packs authored 2026-09-08 for
 * a sleep channel that tells one god, one hero or one epic ENTIRE in a single
 * sitting, across fifty cycles from eight traditions. One reservation batch
 * (revision 221), one receipt, three lifecycle promotions (revisions 227-229).
 *
 * Two of the three declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and no owner authorisation
 * was given for this pass. Nothing was fabricated and nothing was stubbed, so
 * this file pins the honest state instead: every declared preview path is named
 * by the collection's PREVIEW-PROVENANCE.md, and any preview byte that HAS
 * landed must meet the contract.
 *
 * The three-preview rule for Visual Styles, set by the owner on 2026-09-08 and
 * applied to Royal History first, is asserted here too, so a later edit cannot
 * quietly drop this collection back to one.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/baroque-myth')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:03cc8b1e2dba20c873339ea814f8a72b5a13ce624870a9714ded44f476f6dee9'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'baroque-mythological-sky', docs: ['visual-style.json'] },
  {
    kind: 'lettering-style',
    seg: 'lettering',
    slug: 'spaced-light-serif-edition-label',
    docs: ['spaced-light-serif-edition-label.json'],
    multi: true,
  },
  { kind: 'topic-pack', seg: 'topic', slug: 'gods-heroes-and-epics', docs: ['topic-pack.json'] },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/baroque-mythological-sky/assets/baroque-mythological-sky-hero.webp': [1672, 941],
  'style/baroque-mythological-sky/assets/baroque-mythological-sky-scene.webp': [1672, 941],
  'style/baroque-mythological-sky/assets/baroque-mythological-sky-face.webp': [1672, 941],
  'lettering/spaced-light-serif-edition-label/assets/spaced-light-serif-edition-label.webp': [1024, 576],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Baroque Myth pack is an authored, receipt-bound standalone source', async () => {
  const registry = await json(REGISTRY)
  for (const p of PACKS) {
    const packId = `com.storystudio.pack.${p.seg}.${p.slug}`
    const itemId = `com.storystudio.${p.seg}.${p.slug}`
    const record = registry.records.find(r => r.pack_id === packId && r.version === '1.0.0')
    assert.ok(record, `${packId} must be registered`)
    assert.equal(record.receipt_ref, RECEIPT)
    assert.equal(record.status, 'authored')
    assert.equal(record.kind, p.kind)
    if (p.multi) {
      assert.deepEqual(record.item_ids, [itemId], `${packId} records its item set`)
      assert.equal(record.item_id, undefined)
    } else {
      assert.equal(record.item_id, itemId)
      assert.equal(record.item_ids, undefined)
    }
    assert.equal(record.source_path, `content-packs/baroque-myth/${p.seg}/${p.slug}`)
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.bundle_id, undefined, 'no Channel Kit membership')

    const manifest = await json(join(ROOT, p.seg, p.slug, 'pack.json'))
    assert.equal(manifest.pack_format, 1)
    assert.equal(manifest.pack_id, packId)
    assert.equal(manifest.publisher_id, 'com.storystudio')
    assert.equal(manifest.key_id, '{{KEY_ID}}')
    assert.equal(manifest.version, '1.0.0')
    assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(manifest.lifecycle, 'active')
    assert.ok(manifest.changelog?.length > 0, `${packId} states what its first release ships`)
    assert.deepEqual(manifest.entitlement, {
      sku: `com.storystudio.sku.${p.seg}.${p.slug}`,
      family: `com.storystudio.family.${p.seg}.${p.slug}`,
    })
    assert.deepEqual(manifest.dependencies, [])
    assert.equal(manifest.bundles, undefined, 'a creative component declares no bundle')

    assert.deepEqual((await readdir(join(ROOT, p.seg, p.slug, 'content'))).sort(), p.docs)
    for (const name of p.docs) {
      const doc = await json(join(ROOT, p.seg, p.slug, 'content', name))
      assert.equal(doc.kind, p.kind)
      assert.equal(doc.id, itemId)
      assert.equal(doc.schema_version, 1)
      for (const [keyPath, value] of meaningfulStrings(doc)) {
        assert.equal(markIn(value), undefined, `${packId} ${keyPath} carries a third-party mark`)
      }
    }
  }
})

test('the visual style is cloud, diagonal, drapery, attribute and chiaroscuro', async () => {
  const style = await json(join(ROOT, 'style/baroque-mythological-sky/content/visual-style.json'))
  assert.equal(style.name, 'Baroque Mythological Sky')
  assert.deepEqual(style.compatible_formula_ids, [FORMULA_ID])
  // The six things the look is bought for. Losing any one turns it into a
  // generic old-master style, of which the catalogue already has several.
  assert.match(style.style_bible, /banks of cloud|the ground the figures rest on is cloud itself/i)
  assert.match(style.style_bible, /everything moves on a long diagonal/i)
  assert.match(style.style_bible, /billow and snap around the figures in deep crimson/i)
  assert.match(style.style_bible, /small winged cherubs cluster at the edges/i)
  assert.match(style.style_bible, /one plainly readable attribute/i)
  assert.match(style.style_bible, /strong chiaroscuro from a single high source/i)
  // The medium, and the manner the owner named.
  assert.match(style.style_bible, /oil on a coarse primed canvas or as fresco/i)
  assert.match(style.style_bible, /in the manner of Rubens and of Giulio Romano/i)
  // The palette contract: warm flesh against stormy or gilded sky.
  assert.match(style.style_bible, /stormy in slate, bruised violet and grey-green, or gilded in amber/i)
  // It is a SLEEP look, and the bible says so, which is why the drama is in the
  // composition rather than in a face.
  assert.match(style.style_bible, /the drama sits in the composition and the light rather than in a face/i)
  for (const rejected of ['photograph', 'flat vector', 'anime', 'modern objects',
    'muted grey palette', 'text', 'close cropped screaming face']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the visual style declares three previews — hero, empty scene, and hardest case', async () => {
  const doc = await json(join(ROOT, 'style/baroque-mythological-sky/content/visual-style.json'))
  assert.deepEqual(doc.preview_assets, [
    'assets/baroque-mythological-sky-hero.webp',
    'assets/baroque-mythological-sky-scene.webp',
    'assets/baroque-mythological-sky-face.webp',
  ], 'the style declares the three-preview set the owner asked for')
})

test('the lettering style is a font axis: spaced light serif under a small-cap edition line', async () => {
  const doc = await json(join(ROOT,
    'lettering/spaced-light-serif-edition-label/content/spaced-light-serif-edition-label.json'))
  assert.equal(doc.name, 'Spaced Light Serif with Edition Label')
  assert.equal(doc.axis, 'font', 'this is a letterform, not a treatment')
  // The four things the owner specified, all of which have to reach the prompt.
  assert.match(doc.phrase, /thin light-weight serif capitals/i)
  assert.match(doc.phrase, /tracked very wide/i)
  assert.match(doc.phrase, /small capitals/i)
  assert.match(doc.phrase, /edition or series tag/i)
  assert.match(doc.phrase, /flat dark band|across a flat dark band|on a flat dark band/i)
  // Flat means flat: no effects anywhere, or the two-line hierarchy collapses.
  assert.match(doc.phrase, /no outline, no bevel, no gradient, no drop shadow and no glow/i)
  assert.deepEqual(doc.preview_assets, ['assets/spaced-light-serif-edition-label.webp'],
    'a lettering style ships exactly the swatch a buyer looks at')
  // A built-in lettering style shares this id namespace, so a pack must not
  // shadow one.
  const builtins = await readFile(join(process.cwd(), 'electron/server/models/thumbnail-styles.ts'), 'utf8')
  const slug = doc.id.split('.').pop()
  assert.ok(!new RegExp(`['"\`]${slug}['"\`]\\s*:`).test(builtins), `${doc.id} shadows a built-in lettering key`)
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/gods-heroes-and-epics/content/topic-pack.json'))
  assert.deepEqual(doc.compatible_formula_ids, [FORMULA_ID])
  assert.equal(doc.subjects.length, 50)
  assert.equal(doc.max_siblings_per_subject, 20)
  assert.equal(doc.coverage_profiles.length, 50)
  assert.deepEqual(doc.coverage_profiles.map(p => p.subject), doc.subjects)
  const pairs = new Set(); const full = new Set()
  let tuples = 0
  for (const profile of doc.coverage_profiles) {
    assert.equal(profile.tuples.length, 20, `${profile.subject} declares twenty slots`)
    assert.equal(new Set(profile.tuples.map(t => t.episode_object)).size, 20, `${profile.subject} objects unique`)
    assert.equal(new Set(profile.tuples.map(t => t.mechanism)).size, 20, `${profile.subject} mechanisms unique`)
    for (const t of profile.tuples) {
      tuples += 1
      pairs.add(`${t.episode_object}|${t.mechanism}`)
      full.add(JSON.stringify(t))
    }
  }
  assert.equal(tuples, 1000)
  assert.equal(pairs.size, 1000, 'object|mechanism pairs unique across the pack')
  assert.equal(full.size, 1000, 'complete tuples unique across the pack')
})

test('the topic pack tells one cycle entire, in order, and never adjudicates a religion', async () => {
  const doc = await json(join(ROOT, 'topic/gods-heroes-and-epics/content/topic-pack.json'))
  // The promise the pack is sold on: a whole cycle, in order, at one pace.
  assert.match(doc.prompt_context, /one god, one hero or one epic entire/i)
  assert.match(doc.prompt_context, /the chapter titles are the story in order/i)
  assert.match(doc.prompt_context, /keep the tempo even and low the whole way through/i)
  // The rule that makes a world-mythology pack safe to sell: describe, never
  // adjudicate, and never condescend.
  assert.match(doc.prompt_context, /without ever\s+claiming or denying that any of it occurred/i)
  assert.match(doc.prompt_context, /somebody's religion and several still are/i)
  assert.match(doc.prompt_context, /leave the disagreement standing/i)
  assert.match(doc.prompt_context, /Invent nothing/i)
  for (const shape of [/No invented episodes/i, /No claim that a myth is true or false/i,
    /No mockery, no debunking tone/i, /No living people are named/i,
    /No third-party characters/i, /No sensational treatment/i,
    /No hooks, cliffhangers/i, /self-contained/i, /No harmonising of variants/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  assert.ok(doc.evidence_expectations.some(entry => /give both and say they disagree/i.test(entry)))
  assert.ok(doc.evidence_expectations.some(entry => /part of a living religion/i.test(entry)))
  // The slots are the story in sequence, so shuffling them is forbidden by the
  // compatibility rules rather than left to chance.
  assert.ok(doc.compatibility_rules.some(rule => /in order rather than at random/i.test(rule)))
  assert.ok(doc.compatibility_rules.some(rule => /promises a revelation/i.test(rule)))
})

test('the fifty cycles cover the traditions the collection claims', async () => {
  const doc = await json(join(ROOT, 'topic/gods-heroes-and-epics/content/topic-pack.json'))
  const all = doc.subjects.join(' | ')
  // The brief named eight traditions "and other cycles". These probes are the
  // cheapest way to catch a later edit that quietly narrows the pack back to
  // one or two mythologies.
  for (const probe of [/Zeus/, /Herakles/, /Odysseus/, /Aeneas/, /Odin/, /Thor/, /Osiris/, /Isis/,
    /Gilgamesh/, /Inanna/, /Shiva/, /Rama/, /Krishna/, /Mahabharata/, /Lugh/, /Cú Chulainn/,
    /mabinogi/, /Amaterasu/, /Monkey King/, /Nüwa/, /Quetzalcoatl/, /Maya underworld/,
    /Anansi/, /Kalevala/, /Rostam/, /Manas/]) {
    assert.match(all, probe, `the subject list must still carry ${probe}`)
  }
  // Every subject is one named cycle rather than a list category, which is the
  // whole difference between this pack and a themed topic pack. Two checks: no
  // subject is framed as a category of things, and most say plainly that the
  // cycle is told complete.
  for (const subject of doc.subjects) {
    assert.doesNotMatch(subject, /^(the )?(deadliest|worst|dumbest|strangest|obscure|greatest|most)\b/i,
      `"${subject}" is framed as a list category rather than as one cycle`)
    assert.doesNotMatch(subject, /\b(creatures|monsters|weapons|wars|disasters|diseases) (of|from|about)\b/i,
      `"${subject}" is framed as a collection rather than as one cycle`)
  }
  const whole = doc.subjects.filter(s => /entire|whole|every|complete|in order|from .+ (to|of) /i.test(s))
  assert.ok(whole.length >= 35, `only ${whole.length} subjects state that the cycle is told complete`)
})

test('no topic line is shared with any other authored collection', async () => {
  const FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']
  const linesOf = doc => new Set(FIELDS.flatMap(field => doc[field] ?? []))
  const mine = linesOf(await json(join(ROOT, 'topic/gods-heroes-and-epics/content/topic-pack.json')))
  assert.ok(mine.size > 4000, 'the pack contributes its own authored lines')
  for (const [collection, slug] of [
    ['gory-cartoon-history', 'obscure-history-horrors'],
    ['royal-history', 'rulers-and-dynasties'],
    ['lost-voyage', 'lost-voyages'],
    ['golden-epic', 'empires-and-civilisations-entire'],
    ['midnight-archives', 'the-real-story-is-worse'],
    ['timeless-dreams', 'legends-across-every-civilisation'],
    ['sleep-theories', 'mysteries-and-cover-ups'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    const shared = [...mine].filter(line => other.has(line))
    assert.deepEqual(shared, [], `no line may be shared with ${collection}`)
  }
})

test('every declared preview is named by the provenance record, and any that exists meets the contract', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  const declared = new Set()
  for (const p of PACKS) {
    for (const name of p.docs) {
      const doc = await json(join(ROOT, p.seg, p.slug, 'content', name))
      for (const asset of doc.preview_assets ?? []) declared.add(`${p.seg}/${p.slug}/${asset}`)
    }
  }
  assert.deepEqual([...declared].sort(), Object.keys(PREVIEW_CONTRACT).sort())

  for (const [rel, [width, height]] of Object.entries(PREVIEW_CONTRACT)) {
    assert.ok(provenance.includes(rel.split('/').pop()), `provenance must name ${rel}`)
    assert.ok(provenance.includes(`${width}x${height}`), `provenance must state ${width}x${height}`)
    const path = join(ROOT, rel)
    if (!await exists(path)) continue
    const buf = await readFile(path)
    assert.ok(buf.byteLength > 20 * 1024, `${rel} must exceed the 20 KB floor`)
    const meta = await sharp(buf).metadata()
    assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height },
      { format: 'webp', width, height }, `${rel} must decode to the declared contract`)
    const digest = createHash('sha256').update(buf).digest('hex')
    assert.ok(provenance.includes(digest), `provenance must record the digest of ${rel}`)
    assert.ok(provenance.includes(`${buf.byteLength}`), `provenance must record the byte count of ${rel}`)
  }
})

test('the provenance record states why nothing was generated, how to generate it, and what to refuse', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'baroque-myth-previews-1',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The two opposite text rules this collection needs: no word at all in the
  // three style previews, and exact spelling in the lettering swatch.
  assert.match(provenance, /Original subjects only/)
  assert.match(provenance, /must carry no word in any language/)
  assert.match(provenance, /spelled exactly as written/)
  assert.match(provenance, /must be rejected rather than committed/)
  // One run id, and its body stays well inside the seven-prompt ceiling.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
  assert.ok(prompts.length <= 7, 'a single run id carries at most seven prompts')
  const bodies = provenance.match(/^> .+$/gm) ?? []
  assert.equal(bodies.length, prompts.length, 'every prompt has exactly one body')
  assert.ok(Buffer.byteLength(JSON.stringify(bodies)) < 16 * 1024, 'the request body stays under the 16 KiB cap')
})
