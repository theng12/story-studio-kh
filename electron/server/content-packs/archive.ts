import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import sharp from 'sharp'

import { parseContentPackDocument, parseContentPackManifest } from './schemas.js'
import { verifyEd25519Signature } from './signature.js'
import type { ContentPackDocument, ContentPackManifest } from './types.js'

const MEBIBYTE = 1024 * 1024

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
  maxJsonBytes: 1 * MEBIBYTE,
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
  /** Exact bytes that were signed; never reserialized before verification. */
  manifestBytes: Uint8Array
  documents: ReadonlyMap<string, ContentPackDocument>
  /** Verified declared content and asset bytes. The installer decides whether to persist them. */
  files: ReadonlyMap<string, Uint8Array>
}

interface ZipCentralEntry {
  path: string
  compressedBytes: number
  expandedBytes: number
}

function fail(message: string): never {
  throw new Error(`Invalid content-pack archive: ${message}`)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
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
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail(`unsafe archive path: ${JSON.stringify(path)}`)
  }
  const canonical = path.normalize('NFC').toLocaleLowerCase('en-US')
  if (seen.has(canonical)) fail(`normalized path collision: ${JSON.stringify(path)}`)
  seen.add(canonical)
}

/**
 * Read the ZIP central directory directly before JSZip gets a chance to normalize
 * names. This preserves duplicate and zip-slip evidence that JSZip deliberately
 * sanitizes for ordinary consumers.
 */
function inspectZipCentralDirectory(archiveBytes: Uint8Array, limits: ContentPackArchiveLimits): ZipCentralEntry[] {
  if (archiveBytes.byteLength > limits.maxArchiveBytes) fail(`archive exceeds ${limits.maxArchiveBytes} byte limit`)
  if (archiveBytes.byteLength < 22) fail('missing ZIP end-of-central-directory record')

  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength)
  const eocdStart = Math.max(0, archiveBytes.byteLength - 22 - 0xffff)
  let eocdOffset = -1
  for (let offset = archiveBytes.byteLength - 22; offset >= eocdStart; offset -= 1) {
    if (readU32(view, offset) === 0x06054b50 && offset + 22 + readU16(view, offset + 20) === archiveBytes.byteLength) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) fail('missing ZIP end-of-central-directory record')

  const diskNumber = readU16(view, eocdOffset + 4)
  const centralDirectoryDisk = readU16(view, eocdOffset + 6)
  const entriesOnDisk = readU16(view, eocdOffset + 8)
  const entryCount = readU16(view, eocdOffset + 10)
  const centralDirectoryBytes = readU32(view, eocdOffset + 12)
  const centralDirectoryOffset = readU32(view, eocdOffset + 16)
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) fail('multi-disk ZIP archives are not permitted')
  if (entryCount === 0xffff || centralDirectoryBytes === 0xffffffff || centralDirectoryOffset === 0xffffffff) fail('ZIP64 archives are not permitted')
  if (entryCount > limits.maxEntries) fail(`archive entry limit exceeded (${entryCount} > ${limits.maxEntries})`)
  if (centralDirectoryOffset + centralDirectoryBytes > eocdOffset) fail('central directory lies outside the archive')

  const entries: ZipCentralEntry[] = []
  const seenPaths = new Set<string>()
  let offset = centralDirectoryOffset
  let totalExpanded = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || readU32(view, offset) !== 0x02014b50) fail('malformed central directory entry')
    const madeBy = readU16(view, offset + 4)
    const flags = readU16(view, offset + 8)
    const compression = readU16(view, offset + 10)
    const compressedBytes = readU32(view, offset + 20)
    const expandedBytes = readU32(view, offset + 24)
    const pathLength = readU16(view, offset + 28)
    const extraLength = readU16(view, offset + 30)
    const commentLength = readU16(view, offset + 32)
    const diskStart = readU16(view, offset + 34)
    const externalAttributes = readU32(view, offset + 38)
    const localHeaderOffset = readU32(view, offset + 42)
    const end = offset + 46 + pathLength + extraLength + commentLength
    if (end > eocdOffset || localHeaderOffset >= centralDirectoryOffset) fail('central directory entry points outside archive data')
    if (flags & 0x1) fail('encrypted ZIP entries are not permitted')
    if (compression !== 0 && compression !== 8) fail('unsupported ZIP compression method')
    if (diskStart !== 0) fail('split ZIP entries are not permitted')
    if (compressedBytes === 0xffffffff || expandedBytes === 0xffffffff || localHeaderOffset === 0xffffffff) fail('ZIP64 entries are not permitted')

    const path = decodePath(archiveBytes.subarray(offset + 46, offset + 46 + pathLength), Boolean(flags & 0x800))
    assertSafePath(path, seenPaths)
    const unixMode = (externalAttributes >>> 16) & 0xf000
    const madeByUnix = (madeBy >>> 8) === 3
    if ((madeByUnix && unixMode === 0xa000) || (externalAttributes & 0x10) !== 0) fail(`symlink or directory entry is not permitted: ${JSON.stringify(path)}`)

    totalExpanded += expandedBytes
    if (!Number.isSafeInteger(totalExpanded) || totalExpanded > limits.maxExpandedBytes) {
      fail(`expanded archive size exceeds ${limits.maxExpandedBytes} byte limit`)
    }
    entries.push({ path, compressedBytes, expandedBytes })
    offset = end
  }
  if (offset !== centralDirectoryOffset + centralDirectoryBytes) fail('central directory size mismatch')
  return entries
}

function readText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${label} is not valid UTF-8`)
  }
}

async function decodeRaster(bytes: Uint8Array, mime: string, limits: ContentPackArchiveLimits, path: string): Promise<void> {
  try {
    const image = sharp(bytes, { failOn: 'error' })
    const metadata = await image.metadata()
    await image.stats()
    const formatMime = metadata.format === 'png' ? 'image/png'
      : metadata.format === 'jpeg' ? 'image/jpeg'
        : metadata.format === 'webp' ? 'image/webp'
          : undefined
    if (!metadata.width || !metadata.height || formatMime !== mime) fail(`raster MIME does not match decoded content: ${JSON.stringify(path)}`)
    if (metadata.width * metadata.height > limits.maxRasterPixels) fail(`raster pixel limit exceeded: ${JSON.stringify(path)}`)
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

export async function verifyContentPackArchive(
  archiveBytes: Uint8Array,
  policy: ContentPackVerificationPolicy,
): Promise<VerifiedContentPack> {
  const limits = limitsFor(policy)
  const centralEntries = inspectZipCentralDirectory(archiveBytes, limits)
  const centralByPath = new Map(centralEntries.map(entry => [entry.path, entry]))
  const manifestCentral = centralByPath.get('manifest.json')
  const signatureCentral = centralByPath.get('signature.ed25519')
  if (!manifestCentral || !signatureCentral) fail('manifest.json and signature.ed25519 are required')
  if (manifestCentral.expandedBytes > limits.maxJsonBytes) fail('manifest.json exceeds JSON byte limit')
  if (signatureCentral.expandedBytes > limits.maxSignatureBytes) fail('signature.ed25519 exceeds signature byte limit')

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true, createFolders: false })
  } catch {
    fail('ZIP payload is corrupt')
  }
  if (Object.keys(zip.files).length !== centralEntries.length) fail('archive entries changed during ZIP parsing')
  const manifestFile = zip.file('manifest.json')
  const signatureFile = zip.file('signature.ed25519')
  if (!manifestFile || !signatureFile || manifestFile.dir || signatureFile.dir) fail('manifest.json and signature.ed25519 must be regular files')
  const manifestBytes = await manifestFile.async('uint8array')
  const signatureBytes = await signatureFile.async('uint8array')
  if (signatureBytes.byteLength !== 64) fail('signature.ed25519 must be a 64-byte Ed25519 signature')

  let manifest: ContentPackManifest
  try {
    manifest = parseContentPackManifest(JSON.parse(readText(manifestBytes, 'manifest.json')))
  } catch (error) {
    fail(`manifest.json does not match the Content Pack contract (${error instanceof Error ? error.message : 'unknown error'})`)
  }
  const key = policy.publisherKeys.get(manifest.key_id)
  if (!key) fail(`unknown publisher key: ${manifest.key_id}`)
  if (key.publisherId !== manifest.publisher_id) fail('publisher key does not match manifest publisher')
  if (!verifyEd25519Signature(manifestBytes, signatureBytes, key.publicKeyPem)) fail('manifest signature verification failed')

  const declaredPaths = new Set(manifest.files.map(file => file.path))
  const admittedPaths = new Set(['manifest.json', 'signature.ed25519', ...declaredPaths])
  if (centralEntries.length !== admittedPaths.size) fail('archive contains duplicate or undeclared entries')
  for (const entry of centralEntries) {
    if (!admittedPaths.has(entry.path)) fail(`undeclared archive entry: ${JSON.stringify(entry.path)}`)
  }

  const itemsByPath = new Map(manifest.items.map(item => [item.path, item]))
  const files = new Map<string, Uint8Array>()
  const documents = new Map<string, ContentPackDocument>()
  for (const file of manifest.files) {
    const central = centralByPath.get(file.path)
    const zipFile = zip.file(file.path)
    if (!central || !zipFile || zipFile.dir) fail(`declared file is missing: ${JSON.stringify(file.path)}`)
    const isJson = file.mime === 'application/json'
    const perFileLimit = isJson ? limits.maxJsonBytes : limits.maxRasterBytes
    if (central.expandedBytes > perFileLimit) fail(`declared file exceeds byte limit: ${JSON.stringify(file.path)}`)
    if (central.expandedBytes !== file.bytes) fail(`declared file byte count mismatch: ${JSON.stringify(file.path)}`)
    const bytes = await zipFile.async('uint8array')
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) fail(`declared file hash or byte count mismatch: ${JSON.stringify(file.path)}`)
    if (isJson) {
      const item = itemsByPath.get(file.path)
      if (!item) fail(`declared JSON file has no content item: ${JSON.stringify(file.path)}`)
      let document: ContentPackDocument
      try {
        document = parseContentPackDocument(item.kind, JSON.parse(readText(bytes, file.path)))
      } catch (error) {
        fail(`content document does not match its declared contract (${file.path}: ${error instanceof Error ? error.message : 'unknown error'})`)
      }
      if (document.id !== item.id || document.schema_version !== item.schema_version) {
        fail(`content document identity does not match manifest item: ${JSON.stringify(file.path)}`)
      }
      documents.set(document.id, document)
    } else {
      await decodeRaster(bytes, file.mime, limits, file.path)
    }
    files.set(file.path, bytes)
  }

  return { manifest, manifestBytes, documents, files }
}
