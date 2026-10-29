import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: express.Express

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.key.topic-list-view-test'
const PACK_ID = 'com.storystudio.pack.topic.list-view'
const ITEM_ID = 'com.storystudio.topic.list-view'
const keys = generateKeyPairSync('ed25519')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * A signed Topic Pack — the picker's list is installed Content Pack items only
 * (owner ruling, 2026-10-29), so this fixture goes through the real installer
 * rather than a `.topic-packs` file the list no longer reads.
 */
const document = {
  kind: 'topic-pack', schema_version: 1, id: ITEM_ID, name: 'Deep Time', description: 'd',
  compatible_formula_ids: ['com.storystudio.formula.history-explained'],
  subjects: ['Taung child'], tags: ['science'],
  episode_objects: ['excavation'], time_place_scopes: ['Pliocene'], mechanisms: ['m'.repeat(500)],
  evidence_lenses: ['e'], exclusions: [], max_siblings_per_subject: 20, prompt_context: 'p',
  idea_axes: [{ id: 'era', label: 'Era', values: ['Pliocene'] }],
  coverage_profiles: [{ id: 'p1', label: 'Profile', tuples: [{ a: 1 }, { a: 2 }, { a: 3 }] }],
}

async function archive(): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify(document))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: PACK_ID, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version: '1.0.0',
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` }, bundles: [],
    items: [{ id: ITEM_ID, kind: 'topic-pack', schema_version: 1, path: 'content/topic-pack.json' }],
    files: [{
      path: 'content/topic-pack.json', sha256: sha256(content), bytes: content.byteLength, mime: 'application/json',
    }],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  zip.file('content/topic-pack.json', content, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const { installContentPack } = await import('../content-packs/installer.js')
  const { createContentPackKeyring } = await import('../content-packs/keyring.js')
  const { getContentPackRuntimePaths } = await import('../content-packs/runtime-paths.js')
  const recoveryRoot = path.join(temp.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = {
    paths: getContentPackRuntimePaths(),
    policy: createContentPackKeyring([{
      keyId: KEY_ID,
      publisherId: PUBLISHER_ID,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }]),
    recoveryRoot,
    appVersion: '1.0.0',
  }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)
  const { router } = await import('../routes/niches.js')
  app = express()
  app.locals.contentPackOptions = options
  app.use(express.json()).use('/api', router)
})
after(async () => { await cleanup() })

// S9: the pickers read a slim list; the full pack stays one GET away.
test('GET /topic-packs?view=list drops generation inventories and coverage tuples, keeping counts', async () => {
  const full = (await request(app).get('/api/topic-packs').expect(200)).body.topic_packs.find((p: any) => p.id === ITEM_ID)
  const slim = (await request(app).get('/api/topic-packs?view=list').expect(200)).body.topic_packs.find((p: any) => p.id === ITEM_ID)
  assert.ok(full, 'the installed pack is listed')
  assert.equal(full.coverageProfiles?.[0]?.tuples?.length, 3, 'the default view is unchanged')
  assert.deepEqual(slim.coverageProfiles, [{ id: 'p1', label: 'Profile', tuple_count: 3 }])
  for (const field of ['mechanisms', 'evidenceLenses', 'episodeObjects', 'timePlaceScopes']) assert.equal(slim[field], undefined, field)
  assert.deepEqual(slim.subjects, ['Taung child'])
  assert.deepEqual(slim.ideaAxes, document.idea_axes)
  assert.ok(slim.catalog, 'catalog metadata is still attached')
})
