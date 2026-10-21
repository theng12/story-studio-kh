import { createHash } from 'node:crypto'
import * as zlib from 'node:zlib'
import { promisify } from 'node:util'

// Off the main thread: a sync inflate of a 40 MB pack stalled every request behind it.
const inflateRaw = promisify(zlib.inflateRaw)
import sharp from 'sharp'

import { isBundleOnlyCoordinationManifest, parseContentPackDocument, parseContentPackManifest } from './schemas.js'
import { verifyEd25519Signature } from './signature.js'
import type { ContentPackDocument, ContentPackManifest } from './types.js'

const MEBIBYTE = 1024 * 1024
const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_CENTRAL_HEADER = 0x02014b50
const ZIP_EOCD = 0x06054b50
const ZIP64_EOCD_LOCATOR = 0x07064b50

export interface ContentPackArchiveLimits {
  maxArchiveBytes: number
  maxExpandedBytes: number
  maxEntries: number
  maxJsonBytes: number
  maxRasterBytes: number
  maxRasterPixels: number
  maxSignatureBytes: number
}

const DEFAULT_LIMITS: ContentPackArchiveLimits = {
  maxArchiveBytes: 50 * MEBIBYTE,
  maxExpandedBytes: 100 * MEBIBYTE,
  maxEntries: 256,
  // 4 MiB, not 1: a 100-subject Topic Pack document is ~1.2 MB, and rasters were
  // already allowed 15 MiB while JSON was capped at 1 MiB — an asymmetry nobody
  // chose, it is just that no one had expected a large JSON. The caps that
  // actually stop a decompression bomb are maxArchiveBytes, maxExpandedBytes and
  // maxEntries above, and those are unchanged. Do not raise this to make a test
  // pass; raise it only when a real document needs the room, and say why here.
  maxJsonBytes: 4 * MEBIBYTE,
  maxRasterBytes: 15 * MEBIBYTE,
  maxRasterPixels: 100_000_000,
  maxSignatureBytes: 1024,
}

export interface ContentPackVerificationPolicy {
  publisherKeys: ReadonlyMap<string, { publisherId: string; publicKeyPem: string }>
  limits?: Partial<ContentPackArchiveLimits>
}

export interface VerifiedContentPack {
  manifest: ContentPackManifest
  /** SHA-256 of the exact signed archive, used for immutable version pins. */
  archiveSha256: string
  /** Exact bytes that were signed; never reserialized before verification. */
  manifestBytes: Uint8Array
  documents: ReadonlyMap<string, ContentPackDocument>
  /** Verified declared content and asset bytes. The installer decides whether to persist them. */
  files: ReadonlyMap<string, Uint8Array>
}

interface ZipEntry {
  path: string
  flags: number
  method: number
  crc: number
  compressedBytes: number
  expandedBytes: number
  localHeaderOffset: number
  dataOffset: number
}

function fail(message: string): never {
  throw new Error(`Invalid content-pack archive: ${message}`)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * CRC-32 of a ZIP entry. Node's zlib implementation (22.2+; Electron's Node is
 * 24) runs at memory speed; the bit-by-bit loop below managed ~36 MB/s, which
 * put 6.8 s of main-thread CPU into one verification sweep over 244 MB of
 * installed packs (profiled 2026-09-12). The loop stays as the reference and
 * fallback, and a test pins the two to the same digest.
 */
export function crc32(bytes: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32
  if (typeof native === 'function') return native(bytes) >>> 0
  return referenceCrc32(bytes)
}

export function referenceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

function decodePath(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some(byte => byte >= 0x80)) fail('non-UTF-8 archive path')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('invalid UTF-8 archive path')
  }
}

function assertSafePath(path: string, seen: Set<string>): void {
  if (!path || path.length > 240 || path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.endsWith('/')) {
    fail(`unsafe archive path: ${JSON.stringify(path)}`)
  }
  const segments = path.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) fail(`unsafe archive path: ${JSON.stringify(path)}`)
  const canonical = path.normalize('NFC').toLocaleLowerCase('en-US')
  if (seen.has(canonical)) fail(`normalized path collision: ${JSON.stringify(path)}`)
  seen.add(canonical)
}

/** V1 has no use for ZIP extras; rejecting them removes ZIP64 and Unicode-extra ambiguity. */
function rejectExtraFields(bytes: Uint8Array, label: string): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) fail(`malformed ${label} extra field`)
    const id = bytes[offset] | (bytes[offset + 1] << 8)
    const length = bytes[offset + 2] | (bytes[offset + 3] << 8)
    if (offset + 4 + length > bytes.byteLength) fail(`malformed ${label} extra field`)
    if (id === 0x0001) fail('ZIP64 extra fields are not permitted')
    fail(`${label} extra fields are not permitted in Content Pack v1`)
  }
}

function assertEntryFlags(flags: number, method: number, label: string): void {
  if (flags & (0x1 | 0x40)) fail(`encrypted ZIP entry is not permitted (${label})`)
  if (flags & 0x8) fail(`ZIP data descriptors are not permitted (${label})`)
  const supported = 0x800 | (method === 8 ? 0x6 : 0)
  const unsupported = flags & ~supported
  if (unsupported & 0x20) fail(`patched ZIP data is not permitted (${label})`)
  if (unsupported & 0x2000) fail(`masked ZIP header values are not permitted (${label})`)
  if (unsupported) fail(`unsupported ZIP general-purpose flag (${label})`)
}

function findEocd(view: DataView, archiveBytes: Uint8Array): number {
  const start = Math.max(0, archiveBytes.byteLength - 22 - 0xffff)
  for (let offset = archiveBytes.byteLength - 22; offset >= start; offset -= 1) {
    if (readU32(view, offset) === ZIP_EOCD && offset + 22 + readU16(view, offset + 20) === archiveBytes.byteLength) return offset
  }
  fail('missing ZIP end-of-central-directory record')
}

function parseZipEntries(archiveBytes: Uint8Array, limits: ContentPackArchiveLimits): ZipEntry[] {
  if (archiveBytes.byteLength > limits.maxArchiveBytes) fail(`archive exceeds ${limits.maxArchiveBytes} byte limit`)
  if (archiveBytes.byteLength < 22) fail('missing ZIP end-of-central-directory record')
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength)
  const eocd = findEocd(view, archiveBytes)
  if (eocd >= 20 && readU32(view, eocd - 20) === ZIP64_EOCD_LOCATOR) fail('ZIP64 archives are not permitted')
  const diskNumber = readU16(view, eocd + 4)
  const centralDisk = readU16(view, eocd + 6)
  const entriesOnDisk = readU16(view, eocd + 8)
  const entryCount = readU16(view, eocd + 10)
  const centralBytes = readU32(view, eocd + 12)
  const centralOffset = readU32(view, eocd + 16)
  const archiveCommentBytes = readU16(view, eocd + 20)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail('multi-disk ZIP archives are not permitted')
  if (archiveCommentBytes !== 0) fail('ZIP archive comments are not permitted')
  if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 archives are not permitted')
  if (entryCount > limits.maxEntries) fail(`archive entry limit exceeded (${entryCount} > ${limits.maxEntries})`)
  if (centralOffset > eocd || centralBytes > eocd - centralOffset) fail('central directory lies outside the archive')
  if (centralOffset + centralBytes !== eocd) fail('unclaimed gap follows the central directory')

  const entries: ZipEntry[] = []
  const seenPaths = new Set<string>()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || readU32(view, offset) !== ZIP_CENTRAL_HEADER) fail('malformed central directory entry')
    const madeBy = readU16(view, offset + 4)
    const flags = readU16(view, offset + 8)
    const method = readU16(view, offset + 10)
    const crc = readU32(view, offset + 16)
    const compressedBytes = readU32(view, offset + 20)
    const expandedBytes = readU32(view, offset + 24)
    const pathLength = readU16(view, offset + 28)
    const extraLength = readU16(view, offset + 30)
    const commentLength = readU16(view, offset + 32)
    const diskStart = readU16(view, offset + 34)
    const externalAttributes = readU32(view, offset + 38)
    const localHeaderOffset = readU32(view, offset + 42)
    const end = offset + 46 + pathLength + extraLength + commentLength
    if (end > eocd || localHeaderOffset >= centralOffset) fail('central directory entry points outside archive data')
    if (commentLength !== 0) fail('central directory comments are not permitted')
    if (diskStart !== 0 || compressedBytes === 0xffffffff || expandedBytes === 0xffffffff || localHeaderOffset === 0xffffffff) fail('ZIP64 or split ZIP entries are not permitted')
    assertEntryFlags(flags, method, 'central directory')
    if (method !== 0 && method !== 8) fail('unsupported ZIP compression method')
    const rawPath = archiveBytes.subarray(offset + 46, offset + 46 + pathLength)
    const path = decodePath(rawPath, Boolean(flags & 0x800))
    assertSafePath(path, seenPaths)
    rejectExtraFields(archiveBytes.subarray(offset + 46 + pathLength, offset + 46 + pathLength + extraLength), 'central directory')
    const modeType = (externalAttributes >>> 16) & 0xf000
    if (modeType !== 0 && modeType !== 0x8000) fail(`symlink or special ZIP entry is not permitted: ${JSON.stringify(path)}`)
    if ((externalAttributes & 0x10) !== 0) fail(`directory ZIP entry is not permitted: ${JSON.stringify(path)}`)
    // `madeBy` is deliberately read only to avoid trusting its host claim when interpreting mode bits.
    void madeBy
    entries.push({ path, flags, method, crc, compressedBytes, expandedBytes, localHeaderOffset, dataOffset: 0 })
    offset = end
  }
  if (offset !== centralOffset + centralBytes) fail('central directory size mismatch')

  const occupied: Array<{ start: number; end: number }> = []
  for (const entry of entries) {
    const local = entry.localHeaderOffset
    if (local + 30 > centralOffset || readU32(view, local) !== ZIP_LOCAL_HEADER) fail(`missing local header for ${JSON.stringify(entry.path)}`)
    const flags = readU16(view, local + 6)
    const method = readU16(view, local + 8)
    const crc = readU32(view, local + 14)
    const compressedBytes = readU32(view, local + 18)
    const expandedBytes = readU32(view, local + 22)
    const pathLength = readU16(view, local + 26)
    const extraLength = readU16(view, local + 28)
    const dataOffset = local + 30 + pathLength + extraLength
    const dataEnd = dataOffset + compressedBytes
    if (dataOffset > centralOffset || dataEnd > centralOffset || !Number.isSafeInteger(dataEnd)) fail(`local header data lies outside archive: ${JSON.stringify(entry.path)}`)
    assertEntryFlags(flags, method, 'local header')
    if (flags !== entry.flags || method !== entry.method || crc !== entry.crc || compressedBytes !== entry.compressedBytes || expandedBytes !== entry.expandedBytes) {
      fail(`local header does not match central directory: ${JSON.stringify(entry.path)}`)
    }
    const localRawPath = archiveBytes.subarray(local + 30, local + 30 + pathLength)
    const localPath = decodePath(localRawPath, Boolean(flags & 0x800))
    if (localPath !== entry.path || !sameBytes(localRawPath, new TextEncoder().encode(entry.path))) fail(`local header path does not match central directory: ${JSON.stringify(entry.path)}`)
    rejectExtraFields(archiveBytes.subarray(local + 30 + pathLength, dataOffset), 'local header')
    entry.dataOffset = dataOffset
    occupied.push({ start: local, end: dataEnd })
  }
  occupied.sort((left, right) => left.start - right.start)
  let covered = 0
  for (const range of occupied) {
    if (range.start !== covered) fail('local ZIP records overlap or leave unclaimed archive data')
    covered = range.end
  }
  if (covered !== centralOffset) fail('local ZIP records do not exactly cover archive data')
  return entries
}

function readText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${label} is not valid UTF-8`)
  }
}

async function extractBounded(archiveBytes: Uint8Array, entry: ZipEntry, limit: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit <= 0) fail('invalid extraction limit')
  const compressed = archiveBytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes)
  let bytes: Uint8Array
  if (entry.method === 0) {
    if (compressed.byteLength > limit) fail(`actual expanded data exceeds bounded limit: ${JSON.stringify(entry.path)}`)
    bytes = Uint8Array.from(compressed)
  } else {
    try {
      bytes = Uint8Array.from(await inflateRaw(compressed, { maxOutputLength: limit }))
    } catch (error: any) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output length/i.test(String(error?.message ?? ''))) {
        fail(`actual expanded data exceeds bounded limit: ${JSON.stringify(entry.path)}`)
      }
      fail(`compressed ZIP payload is corrupt: ${JSON.stringify(entry.path)}`)
    }
  }
  if (bytes.byteLength > limit) fail(`actual expanded data exceeds bounded limit: ${JSON.stringify(entry.path)}`)
  if (bytes.byteLength !== entry.expandedBytes) fail(`ZIP header byte count does not match extracted data: ${JSON.stringify(entry.path)}`)
  if (crc32(bytes) !== entry.crc) fail(`ZIP CRC mismatch: ${JSON.stringify(entry.path)}`)
  return bytes
}

async function decodeRaster(bytes: Uint8Array, mime: string, limits: ContentPackArchiveLimits, path: string): Promise<void> {
  try {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: limits.maxRasterPixels, animated: true })
    const metadata = await image.metadata()
    const pageCount = metadata.pages ?? 1
    const pageHeight = metadata.pageHeight ?? metadata.height
    if (!metadata.width || !metadata.height || !pageHeight) fail(`raster has no usable dimensions: ${JSON.stringify(path)}`)
    if (pageCount !== 1) fail(`animated or multipage raster is not permitted: ${JSON.stringify(path)}`)
    const pixelCount = metadata.width * pageHeight * pageCount
    if (!Number.isSafeInteger(pixelCount) || pixelCount > limits.maxRasterPixels) fail(`raster pixel limit exceeded: ${JSON.stringify(path)}`)
    const formatMime = metadata.format === 'png' ? 'image/png'
      : metadata.format === 'jpeg' ? 'image/jpeg'
        : metadata.format === 'webp' ? 'image/webp'
          : undefined
    if (formatMime !== mime) fail(`raster MIME does not match decoded content: ${JSON.stringify(path)}`)
    await image.stats()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid content-pack archive:')) throw error
    fail(`raster asset cannot be decoded: ${JSON.stringify(path)}`)
  }
}

function limitsFor(policy: ContentPackVerificationPolicy): ContentPackArchiveLimits {
  const limits = { ...DEFAULT_LIMITS, ...policy.limits }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid content-pack verification policy: ${name} must be a positive integer`)
  }
  return limits
}

function referencedRasterPaths(document: ContentPackDocument): readonly string[] {
  // A lettering style's swatch is the whole point of the document -- the
  // owner buys the picture, not the name -- so its preview assets are
  // referenced exactly like a style's. Leaving it out of this switch made
  // every swatch look like an orphan and no lettering pack could be built.
  switch (document.kind) {
    case 'visual-style':
    case 'thumbnail-recipe':
    case 'lettering-style':
      return document.preview_assets
    default:
      return []
  }
}

export async function verifyContentPackArchive(
  archiveBytes: Uint8Array,
  policy: ContentPackVerificationPolicy,
): Promise<VerifiedContentPack> {
  return verifyArchive(archiveBytes, 'publisher', policy)
}

/**
 * Store archives remain structurally strict, but their permanent authority is
 * the GenStudio receipt rather than a Story publisher signature.
 */
export async function verifyDeliveryAttestedContentPackArchive(
  archiveBytes: Uint8Array,
): Promise<VerifiedContentPack> {
  return verifyArchive(archiveBytes, 'delivery-attested')
}

/**
 * Possession is the local-import intent: whoever holds a valid archive may
 * install it without a Store account or receipt. It selects one of the two
 * existing verifications from the manifest's own declared profile — publisher
 * signatures stay strictly checked, and a keyless delivery-profile archive gets
 * the same structural checks as Store delivery. Possession never proves a
 * publisher for a keyless archive.
 */
export async function verifyPossessedContentPackArchive(
  archiveBytes: Uint8Array,
  policy: ContentPackVerificationPolicy,
): Promise<VerifiedContentPack> {
  return verifyArchive(archiveBytes, 'possession', policy)
}

type ArchiveVerificationIntent = 'publisher' | 'delivery-attested' | 'possession'

function verifyPublisherSignature(
  manifest: ContentPackManifest,
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array | undefined,
  policy: ContentPackVerificationPolicy,
): void {
  if (!manifest.key_id) fail('local publisher verification requires a manifest key_id')
  if (manifest.delivery_profile) fail('delivery-attested profile must not use the local publisher verifier')
  const key = policy.publisherKeys.get(manifest.key_id)
  if (!key) fail(`unknown publisher key: ${manifest.key_id}`)
  if (key.publisherId !== manifest.publisher_id) fail('publisher key does not match manifest publisher')
  if (!signatureBytes || !verifyEd25519Signature(manifestBytes, signatureBytes, key.publicKeyPem)) fail('manifest signature verification failed')
}

function verifyDeliveryAttestedProfile(
  manifest: ContentPackManifest,
  signatureEntry: ZipEntry | undefined,
): void {
  // model-drift-allow: Frozen Content Store receipt profile identifies the signed delivery attestation format.
  if (manifest.delivery_profile !== 'genstudio-store-receipt-v1') {
    fail('delivery-attested archive must declare the GenStudio Store receipt profile')
  }
  if (signatureEntry) fail('delivery-attested archive must not contain a publisher signature')
}

async function verifyArchive(
  archiveBytes: Uint8Array,
  intent: ArchiveVerificationIntent,
  policy?: ContentPackVerificationPolicy,
): Promise<VerifiedContentPack> {
  const limits = limitsFor(policy ?? { publisherKeys: new Map() })
  const entries = parseZipEntries(archiveBytes, limits)
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]))
  const manifestEntry = entriesByPath.get('manifest.json')
  const signatureEntry = entriesByPath.get('signature.ed25519')
  if (!manifestEntry) fail('manifest.json is required')
  if (intent === 'publisher' && !signatureEntry) fail('manifest.json and signature.ed25519 are required')
  if (manifestEntry.expandedBytes > limits.maxJsonBytes) fail('manifest.json exceeds JSON byte limit')
  if (signatureEntry && signatureEntry.expandedBytes > limits.maxSignatureBytes) fail('signature.ed25519 exceeds signature byte limit')

  const manifestBytes = await extractBounded(archiveBytes, manifestEntry, Math.min(limits.maxJsonBytes, limits.maxExpandedBytes))
  const signatureBytes = signatureEntry
    ? await extractBounded(archiveBytes, signatureEntry, Math.min(limits.maxSignatureBytes, limits.maxExpandedBytes - manifestBytes.byteLength))
    : undefined
  if (signatureBytes && signatureBytes.byteLength !== 64) fail('signature.ed25519 must be a 64-byte Ed25519 signature')
  let manifest: ContentPackManifest
  try {
    manifest = parseContentPackManifest(JSON.parse(readText(manifestBytes, 'manifest.json')))
  } catch (error) {
    fail(`manifest.json does not match the Content Pack contract (${error instanceof Error ? error.message : 'unknown error'})`)
  }
  if (intent === 'publisher') {
    if (!policy) fail('local publisher verification requires a verification policy')
    verifyPublisherSignature(manifest, manifestBytes, signatureBytes, policy)
  } else if (intent === 'delivery-attested') {
    verifyDeliveryAttestedProfile(manifest, signatureEntry)
  } else if (manifest.delivery_profile) {
    // Keyless possession: structural delivery checks only, never a publisher claim.
    verifyDeliveryAttestedProfile(manifest, signatureEntry)
  } else {
    if (!policy) fail('local publisher verification requires a verification policy')
    verifyPublisherSignature(manifest, manifestBytes, signatureBytes, policy)
  }

  const declaredPaths = new Set(manifest.files.map(file => file.path))
  const admittedPaths = new Set(['manifest.json', ...(signatureEntry ? ['signature.ed25519'] : []), ...declaredPaths])
  if (isBundleOnlyCoordinationManifest(manifest) && entries.some(entry => entry.path.startsWith('content/') || entry.path.startsWith('assets/'))) {
    fail('bundle-only coordination archives must not contain content or assets')
  }
  if (entries.length !== admittedPaths.size) fail('archive contains duplicate or undeclared entries')
  for (const entry of entries) if (!admittedPaths.has(entry.path)) fail(`undeclared archive entry: ${JSON.stringify(entry.path)}`)

  const itemsByPath = new Map(manifest.items.map(item => [item.path, item]))
  const files = new Map<string, Uint8Array>()
  const documents = new Map<string, ContentPackDocument>()
  let actualExpanded = manifestBytes.byteLength + (signatureBytes?.byteLength ?? 0)
  for (const file of manifest.files) {
    const entry = entriesByPath.get(file.path)
    if (!entry) fail(`declared file is missing: ${JSON.stringify(file.path)}`)
    const isJson = file.mime === 'application/json'
    const perFileLimit = isJson ? limits.maxJsonBytes : limits.maxRasterBytes
    const boundedLimit = Math.min(perFileLimit, file.bytes, limits.maxExpandedBytes - actualExpanded)
    const bytes = await extractBounded(archiveBytes, entry, boundedLimit)
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) fail(`declared file hash or byte count mismatch: ${JSON.stringify(file.path)}`)
    actualExpanded += bytes.byteLength
    if (!Number.isSafeInteger(actualExpanded) || actualExpanded > limits.maxExpandedBytes) fail('actual expanded archive size exceeds limit')
    if (isJson) {
      const item = itemsByPath.get(file.path)
      if (!item) fail(`declared JSON file has no content item: ${JSON.stringify(file.path)}`)
      let document: ContentPackDocument
      try {
        document = parseContentPackDocument(item.kind, JSON.parse(readText(bytes, file.path)))
      } catch (error) {
        fail(`content document does not match its declared contract (${file.path}: ${error instanceof Error ? error.message : 'unknown error'})`)
      }
      if (document.id !== item.id || document.schema_version !== item.schema_version) fail(`content document identity does not match manifest item: ${JSON.stringify(file.path)}`)
      documents.set(document.id, document)
    } else {
      await decodeRaster(bytes, file.mime, limits, file.path)
    }
    files.set(file.path, bytes)
  }

  const declaredRasters = new Set(manifest.files.filter(file => file.mime !== 'application/json').map(file => file.path))
  const referencedRasters = new Set<string>()
  for (const document of documents.values()) {
    for (const path of referencedRasterPaths(document)) {
      if (!declaredRasters.has(path) || !files.has(path)) fail(`preview asset reference is missing or undeclared: ${JSON.stringify(path)}`)
      referencedRasters.add(path)
    }
  }
  for (const path of declaredRasters) if (!referencedRasters.has(path)) fail(`orphan declared raster asset: ${JSON.stringify(path)}`)
  return { manifest, archiveSha256: sha256(archiveBytes), manifestBytes, documents, files }
}
