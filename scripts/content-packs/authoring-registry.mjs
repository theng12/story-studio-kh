import { open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RECORD_FIELDS = new Set([
  'receipt_ref', 'pack_id', 'item_id', 'bundle_id', 'version', 'publisher_id',
  'min_app_version', 'min_app_version_status', 'kind', 'source_path', 'status',
  'dependencies', 'stocking_proposal',
])
const CREATIVE_KINDS = new Set(['series-formula', 'topic-pack', 'visual-style', 'thumbnail-recipe'])
const STATUSES = new Set(['authored', 'reserved'])
const PROPOSAL_STATUSES = new Set(['proposed', 'reserved', 'confirmed'])
const MIN_APP_VERSION_STATUSES = new Set(['release-bound', 'fixed'])
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

function nonempty(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string`)
  return value
}

function canonicalDependencies(value, label) {
  if (!Array.isArray(value)) fail(`${label} dependencies must be an array`)
  const seen = new Set()
  return value.map((dependency, index) => {
    exactFields(dependency, new Set(['pack_id', 'version']), `${label} dependency ${index}`)
    const packId = nonempty(dependency.pack_id, `${label} dependency ${index} pack_id`)
    const version = nonempty(dependency.version, `${label} dependency ${index} version`)
    const identity = `${packId}@${version}`
    if (seen.has(identity)) fail(`duplicate dependency ${identity} in ${label}`)
    seen.add(identity)
    return { pack_id: packId, version }
  })
}

function proposal(value, label) {
  exactFields(value, new Set(['id', 'status', 'confirmation_ref']), label)
  const id = nonempty(value.id, `${label} id`)
  if (!PROPOSAL_STATUSES.has(value.status)) fail(`${label} has invalid status`)
  if (value.status === 'confirmed') nonempty(value.confirmation_ref, `${label} confirmation_ref`)
  else if ('confirmation_ref' in value) fail(`${label} confirmation_ref is only allowed when confirmed`)
  return { id, status: value.status, ...(value.status === 'confirmed' ? { confirmation_ref: value.confirmation_ref } : {}) }
}

function validateRecord(record, index) {
  const label = `record ${index}`
  exactFields(record, RECORD_FIELDS, label)
  for (const field of ['receipt_ref', 'pack_id', 'version', 'publisher_id', 'min_app_version', 'source_path']) nonempty(record[field], `${label} ${field}`)
  if (!MIN_APP_VERSION_STATUSES.has(record.min_app_version_status)) fail(`${label} has invalid min_app_version_status`)
  if (!STATUSES.has(record.status)) fail(`${label} has invalid status`)
  if (typeof record.kind !== 'string' || (!CREATIVE_KINDS.has(record.kind) && record.kind !== 'channel-kit')) fail(`${label} has invalid kind`)
  const hasItem = typeof record.item_id === 'string'
  const hasBundle = typeof record.bundle_id === 'string'
  if (record.kind === 'channel-kit' ? hasItem || !hasBundle : !hasItem || hasBundle) fail(`${label} has an invalid coordinator/leaf identity shape`)
  if (hasItem) nonempty(record.item_id, `${label} item_id`)
  if (hasBundle) nonempty(record.bundle_id, `${label} bundle_id`)
  if (record.source_path.startsWith('/') || record.source_path.split(/[\\/]/).includes('..')) fail(`${label} source_path must be repository-relative`)
  exactFields(record.stocking_proposal, new Set(['family', 'sku']), `${label} stocking_proposal`)
  return {
    receipt_ref: record.receipt_ref,
    pack_id: record.pack_id,
    ...(hasItem ? { item_id: record.item_id } : { bundle_id: record.bundle_id }),
    version: record.version,
    publisher_id: record.publisher_id,
    min_app_version: record.min_app_version,
    min_app_version_status: record.min_app_version_status,
    kind: record.kind,
    source_path: record.source_path,
    status: record.status,
    dependencies: canonicalDependencies(record.dependencies, label),
    stocking_proposal: {
      family: proposal(record.stocking_proposal.family, `${label} family`),
      sku: proposal(record.stocking_proposal.sku, `${label} sku`),
    },
  }
}

function unique(records, field) {
  const seen = new Set()
  for (const record of records) {
    const value = field(record)
    if (seen.has(value)) fail(`duplicate ${field.name || 'identity'} ${value}`)
    seen.add(value)
  }
}

async function packPaths(repositoryRoot) {
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true })
    return (await Promise.all(entries.map((entry) => {
      const child = join(path, entry.name)
      if (entry.isDirectory()) return visit(child)
      return entry.name === 'pack.json' ? [child] : []
    }))).flat()
  }
  return (await Promise.all([
    visit(join(repositoryRoot, 'content-packs/free-starters')),
    visit(join(repositoryRoot, 'content-packs/paid/archival-ledger')),
  ])).flat().sort()
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function reconcileAuthored(records, repositoryRoot) {
  const paths = await packPaths(repositoryRoot)
  const authored = records.filter((record) => record.status === 'authored')
  if (paths.length !== authored.length) fail(`authored source reconciliation expected ${paths.length} records, found ${authored.length}`)
  const bySource = new Map(authored.map((record) => [record.source_path, record]))
  for (const packPath of paths) {
    const sourcePath = relative(repositoryRoot, dirname(packPath)).split(sep).join('/')
    const record = bySource.get(sourcePath)
    if (!record) fail(`authored source ${sourcePath} is not registered`)
    const manifest = JSON.parse(await readFile(packPath, 'utf8'))
    const expectedDependencies = manifest.dependencies ?? []
    if (!same(record.dependencies, expectedDependencies)) fail(`dependency closure differs for ${sourcePath}`)
    if (record.pack_id !== manifest.pack_id || record.version !== manifest.version || record.publisher_id !== manifest.publisher_id || record.min_app_version !== manifest.min_app_version) fail(`identity differs for ${sourcePath}`)
    if (record.stocking_proposal.family.id !== manifest.entitlement?.family || record.stocking_proposal.sku.id !== manifest.entitlement?.sku) fail(`stocking proposal differs for ${sourcePath}`)
    const bundles = manifest.bundles ?? []
    if (bundles.length) {
      if (bundles.length !== 1 || record.kind !== bundles[0].kind || record.bundle_id !== bundles[0].id) fail(`coordinator identity differs for ${sourcePath}`)
      const components = bundles[0].components ?? []
      if (!same(components.map(({ pack_id, version }) => ({ pack_id, version })), expectedDependencies)) fail(`dependency closure differs for ${sourcePath}`)
    } else {
      const contentPath = join(dirname(packPath), 'content')
      const documents = (await readdir(contentPath)).filter((name) => name.endsWith('.json'))
      if (documents.length !== 1) fail(`authored source ${sourcePath} must contain exactly one content document`)
      const document = JSON.parse(await readFile(join(contentPath, documents[0]), 'utf8'))
      if (record.kind !== document.kind || record.item_id !== document.id) fail(`component identity differs for ${sourcePath}`)
    }
    bySource.delete(sourcePath)
  }
  if (bySource.size) fail(`registered authored source does not exist: ${[...bySource.keys()][0]}`)
}

async function validateRegistryDocument(registry, repositoryRoot) {
  exactFields(registry, new Set(['revision', 'records']), 'registry')
  if (!Number.isSafeInteger(registry.revision) || registry.revision < 1) fail('revision must be a positive integer')
  if (!Array.isArray(registry.records)) fail('records must be an array')
  const records = registry.records.map(validateRecord)
  unique(records, function pack_id(record) { return record.pack_id })
  unique(records.filter((record) => record.item_id), function item_id(record) { return record.item_id })
  unique(records.filter((record) => record.bundle_id), function bundle_id(record) { return record.bundle_id })
  unique(records, function source_path(record) { return record.source_path })
  unique(records, function family(record) { return record.stocking_proposal.family.id })
  unique(records, function sku(record) { return record.stocking_proposal.sku.id })
  const identities = new Set(records.map((record) => `${record.pack_id}@${record.version}`))
  for (const record of records) for (const dependency of record.dependencies) if (!identities.has(`${dependency.pack_id}@${dependency.version}`)) fail(`unknown dependency ${dependency.pack_id}@${dependency.version}`)
  const byIdentity = new Map(records.map((record) => [`${record.pack_id}@${record.version}`, record]))
  for (const record of records.filter((record) => record.kind === 'channel-kit')) {
    const kinds = record.dependencies.map((dependency) => byIdentity.get(`${dependency.pack_id}@${dependency.version}`).kind)
    if (kinds.filter((kind) => kind === 'series-formula').length !== 1 || !kinds.includes('topic-pack') || !kinds.includes('visual-style') || !kinds.includes('thumbnail-recipe')) fail(`coordinator dependency closure is incomplete for ${record.pack_id}`)
  }
  await reconcileAuthored(records, resolve(repositoryRoot))
  return { revision: registry.revision, records }
}

export async function validateAuthoringRegistry({ registryPath = join(root, 'content-packs/authoring-registry.json'), repositoryRoot = root } = {}) {
  return validateRegistryDocument(JSON.parse(await readFile(registryPath, 'utf8')), repositoryRoot)
}

function reservationRecord(record, index) {
  exactFields(record, new Set([...RECORD_FIELDS].filter((field) => field !== 'receipt_ref')), `request record ${index}`)
  return validateRecord({ ...record, receipt_ref: 'pending' }, index)
}

function reservationRequest(request) {
  exactFields(request, new Set(['expected_revision', 'coordinator', 'proposal_ref', 'records']), 'reservation request')
  if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 1) fail('expected_revision must be a positive integer')
  exactFields(request.coordinator, new Set(['task', 'branch']), 'reservation coordinator')
  nonempty(request.coordinator.task, 'reservation coordinator task')
  nonempty(request.coordinator.branch, 'reservation coordinator branch')
  nonempty(request.proposal_ref, 'reservation proposal_ref')
  if (!Array.isArray(request.records) || !request.records.length) fail('reservation records must be a non-empty array')
  return {
    expected_revision: request.expected_revision,
    coordinator: { task: request.coordinator.task, branch: request.coordinator.branch },
    proposal_ref: request.proposal_ref,
    records: request.records.map(reservationRecord),
  }
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
  return withRegistryLock(registryPath, async () => {
    const current = JSON.parse(await readFile(registryPath, 'utf8'))
    const validated = await validateRegistryDocument(current, repositoryRoot)
    if (validated.revision !== accepted.expected_revision) fail(`stale expected revision ${accepted.expected_revision}; current revision is ${validated.revision}`)
    const receipt_ref = `authoring:${createHash('sha256').update(canonical(accepted)).digest('hex')}`
    const records = accepted.records.map((record) => ({ ...record, receipt_ref }))
    const next = { revision: validated.revision + 1, records: [...validated.records, ...records] }
    await validateRegistryDocument(next, repositoryRoot)
    await atomicWrite(registryPath, `${JSON.stringify(next, null, 2)}\n`)
    return { revision: next.revision, receipt_ref }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'validate') {
    const result = await validateAuthoringRegistry()
    process.stdout.write(`authoring registry revision ${result.revision}: ${result.records.length} records\n`)
  } else if (process.argv[2] === 'reserve' && process.argv[3] === '--request' && process.argv[4] && process.argv.length === 5) {
    process.stdout.write(`${JSON.stringify(await reserveAuthoringBatch({ request: JSON.parse(await readFile(process.argv[4], 'utf8')) }))}\n`)
  } else {
    fail('usage: authoring-registry.mjs validate | reserve --request <path>')
  }
}
