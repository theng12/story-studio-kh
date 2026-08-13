import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import {
  getContentPackRuntimePaths,
  installedVersionPath,
  resolveVerifiedPackFile,
} from '../content-packs/runtime-paths.js'
import {
  emptyContentPackState,
  mutateContentPackState,
  readContentPackState,
} from '../content-packs/state.js'
import type { ContentPackManifest } from '../content-packs/types.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function isolatedPaths() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return { temp, paths: getContentPackRuntimePaths() }
}

function manifest(): ContentPackManifest {
  return {
    pack_format: 1,
    pack_id: 'com.storystudio.test-pack',
    publisher_id: 'com.storystudio',
    key_id: 'com.storystudio.test-key',
    version: '1.2.3',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: 'com.storystudio.sku.test-pack', family: 'com.storystudio.family.test' },
    bundles: [],
    items: [{
      id: 'com.storystudio.style.test',
      kind: 'visual-style',
      schema_version: 1,
      path: 'content/visual-style.json',
    }],
    files: [{
      path: 'content/visual-style.json',
      sha256: '0'.repeat(64),
      bytes: 1,
      mime: 'application/json',
    }],
  }
}

describe('Content Pack runtime state', () => {
  test('resolves userData paths lazily and does not create layout on reads', async () => {
    const { temp, paths } = await isolatedPaths()
    assert.equal(paths.root, path.join(temp.dir, 'content-packs'))
    assert.equal(paths.statePath, path.join(temp.dir, 'content-packs', 'state.json'))
    assert.equal(paths.stagingRoot, path.join(temp.dir, 'content-packs', '.staging'))
    assert.equal(paths.installedRoot, path.join(temp.dir, 'content-packs', 'installed'))
    assert.equal(paths.quarantineRoot, path.join(temp.dir, 'content-packs', 'quarantine'))

    assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
    await assert.rejects(fs.stat(paths.root), { code: 'ENOENT' })
  })

  test('quarantines malformed or unknown state instead of trusting it', async () => {
    const { paths } = await isolatedPaths()
    await fs.mkdir(paths.root, { recursive: true })
    const invalid = '{"schema_version":1,"packs":{},"surprise":true}\n'
    await fs.writeFile(paths.statePath, invalid, { mode: 0o600 })

    assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
    const hash = createHash('sha256').update(invalid).digest('hex')
    const quarantined = path.join(paths.quarantineRoot, `state-invalid-${hash}.json`)
    assert.equal(await fs.readFile(quarantined, 'utf8'), invalid)
    assert.deepEqual(JSON.parse(await fs.readFile(paths.statePath, 'utf8')), emptyContentPackState())
  })

  test('serialises parallel state mutations without losing entries', async () => {
    const { paths } = await isolatedPaths()
    await Promise.all(Array.from({ length: 20 }, (_, n) =>
      mutateContentPackState(state => {
        state.packs[`com.storystudio.test.${n}`] = { discovery_disabled: false, versions: {} }
      }, paths),
    ))
    assert.equal(Object.keys((await readContentPackState(paths)).packs).length, 20)
  })

  test('constructs only contained immutable version paths and verified files', async () => {
    const { paths } = await isolatedPaths()
    const versionRoot = installedVersionPath(paths, manifest())
    assert.equal(versionRoot, path.join(paths.installedRoot, 'com.storystudio', 'com.storystudio.test-pack', '1.2.3'))
    assert.match(resolveVerifiedPackFile(versionRoot, 'content/visual-style.json'), new RegExp(`${path.sep.replace('\\', '\\\\')}content${path.sep.replace('\\', '\\\\')}visual-style\\.json$`))
    assert.throws(() => resolveVerifiedPackFile(versionRoot, '../state.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content\\style.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/../style.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/\0style.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/link/../../state.json'), /contained/i)
  })
})
