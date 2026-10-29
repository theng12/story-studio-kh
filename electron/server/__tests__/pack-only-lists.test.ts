/**
 * Picker lists carry installed pack items only, and every stored id still
 * resolves. Owner ruling, 2026-10-29 — "no custom, no built in, all from packs".
 *
 * What this pins, in both directions:
 *   - the LIST is the installed packs: a shipped `electron/server/niches` profile,
 *     a local `user:` Formula fork and a user style pack style are not offered;
 *   - nothing that was stored stops resolving: a fork a channel still selects is
 *     named on its card (never a raw `user:<uuid>`), a shipped profile still
 *     answers when its pack is absent, and a legacy style preset still reads the
 *     Store style that owns the look — including the owner's own copy of Bold
 *     Illustrated History (owner, 2026-10-29: "the Studio Library style is the
 *     one").
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { STYLE_ALIASES, aliasedVisualStyleId } from '../content-packs/style-aliases.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { forkLegacyContentForEdit } from '../content-packs/user-forks.js'
import * as niches from '../services/niche-loader.js'
import * as styles from '../services/visual-style-loader.js'
import { installUserStylePack } from '../services/user-style-packs.js'
import { useTempDataDir } from './_helpers.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.pack-only-list-test'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A real 1x1 WebP, so a preview asset is an image and not a renamed blob. */
const ONE_PIXEL_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')

const BOLD_STYLE_ID = 'com.storystudio.style.bold-illustrated-history'
const OWNER_COPY_ID = 'kh.owner.style.bold-illustrated-history'

function formulaDocument(id: string, name: string): ContentPackDocument {
  return {
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
}

function styleDocument(id: string, name: string, styleBible: string): ContentPackDocument {
  return {
    kind: 'visual-style',
    schema_version: 1,
    id,
    name,
    description: `${name} test content.`,
    category: 'illustration',
    tags: ['test'],
    style_bible: styleBible,
    negative_prompt: 'photo, 3D render',
    preview_assets: ['assets/preview.webp'],
    compatible_formula_ids: [],
  }
}

async function signedArchive(packId: string, document: ContentPackDocument, withAsset: boolean): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify(document))
  const contentPath = 'content/item.json'
  const files = [{ path: contentPath, sha256: digest(content), bytes: content.byteLength, mime: 'application/json' }]
  const zip = new JSZip()
  if (withAsset) {
    files.push({ path: 'assets/preview.webp', sha256: digest(ONE_PIXEL_WEBP), bytes: ONE_PIXEL_WEBP.byteLength, mime: 'image/webp' })
    zip.file('assets/preview.webp', ONE_PIXEL_WEBP, { createFolders: false })
  }
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: packId,
    publisher_id: publisherId,
    key_id: keyId,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: document.id, kind: document.kind, schema_version: 1, path: contentPath }],
    files,
  }))
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  zip.file(contentPath, content, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function tempWithPacks(documents: Array<{ packId: string; document: ContentPackDocument; withAsset?: boolean }>) {
  const temporary = await useTempDataDir()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths: getContentPackRuntimePaths(), policy, recoveryRoot, appVersion: '1.0.0' }
  for (const item of documents) {
    await installContentPack(
      { archiveBytes: await signedArchive(item.packId, item.document, item.withAsset === true), source: 'local-import' },
      options,
    )
  }
  return { temporary, options }
}

// ── Formulas ──────────────────────────────────────────────────────────────

test('the Formula list is the installed packs; a shipped profile and a user fork are not offered', async t => {
  const { temporary, options } = await tempWithPacks([{
    packId: 'com.storystudio.pack.formula.pack-only-list-test',
    document: formulaDocument('com.storystudio.formula.pack-only-list-test', 'Installed Formula'),
  }])
  t.after(temporary.cleanup)

  const fork = await forkLegacyContentForEdit({ kind: 'series-formula', legacyId: 'sleep' }, options)
  const listed = (await niches.listNicheCatalogEntries(options)).map(entry => entry.value.id)
  assert.ok(listed.includes('com.storystudio.formula.pack-only-list-test'), 'the installed Formula is listed')
  assert.equal(listed.includes('sleep'), false, 'the shipped legacy profile is not listed')
  assert.equal(listed.includes(fork.fork_id), false, 'the user fork is not listed')

  // Nothing was deleted or rewritten: both still answer, by their own ids.
  assert.equal((await niches.loadNiche('sleep', options))?.id, 'sleep', 'the shipped profile still resolves')
  assert.equal((await niches.loadNiche(fork.fork_id, options))?.id, fork.fork_id, 'the fork still resolves')
})

test('a channel that still selects a fork is named on its card, never as a raw user id', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const fork = await forkLegacyContentForEdit({ kind: 'series-formula', legacyId: 'sleep' })

  const names = await niches.formulaDisplayNames()
  const name = names.get(fork.fork_id)
  assert.ok(name, 'a selected fork still has a name for the channel card')
  assert.doesNotMatch(name!, /^user:/, 'the card must never print a raw user:<uuid>')

  const label = niches.formulaCardLabel({ niche_id: fork.fork_id, formula_choice: 'selected' }, names)
  assert.equal(label, name, 'the card shows the fork name as stored')

  // The fork is not the picker's business any more.
  const listed = (await niches.listNicheCatalogEntries()).map(entry => entry.value.id)
  assert.equal(listed.includes(fork.fork_id), false)
})

test('a channel whose Formula no pack publishes still gets its real name, not the stored id', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const [row] = await niches.withFormulaLabels([{ niche_id: 'sleep', formula_choice: 'selected' }])
  assert.ok(row, 'the row survives labelling')
  assert.notEqual(row!.formula_name, 'sleep', 'the shipped profile still names the channel Formula')
  assert.doesNotMatch(String(row!.formula_name), /^com\.storystudio\./, 'the name comes from the Formula, not an id')
})

// ── Visual styles ─────────────────────────────────────────────────────────

test('the Style Library lists installed packs only; the owner copy stays for the channels that carry it', async t => {
  const { temporary, options } = await tempWithPacks([{
    packId: 'com.storystudio.pack.style.pack-only-list-test',
    document: styleDocument(BOLD_STYLE_ID, 'Bold Illustrated History', 'Bold flat illustration, thick ink lines.'),
    withAsset: true,
  }])
  t.after(temporary.cleanup)
  await installUserStylePack({
    user_pack_format: 1,
    pack_id: 'kh.owner.style',
    name: 'Owner styles',
    version: '1.0.0',
    styles: [{
      kind: 'visual-style',
      schema_version: 1,
      id: OWNER_COPY_ID,
      name: 'Bold illustrated history (mine)',
      description: 'The owner copy of this look.',
      category: 'illustration',
      tags: ['test'],
      style_bible: 'Bold flat illustration, thick ink lines.',
      compatible_formula_ids: [],
    }],
  }, options.paths)

  const listed = (await styles.listVisualStyles(options)).map(style => style.id)
  assert.ok(listed.includes(BOLD_STYLE_ID), 'the installed Store style is listed')
  assert.equal(listed.includes(OWNER_COPY_ID), false, 'a user style pack style is no longer listed')

  // The id keeps resolving exactly as today: it reads the Store style through
  // the alias table (owner, 2026-10-29 — "the Studio Library style is the one").
  assert.equal(aliasedVisualStyleId(OWNER_COPY_ID), BOLD_STYLE_ID)
  assert.ok(STYLE_ALIASES.some(alias => alias.styleId === BOLD_STYLE_ID
    && alias.presetIds.includes(OWNER_COPY_ID)))

  // Nothing was rewritten on disk.
  const stored = JSON.parse(await fs.readFile(
    path.join(options.paths.root, 'user-style-packs', 'kh.owner.style.json'), 'utf8'))
  assert.equal(stored.styles[0].id, OWNER_COPY_ID, 'the stored user pack is untouched')
})

test('a stored legacy style preset still reads the Store style that owns the look', async t => {
  const { temporary, options } = await tempWithPacks([{
    packId: 'com.storystudio.pack.style.pack-only-list-test',
    document: styleDocument(BOLD_STYLE_ID, 'Bold Illustrated History', 'Bold flat illustration, thick ink lines.'),
    withAsset: true,
  }])
  t.after(temporary.cleanup)

  const aliased = aliasedVisualStyleId('kh.owner.illustrated-history.bold-illustrated-history')
  assert.equal(aliased, BOLD_STYLE_ID, 'the older preset id still resolves to the same style')
  const loaded = await styles.loadVisualStyle(aliased!, options)
  assert.ok(loaded, 'a style the list offers must load by the id the alias names')
  assert.equal(loaded!.id, BOLD_STYLE_ID)
  assert.match(loaded!.data.style_bible, /thick ink lines/)
})

test('the shipped Formula and Topic Pack sources are still on disk — hidden is not deleted', async () => {
  const nicheFiles = await fs.readdir(path.join(ROOT, 'electron', 'server', 'niches'))
  const topicFiles = await fs.readdir(path.join(ROOT, 'electron', 'server', 'topic-packs'))
  assert.ok(nicheFiles.some(name => name === 'sleep.json'), 'the shipped sleep profile is still shipped')
  assert.ok(topicFiles.some(name => name === 'historical-wars-treaties-world-order.json'),
    'the legacy Wars Topic Pack is still shipped as the read-only fallback')
})
