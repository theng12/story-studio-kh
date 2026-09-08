import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../', import.meta.url)
const LEDGER = new URL('../../../content-packs/legacy-migration-dispositions.json', import.meta.url)
const REGISTRY = new URL('../../../content-packs/authoring-registry.json', import.meta.url)

const unregisterTsx = register()
const [
  { BUILT_IN_SUBTITLE_PRESETS },
  { BUILT_IN_SCENE_MOTIONS, BUILT_IN_FOOTAGE_MOTIONS, BUILT_IN_OVERLAYS },
  { FONT_STYLES, TEXT_STYLES },
  { BUILT_IN_METADATA_FORMULA_IDS },
] = await Promise.all([
  import(new URL('../../../electron/server/contracts/subtitle-presets.ts', import.meta.url)),
  import(new URL('../../../electron/server/contracts/scene-effect-presets.ts', import.meta.url)),
  import(new URL('../../../electron/server/models/thumbnail-styles.ts', import.meta.url)),
  import(new URL('../../../electron/server/contracts/metadata-formulas.ts', import.meta.url)),
])
unregisterTsx()

// Historical inventory only. These identifiers remain frozen so the migration
// ledger continues proving every retired runtime style has a disposition after
// the static frontend catalog itself is removed.
const RETIRED_VISUAL_STYLE_IDS = [
  'builtin-anime-cel',
  'builtin-archival-documentary-reconstruction',
  'builtin-cinematic-photoreal',
  'builtin-flat-vector-explainer',
  'builtin-hand-drawn-cartoon-explainer',
  'builtin-hand-drawn-editorial-diagram',
  'builtin-minimal-stick-figure-explainer',
  'builtin-ms-paint-fantasy',
  'builtin-oil-painting-classical',
  'builtin-paleo-documentary-tableau',
  'builtin-pixel-art-story',
  'builtin-prehistoric-stick-cartoon',
  'builtin-sepia-ink-wash',
  'builtin-studio-catalog-realism',
  'builtin-watercolor-storybook',
  'builtin-waxy-outline-cartoon',
  'builtin-whiteboard-doodle-explainer',
]

const ALLOWED_DISPOSITIONS = new Set([
  'authored-standalone',
  'absorbed',
  'withdrawn-pre-sale',
  'retained-free-builtin',
  'retired-runtime-compatible',
  'historical-read-only',
])

const NEW_AUTHORED_PRODUCTS = new Set([
  'com.storystudio.pack.formula.counted-explainer@1.0.0',
  'com.storystudio.pack.formula.build-under-constraints@1.0.0',
  'com.storystudio.pack.formula.philosophy-real-problem@1.0.0',
  'com.storystudio.pack.formula.pastoral-scripture@1.0.0',
  'com.storystudio.pack.formula.prayer@1.0.0',
  'com.storystudio.pack.topic.ancient-humans-environments@1.0.0',
  'com.storystudio.pack.topic.ancient-humans-social-life@1.0.0',
  'com.storystudio.pack.topic.ancient-humans-technology@1.0.0',
  'com.storystudio.pack.topic.deep-time-speculative-earth@1.0.0',
  'com.storystudio.pack.topic.economics-ancient-civilizations@1.0.0',
  'com.storystudio.pack.topic.natural-world-fungi@1.0.0',
  'com.storystudio.pack.topic.natural-world-insects@1.0.0',
  'com.storystudio.pack.topic.natural-world-plants@1.0.0',
  'com.storystudio.pack.topic.pastoral-daily-reflection@1.0.0',
  'com.storystudio.pack.topic.pastoral-expository-teaching@1.0.0',
  'com.storystudio.pack.topic.pov-criminal-hierarchies@1.0.0',
  'com.storystudio.pack.topic.pov-law-enforcement@1.0.0',
])

const PROMOTED_PREPARED_PRODUCTS = new Set([
  'com.storystudio.pack.thumbnail.prehistoric-survival-title-card@1.0.0',
  'com.storystudio.pack.thumbnail.dreamlike-story-title-card@1.0.0',
  'com.storystudio.pack.style.hand-drawn-hardship-cartoon@1.0.0',
  'com.storystudio.pack.style.dreamlike-luminous-sleep-illustration@1.0.0',
])

const WITHDRAWN_RESERVATIONS = new Set([
  'com.storystudio.pack.thumbnail.animal-hardship-annotation@1.0.0',
  'com.storystudio.pack.thumbnail.centered-hero-headline@1.0.1',
  'com.storystudio.pack.thumbnail.portrait-block-right@1.0.1',
  'com.storystudio.pack.thumbnail.dreamscape-story-window@1.0.1',
  'com.storystudio.pack.kit.symbolic-psychology-studio@1.0.1',
])

async function jsonInventory(directory) {
  const names = (await readdir(new URL(directory, ROOT))).filter(name => name.endsWith('.json')).sort()
  return Promise.all(names.map(async name => JSON.parse(await readFile(new URL(`${directory}${name}`, ROOT), 'utf8'))))
}

function exactSet(actual, expected, message) {
  assert.deepEqual([...new Set(actual)].sort(), [...expected].sort(), message)
}

function registryIdentity(target) {
  return `${target.pack_id}@${target.version}`
}

test('legacy migration ledger closes every real inventory key exactly once without replacing registry authority', async () => {
  const [ledger, registry, niches, topics, thumbnails] = await Promise.all([
    readFile(LEDGER, 'utf8').then(JSON.parse),
    readFile(REGISTRY, 'utf8').then(JSON.parse),
    jsonInventory('electron/server/niches/'),
    jsonInventory('electron/server/topic-packs/'),
    jsonInventory('electron/server/thumbnail-templates/'),
  ])

  assert.equal(ledger.schema_version, 1)
  assert.equal(ledger.authoritative, false)
  assert.equal(ledger.identity_authority, 'content-packs/authoring-registry.json')
  assert.ok(Array.isArray(ledger.dispositions))

  const runtimeInventories = new Map([
    ['runtime-niche', new Set(niches.map(entry => entry.id))],
    ['runtime-topic', new Set(topics.map(entry => entry.id))],
    ['runtime-style', new Set(RETIRED_VISUAL_STYLE_IDS)],
    ['runtime-thumbnail', new Set(thumbnails.map(entry => entry.id))],
    ['runtime-subtitle', new Set(BUILT_IN_SUBTITLE_PRESETS.map(entry => entry.id))],
    ['runtime-scene-effect', new Set([
      ...BUILT_IN_SCENE_MOTIONS.map(entry => `scene:${entry.id}`),
      ...BUILT_IN_FOOTAGE_MOTIONS.map(entry => `footage:${entry.id}`),
    ])],
    ['runtime-overlay', new Set(BUILT_IN_OVERLAYS.map(entry => entry.id))],
    ['runtime-lettering', new Set([
      ...Object.keys(FONT_STYLES).map(id => `font:${id}`),
      ...Object.keys(TEXT_STYLES).map(id => `text:${id}`),
    ])],
    ['runtime-metadata', new Set(BUILT_IN_METADATA_FORMULA_IDS)],
  ])

  // Owner ruling 2026-09-08 discontinued Channel Kits. Every Kit that was ever
  // authored is now `retired` with its source deleted, and the ledger still owes
  // each one a disposition — that is the whole point of a closure ledger.
  const retiredKits = registry.records.filter(record => record.kind === 'channel-kit' && record.status === 'retired')
  const expectedKeys = new Set([
    ...niches.map(entry => `niche:${entry.id}`),
    ...topics.map(entry => `topic:${entry.id}`),
    ...RETIRED_VISUAL_STYLE_IDS.map(id => `style:${id}`),
    ...thumbnails.map(entry => `thumbnail:${entry.id}`),
    ...BUILT_IN_SUBTITLE_PRESETS.map(entry => `subtitle:${entry.id}`),
    ...BUILT_IN_SCENE_MOTIONS.map(entry => `scene-effect:scene:${entry.id}`),
    ...BUILT_IN_FOOTAGE_MOTIONS.map(entry => `scene-effect:footage:${entry.id}`),
    ...BUILT_IN_OVERLAYS.map(entry => `overlay:${entry.id}`),
    ...Object.keys(FONT_STYLES).map(id => `lettering:font:${id}`),
    ...Object.keys(TEXT_STYLES).map(id => `lettering:text:${id}`),
    ...BUILT_IN_METADATA_FORMULA_IDS.map(id => `metadata:${id}`),
    ...[...PROMOTED_PREPARED_PRODUCTS].map(identity => `prepared:${identity}`),
    ...[...WITHDRAWN_RESERVATIONS].map(identity => `reservation:${identity}`),
    ...retiredKits.map(record => `kit:${record.pack_id}@${record.version}`),
    'compatibility-successor:com.storystudio.pack.formula.history-explained@1.0.2',
  ])

  const ledgerKeys = ledger.dispositions.map(entry => entry.legacy_key)
  assert.equal(new Set(ledgerKeys).size, ledgerKeys.length, 'every audited legacy key must appear exactly once')
  exactSet(ledgerKeys, expectedKeys, 'ledger coverage must be derived from the real runtime inventories and registry Kit history')

  const byRegistryIdentity = new Map(registry.records.map(record => [`${record.pack_id}@${record.version}`, record]))
  for (const entry of ledger.dispositions) {
    assert.equal(typeof entry.source, 'string', `${entry.legacy_key} must name its evidence source`)
    assert.ok(entry.source.length > 0, `${entry.legacy_key} must name its evidence source`)
    assert.ok(ALLOWED_DISPOSITIONS.has(entry.disposition), `${entry.legacy_key} has an unknown disposition`)
    assert.ok(entry.target && typeof entry.target === 'object', `${entry.legacy_key} must have a target`)

    if (entry.target.kind === 'registry-record') {
      const identity = registryIdentity(entry.target)
      const record = byRegistryIdentity.get(identity)
      assert.ok(record, `${entry.legacy_key} points to absent registry target ${identity}`)
      assert.equal(record.status, entry.target.status, `${entry.legacy_key} terminal registry status drifted`)
      if (entry.target.source_path) assert.equal(record.source_path, entry.target.source_path)
      if (entry.disposition === 'withdrawn-pre-sale') assert.equal(entry.target.status, 'withdrawn')
      else if (entry.disposition === 'historical-read-only') assert.equal(entry.target.status, 'retired')
      else assert.equal(entry.target.status, 'authored')
      continue
    }

    const inventory = runtimeInventories.get(entry.target.kind)
    assert.ok(inventory, `${entry.legacy_key} has an unknown runtime target kind ${entry.target.kind}`)
    assert.ok(inventory.has(entry.target.id), `${entry.legacy_key} points to absent ${entry.target.kind} ${entry.target.id}`)
    assert.ok(
      ['retained-free-builtin', 'retired-runtime-compatible'].includes(entry.disposition),
      `${entry.legacy_key} cannot claim completion from a runtime-only target`,
    )
  }

  const closureTargets = group => new Set(ledger.dispositions
    .filter(entry => entry.closure_group === group)
    .map(entry => registryIdentity(entry.target)))

  exactSet(closureTargets('new-authored-product'), NEW_AUTHORED_PRODUCTS, 'all 17 new standalone products must be accounted for by exact identity')
  exactSet(closureTargets('promoted-prepared-product'), PROMOTED_PREPARED_PRODUCTS, 'all four prepared products must be accounted for by exact identity')
  exactSet(closureTargets('withdrawn-obsolete-reservation'), WITHDRAWN_RESERVATIONS, 'all five obsolete reservations must be accounted for by exact identity')

  for (const group of ['new-authored-product', 'promoted-prepared-product']) {
    for (const entry of ledger.dispositions.filter(candidate => candidate.closure_group === group)) {
      assert.equal(entry.disposition, 'authored-standalone')
      assert.equal(entry.target.status, 'authored')
    }
  }
  for (const entry of ledger.dispositions.filter(candidate => candidate.closure_group === 'withdrawn-obsolete-reservation')) {
    assert.equal(entry.disposition, 'withdrawn-pre-sale')
    assert.equal(entry.target.status, 'withdrawn')
  }

  const freeSuccessor = ledger.dispositions.find(entry => entry.closure_group === 'free-compatibility-successor')
  assert.equal(freeSuccessor.legacy_key, 'compatibility-successor:com.storystudio.pack.formula.history-explained@1.0.2')
  assert.equal(freeSuccessor.disposition, 'retained-free-builtin')
  assert.equal(registryIdentity(freeSuccessor.target), 'com.storystudio.pack.formula.history-explained@1.0.2')
  assert.equal(freeSuccessor.target.status, 'authored')

  assert.equal(ledger.dispositions.find(entry => entry.legacy_key === 'niche:dark-psychology').disposition, 'absorbed')
  assert.equal(ledger.dispositions.find(entry => entry.legacy_key === 'niche:music-mix').disposition, 'retired-runtime-compatible')

  const freeBaselineKeys = ledger.dispositions
    .filter(entry => entry.closure_group === 'intentional-free-baseline')
    .map(entry => entry.legacy_key)
  exactSet(freeBaselineKeys.filter(key => key.startsWith('lettering:')), [...runtimeInventories.get('runtime-lettering')].map(id => `lettering:${id}`))
  exactSet(freeBaselineKeys.filter(key => key.startsWith('metadata:')), [...runtimeInventories.get('runtime-metadata')].map(id => `metadata:${id}`))
  exactSet(freeBaselineKeys.filter(key => key.startsWith('subtitle:')), [...runtimeInventories.get('runtime-subtitle')].map(id => `subtitle:${id}`))
  exactSet(freeBaselineKeys.filter(key => key.startsWith('scene-effect:')), [...runtimeInventories.get('runtime-scene-effect')].map(id => `scene-effect:${id}`))
  exactSet(freeBaselineKeys.filter(key => key.startsWith('overlay:')), [...runtimeInventories.get('runtime-overlay')].map(id => `overlay:${id}`))
  assert.deepEqual(
    [
      freeBaselineKeys.filter(key => key.startsWith('lettering:')).length,
      freeBaselineKeys.filter(key => key.startsWith('metadata:')).length,
      freeBaselineKeys.filter(key => key.startsWith('subtitle:')).length,
      freeBaselineKeys.filter(key => key.startsWith('scene-effect:')).length,
      freeBaselineKeys.filter(key => key.startsWith('overlay:')).length,
    ],
    [35, 5, 16, 31, 13],
  )

  exactSet(
    ledger.dispositions.filter(entry => entry.disposition === 'historical-read-only').map(entry => entry.legacy_key),
    retiredKits.map(record => `kit:${record.pack_id}@${record.version}`),
    'every historical Kit version must stay closed and no Kit may re-enter standalone authoring',
  )
  assert.deepEqual(
    registry.records.filter(record => record.kind === 'channel-kit' && record.status === 'authored'),
    [],
    'no Channel Kit may be authored again',
  )
  assert.deepEqual(registry.records.filter(record => record.status === 'reserved'), [], 'no unexplained reserved registry row may remain')
})
