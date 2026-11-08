/**
 * Legacy Formula ids read as the store's Formula — WITHOUT a migration.
 *
 * Owner ruling, 2026-10-25: reconcile the bare legacy ids onto the qualified
 * store Formulas like the art styles were reconciled. No project config,
 * preset, or niche file is rewritten (AGENTS §5); a READ-TIME alias table in
 * the niche loader makes `sleep` load `com.storystudio.formula.sleep-story`'s
 * current content.
 *
 * The proof that matters is two-sided: the content comes from the store pack,
 * AND the project file is byte-identical afterwards. A test that only checked
 * the first could still be passing over a silent rewrite.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import * as niches from '../services/niche-loader.js'
import * as projects from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'

const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.formula-alias-test'
const packId = 'com.storystudio.pack.formula-alias-test'
const storeSleepId = 'com.storystudio.formula.sleep-story'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function formula(id: string, name: string, overrides: Record<string, unknown> = {}): ContentPackDocument {
  const base: ContentPackDocument = {
    kind: 'series-formula',
    schema_version: 1,
    id,
    name,
    description: `${name} test content.`,
    channel_promise: 'A calm promise.',
    audience: 'Test listeners.',
    narrative_rules: ['Stay calm.'],
    title_rules: ['Name the subject plainly.'],
    script_structure: {
      default_chapter_count: 3,
      chapter_count_range: [2, 4],
      default_length_minutes: 10,
      length_minutes_range: [5, 15],
      duration_presets: [5, 10, 15],
      default_words_per_minute: 120,
      chapters_independent: true,
      pacing_arc: ['Opening'],
      additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [],
    recommended_visual_style_ids: [],
    recommended_thumbnail_recipe_ids: [],
  }
  return { ...base, ...overrides } as ContentPackDocument
}

async function archiveOf(documents: ContentPackDocument[], id: string): Promise<Uint8Array> {
  const items = documents.map((document, index) => {
    const bytes = Buffer.from(JSON.stringify(document))
    return { document, bytes, path: `content/item-${index}.json` }
  })
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: id,
    publisher_id: publisherId,
    key_id: keyId,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${id}.sku`, family: `${id}.family` },
    bundles: [],
    items: items.map(item => ({ id: item.document.id, kind: item.document.kind, schema_version: 1, path: item.path })),
    files: items.map(item => ({ path: item.path, sha256: digest(item.bytes), bytes: item.bytes.byteLength, mime: 'application/json' })),
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  for (const item of items) zip.file(item.path, item.bytes, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function archive(): Promise<Uint8Array> {
  return archiveOf([
    formula(storeSleepId, 'Store Sleep Formula'),
    formula('com.storystudio.formula.wildlife-under-pressure', 'Adopted Wildlife Formula'),
  ], packId)
}

test('a legacy niche id reads the store Formula and leaves the project file byte-identical', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)

  assert.equal(niches.resolveFormulaAlias('sleep'), storeSleepId)
  assert.equal(niches.resolveFormulaAlias('history-narration'), 'com.storystudio.formula.history-explained')
  // Music Mix used to be the one pass-through id (the music subsystem owned it
  // and a Formula could not carry a music format); it is a pack now too.
  assert.equal(niches.resolveFormulaAlias('music-mix'), 'com.storystudio.formula.music-mix')
  assert.equal(niches.resolveFormulaAlias('com.storystudio.formula.sleep-story'), storeSleepId)

  const project = await projects.createProject({ name: 'Legacy sleep channel', niche_id: 'sleep' })
  const projectFile = path.join(projects.getProjectDir(project.slug)!, 'project.json')
  const before = await fs.readFile(projectFile)

  const loaded = await niches.loadNiche('sleep', options)
  assert.equal(loaded?.id, storeSleepId, 'the bare id must resolve to the store item id')
  assert.equal(loaded?.name, 'Store Sleep Formula', 'content must be the store Formula, not the legacy file')

  const effective = await niches.getEffectiveNicheFor(project, undefined, options)
  assert.equal(effective?.id, storeSleepId)
  assert.equal(effective?.name, 'Store Sleep Formula')

  const after = await fs.readFile(projectFile)
  assert.deepEqual(after, before, 'reading a Formula must not rewrite the project file (AGENTS §5)')
  assert.equal((await projects.getProject(project.slug))?.niche_id, 'sleep', 'the stored id is untouched')
})

test('adopted owner custom Formulas resolve to their store packs at read time', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)

  const customId = 'user:c0293626-910a-4dbd-9c5a-2e0a6c90d798'
  assert.equal(niches.resolveFormulaAlias(customId), 'com.storystudio.formula.wildlife-under-pressure')
  const loaded = await niches.loadNiche(customId, options)
  assert.equal(loaded?.id, 'com.storystudio.formula.wildlife-under-pressure')
  assert.equal(loaded?.name, 'Adopted Wildlife Formula')
})

test('the picker lists installed pack Formulas only, and every stored id still resolves', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)

  const listed = (await niches.listNicheCatalogEntries(options)).map(entry => entry.value.id)
  assert.ok(listed.includes(storeSleepId))
  assert.equal(listed.includes('sleep'), false,
    'a shipped profile is never listed beside the pack that now serves it (owner, 2026-10-29)')
  assert.equal(listed.includes('music-mix'), false,
    'the list is installed packs only: a profile whose own pack is not installed is not listed')
  assert.equal((await niches.loadNiche('music-mix', options))?.id, 'music-mix',
    'but a stored Formula that no installed pack publishes still resolves from its own source')
})

test('without the store Formula the legacy file still answers, so a channel keeps its Formula', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const loaded = await niches.loadNiche('hidden-mechanics-history')
  assert.equal(loaded?.id, 'hidden-mechanics-history', 'fallback keeps generation working when archival-ledger is not installed')
  assert.ok(loaded?.scriptSystemPromptRole)
})

test('aliased qualified owner formula falls back to resolved installed pack when store alias target is absent', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.4.388' }
  const ownerFormulaId = 'kh.owner.formula.illustrated-history-for-sleep'
  const storeTargetId = 'com.storystudio.formula.a-world-before-us'
  const ownerPackId = 'com.storystudio.pack.awbu-test'
  await installContentPack({
    archiveBytes: await archiveOf([formula(ownerFormulaId, 'Illustrated History for Sleep')], ownerPackId),
    source: 'local-import',
  }, options)

  assert.equal(niches.resolveFormulaAlias(ownerFormulaId), storeTargetId)
  // Without canonical store pack installed, fallback resolves the installed legacy qualified pack
  const loaded = await niches.loadNiche(ownerFormulaId, options)
  assert.equal(loaded?.id, ownerFormulaId, 'falls back to installed pack formula when store pack is absent')
  assert.equal(loaded?.name, 'Illustrated History for Sleep')

  // When canonical store pack is also installed, canonical store formula wins
  const storePackId = 'com.storystudio.pack.store-awbu-test'
  await installContentPack({
    archiveBytes: await archiveOf([formula(storeTargetId, 'Store World Before Us Formula')], storePackId),
    source: 'local-import',
  }, options)
  const loadedCanonical = await niches.loadNiche(ownerFormulaId, options)
  assert.equal(loadedCanonical?.id, storeTargetId, 'canonical store pack formula wins over legacy pack when present')
  assert.equal(loadedCanonical?.name, 'Store World Before Us Formula')
})

/**
 * Owner, 2026-10-29: "no custom, no built in, all from packs." Quote Shorts and
 * Still Posts were built-ins; they are packs now, and a channel that stored the
 * built-in id reads the installed pack through the alias.
 *
 * Still Posts is the case that needs more than a name check: its channel type
 * and its writer voice come from `stillPostsFormat`, so a pack that dropped that
 * block would turn a Still Posts channel into a video channel that refuses to
 * write. The pack must carry it, the same way Coffee Jazz carries `musicFormat`.
 */
const quoteShortsId = 'com.storystudio.formula.quote-shorts'
const stillPostsId = 'com.storystudio.formula.still-posts'
const musicMixId = 'com.storystudio.formula.music-mix'
const adoptedFreePackId = 'com.storystudio.pack.formula.adopted-free-builtins-test'

async function freeBuiltinsArchive(): Promise<Uint8Array> {
  const secondsStructure = (formula(quoteShortsId, 'template') as any).script_structure
  return archiveOf([
    formula(quoteShortsId, 'Store Quote Shorts', {
      aspect_ratio: '9:16',
      starting_music_volume: 55,
      script_structure: {
        ...secondsStructure,
        default_length_seconds: 45,
        length_seconds_range: [10, 60],
        randomize_length: true,
      },
    }),
    formula(stillPostsId, 'Store Still Posts', {
      aspect_ratio: '1:1',
      still_posts_format: {
        enabled: true,
        writeSystemPromptRole: 'You write short illustrated posts for this channel.',
        quoteGuidance: 'Vary the subject across the batch.',
      },
    }),
    formula(musicMixId, 'Store Music Mix', {
      music_format: {
        registers: { calm: { label: 'Calm', camera: 'middle distance, level', feeling: 'stillness' } },
        worlds: [{
          id: 'rain-window-desk',
          name: 'Rain on the window',
          register: 'calm',
          sight: 'A desk by a window, rain on the glass.',
          scenes: ['morning'],
          music: ['rain', 'soft piano'],
        }],
      },
    }),
  ], adoptedFreePackId)
}

test('the adopted Quote Shorts, Still Posts and Music Mix packs resolve from the built-in ids', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.4.369' }
  await installContentPack({ archiveBytes: await freeBuiltinsArchive(), source: 'local-import' }, options)

  assert.equal(niches.resolveFormulaAlias('quote-shorts'), quoteShortsId)
  assert.equal(niches.resolveFormulaAlias('still-posts'), stillPostsId)

  const quotes = await niches.loadNiche('quote-shorts', options)
  assert.equal(quotes?.id, quoteShortsId)
  assert.equal(quotes?.name, 'Store Quote Shorts')
  assert.equal((quotes as any)?.aspectRatio, '9:16')
  assert.equal((quotes as any)?.scriptStructure?.defaultLengthSeconds, 45)
  assert.deepEqual((quotes as any)?.scriptStructure?.lengthSecondsRange, [10, 60])
  assert.equal((quotes as any)?.scriptStructure?.randomizeLength, true)
  assert.equal((quotes as any)?.startingMusicVolume, 55)

  const still = await niches.loadNiche('still-posts', options)
  assert.equal(still?.id, stillPostsId)
  assert.equal((still as any)?.stillPostsFormat?.enabled, true)
  assert.equal((still as any)?.stillPostsFormat?.writeSystemPromptRole, 'You write short illustrated posts for this channel.')
  assert.equal((still as any)?.aspectRatio, '1:1')

  // Music Mix's channel type comes from `musicFormat`, exactly like Still
  // Posts'. The music subsystem still owns the workflow; only the Formula's
  // home changed.
  assert.equal(niches.resolveFormulaAlias('music-mix'), musicMixId)
  const music = await niches.loadNiche('music-mix', options)
  assert.equal(music?.id, musicMixId)
  assert.equal((music as any)?.musicFormat?.worlds?.length, 1)
  assert.equal((music as any)?.musicFormat?.worlds?.[0]?.id, 'rain-window-desk')
  const musicChannel = await projects.createProject({ name: 'An adopted music channel', niche_id: 'music-mix' })
  const musicEffective = await niches.getEffectiveNicheFor(musicChannel, undefined, options)
  assert.equal(musicEffective?.id, musicMixId)
  assert.ok((musicEffective as any)?.musicFormat, 'the music channel type must survive the pack boundary')

  // The channel type is decided from the resolved Formula, not from the stored
  // id, so a Still Posts channel still reports itself as one.
  const project = await projects.createProject({ name: 'An adopted still posts channel', niche_id: 'still-posts' })
  const projectFile = path.join(projects.getProjectDir(project.slug)!, 'project.json')
  const before = await fs.readFile(projectFile)
  const effective = await niches.getEffectiveNicheFor(project, undefined, options)
  assert.equal(effective?.id, stillPostsId)
  assert.equal((effective as any)?.stillPostsFormat?.enabled, true, 'the Still Posts channel type must survive the pack boundary')
  assert.deepEqual(await fs.readFile(projectFile), before, 'reading a Formula must not rewrite the project file (AGENTS §5)')
  assert.equal((await projects.getProject(project.slug))?.niche_id, 'still-posts')

  const listed = (await niches.listNicheCatalogEntries(options)).map(entry => entry.value.id)
  assert.ok(listed.includes(quoteShortsId))
  assert.ok(listed.includes(stillPostsId))
  assert.ok(listed.includes(musicMixId))
  assert.equal(listed.includes('quote-shorts'), false, 'the superseded built-in must not sit beside its own pack')
  assert.equal(listed.includes('still-posts'), false, 'the superseded built-in must not sit beside its own pack')
  assert.equal(listed.includes('music-mix'), false, 'the superseded built-in must not sit beside its own pack')
})

test('without the packs, both built-ins still answer so no channel loses its Formula', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const quotes = await niches.loadNiche('quote-shorts')
  assert.equal(quotes?.id, 'quote-shorts')
  const still = await niches.loadNiche('still-posts')
  assert.equal(still?.id, 'still-posts')
  assert.equal((still as any)?.stillPostsFormat?.enabled, true)
  const music = await niches.loadNiche('music-mix')
  assert.equal(music?.id, 'music-mix')
  assert.ok((music as any)?.musicFormat, 'the music channel keeps its format when the pack is absent')
})
