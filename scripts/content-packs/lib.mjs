import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import JSZip from 'jszip'
import { register } from 'tsx/esm/api'

const unregisterTsx = register()
const [{ ContentPackDocumentSchema, ContentPackManifestSchema }, { verifyContentPackArchive }] = await Promise.all([
  import('../../electron/server/content-packs/schemas.ts'),
  import('../../electron/server/content-packs/archive.ts'),
])
unregisterTsx()

const FIXED_ARCHIVE_DATE = new Date('1980-01-01T00:00:00.000Z')
const SOURCE_ROOT_ENTRIES = new Set(['pack.json', 'content', 'assets'])

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

async function readJson(path, label) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sourceRelative(root, path) {
  const value = relative(root, path).split(sep).join('/')
  if (!value || value.startsWith('../') || value.includes('/../')) fail('source directory escaped while reading content')
  return value
}

async function listFiles(root, directory) {
  const absolute = resolve(root, directory)
  const stat = await lstat(absolute).catch(() => undefined)
  if (!stat) return []
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${directory} must be a real directory when present`)
  const files = []
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => comparePaths(left.name, right.name))
    for (const entry of entries) {
      const child = resolve(path, entry.name)
      if (entry.isSymbolicLink()) fail(`source symlink is not permitted: ${sourceRelative(root, child)}`)
      if (entry.isDirectory()) {
        await walk(child)
      } else if (entry.isFile()) {
        files.push(sourceRelative(root, child))
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
  const rootStat = await lstat(root).catch(() => undefined)
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('source directory must be a real directory')
  const rootEntries = await readdir(root, { withFileTypes: true })
  for (const entry of rootEntries) {
    if (!SOURCE_ROOT_ENTRIES.has(entry.name)) fail(`source file is not declared by pack.json: ${entry.name}`)
    if (entry.isSymbolicLink()) fail(`source symlink is not permitted: ${entry.name}`)
  }
  const packJson = rootEntries.find(entry => entry.name === 'pack.json')
  if (!packJson?.isFile()) fail('source directory requires a regular pack.json')
  const files = [...await listFiles(root, 'assets'), ...await listFiles(root, 'content')].sort(comparePaths)
  for (const file of files) if (!mimeForPath(file)) fail(`unsupported source file: ${file}`)
  if (!files.some(file => file.startsWith('content/'))) fail('source directory requires at least one content JSON document')
  return { root, files }
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

async function loadSourceManifest(sourceDirectory) {
  const source = await collectSourceFiles(sourceDirectory)
  const sourceManifest = await readJson(resolve(source.root, 'pack.json'), 'pack.json')
  const contents = []
  for (const path of source.files.filter(file => file.startsWith('content/'))) {
    const bytes = await readFile(resolve(source.root, path))
    let document
    try {
      document = ContentPackDocumentSchema.parse(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      fail(`content document does not match the shared contract (${path}: ${error instanceof Error ? error.message : String(error)})`)
    }
    contents.push({ path, bytes, document })
  }
  const otherFiles = []
  for (const path of source.files.filter(file => file.startsWith('assets/'))) {
    otherFiles.push({ path, bytes: await readFile(resolve(source.root, path)) })
  }
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
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  await rm(temporary, { force: true })
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, output)
  return output
}

export async function buildContentPack({ sourceDirectory, privateKeyPath, outputPath }) {
  if (!sourceDirectory || !privateKeyPath || !outputPath) fail('source directory, private key, and output path are required')
  const privateKey = parsePrivateKey(await readFile(resolve(privateKeyPath), 'utf8'))
  const source = await loadSourceManifest(sourceDirectory)
  const manifestBytes = Buffer.from(canonicalJson(source.manifest), 'utf8')
  const signatureBytes = sign(null, manifestBytes, privateKey)
  const archiveBytes = await deterministicArchive(manifestBytes, signatureBytes, source.files)
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  const verified = await verifyContentPackArchive(archiveBytes, {
    publisherKeys: new Map([[source.manifest.key_id, { publisherId: source.manifest.publisher_id, publicKeyPem }]]),
  })
  const output = await writeOutput(outputPath, archiveBytes)
  return {
    output,
    packId: verified.manifest.pack_id,
    version: verified.manifest.version,
    sha256: sha256(archiveBytes),
  }
}

export async function validateContentPack({ archivePath, keyId, publisherId, publicKeyPath }) {
  if (!archivePath || !keyId || !publisherId || !publicKeyPath) fail('archive path, key ID, publisher ID, and public key path are required')
  const archiveBytes = await readFile(resolve(archivePath))
  const publicKeyPem = await readFile(resolve(publicKeyPath), 'utf8')
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
