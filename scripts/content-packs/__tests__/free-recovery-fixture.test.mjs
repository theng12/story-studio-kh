import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { register } from 'tsx/esm/api'

const unregisterTsx = register()
const { verifyContentPackArchive } = await import(new URL('../../../electron/server/content-packs/archive.ts', import.meta.url))
unregisterTsx()

const FIXTURE = new URL('../../../electron/server/__tests__/fixtures/content-packs/free-recovery-test/', import.meta.url)
const KEY_ID = 'com.storystudio.key.free-recovery-test'
const PUBLISHER_ID = 'com.storystudio'
const EXPECTED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzzatqnj/GLnFGv3ELduoFd6mQFusMNtjnat+8L2ErHg=
-----END PUBLIC KEY-----
`
const EXPECTED_ARCHIVE_SHA256 = 'f5d7d2fc65211b217cd1834a5a6d6faee39ead76b382afd2a7371a967b53d976'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('free recovery pack fixture remains a verified immutable first-party archive', async () => {
  const [archiveBytes, publicKeyPem, recordedHash] = await Promise.all([
    readFile(new URL('free-recovery-test.sspack', FIXTURE)),
    readFile(new URL('free-recovery-test-public.pem', FIXTURE), 'utf8'),
    readFile(new URL('free-recovery-test.sspack.sha256', FIXTURE), 'utf8'),
  ])

  assert.equal(publicKeyPem, EXPECTED_PUBLIC_KEY)
  assert.equal(sha256(archiveBytes), EXPECTED_ARCHIVE_SHA256)
  assert.equal(recordedHash, `${EXPECTED_ARCHIVE_SHA256}  free-recovery-test.sspack\n`)

  const verified = await verifyContentPackArchive(archiveBytes, {
    publisherKeys: new Map([[KEY_ID, { publisherId: PUBLISHER_ID, publicKeyPem }]]),
  })

  assert.deepEqual(verified.manifest, {
    pack_format: 1,
    pack_id: 'com.storystudio.pack.free-recovery-test',
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: {
      sku: 'com.storystudio.sku.free-recovery-test',
      family: 'com.storystudio.family.free-recovery-test',
    },
    items: [{
      id: 'com.storystudio.style.free-recovery-test',
      kind: 'visual-style',
      schema_version: 1,
      path: 'content/free-recovery-style.json',
    }],
    bundles: [],
    files: [
      {
        path: 'assets/free-recovery-preview.png',
        sha256: '2fe8e6c2a228cc8932b1a02ef77d563dddc0618eb038ea3ea29338b35f37fdc6',
        bytes: 91,
        mime: 'image/png',
      },
      {
        path: 'content/free-recovery-style.json',
        sha256: 'eebaa393d40ea6dc36c149a491654c6b3feab7cb8f053a47f16d9d14f3c9ef87',
        bytes: 496,
        mime: 'application/json',
      },
    ],
  })
  assert.deepEqual([...verified.documents.keys()], ['com.storystudio.style.free-recovery-test'])
  assert.deepEqual([...verified.files.keys()], [
    'assets/free-recovery-preview.png',
    'content/free-recovery-style.json',
  ])
  assert.deepEqual(verified.documents.get('com.storystudio.style.free-recovery-test'), {
    kind: 'visual-style',
    schema_version: 1,
    id: 'com.storystudio.style.free-recovery-test',
    name: 'Free Recovery Test Style',
    description: 'A signed free recovery fixture for offline Story Studio validation.',
    category: 'recovery-test',
    tags: ['free', 'recovery', 'test'],
    style_bible: 'Use a calm, legible first-party recovery-test visual style.',
    negative_prompt: 'No text, watermark, logo, or executable content.',
    preview_assets: ['assets/free-recovery-preview.png'],
    compatible_formula_ids: [],
  })
  assert.ok(verified.files.get('assets/free-recovery-preview.png')?.byteLength)
})
