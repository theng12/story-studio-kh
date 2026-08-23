import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

const SUCCESSORS = [
  ['calm-mind', 'com.storystudio.pack.thumbnail.centered-hero-headline'],
  ['human-behavior', 'com.storystudio.pack.thumbnail.centered-hero-headline'],
  ['a-life-as', 'com.storystudio.pack.thumbnail.portrait-block-right'],
  ['sleep-journeys', 'com.storystudio.pack.thumbnail.dreamscape-story-window'],
  ['first-humans', 'com.storystudio.pack.thumbnail.prehistoric-discovery'],
]

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../../../${relativePath}`, import.meta.url), 'utf8'))
}

function releaseIdentity(source) {
  return {
    pack_id: source.pack_id,
    publisher_id: source.publisher_id,
    key_id: source.key_id,
    min_app_version: source.min_app_version,
    lifecycle: source.lifecycle,
    entitlement: source.entitlement,
    bundle_id: source.bundles?.[0]?.id,
  }
}

test('same-lineage Starter Channel Kit successors change only their restored thumbnail release', async t => {
  const registry = await readJson('content-packs/authoring-registry.json')

  for (const [slug, thumbnailPackId] of SUCCESSORS) {
    await t.test(slug, async () => {
      const originalPath = `content-packs/free-starters/kit/${slug}/pack.json`
      const successorPath = `content-packs/free-starters/kit/${slug}-v1.0.1/pack.json`
      const [original, successor] = await Promise.all([readJson(originalPath), readJson(successorPath)])

      assert.equal(successor.version, '1.0.1')
      assert.deepEqual(releaseIdentity(successor), releaseIdentity(original))
      assert.equal(successor.changelog, 'Adds the restored thumbnail gallery.')

      const expectedDependencies = original.dependencies.map(dependency => (
        dependency.pack_id === thumbnailPackId
          ? { ...dependency, version: '1.0.1' }
          : dependency
      ))
      assert.deepEqual(successor.dependencies, expectedDependencies)
      assert.deepEqual(
        successor.bundles[0].components.map(({ pack_id, version }) => ({ pack_id, version })),
        expectedDependencies,
      )

      const entries = await readdir(new URL(`../../../content-packs/free-starters/kit/${slug}-v1.0.1/`, import.meta.url))
      assert.deepEqual(entries.sort(), ['pack.json'])

      const originalRecord = registry.records.find(record => record.pack_id === original.pack_id && record.version === original.version)
      const successorRecord = registry.records.find(record => record.pack_id === successor.pack_id && record.version === successor.version)
      assert.ok(originalRecord)
      assert.ok(successorRecord)
      assert.equal(successorRecord.kind, 'channel-kit')
      assert.equal(successorRecord.status, 'authored')
      assert.equal(successorRecord.source_path, successorPath.slice(0, -'/pack.json'.length))
      assert.deepEqual(successorRecord.stocking_proposal, originalRecord.stocking_proposal)
      assert.deepEqual(successorRecord.dependencies, expectedDependencies)

      for (const dependency of expectedDependencies) {
        assert.ok(
          registry.records.some(record => record.pack_id === dependency.pack_id && record.version === dependency.version),
          `registry is missing ${dependency.pack_id}@${dependency.version}`,
        )
      }
    })
  }
})
