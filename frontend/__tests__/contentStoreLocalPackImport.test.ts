import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'

/**
 * The local import path is deliberately separate from the Store's Gateway
 * commerce state: it must work with no overview, no account and no fresh
 * catalog, and it must not pretend a keyless local file became Gateway-owned.
 * These tests pin the wire request, the 50 MiB bound, the result normalization
 * and the local-only error copy.
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
  CONTENT_PACK_IMPORT_MAX_BYTES,
  contentPackImportErrorPresentation,
  contentPackImportUiError,
} = await import('../composables/useContentStore.js')

const installResult = {
  pack_id: 'kh.owner.example',
  version: '1.2.0',
  archive_sha256: 'b'.repeat(64),
  activated: true,
  retained_versions: ['1.2.0'],
}

beforeEach(() => {
  _clearContentStoreSessionCacheForTests()
  calls = []
  handler = () => { throw new Error('No request expected') }
})

describe('local Content Pack import', () => {
  test('POSTs the raw archive as application/octet-stream and reads the flat install result', async () => {
    const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    handler = (path, options) => {
      assert.equal(path, '/api/content-packs/import')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.['Content-Type'], 'application/octet-stream')
      assert.ok(options.body instanceof ArrayBuffer)
      assert.deepEqual([...new Uint8Array(options.body)], [...archive])
      return structuredClone(installResult)
    }

    const installed = await useContentStore().importPack(archive.buffer as ArrayBuffer)

    assert.deepEqual(installed, { packId: 'kh.owner.example', version: '1.2.0' })
    assert.deepEqual(calls.map(call => call.path), ['/api/content-packs/import'])
  })

  test('refuses an archive over 50 MiB before sending it', async () => {
    const archive = new ArrayBuffer(CONTENT_PACK_IMPORT_MAX_BYTES + 1)
    await assert.rejects(
      useContentStore().importPack(archive),
      (error: any) => error?.data?.code === 'CONTENT_PACK_IMPORT_TOO_LARGE'
        && /50 MiB/.test(error.data.detail),
    )
    assert.equal(calls.length, 0)
  })

  test('refuses an empty archive and an unreadable success result', async () => {
    await assert.rejects(
      useContentStore().importPack(new ArrayBuffer(0)),
      (error: any) => error?.data?.code === 'CONTENT_PACK_IMPORT_EMPTY',
    )
    assert.equal(calls.length, 0)

    handler = () => ({ activated: true })
    await assert.rejects(
      useContentStore().importPack(new Uint8Array([1]).buffer as ArrayBuffer),
      (error: any) => error?.data?.code === 'CONTENT_PACK_IMPORT_RESPONSE_INVALID',
    )
  })

  test('local error copy never falls back to Store/refresh or Installed-tab instructions', () => {
    const tooLarge = contentPackImportErrorPresentation(contentPackImportUiError(
      Object.assign(new Error('too large'), {
        status: 413,
        data: { detail: 'Content Pack archive exceeds the 52428800 byte limit.' },
      }),
    ))
    assert.match(tooLarge.title, /50 MiB/)

    const unreadable = contentPackImportErrorPresentation(contentPackImportUiError(
      Object.assign(new Error('unreadable result'), {
        status: 201,
        data: { code: 'CONTENT_PACK_IMPORT_RESPONSE_INVALID', detail: 'Story Studio could not read which pack and version the server reported, so the installation is unconfirmed.' },
      }),
    ))
    assert.equal(unreadable.title, 'The installation result could not be read')
    assert.match(unreadable.detail, /installation is unconfirmed/)
    assert.doesNotMatch(unreadable.recovery, /Installed packs/)

    const unknown = contentPackImportErrorPresentation(contentPackImportUiError(
      Object.assign(new Error('bad archive'), {
        status: 400,
        data: { detail: 'This Content Pack archive could not be verified. It may be damaged, tampered with, or incompatible with this version of Story Studio.' },
      }),
    ))
    assert.equal(unknown.title, 'This Content Pack could not be installed')
    assert.equal(unknown.detail, 'This Content Pack archive could not be verified. It may be damaged, tampered with, or incompatible with this version of Story Studio.')
    assert.doesNotMatch(unknown.recovery, /Refresh the Store|Content Store is unavailable|Installed/)
  })

  test('the Store page exposes the local action without a Gateway freshness gate', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../pages/library.vue', import.meta.url)),
      'utf8',
    )
    assert.match(page, /Install Content Pack/)
    assert.match(page, /:disabled="importBusy"/)
    assert.match(page, /CONTENT_PACK_IMPORT_MAX_BYTES/)
    // The local button must not inherit the Store's commerce gate.
    assert.doesNotMatch(page, /:disabled="[^"]*networkActionsDisabled[^"]*"[^>]*@click="chooseContentPack"/)
    assert.match(page, /installed on this Mac and available in the library pickers/)
    assert.doesNotMatch(page, /does not change Gateway ownership|Gateway-backed Installed list/)
  })
})
