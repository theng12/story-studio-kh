/**
 * Quote Shorts and Still Posts are Content Packs, not built-ins (owner,
 * 2026-10-29: "no custom, no built in, all from packs").
 *
 * Both were adopted from their built-in Formula file with NO creative change, so
 * this fence is two-sided:
 *
 *   - the pack carries the built-in's own words: every field the runtime Niche
 *     exposes reads the same through the pack as it did through the .json file;
 *   - the two things a Formula can only say from a pack — a seconds-precision
 *     length (1.4.369) and the Still Posts block — survive the pack boundary, so
 *     adopting the built-in does not quietly turn a Still Posts channel into a
 *     video channel with no writer voice.
 *
 * A parity test that only compared a handful of fields could still pass over a
 * dropped `stillPostsFormat` or a lost length range, so the shared-field set is
 * compared whole, and the deliberate differences are named one by one.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../', import.meta.url)
const REGISTRY = new URL('../../../content-packs/authoring-registry.json', import.meta.url)
const LEDGER = new URL('../../../content-packs/legacy-migration-dispositions.json', import.meta.url)

/** The release that first understands the seconds length fields and the pack's
 *  Still Posts block. A pack that needs it must say so itself rather than raise
 *  the shared floor and hide every other pack from older builds. */
const FLOOR = '1.4.369'

const PACKS = [
  {
    slug: 'quote-shorts',
    builtin: 'electron/server/niches/quote-shorts.json',
    packId: 'com.storystudio.pack.formula.quote-shorts',
    itemId: 'com.storystudio.formula.quote-shorts',
  },
  {
    slug: 'still-posts',
    builtin: 'electron/server/niches/still-posts.json',
    packId: 'com.storystudio.pack.formula.still-posts',
    itemId: 'com.storystudio.formula.still-posts',
  },
]

const unregister = register()
const { ContentPackDocumentSchema } = await import('../../../electron/server/content-packs/schemas.ts')
const { contentPackDocumentToNiche } = await import('../../../electron/server/content-packs/legacy-adapters.ts')
unregister()

const json = async url => JSON.parse(await readFile(url, 'utf8'))
/** Drop `undefined` keys so a mapped field that is absent compares equal to a
 *  built-in field that was never there, as deepStrictEqual would not. */
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const sourceUrl = (slug, name) => new URL(`../../../content-packs/free-starters/formula/${slug}/${name}`, import.meta.url)
const document = slug => json(sourceUrl(slug, 'content/series-formula.json'))
const manifest = slug => json(sourceUrl(slug, 'pack.json'))

test('both packs are registered, authored, and pinned to the release that can read them', async () => {
  const registry = await json(REGISTRY)
  for (const { slug, packId, itemId } of PACKS) {
    const record = registry.records.find(row => row.pack_id === packId)
    assert.ok(record, `${packId} must be registered`)
    assert.equal(record.version, '1.0.0')
    assert.equal(record.status, 'authored')
    assert.equal(record.kind, 'series-formula')
    assert.equal(record.item_id, itemId)
    assert.equal(record.source_path, `content-packs/free-starters/formula/${slug}`)
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.min_app_version_status, 'fixed', `${packId} states its own floor`)
    assert.equal(record.min_app_version, FLOOR)

    const declared = await manifest(slug)
    assert.equal(declared.pack_id, packId)
    assert.equal(declared.version, record.version)
    // The registry reconciles the manifest against its record; a floor that
    // drifted between the two would fail `content-pack:registry -- validate`.
    assert.equal(declared.min_app_version, record.min_app_version)
    assert.equal(declared.entitlement.family, record.stocking_proposal.family.id)
    assert.equal(declared.entitlement.sku, record.stocking_proposal.sku.id)
    assert.equal(declared.lifecycle, 'active')
  }
})

test('both documents parse and keep the built-in Formula word for word', async () => {
  for (const { slug, builtin, itemId } of PACKS) {
    const doc = await document(slug)
    ContentPackDocumentSchema.parse(doc)
    assert.equal(doc.id, itemId)
    assert.equal(doc.kind, 'series-formula')

    const niche = contentPackDocumentToNiche(doc)
    const legacy = await json(new URL(`../../../${builtin}`, import.meta.url))

    // Every shared field, compared whole. `id` is the qualified pack item, the
    // narrator-style ids are lowercased (a Content Pack id must be a local
    // slug; labels and every description are unchanged), and `kind` is stated
    // rather than implied.
    assert.equal(niche.name, legacy.name)
    assert.equal(niche.description, legacy.description)
    assert.equal(niche.tagline, legacy.tagline)
    assert.equal(niche.formulaFamily, legacy.formulaFamily)
    assert.equal(niche.perspectivePolicy, legacy.perspectivePolicy)
    assert.deepEqual(plain(niche.narrativeQualityContract), plain(legacy.narrativeQualityContract))
    assert.equal(niche.aspectRatio, legacy.aspectRatio)
    assert.equal(niche.startingMusicVolume, legacy.startingMusicVolume)
    assert.deepEqual(plain(niche.ideaAxes), plain(legacy.ideaAxes))
    assert.deepEqual(niche.exampleTopics, legacy.exampleTopics)
    assert.deepEqual(plain(niche.vocabulary), plain(legacy.vocabulary))
    assert.equal(niche.audienceHint, legacy.audienceHint)
    assert.deepEqual(niche.youtubeTagsHint, legacy.youtubeTagsHint)
    assert.equal(niche.metadataTitleStyleHint, legacy.metadataTitleStyleHint)
    assert.deepEqual(niche.titleShapeRules, legacy.titleShapeRules)
    assert.deepEqual(niche.titleLengthRange, legacy.titleLengthRange)
    assert.equal(niche.structuralVariety, legacy.structuralVariety)
    assert.deepEqual(plain(niche.scriptStructure), plain(legacy.scriptStructure))
    assert.equal(niche.scriptContext, legacy.scriptContext)
    assert.equal(niche.scriptSystemPromptRole, legacy.scriptSystemPromptRole)
    assert.equal(niche.scriptClosingHint, legacy.scriptClosingHint)
    assert.equal(niche.ideaSystemPromptRole, legacy.ideaSystemPromptRole)
    assert.equal(niche.ideaGuidanceText, legacy.ideaGuidanceText)
    assert.deepEqual(
      (niche.narratorStyles ?? []).map(style => [style.id, style.label, style.description]),
      (legacy.narratorStyles ?? []).map(style => [style.id.toLowerCase(), style.label, style.description]),
    )
    assert.equal(niche.defaultNarratorStyleId, legacy.defaultNarratorStyleId.toLowerCase())
    assert.deepEqual(plain(niche.stillPostsFormat), plain(legacy.stillPostsFormat))
  }
})

test('the Quote Shorts pack carries its own seconds-precision length', async () => {
  const niche = contentPackDocumentToNiche(await document('quote-shorts'))
  assert.equal(niche.aspectRatio, '9:16')
  assert.equal(niche.scriptStructure.defaultLengthSeconds, 45, 'the Formula says 45 s, not 1 minute')
  assert.deepEqual(niche.scriptStructure.lengthSecondsRange, [10, 60])
  assert.equal(niche.scriptStructure.randomizeLength, true)
  assert.equal(niche.startingMusicVolume, 55)
})

test('the Still Posts pack keeps the block that makes a channel a Still Posts channel', async () => {
  const niche = contentPackDocumentToNiche(await document('still-posts'))
  const builtin = await json(new URL('../../../electron/server/niches/still-posts.json', import.meta.url))
  assert.deepEqual(plain(niche.stillPostsFormat), plain(builtin.stillPostsFormat))
  assert.equal(niche.stillPostsFormat?.enabled, true)
  assert.ok(niche.stillPostsFormat?.writeSystemPromptRole)
  assert.equal(niche.aspectRatio, '1:1')
  // No narration and no seconds length: a post is one line on one picture.
  assert.equal(niche.scriptStructure.defaultLengthSeconds, undefined)
})

test('the ledger names both adopted built-ins as authored packs', async () => {
  const ledger = await json(LEDGER)
  for (const { slug, packId, builtin } of PACKS) {
    const entry = ledger.dispositions.find(row => row.legacy_key === `niche:${slug}`)
    assert.ok(entry, `niche:${slug} must keep its disposition`)
    assert.equal(entry.source, builtin)
    assert.equal(entry.disposition, 'authored-standalone')
    assert.equal(entry.target.kind, 'registry-record')
    assert.equal(entry.target.pack_id, packId)
    assert.equal(entry.target.version, '1.0.0')
    assert.equal(entry.target.status, 'authored')
    assert.equal(entry.target.source_path, `content-packs/free-starters/formula/${slug}`)
  }
})

test('both packs build reproducibly and validate with an ephemeral key', async t => {
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')
  const temporary = await mkdtemp(join(tmpdir(), 'story-quote-still-packs-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(temporary, 'private.pem')
  const publicKeyPath = join(temporary, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const release = { keyId: 'com.storystudio.key.test' }

  for (const { slug } of PACKS) {
    const source = decodeURIComponent(new URL(`../../../content-packs/free-starters/formula/${slug}`, import.meta.url).pathname)
    // Both packs declare their own floor, so the builder must be given no
    // release override at all.
    const declared = await manifest(slug)
    assert.notEqual(declared.min_app_version, '{{MIN_APP_VERSION}}')
    const first = join(temporary, `${slug}-1.sspack`)
    const second = join(temporary, `${slug}-2.sspack`)
    await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: first, ...release })
    await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: second, ...release })
    const [a, b] = await Promise.all([readFile(first), readFile(second)])
    assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'), `${slug} must build reproducibly`)
    await validateContentPack({ archivePath: first, keyId: release.keyId, publisherId: 'com.storystudio', publicKeyPath })
  }
})
