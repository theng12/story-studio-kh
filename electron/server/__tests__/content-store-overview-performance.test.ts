/**
 * Content Store load and install cost (v1.4.152).
 *
 * Measured 2026-09-12 on the owner's Mac: the overview took 4.7 s warm and 13 s
 * cold, each install 14 s, of which ~5 s was rebuilding that overview. Three
 * things pinned here: the GenStudio reads run together, an install can be asked
 * for without the rebuild, and the archive CRC is the native one with the same
 * digest as the reference loop.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { describe, test } from 'node:test'
import { crc32, referenceCrc32 } from '../content-packs/archive.js'

const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf8')

describe('Content Store overview and install cost', () => {
  test('native CRC-32 matches the reference loop byte for byte, including empty and odd-length input', () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([255]), randomBytes(1), randomBytes(1023), randomBytes(64 * 1024 + 7)]) {
      assert.equal(crc32(bytes), referenceCrc32(bytes))
    }
    // Known vector: CRC-32 of "123456789".
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  })

  test('the overview asks GenStudio for account, catalog and receipts together, then shelves', async () => {
    const source = await read('../services/content-store.ts')
    const start = source.indexOf('export async function loadContentStoreOverview')
    const end = source.indexOf('function requirePurchasableProduct', start)
    const body = source.slice(start, end)
    assert.match(body, /const accountRequest = getGenStudioContentAccount\(apiKey\)/)
    assert.match(body, /const catalogRequest = listGenStudioContentProducts\(apiKey, storyVersion\)/)
    assert.match(body, /const receiptsRequest = getGenStudioContentReceipts\(apiKey\)/)
    assert.match(body, /Promise\.allSettled\(\[accountRequest, catalogRequest, receiptsRequest, shelvesRequest\]\)/)
    assert.doesNotMatch(body, /const catalog = await listGenStudioContentProducts/)
  })

  test('an install can skip the overview rebuild, and only then', async () => {
    const delivery = await read('../services/content-store-delivery.ts')
    assert.match(delivery, /overview: response\.overview === false \? null : await loadContentStoreOverview\(\)/)
    const route = await read('../routes/content-store.ts')
    assert.match(route, /const overview = firstParam\(req\.query\.overview as string \| string\[\] \| undefined\) !== '0'/)
    assert.match(route, /installOwnedContentStoreRelease\(OPAQUE_ID\.parse\(firstParam\(req\.params\.releaseId\)\), options, \{ overview \}\)/)
  })

  test('the installed-tree fingerprint stats a directory\'s entries together, in sorted order', async () => {
    const installer = await read('../content-packs/installer.ts')
    const start = installer.indexOf('async function installedTreeFingerprint')
    const body = installer.slice(start, installer.indexOf('\n}\n', start))
    assert.match(body, /const infos = await Promise\.all\(entries\.map\(entry => fs\.lstat\(path\.join\(dir, entry\.name\)\)\)\)/)
    assert.match(body, /\.sort\(\(left, right\) => left\.name\.localeCompare\(right\.name\)\)/)
  })
})
