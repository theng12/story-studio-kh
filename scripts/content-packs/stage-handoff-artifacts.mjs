import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { validateContentPack } from './lib.mjs'

const DELIVERY_PROFILE = 'genstudio-store-receipt-v1'
const MIN_APP_VERSION = '1.0.843'
const MAX_ARCHIVE_BYTES = 52_428_800
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256 = /^[a-f0-9]{64}$/
const RECEIPT = /^authoring:[a-f0-9]{64}$/
const WAVE_RECEIPT = 'authoring:bd4d3d8938cee8b2191379c5912cbbc5d848daa36bf6f7ca28f870c1359a2728'
const WAVE_BINDINGS = {
  'question-ladder': {
    pack_id: 'com.storystudio.pack.formula.question-ladder',
    item_id: 'com.storystudio.formula.question-ladder',
    version: '1.0.0',
    kind: 'series-formula',
    source_path: 'content-packs/reusable-primitives/formula/question-ladder',
  },
  'audience-question-seeder': {
    pack_id: 'com.storystudio.pack.topic.audience-question-seeder',
    item_id: 'com.storystudio.topic.audience-question-seeder',
    version: '1.0.0',
    kind: 'topic-pack',
    source_path: 'content-packs/reusable-primitives/topic/audience-question-seeder',
  },
  'before-after-timeline': {
    pack_id: 'com.storystudio.pack.formula.before-after-timeline',
    item_id: 'com.storystudio.formula.before-after-timeline',
    version: '1.0.0',
    kind: 'series-formula',
    source_path: 'content-packs/reusable-primitives/formula/before-after-timeline',
  },
  'object-hero-question': {
    pack_id: 'com.storystudio.pack.thumbnail.object-hero-question',
    item_id: 'com.storystudio.thumbnail.object-hero-question',
    version: '1.0.0',
    kind: 'thumbnail-recipe',
    source_path: 'content-packs/reusable-primitives/thumbnail/object-hero-question',
  },
  'route-map-one-promise': {
    pack_id: 'com.storystudio.pack.thumbnail.route-map-one-promise',
    item_id: 'com.storystudio.thumbnail.route-map-one-promise',
    version: '1.0.0',
    kind: 'thumbnail-recipe',
    source_path: 'content-packs/reusable-primitives/thumbnail/route-map-one-promise',
  },
}
const FIXED_WAVE_SLUGS = Object.keys(WAVE_BINDINGS)
const REQUIRED_REVIEWS = [
  'schema',
  'originality-provenance',
  'compatibility',
  'prompt-equivalence',
  'safety',
  'copy',
  'commercial-boundary',
]
const EXPLICITLY_NOT_DONE = [
  'upload',
  'product-or-release-draft-creation',
  'price-or-discount-decision',
  'purchase',
  'grant',
  'publication',
  'production-signing',
  'deploy',
  'push',
]

function fail(message) {
  throw new Error(`Handoff staging: ${message}`)
}

function isContained(parent, child) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function uniqueSlugs(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`)
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || !SLUG.test(value)) fail(`${label} contains an invalid slug`)
    if (seen.has(value)) fail(`${label} contains duplicate slug ${value}`)
    seen.add(value)
  }
  return seen
}

function exactSet(actual, expected, label) {
  if (actual.size !== expected.size || [...actual].some(value => !expected.has(value))) {
    fail(`${label} does not match the required slug partition`)
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(`${label} must be a plain object`)
  }
}

function assertNoSummary(value, label) {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value) && Object.hasOwn(value, 'component_summary')) fail(`${label} must not contain component_summary`)
  for (const child of Object.values(value)) assertNoSummary(child, label)
}

function validateSummary(value, label) {
  assertPlainObject(value, label)
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify(['kind', 'schema_version', 'slots', 'summary'])) fail(`${label} has invalid fields`)
  if (value.schema_version !== 1 || typeof value.kind !== 'string' || !value.kind
    || typeof value.summary !== 'string' || !value.summary.trim()) fail(`${label} is incomplete`)
  assertPlainObject(value.slots, `${label}.slots`)
  if (Object.keys(value.slots).length !== 1 || Object.values(value.slots)[0] !== 1) fail(`${label}.slots must declare one component`)
}

function validateReviews(reviews, kind, label) {
  if (!Array.isArray(reviews)) fail(`${label} reviews must be an array`)
  const names = new Set()
  for (const result of reviews) {
    assertPlainObject(result, `${label} review`)
    if (typeof result.review !== 'string' || names.has(result.review)) fail(`${label} reviews must have unique names`)
    if (result.status !== 'passed') fail(`${label} review ${result.review} is incomplete`)
    names.add(result.review)
  }
  for (const required of REQUIRED_REVIEWS) {
    if (!names.has(required)) fail(`${label} missing required review ${required}`)
  }
  if (kind === 'thumbnail-recipe') {
    for (const required of ['visual', 'thumbnail']) {
      if (!names.has(required)) fail(`${label} missing required review ${required}`)
    }
  }
}

function validateCollections({ allowedSlugs, eligibleSlugs, entries, blockedEntries }) {
  const allowed = uniqueSlugs(allowedSlugs, 'allowedSlugs')
  if (JSON.stringify(allowedSlugs) !== JSON.stringify(FIXED_WAVE_SLUGS)) {
    fail('allowedSlugs must equal the exact fixed Wave 2 slug order')
  }
  const eligible = uniqueSlugs(eligibleSlugs, 'eligibleSlugs')
  for (const slug of eligible) if (!allowed.has(slug)) fail(`eligible slug ${slug} is outside allowedSlugs`)
  if (!Array.isArray(entries) || !Array.isArray(blockedEntries)) fail('entries and blockedEntries must be arrays')
  const entrySlugs = uniqueSlugs(entries.map(entry => entry?.slug), 'entries')
  const blockedSlugs = uniqueSlugs(blockedEntries.map(entry => entry?.slug), 'blockedEntries')
  exactSet(entrySlugs, eligible, 'entries')
  const complement = new Set([...allowed].filter(slug => !eligible.has(slug)))
  exactSet(blockedSlugs, complement, 'blockedEntries')
  for (const slug of eligible) if (blockedSlugs.has(slug)) fail(`eligible slug ${slug} overlaps blockedEntries`)
  for (const entry of blockedEntries) {
    assertPlainObject(entry, `blocked entry ${entry?.slug ?? ''}`)
    if (Object.keys(entry).sort().join(',') !== 'blocker,slug') fail(`blocked entry ${entry.slug} must contain exactly slug and blocker`)
    if (typeof entry.blocker !== 'string' || !entry.blocker.trim()) fail(`blocked entry ${entry.slug} requires a blocker`)
    assertNoSummary(entry, `blocked entry ${entry.slug}`)
  }
  return { allowed, eligible }
}

async function assertNoSymlinkAncestry(path, label, requireFinalDirectory = true) {
  const absolute = resolve(path)
  const root = absolute.slice(0, absolute.indexOf(sep) + 1) || sep
  const segments = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code === 'ENOENT' && !requireFinalDirectory && index === segments.length - 1) return
      fail(`${label} ancestry must already exist as real directories`)
    }
    // macOS exposes its test temp root through the system-owned /var -> /private/var
    // alias. Accept only aliases above tmpdir itself; caller-controlled aliases at or
    // below the candidate/destination parent remain forbidden.
    const permittedSystemTempAlias = info.isSymbolicLink() && isContained(current, resolve(tmpdir()))
    if (info.isSymbolicLink() && !permittedSystemTempAlias) {
      fail(`${label} ancestry must not contain a symlink`)
    }
    if (index < segments.length - 1 || requireFinalDirectory) {
      if (!info.isDirectory() && !permittedSystemTempAlias) fail(`${label} ancestry must contain only directories`)
    }
  }
}

async function mustBeAbsent(path, label) {
  try {
    await lstat(path)
    fail(`${label} already exists`)
  } catch (error) {
    if (error?.message?.startsWith('Handoff staging:')) throw error
    if (error?.code !== 'ENOENT') throw error
  }
}

async function snapshotDirectory(path, label) {
  await assertNoSymlinkAncestry(path, label)
  const [info, physical] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path),
  ])
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory`)
  return { path, label, physical, dev: info.dev, ino: info.ino }
}

async function assertDirectoryUnchanged(expected) {
  await assertNoSymlinkAncestry(expected.path, expected.label)
  const [current, physical] = await Promise.all([
    lstat(expected.path, { bigint: true }).catch(() => undefined),
    realpath(expected.path).catch(() => undefined),
  ])
  if (!current || !current.isDirectory() || current.isSymbolicLink()
    || current.dev !== expected.dev || current.ino !== expected.ino || physical !== expected.physical) {
    fail(`${expected.label} was replaced or its ancestry changed`)
  }
}

function ownedPath(path, parent, info) {
  return { path, parent, dev: info.dev, ino: info.ino }
}

async function unlinkOwned(owned) {
  await assertDirectoryUnchanged(owned.parent)
  const current = await lstat(owned.path, { bigint: true }).catch(() => undefined)
  if (!current || !current.isFile() || current.isSymbolicLink()
    || current.dev !== owned.dev || current.ino !== owned.ino) {
    fail(`owned path ${owned.path} was replaced before cleanup`)
  }
  await unlink(owned.path)
}

function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function openStableRegular(path, label) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    fail(`${label} must be a regular non-symlink file`)
  }
  const before = await handle.stat({ bigint: true })
  if (!before.isFile()) {
    await handle.close()
    fail(`${label} must be a regular non-symlink file`)
  }
  const pathInfo = await lstat(path, { bigint: true }).catch(() => undefined)
  if (!pathInfo || pathInfo.isSymbolicLink() || !pathInfo.isFile()
    || pathInfo.dev !== before.dev || pathInfo.ino !== before.ino) {
    await handle.close()
    fail(`${label} path was replaced or is a symlink`)
  }
  return { handle, before }
}

async function hashHandle(handle, maximum = MAX_ARCHIVE_BYTES) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
    if (bytesRead === 0) break
    bytes += bytesRead
    if (bytes > maximum) fail(`archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
    hash.update(buffer.subarray(0, bytesRead))
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function verifyStableEvidence(path, declared, candidatePhysical) {
  const physical = await realpath(path).catch(() => fail(`${declared.slug} candidate must exist`))
  if (!isContained(candidatePhysical, physical) || physical === candidatePhysical) fail(`${declared.slug} candidate escapes candidateRoot`)
  const { handle, before } = await openStableRegular(path, `${declared.slug} candidate`)
  try {
    const measured = await hashHandle(handle)
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after) || after.size !== BigInt(measured.bytes)) fail(`${declared.slug} candidate changed while being read`)
    const current = await lstat(path, { bigint: true }).catch(() => undefined)
    if (!current || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) fail(`${declared.slug} candidate path was replaced`)
    if (measured.bytes !== declared.bytes) fail(`${declared.slug} candidate byte count differs from declared evidence`)
    if (measured.sha256 !== declared.sha256) fail(`${declared.slug} candidate SHA-256 digest differs from declared evidence`)
    return measured
  } finally {
    await handle.close()
  }
}

async function copyStable(sourcePath, destinationPath, declared, onDestinationCreated, afterSourceOpened) {
  const source = await openStableRegular(sourcePath, `${declared.slug} source`)
  let destination
  try {
    await afterSourceOpened?.({ path: sourcePath, destination: destinationPath })
    destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await onDestinationCreated?.(destinationPath, await destination.stat({ bigint: true }))
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let bytes = 0
    while (true) {
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, bytes)
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, bytes + written)
        if (result.bytesWritten === 0) fail(`${declared.slug} copy made no progress`)
        written += result.bytesWritten
      }
      hash.update(buffer.subarray(0, bytesRead))
      bytes += bytesRead
      if (bytes > MAX_ARCHIVE_BYTES) fail(`${declared.slug} archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
    }
    await destination.sync()
    const after = await source.handle.stat({ bigint: true })
    if (!sameSnapshot(source.before, after) || after.size !== BigInt(bytes)) fail(`${declared.slug} source changed while being copied`)
    const measured = { bytes, sha256: hash.digest('hex') }
    if (measured.bytes !== declared.bytes || measured.sha256 !== declared.sha256) fail(`${declared.slug} copied bytes differ from declared evidence`)
    return measured
  } finally {
    await Promise.allSettled([source.handle.close(), destination?.close()])
  }
}

async function writeExclusive(path, bytes, mode = 0o600, onCreated) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    await onCreated?.(path, await handle.stat({ bigint: true }))
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset)
      if (bytesWritten === 0) fail(`write made no progress for ${path}`)
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeJsonExclusive(path, value, onCreated) {
  assertNoSummary(path.endsWith('ledger.json') ? value : null, 'ledger')
  await writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`, 0o600, onCreated)
}

async function readJsonStable(path, label) {
  const { handle, before } = await openStableRegular(path, label)
  try {
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after) || after.size !== BigInt(bytes.byteLength)) fail(`${label} changed while being read`)
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    await handle.close()
  }
}

async function pathInventory(root) {
  const paths = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      paths.push(path)
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
  return paths.sort()
}

async function cleanupCreated(paths, stagingRoot, stagingGuard) {
  const failures = []
  for (const owned of [...paths].reverse()) {
    try {
      await unlinkOwned(owned)
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push({ path: owned.path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  try {
    if (stagingGuard) {
      await assertDirectoryUnchanged(stagingGuard)
      await rmdir(stagingRoot)
    }
  } catch (error) {
    failures.push({ path: stagingRoot, error: error instanceof Error ? error.message : String(error) })
  }
  return failures
}

function validateEntry(entry) {
  assertPlainObject(entry, `entry ${entry?.slug ?? ''}`)
  const binding = WAVE_BINDINGS[entry.slug]
  if (!binding) fail(`${entry.slug} is not a fixed Wave 2 slug`)
  for (const field of ['pack_id', 'item_id', 'version', 'source_path']) {
    if (entry[field] !== binding[field]) fail(`${entry.slug} ${field} does not match its fixed Wave 2 binding`)
  }
  if (typeof entry.candidate_path !== 'string' || !isAbsolute(entry.candidate_path)) fail(`${entry.slug} candidate_path must be absolute`)
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_ARCHIVE_BYTES) fail(`${entry.slug} has an invalid byte count`)
  if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) fail(`${entry.slug} has an invalid SHA-256 digest`)
  if (entry.min_app_version !== MIN_APP_VERSION) fail(`${entry.slug} min_app_version must be ${MIN_APP_VERSION}`)
  if (entry.delivery_profile !== DELIVERY_PROFILE) fail(`${entry.slug} delivery profile must be ${DELIVERY_PROFILE}`)
  if (typeof entry.receipt_ref !== 'string' || !RECEIPT.test(entry.receipt_ref) || entry.receipt_ref !== WAVE_RECEIPT) {
    fail(`${entry.slug} receipt_ref does not match the exact Wave 2 reservation`)
  }
  validateSummary(entry.component_summary, `${entry.slug} component_summary`)
  if (entry.component_summary.kind !== binding.kind) fail(`${entry.slug} summary kind does not match its fixed Wave 2 binding`)
  validateReviews(entry.reviews, entry.component_summary.kind, entry.slug)
}

async function validateBoundArchive(entry, archivePath) {
  const binding = WAVE_BINDINGS[entry.slug]
  const verified = await validateContentPack({
    archivePath,
    deliveryProfile: DELIVERY_PROFILE,
    includeManifest: true,
  })
  const manifest = verified.manifest
  if (verified.packId !== binding.pack_id || verified.version !== binding.version || verified.sha256 !== entry.sha256
    || manifest.pack_id !== binding.pack_id || manifest.version !== binding.version
    || manifest.publisher_id !== 'com.storystudio' || manifest.min_app_version !== MIN_APP_VERSION
    || manifest.delivery_profile !== DELIVERY_PROFILE
    || JSON.stringify(manifest.dependencies ?? []) !== '[]'
    || manifest.items.length !== 1 || manifest.items[0].id !== binding.item_id
    || manifest.items[0].kind !== binding.kind) {
    fail(`${entry.slug} archive identity or manifest contract does not match its fixed Wave 2 binding`)
  }
  return verified
}

/**
 * Copy explicitly qualified candidate archives to fresh, external handoff destinations.
 * The helper is intentionally fail-closed and never infers eligibility from filesystem state.
 * Directory identities are revalidated around controlled boundaries, but this is not a
 * filesystem-wide atomic transaction: Node does not expose dirfd-relative openat/renameat
 * primitives here, so a hostile swap in the final check-to-open instruction window remains
 * a residual platform limitation and restart still fails closed on existing destinations.
 */
export async function stageHandoffArtifacts(input, { afterPhase } = {}) {
  assertPlainObject(input, 'input')
  const {
    repositoryRoot,
    candidateRoot,
    artifactRoot,
    receiverHandoffPath,
    allowedSlugs,
    eligibleSlugs,
    entries,
    blockedEntries,
  } = input
  validateCollections({ allowedSlugs, eligibleSlugs, entries, blockedEntries })
  for (const entry of entries) validateEntry(entry)
  for (const path of [repositoryRoot, candidateRoot, artifactRoot, receiverHandoffPath]) {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('repository, candidate, and destination paths must be absolute')
  }
  if (resolve(artifactRoot) === resolve(receiverHandoffPath)) fail('artifact and receiver destinations must differ')

  let rootCreated = false
  let stagingRoot
  let artifactRootGuard
  let stagingGuard
  let receiverParentGuard
  const createdPaths = []
  try {
    await assertNoSymlinkAncestry(repositoryRoot, 'repository root')
    await assertNoSymlinkAncestry(candidateRoot, 'candidate root')
    await assertNoSymlinkAncestry(dirname(artifactRoot), 'artifact parent')
    await assertNoSymlinkAncestry(dirname(receiverHandoffPath), 'receiver parent')
    await mustBeAbsent(artifactRoot, 'artifact destination')
    await mustBeAbsent(receiverHandoffPath, 'receiver destination')
    const [repositoryPhysical, candidatePhysical, artifactParentPhysical, receiverParentPhysical] = await Promise.all([
      realpath(repositoryRoot),
      realpath(candidateRoot),
      realpath(dirname(artifactRoot)),
      realpath(dirname(receiverHandoffPath)),
    ])
    const artifactPhysical = join(artifactParentPhysical, basename(artifactRoot))
    const receiverPhysical = join(receiverParentPhysical, basename(receiverHandoffPath))
    if (isContained(repositoryPhysical, artifactPhysical) || isContained(repositoryPhysical, receiverPhysical)) {
      fail('handoff destinations must be outside the repository')
    }
    if (isContained(artifactPhysical, receiverPhysical) || isContained(receiverPhysical, artifactPhysical)) {
      fail('artifact and receiver destinations must not contain one another')
    }
    const artifactParentGuard = await snapshotDirectory(dirname(artifactRoot), 'artifact parent')
    receiverParentGuard = await snapshotDirectory(dirname(receiverHandoffPath), 'receiver parent')
    for (const entry of entries) {
      await verifyStableEvidence(entry.candidate_path, entry, candidatePhysical)
      await validateBoundArchive(entry, entry.candidate_path)
    }

    await Promise.all([
      assertDirectoryUnchanged(artifactParentGuard),
      assertDirectoryUnchanged(receiverParentGuard),
    ])
    await mkdir(artifactRoot, { mode: 0o700 })
    rootCreated = true
    await assertDirectoryUnchanged(artifactParentGuard)
    artifactRootGuard = await snapshotDirectory(artifactRoot, 'artifact root')
    if (artifactRootGuard.physical !== artifactPhysical) fail('artifact root was created outside its preflight physical parent')
    stagingRoot = join(artifactRoot, '.staging')
    await assertDirectoryUnchanged(artifactRootGuard)
    await mkdir(stagingRoot, { mode: 0o700 })
    await assertDirectoryUnchanged(artifactRootGuard)
    stagingGuard = await snapshotDirectory(stagingRoot, 'staging root')
    const stagedPaths = new Map()
    const stagedOwned = new Map()
    for (const entry of entries) {
      await Promise.all([
        assertDirectoryUnchanged(artifactParentGuard),
        assertDirectoryUnchanged(artifactRootGuard),
        assertDirectoryUnchanged(stagingGuard),
      ])
      const stagedPath = join(stagingRoot, `${entry.slug}.sspack`)
      await copyStable(entry.candidate_path, stagedPath, entry, (path, info) => {
        const owned = ownedPath(path, stagingGuard, info)
        createdPaths.push(owned)
        stagedOwned.set(entry.slug, owned)
      }, detail => afterPhase?.('source-opened', detail))
      await validateBoundArchive(entry, stagedPath)
      await Promise.all([
        assertDirectoryUnchanged(artifactRootGuard),
        assertDirectoryUnchanged(stagingGuard),
      ])
      stagedPaths.set(entry.slug, stagedPath)
    }
    await afterPhase?.('staged-and-validated')

    const ledgerEntries = []
    const archivePaths = []
    for (const entry of entries) {
      await Promise.all([
        assertDirectoryUnchanged(artifactParentGuard),
        assertDirectoryUnchanged(artifactRootGuard),
        assertDirectoryUnchanged(stagingGuard),
      ])
      const archivePath = join(artifactRoot, `${entry.slug}.sspack`)
      await copyStable(stagedPaths.get(entry.slug), archivePath, entry, (path, info) => {
        createdPaths.push(ownedPath(path, artifactRootGuard, info))
      }, detail => afterPhase?.('source-opened', detail))
      await validateBoundArchive(entry, archivePath)
      await Promise.all([
        assertDirectoryUnchanged(artifactRootGuard),
        assertDirectoryUnchanged(stagingGuard),
      ])
      const stagedOwnership = stagedOwned.get(entry.slug)
      await unlinkOwned(stagedOwnership)
      createdPaths.splice(createdPaths.indexOf(stagedOwnership), 1)
      archivePaths.push(archivePath)
      ledgerEntries.push({
        absolute_path: archivePath,
        bytes: entry.bytes,
        delivery_profile: entry.delivery_profile,
        min_app_version: entry.min_app_version,
        receipt_ref: entry.receipt_ref,
        reviews: entry.reviews,
        sha256: entry.sha256,
        slug: entry.slug,
      })
      await afterPhase?.('archive-finalized', { path: archivePath })
    }
    await Promise.all([
      assertDirectoryUnchanged(artifactParentGuard),
      assertDirectoryUnchanged(artifactRootGuard),
      assertDirectoryUnchanged(stagingGuard),
      assertDirectoryUnchanged(receiverParentGuard),
    ])
    await rmdir(stagingRoot)
    stagingGuard = undefined

    const ledger = { schema_version: 1, entries: ledgerEntries }
    const successfulEntries = ledgerEntries.map((entry, index) => ({
      ...entry,
      component_summary: entries[index].component_summary,
    }))
    const releaseHandoff = { schema_version: 1, entries: successfulEntries }
    const receiver = {
      schema_version: 1,
      artifact_root: artifactRoot,
      ledger_path: join(artifactRoot, 'ledger.json'),
      successful_entries: successfulEntries,
      blocked_entries: blockedEntries,
      explicitly_not_done: EXPLICITLY_NOT_DONE,
    }
    const ledgerPath = join(artifactRoot, 'ledger.json')
    const releaseHandoffPath = join(artifactRoot, 'release-handoff.json')
    for (const [path, value] of [[ledgerPath, ledger], [releaseHandoffPath, releaseHandoff], [receiverHandoffPath, receiver]]) {
      await Promise.all([
        assertDirectoryUnchanged(artifactParentGuard),
        assertDirectoryUnchanged(artifactRootGuard),
        ...(path === receiverHandoffPath ? [assertDirectoryUnchanged(receiverParentGuard)] : []),
      ])
      const parentGuard = path === receiverHandoffPath ? receiverParentGuard : artifactRootGuard
      await writeJsonExclusive(path, value, (createdPath, info) => createdPaths.push(ownedPath(createdPath, parentGuard, info)))
      await assertDirectoryUnchanged(parentGuard)
      await afterPhase?.('handoff-finalized', { path })
    }

    await Promise.all([
      assertDirectoryUnchanged(artifactParentGuard),
      assertDirectoryUnchanged(artifactRootGuard),
      assertDirectoryUnchanged(receiverParentGuard),
    ])
    const artifactRootPhysical = artifactRootGuard.physical
    for (const [index, archivePath] of archivePaths.entries()) {
      await verifyStableEvidence(archivePath, entries[index], artifactRootPhysical)
      await validateBoundArchive(entries[index], archivePath)
    }
    const [persistedLedger, persistedRelease, persistedReceiver] = await Promise.all([
      readJsonStable(ledgerPath, 'ledger'),
      readJsonStable(releaseHandoffPath, 'release handoff'),
      readJsonStable(receiverHandoffPath, 'receiver handoff'),
    ])
    assertNoSummary(persistedLedger, 'ledger')
    if (JSON.stringify(persistedLedger) !== JSON.stringify(ledger)
      || JSON.stringify(persistedRelease) !== JSON.stringify(releaseHandoff)
      || JSON.stringify(persistedReceiver) !== JSON.stringify(receiver)) fail('persisted handoff JSON differs from verified input')
    await Promise.all([
      assertDirectoryUnchanged(artifactParentGuard),
      assertDirectoryUnchanged(artifactRootGuard),
      assertDirectoryUnchanged(receiverParentGuard),
    ])
    return { phase: 'complete', archivePaths, ledgerPath, releaseHandoffPath, receiverHandoffPath }
  } catch (error) {
    if (!rootCreated) {
      error.phase = 'preflight-failed'
      throw error
    }
    const cleanupFailures = await cleanupCreated(createdPaths, stagingRoot, stagingGuard)
    const failurePath = join(artifactRoot, 'failure.json')
    let rootStillOwned = false
    try {
      await assertDirectoryUnchanged(artifactRootGuard)
      rootStillOwned = true
    } catch (identityError) {
      cleanupFailures.push({ path: artifactRoot, error: identityError instanceof Error ? identityError.message : String(identityError) })
    }
    const remainingBeforeFailure = rootStillOwned ? await pathInventory(artifactRoot) : createdPaths.map(owned => owned.path)
    const failure = {
      schema_version: 1,
      phase: 'failed-after-root',
      error: error instanceof Error ? error.message : String(error),
      cleanup_failures: cleanupFailures,
      remaining_paths: [...remainingBeforeFailure, failurePath].sort(),
    }
    if (rootStillOwned) {
      try {
        await writeJsonExclusive(failurePath, failure)
        error.failurePath = failurePath
      } catch (failureError) {
        error.failure_write_error = failureError instanceof Error ? failureError.message : String(failureError)
      }
    } else {
      error.failure_write_error = 'artifact root identity changed; refusing to redirect failure evidence'
    }
    error.phase = 'failed-after-root'
    throw error
  }
}
