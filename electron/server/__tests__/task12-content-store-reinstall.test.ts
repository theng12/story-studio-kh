import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const KEY = 'gsk_task12_reinstall'
const ACCOUNT = 'acct_task12_reinstall'
const RELEASE_ID = 'release-task12-reinstall'
let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
  await cleanup?.()
  cleanup = undefined
})

async function storeArchive(): Promise<{ bytes: Uint8Array; manifest: Record<string, any> }> {
  const source = new Uint8Array(await fs.readFile(
    new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url),
  ))
  const zip = await JSZip.loadAsync(source)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'))
  delete manifest.key_id
  manifest.delivery_profile = 'genstudio-store-receipt-v1'
  zip.file('manifest.json', JSON.stringify(manifest))
  zip.remove('signature.ed25519')
  return {
    bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' }),
    manifest,
  }
}

async function ownedReleaseFixture() {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const fixture = await storeArchive()
  const digest = createHash('sha256').update(fixture.bytes).digest('hex')
  const itemKind = String(fixture.manifest.items?.[0]?.kind || 'visual-style').replaceAll('-', '_')
  const family = String(fixture.manifest.entitlement.family)
  const productId = 'product-task12-reinstall'

  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  mock.contentProducts = [{
    product_id: productId, entitlement_family: family, kind: itemKind,
    title: 'Task 12 reinstall', summary: '', description: '', publisher_id: 'com.storystudio',
    credit_price: 0, free: true, owned: true, retired: false, successor_product_id: null,
    current_release: {
      release_id: RELEASE_ID, pack_id: fixture.manifest.pack_id, version: fixture.manifest.version,
      archive_sha256: digest, archive_bytes: fixture.bytes.byteLength, archive_available: true,
      min_story_version: fixture.manifest.min_app_version, changelog: '', component_summary: {},
    },
    compatible: true, compatibility_reason: null, bundle_components: [], owned_component_credit_value: 0,
    showcase_videos: [], cover: null, hero: null, tags: [], license: null, discount: null,
  }]
  mock.seedContentProductOwnership(ACCOUNT, productId)
  mock.setContentArchive(RELEASE_ID, fixture.bytes)
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)

  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', contentStoreRouter)
  await request(app).post('/api/content-store/restore').send({}).expect(200)
  await request(app).post(`/api/content-store/releases/${RELEASE_ID}/install`).send({}).expect(200)

  const before = await readContentPackState()
  const installed = before.packs[String(fixture.manifest.pack_id)]!.versions[String(fixture.manifest.version)]!
  const attestationBefore = installed.delivery_attestation
  assert.ok(attestationBefore)
  const retainedArchive = path.join(installed.install_path, 'content', 'archive.sspack')
  const paths = getContentPackRuntimePaths()
  return { app, fixture, digest, installed, attestationBefore, retainedArchive, paths, service: mock }
}

test('reinstalling an owned release retains corrupt evidence and recovers after interruption', async () => {
  const { app, fixture, digest, installed, attestationBefore, retainedArchive, paths, service } = await ownedReleaseFixture()
  const corruptBytes = Buffer.from('corrupt installed archive')
  await fs.writeFile(retainedArchive, corruptBytes)
  const downloadsBefore = service.contentArchiveGetCount
  const stateBefore = await fs.readFile(paths.statePath)

  await assert.rejects(installContentPack({
    archiveBytes: fixture.bytes,
    source: 'genstudio-store',
    expectedArchiveSha256: digest,
    expectedPackId: String(fixture.manifest.pack_id),
    expectedVersion: String(fixture.manifest.version),
    deliveryAttestation: attestationBefore,
  }, {
    paths,
    activate: false,
    repairCorruptExactStoreVersion: true,
    hooks: {
      afterRepairBackupRename: async () => { throw new Error('injected repair interruption') },
    },
  }), /injected repair interruption/)

  assert.deepEqual(await fs.readFile(paths.statePath), stateBefore, 'interrupted repair commits no state change')
  await assert.rejects(fs.stat(installed.install_path), { code: 'ENOENT' })
  const interruptedBackups = (await fs.readdir(paths.quarantineRoot))
    .filter(name => name.startsWith(`repair-${fixture.manifest.pack_id}-${fixture.manifest.version}-`))
  assert.equal(interruptedBackups.length, 1)
  const backupArchive = path.join(paths.quarantineRoot, interruptedBackups[0]!, 'content', 'archive.sspack')
  assert.deepEqual(await fs.readFile(backupArchive), corruptBytes, 'the bad immutable copy remains available as evidence')

  const repaired = await request(app)
    .post(`/api/content-store/releases/${RELEASE_ID}/install`)
    .send({})
    .expect(200)

  assert.equal(repaired.body.install.pack_id, fixture.manifest.pack_id)
  assert.equal(service.contentArchiveGetCount, downloadsBefore + 1, 'repair downloads the exact owned archive once')
  assert.deepEqual(new Uint8Array(await fs.readFile(retainedArchive)), fixture.bytes)
  assert.deepEqual(
    (await fs.readdir(paths.quarantineRoot)).filter(name => name.startsWith('repair-')),
    interruptedBackups,
    'a successful retry never deletes the retained corrupt copy',
  )
  const after = await readContentPackState()
  assert.deepEqual(
    after.packs[String(fixture.manifest.pack_id)]!.versions[String(fixture.manifest.version)]!.delivery_attestation,
    attestationBefore,
    'repair preserves the exact signed ownership evidence for this immutable release',
  )
})

test('a failed replacement verification leaves state unchanged and retry retains every bad copy', async () => {
  const { app, fixture, installed, attestationBefore, retainedArchive, paths } = await ownedReleaseFixture()
  const originalCorruption = Buffer.from('original corrupt archive')
  const replacementCorruption = Buffer.from('injected replacement corruption')
  await fs.writeFile(retainedArchive, originalCorruption)
  const stateBefore = await fs.readFile(paths.statePath)
  const realRename = fs.rename
  let replacementChanged = false
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    await realRename(...args)
    if (String(args[1]) === installed.install_path) {
      await fs.writeFile(retainedArchive, replacementCorruption)
      replacementChanged = true
    }
  }
  try {
    await request(app).post(`/api/content-store/releases/${RELEASE_ID}/install`).send({}).expect(500)
  } finally {
    fs.rename = realRename
  }
  assert.equal(replacementChanged, true, 'the test must reach the replacement rename')
  assert.deepEqual(await fs.readFile(paths.statePath), stateBefore, 'verification must precede state commit')
  const firstBackups = (await fs.readdir(paths.quarantineRoot)).filter(name => name.startsWith('repair-'))
  assert.equal(firstBackups.length, 1)
  assert.deepEqual(await fs.readFile(path.join(paths.quarantineRoot, firstBackups[0]!, 'content/archive.sspack')), originalCorruption)

  await request(app).post(`/api/content-store/releases/${RELEASE_ID}/install`).send({}).expect(200)
  assert.deepEqual(new Uint8Array(await fs.readFile(retainedArchive)), fixture.bytes)
  const allBackups = (await fs.readdir(paths.quarantineRoot)).filter(name => name.startsWith('repair-'))
  assert.equal(allBackups.length, 2, 'retry creates a unique backup without removing prior evidence')
  assert.ok(allBackups.includes(firstBackups[0]!))
  const secondBackup = allBackups.find(name => name !== firstBackups[0])!
  assert.deepEqual(await fs.readFile(path.join(paths.quarantineRoot, secondBackup, 'content/archive.sspack')), replacementCorruption)
  assert.deepEqual(
    (await readContentPackState()).packs[String(fixture.manifest.pack_id)]!.versions[String(fixture.manifest.version)]!.delivery_attestation,
    attestationBefore,
  )
})
