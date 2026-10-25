/**
 * The 2026-10-25 Formula modernization and adoption (content-only).
 *
 * Owner ruling: reconcile and adopt the Formula library like the art styles —
 * modernize the store Formulas so they are cohesive, and adopt the three unique
 * owner custom Formulas under registry-issued ids. This file is the fence:
 *
 *   - every successor and new pack is a registered, authored standalone source;
 *   - the eleven core Formulas (plus Archival Ledger) now carry the opening
 *     recipe their legacy contract had, so aliasing a legacy channel onto the
 *     store Formula does not silently change its opening;
 *   - the adopted Coffee Jazz Formula's music block is INTACT, byte for byte;
 *   - a Formula never carries a thumbnail count (that stays a channel/preset
 *     setting, three by default);
 *   - a Formula names at most a STARTING scene length and never claims to
 *     decide an episode's rhythm (AGENTS §5).
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

const MODERNIZED = [
  ['free-starters/formula/ancient-humans-v1.0.3', 'com.storystudio.formula.ancient-humans', '1.0.3'],
  ['free-starters/formula/deep-time-documentary-v1.0.3', 'com.storystudio.formula.deep-time-documentary', '1.0.3'],
  ['free-starters/formula/economics-of-v1.0.2', 'com.storystudio.formula.economics-of', '1.0.2'],
  ['free-starters/formula/guided-mindfulness-v1.0.2', 'com.storystudio.formula.guided-mindfulness', '1.0.2'],
  ['free-starters/formula/history-explained-v1.0.3', 'com.storystudio.formula.history-explained', '1.0.3'],
  ['free-starters/formula/human-behavior-explained-v1.0.3', 'com.storystudio.formula.human-behavior-explained', '1.0.3'],
  ['free-starters/formula/natural-world-explained-v1.0.3', 'com.storystudio.formula.natural-world-explained', '1.0.3'],
  ['free-starters/formula/pov-your-life-as-v1.0.3', 'com.storystudio.formula.pov-your-life-as', '1.0.3'],
  ['free-starters/formula/practical-motivation-v1.0.2', 'com.storystudio.formula.practical-motivation', '1.0.2'],
  ['free-starters/formula/sleep-story-v1.0.2', 'com.storystudio.formula.sleep-story', '1.0.2'],
  ['legacy-niche-conversion/formula/counted-explainer-v1.0.1', 'com.storystudio.formula.counted-explainer', '1.0.1'],
  ['legacy-niche-conversion/formula/build-under-constraints-v1.0.1', 'com.storystudio.formula.build-under-constraints', '1.0.1'],
  ['legacy-niche-conversion/formula/pastoral-scripture-v1.0.1', 'com.storystudio.formula.pastoral-scripture', '1.0.1'],
  ['legacy-niche-conversion/formula/philosophy-real-problem-v1.0.1', 'com.storystudio.formula.philosophy-real-problem', '1.0.1'],
  ['legacy-niche-conversion/formula/prayer-v1.0.1', 'com.storystudio.formula.prayer', '1.0.1'],
  ['reusable-primitives/formula/before-after-timeline-v1.0.1', 'com.storystudio.formula.before-after-timeline', '1.0.1'],
  ['reusable-primitives/formula/question-ladder-v1.0.1', 'com.storystudio.formula.question-ladder', '1.0.1'],
]

const NEW_PACKS = [
  ['free-starters/formula/wildlife-under-pressure', 'com.storystudio.formula.wildlife-under-pressure'],
  ['free-starters/formula/coffee-jazz-ambient', 'com.storystudio.formula.coffee-jazz-ambient'],
  ['illustrated-history/formula/a-world-before-us', 'com.storystudio.formula.a-world-before-us'],
  ['free-starters/formula/khmer-folk-horror', 'com.storystudio.formula.khmer-folk-horror'],
  ['free-starters/formula/calm-science-for-sleep', 'com.storystudio.formula.calm-science-for-sleep'],
  ['free-starters/formula/mythology-for-sleep', 'com.storystudio.formula.mythology-for-sleep'],
]

const CORE_WITH_INTRO = [
  'ancient-humans-v1.0.3', 'deep-time-documentary-v1.0.3', 'economics-of-v1.0.2',
  'guided-mindfulness-v1.0.2', 'history-explained-v1.0.3', 'human-behavior-explained-v1.0.3',
  'natural-world-explained-v1.0.3', 'pov-your-life-as-v1.0.3', 'practical-motivation-v1.0.2',
  'sleep-story-v1.0.2', 'pastoral-scripture-v1.0.1',
]

const unregister = register()
const { ContentPackDocumentSchema } = await import('../../../electron/server/content-packs/schemas.ts')
const { contentPackDocumentToNiche } = await import('../../../electron/server/content-packs/legacy-adapters.ts')
unregister()

async function json(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

function sourceUrl(dir, name) {
  return new URL(`../../../content-packs/${dir}/${name}`, import.meta.url)
}

async function document(dir) {
  return json(sourceUrl(dir, 'content/series-formula.json'))
}

test('every successor and new Formula is a registered, authored standalone source', async () => {
  const registry = await json(REGISTRY)
  for (const [dir, id, version] of [...MODERNIZED, ...NEW_PACKS.map(([d, i]) => [d, i, '1.0.0'])]) {
    const packId = `com.storystudio.pack.formula.${id.replace('com.storystudio.formula.', '')}`
    const record = registry.records.find(row => row.pack_id === packId && row.version === version)
    assert.ok(record, `${packId}@${version} must be registered`)
    assert.equal(record.status, 'authored', `${packId}@${version}`)
    assert.equal(record.item_id, id)
    assert.equal(record.kind, 'series-formula')
    assert.equal(record.source_path, `content-packs/${dir}`)
    assert.deepEqual(record.dependencies, [])
    const manifest = await json(sourceUrl(dir, 'pack.json'))
    assert.equal(manifest.pack_id, packId)
    assert.equal(manifest.version, version)
    assert.equal(manifest.lifecycle, 'active')
    const doc = await document(dir)
    ContentPackDocumentSchema.parse(doc)
    assert.equal(doc.id, id)
    assert.equal(doc.kind, 'series-formula')
  }
})

test('the eleven core Formulas carry the opening recipe their legacy contract had', async () => {
  for (const dir of CORE_WITH_INTRO) {
    const doc = await document(`free-starters/formula/${dir}`).catch(() => null)
    const actual = doc ?? await document(`legacy-niche-conversion/formula/${dir}`)
    assert.ok(actual.intro_defaults?.beats?.length, `${dir} must declare intro_defaults`)
    assert.ok(actual.intro_defaults.word_target >= 50, `${dir} word target`)
    for (const beat of actual.intro_defaults.beats) {
      assert.ok(beat.id, `${dir} beat id`)
    }
  }
})

test('the shared field set is present on every full Formula', async () => {
  const dirs = [
    ...MODERNIZED.map(([dir]) => dir),
    ...NEW_PACKS.map(([dir]) => dir),
  ]
  for (const dir of dirs) {
    // The reusable primitives are deliberately minimal, and a music channel's
    // picture comes from the music subsystem rather than a thumbnail recipe.
    if (/before-after-timeline|question-ladder|coffee-jazz-ambient/.test(dir)) continue
    const doc = await document(dir)
    assert.ok(doc.tagline, `${dir} tagline`)
    assert.ok(doc.metadata_profile, `${dir} metadata_profile`)
    assert.ok(doc.default_thumbnail_recipe_id, `${dir} default_thumbnail_recipe_id`)
    assert.ok(doc.recommended_thumbnail_recipe_ids.includes(doc.default_thumbnail_recipe_id), `${dir} default recipe is recommended`)
    assert.ok(doc.perspective_policy, `${dir} perspective_policy`)
    assert.ok(doc.narrative_quality_contract, `${dir} narrative_quality_contract`)
  }
})

test("the adopted Coffee Jazz Formula's music block is intact", async () => {
  const doc = await document('free-starters/formula/coffee-jazz-ambient')
  assert.ok(doc.music_format, 'the music block must survive adoption')
  assert.equal(
    createHash('sha256').update(JSON.stringify(doc.music_format)).digest('hex'),
    '4dae07fb039826feae38f7de8c9e72ac08fdf044b962850bafa737f457a16fe3',
    'the music_format block must stay byte-identical to the owner fork it was adopted from',
  )
  assert.equal(doc.music_format.worlds.length, 90)
  assert.equal(doc.music_format.sceneSettings.length, 30)
  assert.ok(doc.music_format.songFormula)
  assert.ok(doc.music_format.episodeDefaults)
  // And the adapter the app actually reads still exposes it as musicFormat.
  const niche = contentPackDocumentToNiche(doc)
  assert.deepEqual(niche.musicFormat, doc.music_format)
})

test('the three new channel Formulas are Khmer-specific and calm, not western horror', async () => {
  const khmer = await document('free-starters/formula/khmer-folk-horror')
  assert.match(khmer.name, /Khmer/)
  assert.ok(khmer.vocabulary.keyword.some(word => /[ក-៿]/.test(word)), 'Khmer script vocabulary')
  assert.ok(khmer.narrative_rules.some(rule => /khmer|khmaoch|preay|areak|neak ta/i.test(rule)))
  const forbidden = khmer.narrative_quality_contract.forbidden_patterns.join(' ').toLowerCase()
  for (const western of ['zombie', 'exorcism', 'ouija', 'possession', 'gore', 'jump scare']) {
    assert.ok(forbidden.includes(western), `Khmer Formula must name and forbid ${western}`)
  }

  for (const dir of ['calm-science-for-sleep', 'mythology-for-sleep']) {
    const doc = await document(`free-starters/formula/${dir}`)
    assert.equal(doc.formula_family, 'Calm documentary')
    assert.ok(doc.script_structure.chapters_independent, `${dir} chapters are independent`)
    assert.ok(doc.script_structure.default_length_minutes >= 90, `${dir} is long-form`)
    assert.ok(doc.intro_defaults.beats.some(beat => beat.id === 'relaxation'), `${dir} settles in`)
  }
})

test('a Formula names a starting scene length, never a rhythm claim or a thumbnail count', async () => {
  for (const [dir] of [...MODERNIZED, ...NEW_PACKS.map(([d]) => [d])]) {
    const raw = JSON.stringify(await document(dir))
    assert.doesNotMatch(raw, /thumbnail(_|)count/i, `${dir} must not carry a thumbnail count`)
    assert.doesNotMatch(raw, /locks? (the )?(episode|scene) rhythm|decides? (the )?(episode|scene) rhythm/i, `${dir} must not claim the rhythm`)
    if (/"starting_scene_seconds"/.test(raw)) {
      const doc = await document(dir)
      assert.equal(Array.isArray(doc.starting_scene_seconds) && doc.starting_scene_seconds.length, 2, `${dir} starting scene length is a range`)
    }
  }
})

test('all six new packs build reproducibly and validate with an ephemeral key', async t => {
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')
  const temporary = await mkdtemp(join(tmpdir(), 'story-formula-modernize-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(temporary, 'private.pem')
  const publicKeyPath = join(temporary, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const release = { keyId: 'com.storystudio.key.test', minAppVersion: '1.0.0' }

  for (const [dir] of NEW_PACKS) {
    const source = decodeURIComponent(new URL(`../../../content-packs/${dir}`, import.meta.url).pathname)
    const first = join(temporary, `${dir.replaceAll('/', '-')}-1.sspack`)
    const second = join(temporary, `${dir.replaceAll('/', '-')}-2.sspack`)
    await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: first, ...release })
    await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: second, ...release })
    const [a, b] = await Promise.all([readFile(first), readFile(second)])
    assert.deepEqual(a, b, `${dir} must build reproducibly`)
    await validateContentPack({ archivePath: first, keyId: release.keyId, publisherId: 'com.storystudio', publicKeyPath })
  }
})
