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

test('validates closed late-label stages, reveal refs, ordering and cue uniqueness', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const base = fixture.cases[1].packet
  const packetWith = (ops: any[]): any => {
    const packet = copy(base)
    const logoAt = packet.recipe.operations.findIndex((op: any) => op.kind === 'logo')
    packet.recipe.operations.splice(logoAt, 0, ...ops)
    const cueAssets = new Map<string, number>()
    for (const op of ops) {
      for (const id of [op.label?.asset?.logical_id, op.line?.asset?.logical_id,
        ...(op.reveal?.frames ?? []).map((frame: any) => frame.asset.logical_id),
        ...(op.line_reveal?.frames ?? []).map((frame: any) => frame.asset.logical_id)]) {
        if (id) cueAssets.set(id, id.endsWith('_line') ? 1280 * 720 : 240 * 80)
      }
    }
    for (const [id, size_bytes] of cueAssets) packet.manifest.push({
      logical_id: id, safe_name: `${id}.png`, role: 'cue_label', sha256: '4'.repeat(64), size_bytes,
    })
    packet.manifest.sort((a: any, b: any) => a.logical_id.localeCompare(b.logical_id))
    rehash(packet)
    return packet
  }
  const asset = (logical_id: string) => ({ type: 'asset_ref', logical_id })
  const revealFrameCount = Math.max(2, Math.ceil(base.recipe.canvas.working_fps * 0.3) + 1)
  const frameList = (prefix: string, count = revealFrameCount, operationIndex = 9) => Array.from({ length: count }, (_, i) => ({
    asset: asset(`cue_${String(operationIndex).padStart(4, '0')}_${prefix}${String(i).padStart(4, '0')}`), progress: i / (count - 1),
  }))
  const pop = {
    kind: 'late_label_stage', contract: 'studio.render.late-label.v3', cue_id: 'cue_a',
    enable: { start_sec: 0.25, end_sec: 1.75 }, placement: { x_px: 20, y_px: 30 },
    motion: { kind: 'pop', entrance_sec: 0.3 }, label: { asset: asset('cue_0008_label') },
    reveal: null, line: null, line_reveal: null,
  }
  const wipe = {
    ...pop, cue_id: 'cue_b', motion: { kind: 'wipe', entrance_sec: 0.3 }, label: null,
    reveal: { duration_sec: 0.3, frames: frameList('r') },
  }
  const valid = packetWith([pop, wipe])
  assert.doesNotThrow(() => validateRenderPacketSyntax(valid))
  assert.equal(valid.recipe.operations[8].label.asset.logical_id, 'cue_0008_label')

  const reject = (ops: any[], alter?: (packet: any) => void): void => {
    const packet = packetWith(ops)
    alter?.(packet)
    rehash(packet)
    assert.throws(() => validateRenderPacketSyntax(packet), /Invalid render packet/)
  }
  reject([pop, { ...wipe, cue_id: 'cue_a' }])
  reject([pop], packet => { packet.recipe.operations.splice(6, 0, packet.recipe.operations.splice(-2, 1)[0]) })
  reject([{ ...pop, raw_filter: 'null' }])
  reject([{ ...pop, enable: { start_sec: 2, end_sec: 6.1 } }])
  reject([{ ...pop, placement: { x_px: -1, y_px: 0 } }])
  reject([{ ...pop, label: null }])
  reject([{ ...wipe, reveal: { duration_sec: 0.3, frames: frameList('r', revealFrameCount - 1) } }])
  reject([{ ...wipe, reveal: { duration_sec: 0.3, frames: frameList('r').map((f: any, i: number) => i === 1 ? { ...f, progress: 0.9 } : f) } }])
  reject([pop], packet => { packet.manifest.find((entry: any) => entry.logical_id === 'cue_0008_label').role = 'overlay' })
  reject([pop], packet => { packet.manifest.find((entry: any) => entry.logical_id === 'cue_0008_label').safe_name = 'cue_0008_label.jpg' })
})

test('validates closed subtitle stages, ordered font ids, and manifest-equal font hashes', async () => {
  const { validateRenderPacketSyntax } = await validator()
  const base = fixture.cases[1].packet
  const asset = (logical_id: string) => ({ type: 'asset_ref', logical_id })
  const subtitleOp = (fontId = 'subtitle_font_0000', family = 'Inter', sha256 = '6'.repeat(64)) => ({
    kind: 'subtitle_stage', contract: 'studio.render.subtitle.v1',
    ass: asset('subtitle_ass'),
    fonts: [{ asset: asset(fontId), family, sha256 }],
  })
  const packetWith = (ops: any[], alterManifest?: (manifest: any[]) => void): any => {
    const packet = copy(base)
    const logoAt = packet.recipe.operations.findIndex((op: any) => op.kind === 'logo')
    packet.recipe.operations.splice(logoAt, 0, ...ops)
    packet.manifest.push(
      { logical_id: 'subtitle_ass', safe_name: 'subtitle_ass.ass', role: 'subtitle_ass', sha256: '5'.repeat(64), size_bytes: 128 },
      { logical_id: 'subtitle_font_0000', safe_name: 'subtitle_font_0000.ttf', role: 'subtitle_font', sha256: '6'.repeat(64), size_bytes: 4096 },
    )
    alterManifest?.(packet.manifest)
    packet.manifest.sort((a: any, b: any) => a.logical_id.localeCompare(b.logical_id))
    rehash(packet)
    return packet
  }
  const valid = packetWith([subtitleOp()])
  assert.doesNotThrow(() => validateRenderPacketSyntax(valid))
  // The stage sits after the presentation frame and before the late-label/logo tail.
  const kinds = valid.recipe.operations.map((op: any) => op.kind)
  assert.ok(kinds.indexOf('subtitle_stage') > kinds.indexOf('presentation_frame'))
  assert.ok(kinds.indexOf('subtitle_stage') < kinds.indexOf('logo'))

  const reject = (ops: any[], alterManifest?: (manifest: any[]) => void): void => {
    assert.throws(() => validateRenderPacketSyntax(packetWith(ops, alterManifest)), /Invalid render packet/)
  }
  // Contract and shape are exact: no other version, no bare/extra fields, no empty font list.
  reject([{ ...subtitleOp(), contract: 'studio.render.subtitle.v2' }])
  reject([{ ...subtitleOp(), fonts: [] }])
  reject([{ ...subtitleOp(), extra: true }])
  // Font ids are the generated ordered names, never a source filename.
  reject([subtitleOp('subtitle_font_0001')])
  reject([subtitleOp('Inter.ttf')])
  // The family is a family name, never a path.
  reject([subtitleOp('subtitle_font_0000', 'Inter/../../etc')])
  // A font record's hash is the manifest's hash — one value, never two.
  reject([subtitleOp()], manifest => {
    manifest.find((entry: any) => entry.logical_id === 'subtitle_font_0000').sha256 = '7'.repeat(64)
  })
  // Extension follows role: ASS for the document, TTF/OTF for fonts.
  reject([subtitleOp()], manifest => {
    manifest.find((entry: any) => entry.logical_id === 'subtitle_ass').safe_name = 'subtitle_ass.png'
  })
  reject([subtitleOp()], manifest => {
    manifest.find((entry: any) => entry.logical_id === 'subtitle_font_0000').safe_name = 'subtitle_font_0000.png'
  })
  // The stage is a singleton and the manifest stays a bijection.
  reject([subtitleOp(), subtitleOp()])
  reject([subtitleOp()], manifest => {
    manifest.splice(manifest.findIndex((entry: any) => entry.logical_id === 'subtitle_ass'), 1)
  })
})
