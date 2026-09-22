/**
 * A delivered `font_pack` product must change the picture, not just the picker.
 *
 * The 2026-09-22 wire-kind parity letter asked Story to bridge
 * `lettering-style` (pack kind) ↔ `font_pack` (wire kind) end to end:
 * delivery → install → `letteringCatalogue()`. Checking that request against
 * current source found the chain already worked up to a point, and one real gap
 * after it:
 *
 *   - the wire kind parses (`PRODUCT_KINDS` has `font_pack`, since 1.4.62);
 *   - installation is archive-manifest driven and kind-agnostic, so a
 *     `lettering-style` archive installs and activates;
 *   - `letteringCatalogue()` already lists installed lettering-style packs;
 *   - BUT the thumbnail prompt builders resolved the chosen style id against the
 *     hardcoded `FONT_STYLES` / `TEXT_STYLES` maps only. A pack style id is not
 *     in those maps, so the run silently used the built-in serif: the customer
 *     saw the swatch they paid for and the image model was told to draw
 *     something else.
 *
 * These tests drive the real installer with a signed `lettering-style` archive
 * and then assert the phrase actually reaches the prompt — the part that was
 * missing — plus the built-in fallbacks that must not regress.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { letteringCatalogue, letteringPhraseMaps } from '../services/lettering-catalogue.js'
import { buildThumbnailDirective, enforceThumbnailPromptElements } from '../generators/image-prompts.js'
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-lettering-bridge'
const PACK_ID = 'com.storystudio.pack.lettering.bridge-probe'
const PACK_VERSION = '2.0.0'
// A namespaced id of its own, as a real re-homed pack would have; it must not
// collide with any built-in on either axis.
const PACK_FONT_ID = 'com.storystudio.lettering.molten-brass-probe'
const PACK_TEXT_ID = 'com.storystudio.lettering.red-glow-finish-probe'
const PACK_FONT_PHRASE = 'molten brass letterforms, hot rim light along every edge, dark cooling shadow'
const PACK_TEXT_PHRASE = 'red glow bloom with a soft dark falloff, warm highlights on the letter edges'
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
)

const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The archive the Gateway would deliver for a `font_pack` product: the wire
 * kind is `font_pack`, and the SIGNED manifest inside declares the pack kind
 * `lettering-style` with both axes, exactly as the schema requires. The two
 * spellings are allowed to differ because the wire kind is a catalogue/Merch
 * concern and installation reads the manifest.
 */
async function buildLetteringArchive(): Promise<Uint8Array> {
  const fontDocument = Buffer.from(JSON.stringify({
    kind: 'lettering-style',
    schema_version: 1,
    id: PACK_FONT_ID,
    name: 'Molten Brass',
    description: 'Poured metal letterforms with a hot rim light.',
    axis: 'font',
    phrase: PACK_FONT_PHRASE,
    preview_assets: ['assets/font.png'],
  }), 'utf8')
  const textDocument = Buffer.from(JSON.stringify({
    kind: 'lettering-style',
    schema_version: 1,
    id: PACK_TEXT_ID,
    name: 'Red Glow Finish',
    description: 'A hot rim light on every letter edge.',
    axis: 'text',
    phrase: PACK_TEXT_PHRASE,
    preview_assets: ['assets/text.png'],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: PACK_ID,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: PACK_VERSION,
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [],
    items: [
      { id: PACK_FONT_ID, kind: 'lettering-style', schema_version: 1, path: 'content/font.json' },
      { id: PACK_TEXT_ID, kind: 'lettering-style', schema_version: 1, path: 'content/text.json' },
    ],
    files: [
      { path: 'content/font.json', sha256: sha256(fontDocument), bytes: fontDocument.byteLength, mime: 'application/json' },
      { path: 'content/text.json', sha256: sha256(textDocument), bytes: textDocument.byteLength, mime: 'application/json' },
      { path: 'assets/font.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
      { path: 'assets/text.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file('content/font.json', fontDocument, { createFolders: false })
  zip.file('content/text.json', textDocument, { createFolders: false })
  zip.file('assets/font.png', PNG_1PX, { createFolders: false })
  zip.file('assets/text.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

/** Install the delivered pack through Story's own installer, as the Store does. */
async function installDeliveredPack(): Promise<ReturnType<typeof getContentPackRuntimePaths>> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const archiveBytes = await buildLetteringArchive()
  const result = await installContentPack(
    { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
    { paths, policy },
  )
  assert.equal(result.activated, true, 'the delivered pack must activate, or the catalogue will not read it')
  return paths
}

describe('a delivered font_pack product reaches the picker', () => {
  test('both axes of the installed pack list in letteringCatalogue() with their swatches', async () => {
    const paths = await installDeliveredPack()
    const rows = await letteringCatalogue({ paths, policy })
    const font = rows.find(row => row.axis === 'font' && row.id === PACK_FONT_ID)
    const text = rows.find(row => row.axis === 'text' && row.id === PACK_TEXT_ID)

    assert.ok(font, 'the delivered font must appear in the picker catalogue')
    assert.equal(font.source, 'pack')
    assert.equal(font.packId, PACK_ID)
    assert.equal(font.phrase, PACK_FONT_PHRASE)
    assert.ok(font.previewUrl?.includes(encodeURIComponent(PACK_ID)),
      'the swatch must come from the pack, not a paid re-render')
    assert.ok(text, 'the delivered text style must appear too')
    assert.equal(text.phrase, PACK_TEXT_PHRASE)
  })
})

describe('a delivered font_pack product reaches the prompt', () => {
  test('the pack phrase is what the image model is told to draw', async () => {
    const paths = await installDeliveredPack()
    const phrases = await letteringPhraseMaps({ paths, policy })

    assert.equal(phrases.font[PACK_FONT_ID], PACK_FONT_PHRASE, 'the catalogue map must carry the pack font')
    assert.equal(phrases.text[PACK_TEXT_ID], PACK_TEXT_PHRASE, 'and the pack text style')

    const directive = buildThumbnailDirective({
      thumbs: 3,
      title: 'A measured probe',
      fontStyle: PACK_FONT_ID,
      textStyle: PACK_TEXT_ID,
      textPosition: 'bottom',
      fontPhrases: phrases.font,
      textPhrases: phrases.text,
    })

    assert.ok(directive.includes(PACK_FONT_PHRASE),
      'the bought font phrase must reach the directive — this is the defect the bridge fixes')
    assert.ok(directive.includes(PACK_TEXT_PHRASE), 'and the bought text treatment')
    assert.ok(!directive.includes(FONT_STYLES.serif),
      'the built-in serif must not stand in for a style the customer bought')
  })

  test('the enforcement clause names the bought style too, not the fallback', async () => {
    const paths = await installDeliveredPack()
    const phrases = await letteringPhraseMaps({ paths, policy })
    const prompt = enforceThumbnailPromptElements('A cover with no title instruction yet.', {
      aspectRatio: '16:9',
      title: 'A measured probe',
      fontStyle: PACK_FONT_ID,
      textStyle: PACK_TEXT_ID,
      textPosition: 'bottom',
      fontPhrases: phrases.font,
      textPhrases: phrases.text,
    })

    assert.ok(prompt.includes(PACK_FONT_PHRASE), 'the appended clause must carry the pack phrase')
    assert.ok(!prompt.includes('a font chosen to suit the concept'),
      'a deliberate choice must never be described as unchosen')
  })

  test('a recipe default that names a pack style is honoured on the auto path', async () => {
    const paths = await installDeliveredPack()
    const phrases = await letteringPhraseMaps({ paths, policy })
    // The effective id may come from the recipe rather than the request, which
    // is why the whole catalogue map is resolved instead of probing two ids.
    const directive = buildThumbnailDirective({
      thumbs: 1,
      title: 'A measured probe',
      fontStyle: 'auto',
      textStyle: 'auto',
      fmt: { defaultFontStyle: PACK_FONT_ID, defaultTextStyle: PACK_TEXT_ID },
      fontPhrases: phrases.font,
      textPhrases: phrases.text,
    })

    assert.ok(directive.includes(PACK_FONT_PHRASE), 'an auto run must still resolve a pack style the recipe chose')
    assert.ok(directive.includes(PACK_TEXT_PHRASE))
  })
})

describe('built-in lettering is unchanged', () => {
  test('a built-in id still resolves from the hardcoded maps', () => {
    const directive = buildThumbnailDirective({
      thumbs: 1,
      title: 'A measured probe',
      fontStyle: 'display',
      textStyle: 'neon',
      fmt: null,
    })
    assert.ok(directive.includes(FONT_STYLES.display!), 'the built-in font phrase must still be used')
    assert.ok(directive.includes(TEXT_STYLES.neon!), 'and the built-in treatment')
  })

  test('an unknown id still falls back to the built-in serif rather than an empty instruction', () => {
    const directive = buildThumbnailDirective({
      thumbs: 1,
      title: 'A measured probe',
      fontStyle: 'com.example.lettering.not-installed',
      fmt: null,
    })
    assert.ok(directive.includes(FONT_STYLES.serif!), 'an uninstalled style must not leave the clause empty')
  })

  test('the catalogue still offers every built-in beside the pack styles', async () => {
    const paths = await installDeliveredPack()
    const rows = await letteringCatalogue({ paths, policy })
    const builtIns = rows.filter(row => row.source === 'built-in')
    assert.equal(builtIns.length, Object.keys(FONT_STYLES).length + Object.keys(TEXT_STYLES).length)
    assert.ok(!builtIns.some(row => row.id === PACK_FONT_ID), 'a pack style must not masquerade as built-in')
    assert.ok(path.isAbsolute(paths.installedRoot), 'sanity: the fixture wrote to an absolute temp root')
  })
})
