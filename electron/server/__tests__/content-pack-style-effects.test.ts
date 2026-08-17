/**
 * Caption looks and scene effects as Content Pack content (v1.2.1).
 *
 * The three things this file is really defending:
 *
 *  1. The free library never depends on the pack subsystem. Every list must be
 *     byte-identical to v1.2.0 with nothing installed.
 *  2. A pack ADDS. It cannot replace a built-in, cannot smuggle executable or
 *     addressable content past a shape check, and cannot render approximately
 *     when it was authored against an engine this build does not have.
 *  3. Uninstalling never changes a render silently. A caption look survives
 *     because applying one copies the document into the episode; an effect
 *     cannot, so its render stops and names what is missing.
 */

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { setContentPackDiscoveryDisabled } from '../content-packs/lifecycle.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState } from '../content-packs/state.js'
import { ContentPackDocumentSchema, ContentPackItemKindSchema } from '../content-packs/schemas.js'
import {
  appendPackEntries,
  listSceneEffectLibrary,
  listSubtitleStylePresets,
  type ContentEntryRefusal,
} from '../services/style-effect-loader.js'
import {
  BUILT_IN_FOOTAGE_MOTIONS,
  BUILT_IN_OVERLAYS,
  BUILT_IN_SCENE_MOTIONS,
  MissingPackEffectError,
  assertNoUnavailablePackOverlays,
  resolveAppliedOverlays,
  sceneEffectCatalog,
} from '../contracts/scene-effect-presets.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { defaultSubtitleStyle, normalizeSubtitleStyle } from '../contracts/subtitle-style.js'
import { defaultSceneMotion, defaultSceneOverlay } from '../contracts/scene-effects.js'
import { isContentPackItemId, type ContentOrigin } from '../contracts/content-origin.js'
import { buildAnimationFilter } from '../lib/animation-filters.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-style-effects'
const PACK_ID = 'com.storystudio.pack.looks-test'
const STYLE_ID = `${PUBLISHER_ID}.subtitle.midnight-serif`
const MOTION_ID = `${PUBLISHER_ID}.motion.long-drift`
const OVERLAY_ID = `${PUBLISHER_ID}.overlay.amber-haze`

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

/** The caption look the fixture pack ships: the default, dressed differently. */
function packStyleDocument(): Record<string, unknown> {
  return {
    ...defaultSubtitleStyle(),
    typography: { ...defaultSubtitleStyle().typography, font_family: 'Georgia', font_size_px: 33 },
    color: { ...defaultSubtitleStyle().color, primary_hex: '#EFE3C8' },
    word: { ...defaultSubtitleStyle().word, mode: 'highlight' },
  }
}

function packMotionDocument(): Record<string, unknown> {
  const base = defaultSceneMotion()
  return {
    ...base,
    framing: { source_scale_pct: 200 },
    zoom: { ...base.zoom, mode: 'ramp', from_pct: 100, to_pct: 104 },
  }
}

function packOverlayDocument(): Record<string, unknown> {
  return { ...defaultSceneOverlay('light-leak'), color_hex: '#FFB347', intensity: 0.4 }
}

interface DocumentOverrides {
  style?: Record<string, unknown>
  motion?: Record<string, unknown>
  overlay?: Record<string, unknown>
}

function fixtureDocuments(overrides: DocumentOverrides = {}): Array<Record<string, unknown>> {
  return [
    {
      kind: 'subtitle-style', schema_version: 1, id: STYLE_ID,
      name: 'Midnight Serif', description: 'A warm serif caption for late-night stories.',
      style: overrides.style ?? packStyleDocument(),
    },
    {
      kind: 'scene-effect', schema_version: 1, id: MOTION_ID, category: 'zoom',
      name: 'Long Drift', description: 'A very slow push, gentler than Ken Burns.',
      motion: overrides.motion ?? packMotionDocument(),
    },
    {
      kind: 'overlay', schema_version: 1, id: OVERLAY_ID, category: 'light',
      name: 'Amber Haze', description: 'A warm haze drifting down the right of the frame.',
      approximation: 'A soft coloured blob screen-blended over the picture, not true film fogging.',
      overlay: overrides.overlay ?? packOverlayDocument(),
    },
  ]
}

const CONTENT_PATHS = ['content/subtitle-style.json', 'content/scene-effect.json', 'content/overlay.json']
const KINDS = ['subtitle-style', 'scene-effect', 'overlay'] as const

async function buildArchive(overrides: DocumentOverrides = {}): Promise<Uint8Array> {
  const documents = fixtureDocuments(overrides)
    .map(document => Buffer.from(JSON.stringify(document), 'utf8'))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: PACK_ID, publisher_id: PUBLISHER_ID, key_id: KEY_ID,
    version: '1.0.0', min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [],
    items: KINDS.map((kind, index) => ({
      id: [STYLE_ID, MOTION_ID, OVERLAY_ID][index],
      kind,
      schema_version: 1,
      path: CONTENT_PATHS[index],
    })),
    files: CONTENT_PATHS.map((path, index) => ({
      path,
      sha256: sha256(documents[index]),
      bytes: documents[index].byteLength,
      mime: 'application/json',
    })),
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  for (const [index, path] of CONTENT_PATHS.entries()) {
    zip.file(path, documents[index], { createFolders: false })
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return getContentPackRuntimePaths()
}

async function installFixture(overrides: DocumentOverrides = {}) {
  const paths = await isolated()
  const archiveBytes = await buildArchive(overrides)
  await installContentPack(
    { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
    { paths, policy },
  )
  return { paths, options: { paths, policy } }
}

/** Every problem a document parse reported, flattened to one searchable string. */
function refusalMessage(document: unknown): string {
  const result = ContentPackDocumentSchema.safeParse(document)
  assert.equal(result.success, false, 'expected the document to be refused')
  return JSON.stringify(result.error!.issues)
}

describe('Content Pack style and effect kinds', () => {
  test('the free library is complete and unchanged with no pack installed', async () => {
    const options = { paths: await isolated(), policy }

    const captions = await listSubtitleStylePresets(options)
    assert.equal(captions.refusals.length, 0)
    assert.deepEqual(
      captions.presets.map(preset => preset.id),
      BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id),
      'the sixteen shipped caption looks must be the whole gallery, in their shipped order',
    )
    assert.ok(captions.presets.every(preset => preset.origin.origin === 'built-in'))
    for (const preset of captions.presets) {
      const shipped = BUILT_IN_SUBTITLE_PRESETS.find(candidate => candidate.id === preset.id)!
      assert.deepEqual(preset.style, shipped.style, `${preset.id} must be the shipped document, untouched`)
    }

    const effects = await listSceneEffectLibrary(options)
    assert.equal(effects.refusals.length, 0)
    const shipped = sceneEffectCatalog()
    assert.deepEqual(effects.scene_motions.map(m => m.id), shipped.scene_motions.map(m => m.id))
    assert.deepEqual(effects.footage_motions.map(m => m.id), shipped.footage_motions.map(m => m.id))
    assert.deepEqual(effects.overlays.map(o => o.id), shipped.overlays.map(o => o.id))
    assert.deepEqual(
      effects.grouped_overlays.map(group => [group.category, group.overlays.length]),
      shipped.grouped_overlays.map(group => [group.category, group.overlays.length]),
    )
    for (const motion of effects.scene_motions) {
      const original = BUILT_IN_SCENE_MOTIONS.find(candidate => candidate.id === motion.id)!
      assert.deepEqual(motion.document, original.document, `${motion.id} must compile from the shipped document`)
    }
  })

  test('a built-in id can never be a pack item id, so the namespaces cannot collide', () => {
    const builtIns = [
      ...BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id),
      ...BUILT_IN_SCENE_MOTIONS.map(motion => motion.id),
      ...BUILT_IN_FOOTAGE_MOTIONS.map(motion => motion.id),
      ...BUILT_IN_OVERLAYS.map(overlay => overlay.id),
    ]
    // This is the invariant the whole no-shadowing story rests on. If a future
    // built-in is ever given a dotted id, this fails here rather than in a
    // customer's picker.
    const qualified = builtIns.filter(isContentPackItemId)
    assert.deepEqual(qualified, [], 'built-in ids must stay bare slugs')
  })

  test('every new kind is a pack item kind', () => {
    for (const kind of KINDS) assert.equal(ContentPackItemKindSchema.safeParse(kind).success, true)
  })

  test('a valid pack adds a caption look, a camera move and an overlay, each naming its pack', async () => {
    const { options } = await installFixture()

    const captions = await listSubtitleStylePresets(options)
    assert.equal(captions.refusals.length, 0)
    assert.equal(captions.presets.length, BUILT_IN_SUBTITLE_PRESETS.length + 1)
    const added = captions.presets.find(preset => preset.id === STYLE_ID)!
    assert.ok(added, 'the pack caption look must appear in the gallery')
    assert.deepEqual(added.origin, { origin: 'content-pack', pack_id: PACK_ID, pack_version: '1.0.0' })
    assert.equal(added.name, 'Midnight Serif')
    assert.equal(added.style.typography.font_family, 'Georgia')
    assert.equal(added.wordLevel, true, 'wordLevel is derived from the document, not declared')
    // The shipped sixteen keep their slots, ahead of anything installed.
    assert.deepEqual(
      captions.presets.slice(0, BUILT_IN_SUBTITLE_PRESETS.length).map(preset => preset.id),
      BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id),
    )

    const effects = await listSceneEffectLibrary(options)
    assert.equal(effects.refusals.length, 0)
    const motion = effects.scene_motions.find(entry => entry.id === MOTION_ID)!
    assert.ok(motion, 'the pack camera move must appear among the scene motions')
    assert.equal(motion.category, 'zoom')
    assert.equal(motion.legacy_binding, 'none')
    assert.equal(motion.document.zoom.to_pct, 104)
    assert.deepEqual(motion.origin, { origin: 'content-pack', pack_id: PACK_ID, pack_version: '1.0.0' })
    // A still move must not leak into the B-Roll registry — they are separate
    // engines and six of the seven footage ids also name a scene animation.
    assert.equal(effects.footage_motions.some(entry => entry.id === MOTION_ID), false)
    assert.deepEqual(effects.footage_motions.map(entry => entry.id), BUILT_IN_FOOTAGE_MOTIONS.map(entry => entry.id))

    const overlay = effects.overlays.find(entry => entry.id === OVERLAY_ID)!
    assert.ok(overlay, 'the pack overlay must appear in the overlay library')
    assert.equal(overlay.document.kind, 'light-leak')
    assert.equal(overlay.category, 'light')
    assert.deepEqual(overlay.origin, { origin: 'content-pack', pack_id: PACK_ID, pack_version: '1.0.0' })
    assert.ok(effects.grouped_overlays.find(group => group.category === 'light')!
      .overlays.some(entry => entry.id === OVERLAY_ID), 'it must be grouped with the other light effects')
  })

  test('a pack camera move actually renders, and reaches the compiler as data', async () => {
    const { options } = await installFixture()
    const library = (await listSceneEffectLibrary(options)).scene_motions
    const filters = buildAnimationFilter({
      type: MOTION_ID,
      params: { type: MOTION_ID } as never,
      library,
      w: 1920, h: 1080, fps: 30, duration: 5,
    })
    assert.ok(filters.some(token => token.startsWith('zoompan')), 'a ramping zoom must compile to zoompan')
    assert.deepEqual(
      buildAnimationFilter({ type: 'none', params: { type: 'none' } as never, library, w: 1920, h: 1080, fps: 30, duration: 5 }),
      buildAnimationFilter({ type: 'none', params: { type: 'none' } as never, w: 1920, h: 1080, fps: 30, duration: 5 }),
      'a built-in compiles identically whether or not a pack library is supplied',
    )
  })

  test('a pack overlay reaches the render selection and keeps its approximation note', async () => {
    const { options } = await installFixture()
    const library = (await listSceneEffectLibrary(options)).overlays
    const { resolved, unavailable } = resolveAppliedOverlays(
      { enabled: true, overlays: [{ id: OVERLAY_ID, enabled: true, params: { intensity: 0.9 } }] },
      library,
    )
    assert.deepEqual(unavailable, [])
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].name, 'Amber Haze')
    assert.equal((resolved[0].document as { intensity: number }).intensity, 0.9)
    assert.match(resolved[0].approximation!, /screen-blended/)
  })

  test('an id that collides with a built-in is refused by name', () => {
    for (const [kind, key, id] of [
      ['subtitle-style', 'style', BUILT_IN_SUBTITLE_PRESETS[0].id],
      ['scene-effect', 'motion', BUILT_IN_SCENE_MOTIONS[0].id],
      ['overlay', 'overlay', BUILT_IN_OVERLAYS[0].id],
    ] as const) {
      const document = fixtureDocuments().find(candidate => candidate.kind === kind)!
      const message = refusalMessage({ ...document, id, [key]: document[key] })
      assert.match(message, /collides with the built-in/)
      assert.match(message, new RegExp(id))
      assert.match(message, /never replace or shadow a built-in/)
    }
  })

  test('an unknown field is refused by name rather than ignored', () => {
    const message = refusalMessage({
      ...fixtureDocuments()[0],
      style: { ...packStyleDocument(), glow_radius_px: 12 },
    })
    assert.match(message, /glow_radius_px/)
    assert.match(message, /authored for a newer subtitle engine/)

    // An unknown field on the PACK wrapper is refused the same way, by the
    // `.strict()` object rather than by the engine.
    const wrapper = refusalMessage({ ...fixtureDocuments()[2], install_script: 'rm -rf /' })
    assert.match(wrapper, /install_script/)
  })

  test('a pack cannot smuggle executable, addressable or credential content past a shape check', () => {
    // Every one of these is a perfectly valid STRING as far as the engine
    // schema is concerned. The pack rules are what reject them.
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ overlay: { ...defaultSceneOverlay('lower-third'), title: 'Watch at example.com/deal' } }, /URI references/],
      [{ overlay: { ...defaultSceneOverlay('lower-third'), subtitle: 'api_key: sk-live-9f2b71ccaa41' } }, /credential, token, or account/],
      [{ overlay: { ...defaultSceneOverlay('lower-third'), title: 'route via provider fal' } }, /routing directives/],
    ]
    for (const [override, expected] of cases) {
      const message = refusalMessage({ ...fixtureDocuments()[2], ...override })
      assert.match(message, expected)
    }

    // A corner logo names a file on the customer's machine. A pack supplying
    // one is either guessing or aiming the compiler at a file of its choosing.
    const logo = refusalMessage({
      ...fixtureDocuments()[2], category: 'brand',
      overlay: { ...defaultSceneOverlay('corner-logo'), image_path: '/Users/someone/Pictures/mark.png' },
    })
    assert.match(logo, /must not supply overlay\.image_path/)
  })

  test('a document authored for a newer engine names the version it needs', () => {
    const newerCaption = refusalMessage({
      ...fixtureDocuments()[0],
      style: { ...packStyleDocument(), schema_version: 3 },
    })
    assert.match(newerCaption, /needs subtitle style schema version 3/)
    assert.match(newerCaption, /Story Studio build implements version 2/i)
    assert.match(newerCaption, /update Story Studio/i)
    assert.match(newerCaption, /schema_version/)

    const newerEffect = refusalMessage({
      ...fixtureDocuments()[2],
      overlay: { ...packOverlayDocument(), schema_version: 9 },
    })
    assert.match(newerEffect, /needs scene overlay schema version 9/)
    assert.match(newerEffect, /Story Studio build implements version 1/i)

    const retired = refusalMessage({
      ...fixtureDocuments()[1],
      motion: { ...packMotionDocument(), schema_version: 0 },
    })
    assert.match(retired, /schema_version/)
  })

  test('a footage move and a still move cannot be filed under each other', () => {
    const message = refusalMessage({
      ...fixtureDocuments()[1],
      category: 'footage',
      motion: packMotionDocument(),
    })
    assert.match(message, /category .*footage.* and motion\.source .*footage.* must be used together/)
  })

  test('an overlay category outside the app-owned list is refused', () => {
    const message = refusalMessage({ ...fixtureDocuments()[2], category: 'sparkles' })
    assert.match(message, /category/)
  })

  test('removing a pack takes its entries out and never silently changes a render', async () => {
    const { paths, options } = await installFixture()

    // What the episode stored when the customer applied the pack caption look.
    // The picker emits STYLE and nothing else, so this is a plain document.
    const episodeStyle = (await listSubtitleStylePresets(options)).presets
      .find(preset => preset.id === STYLE_ID)!.style
    assert.equal(episodeStyle.typography.font_family, 'Georgia')

    // The pack is gone from the library. Deleting the state entry is the state
    // a true uninstall, a fresh machine or a wiped install leaves behind;
    // `setContentPackDiscoveryDisabled` and a Store recall reach the same
    // observable through a different door, and everything below is about that
    // observable rather than about which door was used.
    await mutateContentPackState(state => { delete state.packs[PACK_ID] }, paths)

    // 1. Gone from both pickers, and the free library is untouched.
    const captions = await listSubtitleStylePresets(options)
    assert.deepEqual(captions.presets.map(preset => preset.id), BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id))
    const effects = await listSceneEffectLibrary(options)
    assert.equal(effects.scene_motions.some(entry => entry.id === MOTION_ID), false)
    assert.equal(effects.overlays.some(entry => entry.id === OVERLAY_ID), false)
    assert.deepEqual(effects.overlays.map(entry => entry.id), BUILT_IN_OVERLAYS.map(entry => entry.id))

    // 2. The episode's captions are unaffected, because the look was COPIED
    //    into the episode when it was applied. No fallback, silent or loud.
    assert.deepEqual(normalizeSubtitleStyle(episodeStyle), episodeStyle)
    assert.notDeepEqual(normalizeSubtitleStyle(episodeStyle), defaultSubtitleStyle())

    // 3. An effect cannot be copied — it is resolved fresh on every render. So
    //    the selection is reported as unavailable and NAMED as pack content...
    const { resolved, unavailable } = resolveAppliedOverlays(
      { enabled: true, overlays: [{ id: OVERLAY_ID, enabled: true }] },
      effects.overlays,
    )
    assert.deepEqual(resolved, [])
    assert.deepEqual(unavailable, [{ id: OVERLAY_ID, from_content_pack: true }])

    // ...and the render refuses rather than publishing a video without it.
    assert.throws(
      () => assertNoUnavailablePackOverlays(unavailable),
      (error: unknown) => {
        assert.ok(error instanceof MissingPackEffectError)
        assert.deepEqual(error.effectIds, [OVERLAY_ID])
        assert.match(error.message, new RegExp(OVERLAY_ID))
        assert.match(error.message, /published by com\.storystudio/)
        assert.match(error.message, /Reinstall the pack/)
        assert.match(error.message, /no completed work is repeated/)
        return true
      },
    )

    // The same rule for a camera move, which fails at the point of compiling it.
    assert.throws(
      () => buildAnimationFilter({
        type: MOTION_ID, params: { type: MOTION_ID } as never,
        library: effects.scene_motions, w: 1920, h: 1080, fps: 30, duration: 5,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MissingPackEffectError)
        assert.match(error.message, /Content Pack that is not installed/)
        return true
      },
    )
  })

  test('disabling a pack takes its entries out of the pickers too', async () => {
    const { paths, options } = await installFixture()
    assert.equal((await listSceneEffectLibrary(options)).overlays.some(entry => entry.id === OVERLAY_ID), true)

    await setContentPackDiscoveryDisabled(PACK_ID, true, { paths, policy })

    const effects = await listSceneEffectLibrary(options)
    assert.deepEqual(effects.overlays.map(entry => entry.id), BUILT_IN_OVERLAYS.map(entry => entry.id))
    const captions = await listSubtitleStylePresets(options)
    assert.deepEqual(captions.presets.map(preset => preset.id), BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id))
  })

  test('a bare unknown id stays survivable, exactly as it was in v1.2.0', () => {
    const { resolved, unavailable } = resolveAppliedOverlays({
      enabled: true,
      overlays: [{ id: 'hand-typed-nonsense', enabled: true }, { id: 'vignette-soft', enabled: true }],
    })
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].id, 'vignette-soft')
    assert.deepEqual(unavailable, [{ id: 'hand-typed-nonsense', from_content_pack: false }])
    // Nothing to refuse: a bare id was never pack content.
    assert.doesNotThrow(() => assertNoUnavailablePackOverlays(unavailable))
  })

  test('the merge refuses a collision loudly instead of letting a pack win a lookup', () => {
    // Unreachable today: built-in ids are bare and pack ids are qualified, and
    // the test above pins that. This is the guard for the day that stops being
    // true, so it is exercised directly rather than left as an assertion nobody
    // has ever run.
    const refusals: ContentEntryRefusal[] = []
    const builtIn: { id: string; origin: ContentOrigin } = {
      id: 'com.storystudio.overlay.clash',
      origin: { origin: 'built-in' },
    }
    const fromPack: { id: string; origin: ContentOrigin } = {
      id: 'com.storystudio.overlay.clash',
      origin: { origin: 'content-pack', pack_id: PACK_ID, pack_version: '1.0.0' },
    }
    const merged = appendPackEntries([builtIn], [fromPack], 'overlay', refusals)

    assert.deepEqual(merged, [builtIn], 'the built-in keeps the slot')
    assert.equal(refusals.length, 1)
    assert.equal(refusals[0].item_id, 'com.storystudio.overlay.clash')
    assert.equal(refusals[0].pack_id, PACK_ID)
    assert.match(refusals[0].reason, /may never replace or shadow a built-in/)

    // Two packs claiming one id is refused too, and says which pack got there
    // first rather than picking one at random.
    const second: { id: string; origin: ContentOrigin } = {
      id: fromPack.id,
      origin: { origin: 'content-pack', pack_id: 'com.storystudio.pack.other' },
    }
    const again: ContentEntryRefusal[] = []
    assert.deepEqual(appendPackEntries([], [fromPack, second], 'overlay', again), [fromPack])
    assert.match(again[0].reason, new RegExp(PACK_ID))
  })

  test('a tampered pack is dropped whole and the free library survives it', async () => {
    const { paths, options } = await installFixture()

    // Corrupt the installed overlay document AFTER verification, the way a disk
    // fault or a hand-edit would. The closure check refuses the whole pack —
    // an archive that no longer matches what was signed is not partially
    // trustworthy — and every built-in must still be there afterwards.
    const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'))
    const installPath = state.packs[PACK_ID].versions['1.0.0'].install_path
    await fs.writeFile(`${installPath}/content/overlay.json`, '{ not json', 'utf8')

    const effects = await listSceneEffectLibrary(options)
    assert.deepEqual(effects.overlays.map(entry => entry.id), BUILT_IN_OVERLAYS.map(entry => entry.id))
    const captions = await listSubtitleStylePresets(options)
    assert.deepEqual(captions.presets.map(preset => preset.id), BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id))
  })
})
