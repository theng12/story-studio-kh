import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { trashPath } from '../../shared-paths.mjs'
import { test } from 'node:test'
import {
  readSelectedStoryRenderProvenance,
  assertPackagedStoryRenderProvenance,
  _createStoryRenderArtifactVerifierForTesting,
} from '../render-build-provenance.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const tool = { format: 'studio.render.story-build-provenance.v1', mode: 'tool-only', descriptors: null, qualification: null }
const descriptors = { profile_digest: '1'.repeat(64), tools_digest: '2'.repeat(64), compiler_digest: '3'.repeat(64) }
const qualification = { vector_id: 'candidate vector ' + 'v'.repeat(150), qualification_digest: '4'.repeat(64), packet_digest: '5'.repeat(64), recipe_digest: '6'.repeat(64), manifest_digest: '7'.repeat(64) }
const descriptor = { ...tool, mode: 'descriptor-only', descriptors }
const sealed = { ...descriptor, mode: 'sealed-candidate', qualification }
const builderSelection = {
  ...tool,
  mode: 'descriptor-only',
  descriptors: {
    profile_digest: 'ad3f1c9d47d5f59400b1b1d03596a59fba6dc2f26817ac5cc2c77f8837f24863',
    tools_digest: '98c25ae582d4ee43ee1cf665192365149f8d9f860c229a0be9da131df43eba8a',
    compiler_digest: '1239374f6cf60d025ee897c4c6ea394892d2bc146b0f1b2df94e5eaecc86b4a7',
  },
}
const packageText = provenance => JSON.stringify({ name: 'story-studio-kh', main: 'electron/dist/main.js', type: 'module', version: '1.0.0', storyRenderProvenance: provenance })
const selected = value => readSelectedStoryRenderProvenance(Buffer.from(JSON.stringify({ extraMetadata: { storyRenderProvenance: value } })))

function fixture({ provenance = tool, mountedProvenance = provenance, outputPayload = 'same', mountedPayload = outputPayload, stat = {}, attachFails = false, detachFails = false, missingEntry = null } = {}) {
  const parent = process.env.STORY_STUDIO_TEST_HARNESS_ROOT || trashPath('test-fixtures')
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'render-provenance-contract-')))
  fs.chmodSync(dir, 0o700)
  const appPath = path.join(dir, 'output', 'Story Studio KH.app')
  const archive = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  const makeArchive = (metadata, payload) => JSON.stringify({ metadata: packageText(metadata), payload })
  fs.writeFileSync(archive, makeArchive(provenance, outputPayload))
  const mountedBytes = makeArchive(mountedProvenance, mountedPayload)
  const calls = []
  let extracted = 0
  const archiveApi = {
    uncache() {},
    statFile(file, entry, follow) {
      assert.equal(entry, 'package.json'); assert.equal(follow, false)
      return { size: Buffer.byteLength(JSON.parse(fs.readFileSync(file, 'utf8')).metadata), unpacked: false, ...stat }
    },
    extractFile(file, entry, follow) {
      extracted++; assert.equal(entry, 'package.json'); assert.equal(follow, false)
      return Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).metadata)
    },
  }
  const run = args => {
    calls.push(args)
    if (args[0] === 'attach') {
      assert.ok(args.includes('-readonly')); assert.ok(args.includes('-nobrowse'))
      if (attachFails) throw new Error('fixture attach failed')
      const mount = args[args.indexOf('-mountpoint') + 1]
      const mountedArchive = path.join(mount, 'Story Studio KH.app', 'Contents', 'Resources', 'app.asar')
      if (missingEntry !== 'Story Studio KH.app') {
        fs.mkdirSync(path.dirname(mountedArchive), { recursive: true })
        fs.writeFileSync(mountedArchive, mountedBytes)
      }
      if (missingEntry !== 'Applications') fs.mkdirSync(path.join(mount, 'Applications'))
      if (missingEntry !== 'READ ME FIRST.txt') fs.writeFileSync(path.join(mount, 'READ ME FIRST.txt'), 'retained fixture readme\n')
    } else if (detachFails) throw new Error('fixture detach failed')
  }
  const verify = _createStoryRenderArtifactVerifierForTesting({ archiveApi, run, fixturesRoot: path.join(dir, 'inspection') })
  return { dir, calls, extracted: () => extracted, verify: () => verify({ appPath, dmgPath: path.join(dir, 'candidate.dmg'), expected: provenance }) }
}

test('common build input requires explicit closed provenance', () => {
  for (const value of [{}, { extraMetadata: {} }, { extraMetadata: { storyRenderProvenance: null } }]) {
    assert.throws(() => readSelectedStoryRenderProvenance(Buffer.from(JSON.stringify(value))))
  }
  for (const value of [{ ...tool, extra: true }, { ...tool, mode: 'production' }, { ...descriptor, qualification }, { ...sealed, descriptors: null }]) {
    assert.throws(() => selected(value))
  }
  assert.throws(() => readSelectedStoryRenderProvenance(Buffer.from('{"extraMetadata":{},"extraMetadata":{}}')))
})

test('default builder selects the reviewed descriptor-only provenance pins', () => {
  assert.deepEqual(
    readSelectedStoryRenderProvenance(fs.readFileSync(path.join(root, 'electron-builder.json'))),
    builderSelection,
  )
})

test('artifact metadata uses the shared duplicate-key decoder', () => {
  const bytes = packageText(tool).replace('"version":"1.0.0"', '"version":"1.0.0","ver\\u0073ion":"2.0.0"')
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(bytes), tool))
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from([0xff]), tool))
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from('﻿' + packageText(tool)), tool))
})

test('artifact provenance equals reviewed input for all three modes', () => {
  for (const provenance of [tool, descriptor, sealed]) {
    assert.deepEqual(assertPackagedStoryRenderProvenance(Buffer.from(packageText(provenance)), provenance), provenance)
    assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(packageText(provenance)), provenance.mode === 'tool-only' ? descriptor : tool))
    if (provenance.descriptors) {
      for (const key of Object.keys(descriptors)) {
        const changed = { ...provenance, descriptors: { ...descriptors, [key]: 'a'.repeat(64) } }
        assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(packageText(changed)), provenance), /differs/)
      }
    }
    if (provenance.qualification) {
      for (const key of Object.keys(qualification)) {
        const changed = { ...provenance, qualification: { ...qualification, [key]: key === 'vector_id' ? 'other-vector' : 'b'.repeat(64) } }
        assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(packageText(changed)), provenance), /differs/)
      }
    }
    const f = fixture({ provenance })
    const result = f.verify()
    assert.equal(result.asarSha256, result.dmgAsarSha256)
    assert.deepEqual(f.calls.map(args => args[0]), ['attach', 'detach'])
    assert.ok(fs.existsSync(result.retained))
  }
})

test('artifact rejects absent stale malformed and unpacked metadata', () => {
  const legacy = JSON.stringify({ name: 'story-studio-kh', main: 'electron/dist/main.js', type: 'module' })
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(legacy), tool), /missing/)
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(packageText({ ...tool, mode: 'bad' })), tool))
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(packageText(null)), tool))
  assert.throws(() => assertPackagedStoryRenderProvenance(Buffer.from(packageText(tool).replace('story-studio-kh', 'other-app')), tool))
  for (const stat of [{ unpacked: true }, { link: 'other.json' }, { files: {} }, { size: 1024 * 1024 + 1 }]) {
    const f = fixture({ stat })
    assert.throws(f.verify, /packed, unlinked/)
    assert.equal(f.extracted(), 0, 'entry bounds/type must reject before allocating extraction')
    assert.deepEqual(f.calls, [])
  }
  const stale = fixture({ mountedProvenance: descriptor })
  assert.throws(stale.verify, /differs from reviewed/)
  assert.equal(stale.calls.at(-1)[0], 'detach')
})

test('DMG-contained ASAR must equal the inspected output ASAR', () => {
  const unequal = fixture({ mountedPayload: 'same provenance, different archive bytes' })
  assert.throws(unequal.verify, /ASAR|app.asar bytes differ/)
  assert.equal(unequal.calls.at(-1)[0], 'detach')
  for (const missingEntry of ['Story Studio KH.app', 'Applications', 'READ ME FIRST.txt']) {
    const missing = fixture({ missingEntry })
    assert.throws(missing.verify, /DMG does not contain/)
    assert.equal(missing.calls.at(-1)[0], 'detach')
  }
  for (const options of [{ attachFails: true }, { detachFails: true }, { attachFails: true, detachFails: true }]) {
    const f = fixture(options)
    assert.throws(f.verify, /attach|detach|inspection/)
    assert.deepEqual(f.calls.map(args => args[0]), ['attach', 'detach'])
  }
})

test('artifact inspection never writes the source package manifest', () => {
  const paths = ['package.json', 'package-lock.json'].map(name => path.join(root, name))
  const before = paths.map(file => fs.readFileSync(file))
  fixture().verify()
  paths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]))
})

test('release helper imports pure source modules without compiled output', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/release/render-build-provenance.mjs'), 'utf8')
  assert.match(source, /electron\/server\/lib\/final-render-provenance-contract\.js/)
  assert.match(source, /electron\/server\/lib\/final-render-strict-json\.js/)
  assert.doesNotMatch(source, /electron\/dist|final-render-gateway-client|final-render-build-provenance\.ts|extractAll|extract-file/)
  // Package parsing must not inherit wire-only canonical number restrictions.
  const ordinary = packageText(tool).replace('"version":"1.0.0"', '"version":"1.0.0","ordinary":1.5')
  assert.deepEqual(assertPackagedStoryRenderProvenance(Buffer.from(ordinary), tool), tool)
})
