import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLISHER_ID = 'com.storystudio'
const MIN_APP_VERSION_TOKEN = '{{MIN_APP_VERSION}}'
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const QUALIFIED_ID = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const AUTHORING_RECEIPT = /^authoring:[a-f0-9]{64}$/
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
// Content documents get their own, larger bound: a pack.json manifest should
// never approach 1 MiB and stays tightly capped above, but a 100-subject Topic
// Pack document is ~1.2 MB. 4 MiB matches DEFAULT_LIMITS.maxJsonBytes in
// electron/server/content-packs/archive.ts, so a document the archive verifier
// accepts is also a document this validator will register. Keep the two in step.
const MAX_CONTENT_DOCUMENT_BYTES = 4 * 1024 * 1024
const MAX_REGISTRY_RECORDS = 5_000
const MAX_REQUEST_RECORDS = 100
const MAX_DEPENDENCIES = 100
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 250_000
const MAX_JSON_STRING_BYTES = 64 * 1024
const MAX_SOURCE_DEPTH = 16
const MAX_DISCOVERY_ENTRIES = 100_000
const MAX_DISCOVERY_DIRECTORIES = 10_000
const RETIRED_SOURCE_ROOT = 'content-packs/archival-ledger'
const RECORD_FIELDS = new Set([
  'receipt_ref', 'pack_id', 'item_id', 'item_ids', 'bundle_id', 'version', 'publisher_id',
  'min_app_version', 'min_app_version_status', 'kind', 'source_path', 'status',
  'dependencies', 'stocking_proposal',
])
const REQUEST_RECORD_FIELDS = new Set([...RECORD_FIELDS].filter((field) => field !== 'receipt_ref'))
// `reserved` is an identity with no source yet; `authored` has one on disk.
// The two terminal states differ in what they close. `withdrawn` is pre-sale
// identity closure: a reservation that never became a source. `retired` is
// post-sale source closure: an authored product we have stopped selling and
// whose source directory has been removed from this repository. Both refuse a
// source directory, both refuse further mutation, and both burn the pack_id.
// Customer archives are untouched by either; their own lifecycle values
// (`active`, `retired`, `replaced`) live in the manifest, not here.
const STATUSES = new Set(['authored', 'reserved', 'withdrawn', 'retired'])
const TERMINAL_STATUSES = new Set(['withdrawn', 'retired'])
const PROPOSAL_STATUSES = new Set(['proposed', 'reserved', 'confirmed'])
const MIN_APP_VERSION_STATUSES = new Set(['release-bound', 'fixed'])
const KIND_NAMESPACES = {
  'series-formula': { pack: `${PUBLISHER_ID}.pack.formula.`, item: `${PUBLISHER_ID}.formula.`, proposal: 'formula' },
  'topic-pack': { pack: `${PUBLISHER_ID}.pack.topic.`, item: `${PUBLISHER_ID}.topic.`, proposal: 'topic' },
  'visual-style': { pack: `${PUBLISHER_ID}.pack.style.`, item: `${PUBLISHER_ID}.style.`, proposal: 'style' },
  'thumbnail-recipe': { pack: `${PUBLISHER_ID}.pack.thumbnail.`, item: `${PUBLISHER_ID}.thumbnail.`, proposal: 'thumbnail' },
  'channel-kit': { pack: `${PUBLISHER_ID}.pack.kit.`, bundle: `${PUBLISHER_ID}.bundle.`, proposal: 'kit' },
  // Lettering is sold in packs of several creative documents, so its stable
  // identity is an exact set of item ids rather than one item or one bundle.
  'lettering-style': { pack: `${PUBLISHER_ID}.pack.lettering.`, item: `${PUBLISHER_ID}.lettering.`, proposal: 'lettering' },
  // Metadata formulas sell the same way lettering does — six creative documents
  // to a pack — so their identity is an exact set of item ids too.
  'metadata-formula': { pack: `${PUBLISHER_ID}.pack.metadata-formula.`, item: `${PUBLISHER_ID}.metadata-formula.`, proposal: 'metadata-formula' },
}
/** Kinds whose pack holds many creative documents rather than exactly one. */
const MULTI_ITEM_KINDS = new Set(['lettering-style', 'metadata-formula'])
const MAX_PACK_ITEMS = 24
const root = fileURLToPath(new URL('../..', import.meta.url))

function fail(message) {
  throw new Error(`Authoring registry: ${message}`)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function exactFields(value, allowed, label) {
  for (const key of Object.keys(object(value, label))) {
    if (!allowed.has(key)) fail(`unknown or forbidden field ${key} in ${label}`)
  }
}

function boundedString(value, label, maximum) {
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string`)
  if (value.length > maximum) fail(`${label} must not exceed ${maximum} characters`)
  if (/\p{Cc}/u.test(value)) fail(`${label} must not contain control characters`)
  return value
}

function trimmedString(value, label, maximum) {
  boundedString(value, label, maximum)
  const trimmed = value.trim()
  if (!trimmed) fail(`${label} must be non-empty after trimming whitespace`)
  return trimmed
}

function qualifiedId(value, label, namespace) {
  boundedString(value, label, 160)
  if (!QUALIFIED_ID.test(value)) fail(`${label} must be a lowercase qualified identifier`)
  if (!value.startsWith(namespace)) fail(`${label} must be within the ${namespace.slice(0, -1)} namespace`)
  return value
}

function exactSemver(value, label) {
  if (typeof value !== 'string' || !EXACT_SEMVER.test(value)) fail(`${label} must be an exact semantic version`)
  return value
}

function canonicalSourcePath(value, label) {
  boundedString(value, label, 240)
  const segments = value.split('/')
  if (!value.startsWith('content-packs/') || value.includes('\\') || value.startsWith('/')
    || /^[a-z]:/i.test(value) || value !== value.normalize('NFC')
    || !/^[a-z0-9][a-z0-9._/-]*$/.test(value)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${label} must be a canonical repository-contained forward-slash path under content-packs`)
  }
  if (segments.length > MAX_SOURCE_DEPTH) fail(`${label} exceeds the ${MAX_SOURCE_DEPTH}-segment traversal depth limit`)
  if (value === RETIRED_SOURCE_ROOT || value.startsWith(`${RETIRED_SOURCE_ROOT}/`)) {
    fail(`${label} must not use the retired source monolith ${RETIRED_SOURCE_ROOT}`)
  }
  return value
}

function assertBoundedJson(value, label, maximumBytes) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    fail(`${label} must be valid acyclic JSON`)
  }
  if (Buffer.byteLength(serialized) > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte JSON limit`)
  const stack = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()
    nodes += 1
    if (nodes > MAX_JSON_NODES) fail(`${label} exceeds the ${MAX_JSON_NODES}-node JSON limit`)
    if (current.depth > MAX_JSON_DEPTH) fail(`${label} exceeds the ${MAX_JSON_DEPTH}-level JSON depth limit`)
    if (typeof current.value === 'string') {
      if (Buffer.byteLength(current.value) > MAX_JSON_STRING_BYTES) fail(`${label} exceeds the JSON string limit`)
    } else if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) fail(`${label} must contain finite JSON numbers`)
    } else if (current.value && typeof current.value === 'object') {
      if (!Array.isArray(current.value)) {
        const prototype = Object.getPrototypeOf(current.value)
        if (prototype !== Object.prototype && prototype !== null) fail(`${label} must contain plain JSON objects`)
      }
      for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    } else if (current.value !== null && !['boolean', 'string', 'number'].includes(typeof current.value)) {
      fail(`${label} must contain only JSON values`)
    }
  }
}

async function readBoundedJson(path, maximumBytes, label) {
  let handle
  try {
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      fail(`${label} must be a regular file, not a symlink`)
    }
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) fail(`${label} must be a regular file, not a symlink`)
    if (before.size > BigInt(maximumBytes)) fail(`${label} exceeds the ${maximumBytes}-byte limit`)
    const bytes = Buffer.alloc(maximumBytes + 1)
    let length = 0
    let reachedEof = false
    while (length < bytes.length) {
      const chunkLength = Math.min(64 * 1024, bytes.length - length)
      const result = await handle.read(bytes, length, chunkLength, length)
      if (result.bytesRead === 0) {
        reachedEof = true
        break
      }
      length += result.bytesRead
    }
    if (!reachedEof || length > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit`)
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.size !== BigInt(length)) {
      fail(`${label} changed while being read`)
    }
    const pathInfo = await lstat(path, { bigint: true }).catch(() => undefined)
    if (!pathInfo || !pathInfo.isFile() || pathInfo.isSymbolicLink()
      || pathInfo.dev !== after.dev || pathInfo.ino !== after.ino) {
      fail(`${label} path was replaced while being read`)
    }
    let value
    try {
      value = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    } catch (error) {
      fail(`${label} must contain valid JSON: ${error.message}`)
    }
    assertBoundedJson(value, label, maximumBytes)
    return value
  } finally {
    await handle?.close()
  }
}

function packVersion(record) {
  return `${record.pack_id}@${record.version}`
}

function canonicalDependencies(value, label, self) {
  if (!Array.isArray(value)) fail(`${label} dependencies must be an array`)
  if (value.length > MAX_DEPENDENCIES) fail(`${label} dependencies must not exceed ${MAX_DEPENDENCIES} records`)
  const seen = new Set()
  return value.map((dependency, index) => {
    exactFields(dependency, new Set(['pack_id', 'version']), `${label} dependency ${index}`)
    const packId = qualifiedId(dependency.pack_id, `${label} dependency ${index} pack_id`, `${PUBLISHER_ID}.pack.`)
    const version = exactSemver(dependency.version, `${label} dependency ${index} version`)
    const identity = packVersion({ pack_id: packId, version })
    if (packId === self.pack_id) fail(`${label} must not depend on itself`)
    if (seen.has(identity)) fail(`duplicate dependency ${identity} in ${label}`)
    seen.add(identity)
    return { pack_id: packId, version }
  })
}

function proposal(value, label, namespace) {
  exactFields(value, new Set(['id', 'status', 'confirmation_ref']), label)
  const id = qualifiedId(value.id, `${label} id`, namespace)
  if (!PROPOSAL_STATUSES.has(value.status)) fail(`${label} has invalid status`)
  const confirmationRef = value.status === 'confirmed'
    ? trimmedString(value.confirmation_ref, `${label} confirmation_ref`, 500)
    : undefined
  if (value.status !== 'confirmed' && 'confirmation_ref' in value) fail(`${label} confirmation_ref is only allowed when confirmed`)
  return { id, status: value.status, ...(confirmationRef ? { confirmation_ref: confirmationRef } : {}) }
}

function validateRecord(record, index, { request = false } = {}) {
  const label = `${request ? 'request ' : ''}record ${index}`
  exactFields(record, request ? REQUEST_RECORD_FIELDS : RECORD_FIELDS, label)
  if (typeof record.kind !== 'string' || !KIND_NAMESPACES[record.kind]) fail(`${label} has invalid kind`)
  const namespaces = KIND_NAMESPACES[record.kind]
  const packId = qualifiedId(record.pack_id, `${label} pack_id`, namespaces.pack)
  const version = exactSemver(record.version, `${label} version`)
  if (record.publisher_id !== PUBLISHER_ID) fail(`${label} publisher_id must be exactly ${PUBLISHER_ID}`)
  if (!MIN_APP_VERSION_STATUSES.has(record.min_app_version_status)) fail(`${label} has invalid min_app_version_status`)
  if (record.min_app_version_status === 'release-bound') {
    if (record.min_app_version !== MIN_APP_VERSION_TOKEN) fail(`${label} min_app_version must be ${MIN_APP_VERSION_TOKEN} when release-bound`)
  } else {
    exactSemver(record.min_app_version, `${label} min_app_version for fixed status`)
  }
  if (!STATUSES.has(record.status)) fail(`${label} has invalid status`)
  if (request && record.status !== 'reserved') fail(`${label} status must be reserved`)
  const hasItem = typeof record.item_id === 'string'
  const hasItems = Array.isArray(record.item_ids)
  const hasBundle = typeof record.bundle_id === 'string'
  const expected = record.kind === 'channel-kit'
    ? (!hasItem && !hasItems && hasBundle)
    : MULTI_ITEM_KINDS.has(record.kind)
      ? (!hasItem && hasItems && !hasBundle)
      : (hasItem && !hasItems && !hasBundle)
  if (!expected) fail(`${label} has an invalid coordinator/leaf identity shape`)
  if (hasItem) qualifiedId(record.item_id, `${label} item_id`, namespaces.item)
  if (hasItems) {
    if (!record.item_ids.length) fail(`${label} item_ids must not be empty`)
    if (record.item_ids.length > MAX_PACK_ITEMS) fail(`${label} item_ids must not exceed ${MAX_PACK_ITEMS} documents`)
    const seen = new Set()
    for (const [position, id] of record.item_ids.entries()) {
      qualifiedId(id, `${label} item_ids[${position}]`, namespaces.item)
      if (seen.has(id)) fail(`${label} repeats item id ${id}`)
      seen.add(id)
    }
    // Stored sorted so one pack has exactly one canonical identity, and a
    // reordered request cannot mint a second receipt for the same item set.
    if (!same(record.item_ids, [...record.item_ids].sort())) fail(`${label} item_ids must be sorted`)
  }
  if (hasBundle) qualifiedId(record.bundle_id, `${label} bundle_id`, namespaces.bundle)
  const sourcePath = canonicalSourcePath(record.source_path, `${label} source_path`)
  exactFields(record.stocking_proposal, new Set(['family', 'sku']), `${label} stocking_proposal`)
  const proposalNamespace = namespaces.proposal
  const validated = {
    ...(request ? {} : { receipt_ref: boundedString(record.receipt_ref, `${label} receipt_ref`, 256) }),
    pack_id: packId,
    ...(hasItem ? { item_id: record.item_id } : hasItems ? { item_ids: [...record.item_ids] } : { bundle_id: record.bundle_id }),
    version,
    publisher_id: PUBLISHER_ID,
    min_app_version: record.min_app_version,
    min_app_version_status: record.min_app_version_status,
    kind: record.kind,
    source_path: sourcePath,
    status: record.status,
    dependencies: canonicalDependencies(record.dependencies, label, { pack_id: packId, version }),
    stocking_proposal: {
      family: proposal(record.stocking_proposal.family, `${label} family`, `${PUBLISHER_ID}.family.${proposalNamespace}.`),
      sku: proposal(record.stocking_proposal.sku, `${label} sku`, `${PUBLISHER_ID}.sku.${proposalNamespace}.`),
    },
  }
  if (!request && !AUTHORING_RECEIPT.test(validated.receipt_ref)) {
    const baseline = `baseline:${validated.pack_id}@${validated.version}`
    // A baseline record was entered at genesis as `authored`. Retirement is the
    // one mutation it may ever undergo, and it must be journaled to get there.
    if (validated.receipt_ref !== baseline || !['authored', 'retired'].includes(validated.status)) {
      fail(`${label} receipt_ref is not bound to its exact baseline identity`)
    }
  }
  return validated
}

function unique(records, label, field) {
  const seen = new Set()
  for (const record of records) {
    const value = field(record)
    if (seen.has(value)) fail(`duplicate ${label} ${value}`)
    seen.add(value)
  }
}

function validateLineages(records) {
  const lineages = new Map()
  const owners = new Map()
  for (const record of records) {
    const lineage = {
      publisher_id: record.publisher_id,
      kind: record.kind,
      ...(record.item_id
        ? { item_id: record.item_id }
        : record.item_ids
          ? { item_ids: record.item_ids }
          : { bundle_id: record.bundle_id }),
      family: record.stocking_proposal.family.id,
      sku: record.stocking_proposal.sku.id,
    }
    const current = lineages.get(record.pack_id)
    if (current && !same(current, lineage)) {
      const field = ['publisher_id', 'kind', 'item_id', 'item_ids', 'bundle_id', 'family', 'sku']
        .find((candidate) => !same(current[candidate], lineage[candidate]))
      fail(`stable pack_id ${field} lineage differs for ${record.pack_id}`)
    }
    lineages.set(record.pack_id, lineage)
    const identities = [
      ...(record.item_ids ?? (record.item_id ? [record.item_id] : []))
        .map((itemId) => ['item_id', itemId]),
      ...(record.bundle_id ? [['bundle_id', record.bundle_id]] : []),
      ['family', record.stocking_proposal.family.id],
      ['sku', record.stocking_proposal.sku.id],
    ]
    for (const [label, identity] of identities) {
      const owner = owners.get(`${label}:${identity}`)
      if (owner && owner !== record.pack_id) fail(`duplicate ${label} ${identity}; already owned by different pack ${owner}`)
      owners.set(`${label}:${identity}`, record.pack_id)
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function same(left, right) {
  return canonical(left) === canonical(right)
}

function reservationRequest(request) {
  assertBoundedJson(request, 'reservation request', MAX_REQUEST_BYTES)
  exactFields(request, new Set(['expected_revision', 'coordinator', 'proposal_ref', 'records']), 'reservation request')
  if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 1) fail('expected_revision must be a positive integer')
  exactFields(request.coordinator, new Set(['task', 'branch']), 'reservation coordinator')
  boundedString(request.coordinator.task, 'reservation coordinator task', 200)
  boundedString(request.coordinator.branch, 'reservation coordinator branch', 200)
  boundedString(request.proposal_ref, 'reservation proposal_ref', 500)
  if (!Array.isArray(request.records) || !request.records.length) fail('reservation records must be a non-empty array')
  if (request.records.length > MAX_REQUEST_RECORDS) fail(`reservation records must not exceed ${MAX_REQUEST_RECORDS}`)
  return {
    expected_revision: request.expected_revision,
    coordinator: { task: request.coordinator.task, branch: request.coordinator.branch },
    proposal_ref: request.proposal_ref,
    records: request.records.map((record, index) => validateRecord(record, index, { request: true })),
  }
}

function receiptFor(request) {
  return `authoring:${createHash('sha256').update(canonical(request)).digest('hex')}`
}

function transitionRequest(request) {
  assertBoundedJson(request, 'lifecycle transition request', MAX_REQUEST_BYTES)
  exactFields(request, new Set(['expected_revision', 'coordinator', 'receipt_ref', 'pack_id', 'version', 'changes', 'reason']), 'lifecycle transition request')
  if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 1) fail('expected_revision must be a positive integer')
  exactFields(request.coordinator, new Set(['task', 'branch']), 'lifecycle transition coordinator')
  boundedString(request.coordinator.task, 'lifecycle transition coordinator task', 200)
  boundedString(request.coordinator.branch, 'lifecycle transition coordinator branch', 200)
  const packId = qualifiedId(request.pack_id, 'lifecycle transition pack_id', `${PUBLISHER_ID}.pack.`)
  const version = exactSemver(request.version, 'lifecycle transition version')
  // Genesis records carry a `baseline:` receipt and no batch to replay, so they
  // accept exactly one lifecycle event: retirement. Everything else about them
  // is immutable, which is what made a baseline receipt acceptable at all.
  const baselineReceipt = request.receipt_ref === `baseline:${packId}@${version}`
  if (!AUTHORING_RECEIPT.test(request.receipt_ref) && !baselineReceipt) {
    fail('lifecycle transition receipt_ref must be a valid authoring receipt, or the record\'s exact baseline receipt')
  }
  exactFields(request.changes, new Set(['status', 'stocking_proposal']), 'lifecycle transition changes')
  if (!Object.keys(request.changes).length) fail('lifecycle transition changes must not be empty')
  const changes = {}
  if ('status' in request.changes) {
    if (!['authored', 'withdrawn', 'retired'].includes(request.changes.status)) fail('lifecycle status transition must advance reserved to authored or withdrawn, or authored to retired')
    changes.status = request.changes.status
  }
  if ('stocking_proposal' in request.changes) {
    const stocking = request.changes.stocking_proposal
    exactFields(stocking, new Set(['family', 'sku']), 'lifecycle transition stocking_proposal')
    if (!Object.keys(stocking).length) fail('lifecycle transition stocking_proposal must not be empty')
    changes.stocking_proposal = {}
    for (const name of ['family', 'sku']) {
      if (!(name in stocking)) continue
      const change = stocking[name]
      exactFields(change, new Set(['status', 'confirmation_ref']), `lifecycle transition ${name}`)
      if (!PROPOSAL_STATUSES.has(change.status)) fail(`lifecycle transition ${name} has invalid status`)
      const confirmationRef = change.status === 'confirmed'
        ? trimmedString(change.confirmation_ref, `lifecycle transition ${name} confirmation_ref`, 500)
        : undefined
      if (change.status !== 'confirmed' && 'confirmation_ref' in change) fail(`lifecycle transition ${name} confirmation_ref is only allowed when confirmed`)
      changes.stocking_proposal[name] = {
        status: change.status,
        ...(confirmationRef ? { confirmation_ref: confirmationRef } : {}),
      }
    }
  }
  if (TERMINAL_STATUSES.has(changes.status) && changes.stocking_proposal) {
    fail(`${changes.status === 'retired' ? 'retirement' : 'withdrawal'} is terminal and must not change stocking proposals`)
  }
  // Retirement removes a shipped source from the repository, so the reason it
  // was retired is the only surviving explanation. Record it in the journal
  // rather than in a commit message that the registry cannot see.
  if (baselineReceipt && !same(Object.keys(changes).sort(), ['status'])) fail('a baseline record accepts no lifecycle change but retirement')
  if (baselineReceipt && changes.status !== 'retired') fail('a baseline record accepts no lifecycle change but retirement')
  if (changes.status === 'retired' && !('reason' in request)) fail('retirement must state a reason')
  if (changes.status !== 'retired' && 'reason' in request) fail('reason is only allowed when retiring a record')
  const reason = 'reason' in request ? trimmedString(request.reason, 'lifecycle transition reason', 500) : undefined
  return {
    expected_revision: request.expected_revision,
    coordinator: { task: request.coordinator.task, branch: request.coordinator.branch },
    receipt_ref: request.receipt_ref,
    pack_id: packId,
    version,
    changes,
    ...(reason ? { reason } : {}),
  }
}

function transitionFor(request) {
  return `lifecycle:${createHash('sha256').update(canonical(request)).digest('hex')}`
}

function applyLifecycleTransition(record, changes, { replay = false } = {}) {
  if (TERMINAL_STATUSES.has(record.status)) fail(`${record.status} records are terminal`)
  if (record.kind === 'channel-kit' && changes.stocking_proposal && !replay) {
    fail('Channel Kit stocking-proposal changes are refused; historical Channel Kits are read-only')
  }
  const next = {
    ...record,
    stocking_proposal: {
      family: { ...record.stocking_proposal.family },
      sku: { ...record.stocking_proposal.sku },
    },
  }
  if ('status' in changes) {
    const permitted = record.status === 'reserved'
      ? ['authored', 'withdrawn']
      : record.status === 'authored' ? ['retired'] : []
    if (!permitted.includes(changes.status)) fail('lifecycle status must advance reserved to authored or withdrawn, or authored to retired')
    if (record.kind === 'channel-kit' && changes.status === 'authored' && !replay) {
      fail('Channel Kit promotion is refused; historical Channel Kits are read-only')
    }
    next.status = changes.status
  }
  for (const name of ['family', 'sku']) {
    const change = changes.stocking_proposal?.[name]
    if (!change) continue
    const states = ['proposed', 'reserved', 'confirmed']
    if (states.indexOf(change.status) !== states.indexOf(record.stocking_proposal[name].status) + 1) {
      fail(`lifecycle ${name} must advance one step from proposed to reserved to confirmed`)
    }
    next.stocking_proposal[name] = {
      id: record.stocking_proposal[name].id,
      status: change.status,
      ...(change.status === 'confirmed' ? { confirmation_ref: change.confirmation_ref } : {}),
    }
  }
  return next
}

function validateBatches(value) {
  if (!Array.isArray(value)) fail('registry batches must be an array')
  return value.map((batch, index) => {
    const label = `batch ${index}`
    exactFields(batch, new Set(['revision', 'receipt_ref', 'request']), label)
    if (!Number.isSafeInteger(batch.revision) || batch.revision < 2) fail(`${label} revision must be an integer of at least 2`)
    if (!AUTHORING_RECEIPT.test(batch.receipt_ref)) fail(`${label} receipt_ref must be a valid authoring receipt`)
    const request = reservationRequest(batch.request)
    if (request.expected_revision !== batch.revision - 1) fail(`${label} expected_revision must precede its revision`)
    if (receiptFor(request) !== batch.receipt_ref) fail(`${label} receipt does not match its persisted request metadata`)
    return { revision: batch.revision, receipt_ref: batch.receipt_ref, request }
  })
}

function validateTransitions(value) {
  if (!Array.isArray(value)) fail('registry transitions must be an array')
  return value.map((transition, index) => {
    const label = `transition ${index}`
    exactFields(transition, new Set(['revision', 'transition_ref', 'request']), label)
    if (!Number.isSafeInteger(transition.revision) || transition.revision < 2) fail(`${label} revision must be an integer of at least 2`)
    if (typeof transition.transition_ref !== 'string' || !/^lifecycle:[a-f0-9]{64}$/.test(transition.transition_ref)) fail(`${label} transition_ref is invalid`)
    const request = transitionRequest(transition.request)
    if (request.expected_revision !== transition.revision - 1) fail(`${label} expected_revision must precede its revision`)
    if (transitionFor(request) !== transition.transition_ref) fail(`${label} reference does not match its persisted request metadata`)
    return { revision: transition.revision, transition_ref: transition.transition_ref, request }
  })
}

function validateRevisionEvents(revision, batches, transitions) {
  const events = [...batches, ...transitions].sort((left, right) => left.revision - right.revision)
  if (events.length !== revision - 1) fail(`registry revision ${revision} must have exactly ${revision - 1} persisted mutation events`)
  events.forEach((event, index) => {
    if (event.revision !== index + 2) fail(`registry mutation event ${index} revision must be ${index + 2}`)
  })
}

// `retiringSourcePath` names the one record being retired by the transition
// that is validating this document. Retirement is a two-step move — retire the
// record, then delete the directory — and the registry refuses to hold either
// half on its own: an authored record must have its source, a retired one must
// not. The single exemption is the record under the lock right now, whose
// directory is deleted immediately after the write. Every other retired record
// must already be gone, so a half-finished retirement fails `validate`.
async function assertSafeSourcePath(repositoryRoot, record, { retiringSourcePath } = {}) {
  const repositoryPhysical = await realpath(repositoryRoot)
  let cursor = resolve(repositoryRoot)
  const segments = record.source_path.split('/')
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    const info = await lstat(cursor).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (!info) {
      if (record.status === 'authored') fail(`registered authored source does not exist: ${record.source_path}`)
      return
    }
    if (info.isSymbolicLink()) fail(`source_path must not contain symlinks: ${record.source_path}`)
    if (index < segments.length - 1 && !info.isDirectory()) fail(`source_path ancestor must be a directory: ${record.source_path}`)
  }
  const physical = await realpath(cursor)
  const fromRoot = relative(repositoryPhysical, physical)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) fail(`source_path must remain inside the repository: ${record.source_path}`)
  const final = await lstat(cursor)
  if (TERMINAL_STATUSES.has(record.status) && record.source_path !== retiringSourcePath) {
    fail(`${record.status} source path must not exist: ${record.source_path}`)
  }
  if (!final.isDirectory()) fail(`source_path must be a directory: ${record.source_path}`)
}

async function packPaths(repositoryRoot) {
  const contentRoot = join(repositoryRoot, 'content-packs')
  const rootInfo = await lstat(contentRoot).catch(() => undefined)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail('content-packs source root must be a regular directory')
  const repositoryPhysical = await realpath(repositoryRoot)
  const stack = [{ path: contentRoot, sourcePath: 'content-packs', depth: 1 }]
  const paths = []
  let directoryCount = 0
  let entryCount = 0
  while (stack.length) {
    const current = stack.pop()
    directoryCount += 1
    if (directoryCount > MAX_DISCOVERY_DIRECTORIES) fail(`source discovery exceeds the ${MAX_DISCOVERY_DIRECTORIES}-directory limit`)
    const physical = await realpath(current.path)
    const fromRoot = relative(repositoryPhysical, physical)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) fail(`source discovery escaped the repository at ${current.sourcePath}`)
    const entries = (await readdir(current.path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      entryCount += 1
      if (entryCount > MAX_DISCOVERY_ENTRIES) fail(`source discovery exceeds the ${MAX_DISCOVERY_ENTRIES}-entry limit`)
      const child = join(current.path, entry.name)
      const sourcePath = `${current.sourcePath}/${entry.name}`
      if (sourcePath === RETIRED_SOURCE_ROOT) continue
      if (entry.isSymbolicLink()) fail(`source discovery symlink is not permitted: ${sourcePath}`)
      if (entry.isDirectory()) {
        if (current.depth + 1 > MAX_SOURCE_DEPTH) fail(`source discovery exceeds the ${MAX_SOURCE_DEPTH}-segment traversal depth limit at ${sourcePath}`)
        stack.push({ path: child, sourcePath, depth: current.depth + 1 })
      } else if (entry.name === 'pack.json') {
        if (!entry.isFile()) fail(`pack.json must be a regular file: ${sourcePath}`)
        paths.push(child)
      }
    }
  }
  return paths.sort()
}

async function reconcileSources(records, repositoryRoot) {
  const paths = await packPaths(repositoryRoot)
  const bySource = new Map(records.map((record) => [record.source_path, record]))
  const discovered = new Set()
  const byIdentity = new Map(records.map((record) => [`${record.pack_id}@${record.version}`, record]))
  for (const packPath of paths) {
    const sourcePath = relative(repositoryRoot, dirname(packPath)).split(sep).join('/')
    const record = bySource.get(sourcePath)
    if (!record) fail(`authored source ${sourcePath} is not registered`)
    discovered.add(sourcePath)
    const manifest = await readBoundedJson(packPath, MAX_MANIFEST_BYTES, `pack manifest ${sourcePath}`)
    const expectedDependencies = manifest.dependencies ?? []
    if (!same(record.dependencies, expectedDependencies)) fail(`dependency closure differs for ${sourcePath}`)
    if (record.pack_id !== manifest.pack_id || record.version !== manifest.version || record.publisher_id !== manifest.publisher_id || record.min_app_version !== manifest.min_app_version) fail(`identity differs for ${sourcePath}`)
    if (record.stocking_proposal.family.id !== manifest.entitlement?.family || record.stocking_proposal.sku.id !== manifest.entitlement?.sku) fail(`stocking proposal differs for ${sourcePath}`)
    const bundles = manifest.bundles ?? []
    if (!Array.isArray(bundles)) fail(`manifest bundles must be an array for ${sourcePath}`)
    if (record.kind === 'channel-kit') {
      if (bundles.length !== 1 || bundles[0].kind !== 'channel-kit' || record.bundle_id !== bundles[0].id) fail(`coordinator must have exactly one matching Channel Kit bundle for ${sourcePath}`)
      const contentInfo = await lstat(join(dirname(packPath), 'content')).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
      if (contentInfo) fail(`coordinator source must be bundle-only and contain no creative content for ${sourcePath}`)
      const components = bundles[0].components ?? []
      if (!same(components.map(({ pack_id, version }) => ({ pack_id, version })), expectedDependencies)) fail(`dependency closure differs for ${sourcePath}`)
      for (const component of components) {
        const dependency = byIdentity.get(`${component.pack_id}@${component.version}`)
        if (!dependency || dependency.item_id !== component.item_id) fail(`bundle component item_id differs for ${sourcePath}`)
        if (dependency.kind !== component.kind) fail(`bundle component kind differs for ${sourcePath}`)
      }
    } else {
      if (bundles.length) fail(`creative component ${record.kind} must not declare bundles for ${sourcePath}`)
      const contentPath = join(dirname(packPath), 'content')
      const documents = await readdir(contentPath, { withFileTypes: true }).catch(() => [])
      const jsonDocuments = documents.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      if (documents.some((entry) => entry.isSymbolicLink())) fail(`authored source ${sourcePath} must not contain content symlinks`)
      if (MULTI_ITEM_KINDS.has(record.kind)) {
        if (!jsonDocuments.length) fail(`authored source ${sourcePath} must contain at least one content document`)
        const found = []
        for (const entry of jsonDocuments) {
          const document = await readBoundedJson(join(contentPath, entry.name), MAX_CONTENT_DOCUMENT_BYTES, `content document ${sourcePath}`)
          if (record.kind !== document.kind) fail(`component identity differs for ${sourcePath}`)
          found.push(document.id)
        }
        if (!same([...found].sort(), record.item_ids)) fail(`component identity differs for ${sourcePath}`)
      } else {
        if (jsonDocuments.length !== 1) fail(`authored source ${sourcePath} must contain exactly one content document`)
        const document = await readBoundedJson(join(contentPath, jsonDocuments[0].name), MAX_CONTENT_DOCUMENT_BYTES, `content document ${sourcePath}`)
        if (record.kind !== document.kind || record.item_id !== document.id) fail(`component identity differs for ${sourcePath}`)
      }
    }
  }
  const missingAuthored = records.find((record) => record.status === 'authored' && !discovered.has(record.source_path))
  if (missingAuthored) fail(`registered authored source does not exist: ${missingAuthored.source_path}`)
}

function validateDependencyGraph(records) {
  const byIdentity = new Map(records.map((record) => [packVersion(record), record]))
  const outgoing = new Map(records.map((record) => [packVersion(record), []]))
  const indegree = new Map(records.map((record) => [packVersion(record), 0]))
  for (const record of records) {
    const node = packVersion(record)
    for (const dependency of record.dependencies) {
      const dependencyNode = packVersion(dependency)
      const target = byIdentity.get(dependencyNode)
      if (!target) fail(`unknown dependency ${dependencyNode}`)
      if (record.kind === 'channel-kit' && target.kind === 'channel-kit') fail(`coordinator ${record.pack_id} must depend only on creative components, not coordinator ${target.pack_id}`)
      if (record.kind !== 'channel-kit' && target.kind === 'channel-kit') fail(`creative pack ${record.pack_id} must not depend on coordinator ${target.pack_id}`)
      outgoing.get(dependencyNode).push(node)
      indegree.set(node, indegree.get(node) + 1)
    }
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([node]) => node)
  let visited = 0
  while (queue.length) {
    const node = queue.shift()
    visited += 1
    for (const dependent of outgoing.get(node)) {
      const degree = indegree.get(dependent) - 1
      indegree.set(dependent, degree)
      if (degree === 0) queue.push(dependent)
    }
  }
  if (visited !== records.length) fail('cyclic dependency closure is not permitted')
  for (const record of records.filter((candidate) => candidate.kind === 'channel-kit')) {
    const kinds = record.dependencies.map((dependency) => byIdentity.get(`${dependency.pack_id}@${dependency.version}`).kind)
    if (kinds.filter((kind) => kind === 'series-formula').length !== 1 || !kinds.includes('topic-pack') || !kinds.includes('visual-style') || !kinds.includes('thumbnail-recipe')) fail(`coordinator dependency closure is incomplete for ${record.pack_id}`)
  }
}

function immutableIdentity(record) {
  return {
    pack_id: record.pack_id,
    ...(record.item_id
      ? { item_id: record.item_id }
      : record.item_ids
        ? { item_ids: record.item_ids }
        : { bundle_id: record.bundle_id }),
    version: record.version,
    publisher_id: record.publisher_id,
    min_app_version: record.min_app_version,
    min_app_version_status: record.min_app_version_status,
    kind: record.kind,
    source_path: record.source_path,
    dependencies: record.dependencies,
    stocking_proposal: {
      family: { id: record.stocking_proposal.family.id },
      sku: { id: record.stocking_proposal.sku.id },
    },
  }
}

function mutableLifecycle(record) {
  return {
    status: record.status,
    stocking_proposal: record.stocking_proposal,
  }
}

function bindReceipts(records, batches, transitions) {
  const authoringRecords = new Map()
  for (const record of records) {
    if (!AUTHORING_RECEIPT.test(record.receipt_ref)) continue
    const list = authoringRecords.get(record.receipt_ref) ?? []
    list.push(record)
    authoringRecords.set(record.receipt_ref, list)
  }
  for (const batch of batches) {
    const current = authoringRecords.get(batch.receipt_ref) ?? []
    if (current.length !== batch.request.records.length) fail(`receipt ${batch.receipt_ref} identity count differs from persisted metadata`)
    for (const expected of batch.request.records) {
      const match = current.find((record) => record.pack_id === expected.pack_id && record.version === expected.version)
      if (!match || !same(immutableIdentity(match), immutableIdentity(expected))) fail(`receipt ${batch.receipt_ref} identity differs from persisted metadata for pack_id ${expected.pack_id}`)
    }
    authoringRecords.delete(batch.receipt_ref)
  }
  if (authoringRecords.size) fail(`authoring receipt has no persisted batch metadata: ${authoringRecords.keys().next().value}`)

  const lifecycle = new Map()
  for (const batch of [...batches].sort((left, right) => left.revision - right.revision)) {
    for (const record of batch.request.records) lifecycle.set(`${batch.receipt_ref}:${record.pack_id}@${record.version}`, record)
  }
  // Baseline records predate the receipt journal: they were entered at genesis
  // as `authored`, with no batch to replay them from. Seed them at that genesis
  // status so their one permitted event — retirement — is replayed like any
  // other, instead of being an unjournaled edit nobody checks.
  for (const record of records) {
    if (AUTHORING_RECEIPT.test(record.receipt_ref)) continue
    lifecycle.set(`${record.receipt_ref}:${record.pack_id}@${record.version}`, { ...record, status: 'authored' })
  }
  for (const transition of [...transitions].sort((left, right) => left.revision - right.revision)) {
    const request = transition.request
    const key = `${request.receipt_ref}:${request.pack_id}@${request.version}`
    const record = lifecycle.get(key)
    if (!record) fail(`lifecycle transition target is not bound to receipt ${request.receipt_ref}`)
    lifecycle.set(key, applyLifecycleTransition(record, request.changes, { replay: true }))
  }
  for (const record of records) {
    const expected = lifecycle.get(`${record.receipt_ref}:${record.pack_id}@${record.version}`)
    if (!expected || !same(mutableLifecycle(record), mutableLifecycle(expected))) {
      fail(`receipt ${record.receipt_ref} lifecycle differs from persisted mutation metadata for pack_id ${record.pack_id}`)
    }
  }
}

async function validateRegistryDocument(registry, repositoryRoot, { retiringSourcePath } = {}) {
  assertBoundedJson(registry, 'registry', MAX_REGISTRY_BYTES)
  exactFields(registry, new Set(['revision', 'batches', 'transitions', 'records']), 'registry')
  if (!Number.isSafeInteger(registry.revision) || registry.revision < 1) fail('revision must be a positive integer')
  if (!Array.isArray(registry.records)) fail('records must be an array')
  if (registry.records.length > MAX_REGISTRY_RECORDS) fail(`registry records must not exceed ${MAX_REGISTRY_RECORDS}`)
  const records = registry.records.map((record, index) => validateRecord(record, index))
  const batches = validateBatches(registry.batches)
  const transitions = validateTransitions(registry.transitions)
  validateRevisionEvents(registry.revision, batches, transitions)
  unique(records, 'pack_id@version', packVersion)
  unique(records.flatMap((record) => (record.item_ids ?? (record.item_id ? [record.item_id] : []))
    .map((itemId) => ({ item_id: itemId, version: record.version }))),
    'item_id@version', (record) => `${record.item_id}@${record.version}`)
  unique(records.filter((record) => record.bundle_id), 'bundle_id@version', (record) => `${record.bundle_id}@${record.version}`)
  unique(records, 'source_path', (record) => record.source_path)
  validateLineages(records)
  bindReceipts(records, batches, transitions)
  validateDependencyGraph(records)
  const resolvedRoot = resolve(repositoryRoot)
  for (const record of records) await assertSafeSourcePath(resolvedRoot, record, { retiringSourcePath })
  await reconcileSources(records, resolvedRoot)
  return { revision: registry.revision, batches, transitions, records }
}

export async function validateAuthoringRegistry({ registryPath = join(root, 'content-packs/authoring-registry.json'), repositoryRoot = root } = {}) {
  return validateRegistryDocument(await readBoundedJson(registryPath, MAX_REGISTRY_BYTES, 'registry'), repositoryRoot)
}

async function withRegistryLock(registryPath, action) {
  let handle
  try {
    handle = await open(`${registryPath}.lock`, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') fail('reservation already in progress; rebase and retry')
    throw error
  }
  try {
    return await action()
  } finally {
    await handle.close()
    await unlink(`${registryPath}.lock`).catch(() => {})
  }
}

async function atomicWrite(path, bytes) {
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-authoring-registry.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function reserveAuthoringBatch({ registryPath = join(root, 'content-packs/authoring-registry.json'), repositoryRoot = root, request } = {}) {
  const accepted = reservationRequest(request)
  if (accepted.records.some((record) => record.kind === 'channel-kit')) {
    fail('new Channel Kit reservations are refused; historical Channel Kits are read-only')
  }
  return withRegistryLock(registryPath, async () => {
    const current = await readBoundedJson(registryPath, MAX_REGISTRY_BYTES, 'registry')
    const validated = await validateRegistryDocument(current, repositoryRoot)
    if (validated.revision !== accepted.expected_revision) fail(`stale expected revision ${accepted.expected_revision}; current revision is ${validated.revision}`)
    for (const record of accepted.records) {
      const closed = validated.records.find((candidate) => (
        candidate.pack_id === record.pack_id
        && TERMINAL_STATUSES.has(candidate.status)
      ))
      if (closed) fail(`${closed.status} pack_id ${record.pack_id} may not gain reservation ${record.version}`)
    }
    const receipt_ref = receiptFor(accepted)
    const records = accepted.records.map((record) => ({ receipt_ref, ...record }))
    const revision = validated.revision + 1
    const next = {
      revision,
      batches: [...validated.batches, { revision, receipt_ref, request: accepted }],
      transitions: validated.transitions,
      records: [...validated.records, ...records],
    }
    await validateRegistryDocument(next, repositoryRoot)
    await atomicWrite(registryPath, `${JSON.stringify(next, null, 2)}\n`)
    return { revision, receipt_ref }
  })
}

export async function transitionAuthoringRecord({ registryPath = join(root, 'content-packs/authoring-registry.json'), repositoryRoot = root, request } = {}) {
  const accepted = transitionRequest(request)
  return withRegistryLock(registryPath, async () => {
    const current = await readBoundedJson(registryPath, MAX_REGISTRY_BYTES, 'registry')
    const validated = await validateRegistryDocument(current, repositoryRoot)
    if (validated.revision !== accepted.expected_revision) fail(`stale expected revision ${accepted.expected_revision}; current revision is ${validated.revision}`)
    const index = validated.records.findIndex((record) => record.receipt_ref === accepted.receipt_ref
      && record.pack_id === accepted.pack_id && record.version === accepted.version)
    if (index < 0) fail(`lifecycle transition target is not bound to receipt ${accepted.receipt_ref}`)
    const records = [...validated.records]
    const retiringSourcePath = accepted.changes.status === 'retired' ? records[index].source_path : undefined
    records[index] = applyLifecycleTransition(records[index], accepted.changes)
    const revision = validated.revision + 1
    const transition_ref = transitionFor(accepted)
    const next = {
      revision,
      batches: validated.batches,
      transitions: [...validated.transitions, { revision, transition_ref, request: accepted }],
      records,
    }
    await validateRegistryDocument(next, repositoryRoot, { retiringSourcePath })
    await atomicWrite(registryPath, `${JSON.stringify(next, null, 2)}\n`)
    return { revision, transition_ref }
  })
}

export async function verifyAuthoringReceipt({ registryPath = join(root, 'content-packs/authoring-registry.json'), repositoryRoot = root, revision, receiptRef, expectedIdentity } = {}) {
  const validated = await validateAuthoringRegistry({ registryPath, repositoryRoot })
  if (!Number.isSafeInteger(revision) || revision < 2) fail('receipt revision must be an integer of at least 2')
  if (typeof receiptRef !== 'string' || !AUTHORING_RECEIPT.test(receiptRef)) fail('receipt reference must be a valid authoring receipt')
  const batch = validated.batches.find((candidate) => candidate.revision === revision && candidate.receipt_ref === receiptRef)
  if (!batch) fail('receipt revision or receipt reference does not match a persisted batch')
  const identity = validateRecord(expectedIdentity, 0, { request: true })
  const accepted = batch.request.records.find((candidate) => same(candidate, identity))
  if (!accepted) fail('receipt expected identity does not match the persisted batch')
  return { revision, receipt_ref: receiptRef, identity: accepted }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'validate' && process.argv.length === 3) {
    const result = await validateAuthoringRegistry()
    process.stdout.write(`authoring registry revision ${result.revision}: ${result.records.length} records\n`)
  } else if (process.argv[2] === 'reserve' && process.argv[3] === '--request' && process.argv[4] && process.argv.length === 5) {
    const request = await readBoundedJson(resolve(process.argv[4]), MAX_REQUEST_BYTES, 'reservation request file')
    process.stdout.write(`${JSON.stringify(await reserveAuthoringBatch({ request }))}\n`)
  } else if (process.argv[2] === 'transition' && process.argv[3] === '--request' && process.argv[4] && process.argv.length === 5) {
    const request = await readBoundedJson(resolve(process.argv[4]), MAX_REQUEST_BYTES, 'lifecycle transition request file')
    process.stdout.write(`${JSON.stringify(await transitionAuthoringRecord({ request }))}\n`)
  } else if (process.argv[2] === 'verify-receipt' && process.argv[3] === '--revision' && process.argv[4]
    && process.argv[5] === '--receipt' && process.argv[6] && process.argv[7] === '--expected-identity'
    && process.argv[8] && process.argv.length === 9) {
    const expectedIdentity = await readBoundedJson(resolve(process.argv[8]), MAX_REQUEST_BYTES, 'expected identity file')
    process.stdout.write(`${JSON.stringify(await verifyAuthoringReceipt({
      revision: Number(process.argv[4]),
      receiptRef: process.argv[6],
      expectedIdentity,
    }))}\n`)
  } else {
    fail('usage: authoring-registry.mjs validate | reserve --request <path> | transition --request <path> | verify-receipt --revision <revision> --receipt <receipt_ref> --expected-identity <path>')
  }
}
