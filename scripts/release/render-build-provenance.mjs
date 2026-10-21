import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decodeStrictJson } from '../../electron/server/lib/final-render-strict-json.js'
import {
  parseStoryRenderProvenance,
  readStoryRenderProvenanceFromPackageBytes,
  sameDescriptorPins,
  sameQualificationProvenance,
} from '../../electron/server/lib/final-render-provenance-contract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const MAX_PACKAGE_BYTES = 1024 * 1024
const PRODUCT_APP = 'Story Studio KH.app'

export function readSelectedStoryRenderProvenance(builderBytes) {
  const builder = decodeStrictJson(builderBytes, 'electron-builder.json')
  if (!builder || typeof builder !== 'object' || Array.isArray(builder)
    || !builder.extraMetadata || typeof builder.extraMetadata !== 'object' || Array.isArray(builder.extraMetadata)
    || !Object.hasOwn(builder.extraMetadata, 'storyRenderProvenance')) {
    throw new Error('Build input requires explicit extraMetadata.storyRenderProvenance')
  }
  return parseStoryRenderProvenance(builder.extraMetadata.storyRenderProvenance)
}

export function assertPackagedStoryRenderProvenance(packageBytes, expected) {
  const selected = parseStoryRenderProvenance(expected)
  const actual = readStoryRenderProvenanceFromPackageBytes(packageBytes)
  if (actual === null) throw new Error('New artifact package.json is missing storyRenderProvenance')
  if (actual.format !== selected.format || actual.mode !== selected.mode
    || (actual.descriptors === null || selected.descriptors === null
      ? actual.descriptors !== selected.descriptors
      : !sameDescriptorPins(actual.descriptors, selected.descriptors))
    || (actual.qualification === null || selected.qualification === null
      ? actual.qualification !== selected.qualification
      : !sameQualificationProvenance(actual.qualification, selected.qualification))) {
    throw new Error('Artifact render provenance differs from reviewed build input')
  }
  return actual
}

function command(args) {
  const result = spawnSync('/usr/bin/hdiutil', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`hdiutil ${args[0]} failed: ${result.stderr || result.stdout}`)
}

function archiveHash(archive) {
  const hash = createHash('sha256')
  const fd = fs.openSync(archive, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

function inspectApp(appPath, expected, archiveApi) {
  const archive = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  const disk = fs.lstatSync(archive)
  if (!disk.isFile() || disk.isSymbolicLink()) throw new Error('app.asar must be a regular file')
  // Do not follow ASAR links or allocate package bytes until the entry bound is checked.
  archiveApi.uncache(archive)
  const entry = archiveApi.statFile(archive, 'package.json', false)
  if (!entry || Object.hasOwn(entry, 'link') || Object.hasOwn(entry, 'files') || entry.unpacked
    || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_PACKAGE_BYTES) {
    throw new Error('ASAR package.json must be packed, unlinked and at most 1 MiB')
  }
  const bytes = archiveApi.extractFile(archive, 'package.json', false)
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size || bytes.length > MAX_PACKAGE_BYTES) {
    throw new Error('ASAR package.json size differs from its bounded entry')
  }
  assertPackagedStoryRenderProvenance(bytes, expected)
  return archiveHash(archive)
}

function verifyArtifacts({ appPath, dmgPath, expected }, { archiveApi, run, fixturesRoot }) {
  const selected = parseStoryRenderProvenance(expected)
  const outputHash = inspectApp(appPath, selected, archiveApi)
  fs.mkdirSync(fixturesRoot, { recursive: true, mode: 0o700 })
  const retained = fs.realpathSync(fs.mkdtempSync(path.join(fixturesRoot, 'render-provenance-')))
  fs.chmodSync(retained, 0o700)
  const mount = path.join(retained, 'mount')
  fs.mkdirSync(mount, { mode: 0o700 })
  let attempted = false
  let failure
  let mountedHash
  let detached = false
  try {
    attempted = true
    run(['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.resolve(dmgPath)])
    for (const entry of [PRODUCT_APP, 'Applications', 'READ ME FIRST.txt']) {
      if (!fs.existsSync(path.join(mount, entry))) throw new Error(`DMG does not contain ${entry}`)
    }
    mountedHash = inspectApp(path.join(mount, PRODUCT_APP), selected, archiveApi)
    if (mountedHash !== outputHash) throw new Error('DMG-contained app.asar bytes differ from output app.asar')
  } catch (error) { failure = { error } }
  finally {
    if (attempted) {
      try { run(['detach', mount]); detached = true }
      catch (error) {
        failure = failure
          ? { error: new AggregateError([failure.error, error], 'Artifact inspection and DMG detach failed') }
          : { error }
      }
    }
    const evidence = {
      appPath, dmgPath, outputAsarSha256: outputHash, dmgAsarSha256: mountedHash ?? null,
      attachAttempted: attempted, detached, error: failure ? String(failure.error) : null,
    }
    try { fs.writeFileSync(path.join(retained, 'inspection.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      failure = failure
        ? { error: new AggregateError([failure.error, error], 'Artifact inspection evidence could not be retained') }
        : { error }
    }
    console.log(`[render-provenance] retained inspection evidence: ${retained}`)
  }
  if (failure) throw failure.error
  return Object.freeze({ asarSha256: outputHash, dmgAsarSha256: mountedHash, retained })
}

export function verifyStoryRenderProvenanceArtifacts(options) {
  return verifyArtifacts(options, { archiveApi: asar, run: command, fixturesRoot: path.join(root, '_trash', 'test-fixtures') })
}

// Release-only isolated fixture seam; cannot replace any production singleton or runtime authority.
export function _createStoryRenderArtifactVerifierForTesting({ archiveApi, run, fixturesRoot }) {
  return options => verifyArtifacts(options, { archiveApi, run, fixturesRoot })
}
