import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'

/**
 * Story's Gateway archive shelf reuses the authenticated admin archive bank
 * and the shared local installer. It is not a Content Store account read and
 * it must not turn the Gateway's archive-only `installable: false` metadata
 * into a new gate: possession of compatible bytes is enough.
 */

let calls: Array<{ path: string; options: Record<string, any> }> = []
let handler: (path: string, options: Record<string, any>) => unknown

;(globalThis as any).$fetch = async (path: string, options: Record<string, any> = {}) => {
  calls.push({ path, options })
  return handler(path, options)
}

const {
  useContentStore,
  _clearContentStoreSessionCacheForTests,
  gatewayArchiveErrorPresentation,
} = await import('../composables/useContentStore.js')

const digest = 'a'.repeat(64)
const archive = {
  archiveSha256: digest,
  bytes: 208_257,
  packId: 'kh.owner.example',
  version: '1.2.0',
  title: 'Illustrated Sleep History',
  minAppVersion: '1.0.0',
  itemKinds: ['visual-style'],
  integrity: 'verified',
}
const installResult = {
  pack_id: 'kh.owner.example',
  version: '1.2.0',
  archive_sha256: digest,
  activated: true,
  retained_versions: ['1.2.0'],
}

beforeEach(() => {
  _clearContentStoreSessionCacheForTests()
  calls = []
  handler = () => { throw new Error('No request expected') }
})

describe('Gateway archive shelf', () => {
  test('lists the backend projection without an account or catalog read', async () => {
    handler = (path, options) => {
      assert.equal(path, '/api/content-packs/gateway-archives')
      assert.equal(options.cache, 'no-store')
      return {
        archives: [
          archive,
          {
            archiveSha256: 'f'.repeat(64), bytes: null, packId: '', version: '',
            title: '', minAppVersion: '', itemKinds: [], integrity: 'unreadable',
          },
          { archiveSha256: 'not-a-digest', bytes: 1 },
        ],
      }
    }

    const listed = await useContentStore().listGatewayArchives()

    assert.deepEqual(listed, [
      archive,
      {
        archiveSha256: 'f'.repeat(64), bytes: null, packId: '', version: '',
        title: '', minAppVersion: '', itemKinds: [], integrity: 'unreadable',
      },
    ])
    assert.deepEqual(calls.map(call => call.path), ['/api/content-packs/gateway-archives'])
  })

  test('installs one exact digest through the existing local install result', async () => {
    handler = (path, options) => {
      assert.equal(path, `/api/content-packs/gateway-archives/${digest}/install`)
      assert.equal(options.method, 'POST')
      return structuredClone(installResult)
    }

    const installed = await useContentStore().installGatewayArchive(digest)

    assert.deepEqual(installed, { packId: 'kh.owner.example', version: '1.2.0' })
    assert.deepEqual(calls.map(call => call.path), [
      `/api/content-packs/gateway-archives/${digest}/install`,
    ])
  })

  test('refuses an invalid digest and an unreadable list before trusting it', async () => {
    await assert.rejects(
      useContentStore().installGatewayArchive('not-a-digest'),
      (error: any) => error?.data?.code === 'CONTENT_PACK_GATEWAY_DIGEST_INVALID',
    )
    assert.equal(calls.length, 0)

    handler = () => ({ archives: 'not-an-array' })
    await assert.rejects(
      useContentStore().listGatewayArchives(),
      (error: any) => error?.data?.code === 'CONTENT_PACK_GATEWAY_RESPONSE_INVALID',
    )
  })

  test('explains Gateway failures without inventing a Store account step', () => {
    const missingKey = gatewayArchiveErrorPresentation({
      status: 400,
      code: 'CONTENT_PACK_GATEWAY_KEY_REQUIRED',
      detail: 'Save your Gateway API Key in Settings → This Mac before browsing Gateway archives.',
    })
    assert.match(missingKey.title, /Gateway access/)
    assert.match(missingKey.recovery, /Gateway API Key/)
    assert.doesNotMatch(missingKey.recovery, /purchase|owned|shelf/i)

    const mismatch = gatewayArchiveErrorPresentation({
      status: 502,
      code: 'CONTENT_PACK_GATEWAY_ARCHIVE_MISMATCH',
      detail: 'The Gateway returned an archive whose SHA-256 does not match the archive you chose. Nothing was installed.',
    })
    assert.match(mismatch.title, /did not match/)
    assert.match(mismatch.detail, /Nothing was installed/)
    assert.doesNotMatch(mismatch.recovery, /Refresh the Store|Restore Purchases/i)
  })

  test('the Store page shows the archive shelf, compatibility and visible failures outside account state', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../pages/library.vue', import.meta.url)),
      'utf8',
    )
    assert.match(page, /Gateway archives/)
    assert.match(page, /Gateway Archive Bank/)
    assert.match(page, /@click="loadGatewayArchives"/)
    assert.match(page, /@click="installFromGatewayArchive\(archive\)"/)
    assert.match(page, /:disabled="!!gatewayArchiveBusyDigest"/)
    assert.match(page, /gatewayCompatibilityLabel/)
    assert.match(page, /gatewayArchivesError/)
    assert.match(page, /Nothing needs to be on a shelf first\./)
    // The shelf itself must not be rendered behind the account/ownership gates
    // used by Gateway Store products.
    assert.doesNotMatch(page, /v-if="account"[^>]*>\s*<section class="gateway-archives"/)
    assert.doesNotMatch(page, /v-if="ownershipResolved"[^>]*>\s*<section class="gateway-archives"/)
  })
})
