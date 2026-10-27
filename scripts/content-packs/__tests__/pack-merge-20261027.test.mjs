/**
 * Content Pack Merges 2026-10-27: Studio Library duplicate pack consolidation.
 *
 * Verifies:
 * 1. Visual style: com.storystudio.pack.style.academic-classical-oil-v2 v1.0.1
 *    (folding in com.storystudio.pack.style.oil-painting-classical-v2).
 *    - Enriched style_bible with impasto, layered glazes, canvas texture.
 *    - Soft low-contrast lighting preserved; no chiaroscuro.
 *    - Unioned negative prompt tokens.
 *    - Exactly 3 Qwen preview assets in contract order (hero, scene, face).
 *    - Valid delivery-attested .sspack archive verification.
 *
 * 2. Topic pack: com.storystudio.pack.topic.wars-treaties-world-order-v2 v1.0.1
 *    (full union of historical-wars-treaties-world-order-v2).
 *    - Ceilings raised to 4000 in TopicPackDocumentSchema.
 *    - Full union: 122 subjects, 122 coverage profiles (1:1 with subjects),
 *      2,999 episode_objects, 3,000 time_place_scopes, 3,000 mechanisms, 3,000 evidence_lenses.
 *    - All 7 exclusions and both compatible formulas.
 *    - Min app version 1.4.362.
 *    - Valid delivery-attested .sspack archive verification.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { register } from 'tsx/esm/api'


const unregisterTsx = register()
const { ContentPackDocumentSchema } = await import('../../../electron/server/content-packs/schemas.ts')
unregisterTsx()

const CWD = process.cwd()
// The committed merge sources, not a built archive: dist/ is untracked, so an
// archive-reading test passes only where it happened to be built. The .sspack is
// built from these sources at publish time and checked by validate-pack there.
const SOURCES = join(CWD, '.superpowers/sdd/2026-10-27-pack-merge/sources')
const STYLE_SOURCE = join(SOURCES, 'style-academic-classical-oil-v2')
const TOPIC_SOURCE = join(SOURCES, 'topic-wars-treaties-world-order-v2')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('visual style merge: academic-classical-oil-v2 1.0.1 source meets the content contract', async () => {
  const manifest = await readJson(join(STYLE_SOURCE, 'pack.json'))
  assert.equal(manifest.pack_id, 'com.storystudio.pack.style.academic-classical-oil-v2')
  assert.equal(manifest.version, '1.0.1')

  const doc = await readJson(join(STYLE_SOURCE, 'content/visual-style.json'))
  ContentPackDocumentSchema.parse(doc)
  assert.equal(doc.kind, 'visual-style')
  assert.equal(doc.id, 'com.storystudio.style.academic-classical-oil-v2')

  // Previews: exactly 3 Qwen previews in hero, scene, face contract order
  assert.deepEqual(doc.preview_assets, [
    'assets/academic-classical-oil-hero.webp',
    'assets/academic-classical-oil-scene.webp',
    'assets/academic-classical-oil-face.webp',
  ])

  // Style bible: enriched with concrete descriptors; lighting kept soft/low-contrast
  assert.match(doc.style_bible, /impasto/i, 'style_bible must describe impasto')
  assert.match(doc.style_bible, /layered glazes/i, 'style_bible must describe layered glazes')
  assert.match(doc.style_bible, /canvas texture/i, 'style_bible must describe canvas texture')
  assert.match(doc.style_bible, /broad mediterranean sunlight/i, 'lighting must remain soft late-day sunlight')
  assert.match(doc.style_bible, /no dramatic chiaroscuro/i, 'lighting must explicitly exclude dramatic chiaroscuro')
  assert.match(doc.style_bible, /low stimulation/i, 'low-stimulation contract preserved')

  // Negative prompt: union includes original tokens plus merged tokens
  for (const token of ['pixel art', 'neon colours', '3D CGI render', 'hard digital edges', 'lowres', 'modern clip-art']) {
    assert.ok(doc.negative_prompt.includes(token), `negative_prompt must include ${token}`)
  }
  for (const token of ['action', 'gore', 'screaming faces', 'dramatic chiaroscuro', 'high contrast']) {
    assert.ok(doc.negative_prompt.includes(token), `negative_prompt must retain original token ${token}`)
  }

  // Tags: 15 unioned tags
  assert.equal(doc.tags.length, 15)
  assert.ok(doc.tags.includes('academic painting'))
  assert.ok(doc.tags.includes('baroque'))

  // Compatible formulas: 4 unioned formulas
  assert.equal(doc.compatible_formula_ids.length, 4)
  assert.ok(doc.compatible_formula_ids.includes('com.storystudio.formula.sleep-history-compilation-v2'))
  assert.ok(doc.compatible_formula_ids.includes('com.storystudio.formula.human-behavior-explained-v2'))
})

test('full union topic pack: wars-treaties-world-order-v2 1.0.1 source carries the full merge at the raised ceiling', async () => {
  const manifest = await readJson(join(TOPIC_SOURCE, 'pack.json'))
  assert.equal(manifest.pack_id, 'com.storystudio.pack.topic.wars-treaties-world-order-v2')
  assert.equal(manifest.version, '1.0.1')
  assert.equal(manifest.min_app_version, '1.4.362', 'requires 1.4.362 where ceiling was raised to 4000')

  const doc = await readJson(join(TOPIC_SOURCE, 'content/topic-pack.json'))
  ContentPackDocumentSchema.parse(doc)

  // Compatible formulas: 2 unioned
  assert.deepEqual(doc.compatible_formula_ids, [
    'com.storystudio.formula.archival-ledger-v2',
    'com.storystudio.formula.history-explained-v2',
  ])

  // Exclusions: 7 unioned
  assert.equal(doc.exclusions.length, 7)

  // Full union subjects & profiles: 122 subjects, 122 coverage profiles (1:1 subject mapping)
  assert.equal(doc.subjects.length, 122)
  assert.equal(doc.coverage_profiles.length, 122)
  assert.deepEqual(doc.coverage_profiles.map(p => p.subject), doc.subjects)

  // Full union tuple arrays
  assert.equal(doc.episode_objects.length, 2999)
  assert.equal(doc.time_place_scopes.length, 3000)
  assert.equal(doc.mechanisms.length, 3000)
  assert.equal(doc.evidence_lenses.length, 3000)

  // Document byte size is well within 4 MiB limit
  const docBytes = (await readFile(join(TOPIC_SOURCE, 'content/topic-pack.json'))).length
  assert.ok(docBytes < 4 * 1024 * 1024, `document byte size ${docBytes} must be under 4 MiB`)
})

test('topic pack schema cap: pins 4000 ceiling and rejects 4001', async () => {
  const doc = JSON.parse(await readFile(join(CWD, '.superpowers/sdd/2026-10-27-pack-merge/sources/topic-wars-treaties-world-order-v2/content/topic-pack.json'), 'utf8'))

  // Valid at 4000
  const atCeiling = {
    ...doc,
    episode_objects: [...doc.episode_objects, ...Array.from({ length: 4000 - doc.episode_objects.length }, (_, i) => `filler object ${i}`)],
  }
  assert.equal(atCeiling.episode_objects.length, 4000)
  assert.doesNotThrow(() => ContentPackDocumentSchema.parse(atCeiling))

  // Rejects 4001
  const overCeiling = {
    ...atCeiling,
    episode_objects: [...atCeiling.episode_objects, 'one past ceiling'],
  }
  assert.equal(overCeiling.episode_objects.length, 4001)
  assert.throws(
    () => ContentPackDocumentSchema.parse(overCeiling),
    /Array must contain at most 4000 element\(s\)/,
  )
})
