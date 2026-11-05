import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { compileFinalRenderPacket } from '../lib/final-render-compiler.js'
import { renderHash } from '../lib/render-hash-v1.js'

/**
 * Late-label stage (studio.render.late-label.v3) — the compiler half of the
 * frozen acceptance case LL-F09: every motion compiles, the primary video
 * controls EOF, reveal sequences are finite image2 inputs whose pattern is
 * derived beside the output (never written here, never on the wire), cue
 * burn-ins report a nonzero count, and packets without cues keep the exact
 * old behaviour. Frozen schema/fixtures live under
 * _orchestra/remote-render-parity-20261104/; this file asserts the compiled
 * argv shapes those contracts require.
 */

const FPS = 25
const DURATION = 6
const START = 2.125
const END = 4.875
const REVEAL_COUNT = Math.max(2, Math.ceil(FPS * 0.3) + 1) // 9 at 25 fps

type Motion = 'none' | 'pop' | 'slide' | 'float' | 'pulse' | 'wipe' | 'line-draw'
type AssetEntry = { logical_id: string; safe_name: string; role: string; sha256: string; size_bytes: number }

function entry(logical_id: string, role: string, extension: string): AssetEntry {
  return { logical_id, safe_name: `${logical_id}.${extension}`, role, sha256: 'a'.repeat(64), size_bytes: 1024 }
}

function revealFrames(stem: string): { duration_sec: number; frames: { asset: { type: 'asset_ref'; logical_id: string }; progress: number }[] } {
  return {
    duration_sec: 0.3,
    frames: Array.from({ length: REVEAL_COUNT }, (_, i) => ({
      asset: { type: 'asset_ref', logical_id: `${stem}${String(i).padStart(4, '0')}` },
      progress: i / (REVEAL_COUNT - 1),
    })),
  }
}

function lateLabelOp(cueId: string, motion: Motion, stem: string, withLine = false): Record<string, any> {
  const wipe = motion === 'wipe'
  const lineDraw = motion === 'line-draw'
  return {
    kind: 'late_label_stage',
    contract: 'studio.render.late-label.v3',
    cue_id: cueId,
    enable: { start_sec: START, end_sec: END },
    placement: { x_px: 120, y_px: 160 },
    motion: { kind: motion, entrance_sec: 0.3 },
    label: wipe ? null : { asset: { type: 'asset_ref', logical_id: `${stem}label` } },
    reveal: wipe ? revealFrames(`${stem}r`) : null,
    line: withLine && !lineDraw ? { asset: { type: 'asset_ref', logical_id: `${stem}line` } } : null,
    line_reveal: lineDraw ? revealFrames(`${stem}lr`) : null,
  }
}

function cueAssets(...operations: Record<string, any>[]): AssetEntry[] {
  const ids = new Set<string>()
  for (const op of operations) {
    if (op.label) ids.add(op.label.asset.logical_id)
    if (op.line) ids.add(op.line.asset.logical_id)
    for (const frames of [op.reveal, op.line_reveal]) {
      for (const frame of frames?.frames ?? []) ids.add(frame.asset.logical_id)
    }
  }
  return [...ids].map(id => entry(id, 'cue_label', 'png'))
}

function presentationFrameOp(): Record<string, any> {
  return {
    kind: 'presentation_frame', inset_pct: 5, border_width: 4, corner_radius: 8,
    border_color: '#112233', background_color: '#000000', fit: 'cover',
    background: { kind: 'solid' },
  }
}

function logoOp(): Record<string, any> {
  return {
    kind: 'logo', asset: { type: 'asset_ref', logical_id: 'logo' },
    opacity: 0.8, scale: 0.1, anchor: 'bottom-right', margin_px: 12, gate: 'always',
  }
}

function buildPacket(operations: Record<string, any>[], extra: AssetEntry[] = []) {
  const recipe = {
    namespace: 'studio.render.final.v1',
    profile_digest: 'f'.repeat(64),
    base_video: { type: 'asset_ref', logical_id: 'base' },
    premixed_audio: { type: 'asset_ref', logical_id: 'audio' },
    canvas: { width: 1280, height: 720, working_fps: FPS },
    target_duration_sec: DURATION,
    effects_gate: { start_sec: null, end_sec: null },
    operations,
    encode: {
      container: 'mp4', requested_codec: 'h264', requested_effort: 'medium',
      crf: 23, quality_cpu_preset: 'medium', bitrate_kbps: null,
    },
  }
  const manifest = [entry('audio', 'premixed_audio', 'wav'), entry('base', 'base_video', 'mp4'), ...extra]
    .sort((left, right) => left.logical_id < right.logical_id ? -1 : left.logical_id > right.logical_id ? 1 : 0)
  const recipe_digest = renderHash('recipe', recipe)
  const manifest_digest = renderHash('manifest', manifest)
  const packet = {
    recipe,
    manifest,
    recipe_digest,
    manifest_digest,
    packet_digest: renderHash('packet', { recipe_digest, manifest_digest }),
  }
  const localAssets = new Map(manifest.map(item => [item.logical_id, `/schema/${item.safe_name}`]))
  return { packet, localAssets }
}

function graph(argv: readonly string[]): string {
  const index = argv.indexOf('-filter_complex')
  assert.notEqual(index, -1, 'full tier must carry the final filter graph')
  return argv[index + 1]!
}

function compile(operations: Record<string, any>[], extra: AssetEntry[], outputPath = '/schema/output/final.mp4') {
  const { packet, localAssets } = buildPacket(operations, extra)
  const before = JSON.stringify(packet)
  const assetsBefore = [...localAssets]
  const result = compileFinalRenderPacket(structuredClone(packet) as unknown, localAssets, outputPath)
  assert.equal(JSON.stringify(packet), before, 'compilation must not mutate its packet')
  assert.deepEqual([...localAssets], assetsBefore, 'compilation must not mutate its asset map')
  return result
}

test('every motion compiles with the frozen clock, EOF and motion shape', () => {
  for (const motion of ['none', 'pop', 'slide', 'float', 'pulse', 'wipe', 'line-draw'] as const) {
    const op = lateLabelOp('cue-one', motion, 'cue_0000_')
    const result = compile([op], cueAssets(op))
    const argv = result.tiers[0].build()
    const filters = graph(argv)

    assert.ok(filters.includes('eof_action=repeat'), `${motion}: cue overlays must not control EOF`)
    assert.ok(filters.includes('enable=between(t\\,2.125\\,4.875)'), `${motion}: composed-clock enable window`)
    assert.ok(result.requestedBurnIns.includes('1 contextual cue(s)'), `${motion}: nonzero contextual cue burn-in`)

    const loops = argv.filter(arg => arg === '-loop')
    const shortest = filters.includes(':shortest=1')
    if (motion === 'pop' || motion === 'pulse') {
      assert.equal(loops.length, 1, `${motion}: scale motion loops its still at working_fps`)
      assert.ok(argv.includes('25'), `${motion}: loop framerate is working_fps`)
      assert.ok(filters.includes('eval=frame'), `${motion}: scale must evaluate per frame`)
      assert.equal(shortest, true, `${motion}: pop/pulse keep local shortest=1`)
    } else {
      assert.equal(loops.length, 0, `${motion}: no loop input`)
      assert.equal(shortest, false, `${motion}: only scale motions may use shortest=1`)
    }
    if (motion === 'slide') {
      assert.ok(filters.includes('-w*(1-(t-2.125)/0.3)'), `${motion}: frozen slide formula against overlay width`)
    }
    if (motion === 'float') {
      assert.ok(filters.includes('sin((t-2.125)*2)*3'), `${motion}: frozen float formula`)
    }
    if (motion === 'wipe') {
      assert.ok(argv.includes('-framerate'), `${motion}: sequence input carries working_fps framerate`)
      assert.ok(argv.some(arg => arg.endsWith('.cue-sequences/cue_0000_r%04d.png')), `${motion}: derived image2 pattern`)
      assert.ok(filters.includes('setpts=PTS+2.125/TB'), `${motion}: frame 0 begins at enable.start_sec`)
      const uses = result.inputUses.filter(use => use.logicalId.startsWith('cue_0000_r'))
      assert.equal(uses.length, REVEAL_COUNT, `${motion}: every ordered reveal ref feeds inputUses`)
      assert.equal(new Set(uses.map(use => use.index)).size, 1, `${motion}: one sequence input per reveal`)
    }
    if (motion === 'line-draw') {
      assert.ok(argv.some(arg => arg.endsWith('.cue-sequences/cue_0000_lr%04d.png')), `${motion}: line sequence pattern`)
      assert.ok(filters.includes('setpts=PTS+2.125/TB'), `${motion}: line frame 0 begins at enable.start_sec`)
      const lineAt = filters.indexOf('overlay=x=0:y=0:eof_action=repeat')
      const labelAt = filters.indexOf('overlay=x=120:y=160:eof_action=repeat')
      assert.ok(lineAt >= 0 && labelAt > lineAt, `${motion}: the line composites before the label`)
      assert.ok(argv.includes('/schema/cue_0000_label.png'), `${motion}: label still is its own input`)
    }
  }
})

test('reveal sequences are derived beside outputPath, never written, refs ordered', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'late-label-compile-'))
  try {
    const op = lateLabelOp('cue-one', 'wipe', 'cue_0000_')
    const { packet } = buildPacket([op], cueAssets(op))
    assert.equal(JSON.stringify(packet).includes('%04d'), false, 'no pattern ever rides in a packet')
    const outputPath = path.join(dir, 'final.mp4')
    const result = compileFinalRenderPacket(structuredClone(packet) as unknown, new Map(
      packet.manifest.map(item => [item.logical_id, `/schema/${item.safe_name}`]),
    ), outputPath)
    const argv = result.tiers[0].build()
    const pattern = path.join(dir, '.cue-sequences', 'cue_0000_r%04d.png')

    assert.ok(argv.includes(pattern), 'pattern is derived from the output path, not the packet')
    assert.equal(existsSync(path.join(dir, '.cue-sequences')), false, 'the pure compiler creates no sequence directory')

    const patternAt = argv.indexOf(pattern)
    assert.equal(argv[patternAt - 1], '-i')
    assert.equal(argv[patternAt - 2], '25')
    assert.equal(argv[patternAt - 3], '-framerate')
    const sequenceIndex = argv.slice(0, patternAt).filter(arg => arg === '-i').length - 1

    const frameIds = op.reveal.frames.map((frame: any) => frame.asset.logical_id)
    const uses = result.inputUses.filter(use => frameIds.includes(use.logicalId))
    assert.deepEqual(uses.map(use => use.logicalId), frameIds, 'refs feed inputUses in play order')
    assert.ok(uses.every(use => use.index === sequenceIndex), 'every ordered ref maps to the sequence input')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('operation-index naming, full stage stack and cue burn-in stay nonzero', () => {
  const op = lateLabelOp('cue-one', 'wipe', 'cue_0001_')
  const logo = logoOp()
  const result = compile(
    [presentationFrameOp(), op, logo],
    [...cueAssets(op), entry('logo', 'logo', 'png')],
  )
  const argv = result.tiers[0].build()

  assert.ok(argv.some(arg => arg.endsWith('.cue-sequences/cue_0001_r%04d.png')),
    'pattern stem uses the recipe.operations index, not a cue ordinal')
  const uses = result.inputUses.filter(use => use.logicalId.startsWith('cue_0001_'))
  assert.equal(uses.length, REVEAL_COUNT)
  assert.ok(result.requestedBurnIns.includes('1 contextual cue(s)'))
  assert.ok(result.requestedBurnIns.includes('logo'))
  assert.ok(graph(argv).includes('mainframe'), 'frame stage still compiles')
})

test('two cues count as two burn-ins and one op per cue', () => {
  const first = lateLabelOp('cue-one', 'none', 'cue_0000_')
  const second = lateLabelOp('cue-two', 'pop', 'cue_0001_')
  const result = compile([first, second], cueAssets(first, second))
  assert.ok(result.requestedBurnIns.includes('2 contextual cue(s)'))
  const cueUses = result.inputUses.filter(use => use.logicalId.startsWith('cue_000'))
  assert.equal(cueUses.filter(use => use.logicalId === 'cue_0000_label').length, 1)
  assert.equal(cueUses.filter(use => use.logicalId === 'cue_0001_label').length, 1)
})

test('a static leader line composites at 0,0 before the label', () => {
  const op = lateLabelOp('cue-one', 'none', 'cue_0000_', true)
  const result = compile([op], cueAssets(op))
  const argv = result.tiers[0].build()
  const filters = graph(argv)
  const lineAt = filters.indexOf('overlay=x=0:y=0:eof_action=repeat')
  const labelAt = filters.indexOf('overlay=x=120:y=160:eof_action=repeat')
  assert.ok(lineAt >= 0 && labelAt > lineAt, 'line before label')
  assert.ok(result.inputUses.some(use => use.logicalId === 'cue_0000_line'))
  const linePathAt = argv.indexOf('/schema/cue_0000_line.png')
  assert.ok(linePathAt > 0, 'static line path is an input')
  assert.equal(argv[linePathAt - 1], '-i', 'the static line input carries exactly one -i flag')
  assert.notEqual(argv[linePathAt - 2], '-i', 'no doubled -i before the static line path')
})

test('packets without late labels keep the old argv and burn-ins', () => {
  const result = compile([], [])
  const argv = result.tiers[0].build()
  assert.deepEqual(result.requestedBurnIns, [], 'a cue-less packet must not gain a cue burn-in')
  assert.equal(argv.join('\n').includes('.cue-sequences'), false, 'no sequence path for cue-less packets')
  assert.equal(graph(argv).includes('eof_action=repeat:enable='), false, 'no cue overlays on the old path')
})
