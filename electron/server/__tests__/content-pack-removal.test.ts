/**
 * Removing a Content Pack from this Mac — owner, 2026-10-29: the Library only
 * offers things to download, so a pack can be taken off this Mac as plainly as
 * it was put on. Nothing is ever deleted: the bytes go to Story's Trash and can
 * be put back. A channel that still uses the pack refuses the removal by name.
 *
 * Also pinned here: the Gateway's "take this off installs" request, in either
 * published shape, applied at most once per `remove_from_installs_at`.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import {
  applyGatewayPackRemovals,
  contentPackUsage,
  markPackRemovalReportsSent,
  pendingPackRemovalReports,
  readContentPackRemovalStatus,
  readContentPackRemovalStore,
  removeContentPack,
  restoreContentPack,
  ContentPackRemovalError,
} from '../content-packs/removal.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { projectsRoot } from '../services/project-manager.js'
import { parseContentStoreCatalog } from '../lib/genstudio-content-store.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-removal'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
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

async function buildArchive(packId = 'com.storystudio.removal-test', version = '1.0.0', itemId = `${packId}.style`): Promise<Uint8Array> {
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: itemId, name: 'Removal Test',
    description: 'A strict local removal fixture.', category: 'Test', tags: ['test'],
    style_bible: 'Keep the scene clear.', negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version,
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: itemId, kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file('content/visual-style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return getContentPackRuntimePaths()
}

async function install(
  packId: string,
  version: string,
  paths: Awaited<ReturnType<typeof isolated>>,
  itemId?: string,
): Promise<void> {
  const archiveBytes = await buildArchive(packId, version, itemId)
  await installContentPack(
    { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
    { paths, policy, appVersion: '1.0.0' },
  )
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, () => false)
}

/** A channel folder exactly as the app finds one: project.json + config.json. */
async function channel(slug: string, config: Record<string, unknown> | string, project: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(projectsRoot(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ slug, name: slug, created_at: new Date(0).toISOString(), ...project }))
  await fs.writeFile(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
}

describe('removing a Content Pack from this Mac', () => {
  test('moves every version into Story Trash, forgets the pack, and records where the bytes went', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths)
    await install(packId, '1.1.0', paths)
    const before = await readContentPackState(paths)
    const installPaths = Object.values(before.packs[packId]!.versions).map(version => version.install_path)

    const result = await removeContentPack(packId, { paths, policy })

    assert.deepEqual(result.removed.map(version => version.version).sort(), ['1.0.0', '1.1.0'])
    assert.equal((await readContentPackState(paths)).packs[packId], undefined, 'the pack is no longer installed')
    for (const installPath of installPaths) {
      assert.equal(await exists(installPath), false, 'nothing is left at the install path')
    }
    for (const version of result.removed) {
      assert.ok(version.trash_path, 'every removed version says where its bytes went')
      assert.equal(await exists(version.trash_path!), true, 'the bytes are in Story Trash, not deleted')
      assert.match(version.trash_path!, /_trash/)
    }
    const store = await readContentPackRemovalStore(paths)
    assert.equal(store.unreadable, false)
    assert.equal(store.ledger.packs[packId]?.outcome, 'removed')
    assert.equal(store.ledger.packs[packId]?.versions.length, 2)
  })

  test('refuses when a channel uses the pack, names the channels, and moves nothing', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths, 'com.storystudio.formula.sleep-story')
    // Two real channels name the pack's Formula through its legacy alias; the
    // refusal is the same scan the Library page shows, not a test-only seam.
    await channel('channel-one', { niche_id: 'sleep' })
    await channel('channel-two', { niche_id: 'sleep' })
    const before = await readContentPackState(paths)
    const installPath = before.packs[packId]!.versions['1.0.0']!.install_path

    await assert.rejects(
      removeContentPack(packId, { paths, policy }),
      (error: unknown) => {
        assert.ok(error instanceof ContentPackRemovalError)
        assert.equal(error.code, 'CONTENT_PACK_IN_USE')
        assert.deepEqual(error.channels, ['channel-one', 'channel-two'])
        assert.match(error.message, /channel-one, channel-two/)
        return true
      },
    )

    assert.ok((await readContentPackState(paths)).packs[packId], 'a refused removal leaves the pack installed')
    assert.equal(await exists(installPath), true, 'a refused removal moves no file')
    const store = await readContentPackRemovalStore(paths)
    assert.equal(store.ledger.packs[packId]?.outcome, 'kept_in_use')
    assert.deepEqual(store.ledger.packs[packId]?.channels, ['channel-one', 'channel-two'])
  })

  test('refuses a pack that ships inside Story Studio and says so plainly', async () => {
    const paths = await isolated()
    const shippedPackId = 'com.storystudio.shipped-test'
    const recoveryRoot = path.join(paths.root, 'bundled-recovery')
    await fs.mkdir(recoveryRoot, { recursive: true })
    await fs.writeFile(path.join(recoveryRoot, 'shipped.sspack'), await buildArchive(shippedPackId, '1.0.0'))

    await assert.rejects(
      removeContentPack(shippedPackId, { paths: { ...paths, recoveryRoot }, policy }),
      (error: unknown) => {
        assert.ok(error instanceof ContentPackRemovalError)
        assert.equal(error.code, 'CONTENT_PACK_BUILT_IN')
        assert.match(error.message, /ships with Story Studio/)
        return true
      },
    )
  })

  test('a pack that is simply not here is not reported as built in', async () => {
    const paths = await isolated()
    await assert.rejects(
      removeContentPack('com.storystudio.never-installed', { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError && error.code === 'CONTENT_PACK_NOT_INSTALLED',
    )
  })

  test('restores a removed pack from Story Trash to the exact path it came from', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '2.0.0', paths)
    const installPath = (await readContentPackState(paths)).packs[packId]!.versions['2.0.0']!.install_path
    const removal = await removeContentPack(packId, { paths, policy })
    const trashPath = removal.removed[0]!.trash_path!

    await restoreContentPack(packId, { paths, policy })

    const state = await readContentPackState(paths)
    assert.ok(state.packs[packId]?.versions['2.0.0'], 'the version is installed again')
    assert.equal(state.packs[packId]?.active_version, '2.0.0', 'it comes back active, as it was')
    assert.equal(await exists(installPath), true)
    assert.equal(await exists(trashPath), false, 'the Trash copy is no longer there')
    const store = await readContentPackRemovalStore(paths)
    assert.ok(store.ledger.packs[packId]?.restored_at, 'the record says it was restored')
  })

  test('restoring twice is refused instead of claiming a second restore', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths)
    await removeContentPack(packId, { paths, policy })
    await restoreContentPack(packId, { paths, policy })
    await assert.rejects(
      restoreContentPack(packId, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError && error.code === 'CONTENT_PACK_ALREADY_RESTORED',
    )
  })
})

const AT = '2026-10-29T08:00:00Z'

function release(overrides: Record<string, unknown> = {}) {
  return {
    release_id: 'crel_removal', pack_id: 'com.storystudio.removal-test', version: '1.0.0',
    archive_sha256: 'a'.repeat(64), archive_bytes: 4096, min_story_version: '1.0.0',
    changelog: 'First release.', component_summary: {}, ...overrides,
  }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 'cprod_removal', entitlement_family: 'com.storystudio.removal-test', kind: 'visual_style',
    title: 'Removal Test', summary: 'A test.', description: 'Longer.', publisher_id: 'com.storystudio',
    credit_price: 0, free: true, owned: true, retired: false, successor_product_id: null,
    current_release: release(), compatible: true, compatibility_reason: null,
    bundle_components: [], owned_component_credit_value: 0,
    cover: null, hero: null, tags: [], license: null, discount: null, ...overrides,
  }
}

describe('what a channel actually selects counts as a use', () => {
  const PACK_ID = 'com.storystudio.usage-test'

  test('the Formula a channel names in its config, through its legacy alias', async () => {
    const paths = await isolated()
    const itemId = 'com.storystudio.formula.sleep-story'
    await install(PACK_ID, '1.0.0', paths, itemId)
    // `sleep` is the owner's stored id; the alias table maps it to the qualified Formula.
    await channel('sleep-channel', { niche_id: 'sleep' })

    await assert.rejects(
      removeContentPack(PACK_ID, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError
        && error.code === 'CONTENT_PACK_IN_USE'
        && error.channels.includes('sleep-channel'),
    )
    assert.ok((await readContentPackState(paths)).packs[PACK_ID], 'the pack stays installed')
  })

  test('a Topic Pack id selected in the channel config', async () => {
    const paths = await isolated()
    const itemId = 'com.storystudio.topic.forensics'
    await install(PACK_ID, '1.0.0', paths, itemId)
    await channel('topic-channel', { niche_id: 'history-narration', topic_pack_ids: [itemId] })

    await assert.rejects(
      removeContentPack(PACK_ID, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError
        && error.code === 'CONTENT_PACK_IN_USE'
        && error.channels.includes('topic-channel'),
    )
  })

  test('the active style, resolved through the visual-style alias table', async () => {
    const paths = await isolated()
    const itemId = 'com.storystudio.style.carved-woodcut-print'
    await install(PACK_ID, '1.0.0', paths, itemId)
    // A hand-written preset id the alias table maps onto the Store style.
    await channel('style-channel', { active_style_preset_id: 'night-atlas-woodcut' })

    const usage = await contentPackUsage([PACK_ID], paths)
    assert.deepEqual(usage[PACK_ID], ['style-channel'])
    await assert.rejects(
      removeContentPack(PACK_ID, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError && error.code === 'CONTENT_PACK_IN_USE',
    )
  })

  test('a style named inside a preset pool (Scene Plan, thumbnail prompts, Character Sheet)', async () => {
    const paths = await isolated()
    const itemId = 'com.storystudio.style.lush-painterly-scenery'
    await install(PACK_ID, '1.0.0', paths, itemId)
    await channel('preset-channel', {
      niche_id: 'documentary',
      scene_plan_presets: [{ id: 'plan', data: { styling: { visual_style_id: itemId } } }],
      thumbnail_prompts_presets: [{ id: 'thumb', data: { styleId: 'kh.art-styles.golden-hour-painterly' } }],
    })

    const usage = await contentPackUsage([PACK_ID], paths)
    assert.deepEqual(usage[PACK_ID], ['preset-channel'], 'the thumbnail preset names an aliased style of this pack too')
  })

  test('a channel whose config cannot be read refuses the removal instead of reading as unused', async () => {
    const paths = await isolated()
    await install(PACK_ID, '1.0.0', paths)
    await channel('unreadable-channel', '{ this is not json')

    const usage = await contentPackUsage([PACK_ID], paths)
    assert.deepEqual(usage[PACK_ID], ['could not check unreadable-channel'])
    await assert.rejects(
      removeContentPack(PACK_ID, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError
        && error.code === 'CONTENT_PACK_IN_USE'
        && error.channels.includes('could not check unreadable-channel')
        && /still needed by: could not check unreadable-channel/.test(error.message),
    )
    assert.ok((await readContentPackState(paths)).packs[PACK_ID], 'nothing was removed on a check that could not finish')
  })

  test('a channel that names none of it does not block a removal', async () => {
    const paths = await isolated()
    await install(PACK_ID, '1.0.0', paths, 'com.storystudio.style.some-other-style')
    await channel('unrelated-channel', { niche_id: 'history-narration', topic_pack_ids: ['com.storystudio.topic.other'] })
    const usage = await contentPackUsage([PACK_ID], paths)
    assert.deepEqual(usage[PACK_ID], [])
    await removeContentPack(PACK_ID, { paths, policy })
    assert.equal((await readContentPackState(paths)).packs[PACK_ID], undefined)
  })
})

describe('a removal a crash left half-done heals on the next read', () => {
  test('every version is pending with no ledger entry: the bytes go to Trash and the pack stops being listed', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths)
    const installPath = (await readContentPackState(paths)).packs[packId]!.versions['1.0.0']!.install_path
    const { randomUUID } = await import('node:crypto')
    // Exactly the state a crash between the checkpoint and the moves leaves.
    await mutateContentPackState(state => {
      const pack = state.packs[packId]!
      for (const version of Object.values(pack.versions)) {
        version.pending_removal = { operation_id: randomUUID(), started_at: new Date().toISOString() }
      }
      delete pack.active_version
    }, paths)

    const status = await readContentPackRemovalStatus(paths)

    assert.equal((await readContentPackState(paths)).packs[packId], undefined, 'the half-finished removal is finished')
    assert.equal(await exists(installPath), false)
    assert.equal(status.packs[packId]?.outcome, 'removed')
    assert.match(status.packs[packId]?.detail ?? '', /interrupted/)
    assert.ok(status.packs[packId]?.versions[0]?.trash_path, 'the healed removal still says where the bytes are')
  })
})

describe('the Gateway asking for a pack to come off installs', () => {
  test('reads the product-level pair, beside retired', () => {
    const catalog = parseContentStoreCatalog({
      products: [product({ retired: true, remove_from_installs: true, remove_from_installs_at: AT })],
    })
    assert.deepEqual(catalog.retiredPacks, [{
      packId: 'com.storystudio.removal-test', releaseId: 'crel_removal', retiredAt: null, removeFromInstallsAt: AT,
    }])
  })

  test('reads the retired_packs list, and ignores a row that does not ask for removal', () => {
    const catalog = parseContentStoreCatalog({
      products: [product()],
      retired_packs: [
        { pack_id: 'com.storystudio.removal-test', release_id: 'crel_removal', retired_at: AT, remove_from_installs: true, remove_from_installs_at: AT },
        { pack_id: 'com.storystudio.kept', retired_at: AT, remove_from_installs: false },
      ],
    })
    assert.deepEqual(catalog.retiredPacks, [{
      packId: 'com.storystudio.removal-test', releaseId: 'crel_removal', retiredAt: AT, removeFromInstallsAt: AT,
    }])
  })

  test('an older Gateway with neither field means nothing to do', () => {
    assert.deepEqual(parseContentStoreCatalog({ products: [product()] }).retiredPacks, [])
  })

  test('removes an installed pack once per remove_from_installs_at and reports the outcome', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths)
    const entry = { packId, releaseId: 'crel_removal', retiredAt: AT, removeFromInstallsAt: AT }

    const first = await applyGatewayPackRemovals([entry], { paths, policy })
    assert.equal(first[0]?.outcome, 'removed')
    assert.equal((await readContentPackState(paths)).packs[packId], undefined)

    // Reinstalled and told again with the SAME instant: that request was already
    // answered, so it must not remove the pack a second time.
    await install(packId, '1.0.0', paths)
    const second = await applyGatewayPackRemovals([entry], { paths, policy })
    assert.deepEqual(second, [])
    assert.ok((await readContentPackState(paths)).packs[packId], 'the same request is never applied twice')

    // A NEW instant is a new request.
    const third = await applyGatewayPackRemovals([{ ...entry, removeFromInstallsAt: '2026-10-30T08:00:00Z' }], { paths, policy })
    assert.equal(third[0]?.outcome, 'removed')
  })

  test('keeps a pack a channel uses, and says which channels', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths, 'com.storystudio.formula.sleep-story')
    await channel('channel-one', { niche_id: 'sleep' })
    const applied = await applyGatewayPackRemovals(
      [{ packId, releaseId: 'crel_removal', retiredAt: AT, removeFromInstallsAt: AT }],
      { paths, policy },
    )
    assert.equal(applied[0]?.outcome, 'kept_in_use')
    assert.deepEqual(applied[0]?.channels, ['channel-one'])
    assert.ok((await readContentPackState(paths)).packs[packId], 'the pack stays installed')
  })
})

describe('telling the Gateway what happened', () => {
  test('reports a Gateway removal once, then never again', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths)
    await applyGatewayPackRemovals(
      [{ packId, releaseId: 'crel_removal', retiredAt: AT, removeFromInstallsAt: AT }],
      { paths, policy },
    )

    const pending = await pendingPackRemovalReports(paths)
    assert.deepEqual(pending, [{ pack_id: packId, outcome: 'removed', detail: 'Removed on the Gateway.' }])
    await markPackRemovalReportsSent([packId], paths)
    assert.deepEqual(await pendingPackRemovalReports(paths), [], 'a sent report is not repeated')
  })

  test('a removal the customer asked for is never reported to the Gateway', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.removal-test'
    await install(packId, '1.0.0', paths)
    await removeContentPack(packId, { paths, policy })
    assert.deepEqual(await pendingPackRemovalReports(paths), [])
  })
})
