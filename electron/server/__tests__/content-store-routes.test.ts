import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { getContentStoreStatePath, readContentStoreCommerceState } from '../content-store/commerce-state.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { setProjectContentPin } from '../content-packs/project-pins.js'
import { forgetVerifiedContentPackVersions } from '../content-packs/installer.js'
import { verifyContentPackRuntimeAtBoot } from '../content-packs/recovery.js'
import {
  getGenStudioContentReceipts,
} from '../lib/genstudio-content-store.js'
import { router as contentStoreRouter } from '../routes/content-store.js'
import { contentStoreAnchorsPath, setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import * as jobQueue from '../services/job-queue.js'
import * as projectManager from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import {
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const KEY_A = 'gsk_content_account_a'
const KEY_A_ROTATED = 'gsk_content_account_a_rotated'
const KEY_B = 'gsk_content_account_b'
const KEY_C = 'gsk_content_account_c'
const HASH = 'a'.repeat(64)

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService

function release(overrides: Record<string, unknown> = {}) {
  return {
    release_id: 'crel_a', pack_id: 'com.storystudio.test', version: '1.0.0',
    archive_sha256: HASH, archive_bytes: 4096, min_story_version: '1.0.834',
    changelog: 'First release.', component_summary: { count: 1 },
    ...overrides,
  }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 'cprod_a', entitlement_family: 'com.storystudio.test', kind: 'series_formula',
    title: 'Test Formula', summary: 'A formula.', description: 'Long description.',
    publisher_id: 'com.storystudio', credit_price: 300, free: false, owned: false,
    retired: false, successor_product_id: null, current_release: release(), compatible: true,
    compatibility_reason: null, bundle_components: [], owned_component_credit_value: 0,
    ...overrides,
  }
}

async function asStoreDeliveryArchive(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'))
  delete manifest.key_id
  manifest.delivery_profile = 'genstudio-store-receipt-v1'
  zip.file('manifest.json', JSON.stringify(manifest))
  zip.remove('signature.ed25519')
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function archiveRelease(archive: Uint8Array, overrides: Record<string, unknown> = {}) {
  return release({
    archive_sha256: createHash('sha256').update(archive).digest('hex'), archive_bytes: archive.byteLength,
    ...overrides,
  })
}

function app() {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', contentStoreRouter)
  return instance
}

async function setup(options: { products?: Array<Record<string, unknown>>; key?: string } = {}) {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY_A, 'acct_a')
  mock.registerContentStoreKey(KEY_A_ROTATED, 'acct_a')
  mock.registerContentStoreKey(KEY_B, 'acct_b')
  mock.registerContentStoreKey(KEY_C, 'acct_c')
  mock.contentProducts = options.products ?? [product()]
  for (const owned of mock.contentProducts.filter(product => product.owned === true)) {
    mock.seedContentProductOwnership('acct_a', String(owned.product_id))
  }
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', options.key ?? KEY_A)
  return { app: app(), tempDir: temp.dir }
}

async function setupPinnedOwnedPack() {
  const bytes = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
  const ownedRelease = {
    ...archiveRelease(bytes), pack_id: 'com.storystudio.pack.free-recovery-test', version: '1.0.0', archive_available: true,
  }
  const setupResult = await setup({ products: [product({
    owned: true, entitlement_family: 'com.storystudio.family.free-recovery-test', current_release: ownedRelease,
  })] })
  mock.setContentArchive('crel_a', bytes)
  await request(setupResult.app).post('/api/content-store/restore').send({}).expect(200)
  await request(setupResult.app).post('/api/content-store/releases/crel_a/install').send({}).expect(200)
  const installed = (await readContentPackState()).packs['com.storystudio.pack.free-recovery-test'].versions['1.0.0']
  const project = await projectManager.createProject({ name: 'Trust Revalidation Project' })
  await setProjectContentPin(project.slug, {
    pack_id: 'com.storystudio.pack.free-recovery-test', version: '1.0.0', archive_sha256: installed.archive_sha256,
  })
  return { ...setupResult, project }
}

async function waitForJobs(jobIds: string[]): Promise<void> {
  await waitFor(async () => {
    if (jobIds.every(jobId => ['done', 'error', 'cancelled'].includes(jobQueue.getJob(jobId)?.status ?? ''))) {
      await jobQueue._waitForJobPersistenceForTesting()
      return true
    }
    return false
  }, { label: 'queued trust-revalidation jobs to finish', timeoutMs: 2_000, pollMs: 10 })
}

afterEach(async () => {
  await mock?.close()
  await cleanup?.()
  cleanup = undefined
})

describe('Content Store commerce routes', () => {
  test('shared pre-enqueue verification restores one exact missing anchor before creating ordinary jobs', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    jobQueue.registerExecutor('chapter-only', async () => {})
    const restoreRequestsBefore = mock.requests.filter(row => row.path === '/v1/content/receipts').length

    const jobs = await Promise.all(['EP001', 'EP002'].map(episode_id => jobQueue.enqueue({
      project_slug: project.slug, type: 'chapter-only', episode_id, params: {},
    })))

    assert.equal(jobs.length, 2)
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/receipts').length, restoreRequestsBefore + 1)
    assert.equal((await jobQueue.getJobs(project.slug)).filter(job => jobs.some(created => created.job_id === job.job_id)).length, 2)
    await waitForJobs(jobs.map(job => job.job_id))
  })

  test('failed missing-anchor revalidation returns an actionable 409 and creates no job', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    await mock.close()
    const before = await jobQueue.getJobs(project.slug)

    await assert.rejects(jobQueue.enqueue({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'EP003', params: {},
    }), (error: any) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'content-store-revalidation-required')
      assert.match(error.message, /Restore purchases/i)
      return true
    })
    assert.deepEqual(await jobQueue.getJobs(project.slug), before)
  })

  test('missing-anchor revalidation preserves a distinct origin mismatch and creates no job', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    const requestsBefore = mock.requests.length
    const jobsBefore = await jobQueue.getJobs(project.slug)
    await setGenStudioUrl('http://127.0.0.1:9')

    await assert.rejects(jobQueue.enqueue({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'EP004', params: {},
    }), (error: any) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'CONTENT_STORE_ORIGIN_MISMATCH')
      return true
    })
    assert.equal(mock.requests.length, requestsBefore)
    assert.deepEqual(await jobQueue.getJobs(project.slug), jobsBefore)
  })

  test('missing-anchor revalidation preserves a distinct account mismatch and creates no paid or download work', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    await setApiKey('genstudio', KEY_B)
    const jobsBefore = await jobQueue.getJobs(project.slug)
    const purchasesBefore = mock.contentPurchasePostCount
    const downloadsBefore = mock.contentDownloadPostCount

    await assert.rejects(jobQueue.enqueue({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'EP005', params: {},
    }), (error: any) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'CONTENT_STORE_ACCOUNT_MISMATCH')
      return true
    })
    assert.equal(mock.contentPurchasePostCount, purchasesBefore)
    assert.equal(mock.contentDownloadPostCount, downloadsBefore)
    assert.deepEqual(await jobQueue.getJobs(project.slug), jobsBefore)
  })

  test('tampered dedicated anchor fails closed without online restore or job creation', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.writeFile(contentStoreAnchorsPath(), JSON.stringify({
      schema_version: 1, anchors: [{ invalid: true }],
    }))
    forgetVerifiedContentPackVersions()
    const requestsBefore = mock.requests.length
    const jobsBefore = await jobQueue.getJobs(project.slug)

    await assert.rejects(jobQueue.enqueue({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'EP006', params: {},
    }), /undecryptable|malformed|tampered/i)
    assert.equal(mock.requests.length, requestsBefore)
    assert.deepEqual(await jobQueue.getJobs(project.slug), jobsBefore)
  })

  test('a failed online restore signature stays distinct and is attempted only once before any job', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    mock.tamperContentRestoreReceipt = true
    const receiptsBefore = mock.requests.filter(row => row.path === '/v1/content/receipts').length
    const jobsBefore = await jobQueue.getJobs(project.slug)
    const purchasesBefore = mock.contentPurchasePostCount

    await assert.rejects(jobQueue.enqueue({
      project_slug: project.slug, type: 'chapter-only', episode_id: 'EP007', params: {},
    }), (error: any) => {
      assert.notEqual(error.code, 'content-store-revalidation-required')
      assert.match(error.message, /signature/i)
      return true
    })
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/receipts').length, receiptsBefore + 1)
    assert.equal(mock.contentPurchasePostCount, purchasesBefore)
    assert.deepEqual(await jobQueue.getJobs(project.slug), jobsBefore)
  })

  test('a credential change during revalidation cannot record trust or create a job', async () => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    const originalFetch = globalThis.fetch
    let releaseReceipts!: () => void
    let sawReceipts!: () => void
    const receiptsStarted = new Promise<void>(resolve => { sawReceipts = resolve })
    const receiptsRelease = new Promise<void>(resolve => { releaseReceipts = resolve })
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/v1/content/receipts') {
        sawReceipts()
        await receiptsRelease
      }
      return originalFetch(input, init)
    }
    const jobsBefore = await jobQueue.getJobs(project.slug)
    try {
      const pending = jobQueue.enqueue({
        project_slug: project.slug, type: 'chapter-only', episode_id: 'EP008', params: {},
      })
      await receiptsStarted
      await setApiKey('genstudio', KEY_A_ROTATED)
      releaseReceipts()
      await assert.rejects(pending, (error: any) => {
        assert.equal(error.statusCode, 409)
        assert.equal(error.code, 'content-store-revalidation-required')
        return true
      })
    } finally {
      globalThis.fetch = originalFetch
      releaseReceipts()
    }
    assert.equal(await fs.stat(contentStoreAnchorsPath()).then(() => true, () => false), false)
    assert.deepEqual(await jobQueue.getJobs(project.slug), jobsBefore)
  })

  test('a credential change while the verified restore waits for the commerce lock is rechecked before recording trust', async t => {
    const { project } = await setupPinnedOwnedPack()
    await fs.rm(contentStoreAnchorsPath())
    forgetVerifiedContentPackVersions()
    const commerceStatePath = getContentStoreStatePath()
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'atomic-store-lock-worker.ts')
    const ready = `${commerceStatePath}.worker-ready`
    const release = `${commerceStatePath}.worker-release`
    const child = spawn(process.execPath, ['--import', 'tsx', worker], {
      env: {
        ...process.env, TARGET: commerceStatePath, READY: ready, RELEASE: release, NO_WRITE: '1',
      },
      stdio: 'pipe',
    })
    let childStderr = ''
    child.stderr.on('data', chunk => { childStderr += chunk })
    let childFailure: unknown
    const childExited = new Promise<void>((resolve, reject) => {
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`commerce lock worker exited ${code}: ${childStderr}`)))
    })
    let readyObserved = false
    t.after(async () => {
      await fs.writeFile(release, 'release').catch(() => {})
      if (!readyObserved && child.exitCode === null) child.kill()
      await Promise.allSettled([childExited])
    })
    void childExited.catch(error => { childFailure = error })
    // Allow cold Node/tsx startup; the lock observation below keeps its own deadline.
    await waitFor(async () => {
      if (childFailure) throw childFailure
      return fs.stat(ready).then(() => true, () => false)
    }, { label: 'commerce lock worker to become ready', timeoutMs: 5_000, pollMs: 5 })
    readyObserved = true
    const originalFetch = globalThis.fetch
    const originalReadFile = fs.readFile.bind(fs)
    const commerceLockPath = `${commerceStatePath}.lock`
    let commerceLockReads = 0
    ;(fs as any).readFile = async (...args: any[]) => {
      if (String(args[0]) === commerceLockPath) commerceLockReads += 1
      return (originalReadFile as any)(...args)
    }
    let markReceiptsReturned!: () => void
    const receiptsReturned = new Promise<void>(resolve => { markReceiptsReturned = resolve })
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname === '/v1/content/receipts') markReceiptsReturned()
      return response
    }
    const jobsBefore = await jobQueue.getJobs(project.slug)
    try {
      const pending = jobQueue.enqueue({
        project_slug: project.slug, type: 'chapter-only', episode_id: 'EP009', params: {},
      })
      await receiptsReturned
      await waitFor(() => commerceLockReads > 0, {
        label: 'verified restore to wait on the held commerce lock', timeoutMs: 2_000, pollMs: 5,
      })
      await setApiKey('genstudio', KEY_A_ROTATED)
      await fs.writeFile(release, 'release')
      await assert.rejects(pending, (error: any) => {
        assert.equal(error.statusCode, 409)
        assert.equal(error.code, 'content-store-revalidation-required')
        return true
      })
    } finally {
      globalThis.fetch = originalFetch
      ;(fs as any).readFile = originalReadFile
      await fs.writeFile(release, 'release').catch(() => {})
      await childExited
    }
    assert.equal(await fs.stat(contentStoreAnchorsPath()).then(() => true, () => false), false)
    assert.deepEqual(await jobQueue.getJobs(project.slug), jobsBefore)
  })

  test('a stopped Gateway is named per section, and the overview still answers with what this Mac knows', async () => {
    const { app: localApp } = await setup({ products: [product()] })
    await mock.close()
    // 2026-10-28: this used to be a bare 503/500 with nothing else. The parts
    // that do not need the Gateway are answered, and each part that does is
    // named — "could not ask" is never rendered as "you own nothing".
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(response.body.phase, 'partial')
    assert.equal(response.body.account, null, 'a refused question is not an empty ownership list')
    assert.equal(response.body.sections.account.status, 'unavailable')
    assert.equal(response.body.sections.account.code, 'GATEWAY_UNREACHABLE')
    assert.match(response.body.sections.account.reason, /Gateway not reachable at http:\/\//)
    assert.equal(response.body.sections.catalog.status, 'unavailable')
    assert.equal(response.body.sections.receipts.status, 'unavailable')
    assert.deepEqual(response.body.products, [])
    assert.deepEqual(response.body.installed, [], 'no packs are installed in this fixture — a real, local fact')
  })

  test('projects authoritative hero and complete license fields without raw upstream proof bytes', async () => {
    const { app: localApp } = await setup({ products: [product({
      cover: { url: 'https://cdn.example.test/cover.webp', alt: 'Published cover' },
      hero: { url: 'https://cdn.example.test/hero.webp', alt: 'Published hero' },
      tags: ['documentary'],
      license: { label: 'Content Pack License', text: 'Monetized Story Studio videos are permitted; source redistribution is prohibited.' },
    })] })

    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.deepEqual(response.body.products[0].presentation, {
      cover: { src: 'https://cdn.example.test/cover.webp', alt: 'Published cover' },
      hero: { src: 'https://cdn.example.test/hero.webp', alt: 'Published hero' },
      licenseLabel: 'Content Pack License',
      licenseText: 'Monetized Story Studio videos are permitted; source redistribution is prohibited.',
      tags: ['documentary'],
    })
    assert.equal(JSON.stringify(response.body.products[0]).includes('canonicalJson'), false)
    assert.equal(JSON.stringify(response.body.products[0]).includes('canonicalBytes'), false)
  })

  test('restores same-account ownership and explicitly installs verified bytes without spending credits', async () => {
    const archive = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
    const ownedRelease = {
      ...archiveRelease(archive),
      pack_id: 'com.storystudio.pack.free-recovery-test',
      version: '1.0.0',
      archive_available: true,
    }
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      entitlement_family: 'com.storystudio.family.free-recovery-test',
      current_release: ownedRelease,
    })] })
    mock.setContentArchive('crel_a', archive)

    const otherAccountReceipts = await getGenStudioContentReceipts(KEY_B)
    assert.equal(otherAccountReceipts.entitlements.length, 0, 'legacy fixture ownership is seeded to acct_a only')
    mock.seedContentProductOwnership('acct_b', 'cprod_a')
    assert.equal((await getGenStudioContentReceipts(KEY_B)).entitlements.length, 1, 'a legacy catalog flag cannot suppress another account grant')
    const purchasePostsBeforeRestore = mock.contentPurchasePostCount

    const restored = await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    assert.equal(restored.body.capabilities.restore, true)
    assert.equal(restored.body.capabilities.receipt_verification, true)
    assert.equal(restored.body.account.owned[0].receiptVerification, 'verified')
    assert.equal(mock.contentPurchasePostCount, purchasePostsBeforeRestore, 'restore sends no purchase for acct_a')
    assert.equal((await readContentStoreCommerceState()).verified_restores?.[0]?.account_id, 'acct_a')

    await setApiKey('genstudio', KEY_A_ROTATED)
    const installed = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(200)
    assert.equal(installed.body.install.pack_id, 'com.storystudio.pack.free-recovery-test')
    assert.equal(installed.body.install.version, '1.0.0')
    assert.deepEqual(installed.body.overview.installed, [{
      packId: 'com.storystudio.pack.free-recovery-test', version: '1.0.0',
      installState: 'installed_current', missingDependencies: [],
      productId: 'cprod_a', title: 'Test Formula', kind: 'series_formula', active: true, ownedByActiveAccount: true,
    }])
    assert.equal(mock.contentDownloadPostCount, 1)
    assert.equal(mock.contentArchiveGetCount, 1)
    const downloadRequest = mock.requests.find(row => row.path === '/v1/content/downloads')
    assert.deepEqual(JSON.parse(downloadRequest?.bodyText || '{}'), {
      entitlement_family: 'com.storystudio.family.free-recovery-test', version: '1.0.0',
    })
    const archiveRequest = mock.requests.find(row => row.path.startsWith('/v1/content/archives/'))
    assert.equal(archiveRequest?.authorization, '')
    // Installing an owned pack must not re-derive recall state one HTTP request
    // per owned family. It used to, and with 65 owned packs that was 65 requests
    // BEFORE any bytes moved -- installing a whole library cost ~4,200 of them,
    // ran past this client's own 8-12s request timeouts, and reported a healthy
    // store as "the Content Store is unavailable". `/v1/content/receipts`
    // already states `recalled_release_versions` per entitlement, so the only
    // correct number here is zero.
    assert.deepEqual(
      mock.requests.filter(row => row.path.includes('/entitlements/') && row.path.endsWith('/releases')).map(row => row.path),
      [],
      'installing an owned release fans out no per-entitlement release-history requests',
    )
    const state = await readContentPackState()
    assert.equal(state.packs['com.storystudio.pack.free-recovery-test'].active_version, '1.0.0')
    assert.doesNotMatch(JSON.stringify(installed.body), /receipt_signature|grant_signature|public_key_base64|download_url|"grant"|gsk_|\/Users\//i)

    const commercePath = getContentStoreStatePath()
    const commerce = JSON.parse(await fs.readFile(commercePath, 'utf8'))
    delete commerce.verified_restores
    await fs.writeFile(commercePath, JSON.stringify(commerce))
    const unverified = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(unverified.body.account.owned[0].receiptVerification, 'unverified')
    assert.equal(unverified.body.installed[0].ownedByActiveAccount, false, 'raw account ownership never upgrades local bytes')
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)

    await mutateContentPackState(state => { delete state.packs['com.storystudio.pack.free-recovery-test'].active_version })
    const retainedInactive = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(retainedInactive.body.installed.length, 1)
    assert.equal(retainedInactive.body.installed[0].version, '1.0.0')
    assert.equal(retainedInactive.body.installed[0].active, false)
    await mutateContentPackState(state => { state.packs['com.storystudio.pack.free-recovery-test'].active_version = '1.0.0' })

    await setApiKey('genstudio', KEY_C)
    const otherAccount = await request(localApp).get('/api/content-store').expect(200)
    assert.deepEqual(otherAccount.body.account.owned, [])
    assert.equal(otherAccount.body.installed[0].packId, 'com.storystudio.pack.free-recovery-test')
    assert.equal(otherAccount.body.installed[0].ownedByActiveAccount, false)
    await setApiKey('genstudio', KEY_A_ROTATED)

    mock.contentProducts = [product({
      owned: true,
      entitlement_family: 'com.storystudio.family.free-recovery-test',
      current_release: { ...ownedRelease, archive_available: false },
    })]
    const offlineOwned = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(offlineOwned.body.account.owned[0].downloadAvailable, false)
    assert.equal(offlineOwned.body.account.owned[0].installState, 'installed_current')
    assert.equal(offlineOwned.body.account.owned[0].installedVersion, '1.0.0')
  })

  test('reports an incomplete closure, never Installed, when a local Store pack cannot be verified', async () => {
    const archive = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
    const ownedRelease = {
      ...archiveRelease(archive),
      pack_id: 'com.storystudio.pack.free-recovery-test',
      version: '1.0.0',
      archive_available: true,
    }
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      entitlement_family: 'com.storystudio.family.free-recovery-test',
      current_release: ownedRelease,
    })] })
    mock.setContentArchive('crel_a', archive)
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    await request(localApp).post('/api/content-store/releases/crel_a/install').send({}).expect(200)

    const state = await readContentPackState()
    const installed = state.packs['com.storystudio.pack.free-recovery-test'].versions['1.0.0']
    await fs.writeFile(path.join(installed.install_path, 'content', 'archive.sspack'), 'damaged')

    const overview = await request(localApp).get('/api/content-store').expect(200)
    const installedState = overview.body.account.owned[0]
    assert.equal(installedState.installState, 'incomplete')
    assert.equal(installedState.installedVersion, '1.0.0')
    assert.deepEqual(installedState.missingDependencies, [])
    assert.doesNotMatch(JSON.stringify(installedState), /archive\.sspack|\/Users\//i)
  })

  test('ordinary overview durably disables a recalled installed version for the next offline boot', async () => {
    const archive = await asStoreDeliveryArchive(await fs.readFile(new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url)))
    const ownedRelease = { ...archiveRelease(archive), pack_id: 'com.storystudio.pack.free-recovery-test', version: '1.0.0', archive_available: true }
    const { app: localApp } = await setup({ products: [product({
      owned: true, entitlement_family: 'com.storystudio.family.free-recovery-test', current_release: ownedRelease,
    })] })
    mock.setContentArchive('crel_a', archive)
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    await request(localApp).post('/api/content-store/releases/crel_a/install').send({}).expect(200)
    mock.contentProducts = [product({
      owned: true, entitlement_family: 'com.storystudio.family.free-recovery-test', current_release: ownedRelease,
      recalled_release_versions: ['1.0.0'],
    })]
    await request(localApp).get('/api/content-store').expect(200)
    const disabled = await readContentPackState()
    const retained = disabled.packs['com.storystudio.pack.free-recovery-test'].versions['1.0.0']
    assert.equal(disabled.packs['com.storystudio.pack.free-recovery-test'].active_version, undefined)
    assert.equal(retained.recalled?.account_id, 'acct_a')
    assert.equal(retained.recalled?.genstudio_origin, mock.baseUrl)
    await verifyContentPackRuntimeAtBoot()
    assert.equal((await readContentPackState()).packs['com.storystudio.pack.free-recovery-test'].active_version, undefined)
  })

  test('does not advertise verified ownership when an original purchase receipt fails signature verification', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.tamperContentPurchaseReceipt = true
    const response = await request(localApp).post('/api/content-store/restore').send({}).expect(500)
    assert.equal((await readContentStoreCommerceState()).verified_restores, undefined)
    assert.doesNotMatch(JSON.stringify(response.body), /signature|receipt|mock-content-key/i)
  })

  test('refuses a Story-incompatible archive before issuing a download grant', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_bytes: 60 * 1024 * 1024, archive_available: true }),
    })] })
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(409)
    assert.equal(response.body.code, 'CONTENT_PACK_TOO_LARGE_FOR_THIS_APP')
    assert.equal(mock.contentDownloadPostCount, 0)
    assert.equal(mock.contentArchiveGetCount, 0)
  })

  test('refuses a release requiring a newer Story version before issuing a download grant', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ min_story_version: '999.0.0', archive_available: true }),
    })] })
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(409)
    assert.equal(response.body.code, 'CONTENT_PACK_REQUIRES_NEWER_APP')
    assert.match(response.body.detail, /999\.0\.0/)
    assert.equal(mock.contentDownloadPostCount, 0)
    assert.equal(mock.contentArchiveGetCount, 0)
  })

  test('redacts unknown delivery refusals instead of forwarding upstream internals', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.contentDownloadRefusal = {
      status: 503,
      code: 'future_internal_refusal',
      detail: 'private bucket /srv/private/content/archive is unavailable',
    }
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(502)
    assert.equal(response.body.code, 'CONTENT_STORE_UPSTREAM_REFUSED')
    assert.doesNotMatch(JSON.stringify(response.body), /future_internal_refusal|private bucket|\/srv\/private|internal_path/i)
  })

  test('starts and reads an async install operation, while rejecting malformed and expired monitor ids', async () => {
    const { app: localApp } = await setup()
    const started = await request(localApp)
      .post('/api/content-store/releases/crel_a/install?overview=0&async=1').send({}).expect(202)
    assert.equal(typeof started.body.operation?.operationId, 'string')
    assert.equal(started.body.operation?.phase, 'queued')

    const operationId = started.body.operation.operationId as string
    await request(localApp).get(`/api/content-store/installs/${encodeURIComponent(operationId)}`).expect(200)
    const malformed = await request(localApp).get('/api/content-store/installs/bad%00id').expect(400)
    assert.equal(malformed.body.code, 'CONTENT_STORE_REQUEST_INVALID')
    const missing = await request(localApp).get('/api/content-store/installs/missing-operation').expect(404)
    assert.equal(missing.body.code, 'CONTENT_STORE_INSTALL_NOT_FOUND')
    // The request is intentionally unowned, but its background operation must
    // finish before this test closes the mock and removes its isolated state.
    await waitFor(async () => {
      const response = await request(localApp).get(`/api/content-store/installs/${operationId}`).expect(200)
      return response.body.operation.phase === 'failed'
    }, { label: 'unowned async install operation', timeoutMs: 5_000 })
  })

  test('keeps the existing safe GenStudio refusal projection when an async install fails', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.contentDownloadRefusal = {
      status: 410,
      code: 'release_recalled',
      detail: 'release 1.0.0 was recalled: unsafe bundled reference',
      recall_reason: 'unsafe bundled reference',
      recalled_at: '2026-08-14T09:00:00Z',
    }
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)
    const started = await request(localApp)
      .post('/api/content-store/releases/crel_a/install?overview=0&async=1').send({}).expect(202)
    const operationId = started.body.operation.operationId as string
    let monitored: any
    await waitFor(async () => {
      const response = await request(localApp).get(`/api/content-store/installs/${operationId}`).expect(200)
      monitored = response.body.operation
      return monitored.phase === 'failed'
    }, { label: 'async recalled install operation', timeoutMs: 5_000 })
    assert.deepEqual(monitored.failure, {
      code: 'release_recalled',
      detail: 'GenStudio stopped serving this exact Content Pack release.',
    })
  })

  test('preserves an exact release recall as a terminal refusal without retrying delivery', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ archive_available: true }),
    })] })
    mock.contentDownloadRefusal = {
      status: 410,
      code: 'release_recalled',
      detail: 'release 1.0.0 was recalled: unsafe bundled reference',
      recall_reason: 'unsafe bundled reference',
      recalled_at: '2026-08-14T09:00:00Z',
    }
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)

    const response = await request(localApp)
      .post('/api/content-store/releases/crel_a/install').send({}).expect(410)

    assert.deepEqual(response.body, {
      code: 'release_recalled',
      detail: 'GenStudio stopped serving this exact Content Pack release.',
      recall_reason: 'unsafe bundled reference',
      recalled_at: '2026-08-14T09:00:00Z',
      terminal: true,
    })
    assert.equal(mock.contentDownloadPostCount, 1)
    assert.equal(mock.contentArchiveGetCount, 0)
  })

  test('a Mac with no saved key answers locally and names the missing key, sending no remote request', async () => {
    const { app: localApp } = await setup({ key: '' })
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(mock.requests.length, 0, 'no key means no request is attempted')
    assert.equal(response.body.account, null)
    assert.equal(response.body.sections.account.code, 'CONTENT_STORE_KEY_REQUIRED')
    assert.match(response.body.sections.account.reason, /Gateway API Key/)
    assert.equal(response.body.sections.catalog.code, 'CONTENT_STORE_KEY_REQUIRED')
    assert.equal(response.body.sections.commerce.status, 'unavailable')
    assert.deepEqual(response.body.installed, [])
  })

  test('loads exact account and products with the current Story version and accepts an empty catalog', async () => {
    const { app: localApp } = await setup({ products: [] })
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(response.body.phase, 'delivery_ready')
    assert.equal(response.body.account.accountId, 'acct_a')
    assert.deepEqual(response.body.products, [])
    assert.doesNotMatch(JSON.stringify(response.body), /canonicalJson|canonicalBytes|\"raw\"/)
    assert.deepEqual(response.body.capabilities, {
      purchase: false, receipt_verification: true, download: true,
      install_after_purchase: false, restore: true,
    })
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/account').length, 1)
    assert.match(mock.requests.find(row => row.path === '/v1/content/products')!.path, /^\/v1\/content\/products$/)
  })

  test('projects only validated catalog merchandising facts and preserves the published shelf/fallback order', async () => {
    const merchandising = {
      cover: { url: 'https://catalog.example.test/covers/test-formula.webp', alt: 'A documented formula cover' },
      hero: { url: 'https://catalog.example.test/heroes/test-formula.webp', alt: 'A documented formula hero' },
      tags: ['documentary', 'archive'],
      license: { label: 'Story Studio Content Pack License', text: 'Customer-facing terms.' },
      discount: {
        discount_id: 'cdsc_test_formula', version: 1, percent: 25,
        starts_on: null, ends_on: '2026-12-31', timezone: 'Asia/Phnom_Penh',
        list_credit_price: 300, discounted_credit_price: 225,
      },
    }
    const fallback = product({
      product_id: 'cprod_fallback', entitlement_family: 'com.storystudio.fallback',
      title: 'Fallback Formula', ...merchandising,
      discount: null,
    })
    const { app: localApp } = await setup({ products: [product(merchandising), fallback] })
    mock.contentShelves = {
      shelves: [{ shelf_id: 'cshf_featured', title: 'Featured', position: 9, product_ids: ['cprod_a'] }],
      fallback_product_ids: ['cprod_fallback'],
    }

    const response = await request(localApp).get('/api/content-store').expect(200)

    assert.deepEqual(response.body.shelves.map((shelf: { productIds: string[] }) => shelf.productIds), [
      ['cprod_a'], ['cprod_fallback'],
    ])
    assert.equal(response.body.products[0].presentation.cover.src, merchandising.cover.url)
    assert.equal(response.body.products[0].presentation.cover.alt, merchandising.cover.alt)
    assert.equal(response.body.products[0].presentation.hero.src, merchandising.hero.url)
    assert.equal(response.body.products[0].presentation.hero.alt, merchandising.hero.alt)
    assert.equal(response.body.products[0].presentation.licenseLabel, merchandising.license.label)
    assert.equal(response.body.products[0].presentation.licenseText, merchandising.license.text)
    assert.deepEqual(response.body.products[0].presentation.tags, merchandising.tags)
    // The shop is retired: a published discount and its credit prices are not
    // projected, so no money fact reaches the page.
    assert.equal('discount' in response.body.products[0], false)
    assert.doesNotMatch(JSON.stringify(response.body), /creditPrice|CreditValue|credit_price/i)
    assert.doesNotMatch(JSON.stringify(response.body), /canonicalJson|canonicalBytes|"raw"/)
    assert.equal(mock.requests.filter(row => row.path === '/v1/content/shelves').length, 1)
  })

  test('shows recalled owned versions beside the newest safe release without changing ownership', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true,
      current_release: release({ release_id: 'crel_safe', version: '0.9.0', archive_available: true }),
      recalled_release_versions: ['1.0.0'],
    })] })

    const response = await request(localApp).get('/api/content-store').expect(200)

    assert.equal(response.body.account.owned[0].currentRelease.version, '0.9.0')
    assert.deepEqual(response.body.account.owned[0].recalledReleaseVersions, ['1.0.0'])
    assert.equal(response.body.account.owned[0].entitlementFamily, 'com.storystudio.test')
  })

  test('does not use stale ownership after a content scope failure', async () => {
    const { app: localApp } = await setup()
    await request(localApp).get('/api/content-store').expect(200)
    mock.registerKey('gsk_without_content_scope', [])
    await setApiKey('genstudio', 'gsk_without_content_scope')
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.match(response.body.sections.account.reason, /content:read/i)
    assert.equal(response.body.sections.account.code, 'CONTENT_STORE_SCOPE_REQUIRED')
    assert.equal(response.body.account, null, 'a refused key never leaves the previous ownership on screen')
  })

  test('keeps the 16 KiB body cap on Store routes only, not on the routers mounted after it', async () => {
    // routes/index.ts mounts this router bare on `/api` with ~30 siblings after
    // it. A path-less `router.use` guard here therefore runs for EVERY later
    // `/api` request, and every one of those routers silently inherited the
    // Store's 16 KiB cap — answering a large but perfectly legitimate payload
    // with a Content Store error about a Content Store limit. Found 2026-09-08
    // when a 16.9 KiB `POST /api/projects/:slug/image-pool/generate` carrying 13
    // image prompts came back CONTENT_STORE_REQUEST_TOO_LARGE.
    const instance = express()
    instance.use(express.json({ limit: '10mb' }))
    instance.use('/api', contentStoreRouter)
    const sibling = express.Router()
    sibling.post('/projects/:slug/image-pool/generate', (req, res) => {
      res.status(201).json({ prompts: (req.body?.prompts || []).length })
    })
    instance.use('/api', sibling)

    const big = { prompts: Array.from({ length: 13 }, () => 'x'.repeat(1_400)) }
    const passed = await request(instance)
      .post('/api/projects/pack-previews/image-pool/generate').send(big).expect(201)
    assert.equal(passed.body.prompts, 13)

    // The Store's own routes keep the cap.
    await request(instance).post('/api/content-store/restore')
      .send({ padding: 'x'.repeat(20_000) }).expect(413)
  })

  test('a retired family that keeps its bytes does not block the rest of the Store', async () => {
    // The live shape (Gateway 0.2.213, 2026-10-27): a retired family publishes
    // `download_available: false` while its release archive is still on disk.
    // Demanding the two fields agree refused the WHOLE receipts answer, which
    // refused every Restore and every install for as long as one retired family
    // existed. Keep rejecting only "you may download it" with no archive.
    const bytes = await asStoreDeliveryArchive(await fs.readFile(
      new URL('./fixtures/content-packs/free-recovery-test/free-recovery-test.sspack', import.meta.url),
    ))
    const { app: localApp } = await setup({ products: [
      product({
        product_id: 'cprod_live', entitlement_family: 'com.storystudio.family.free-recovery-test',
        owned: true, current_release: release({ pack_id: 'com.storystudio.pack.free-recovery-test', archive_available: true }),
      }),
      product({
        product_id: 'cprod_retired', entitlement_family: 'com.storystudio.family.retired', title: 'Retired Formula',
        owned: true, retired: true, download_available: false,
        current_release: release({ release_id: 'crel_retired', pack_id: 'com.storystudio.pack.retired', archive_available: true }),
      }),
    ] })
    mock.setContentArchive('crel_a', bytes)

    await request(localApp).post('/api/content-store/restore').send({}).expect(200)

    const overview = await request(localApp).get('/api/content-store').expect(200)
    const retired = overview.body.account.owned.find((row: any) => row.entitlementFamily === 'com.storystudio.family.retired')
    const live = overview.body.account.owned.find((row: any) => row.entitlementFamily === 'com.storystudio.family.free-recovery-test')
    assert.equal(retired?.downloadAvailable, false, 'the bytes existing is not GenStudio offering a download')
    assert.equal(retired?.installState, 'not_installed', 'a withdrawn download is not an installable row')
    assert.equal(live?.downloadAvailable, true, 'an ordinary family is unaffected')

    // Another pack installs normally with the retired row present in the answer.
    await request(localApp).post('/api/content-store/releases/crel_a/install').send({}).expect(200)

    const downloadsBefore = mock.contentDownloadPostCount
    const archivesBefore = mock.contentArchiveGetCount
    const refused = await request(localApp).post('/api/content-store/releases/crel_retired/install').send({}).expect(409)
    assert.equal(refused.body.code, 'CONTENT_PACK_DOWNLOAD_WITHDRAWN')
    assert.match(refused.body.detail, /withdrawn/i)
    assert.equal(mock.contentDownloadPostCount, downloadsBefore, 'no download grant is asked for a withdrawn download')
    assert.equal(mock.contentArchiveGetCount, archivesBefore)
  })

  test('an installed pack keeps working when GenStudio later retires its family', async () => {
    const { app: localApp } = await setupPinnedOwnedPack()
    const source = mock.contentProducts[0]!
    source.retired = true
    source.download_available = false

    const overview = await request(localApp).get('/api/content-store').expect(200)
    const installed = overview.body.installed.find((pack: any) => pack.packId === 'com.storystudio.pack.free-recovery-test')
    assert.equal(installed?.installState, 'installed_current', 'retirement withdraws the download, not the installed copy')
    const owned = overview.body.account.owned[0]
    assert.equal(owned.downloadAvailable, false)
    assert.equal(owned.installState, 'installed_current')
    assert.equal((await readContentPackState()).packs['com.storystudio.pack.free-recovery-test']?.active_version, '1.0.0')
  })

  test('a Gateway answer this build cannot read is a 502 that names the response, not a silent 500', async () => {
    const { app: localApp } = await setup({ products: [product({ owned: true, current_release: release({ archive_available: true }) })] })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (new URL(url).pathname === '/v1/content/receipts') {
        return new Response('{"entitlements": "not an array"}', {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return original(input, init)
    }) as typeof fetch
    try {
      const response = await request(localApp).post('/api/content-store/restore').send({}).expect(502)
      assert.equal(response.body.code, 'CONTENT_STORE_RESPONSE_INVALID')
      assert.match(response.body.detail, /^The Gateway answered, but not with a Studio Library response: /)
      assert.match(response.body.detail, /\/v1\/content\/receipts/, 'the answer names which response was unreadable')
    } finally { globalThis.fetch = original }
  })

  test('an async install that fails for a reason this build cannot name is not called a GenStudio refusal', async () => {
    const { app: localApp } = await setup({ products: [product({
      owned: true, current_release: release({ archive_available: true }),
    })] })
    // A valid signing path delivering bytes that are not a Content Pack: the
    // failure is real and local, and has no refusal code to report.
    mock.setContentArchive('crel_a', Buffer.from('this is not a content-pack archive'))
    await request(localApp).post('/api/content-store/restore').send({}).expect(200)

    const started = await request(localApp)
      .post('/api/content-store/releases/crel_a/install?overview=0&async=1').send({}).expect(202)
    const operationId = started.body.operation.operationId as string
    let monitored: any
    await waitFor(async () => {
      const response = await request(localApp).get(`/api/content-store/installs/${encodeURIComponent(operationId)}`).expect(200)
      monitored = response.body.operation
      return monitored.phase === 'failed'
    }, { label: 'async install with an unreadable archive', timeoutMs: 5_000 })
    assert.equal(monitored.failure.code, 'CONTENT_STORE_INSTALL_FAILED',
      'nothing was refused, so the row must not say GenStudio refused it')
    assert.doesNotMatch(monitored.failure.detail, /GenStudio (?:could not|refused)/i)
  })

  test('keeps the financial service independent from installer, lifecycle, queue, and admission modules', async () => {
    const serviceSource = await fs.readFile(new URL('../services/content-store.ts', import.meta.url), 'utf8')
    const routeSource = await fs.readFile(new URL('../routes/content-store.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(serviceSource + routeSource, /content-packs\/(?:installer|lifecycle)|job-queue|admission|generation/i)
  })
})

/**
 * The 2026-10-28 production report: `GET /api/content-store` answered
 * `500 {"detail":"Failed to load the Content Store."}` on the installed mini
 * while `GET /api/content-packs/gateway-archives` answered 216 archives and
 * installs from it worked. The cause could not be read out of the log.
 *
 * The rule these pin (AGENTS.md 6): "the answer is none" and "I could not ask"
 * must never render as the same value. A Gateway that does not serve these
 * endpoints, or answers with something that is not a Content Store response, is
 * a named `unavailable` section — never a generic 500, and never an empty list
 * that reads as "you own nothing".
 */
describe('Content Store overview answers partially instead of failing whole', () => {
  async function withContentFetch(replacement: (url: string, init?: RequestInit) => Promise<Response> | null) {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      const replaced = replacement(url, init)
      if (replaced) return replaced
      return original(input, init)
    }) as typeof fetch
    return () => { globalThis.fetch = original }
  }

  test('a complete answer says every section is available and keeps the typed phase', async () => {
    const { app: localApp } = await setup()
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(response.body.phase, 'delivery_ready')
    assert.deepEqual(response.body.sections, {
      account: { status: 'available' },
      catalog: { status: 'available' },
      shelves: { status: 'available' },
      receipts: { status: 'available' },
      commerce: { status: 'available' },
      // 1.4.369: Gateway-requested removals are their own section.
      removals: { status: 'available' },
    })
  })

  test('a Gateway that answers 200 with a foreign body is named, and this Mac still answers', async () => {
    // A catch-all route, a proxy page, or another product's JSON behind these
    // paths. Before 2026-10-28 every one of these was the generic 500.
    const { app: localApp } = await setup()
    const restore = await withContentFetch(url => (
      new URL(url).pathname.startsWith('/v1/content/')
        ? Promise.resolve(new Response('<html><body>Gateway</body></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        }))
        : null
    ))
    try {
      const response = await request(localApp).get('/api/content-store').expect(200)
      assert.equal(response.body.phase, 'partial')
      assert.equal(response.body.sections.account.code, 'CONTENT_STORE_RESPONSE_INVALID')
      assert.match(response.body.sections.account.reason, /not with a Studio Library response/i)
      assert.equal(response.body.account, null, 'could not ask is not an empty ownership list')
      assert.equal(response.body.sections.catalog.code, 'CONTENT_STORE_RESPONSE_INVALID')
      assert.deepEqual(response.body.products, [])
      assert.deepEqual(response.body.installed, [], 'the local answer is still a real answer')
    } finally { restore() }
  })

  test('a Gateway without the content endpoints is named as not serving the Library, not a 500', async () => {
    const { app: localApp } = await setup()
    const restore = await withContentFetch(url => (
      new URL(url).pathname.startsWith('/v1/content/')
        ? Promise.resolve(new Response('Not Found', { status: 404 }))
        : null
    ))
    try {
      const response = await request(localApp).get('/api/content-store').expect(200)
      assert.equal(response.body.sections.account.code, 'CONTENT_STORE_NOT_SERVED')
      assert.match(response.body.sections.account.reason, /does not serve the Studio Library/)
      assert.equal(response.body.account, null)
      assert.equal(response.body.sections.commerce.status, 'unavailable')
    } finally { restore() }
  })

  test('an unreadable local purchase journal is named once and never hides the catalogue', async () => {
    const { app: localApp } = await setup()
    // The journal path is a directory: this Mac cannot read its own record.
    await fs.mkdir(getContentStoreStatePath(), { recursive: true })
    const response = await request(localApp).get('/api/content-store').expect(200)
    assert.equal(response.body.sections.commerce.status, 'unavailable')
    assert.equal(response.body.sections.commerce.code, 'CONTENT_STORE_LOCAL_STATE_UNAVAILABLE')
    assert.deepEqual(response.body.attempts, [])
    // Everything the Gateway answered is still there, and still marked available.
    assert.equal(response.body.sections.catalog.status, 'available')
    assert.equal(response.body.sections.account.status, 'available')
    assert.ok(response.body.account, 'a broken local journal does not make ownership unknown')
    assert.equal(response.body.phase, 'partial')
  })

  test('an account/receipts mismatch still fails loudly — that is a wrong answer, not a missing one', async () => {
    const { app: localApp } = await setup()
    // The account answer is re-labelled as another account's while the receipts
    // stay this account's. Both bodies parse; together they disagree, which is
    // a wrong answer, not an absent one — so it must NOT become a partial
    // overview. (Re-labelling the SIGNED receipts instead would make that body
    // incoherent, which is a different case: an unreadable response, covered by
    // the foreign-body test above.)
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (new URL(url).pathname !== '/v1/content/account') return original(input, init)
      const real = await original(input, init)
      const body = await real.json() as Record<string, unknown>
      body.account_id = 'acct_someone_else'
      body.content_account_id = 'content_acct_someone_else'
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const response = await request(localApp).get('/api/content-store')
      assert.equal(response.status, 409)
      assert.equal(response.body.code, 'CONTENT_STORE_ACCOUNT_MISMATCH')
    } finally { globalThis.fetch = original }
  })
})
