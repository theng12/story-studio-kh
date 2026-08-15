import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const registryPath = join(repositoryRoot, 'content-packs', 'authoring-registry.json')
const registryModule = new URL('../authoring-registry.mjs', import.meta.url)

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), 'story-authoring-registry-'))
  await cp(join(repositoryRoot, 'content-packs'), join(root, 'content-packs'), { recursive: true })
  return root
}

test('reconciles the strict 55-pack authored registry against source manifests', async () => {
  const { validateAuthoringRegistry } = await import(registryModule)
  const result = await validateAuthoringRegistry({ registryPath, repositoryRoot })

  assert.equal(result.revision, 1)
  assert.equal(result.records.length, 55)
  assert.equal(result.records.filter((record) => record.status === 'authored').length, 55)
  assert.equal(result.records.filter((record) => record.item_id).length, 44)
  assert.equal(result.records.filter((record) => record.bundle_id).length, 11)
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

function reservationRequest() {
  return {
    expected_revision: 1,
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

test('reserves a complete batch once with a deterministic receipt', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const request = reservationRequest()
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
  assert.equal(result.revision, 2)
  assert.match(result.receipt_ref, /^authoring:[a-f0-9]{64}$/)
  const registry = JSON.parse(await readFile(copy, 'utf8'))
  assert.equal(registry.revision, 2)
  assert.equal(registry.records.length, 57)
  assert.equal(registry.records.at(-1).receipt_ref, result.receipt_ref)
  assert.equal(registry.records.at(-2).receipt_ref, result.receipt_ref)
  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservationRequest() }),
    /stale expected revision/i,
  )
})

test('leaves registry bytes unchanged for stale, colliding, malformed, unknown, and GenStudio-owned requests', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const cases = [
    ['stale', (request) => { request.expected_revision = 99 }, /stale expected revision/i],
    ['pack collision', (request) => { request.records[0].pack_id = 'com.storystudio.pack.formula.ancient-humans' }, /duplicate pack_id/i],
    ['item collision', (request) => { request.records[0].item_id = 'com.storystudio.formula.ancient-humans' }, /duplicate item_id/i],
    ['bundle collision', (request) => {
      delete request.records[0].item_id
      request.records[0].kind = 'channel-kit'
      request.records[0].bundle_id = 'com.storystudio.bundle.deep-time'
    }, /duplicate bundle_id/i],
    ['family collision', (request) => { request.records[0].stocking_proposal.family.id = 'com.storystudio.family.formula.ancient-humans' }, /duplicate family/i],
    ['sku collision', (request) => { request.records[0].stocking_proposal.sku.id = 'com.storystudio.sku.formula.ancient-humans' }, /duplicate sku/i],
    ['malformed dependency', (request) => { request.records[0].dependencies = [{ pack_id: 'com.storystudio.pack.missing', version: '1.0.0' }] }, /unknown dependency/i],
    ['unknown field', (request) => { request.records[0].unknown = true }, /unknown or forbidden field/i],
    ['GenStudio field', (request) => { request.records[0].product_id = 'product' }, /unknown or forbidden field.*product_id/i],
  ]
  for (const [, mutate, error] of cases) {
    const request = reservationRequest()
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
  const results = await Promise.allSettled([
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservationRequest() }),
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request: reservationRequest() }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(JSON.parse(await readFile(copy, 'utf8')).revision, 2)
})

test('rejects a reserved coordinator without its complete exact dependency closure', async (t) => {
  const { reserveAuthoringBatch } = await import(registryModule)
  const root = await temporaryRepository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = join(root, 'content-packs', 'authoring-registry.json')
  const original = await readFile(copy)
  const request = reservationRequest()
  delete request.records[0].item_id
  Object.assign(request.records[0], {
    pack_id: 'com.storystudio.pack.kit.reserved-style',
    bundle_id: 'com.storystudio.bundle.reserved-style',
    kind: 'channel-kit',
    source_path: 'content-packs/reserved/kit/reserved-style',
  })

  await assert.rejects(
    reserveAuthoringBatch({ registryPath: copy, repositoryRoot: root, request }),
    /coordinator dependency closure/i,
  )
  assert.deepEqual(await readFile(copy), original)
})
