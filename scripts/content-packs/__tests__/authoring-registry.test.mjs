import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const registryPath = join(repositoryRoot, 'content-packs', 'authoring-registry.json')
const registryModule = new URL('../authoring-registry.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), 'story-authoring-registry-'))
  await cp(join(repositoryRoot, 'content-packs'), join(root, 'content-packs'), { recursive: true })
  return root
}

async function registrySnapshot(path) {
  const registry = JSON.parse(await readFile(path, 'utf8'))
  return {
    revision: registry.revision,
    recordCount: registry.records.length,
    batchCount: registry.batches.length,
    transitionCount: registry.transitions.length,
  }
}

test('reconciles the strict 65-pack authored registry against source manifests', async () => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const result = await validateAuthoringRegistry({ registryPath, repositoryRoot })

  const authored = result.records.filter((record) => record.status === 'authored')
  assert.equal(result.revision, JSON.parse(await readFile(registryPath, 'utf8')).revision)
  assert.equal(authored.length, 65)
  assert.equal(authored.filter((record) => record.item_id).length, 48)
  assert.equal(authored.filter((record) => record.bundle_id).length, 17)
})

test('rejects unknown, duplicate, and GenStudio-owned registry fields before source reconciliation', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const registry = JSON.parse(await readFile(copy, 'utf8'))

  registry.records[0].product_id = 'genstudio-product-id'
  await writeFile(copy, JSON.stringify(registry), 'utf8')
  await assert.rejects(
    validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
    /unknown or forbidden field.*product_id/i,
  )

  delete registry.records[0].product_id
  registry.records[1].pack_id = registry.records[0].pack_id
  registry.records[1].receipt_ref = registry.records[0].receipt_ref
  await writeFile(copy, JSON.stringify(registry), 'utf8')
  await assert.rejects(
    validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
    /duplicate pack_id/i,
  )
})

test('rejects authored records whose exact source identity or dependency closure differs', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  registry.records[0].dependencies = [{ pack_id: registry.records[1].pack_id, version: registry.records[1].version }]
  await writeFile(copy, JSON.stringify(registry), 'utf8')

  await assert.rejects(
    validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
    /dependency closure/i,
  )
})

function reservationRequest(expectedRevision) {
  return {
    expected_revision: expectedRevision,
    coordinator: { task: 'content-pack-authoring', branch: 'codex/reserve-content-pack' },
    proposal_ref: 'proposal:reserved-style',
    records: [{
      pack_id: 'com.storystudio.pack.style.reserved-style',
      item_id: 'com.storystudio.style.reserved-style',
      version: '1.0.0',
      publisher_id: 'com.storystudio',
      min_app_version: '{{MIN_APP_VERSION}}',
      min_app_version_status: 'release-bound',
      kind: 'visual-style',
      source_path: 'content-packs/reserved/style/reserved-style',
      status: 'reserved',
      dependencies: [],
      stocking_proposal: {
        family: { id: 'com.storystudio.family.style.reserved-style', status: 'reserved' },
        sku: { id: 'com.storystudio.sku.style.reserved-style', status: 'reserved' },
      },
    }],
  }
}

function reservationRecord(kind, slug) {
  const kindNames = {
    'series-formula': 'formula',
    'topic-pack': 'topic',
    'visual-style': 'style',
    'thumbnail-recipe': 'thumbnail',
  }
  const name = kindNames[kind]
  return {
    pack_id: `com.storystudio.pack.${name}.${slug}`,
    item_id: `com.storystudio.${name}.${slug}`,
    version: '1.0.0',
    publisher_id: 'com.storystudio',
    min_app_version: '{{MIN_APP_VERSION}}',
    min_app_version_status: 'release-bound',
    kind,
    source_path: `content-packs/reserved/${name}/${slug}`,
    status: 'reserved',
    dependencies: [],
    stocking_proposal: {
      family: { id: `com.storystudio.family.${name}.${slug}`, status: 'reserved' },
      sku: { id: `com.storystudio.sku.${name}.${slug}`, status: 'reserved' },
    },
  }
}

function successorReservation(record, expectedRevision, version = '1.0.1') {
  const { receipt_ref, ...requestRecord } = structuredClone(record)
  return {
    expected_revision: expectedRevision,
    coordinator: { task: 'content-pack-authoring', branch: 'codex/versioned-authoring-identities' },
    proposal_ref: `proposal:successor:${record.pack_id}@${version}`,
    records: [{
      ...requestRecord,
      version,
      status: 'reserved',
      source_path: `${record.source_path}-v${version.replaceAll('.', '-')}`,
    }],
  }
}

async function materializeReservedStyle(root, record) {
  const destination = join(root, record.source_path)
  await cp(join(root, 'content-packs', 'free-starters', 'style', 'cinematic-photoreal'), destination, { recursive: true })
  const manifestPath = join(destination, 'pack.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  Object.assign(manifest, {
    pack_id: record.pack_id,
    version: record.version,
    publisher_id: record.publisher_id,
    min_app_version: record.min_app_version,
    entitlement: {
      family: record.stocking_proposal.family.id,
      sku: record.stocking_proposal.sku.id,
    },
  })
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  const documentPath = join(destination, 'content', 'visual-style.json')
  const document = JSON.parse(await readFile(documentPath, 'utf8'))
  document.id = record.item_id
  await writeFile(documentPath, JSON.stringify(document), 'utf8')
}

function transitionRequest(reservation, expectedRevision, changes) {
  return {
    expected_revision: expectedRevision,
    coordinator: { task: 'content-pack-authoring', branch: 'codex/reserve-content-pack' },
    receipt_ref: reservation.receipt_ref,
    pack_id: reservation.record.pack_id,
    version: reservation.record.version,
    changes,
  }
}

test('reserves a complete batch once with a deterministic receipt', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const initial = await registrySnapshot(copy)
  const request = reservationRequest(initial.revision)
  request.records.push({
    ...structuredClone(request.records[0]),
    pack_id: 'com.storystudio.pack.topic.reserved-topic',
    item_id: 'com.storystudio.topic.reserved-topic',
    kind: 'topic-pack',
    source_path: 'content-packs/reserved/topic/reserved-topic',
    stocking_proposal: {
      family: { id: 'com.storystudio.family.topic.reserved-topic', status: 'reserved' },
      sku: { id: 'com.storystudio.sku.topic.reserved-topic', status: 'reserved' },
    },
  })

  const result = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  assert.equal(result.revision, initial.revision + 1)
  assert.match(result.receipt_ref, /^authoring:[a-f0-9]{64}$/)
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  assert.equal(registry.revision, initial.revision + 1)
  assert.equal(registry.records.length, initial.recordCount + 2)
  assert.equal(registry.records.at(-1).receipt_ref, result.receipt_ref)
  assert.equal(registry.records.at(-2).receipt_ref, result.receipt_ref)
  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservationRequest(initial.revision) }),
    /stale expected revision/i,
  )
})

test('reserves a stable leaf successor without changing its historical version or receipt', async (t) => {
  const { reserveAuthoringBatch, verifyAuthoringReceipt } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const before = JSON.parse(await readFile(copy, 'utf8'))
  const original = before.records.find((record) => record.pack_id === 'com.storystudio.pack.style.cinematic-photoreal')
  const request = successorReservation(original, before.revision)

  const result = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  const after = JSON.parse(await readFile(copy, 'utf8'))
  const historical = after.records.find((record) => record.pack_id === original.pack_id && record.version === original.version)
  const successor = after.records.find((record) => record.pack_id === original.pack_id && record.version === '1.0.1')

  assert.deepEqual(historical, original)
  assert.deepEqual(successor, { receipt_ref: result.receipt_ref, ...request.records[0] })
  assert.notEqual(successor.source_path, historical.source_path)
  assert.deepEqual(await verifyAuthoringReceipt({
    registryPath: copy,
    repositoryRoot: root,
    revision: result.revision,
    receiptRef: result.receipt_ref,
    expectedIdentity: request.records[0],
  }), { revision: result.revision, receipt_ref: result.receipt_ref, identity: request.records[0] })
})

test('keeps versioned identity lineages exclusive and exact without mutating failed reservations', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  const original = registry.records.find((record) => record.pack_id === 'com.storystudio.pack.style.cinematic-photoreal')
  const accepted = successorReservation(original, registry.revision)
  const successor = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: accepted })
  const before = await readFile(copy)
  const baseRequest = () => successorReservation(original, successor.revision, '1.0.2')
  const crossPackRequest = () => {
    const request = reservationRequest(successor.revision)
    request.records[0].version = '1.0.2'
    request.records[0].source_path = 'content-packs/reserved/style/reserved-style-v1-0-2'
    return request
  }
  const cases = [
    ['same version', () => successorReservation(original, successor.revision, '1.0.1'), /duplicate pack_id@version/i],
    ['same source', () => ({ ...baseRequest(), records: [{ ...baseRequest().records[0], source_path: original.source_path }] }), /duplicate source_path/i],
    ['different publisher', () => ({ ...baseRequest(), records: [{ ...baseRequest().records[0], publisher_id: 'outside-authority' }] }), /publisher_id.*com\.storystudio/i],
    ['different kind', () => ({ ...baseRequest(), records: [{ ...baseRequest().records[0], kind: 'thumbnail-recipe' }] }), /pack_id.*namespace/i],
    ['different item', () => ({ ...baseRequest(), records: [{ ...baseRequest().records[0], item_id: 'com.storystudio.style.other' }] }), /lineage.*item_id|item_id.*lineage/i],
    ['different family', () => ({ ...baseRequest(), records: [{ ...baseRequest().records[0], stocking_proposal: { ...baseRequest().records[0].stocking_proposal, family: { id: 'com.storystudio.family.style.other', status: 'reserved' } } }] }), /lineage.*family|family.*lineage/i],
    ['different SKU', () => ({ ...baseRequest(), records: [{ ...baseRequest().records[0], stocking_proposal: { ...baseRequest().records[0].stocking_proposal, sku: { id: 'com.storystudio.sku.style.other', status: 'reserved' } } }] }), /lineage.*sku|sku.*lineage/i],
    ['cross-pack item', () => {
      const request = crossPackRequest()
      request.records[0].item_id = original.item_id
      return request
    }, /item_id.*different pack|different pack.*item_id/i],
    ['cross-pack family', () => {
      const request = crossPackRequest()
      request.records[0].stocking_proposal.family.id = original.stocking_proposal.family.id
      return request
    }, /family.*different pack|different pack.*family/i],
    ['cross-pack SKU', () => {
      const request = crossPackRequest()
      request.records[0].stocking_proposal.sku.id = original.stocking_proposal.sku.id
      return request
    }, /sku.*different pack|different pack.*sku/i],
  ]
  for (const [, request, error] of cases) {
    await assert.rejects(reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: request() }), error)
    assert.deepEqual(await readFile(copy), before)
  }
})

test('uses version-qualified dependency nodes while rejecting every same-pack self dependency', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  const original = registry.records.find((record) => record.pack_id === 'com.storystudio.pack.style.cinematic-photoreal')
  const self = successorReservation(original, registry.revision)
  self.records[0].dependencies = [{ pack_id: original.pack_id, version: original.version }]
  const initialBytes = await readFile(copy)
  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: self }),
    /depend on itself/i,
  )
  assert.deepEqual(await readFile(copy), initialBytes)

  const firstA = reservationRecord('visual-style', 'version-node-a')
  const firstB = reservationRecord('visual-style', 'version-node-b')
  const secondA = {
    ...structuredClone(firstA),
    version: '1.0.1',
    source_path: 'content-packs/reserved/style/version-node-a-v1-0-1',
    dependencies: [{ pack_id: firstB.pack_id, version: '1.0.1' }],
  }
  const secondB = {
    ...structuredClone(firstB),
    version: '1.0.1',
    source_path: 'content-packs/reserved/style/version-node-b-v1-0-1',
    dependencies: [{ pack_id: firstA.pack_id, version: '1.0.0' }],
  }
  const exactVersions = {
    expected_revision: registry.revision,
    coordinator: { task: 'content-pack-authoring', branch: 'codex/versioned-authoring-identities' },
    proposal_ref: 'proposal:version-qualified-dependencies',
    records: [firstA, secondA, firstB, secondB],
  }
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: exactVersions })
  assert.equal(reserved.revision, registry.revision + 1)

  const beforeCycle = await readFile(copy)
  const cycle = {
    ...exactVersions,
    expected_revision: reserved.revision,
    records: [
      { ...structuredClone(firstA), version: '1.0.2', source_path: 'content-packs/reserved/style/version-node-a-v1-0-2', dependencies: [{ pack_id: firstB.pack_id, version: '1.0.2' }] },
      { ...structuredClone(firstB), version: '1.0.2', source_path: 'content-packs/reserved/style/version-node-b-v1-0-2', dependencies: [{ pack_id: firstA.pack_id, version: '1.0.2' }] },
    ],
  }
  await assert.rejects(reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: cycle }), /cyclic dependency/i)
  assert.deepEqual(await readFile(copy), beforeCycle)
})

test('leaves registry bytes unchanged for stale, colliding, malformed, unknown, and GenStudio-owned requests', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const initial = await registrySnapshot(copy)
  const cases = [
    ['stale', (request) => { request.expected_revision = initial.revision + 1 }, /stale expected revision/i],
    ['pack collision', (request) => { request.records[0].pack_id = 'com.storystudio.pack.style.cinematic-photoreal' }, /duplicate pack_id/i],
    ['item collision', (request) => { request.records[0].item_id = 'com.storystudio.style.cinematic-photoreal' }, /duplicate item_id/i],
    ['bundle collision', (request) => {
      delete request.records[0].item_id
      request.records[0].kind = 'channel-kit'
      request.records[0].bundle_id = 'com.storystudio.bundle.deep-time'
      request.records[0].pack_id = 'com.storystudio.pack.kit.reserved-style'
      request.records[0].stocking_proposal.family.id = 'com.storystudio.family.kit.reserved-style'
      request.records[0].stocking_proposal.sku.id = 'com.storystudio.sku.kit.reserved-style'
    }, /duplicate bundle_id/i],
    ['family collision', (request) => { request.records[0].stocking_proposal.family.id = 'com.storystudio.family.style.cinematic-photoreal' }, /duplicate family/i],
    ['sku collision', (request) => { request.records[0].stocking_proposal.sku.id = 'com.storystudio.sku.style.cinematic-photoreal' }, /duplicate sku/i],
    ['malformed dependency', (request) => { request.records[0].dependencies = [{ pack_id: 'com.storystudio.pack.missing', version: '1.0.0' }] }, /unknown dependency/i],
    ['unknown field', (request) => { request.records[0].unknown = true }, /unknown or forbidden field/i],
    ['GenStudio field', (request) => { request.records[0].product_id = 'product' }, /unknown or forbidden field.*product_id/i],
  ]
  for (const [, mutate, error] of cases) {
    const request = reservationRequest(initial.revision)
    mutate(request)
    await assert.rejects(reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }), error)
    assert.deepEqual(await readFile(copy), original)
  }
})

test('concurrent reservations from the same revision allow at most one success', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const initial = await registrySnapshot(copy)
  const results = await Promise.allSettled([
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservationRequest(initial.revision) }),
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservationRequest(initial.revision) }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(JSON.parse(await readFile(copy, 'utf8')).revision, initial.revision + 1)
})

test('rejects a reserved coordinator without its complete exact dependency closure', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const request = reservationRequest((await registrySnapshot(copy)).revision)
  delete request.records[0].item_id
  Object.assign(request.records[0], {
    pack_id: 'com.storystudio.pack.kit.reserved-style',
    bundle_id: 'com.storystudio.bundle.reserved-style',
    kind: 'channel-kit',
    source_path: 'content-packs/reserved/kit/reserved-style',
  })
  request.records[0].stocking_proposal.family.id = 'com.storystudio.family.kit.reserved-style'
  request.records[0].stocking_proposal.sku.id = 'com.storystudio.sku.kit.reserved-style'

  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }),
    /coordinator dependency closure/i,
  )
  assert.deepEqual(await readFile(copy), original)
})

test('persists receipt metadata and verifies a leaf exact identity', async (t) => {
  const { reserveAuthoringBatch, verifyAuthoringReceipt } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const initial = await registrySnapshot(copy)
  const request = reservationRequest(initial.revision)
  const result = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })

  const registry = JSON.parse(await readFile(copy, 'utf8'))
  assert.equal(registry.batches.length, initial.batchCount + 1)
  assert.equal(registry.batches.at(-1).revision, result.revision)
  assert.equal(registry.batches.at(-1).receipt_ref, result.receipt_ref)
  assert.deepEqual(registry.batches.at(-1).request, request)
  assert.deepEqual(await verifyAuthoringReceipt({
    registryPath: copy,
    repositoryRoot: root,
    revision: result.revision,
    receiptRef: result.receipt_ref,
    expectedIdentity: request.records[0],
  }), { revision: result.revision, receipt_ref: result.receipt_ref, identity: request.records[0] })

  for (const [label, revision, receiptRef, expectedIdentity] of [
    ['revision', result.revision + 1, result.receipt_ref, request.records[0]],
    ['receipt', result.revision, `authoring:${'0'.repeat(64)}`, request.records[0]],
    ['identity', result.revision, result.receipt_ref, { ...request.records[0], item_id: 'com.storystudio.style.tampered' }],
  ]) {
    await assert.rejects(
      verifyAuthoringReceipt({ registryPath: copy, repositoryRoot: root, revision, receiptRef, expectedIdentity }),
      new RegExp(`receipt.*${label}|${label}.*receipt`, 'i'),
    )
  }
})

test('offers a leaf-facing verify-receipt CLI with revision, receipt, and expected identity', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'scripts', 'content-packs', 'authoring-registry.mjs')
  await mkdir(dirname(script), { recursive: true })
  await cp(fileURLToPath(registryModule), script)
  const request = reservationRequest((await registrySnapshot(join(root, 'content-packs', 'authoring-registry.json'))).revision)
  const result = await reserveAuthoringBatch({
    registryPath: join(root, 'content-packs', 'authoring-registry.json'),
    repositoryRoot: root,
    request,
  })
  const expectedIdentity = join(root, 'expected-identity.json')
  await writeFile(expectedIdentity, JSON.stringify(request.records[0]), 'utf8')

  const { stdout } = await execFileAsync(process.execPath, [
    await realpath(script),
    'verify-receipt',
    '--revision', String(result.revision),
    '--receipt', result.receipt_ref,
    '--expected-identity', expectedIdentity,
  ])
  assert.deepEqual(JSON.parse(stdout), {
    revision: result.revision,
    receipt_ref: result.receipt_ref,
    identity: request.records[0],
  })
})

test('rejects tampered reserved identity fields while retaining the receipt', async (t) => {
  const { reserveAuthoringBatch, validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const initial = await registrySnapshot(copy)
  const request = reservationRequest(initial.revision)
  await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  const acceptedBytes = await readFile(copy)
  const accepted = JSON.parse(acceptedBytes)
  const cases = [
    ['pack_id', (record) => { record.pack_id = 'com.storystudio.pack.style.tampered' }],
    ['item_id', (record) => { record.item_id = 'com.storystudio.style.tampered' }],
    ['source_path', (record) => { record.source_path = 'content-packs/reserved/style/tampered' }],
    ['family', (record) => { record.stocking_proposal.family.id = 'com.storystudio.family.style.tampered' }],
    ['sku', (record) => { record.stocking_proposal.sku.id = 'com.storystudio.sku.style.tampered' }],
    ['lifecycle', (record) => { record.stocking_proposal.family = { ...record.stocking_proposal.family, status: 'confirmed', confirmation_ref: 'unpersisted' } }],
  ]
  for (const [label, mutate] of cases) {
    const tampered = structuredClone(accepted)
    mutate(tampered.records.at(-1))
    await writeFile(copy, JSON.stringify(tampered), 'utf8')
    await assert.rejects(
      validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
      new RegExp(`receipt.*${label}|${label}.*receipt|receipt.*identity`, 'i'),
    )
  }
})

test('discovers an unregistered future catalog source but excludes the retired source-only monolith', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const future = join(root, 'content-packs', 'paid', 'future-wave', 'copied-pack')
  await cp(join(root, 'content-packs', 'free-starters', 'style', 'cinematic-photoreal'), future, { recursive: true })

  await assert.rejects(
    validateAuthoringRegistry({ registryPath: join(root, 'content-packs', 'authoring-registry.json'), repositoryRoot: root }),
    /authored source .*future-wave.* is not registered/i,
  )
})

test('reconciles exact bundle component item IDs and kinds', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const manifestPath = join(root, 'content-packs', 'free-starters', 'kit', 'deep-time', 'pack.json')
  const original = JSON.parse(await readFile(manifestPath, 'utf8'))
  const cases = [
    ['item_id', (manifest) => { manifest.bundles[0].components[0].item_id = 'com.storystudio.formula.tampered' }],
    ['kind', (manifest) => { manifest.bundles[0].components[0].kind = 'topic-pack' }],
  ]
  for (const [label, mutate] of cases) {
    const manifest = structuredClone(original)
    mutate(manifest)
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    await assert.rejects(
      validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
      new RegExp(`bundle component.*${label}|${label}.*bundle component`, 'i'),
    )
  }
})

test('rejects a registered Channel Kit disguised as creative content when its bundle is removed', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')

  const kitRoot = join(root, 'content-packs', 'free-starters', 'kit', 'deep-time')
  const kitManifestPath = join(kitRoot, 'pack.json')
  const kitManifest = JSON.parse(await readFile(kitManifestPath, 'utf8'))
  delete kitManifest.bundles
  await writeFile(kitManifestPath, JSON.stringify(kitManifest), 'utf8')
  await mkdir(join(kitRoot, 'content'))
  await writeFile(join(kitRoot, 'content', 'fake-channel-kit.json'), JSON.stringify({ kind: 'channel-kit' }), 'utf8')
  await assert.rejects(
    validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
    /channel kit|coordinator.*bundle|bundle-only/i,
  )
})

test('rejects a registered creative pack disguised as a bundle when its content is removed', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const styleRoot = join(root, 'content-packs', 'free-starters', 'style', 'cinematic-photoreal')
  const styleManifestPath = join(styleRoot, 'pack.json')
  const styleManifest = JSON.parse(await readFile(styleManifestPath, 'utf8'))
  styleManifest.bundles = [{ kind: 'visual-style', components: [] }]
  await writeFile(styleManifestPath, JSON.stringify(styleManifest), 'utf8')
  await rm(join(styleRoot, 'content'), { recursive: true })
  await assert.rejects(
    validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
    /creative.*bundle|visual-style.*bundle|component.*bundle/i,
  )
})

test('rejects non-canonical, external, aliased, and over-deep source paths without changing bytes', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const initial = await registrySnapshot(copy)
  const cases = [
    ['./ alias', 'content-packs/reserved/style/./reserved-style'],
    ['backslash', 'content-packs\\reserved\\style\\reserved-style'],
    ['Windows absolute', 'C:\\outside\\pack'],
    ['POSIX absolute', '/outside/pack'],
    ['parent alias', 'content-packs/reserved/style/../reserved-style'],
    ['outside catalog', 'other/reserved/style/reserved-style'],
    ['retired source monolith', 'content-packs/archival-ledger'],
    ['traversal depth', `content-packs/${Array.from({ length: 20 }, (_, index) => `l${index}`).join('/')}`],
  ]
  for (const [label, sourcePath] of cases) {
    const request = reservationRequest(initial.revision)
    request.records[0].source_path = sourcePath
    await assert.rejects(
      reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }),
      new RegExp(`source_path.*(?:canonical|repository|depth)|${label}`, 'i'),
    )
    assert.deepEqual(await readFile(copy), original)
  }
})

test('rejects an external symlinked pack manifest during discovery', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  const external = await mkdtemp(join(tmpdir(), 'story-authoring-external-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
  ]))
  const source = join(root, 'content-packs', 'paid', 'future-wave', 'external')
  await mkdir(source, { recursive: true })
  await writeFile(join(external, 'pack.json'), '{}', 'utf8')
  await symlink(join(external, 'pack.json'), join(source, 'pack.json'))

  await assert.rejects(
    validateAuthoringRegistry({ registryPath: join(root, 'content-packs', 'authoring-registry.json'), repositoryRoot: root }),
    /symlink.*pack\.json|pack\.json.*symlink/i,
  )
})

test('rejects self, cyclic, and coordinator dependencies in creative closure without changing bytes', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const initial = await registrySnapshot(copy)
  const self = reservationRequest(initial.revision)
  self.records[0].dependencies = [{ pack_id: self.records[0].pack_id, version: self.records[0].version }]
  const cycle = reservationRequest(initial.revision)
  cycle.records = [reservationRecord('visual-style', 'cycle-a'), reservationRecord('thumbnail-recipe', 'cycle-b')]
  cycle.records[0].dependencies = [{ pack_id: cycle.records[1].pack_id, version: '1.0.0' }]
  cycle.records[1].dependencies = [{ pack_id: cycle.records[0].pack_id, version: '1.0.0' }]
  const coordinator = reservationRequest(initial.revision)
  coordinator.records[0].dependencies = [{ pack_id: 'com.storystudio.pack.kit.deep-time', version: '1.0.0' }]
  for (const [request, error] of [[self, /depend on itself/i], [cycle, /cyclic dependency/i], [coordinator, /creative.*coordinator/i]]) {
    await assert.rejects(reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }), error)
    assert.deepEqual(await readFile(copy), original)
  }
})

test('enforces bounded records, dependencies, strings, and JSON before mutation', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const initial = await registrySnapshot(copy)
  const cases = [
    ['200k string', (request) => { request.records[0].pack_id = `com.storystudio.pack.style.${'x'.repeat(200_000)}` }, /pack_id.*(?:160|length|long|qualified)|JSON.*limit/i],
    ['records', (request) => { request.records = Array.from({ length: 101 }, (_, index) => reservationRecord('visual-style', `bounded-${index}`)) }, /records.*100/i],
    ['dependencies', (request) => { request.records[0].dependencies = Array.from({ length: 101 }, (_, index) => ({ pack_id: `com.storystudio.pack.style.dependency-${index}`, version: '1.0.0' })) }, /dependencies.*100/i],
    ['coordinator string', (request) => { request.coordinator.task = 'x'.repeat(201) }, /coordinator task.*200/i],
  ]
  for (const [, mutate, error] of cases) {
    const request = reservationRequest(initial.revision)
    mutate(request)
    await assert.rejects(reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }), error)
    assert.deepEqual(await readFile(copy), original)
  }
})

test('enforces exact semver and kind-qualified first-party namespaces without changing bytes', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const initial = await registrySnapshot(copy)
  const cases = [
    ['pack namespace', (record) => { record.pack_id = 'x' }, /pack_id.*namespace|qualified/i],
    ['item namespace', (record) => { record.item_id = 'y' }, /item_id.*namespace|qualified/i],
    ['version semver', (record) => { record.version = 'banana' }, /version.*semantic version/i],
    ['publisher', (record) => { record.publisher_id = 'outside-authority' }, /publisher_id.*com\.storystudio/i],
    ['minimum version', (record) => { record.min_app_version = 'later' }, /min_app_version.*release-bound/i],
    ['family namespace', (record) => { record.stocking_proposal.family.id = 'f' }, /family.*namespace|qualified/i],
    ['SKU namespace', (record) => { record.stocking_proposal.sku.id = 's' }, /sku.*namespace|qualified/i],
    ['fixed token', (record) => { record.min_app_version_status = 'fixed' }, /min_app_version.*fixed/i],
  ]
  for (const [, mutate, error] of cases) {
    const request = reservationRequest(initial.revision)
    mutate(request.records[0])
    await assert.rejects(reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }), error)
    assert.deepEqual(await readFile(copy), original)
  }
})

test('promotes an exact reserved source to authored and keeps its immutable receipt verifiable', async (t) => {
  const { reserveAuthoringBatch, transitionAuthoringRecord, verifyAuthoringReceipt } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const initial = await registrySnapshot(copy)
  const request = reservationRequest(initial.revision)
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  await materializeReservedStyle(root, request.records[0])

  const transitioned = await transitionAuthoringRecord({
    registryPath: copy,
    repositoryRoot: root,
    request: transitionRequest({ ...reserved, record: request.records[0] }, reserved.revision, { status: 'authored' }),
  })
  assert.equal(transitioned.revision, reserved.revision + 1)
  assert.match(transitioned.transition_ref, /^lifecycle:[a-f0-9]{64}$/)
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  assert.equal(registry.transitions.length, initial.transitionCount + 1)
  assert.equal(registry.records.at(-1).status, 'authored')
  assert.equal((await verifyAuthoringReceipt({
    registryPath: copy,
    repositoryRoot: root,
    revision: reserved.revision,
    receiptRef: reserved.receipt_ref,
    expectedIdentity: request.records[0],
  })).receipt_ref, reserved.receipt_ref)
})

test('offers a coordinator transition CLI and enforces lifecycle CAS', async (t) => {
  const { reserveAuthoringBatch, transitionAuthoringRecord } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const script = join(root, 'scripts', 'content-packs', 'authoring-registry.mjs')
  await mkdir(dirname(script), { recursive: true })
  await cp(fileURLToPath(registryModule), script)
  const reservation = reservationRequest((await registrySnapshot(copy)).revision)
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservation })
  await materializeReservedStyle(root, reservation.records[0])
  const request = transitionRequest({ ...reserved, record: reservation.records[0] }, reserved.revision, { status: 'authored' })
  const requestPath = join(root, 'transition.json')
  await writeFile(requestPath, JSON.stringify(request), 'utf8')

  const [cli, competing] = await Promise.allSettled([
    execFileAsync(process.execPath, [await realpath(script), 'transition', '--request', requestPath]),
    transitionAuthoringRecord({ registryPath: copy, repositoryRoot: root, request }),
  ])
  assert.equal([cli, competing].filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(JSON.parse(await readFile(copy, 'utf8')).revision, reserved.revision + 1)
  const winner = cli.status === 'fulfilled' ? JSON.parse(cli.value.stdout) : competing.value
  assert.match(winner.transition_ref, /^lifecycle:[a-f0-9]{64}$/)
})

test('refuses authored promotion until the registered source is exact and leaves bytes unchanged', async (t) => {
  const { reserveAuthoringBatch, transitionAuthoringRecord } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const request = reservationRequest((await registrySnapshot(copy)).revision)
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  await materializeReservedStyle(root, request.records[0])
  const documentPath = join(root, request.records[0].source_path, 'content', 'visual-style.json')
  const document = JSON.parse(await readFile(documentPath, 'utf8'))
  document.id = 'com.storystudio.style.wrong-source'
  await writeFile(documentPath, JSON.stringify(document), 'utf8')
  const before = await readFile(copy)

  await assert.rejects(transitionAuthoringRecord({
    registryPath: copy,
    repositoryRoot: root,
    request: transitionRequest({ ...reserved, record: request.records[0] }, reserved.revision, { status: 'authored' }),
  }), /source|component identity/i)
  assert.deepEqual(await readFile(copy), before)
})

test('advances stocking proposals proposed to reserved to confirmed with confirmation references', async (t) => {
  const { reserveAuthoringBatch, transitionAuthoringRecord, verifyAuthoringReceipt } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const request = reservationRequest((await registrySnapshot(copy)).revision)
  request.records[0].stocking_proposal.family.status = 'proposed'
  request.records[0].stocking_proposal.sku.status = 'proposed'
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  const assignment = { ...reserved, record: request.records[0] }

  const proposalReserved = await transitionAuthoringRecord({
    registryPath: copy,
    repositoryRoot: root,
    request: transitionRequest(assignment, reserved.revision, {
      stocking_proposal: { family: { status: 'reserved' }, sku: { status: 'reserved' } },
    }),
  })
  await transitionAuthoringRecord({
    registryPath: copy,
    repositoryRoot: root,
    request: transitionRequest(assignment, proposalReserved.revision, {
      stocking_proposal: {
        family: { status: 'confirmed', confirmation_ref: '  genstudio:family-confirmation  ' },
        sku: { status: 'confirmed', confirmation_ref: '  genstudio:sku-confirmation  ' },
      },
    }),
  })
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  assert.deepEqual(registry.records.at(-1).stocking_proposal, {
    family: { id: request.records[0].stocking_proposal.family.id, status: 'confirmed', confirmation_ref: 'genstudio:family-confirmation' },
    sku: { id: request.records[0].stocking_proposal.sku.id, status: 'confirmed', confirmation_ref: 'genstudio:sku-confirmation' },
  })
  assert.equal((await verifyAuthoringReceipt({
    registryPath: copy,
    repositoryRoot: root,
    revision: reserved.revision,
    receiptRef: reserved.receipt_ref,
    expectedIdentity: request.records[0],
  })).receipt_ref, reserved.receipt_ref)
})

test('rejects whitespace-only confirmed proposal references during reservation and transition without mutation', async (t) => {
  const { reserveAuthoringBatch, transitionAuthoringRecord } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const initial = await registrySnapshot(copy)
  const malformed = reservationRequest(initial.revision)
  malformed.records[0].stocking_proposal.family = { ...malformed.records[0].stocking_proposal.family, status: 'confirmed', confirmation_ref: '   ' }
  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: malformed }),
    /confirmation_ref.*(?:blank|whitespace|non-empty)/i,
  )
  assert.deepEqual(await readFile(copy), original)

  const request = reservationRequest(initial.revision)
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  const before = await readFile(copy)

  await assert.rejects(transitionAuthoringRecord({
    registryPath: copy,
    repositoryRoot: root,
    request: transitionRequest({ ...reserved, record: request.records[0] }, reserved.revision, {
      stocking_proposal: { family: { status: 'confirmed', confirmation_ref: '   ' } },
    }),
  }), /confirmation_ref.*(?:blank|whitespace|non-empty)/i)
  assert.deepEqual(await readFile(copy), before)
})

test('rejects skipped, reversed, or unconfirmed lifecycle changes without changing bytes', async (t) => {
  const { reserveAuthoringBatch, transitionAuthoringRecord } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const request = reservationRequest((await registrySnapshot(copy)).revision)
  request.records[0].stocking_proposal.family.status = 'proposed'
  const reserved = await reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request })
  const before = await readFile(copy)
  const assignment = { ...reserved, record: request.records[0] }
  for (const [changes, error] of [
    [{ stocking_proposal: { family: { status: 'confirmed', confirmation_ref: 'too-soon' } } }, /proposed.*reserved.*confirmed|one step/i],
    [{ stocking_proposal: { family: { status: 'confirmed' } } }, /confirmation_ref/i],
    [{ stocking_proposal: { family: { status: 'proposed' } } }, /advance|transition/i],
  ]) {
    await assert.rejects(transitionAuthoringRecord({
      registryPath: copy,
      repositoryRoot: root,
      request: transitionRequest(assignment, reserved.revision, changes),
    }), error)
    assert.deepEqual(await readFile(copy), before)
  }
})

test('rejects a Channel Kit dependency on another coordinator even with complete creative kinds', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  const deepTime = registry.records.find((record) => record.pack_id === 'com.storystudio.pack.kit.deep-time')
  const request = reservationRequest(registry.revision)
  request.records[0] = {
    ...request.records[0],
    pack_id: 'com.storystudio.pack.kit.reserved-style',
    bundle_id: 'com.storystudio.bundle.reserved-style',
    kind: 'channel-kit',
    source_path: 'content-packs/reserved/kit/reserved-style',
    dependencies: [...deepTime.dependencies, { pack_id: 'com.storystudio.pack.kit.a-life-as', version: '1.0.0' }],
    stocking_proposal: {
      family: { id: 'com.storystudio.family.kit.reserved-style', status: 'reserved' },
      sku: { id: 'com.storystudio.sku.kit.reserved-style', status: 'reserved' },
    },
  }
  delete request.records[0].item_id
  const before = await readFile(copy)

  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }),
    /coordinator.*creative|creative.*coordinator/i,
  )
  assert.deepEqual(await readFile(copy), before)
})

test('rejects a registry file that grows beyond its bound after opening', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  await writeFile(copy, Buffer.concat([original, Buffer.alloc(7 * 1024 * 1024, 0x20)]))

  const validating = validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root })
  await appendFile(copy, Buffer.alloc(2 * 1024 * 1024, 0x20))
  await assert.rejects(validating, /byte limit|changed while being read|grew/i)
})

test('rejects a registry path replaced after its handle opens', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const replacement = join(root, 'content-packs', 'replacement.json')
  const original = await readFile(copy)
  const padded = Buffer.concat([original, Buffer.alloc(4 * 1024 * 1024, 0x20)])
  await writeFile(copy, padded)
  await writeFile(replacement, padded)

  const validating = validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root })
  await rename(replacement, copy)
  await assert.rejects(validating, /replaced|identity changed|changed while being read/i)
})

test('rejects an already oversized registry handle before parsing', async (t) => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  await writeFile(copy, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20))

  await assert.rejects(
    validateAuthoringRegistry({ registryPath: copy, repositoryRoot: root }),
    /byte limit/i,
  )
})
