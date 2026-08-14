import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import JSZip from 'jszip'
import { register } from 'tsx/esm/api'

const unregisterTsx = register()
const [{ ContentPackDocumentSchema, ContentPackManifestSchema, isBundleOnlyCoordinationManifest }, { verifyContentPackArchive }] = await Promise.all([
  import('../../electron/server/content-packs/schemas.ts'),
  import('../../electron/server/content-packs/archive.ts'),
])
unregisterTsx()

const FIXED_ARCHIVE_DATE = new Date('1980-01-01T00:00:00.000Z')
const SOURCE_ROOT_ENTRIES = new Set(['pack.json', 'content', 'assets'])
const MAX_SOURCE_JSON_BYTES = 1024 * 1024
const MAX_SOURCE_RASTER_BYTES = 15 * 1024 * 1024
const MIN_APP_VERSION_TOKEN = '{{MIN_APP_VERSION}}'
const KEY_ID_TOKEN = '{{KEY_ID}}'

function fail(message) {
  throw new Error(`Content Pack publisher error: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSON values must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort(comparePaths).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  fail('pack.json contains an unsupported value')
}

function mimeForPath(path) {
  if (path.startsWith('content/') && path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.webp')) return 'image/webp'
  return undefined
}

function sourceRelative(root, path) {
  const value = relative(root, path).split(sep).join('/')
  if (value === '') return '.'
  if (value.startsWith('../') || value.includes('/../')) fail('source directory escaped while reading content')
  return value
}

function isSameOrInside(path, root) {
  const remainder = relative(root, path)
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))
}

async function physicalPathForPotentialOutput(path) {
  const missing = []
  let cursor = resolve(path)
  while (true) {
    try {
      const physical = await realpath(cursor)
      return resolve(physical, ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) fail(`cannot resolve output path: ${path}`)
      missing.unshift(basename(cursor))
      cursor = parent
    }
  }
}

async function assertOutputSeparatedFromInputs(sourcePath, privateKeyPath, outputPath) {
  if (outputPath === privateKeyPath) fail('output path must not overwrite the private key')
  if (isSameOrInside(outputPath, sourcePath)) fail('output path must be outside the source directory')
  const sourceStat = await lstat(sourcePath).catch(() => undefined)
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail('source directory must be a real directory')
  const [physicalSource, physicalPrivateKey, physicalOutput] = await Promise.all([
    realpath(sourcePath),
    realpath(privateKeyPath).catch(() => privateKeyPath),
    physicalPathForPotentialOutput(outputPath),
  ])
  if (physicalOutput === physicalPrivateKey) fail('output path must not overwrite the private key')
  if (isSameOrInside(physicalOutput, physicalSource)) fail('output path must be outside the source directory')
}

async function pathsResolveToSameFile(left, right) {
  const [physicalLeft, physicalRight] = await Promise.all([realpath(left), realpath(right)])
  return physicalLeft === physicalRight
}

function nodeIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

function sameNode(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function recordSourceNode(root, path, kind, records) {
  const stat = await lstat(path, { bigint: true }).catch(() => undefined)
  if (!stat || stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    fail(`source ${kind} changed or is not safe: ${sourceRelative(root, path)}`)
  }
  const record = { path, relativePath: sourceRelative(root, path), kind, identity: nodeIdentity(stat) }
  records.push(record)
  return record
}

async function assertSourceRecordIntact(record) {
  const stat = await lstat(record.path, { bigint: true }).catch(() => undefined)
  if (!stat || stat.isSymbolicLink() || (record.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) || !sameNode(record.identity, nodeIdentity(stat))) {
    fail(`source ${record.kind} changed or is not safe: ${record.relativePath}`)
  }
  if (record.kind === 'directory') {
    const children = await readdir(record.path)
    children.sort(comparePaths)
    if (children.length !== record.childNames.length || children.some((child, index) => child !== record.childNames[index])) {
      fail(`source directory children changed: ${record.relativePath}`)
    }
  }
}

async function listFiles(root, directory, records) {
  const absolute = resolve(root, directory)
  const stat = await lstat(absolute).catch(() => undefined)
  if (!stat) return []
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${directory} must be a real directory when present`)
  const files = []
  async function walk(path) {
    const directoryRecord = await recordSourceNode(root, path, 'directory', records)
    const entries = await readdir(path)
    entries.sort(comparePaths)
    directoryRecord.childNames = entries
    for (const entry of entries) {
      const child = resolve(path, entry)
      const stat = await lstat(child, { bigint: true }).catch(() => undefined)
      if (!stat || stat.isSymbolicLink()) fail(`source symlink is not permitted: ${sourceRelative(root, child)}`)
      if (stat.isDirectory()) {
        await walk(child)
      } else if (stat.isFile()) {
        files.push(await recordSourceNode(root, child, 'file', records))
      } else {
        fail(`source special file is not permitted: ${sourceRelative(root, child)}`)
      }
    }
  }
  await walk(absolute)
  return files
}

async function collectSourceFiles(sourceDirectory) {
  const root = resolve(sourceDirectory)
  const rootStat = await lstat(root, { bigint: true }).catch(() => undefined)
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('source directory must be a real directory')
  const records = []
  const rootRecord = await recordSourceNode(root, root, 'directory', records)
  const rootEntries = await readdir(root)
  rootEntries.sort(comparePaths)
  rootRecord.childNames = rootEntries
  let packJson
  const files = []
  for (const name of rootEntries) {
    if (!SOURCE_ROOT_ENTRIES.has(name)) fail(`source file is not declared by pack.json: ${name}`)
    const path = resolve(root, name)
    const stat = await lstat(path, { bigint: true }).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) fail(`source symlink is not permitted: ${name}`)
    if (name === 'pack.json') {
      packJson = await recordSourceNode(root, path, 'file', records)
    } else if (stat.isDirectory()) {
      files.push(...await listFiles(root, name, records))
    } else {
      fail(`source file is not declared by pack.json: ${name}`)
    }
  }
  if (!packJson) fail('source directory requires a regular pack.json')
  files.sort((left, right) => comparePaths(left.relativePath, right.relativePath))
  for (const file of files) if (!mimeForPath(file.relativePath)) fail(`unsupported source file: ${file.relativePath}`)
  return { root, packJson, files, records }
}

function boundedSourceSize(size, limit, path) {
  if (size < 0n || size > BigInt(limit)) fail(`source file exceeds its byte limit: ${path}`)
  return Number(size)
}

async function readBoundedFile(handle, expectedBytes) {
  const buffer = Buffer.allocUnsafe(expectedBytes + 1)
  let bytesRead = 0
  while (bytesRead < buffer.byteLength) {
    const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
    if (result.bytesRead === 0) break
    bytesRead += result.bytesRead
  }
  return buffer.subarray(0, bytesRead)
}

async function snapshotSourceFile(record, onBeforeSourceRead) {
  await assertSourceRecordIntact(record)
  const limit = record.relativePath === 'pack.json' || record.relativePath.startsWith('content/') ? MAX_SOURCE_JSON_BYTES : MAX_SOURCE_RASTER_BYTES
  const expectedBytes = boundedSourceSize(record.identity.size, limit, record.relativePath)
  if (!Number.isInteger(constants.O_NOFOLLOW)) fail('safe no-follow source reads are unavailable on this platform')
  let handle
  try {
    handle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameNode(record.identity, nodeIdentity(before))) fail(`source file changed or is not safe: ${record.relativePath}`)
    await onBeforeSourceRead?.(record)
    const bytes = await readBoundedFile(handle, expectedBytes)
    const after = await handle.stat({ bigint: true })
    if (!sameNode(record.identity, nodeIdentity(after)) || bytes.byteLength !== expectedBytes || BigInt(bytes.byteLength) !== after.size || bytes.byteLength > limit) {
      fail(`source file changed or exceeds its byte limit: ${record.relativePath}`)
    }
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Content Pack publisher error:')) throw error
    fail(`source file cannot be read safely: ${record.relativePath}`)
  } finally {
    await handle?.close()
  }
}

async function assertSourceStable(source) {
  for (const record of source.records) await assertSourceRecordIntact(record)
}

function parsePrivateKey(pem) {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') fail('publisher private key must be an Ed25519 key')
  return key
}

function sourceManifestToArchiveManifest(sourceManifest, items, files) {
  if (Object.prototype.hasOwnProperty.call(sourceManifest, 'items') || Object.prototype.hasOwnProperty.call(sourceManifest, 'files')) {
    fail('pack.json must not declare derived items or files')
  }
  try {
    return ContentPackManifestSchema.parse({ ...sourceManifest, items, files })
  } catch (error) {
    fail(`pack.json does not match the shared Content Pack contract: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function substituteReleaseInputs(sourceManifest, { minAppVersion, keyId }) {
  if (!sourceManifest || typeof sourceManifest !== 'object' || Array.isArray(sourceManifest)) return sourceManifest
  const assertTokenPlacement = (value, path = []) => {
    if (typeof value === 'string') {
      for (const [field, token] of [['min_app_version', MIN_APP_VERSION_TOKEN], ['key_id', KEY_ID_TOKEN]]) {
        if (value.includes(token) && !(path.length === 1 && path[0] === field && value === token)) {
          fail(`pack.json release token ${token} is permitted only as the exact ${field} value`)
        }
      }
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) assertTokenPlacement(child, [...path, key])
  }
  assertTokenPlacement(sourceManifest)
  const manifest = { ...sourceManifest }
  if (manifest.min_app_version === MIN_APP_VERSION_TOKEN) {
    if (!minAppVersion) fail(`pack.json ${MIN_APP_VERSION_TOKEN} requires minAppVersion`)
    manifest.min_app_version = minAppVersion
  }
  if (manifest.key_id === KEY_ID_TOKEN) {
    if (!keyId) fail(`pack.json ${KEY_ID_TOKEN} requires keyId`)
    manifest.key_id = keyId
  }
  assertTokenPlacement(manifest)
  return manifest
}

async function loadSourceManifest(sourceDirectory, onSourceEnumerated, onBeforeSourceRead, releaseInputs) {
  const source = await collectSourceFiles(sourceDirectory)
  await onSourceEnumerated?.(source)
  await assertSourceStable(source)
  const sourceManifestBytes = await snapshotSourceFile(source.packJson, onBeforeSourceRead)
  let sourceManifest
  try {
    sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'))
  } catch (error) {
    fail(`pack.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  sourceManifest = substituteReleaseInputs(sourceManifest, releaseInputs)
  const contentRecords = source.files.filter(file => file.relativePath.startsWith('content/'))
  if (contentRecords.length === 0) {
    const manifest = sourceManifestToArchiveManifest(sourceManifest, [], [])
    if (!isBundleOnlyCoordinationManifest(manifest)) fail('source directory requires at least one content JSON document')
    if (source.files.length !== 0) fail('bundle-only coordination sources must not contain content or assets')
    if (source.records.some(record => record.relativePath === 'content' || record.relativePath === 'assets')) {
      fail('bundle-only coordination sources must contain only pack.json')
    }
    await assertSourceStable(source)
    return { root: source.root, manifest, files: [] }
  }
  const contents = []
  for (const file of contentRecords) {
    const bytes = await snapshotSourceFile(file, onBeforeSourceRead)
    let document
    try {
      document = ContentPackDocumentSchema.parse(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      fail(`content document does not match the shared contract (${file.relativePath}: ${error instanceof Error ? error.message : String(error)})`)
    }
    contents.push({ path: file.relativePath, bytes, document })
  }
  const otherFiles = []
  for (const file of source.files.filter(file => file.relativePath.startsWith('assets/'))) {
    otherFiles.push({ path: file.relativePath, bytes: await snapshotSourceFile(file, onBeforeSourceRead) })
  }
  await assertSourceStable(source)
  const allFiles = [...contents, ...otherFiles].sort((left, right) => comparePaths(left.path, right.path))
  const items = contents.map(({ path, document }) => ({
    id: document.id,
    kind: document.kind,
    schema_version: document.schema_version,
    path,
  })).sort((left, right) => comparePaths(left.path, right.path))
  const files = allFiles.map(({ path, bytes }) => ({
    path,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    mime: mimeForPath(path),
  }))
  return { root: source.root, manifest: sourceManifestToArchiveManifest(sourceManifest, items, files), files: allFiles }
}

async function deterministicArchive(manifestBytes, signatureBytes, files) {
  const archive = new JSZip()
  const options = { date: FIXED_ARCHIVE_DATE, createFolders: false, unixPermissions: 0o100644 }
  archive.file('manifest.json', manifestBytes, options)
  archive.file('signature.ed25519', signatureBytes, options)
  for (const file of files) archive.file(file.path, file.bytes, options)
  return archive.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
    comment: '',
  })
}

async function writeOutput(path, bytes) {
  const output = resolve(path)
  const outputDirectory = dirname(output)
  await mkdir(outputDirectory, { recursive: true })
  const temporary = resolve(outputDirectory, `.${basename(output)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try {
      // link(2) creates the final name only when it does not already exist. Unlike
      // rename(2), it can never replace a previously published archive.
      await link(temporary, output)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail('output path already exists; immutable published artifacts require a new version and output path')
      }
      throw error
    }
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function buildContentPack({ sourceDirectory, privateKeyPath, outputPath, minAppVersion, keyId, onSourceEnumerated, onBeforeSourceRead, onBeforeOutputCommit }) {
  if (!sourceDirectory || !privateKeyPath || !outputPath) fail('source directory, private key, and output path are required')
  const sourcePath = resolve(sourceDirectory)
  const privateKey = resolve(privateKeyPath)
  const output = resolve(outputPath)
  await assertOutputSeparatedFromInputs(sourcePath, privateKey, output)
  const privateKeyObject = parsePrivateKey(await readFile(privateKey, 'utf8'))
  const source = await loadSourceManifest(sourcePath, onSourceEnumerated, onBeforeSourceRead, { minAppVersion, keyId })
  const manifestBytes = Buffer.from(canonicalJson(source.manifest), 'utf8')
  const signatureBytes = sign(null, manifestBytes, privateKeyObject)
  const archiveBytes = await deterministicArchive(manifestBytes, signatureBytes, source.files)
  const publicKeyPem = createPublicKey(privateKeyObject).export({ type: 'spki', format: 'pem' }).toString()
  const verified = await verifyContentPackArchive(archiveBytes, {
    publisherKeys: new Map([[source.manifest.key_id, { publisherId: source.manifest.publisher_id, publicKeyPem }]]),
  })
  await assertOutputSeparatedFromInputs(sourcePath, privateKey, output)
  await onBeforeOutputCommit?.()
  const writtenOutput = await writeOutput(output, archiveBytes)
  return {
    output: writtenOutput,
    packId: verified.manifest.pack_id,
    version: verified.manifest.version,
    sha256: sha256(archiveBytes),
  }
}

export async function validateContentPack({ archivePath, keyId, publisherId, publicKeyPath }) {
  if (!archivePath || !keyId || !publisherId || !publicKeyPath) fail('archive path, key ID, publisher ID, and public key path are required')
  const archive = resolve(archivePath)
  const publicKey = resolve(publicKeyPath)
  if (archive === publicKey || await pathsResolveToSameFile(archive, publicKey)) fail('archive path must not be the public key path')
  const archiveBytes = await readFile(archive)
  const publicKeyPem = await readFile(publicKey, 'utf8')
  const verified = await verifyContentPackArchive(archiveBytes, {
    publisherKeys: new Map([[keyId, { publisherId, publicKeyPem }]]),
  })
  return {
    packId: verified.manifest.pack_id,
    version: verified.manifest.version,
    sha256: sha256(archiveBytes),
  }
}

export function parseOptions(argv, requiredPositionals, flags) {
  const positionals = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    if (!flags.includes(argument)) fail(`unknown option: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`option requires a value: ${argument}`)
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (Object.prototype.hasOwnProperty.call(options, key)) fail(`option may be supplied once: ${argument}`)
    options[key] = value
    index += 1
  }
  if (positionals.length !== requiredPositionals) fail(`expected ${requiredPositionals} positional argument${requiredPositionals === 1 ? '' : 's'}`)
  return { positionals, options }
}

export function report(result) {
  process.stdout.write(`Content Pack ${result.packId} ${result.version} sha256=${result.sha256}\n`)
}

export function reportError(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
}
