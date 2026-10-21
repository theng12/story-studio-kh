import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { renderHash } from '../lib/render-hash-v1.js'

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/final-render-packet-syntax-v1.json', import.meta.url),
  'utf8',
))
const validator = () => import('../lib/final-render-recipe.js')
const copy = <T>(value: T): T => structuredClone(value)

function rehash(packet: any): void {
  packet.recipe_digest = renderHash('recipe', packet.recipe)
  packet.manifest_digest = renderHash('manifest', packet.manifest)
  packet.packet_digest = renderHash('packet', {
    recipe_digest: packet.recipe_digest,
    manifest_digest: packet.manifest_digest,
  })
}

test('accepts the two literal schema-only packets and verifies their frozen R/M/P', async () => {
  const { validateRenderPacketSyntax } = await validator()
  assert.equal(fixture.schema_test_only, true)
  assert.equal(fixture.qualification, 'none')
  for (const entry of fixture.cases) {
    const packet = copy(entry.packet)
    assert.strictEqual(validateRenderPacketSyntax(packet), packet, entry.name)
    assert.equal(renderHash('recipe', packet.recipe), packet.recipe_digest, entry.name)
    assert.equal(renderHash('manifest', packet.manifest), packet.manifest_digest, entry.name)
    assert.equal(renderHash('packet', {
      recipe_digest: packet.recipe_digest,
      manifest_digest: packet.manifest_digest,
    }), packet.packet_digest, entry.name)
  }
})

test('accepts and preserves fractional frame border and radius values before renderer scaling', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const base = fixture.cases[1].packet
  for (const vector of fixture.fractional_frame_acceptance) {
    const packet = copy(base)
    packet.recipe.canvas.width = vector.canvas.width
    packet.recipe.canvas.height = vector.canvas.height
    const frame = packet.recipe.operations.find((op: any) => op.kind === 'presentation_frame')
    frame.border_width = vector.border_width
    frame.corner_radius = vector.corner_radius
    packet.recipe_digest = vector.recipe_digest
    packet.manifest_digest = vector.manifest_digest
    packet.packet_digest = vector.packet_digest
    assert.equal(renderHash('recipe', packet.recipe), vector.recipe_digest, vector.name)
    assert.equal(renderHash('manifest', packet.manifest), vector.manifest_digest, vector.name)
    assert.equal(renderHash('packet', {
      recipe_digest: vector.recipe_digest,
      manifest_digest: vector.manifest_digest,
    }), vector.packet_digest, vector.name)
    const validated = validateRenderPacketSyntax(packet)
    const validatedFrame = validated.recipe.operations instanceof Array
      ? validated.recipe.operations.find((op: any) => op.kind === 'presentation_frame') as any
      : undefined
    assert.equal(validatedFrame.border_width, vector.border_width, vector.name)
    assert.equal(validatedFrame.corner_radius, vector.corner_radius, vector.name)
    assert.equal(Number.isInteger(validatedFrame.border_width), false, vector.name)
    assert.equal(Number.isInteger(validatedFrame.corner_radius), false, vector.name)
  }

  const reject = (key: 'border_width' | 'corner_radius', value: unknown, updateHashes = true): void => {
    const packet = copy(base)
    const frame = packet.recipe.operations.find((op: any) => op.kind === 'presentation_frame')
    frame[key] = value
    if (updateHashes) rehash(packet)
    assert.throws(() => validateRenderPacketSyntax(packet), /Invalid render packet/)
  }
  reject('border_width', 160.01)
  reject('corner_radius', 300.01)
  reject('border_width', true)
  reject('border_width', Number.NaN, false)
})

test('covers all eight operation kinds, repeated overlay order, and explicit input modes', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const entry = fixture.cases[1]
  const packet = copy(entry.packet)
  validateRenderPacketSyntax(packet)
  assert.deepEqual([...new Set(packet.recipe.operations.map((op: any) => op.kind))], [
    'overlay_layer',
    'classic_color_grade',
    'classic_vignette',
    'classic_film_grain',
    'aged_archive_film',
    'classic_letterbox',
    'presentation_frame',
    'logo',
  ])
  assert.deepEqual(packet.recipe.operations.slice(0, 2).map((op: any) => op.asset.logical_id),
    entry.overlapping_overlay_order)
  assert.deepEqual(entry.expected_input_allocation, ['base', 'audio', 'logo', 'overlay_a', 'overlay_b', 'frame'])
  assert.deepEqual(packet.recipe.operations.slice(0, 2).map((op: any) => op.input_mode), [
    { kind: 'loop_stream' },
    { kind: 'loop_still', decoder: 'png' },
  ])
})

test('refuses malformed, missing, extra, numeric, prototype, cycle, and NUL values', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const base = fixture.cases[0].packet
  const reject = (change: (packet: any) => void, updateHashes = true): void => {
    const packet = copy(base)
    change(packet)
    if (updateHashes) rehash(packet)
    assert.throws(() => validateRenderPacketSyntax(packet), /Invalid render packet/)
  }
  reject(packet => { delete packet.recipe.encode })
  reject(packet => { packet.recipe.encode.filter_argv = ['scale=1:1'] })
  reject(packet => { packet.extra = null }, false)
  reject(packet => { packet.recipe.namespace = 'studio.render.final.v2' })
  reject(packet => { packet.recipe.profile_digest = 'A'.repeat(64) })
  reject(packet => { packet.recipe.canvas.width = true })
  reject(packet => { packet.recipe.canvas.width = 3 })
  reject(packet => { packet.recipe.canvas.width = 9007199254740990; packet.recipe.canvas.height = 2 })
  reject(packet => { packet.recipe.canvas.working_fps = 23 })
  reject(packet => { packet.recipe.target_duration_sec = 0 })
  reject(packet => { packet.recipe.effects_gate.start_sec = 0 })
  reject(packet => { packet.recipe.effects_gate = { start_sec: 2, end_sec: 2 } })
  reject(packet => { packet.recipe.encode.bitrate_kbps = 499 })
  reject(packet => { packet.recipe.encode.crf = 18; packet.recipe.encode.quality_cpu_preset = 'medium' })
  reject(packet => { packet.manifest[0].safe_name = 'audio\0.wav' })

  const nonfinite = copy(base)
  nonfinite.recipe.target_duration_sec = Number.POSITIVE_INFINITY
  assert.throws(() => validateRenderPacketSyntax(nonfinite), /Invalid render packet/)
  const inherited = Object.assign(Object.create({ inherited: true }), copy(base))
  assert.throws(() => validateRenderPacketSyntax(inherited), /Invalid render packet/)
  const cycle = copy(base)
  cycle.recipe.self = cycle.recipe
  assert.throws(() => validateRenderPacketSyntax(cycle), /Invalid render packet/)
  const unsafe = copy(base)
  Object.defineProperty(unsafe, '__proto__', { value: null, enumerable: true })
  assert.throws(() => validateRenderPacketSyntax(unsafe), /Invalid render packet/)
})

test('refuses stage, singleton, operation shape, range, color, expression, and decoder drift', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const full = fixture.cases[1].packet
  const reject = (change: (packet: any) => void): void => {
    const packet = copy(full)
    change(packet)
    rehash(packet)
    assert.throws(() => validateRenderPacketSyntax(packet), /Invalid render packet/)
  }
  reject(packet => packet.recipe.operations.reverse())
  reject(packet => packet.recipe.operations.push(copy(packet.recipe.operations[2])))
  reject(packet => { packet.recipe.operations[0].kind = 'subtitles' })
  reject(packet => { packet.recipe.operations[0].enabled = true })
  reject(packet => { packet.recipe.operations[0].filter_argv = ['movie=secret'] })
  reject(packet => { packet.recipe.operations[0].input_mode = { kind: 'loop_still' } })
  reject(packet => { packet.recipe.operations[0].input_mode = { kind: 'single', decoder: 'png' } })
  reject(packet => { packet.recipe.operations[0].sizing = { mode: 'width_fraction', value: 0 } })
  reject(packet => { packet.recipe.operations[0].placement = { mode: 'origin', x: 'W/2' } })
  reject(packet => { packet.recipe.operations[0].time_range.end_sec = 2.5 })
  reject(packet => { packet.recipe.operations[0].chroma.color = '#00ff00' })
  reject(packet => { packet.recipe.operations[2].contrast = 3.1 })
  reject(packet => { packet.recipe.operations[3].strength = -0.1 })
  reject(packet => { packet.recipe.operations[4].strength = 1.5 })
  reject(packet => { packet.recipe.operations[5].strength = 0 })
  reject(packet => { packet.recipe.operations[4].strength = 7.5 })
  reject(packet => { packet.recipe.operations[5].strength = 20.5 })
  reject(packet => { packet.recipe.operations[6].ratio = '16:9' })
  reject(packet => { packet.recipe.operations[7].border_color = 'red' })
  reject(packet => { packet.recipe.operations[7].background.input_mode.decoder = 'jpeg' })
  reject(packet => { packet.recipe.operations[8].anchor = 'x=0:y=0' })
  reject(packet => { packet.recipe.operations[8].margin_px = 201 })
  reject(packet => { packet.recipe.operations[8].margin_px = 4.5 })
})

test('refuses manifest order, names, roles, references, unused assets, hashes, and body mutations', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const full = fixture.cases[1].packet
  const reject = (change: (packet: any) => void, updateHashes = true): void => {
    const packet = copy(full)
    change(packet)
    if (updateHashes) rehash(packet)
    assert.throws(() => validateRenderPacketSyntax(packet), /Invalid render packet/)
  }
  reject(packet => { [packet.manifest[0], packet.manifest[1]] = [packet.manifest[1], packet.manifest[0]] })
  reject(packet => { packet.manifest[1].logical_id = 'audio'; packet.manifest[1].safe_name = 'audio.mp4' })
  reject(packet => { packet.manifest[2].safe_name = '../frame.png' })
  reject(packet => { packet.manifest[2].safe_name = 'frame.jpeg' })
  reject(packet => { packet.manifest[2].role = 'overlay' })
  reject(packet => { packet.manifest[2].size_bytes = 0 })
  reject(packet => { packet.manifest[2].sha256 = packet.manifest[2].sha256.toUpperCase() })
  reject(packet => { packet.recipe.operations[0].asset.logical_id = 'missing' })
  reject(packet => { packet.manifest.push({
    logical_id: 'unused',
    safe_name: 'unused.png',
    role: 'overlay',
    sha256: '3'.repeat(64),
    size_bytes: 1,
  }) })
  reject(packet => { packet.recipe.operations[1].asset.logical_id = 'overlay_a' })
  reject(packet => { packet.recipe.base_video.extra = null })
  reject(packet => { packet.recipe_digest = '0'.repeat(64) }, false)
  reject(packet => { packet.manifest_digest = '0'.repeat(64) }, false)
  reject(packet => { packet.packet_digest = '0'.repeat(64) }, false)
  reject(packet => { packet.recipe.target_duration_sec = 2.5 }, false)
  reject(packet => { packet.manifest[0].size_bytes = 16 }, false)
})
