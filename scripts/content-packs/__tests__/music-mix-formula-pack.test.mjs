/**
 * Music Mix is a Content Pack (owner, 2026-10-29: "no custom, no built in, all
 * from packs").
 *
 * It was the last pack-less Formula, and the reason was not creative: the
 * 2026-09-01 ledger closed it as runtime-only because the music-video subsystem
 * owned the workflow and a Formula could not carry a music format. A music
 * Formula now carries its own `music_format` block (2026-10-25, Coffee Jazz), so
 * the pack is possible and the reason no longer holds.
 *
 * The substance of this Formula IS the music block — nine registers and ninety
 * worlds — so the fence proves that block crosses the pack boundary exactly, that
 * the app still reads it as `musicFormat`, and that the scaffolded Formula-contract
 * fields say plainly that the music subsystem does not read them.
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
const SOURCE = new URL('../../../content-packs/free-starters/formula/music-mix/', import.meta.url)

const PACK_ID = 'com.storystudio.pack.formula.music-mix'
const ITEM_ID = 'com.storystudio.formula.music-mix'
/** The release that first taught the pack schema `music_format` (Coffee Jazz). */
const FLOOR = '1.4.359'

const unregister = register()
const { ContentPackDocumentSchema } = await import('../../../electron/server/content-packs/schemas.ts')
const { contentPackDocumentToNiche } = await import('../../../electron/server/content-packs/legacy-adapters.ts')
unregister()

const json = async url => JSON.parse(await readFile(url, 'utf8'))
const document = () => json(new URL('content/series-formula.json', SOURCE))
const manifest = () => json(new URL('pack.json', SOURCE))
const builtin = () => json(new URL('../../../electron/server/niches/music-mix.json', import.meta.url))
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

test('the Music Mix pack is registered, authored, and pinned to the release that can read a music block', async () => {
  const registry = await json(REGISTRY)
  const record = registry.records.find(row => row.pack_id === PACK_ID)
  assert.ok(record, `${PACK_ID} must be registered`)
  assert.equal(record.status, 'authored')
  assert.equal(record.version, '1.0.0')
  assert.equal(record.kind, 'series-formula')
  assert.equal(record.item_id, ITEM_ID)
  assert.equal(record.source_path, 'content-packs/free-starters/formula/music-mix')
  assert.deepEqual(record.dependencies, [])
  assert.equal(record.min_app_version_status, 'fixed')
  assert.equal(record.min_app_version, FLOOR)

  const declared = await manifest()
  assert.equal(declared.pack_id, PACK_ID)
  assert.equal(declared.version, record.version)
  assert.equal(declared.min_app_version, FLOOR)
  assert.equal(declared.entitlement.family, record.stocking_proposal.family.id)
  assert.equal(declared.entitlement.sku, record.stocking_proposal.sku.id)
})

test('the pack carries the built-in music format byte for byte', async () => {
  const doc = await document()
  ContentPackDocumentSchema.parse(doc)
  assert.equal(doc.id, ITEM_ID)
  assert.equal(doc.kind, 'series-formula')

  const legacy = await builtin()
  assert.equal(
    createHash('sha256').update(JSON.stringify(doc.music_format)).digest('hex'),
    createHash('sha256').update(JSON.stringify(legacy.musicFormat)).digest('hex'),
    'the music block must stay identical to the built-in it was adopted from',
  )
  assert.equal(doc.music_format.worlds.length, 90)
  assert.equal(Object.keys(doc.music_format.registers).length, 9)

  const niche = contentPackDocumentToNiche(doc)
  assert.deepEqual(plain(niche.musicFormat), plain(legacy.musicFormat), 'the app still reads it as musicFormat')
  assert.equal(niche.name, legacy.name)
  assert.equal(niche.description, legacy.description)
  assert.equal(niche.tagline, legacy.tagline)
  assert.deepEqual(niche.exampleTopics, legacy.exampleTopics)
  assert.equal(niche.introDefaults?.wordTarget, legacy.introDefaults.wordTarget)
  assert.deepEqual(plain(niche.introDefaults?.beats), plain(legacy.introDefaults.beats))
})

test('the scaffolded Formula fields say the music subsystem does not read them', async () => {
  const doc = await document()
  assert.ok(doc.narrative_rules.length, 'the shared Formula contract requires narrative rules')
  assert.ok(doc.title_rules.length)
  assert.ok(
    doc.script_structure.additional_rules.some(rule => /not read by the music subsystem/.test(rule)),
    'a music Formula must not pretend its script rules drive a music episode',
  )
  // Nothing in the shared fields claims a rhythm or a written script.
  assert.equal(/decides? the .*rhythm/i.test(JSON.stringify(doc)), false)
})

test('the ledger names Music Mix as an adopted pack, superseding the runtime-only closure', async () => {
  const ledger = await json(LEDGER)
  const entry = ledger.dispositions.find(row => row.legacy_key === 'niche:music-mix')
  assert.ok(entry)
  assert.equal(entry.source, 'electron/server/niches/music-mix.json')
  assert.equal(entry.disposition, 'authored-standalone')
  assert.equal(entry.target.kind, 'registry-record')
  assert.equal(entry.target.pack_id, PACK_ID)
  assert.equal(entry.target.version, '1.0.0')
  assert.equal(entry.target.status, 'authored')
  assert.equal(entry.target.source_path, 'content-packs/free-starters/formula/music-mix')
  assert.match(entry.note, /2026-10-29/, 'the note must say when and why the 2026-09-01 closure was superseded')
})

test('the Music Mix pack builds reproducibly and validates with an ephemeral key', async t => {
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')
  const temporary = await mkdtemp(join(tmpdir(), 'story-music-mix-pack-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(temporary, 'private.pem')
  const publicKeyPath = join(temporary, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const release = { keyId: 'com.storystudio.key.test' }
  const source = decodeURIComponent(SOURCE.pathname)
  const first = join(temporary, 'music-mix-1.sspack')
  const second = join(temporary, 'music-mix-2.sspack')
  await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: first, ...release })
  await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: second, ...release })
  const [a, b] = await Promise.all([readFile(first), readFile(second)])
  assert.deepEqual(a, b, 'Music Mix must build reproducibly')
  await validateContentPack({ archivePath: first, keyId: release.keyId, publisherId: 'com.storystudio', publicKeyPath })
})
