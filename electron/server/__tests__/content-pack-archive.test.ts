import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, test } from 'node:test'

import JSZip from 'jszip'

import { verifyContentPackArchive } from '../content-packs/archive.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-publisher'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function formulaDocument() {
  return {
    kind: 'series-formula',
    schema_version: 1,
    id: 'com.storystudio.formula.test',
    name: 'Test Formula',
    description: 'A strict test Formula.',
    channel_promise: 'Explain one thing carefully.',
    audience: 'Test viewers.',
    narrative_rules: ['Use the evidence.'],
    title_rules: ['Use a specific title.'],
    script_structure: {
      default_chapter_count: 1,
      chapter_count_range: [1, 1],
      default_length_minutes: 1,
      length_minutes_range: [1, 1],
      duration_presets: [1],
      default_words_per_minute: 120,
      chapters_independent: true,
      pacing_arc: ['Start'],
      additional_rules: ['Stay concise.'],
    },
    compatible_topic_pack_ids: [],
    recommended_visual_style_ids: [],
    recommended_thumbnail_recipe_ids: [],
  }
}

interface ArchiveOptions {
  mutateManifestBytes?: (signedBytes: Buffer) => Buffer
  mutateFileBytes?: (path: string, bytes: Buffer) => Buffer
  extraEntries?: Array<{ path: string; bytes: Uint8Array; options?: Record<string, unknown> }>
  omitDeclaredPath?: string
  keyId?: string
  publisherId?: string
  signature?: Uint8Array
}

async function buildArchive(options: ArchiveOptions = {}) {
  const formulaBytes = Buffer.from(JSON.stringify(formulaDocument()), 'utf8')
  const files = new Map<string, Buffer>([
    ['content/formula.json', formulaBytes],
    ['assets/preview.png', PNG_1PX],
  ])
  const manifest = {
    pack_format: 1,
    pack_id: 'com.storystudio.test-pack',
    publisher_id: options.publisherId ?? PUBLISHER_ID,
    key_id: options.keyId ?? KEY_ID,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: 'com.storystudio.sku.test-pack', family: 'com.storystudio.family.test' },
    items: [{
      id: 'com.storystudio.formula.test',
      kind: 'series-formula',
      schema_version: 1,
      path: 'content/formula.json',
    }],
    files: [...files.entries()].map(([path, bytes]) => ({
      path,
      sha256: digest(bytes),
      bytes: bytes.byteLength,
      mime: path.endsWith('.json') ? 'application/json' : 'image/png',
    })),
  }
  const signedManifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const manifestBytes = options.mutateManifestBytes?.(Buffer.from(signedManifestBytes)) ?? signedManifestBytes
  const keyPair = generateKeyPairSync('ed25519')
  const signature = options.signature ?? sign(null, signedManifestBytes, keyPair.privateKey)
  const zip = new JSZip()
  zip.file('manifest.json', manifestBytes, { createFolders: false })
  zip.file('signature.ed25519', signature, { createFolders: false })
  for (const [path, bytes] of files) {
    if (path === options.omitDeclaredPath) continue
    zip.file(path, options.mutateFileBytes?.(path, Buffer.from(bytes)) ?? bytes, { createFolders: false })
  }
  for (const entry of options.extraEntries ?? []) {
    zip.file(entry.path, entry.bytes, { createFolders: false, ...entry.options })
  }
  return {
    archiveBytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' }),
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    manifestBytes,
  }
}

function policy(publicKeyPem: string) {
  return {
    publisherKeys: new Map([[KEY_ID, { publisherId: PUBLISHER_ID, publicKeyPem }]]),
  }
}

describe('immutable content-pack archive verification', () => {
  test('returns only fully verified in-memory documents and assets', async () => {
    const archive = await buildArchive()

    const verified = await verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem))

    assert.equal(verified.manifest.pack_id, 'com.storystudio.test-pack')
    assert.deepEqual(Buffer.from(verified.manifestBytes), archive.manifestBytes)
    assert.equal(verified.documents.get('com.storystudio.formula.test')?.kind, 'series-formula')
    assert.deepEqual(Buffer.from(verified.files.get('assets/preview.png') ?? []), PNG_1PX)
  })

  test('binds the detached signature to the exact raw manifest bytes', async () => {
    const archive = await buildArchive({
      mutateManifestBytes: bytes => Buffer.from(bytes.toString('utf8').replace('"version":"1.0.0"', '"version":"1.0.1"'), 'utf8'),
    })

    await assert.rejects(
      verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)),
      /signature/i,
    )
  })

  test('rejects content whose hash or byte size differs from the signed manifest', async () => {
    const archive = await buildArchive({
      mutateFileBytes: (path, bytes) => path === 'content/formula.json'
        ? Buffer.concat([bytes, Buffer.from(' ', 'utf8')])
        : bytes,
    })

    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /hash|byte/i)
  })

  test('rejects a tampered declared raster asset before it can be used', async () => {
    const archive = await buildArchive({
      mutateFileBytes: (path, bytes) => path === 'assets/preview.png'
        ? Buffer.concat([bytes, Buffer.from('tampered', 'utf8')])
        : bytes,
    })

    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /hash|byte/i)
  })

  test('rejects missing and undeclared entries', async () => {
    const missing = await buildArchive({ omitDeclaredPath: 'assets/preview.png' })
    await assert.rejects(verifyContentPackArchive(missing.archiveBytes, policy(missing.publicKeyPem)), /declared|missing/i)

    const extra = await buildArchive({ extraEntries: [{ path: 'notes.txt', bytes: Buffer.from('not allowed') }] })
    await assert.rejects(verifyContentPackArchive(extra.archiveBytes, policy(extra.publicKeyPem)), /undeclared|permitted/i)
  })

  test('rejects unsafe raw archive paths before accepting content', async () => {
    for (const path of [
      '../content/escape.json',
      '/content/absolute.json',
      'content\\backslash.json',
    ]) {
      const archive = await buildArchive({ extraEntries: [{ path, bytes: Buffer.from('{}') }] })
      await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /path|undeclared/i)
    }
  })

  test('rejects case-folded and Unicode-normalized path collisions', async () => {
    const caseCollision = await buildArchive({
      extraEntries: [{ path: 'assets/PREVIEW.png', bytes: PNG_1PX }],
    })
    await assert.rejects(verifyContentPackArchive(caseCollision.archiveBytes, policy(caseCollision.publicKeyPem)), /collision/i)

    const unicodeCollision = await buildArchive({
      extraEntries: [
        { path: 'assets/caf\u00e9.png', bytes: PNG_1PX },
        { path: 'assets/cafe\u0301.png', bytes: PNG_1PX },
      ],
    })
    await assert.rejects(verifyContentPackArchive(unicodeCollision.archiveBytes, policy(unicodeCollision.publicKeyPem)), /collision/i)
  })

  test('rejects symlink-like archive entries', async () => {
    const archive = await buildArchive({
      extraEntries: [{
        path: 'content/link.json',
        bytes: Buffer.from('{}'),
        options: { unixPermissions: 0o120777 },
      }],
    })

    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /symlink/i)
  })

  test('enforces archive entry and expanded-byte limits before returning data', async () => {
    const tooMany = await buildArchive({
      extraEntries: Array.from({ length: 257 }, (_, index) => ({ path: `assets/extra-${index}.png`, bytes: PNG_1PX })),
    })
    await assert.rejects(verifyContentPackArchive(tooMany.archiveBytes, policy(tooMany.publicKeyPem)), /entries|limit/i)

    const overExpanded = await buildArchive({
      extraEntries: [{ path: 'assets/large.png', bytes: Buffer.alloc(101 * 1024 * 1024) }],
    })
    await assert.rejects(verifyContentPackArchive(overExpanded.archiveBytes, policy(overExpanded.publicKeyPem)), /expanded|limit|undeclared/i)
  })

  test('rejects an unknown key, publisher mismatch, and invalid signature', async () => {
    const unknownKey = await buildArchive({ keyId: 'com.storystudio.unknown-key' })
    await assert.rejects(verifyContentPackArchive(unknownKey.archiveBytes, policy(unknownKey.publicKeyPem)), /key/i)

    const publisherMismatch = await buildArchive({ publisherId: 'com.someoneelse' })
    await assert.rejects(verifyContentPackArchive(publisherMismatch.archiveBytes, policy(publisherMismatch.publicKeyPem)), /namespace|publisher/i)

    const invalidSignature = await buildArchive({ signature: Buffer.alloc(64) })
    await assert.rejects(verifyContentPackArchive(invalidSignature.archiveBytes, policy(invalidSignature.publicKeyPem)), /signature/i)
  })
})
