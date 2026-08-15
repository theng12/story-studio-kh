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
