import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { decodeStrictJson, StrictJsonError } from '../lib/final-render-strict-json.js'
import {
  parseStoryRenderProvenance, parseQualificationProvenance, readStoryRenderProvenanceFromPackageBytes,
  RenderProvenanceError, sameDescriptorPins, sameQualificationProvenance,
} from '../lib/final-render-provenance-contract.js'
import { _createInstalledStoryRenderProvenanceReaderForTesting } from '../lib/final-render-build-provenance.js'
import { FinalRenderResponseValidationError, getFinalRenderCapabilities, validateSubmitBytes } from '../lib/final-render-gateway-client.js'
import { canonicalRenderValue } from '../lib/render-hash-v1.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { getOrCreatePrivateRenderIdentity, pinGatewayBinding } from '../services/private-render-identity.js'
import { useTempDataDir } from './_helpers.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const DESCRIPTORS = { profile_digest: 'a'.repeat(64), tools_digest: 'b'.repeat(64), compiler_digest: 'c'.repeat(64) }
const QUALIFICATION = { vector_id: 'candidate-vector', qualification_digest: '1'.repeat(64), packet_digest: '2'.repeat(64), recipe_digest: '3'.repeat(64), manifest_digest: '4'.repeat(64) }
const TOOL = { format: 'studio.render.story-build-provenance.v1', mode: 'tool-only', descriptors: null, qualification: null }
const DESCRIPTOR = { ...TOOL, mode: 'descriptor-only', descriptors: DESCRIPTORS }
const SEALED = { ...DESCRIPTOR, mode: 'sealed-candidate', qualification: QUALIFICATION }
const PACKAGE = { name: 'story-studio-kh', main: 'electron/dist/main.js', type: 'module' }
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const packageBytes = (provenance: unknown = TOOL) => bytes({ ...PACKAGE, storyRenderProvenance: provenance })
const packaged = { isPackaged: true, resourcesPath: '/retained/resources', appPath: '/retained/resources/app.asar' }
const originalFetch = globalThis.fetch
let fixture: Awaited<ReturnType<typeof useTempDataDir>>
let storyInstanceId = ''

before(async () => {
  fixture = await useTempDataDir({ retain: true, settle: async () => {} })
  await setGenStudioUrl('https://gateway.private.example')
  const identity = await getOrCreatePrivateRenderIdentity()
  storyInstanceId = identity.story_instance_id
  await setApiKey('genstudio', 'ab'.repeat(32))
  await pinGatewayBinding({
    origin: 'https://gateway.private.example',
    owner_scope: '11111111-1111-4111-8111-111111111111', gateway_instance_id: '22222222-2222-4222-8222-222222222222',
  })
})
after(async () => { globalThis.fetch = originalFetch; await fixture?.cleanup() })

test('strict-json extraction preserves wire validation', () => {
  assert.deepEqual(decodeStrictJson(bytes({ nested: [{ value: true }] }), 'wire'), { nested: [{ value: true }] })
  for (const raw of [Buffer.from([0xc3, 0x28]), Buffer.from('﻿{}'), Buffer.from('{"a":1,"\\u0061":2}'),
    Buffer.from('{} trailing'), Buffer.alloc(1024 * 1024 + 1, 0x20),
    Buffer.from('['.repeat(34) + '0' + ']'.repeat(34)), bytes(Array.from({ length: 65537 }, () => null))]) {
    assert.throws(() => decodeStrictJson(raw, 'wire'), StrictJsonError)
  }
  for (const raw of ['{"a":1,"\\u0061":2}', '﻿{}']) {
    assert.throws(() => validateSubmitBytes(Buffer.from(raw)), FinalRenderResponseValidationError)
  }
  for (const raw of ['{"x":9007199254740993}', '{"x":"\\ud800"}']) {
    assert.throws(() => validateSubmitBytes(Buffer.from(raw)), /safe|surrogate/i,
      'the client retains its original canonical-render postpass')
  }
  assert.throws(() => canonicalRenderValue(decodeStrictJson('{"x":9007199254740993}', 'wire')), /safe/i)
})

test('package metadata rejects duplicate decoded keys', () => {
  const source = JSON.stringify({ ...PACKAGE, storyRenderProvenance: DESCRIPTOR })
  for (const raw of [
    source.replace('"name":"story-studio-kh"', '"name":"other","na\\u006de":"story-studio-kh"'),
    source.replace('"mode":"descriptor-only"', '"mode":"tool-only","mo\\u0064e":"descriptor-only"'),
    source.replace(`"tools_digest":"${DESCRIPTORS.tools_digest}"`, `"tools_digest":"${DESCRIPTORS.tools_digest}","tools\\u005fdigest":"${DESCRIPTORS.tools_digest}"`),
    source.slice(0, -1) + ',"unrelated":{"x":1,"\\u0078":2}}',
    '﻿' + source,
  ]) assert.throws(() => readStoryRenderProvenanceFromPackageBytes(Buffer.from(raw)), RenderProvenanceError)
  assert.throws(() => readStoryRenderProvenanceFromPackageBytes(Buffer.from([0xc3, 0x28])), RenderProvenanceError)
  assert.throws(() => readStoryRenderProvenanceFromPackageBytes(packageBytes(null)), RenderProvenanceError)
  assert.equal(readStoryRenderProvenanceFromPackageBytes(bytes(PACKAGE)), null)
  for (const key of ['name', 'main', 'type']) {
    const missing: Record<string, unknown> = { ...PACKAGE }; delete missing[key]
    assert.throws(() => readStoryRenderProvenanceFromPackageBytes(bytes(missing)), RenderProvenanceError)
    assert.throws(() => readStoryRenderProvenanceFromPackageBytes(bytes({ ...PACKAGE, [key]: 'wrong' })), RenderProvenanceError)
  }
})

test('package metadata permits unrelated ordinary JSON numbers', () => {
  const raw = JSON.stringify({ ...PACKAGE, storyRenderProvenance: TOOL, unrelated: {
    integer: Number.MAX_SAFE_INTEGER + 1, fractional: 1.25, constructor: 'ordinary npm metadata',
  } })
  assert.equal(readStoryRenderProvenanceFromPackageBytes(Buffer.from(raw))?.mode, 'tool-only')
})

test('provenance variants are closed and immutable', () => {
  for (const value of [TOOL, DESCRIPTOR, SEALED]) {
    const parsed = parseStoryRenderProvenance(value)
    assert.deepEqual(parsed, value)
    assert.notEqual(parsed, value)
    assert.equal(Object.isFrozen(parsed), true)
    if (parsed.descriptors) assert.equal(Object.isFrozen(parsed.descriptors), true)
    if (parsed.qualification) assert.equal(Object.isFrozen(parsed.qualification), true)
    for (const key of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value }; delete missing[key]
      assert.throws(() => parseStoryRenderProvenance(missing), RenderProvenanceError)
    }
    assert.throws(() => parseStoryRenderProvenance({ ...value, extra: true }), RenderProvenanceError)
  }
  for (const invalid of [null, [], {}, { ...TOOL, format: 'other' }, { ...TOOL, mode: 'other' },
    { ...TOOL, descriptors: DESCRIPTORS }, { ...TOOL, qualification: QUALIFICATION },
    { ...DESCRIPTOR, descriptors: null }, { ...DESCRIPTOR, qualification: QUALIFICATION },
    { ...SEALED, qualification: null }, { ...SEALED, descriptors: [] }]) {
    assert.throws(() => parseStoryRenderProvenance(invalid), RenderProvenanceError)
  }
  for (const key of Object.keys(DESCRIPTORS)) {
    const missing: Record<string, unknown> = { ...DESCRIPTORS }; delete missing[key]
    for (const value of [missing, { ...DESCRIPTORS, [key]: 'A'.repeat(64) }, { ...DESCRIPTORS, [key]: 1 }, { ...DESCRIPTORS, extra: true }]) {
      assert.throws(() => parseStoryRenderProvenance({ ...DESCRIPTOR, descriptors: value }), RenderProvenanceError)
    }
  }
  for (const key of Object.keys(QUALIFICATION)) {
    const missing: Record<string, unknown> = { ...QUALIFICATION }; delete missing[key]
    assert.throws(() => parseQualificationProvenance(missing), RenderProvenanceError)
    if (key !== 'vector_id') for (const value of ['', 'A'.repeat(64), 'g'.repeat(64), 1]) {
      assert.throws(() => parseQualificationProvenance({ ...QUALIFICATION, [key]: value }), RenderProvenanceError)
    }
  }
  for (const vector_id of ['', ' leading', 'trailing ', 'a\0b', 'x'.repeat(257), null, 7]) {
    assert.throws(() => parseQualificationProvenance({ ...QUALIFICATION, vector_id }), RenderProvenanceError)
  }
  assert.equal(parseQualificationProvenance({ ...QUALIFICATION, vector_id: 'x'.repeat(256) }).vector_id.length, 256)
  assert.throws(() => parseQualificationProvenance({ ...QUALIFICATION, extra: true }), RenderProvenanceError)
  assert.equal(sameDescriptorPins(DESCRIPTORS, { ...DESCRIPTORS }), true)
  for (const key of Object.keys(DESCRIPTORS)) {
    assert.equal(sameDescriptorPins(DESCRIPTORS, { ...DESCRIPTORS, [key]: '0'.repeat(64) }), false)
  }
  assert.throws(() => parseQualificationProvenance(undefined), RenderProvenanceError)
  assert.equal(sameQualificationProvenance(QUALIFICATION, { ...QUALIFICATION }), true)
  for (const key of Object.keys(QUALIFICATION)) {
    assert.equal(sameQualificationProvenance(QUALIFICATION, { ...QUALIFICATION, [key]: 'different' }), false)
  }
  assert.equal(sameQualificationProvenance(null, null), false)
})

test('installed reader is packaged-only and fixed-path', async () => {
  let reads = 0
  const development = _createInstalledStoryRenderProvenanceReaderForTesting({
    packagedFacts: () => ({ isPackaged: false }), readBoundedBytes: async () => { reads++; return packageBytes(SEALED) },
  })
  assert.deepEqual(await development(), { status: 'unavailable', reason: 'development' })
  assert.equal(reads, 0)
  const reader = _createInstalledStoryRenderProvenanceReaderForTesting({
    packagedFacts: () => packaged,
    readBoundedBytes: async (file, maximum) => {
      assert.equal(file, '/retained/resources/app.asar/package.json')
      assert.equal(maximum, 1024 * 1024 + 1)
      reads++
      return packageBytes(DESCRIPTOR)
    },
  })
  assert.deepEqual(await reader(), { status: 'valid', provenance: DESCRIPTOR })
  assert.equal(reads, 1)
  for (const facts of [
    { ...packaged, appPath: '/other/app.asar' }, { ...packaged, appPath: 'app.asar' },
    { ...packaged, appPath: '/retained/resources/../resources/app.asar' },
    { ...packaged, resourcesPath: undefined }, { ...packaged, appPath: '/retained/resources/app' },
  ]) {
    const invalid = _createInstalledStoryRenderProvenanceReaderForTesting({
      packagedFacts: () => facts, readBoundedBytes: async () => { assert.fail('wrong layout must not read') },
    })
    await assert.rejects(invalid(), RenderProvenanceError)
  }
  const oversized = _createInstalledStoryRenderProvenanceReaderForTesting({
    packagedFacts: () => packaged, readBoundedBytes: async () => Buffer.alloc(1024 * 1024 + 1),
  })
  await assert.rejects(oversized(), RenderProvenanceError)
})

test('installed reader caches success absence and failure', async () => {
  for (const payload of [packageBytes(SEALED), bytes(PACKAGE), Buffer.from('{'), null]) {
    let calls = 0
    const reader = _createInstalledStoryRenderProvenanceReaderForTesting({
      packagedFacts: () => packaged,
      readBoundedBytes: async () => { calls++; if (payload === null) throw new Error('read failure'); return payload },
    })
    const first = reader(), second = reader()
    assert.equal(first, second, 'parallel requests share the exact cached promise')
    const outcomes = await Promise.allSettled([first, second])
    assert.equal(calls, 1)
    if (payload === null || payload.toString() === '{') {
      assert.equal(outcomes[0].status, 'rejected')
      await assert.rejects(reader(), RenderProvenanceError)
      if (outcomes[0].status === 'rejected' && outcomes[1].status === 'rejected') assert.equal(outcomes[0].reason, outcomes[1].reason)
    } else {
      assert.equal(outcomes[0].status, 'fulfilled')
      const value = await reader()
      assert.equal(Object.isFrozen(value), true)
      if (value.status === 'valid') assert.equal(Object.isFrozen(value.provenance.qualification), true)
      else assert.equal(value.reason, 'legacy')
    }
    assert.equal(calls, 1)
  }
})

function capabilities(): Record<string, any> {
  const tools = JSON.stringify({
    format: 'studio.render.tools.v1', platform: 'macos-arm64', ffmpeg_sha256: '1'.repeat(64), ffmpeg_size_bytes: 10,
    ffprobe_sha256: '2'.repeat(64), ffprobe_size_bytes: 10, architecture_evidence_sha256: '3'.repeat(64),
    minimum_os_evidence_sha256: '4'.repeat(64), linked_libraries_evidence_sha256: '5'.repeat(64),
    build_configuration_evidence_sha256: '6'.repeat(64), capability_inventory_evidence_sha256: '7'.repeat(64),
  })
  const compiler = JSON.stringify({ format: 'studio.render.compiler.v1', implementation: 'hub-final-render-v1',
    python_runtime_sha256: '8'.repeat(64), render_hash_sha256: '9'.repeat(64), render_contract_sha256: 'a'.repeat(64), final_render_compiler_sha256: 'b'.repeat(64) })
  const profile = JSON.stringify({ format: 'studio.render.profile.v1', implementation: 'story-classic-no-font-v1',
    recipe_namespace: 'studio.render.final.v1', compiler_artifact_sha256: digest(compiler), tools_artifact_sha256: digest(tools),
    combination_set: 'retained-classic-no-font-candidate-v1', tier_policy: 'story-final-chain-v1', output_policy: 'story-final-output-v1',
    execution_bounds: { canvas_pairs: [{ width: 128, height: 96 }], working_fps: [5], max_duration_sec: 60,
      max_operations: 32, max_assets: 32, max_asset_bytes: 1024 * 1024, max_total_input_bytes: 2 * 1024 * 1024,
      max_pixel_frames: 128 * 96 * 5 * 60, scratch_reserve_bytes: 1, output_limit_bytes: 1024 * 1024,
      process_tree_rss_limit_bytes: 1024 * 1024, cumulative_wall_seconds: 60 },
    hardware_qualification_record_sha256: null, fidelity_record_sha256: null, production_eligible: false })
  return { format: 'studio.render.gateway-capabilities.v1', private: true, chargeable: false,
    owner_scope: '11111111-1111-4111-8111-111111111111', gateway_instance_id: '22222222-2222-4222-8222-222222222222',
    story_instance_id: storyInstanceId, eligible: 0, idle: 0, server_time: Math.floor(Date.now() / 1000),
    profile_descriptor_utf8: profile, profile_digest: digest(profile),
    tools: { descriptor_utf8: tools, digest: digest(tools) }, compiler: { descriptor_utf8: compiler, digest: digest(compiler) } }
}

test('capabilities provenance accepts legacy null and exact object', async () => {
  for (const member of [undefined, null, QUALIFICATION]) {
    const value = capabilities()
    if (member !== undefined) value.qualification_provenance = member
    globalThis.fetch = async () => Response.json(value)
    const parsed = await getFinalRenderCapabilities()
    assert.deepEqual(parsed.qualification_provenance, member)
    if (member) assert.equal(Object.isFrozen(parsed.qualification_provenance), true)
  }
  for (const member of [{}, [], { ...QUALIFICATION, extra: true }, { ...QUALIFICATION, vector_id: ' bad' },
    { ...QUALIFICATION, packet_digest: 'A'.repeat(64) }]) {
    globalThis.fetch = async () => Response.json({ ...capabilities(), qualification_provenance: member })
    await assert.rejects(getFinalRenderCapabilities(), FinalRenderResponseValidationError)
  }
  const duplicate = JSON.stringify({ ...capabilities(), qualification_provenance: QUALIFICATION }).replace(
    '"vector_id":"candidate-vector"', '"vector_id":"other","vector\\u005fid":"candidate-vector"')
  globalThis.fetch = async () => new Response(duplicate)
  await assert.rejects(getFinalRenderCapabilities(), FinalRenderResponseValidationError)
})

test('capabilities provenance preserves binding freshness and descriptors', async () => {
  for (const change of [
    { owner_scope: '33333333-3333-4333-8333-333333333333' },
    { gateway_instance_id: '33333333-3333-4333-8333-333333333333' },
    { story_instance_id: '33333333-3333-4333-8333-333333333333' },
    { server_time: 1 }, { eligible: 1, idle: 2 }, { profile_digest: '0'.repeat(64) },
    { tools: { descriptor_utf8: '{}', digest: digest('{}') } },
    { compiler: { descriptor_utf8: '{}', digest: digest('{}') } },
  ]) {
    globalThis.fetch = async () => Response.json({ ...capabilities(), qualification_provenance: QUALIFICATION, ...change })
    await assert.rejects(getFinalRenderCapabilities(), FinalRenderResponseValidationError)
  }
  // Production authority is Hub runtime state, so a non-production profile may report capacity.
  globalThis.fetch = async () => Response.json({ ...capabilities(), eligible: 2, idle: 1 })
  assert.deepEqual(await getFinalRenderCapabilities().then(value => [value.eligible, value.idle]), [2, 1])
  const value = capabilities()
  const production = JSON.parse(value.profile_descriptor_utf8)
  production.production_eligible = true
  value.profile_descriptor_utf8 = JSON.stringify(production)
  value.profile_digest = digest(value.profile_descriptor_utf8)
  globalThis.fetch = async () => Response.json({ ...value, qualification_provenance: QUALIFICATION })
  await assert.rejects(getFinalRenderCapabilities(), FinalRenderResponseValidationError)
  await fs.writeFile(path.join(fixture.dir, 'provenance-fixtures.json'), JSON.stringify({ TOOL, DESCRIPTOR, SEALED }), { flag: 'wx', mode: 0o600 })
})
