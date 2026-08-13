import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, test } from 'node:test'
import { deflateRawSync } from 'node:zlib'

import JSZip from 'jszip'
import sharp from 'sharp'

import { verifyContentPackArchive } from '../content-packs/archive.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-publisher'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function visualStyleDocument(previewAsset = 'assets/preview.png') {
  return {
    kind: 'visual-style',
    schema_version: 1,
    id: 'com.storystudio.style.test',
    name: 'Test Style',
    description: 'A strict test visual style.',
    category: 'Test',
    tags: ['test'],
    style_bible: 'Use a single restrained visual treatment.',
    negative_prompt: 'No text.',
    preview_assets: [previewAsset],
    compatible_formula_ids: [],
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
  previewAssetPath?: string
  orphanDeclaredAsset?: boolean
  assetPath?: string
  assetMime?: 'image/png' | 'image/jpeg' | 'image/webp'
  assetBytes?: Uint8Array
}

async function buildArchive(options: ArchiveOptions = {}) {
  const assetPath = options.assetPath ?? 'assets/preview.png'
  const visualStyleBytes = Buffer.from(JSON.stringify(visualStyleDocument(options.previewAssetPath ?? assetPath)), 'utf8')
  const files = new Map<string, Buffer>([
    ['content/visual-style.json', visualStyleBytes],
    [assetPath, Buffer.from(options.assetBytes ?? PNG_1PX)],
  ])
  if (options.orphanDeclaredAsset) files.set('assets/orphan.png', PNG_1PX)
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
      id: 'com.storystudio.style.test',
      kind: 'visual-style',
      schema_version: 1,
      path: 'content/visual-style.json',
    }],
    files: [...files.entries()].map(([path, bytes]) => ({
      path,
      sha256: digest(bytes),
      bytes: bytes.byteLength,
      mime: path.endsWith('.json') ? 'application/json' : options.assetMime ?? 'image/png',
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface RawZipEntry {
  path: string
  compressedBytes: Uint8Array
  expandedBytes: number
  crc: number
  method?: number
  localFlags?: number
  centralFlags?: number
  localExtra?: Uint8Array
  centralExtra?: Uint8Array
  externalAttributes?: number
  madeBy?: number
}

function buildRawZip(entries: RawZipEntry[]): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const localExtra = Buffer.from(entry.localExtra ?? [])
    const local = Buffer.alloc(30 + name.byteLength + localExtra.byteLength + entry.compressedBytes.byteLength)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.localFlags ?? 0, 6)
    local.writeUInt16LE(entry.method ?? 0, 8)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.compressedBytes.byteLength, 18)
    local.writeUInt32LE(entry.expandedBytes, 22)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(localExtra.byteLength, 28)
    name.copy(local, 30)
    localExtra.copy(local, 30 + name.byteLength)
    Buffer.from(entry.compressedBytes).copy(local, 30 + name.byteLength + localExtra.byteLength)
    localParts.push(local)

    const centralExtra = Buffer.from(entry.centralExtra ?? [])
    const central = Buffer.alloc(46 + name.byteLength + centralExtra.byteLength)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.madeBy ?? 0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.centralFlags ?? entry.localFlags ?? 0, 8)
    central.writeUInt16LE(entry.method ?? 0, 10)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.compressedBytes.byteLength, 20)
    central.writeUInt32LE(entry.expandedBytes, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(centralExtra.byteLength, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralExtra.copy(central, 46 + name.byteLength)
    centralParts.push(central)
    localOffset += local.byteLength
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

interface RawPackOptions {
  assetActualBytes?: Uint8Array
  assetDeclaredBytes?: Uint8Array
  assetPayload?: Uint8Array
  assetMethod?: number
  assetHeaderExpandedBytes?: number
  manifestLocalExtra?: Uint8Array
  manifestCentralExtra?: Uint8Array
  previewAssetPath?: string
  assetLocalFlags?: number
  assetCentralFlags?: number
}

function buildRawPack(options: RawPackOptions = {}) {
  const visualStyleBytes = Buffer.from(JSON.stringify(visualStyleDocument(options.previewAssetPath)), 'utf8')
  const actualAssetBytes = options.assetActualBytes ?? PNG_1PX
  const declaredAssetBytes = options.assetDeclaredBytes ?? actualAssetBytes
  const manifestBytes = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: 'com.storystudio.raw-pack',
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: 'com.storystudio.sku.raw-pack', family: 'com.storystudio.family.test' },
    items: [{ id: 'com.storystudio.style.test', kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: digest(visualStyleBytes), bytes: visualStyleBytes.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: digest(declaredAssetBytes), bytes: declaredAssetBytes.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const keyPair = generateKeyPairSync('ed25519')
  const signature = sign(null, manifestBytes, keyPair.privateKey)
  const assetPayload = options.assetPayload ?? (options.assetMethod === 8 ? deflateRawSync(actualAssetBytes) : actualAssetBytes)
  return {
    archiveBytes: buildRawZip([
      { path: 'manifest.json', compressedBytes: manifestBytes, expandedBytes: manifestBytes.byteLength, crc: crc32(manifestBytes), localExtra: options.manifestLocalExtra, centralExtra: options.manifestCentralExtra },
      { path: 'signature.ed25519', compressedBytes: signature, expandedBytes: signature.byteLength, crc: crc32(signature) },
      { path: 'content/visual-style.json', compressedBytes: visualStyleBytes, expandedBytes: visualStyleBytes.byteLength, crc: crc32(visualStyleBytes) },
      {
        path: 'assets/preview.png', compressedBytes: assetPayload,
        expandedBytes: options.assetHeaderExpandedBytes ?? actualAssetBytes.byteLength,
        crc: crc32(actualAssetBytes), method: options.assetMethod ?? 0,
        localFlags: options.assetLocalFlags, centralFlags: options.assetCentralFlags,
      },
    ]),
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function centralOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return view.getUint32(offset + 16, true)
  }
  throw new Error('test ZIP is missing EOCD')
}

function findCentralEntry(bytes: Uint8Array, path: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = centralOffset(bytes)
  while (view.getUint32(offset, true) === 0x02014b50) {
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8') === path) return offset
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`test ZIP is missing ${path}`)
}

describe('immutable content-pack archive verification', () => {
  test('returns only fully verified in-memory documents and assets', async () => {
    const archive = await buildArchive()

    const verified = await verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem))

    assert.equal(verified.manifest.pack_id, 'com.storystudio.test-pack')
    assert.deepEqual(Buffer.from(verified.manifestBytes), archive.manifestBytes)
    assert.equal(verified.documents.get('com.storystudio.style.test')?.kind, 'visual-style')
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
      mutateFileBytes: (path, bytes) => path === 'content/visual-style.json'
        ? Buffer.concat([bytes, Buffer.from(' ', 'utf8')])
        : bytes,
    })

    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /hash|byte|expanded/i)
  })

  test('rejects a tampered declared raster asset before it can be used', async () => {
    const archive = await buildArchive({
      mutateFileBytes: (path, bytes) => path === 'assets/preview.png'
        ? Buffer.concat([bytes, Buffer.from('tampered', 'utf8')])
        : bytes,
    })

    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /hash|byte|expanded/i)
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

    const unicodeCollision = buildRawZip([
      { path: 'assets/caf\u00e9.png', compressedBytes: Buffer.alloc(0), expandedBytes: 0, crc: 0, localFlags: 0x800 },
      { path: 'assets/cafe\u0301.png', compressedBytes: Buffer.alloc(0), expandedBytes: 0, crc: 0, localFlags: 0x800 },
    ])
    await assert.rejects(verifyContentPackArchive(unicodeCollision, policy(caseCollision.publicKeyPem)), /collision/i)
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

  test('refuses a deflate payload whose actual output exceeds its forged header and signed file size', async () => {
    const inflatedPayload = Buffer.alloc(4 * 1024 * 1024)
    const archive = buildRawPack({
      assetActualBytes: inflatedPayload,
      assetDeclaredBytes: PNG_1PX,
      assetPayload: deflateRawSync(inflatedPayload),
      assetMethod: 8,
      assetHeaderExpandedBytes: PNG_1PX.byteLength,
    })

    await assert.rejects(
      verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)),
      /expanded|limit|declared size/i,
    )
  })

  test('requires each ZIP header expanded-size field to match actual extracted bytes', async () => {
    const archive = buildRawPack({ assetHeaderExpandedBytes: 1 })
    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /header.*byte|expanded.*header/i)
  })

  test('rejects local-header name swapping and local encryption before reading payloads', async () => {
    const swapped = await buildArchive()
    const swappedBytes = Buffer.from(swapped.archiveBytes)
    const swappedCentral = findCentralEntry(swappedBytes, 'content/visual-style.json')
    const swappedLocal = swappedBytes.readUInt32LE(swappedCentral + 42)
    swappedBytes[swappedLocal + 30] = 'x'.charCodeAt(0)
    await assert.rejects(verifyContentPackArchive(swappedBytes, policy(swapped.publicKeyPem)), /local.*path|header.*path/i)

    const encrypted = await buildArchive()
    const encryptedBytes = Buffer.from(encrypted.archiveBytes)
    const encryptedCentral = findCentralEntry(encryptedBytes, 'content/visual-style.json')
    const encryptedLocal = encryptedBytes.readUInt32LE(encryptedCentral + 42)
    encryptedBytes.writeUInt16LE(encryptedBytes.readUInt16LE(encryptedLocal + 6) | 1, encryptedLocal + 6)
    await assert.rejects(verifyContentPackArchive(encryptedBytes, policy(encrypted.publicKeyPem)), /encrypt/i)
  })

  test('admits only UTF-8 and the documented deflate option bits in both ZIP headers', async () => {
    const allowedDeflate = buildRawPack({ assetMethod: 8, assetLocalFlags: 0x806, assetCentralFlags: 0x806 })
    await assert.doesNotReject(verifyContentPackArchive(allowedDeflate.archiveBytes, policy(allowedDeflate.publicKeyPem)))

    for (const [label, localFlags, centralFlags] of [
      ['patched entries', 0x20, 0x20],
      ['masked entries', 0x2000, 0x2000],
      ['unsupported entries', 0x10, 0x10],
      ['deflate option on stored entries', 0x2, 0x2],
    ] as const) {
      const archive = buildRawPack({ assetLocalFlags: localFlags, assetCentralFlags: centralFlags })
      await assert.rejects(
        verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)),
        /ZIP.*flag|patched|masked|unsupported/i,
        label,
      )
    }
  })

  test('rejects special Unix mode bits even when the ZIP host claims DOS', async () => {
    const archive = await buildArchive()
    const bytes = Buffer.from(archive.archiveBytes)
    const central = findCentralEntry(bytes, 'content/visual-style.json')
    bytes.writeUInt16LE(20, central + 4)
    bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38)

    await assert.rejects(verifyContentPackArchive(bytes, policy(archive.publicKeyPem)), /symlink|special/i)
  })

  test('rejects ZIP64 extra records even when 32-bit size fields are present', async () => {
    const archive = buildRawPack({
      manifestLocalExtra: Buffer.from([0x01, 0x00, 0x00, 0x00]),
      manifestCentralExtra: Buffer.from([0x01, 0x00, 0x00, 0x00]),
    })

    await assert.rejects(verifyContentPackArchive(archive.archiveBytes, policy(archive.publicKeyPem)), /ZIP64|extra/i)
  })

  test('rejects unclaimed bytes between the central directory and EOCD', async () => {
    const archive = await buildArchive()
    const bytes = Buffer.from(archive.archiveBytes)
    const eocd = bytes.length - 22
    const withHiddenGap = Buffer.concat([bytes.subarray(0, eocd), Buffer.from('HIDDEN', 'utf8'), bytes.subarray(eocd)])

    await assert.rejects(verifyContentPackArchive(withHiddenGap, policy(archive.publicKeyPem)), /gap|central directory/i)
  })

  test('requires every preview reference to resolve and rejects orphan declared assets', async () => {
    const missing = await buildArchive({ previewAssetPath: 'assets/missing.png' })
    await assert.rejects(verifyContentPackArchive(missing.archiveBytes, policy(missing.publicKeyPem)), /preview|asset|missing/i)

    const orphan = await buildArchive({ orphanDeclaredAsset: true })
    await assert.rejects(verifyContentPackArchive(orphan.archiveBytes, policy(orphan.publicKeyPem)), /orphan|asset/i)
  })

  test('bounds raster dimensions and rejects multipage assets before full decode', async () => {
    const oversizedPng = Buffer.from(PNG_1PX)
    oversizedPng.writeUInt32BE(50_000, 16)
    oversizedPng.writeUInt32BE(50_000, 20)
    const oversized = await buildArchive({ assetBytes: oversizedPng })
    await assert.rejects(verifyContentPackArchive(oversized.archiveBytes, policy(oversized.publicKeyPem)), /pixel|cannot be decoded/i)

    const multipageTiff = await sharp([PNG_1PX, PNG_1PX], { join: { animated: true } }).tiff().toBuffer()
    const multipage = await buildArchive({ assetBytes: multipageTiff })
    await assert.rejects(verifyContentPackArchive(multipage.archiveBytes, policy(multipage.publicKeyPem)), /animated|multipage/i)
  })
})
