/**
 * The logo's own gate: a measured intro/title start must hide the logo for
 * that window, not for a closing-only tail bound, and a remote render must
 * either express that exact window in the frozen recipe enum or stay local.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { basename } from 'node:path'

import { resolveFinalLogoBounds } from '../lib/final-render-core.js'
import { buildGateEnable } from '../lib/video-effects.js'
import { describeFinalRenderExport, finalizeFinalRenderPacket, type FinalRenderExportDescription } from '../lib/final-render-export.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import { compileFinalRenderPacket } from '../lib/final-render-compiler.js'
import type { CompositionOpts } from '../generators/video.js'

const HASH_1 = '1'.repeat(64)
const HASH_2 = '2'.repeat(64)
const HASH_3 = '3'.repeat(64)

const discovery = {
  format: 'studio.render.gateway-capabilities.v1',
  profile_digest: HASH_1,
} as unknown as FinalRenderCapabilities

function opts(overrides: Partial<CompositionOpts> = {}): CompositionOpts {
  return {
    videoInputPath: '/schema/assets/base.mp4',
    premixedAudioPath: '/schema/assets/audio.wav',
    targetDuration: 100,
    w: 128,
    h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4',
    outputFile: '/schema/output/final.mp4',
    encodingEffort: 'ultrafast',
    codec: 'h264',
    job: { job_id: 'logo-gate', output_lines: [] } as any,
    ...overrides,
  }
}

const logo = {
  enabled: true, image_path: '/schema/assets/logo.png', position: 'top-left' as const,
  opacity: 1, scale: 0.1, margin: 20, hide_during_intro: true,
}

function assetsFor(description: FinalRenderExportDescription) {
  return description.source_requirements.map((source, index) => ({
    logical_id: source.logical_id,
    role: source.role,
    safe_name: basename(source.source_path),
    size_bytes: 1,
    sha256: [HASH_1, HASH_2, HASH_3][index] ?? HASH_1,
    input_mode: { kind: 'single' as const },
  }))
}

function compiledArgs(description: ReturnType<typeof describeFinalRenderExport>): string {
  if (description.kind !== 'exportable') throw new Error(`expected exportable, got ${description.reason}`)
  const assets = assetsFor(description)
  const finalized = finalizeFinalRenderPacket(description, assets)
  const localAssets = new Map(assets.map(asset => [asset.logical_id, `/private/${asset.safe_name}`]))
  const compiled = compileFinalRenderPacket(finalized.packet, localAssets, '/private/final-output.mp4')
  return compiled.tiers[0]!.build().join(' ')
}

test('a closing-only gate cannot mask hide_during_intro: measured 8s start wins and the tail bound stays', () => {
  const bounds = resolveFinalLogoBounds({
    globalStartSec: 0, globalEndSec: 30, hideDuringIntro: true, preSceneDuration: 8,
  })
  assert.deepEqual(bounds, { startSec: 8, endSec: 30 })
  assert.equal(buildGateEnable(bounds.startSec, bounds.endSec), ":enable='between(t,8.00,30.00)'")
})

test('hide_during_intro off leaves a closing-only gate unchanged', () => {
  assert.deepEqual(
    resolveFinalLogoBounds({ globalStartSec: 0, globalEndSec: 30, hideDuringIntro: false, preSceneDuration: 8 }),
    { startSec: 0, endSec: 30 },
  )
  assert.equal(buildGateEnable(0, 30), ":enable='lt(t,30.00)'")
})

test('an explicit exclude-intro start wins over the measured opening clock', () => {
  assert.deepEqual(
    resolveFinalLogoBounds({ globalStartSec: 8, globalEndSec: 30, hideDuringIntro: true, preSceneDuration: 3 }),
    { startSec: 8, endSec: 30 },
  )
})

test('no opening clock falls back to the legacy 10s start, never to a closing-only gate', () => {
  assert.deepEqual(
    resolveFinalLogoBounds({ globalStartSec: 0, globalEndSec: 30, hideDuringIntro: true }),
    { startSec: 10, endSec: 30 },
  )
  assert.equal(buildGateEnable(10, 30), ":enable='between(t,10.00,30.00)'")
})

test('an invalid opening clock or bound is ignored rather than producing a non-finite gate', () => {
  for (const preSceneDuration of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
    assert.deepEqual(
      resolveFinalLogoBounds({ globalStartSec: 0, globalEndSec: 30, hideDuringIntro: true, preSceneDuration }),
      { startSec: 10, endSec: 30 },
      `preSceneDuration ${String(preSceneDuration)} falls back to 10`,
    )
  }
  for (const globalEndSec of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.deepEqual(
      resolveFinalLogoBounds({ globalStartSec: 0, globalEndSec, hideDuringIntro: true, preSceneDuration: 8 }),
      { startSec: 8, endSec: 0 },
      `globalEndSec ${String(globalEndSec)} is not a closing bound`,
    )
  }
})

test('remote export keeps a representable logo window identical to the local gate', () => {
  const description = describeFinalRenderExport(opts({
    logo, excludeIntroFromEffects: true, preSceneDuration: 8, postAudioStart: 30,
  }), discovery)
  assert.equal(description.kind, 'exportable')
  if (description.kind !== 'exportable') return
  assert.deepEqual(description.recipe.effects_gate, { start_sec: 8, end_sec: 30 })
  assert.equal(
    description.recipe.operations.find((operation: any) => operation.kind === 'logo').gate,
    'effects_gate',
  )
  assert.match(compiledArgs(description), /overlay=.*:enable='between\(t,8\.00,30\.00\)'/)
})

test('remote export represents the legacy 10s intro gate and the always-on gate exactly', () => {
  const after10 = describeFinalRenderExport(opts({ logo }), discovery)
  assert.equal(after10.kind, 'exportable')
  if (after10.kind !== 'exportable') return
  assert.equal(after10.recipe.operations.find((operation: any) => operation.kind === 'logo').gate, 'after_10_seconds')
  assert.match(compiledArgs(after10), /overlay=.*:enable='gt\(t,10\)'/)

  const always = describeFinalRenderExport(opts({
    logo: { ...logo, hide_during_intro: false },
  }), discovery)
  assert.equal(always.kind, 'exportable')
  if (always.kind !== 'exportable') return
  assert.equal(always.recipe.operations.find((operation: any) => operation.kind === 'logo').gate, 'always')
  assert.doesNotMatch(compiledArgs(always), /overlay=.*:enable=/)
})

test('an unsupported logo intro window stays local with the exact reason', () => {
  const description = describeFinalRenderExport(opts({
    logo, postAudioStart: 30, preSceneDuration: 8,
  }), discovery)
  assert.deepEqual(description, { kind: 'local-only', reason: 'logo_intro_gate' })
})
