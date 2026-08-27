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
const DEFAULT_WAVE_ID = 'reusable-content-primitives-wave-two'
const WAVE_TWO_BINDINGS = {
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
const THUMBNAIL_EXPANSION_SUMMARIES = {
  'before-after-proof-panel': 'Matched before-and-after states show one subject changing across a truthful temporal seam.',
  'two-option-criteria-split': 'Two present-time alternatives receive equal visual weight for an honest criteria-based comparison.',
  'reaction-evidence-inset': 'A reaction subject directs attention to one original in-scene evidence detail.',
  'cutaway-exploded-object': 'One object opens into an ordered, readable view of its meaningful internal layers.',
  'hero-payoff-companion': 'A generic hero visibly interacts with a separate, tangible result object.',
  'iconic-result-closeup': 'One truthful finished outcome dominates the frame at a detail-revealing angle.',
  'scale-journey': 'Three related forms progress through continuous depth to communicate scale or magnitude.',
  'numbered-lineup': 'Three to five equal-status entries form a precise lineup with matching native numerals.',
  'macro-mystery-detail': 'An extreme close detail creates bounded curiosity while a small honest clue preserves context.',
  'hands-on-pov-moment': 'First-person or over-shoulder hands perform one clear, safe action in task context.',
}
const THUMBNAIL_EXPANSION_BINDINGS = Object.fromEntries(Object.keys(THUMBNAIL_EXPANSION_SUMMARIES).map(slug => [slug, {
  pack_id: `com.storystudio.pack.thumbnail.${slug}`,
  item_id: `com.storystudio.thumbnail.${slug}`,
  version: '1.0.0',
  publisher_id: 'com.storystudio',
  kind: 'thumbnail-recipe',
  source_path: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/${slug}`,
  dependencies: [],
}]))
const WAVE_CONTRACTS = {
  [DEFAULT_WAVE_ID]: {
    label: 'fixed Wave 2',
    receipt: 'authoring:bd4d3d8938cee8b2191379c5912cbbc5d848daa36bf6f7ca28f870c1359a2728',
    bindings: WAVE_TWO_BINDINGS,
    includeStoryIdentity: false,
    includeReceiverStatus: false,
  },
  'thumbnail-recipe-expansion-ten': {
    label: 'fixed thumbnail-recipe-expansion-ten wave',
    receipt: 'authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378',
    bindings: THUMBNAIL_EXPANSION_BINDINGS,
    summaries: THUMBNAIL_EXPANSION_SUMMARIES,
    includeStoryIdentity: true,
    includeReceiverStatus: true,
    strictEntry: true,
  },
  'reusable-content-primitives-wave-two-recipe-completion': {
    label: 'fixed Wave 2 recipe completion',
    receipt: 'authoring:bd4d3d8938cee8b2191379c5912cbbc5d848daa36bf6f7ca28f870c1359a2728',
    bindings: WAVE_TWO_BINDINGS,
    includeStoryIdentity: false,
    includeReceiverStatus: false,
    completionSuccessor: true,
  },
}
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

function expectedExpansionReviewEvidence(slug, review) {
  const base = `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/${slug}`
  if (review === 'commercial-boundary') return `${base}.spec.md and ${base}.quality.md`
  return `${base}.${['originality-provenance', 'visual', 'thumbnail', 'safety', 'copy'].includes(review) ? 'quality' : 'spec'}.md`
}

function validateStrictExpansionReviews(reviews, slug) {
  const expectedNames = [
    'schema', 'originality-provenance', 'compatibility', 'prompt-equivalence', 'visual',
    'thumbnail', 'safety', 'copy', 'commercial-boundary',
  ]
  if (JSON.stringify(reviews.map(entry => entry?.review)) !== JSON.stringify(expectedNames)) {
    fail(`${slug} reviews must use the exact thumbnail expansion review order`)
  }
  for (const review of reviews) {
    if (Object.keys(review).sort().join(',') !== 'evidence,review,status') fail(`${slug} review ${review.review} has invalid fields`)
    if (review.evidence !== expectedExpansionReviewEvidence(slug, review.review)) {
      fail(`${slug} review ${review.review} has invalid evidence`)
    }
  }
}

function resolveWaveContract(waveId) {
  if (waveId === undefined) return WAVE_CONTRACTS[DEFAULT_WAVE_ID]
  if (typeof waveId !== 'string' || !Object.hasOwn(WAVE_CONTRACTS, waveId)) fail('waveId is not a supported immutable wave contract')
  return WAVE_CONTRACTS[waveId]
}

function validateCollections({ allowedSlugs, eligibleSlugs, entries, blockedEntries }, contract) {
  const allowed = uniqueSlugs(allowedSlugs, 'allowedSlugs')
  const fixedSlugs = Object.keys(contract.bindings)
  if (JSON.stringify(allowedSlugs) !== JSON.stringify(fixedSlugs)) {
    fail(`allowedSlugs must equal the exact ${contract.label} slug order`)
  }
  const eligible = uniqueSlugs(eligibleSlugs, 'eligibleSlugs')
  for (const slug of eligible) if (!allowed.has(slug)) fail(`eligible slug ${slug} is outside allowedSlugs`)
  if (!Array.isArray(entries) || !Array.isArray(blockedEntries)) fail('entries and blockedEntries must be arrays')
  const entrySlugs = uniqueSlugs(entries.map(entry => entry?.slug), 'entries')
  const blockedSlugs = uniqueSlugs(blockedEntries.map(entry => entry?.slug), 'blockedEntries')
  if (contract.completionSuccessor) {
    const requiredRecipes = ['object-hero-question', 'route-map-one-promise']
    if (JSON.stringify(eligibleSlugs) !== JSON.stringify(requiredRecipes)
      || JSON.stringify(entries.map(entry => entry?.slug)) !== JSON.stringify(requiredRecipes)
      || blockedSlugs.size !== 0) {
      fail('completion successor must stage the exact ordered two-recipe eligible set with no blocked entries')
    }
    exactSet(entrySlugs, eligible, 'entries')
    return { allowed, eligible }
  }
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
  return (await readJsonStableEvidence(path, label)).value
}

async function readJsonStableEvidence(path, label) {
  const { handle, before } = await openStableRegular(path, label)
  try {
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after) || after.size !== BigInt(bytes.byteLength)) fail(`${label} changed while being read`)
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    await handle.close()
  }
}

async function validatePriorValidatedDelivery(context, contract, repositoryPhysical) {
  assertPlainObject(context, 'completion')
  if (JSON.stringify(Object.keys(context).sort()) !== JSON.stringify([
    'prior_artifact_root', 'prior_delivered_slugs', 'prior_ledger_path',
  ])) fail('completion has invalid fields')
  const expectedSlugs = Object.keys(contract.bindings).slice(0, 3)
  if (!isAbsolute(context.prior_artifact_root) || !isAbsolute(context.prior_ledger_path)) {
    fail('completion prior delivery paths must be absolute')
  }
  if (resolve(context.prior_ledger_path) !== join(resolve(context.prior_artifact_root), 'ledger.json')) {
    fail('completion prior ledger must be the prior artifact ledger')
  }
  if (JSON.stringify(context.prior_delivered_slugs) !== JSON.stringify(expectedSlugs)) {
    fail('completion prior delivered leaves must be the exact historical three-leaf set')
  }
  await assertNoSymlinkAncestry(context.prior_artifact_root, 'completion prior artifact root')
  await assertNoSymlinkAncestry(context.prior_ledger_path, 'completion prior ledger', false)
  const priorRoot = await snapshotDirectory(context.prior_artifact_root, 'completion prior artifact root')
  if (isContained(repositoryPhysical, priorRoot.physical)) fail('completion prior delivery must be outside the repository')
  const { value: ledger, sha256: ledgerSha256 } = await readJsonStableEvidence(context.prior_ledger_path, 'completion prior ledger')
  if (JSON.stringify(Object.keys(ledger).sort()) !== JSON.stringify(['entries', 'schema_version']) || ledger.schema_version !== 1
    || !Array.isArray(ledger.entries) || ledger.entries.length !== expectedSlugs.length) {
    fail('completion prior ledger has an invalid shape')
  }
  if (JSON.stringify(ledger.entries.map(entry => entry?.slug)) !== JSON.stringify(expectedSlugs)) {
    fail('completion prior ledger does not preserve the exact historical leaf order')
  }
  const archives = []
  for (const entry of ledger.entries) {
    assertPlainObject(entry, `completion prior ${entry?.slug ?? ''}`)
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([
      'absolute_path', 'bytes', 'delivery_profile', 'min_app_version', 'receipt_ref', 'reviews', 'sha256', 'slug',
    ])) fail(`completion prior ${entry.slug} has invalid ledger fields`)
    if (resolve(entry.absolute_path) !== join(priorRoot.physical, `${entry.slug}.sspack`)) {
      fail(`completion prior ${entry.slug} archive path does not match its artifact root`)
    }
    if (entry.receipt_ref !== contract.receipt || entry.min_app_version !== MIN_APP_VERSION
      || entry.delivery_profile !== DELIVERY_PROFILE || !expectedSlugs.includes(entry.slug)) {
      fail(`completion prior ${entry.slug} does not match the immutable Wave 2 delivery`)
    }
    archives.push({ slug: entry.slug, ...(await verifyStableEvidence(entry.absolute_path, entry, priorRoot.physical)) })
    await validateBoundArchive(entry, entry.absolute_path, contract)
  }
  await assertDirectoryUnchanged(priorRoot)
  return {
    summary: {
      artifact_root: priorRoot.physical,
      ledger_path: resolve(context.prior_ledger_path),
      receipt_ref: contract.receipt,
      delivered_leaves: expectedSlugs,
      validation: 'validated-existing-delivery',
    },
    evidence: { ledger_sha256: ledgerSha256, archives },
  }
}

function assertPriorDeliveryUnchanged(before, after) {
  if (JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) {
    fail('prior delivery changed since preflight')
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

function validateEntry(entry, contract) {
  assertPlainObject(entry, `entry ${entry?.slug ?? ''}`)
  if (contract.strictEntry) {
    const expectedFields = [
      'bytes', 'candidate_path', 'component_summary', 'delivery_profile', 'dependencies', 'item_id',
      'kind', 'min_app_version', 'pack_id', 'publisher_id', 'receipt_ref', 'reviews', 'sha256',
      'slug', 'source_path', 'version',
    ].sort()
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedFields)) fail(`${entry.slug} entry has invalid fields`)
  }
  const binding = contract.bindings[entry.slug]
  if (!binding) fail(`${entry.slug} is not a ${contract.label} slug`)
  for (const field of ['pack_id', 'item_id', 'version', 'source_path']) {
    if (entry[field] !== binding[field]) fail(`${entry.slug} ${field} does not match its ${contract.label} binding`)
  }
  if (contract.includeStoryIdentity) {
    for (const field of ['publisher_id', 'kind', 'dependencies']) {
      if (JSON.stringify(entry[field]) !== JSON.stringify(binding[field])) fail(`${entry.slug} ${field} does not match its ${contract.label} binding`)
    }
  }
  if (typeof entry.candidate_path !== 'string' || !isAbsolute(entry.candidate_path)) fail(`${entry.slug} candidate_path must be absolute`)
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_ARCHIVE_BYTES) fail(`${entry.slug} has an invalid byte count`)
  if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) fail(`${entry.slug} has an invalid SHA-256 digest`)
  if (entry.min_app_version !== MIN_APP_VERSION) fail(`${entry.slug} min_app_version must be ${MIN_APP_VERSION}`)
  if (entry.delivery_profile !== DELIVERY_PROFILE) fail(`${entry.slug} delivery profile must be ${DELIVERY_PROFILE}`)
  if (typeof entry.receipt_ref !== 'string' || !RECEIPT.test(entry.receipt_ref) || entry.receipt_ref !== contract.receipt) {
    fail(`${entry.slug} receipt_ref does not match the exact ${contract.label} reservation`)
  }
  validateSummary(entry.component_summary, `${entry.slug} component_summary`)
  if (entry.component_summary.kind !== binding.kind) fail(`${entry.slug} summary kind does not match its ${contract.label} binding`)
  if (contract.summaries && entry.component_summary.summary !== contract.summaries[entry.slug]) {
    fail(`${entry.slug} component_summary does not match its exact ${contract.label} summary`)
  }
  if (contract.summaries && JSON.stringify(entry.component_summary.slots) !== JSON.stringify({ 'thumbnail-recipe': 1 })) {
    fail(`${entry.slug} component_summary slots do not match the exact ${contract.label} summary`)
  }
  validateReviews(entry.reviews, entry.component_summary.kind, entry.slug)
  if (contract.strictEntry) validateStrictExpansionReviews(entry.reviews, entry.slug)
}

async function validateBoundArchive(entry, archivePath, contract) {
  const binding = contract.bindings[entry.slug]
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
    fail(`${entry.slug} archive identity or manifest contract does not match its ${contract.label} binding`)
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
    waveId,
    repositoryRoot,
    candidateRoot,
    artifactRoot,
    receiverHandoffPath,
    allowedSlugs,
    eligibleSlugs,
    entries,
    blockedEntries,
    completion,
  } = input
  const contract = resolveWaveContract(waveId)
  validateCollections({ allowedSlugs, eligibleSlugs, entries, blockedEntries }, contract)
  for (const entry of entries) validateEntry(entry, contract)
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
    const priorDelivery = contract.completionSuccessor
      ? await validatePriorValidatedDelivery(completion, contract, repositoryPhysical)
      : undefined
    const priorValidatedDelivery = priorDelivery?.summary
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
      await validateBoundArchive(entry, entry.candidate_path, contract)
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
      await validateBoundArchive(entry, stagedPath, contract)
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
      await validateBoundArchive(entry, archivePath, contract)
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

    if (priorDelivery) {
      assertPriorDeliveryUnchanged(priorDelivery, await validatePriorValidatedDelivery(completion, contract, repositoryPhysical))
    }

    const ledger = {
      schema_version: 1,
      ...(priorValidatedDelivery ? { prior_validated_delivery: priorValidatedDelivery } : {}),
      entries: ledgerEntries,
    }
    const successfulEntries = ledgerEntries.map((entry, index) => ({
      ...(contract.includeStoryIdentity ? {
        slug: entries[index].slug,
        pack_id: entries[index].pack_id,
        item_id: entries[index].item_id,
        version: entries[index].version,
        publisher_id: entries[index].publisher_id,
        kind: entries[index].kind,
        source_path: entries[index].source_path,
        dependencies: entries[index].dependencies,
      } : {}),
      ...entry,
      component_summary: entries[index].component_summary,
    }))
    const releaseHandoff = {
      schema_version: 1,
      ...(priorValidatedDelivery ? {
        prior_validated_delivery: priorValidatedDelivery,
        wave_completion: { all_leaves: Object.keys(contract.bindings), status: 'complete' },
      } : {}),
      entries: successfulEntries,
    }
    const receiver = {
      schema_version: 1,
      ...(contract.includeReceiverStatus ? {
        status: successfulEntries.length === Object.keys(contract.bindings).length
          && blockedEntries.length === 0
          && JSON.stringify(successfulEntries.map(entry => entry.slug)) === JSON.stringify(Object.keys(contract.bindings))
          ? 'ready-for-owner-stocking'
          : 'partial-ready-blocked',
      } : {}),
      artifact_root: artifactRoot,
      ledger_path: join(artifactRoot, 'ledger.json'),
      successful_entries: successfulEntries,
      ...(priorValidatedDelivery ? {
        prior_validated_delivery: priorValidatedDelivery,
        wave_completion: { all_leaves: Object.keys(contract.bindings), status: 'complete' },
        stocking_request: 'draft-stocking-only',
        commercial_boundary: 'Component packs are draft and available through active Channel Kits; no standalone publication is authorized here.',
      } : { blocked_entries: blockedEntries }),
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
      await validateBoundArchive(entries[index], archivePath, contract)
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
    if (priorDelivery) {
      assertPriorDeliveryUnchanged(priorDelivery, await validatePriorValidatedDelivery(completion, contract, repositoryPhysical))
    }
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
