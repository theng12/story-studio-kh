import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import {
  describeFinalRenderExport,
  finalizeFinalRenderPacket,
  finalRenderRequestedEncode,
  type FinalRenderVerifiedAsset,
} from '../lib/final-render-export.js'
import { canonicalRenderValue, renderHash } from '../lib/render-hash-v1.js'
import type { Job } from '../models/types.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(TEST_DIR, '..')
const FROZEN_FIXTURE_PATH = path.join(TEST_DIR, 'fixtures/final-render-compiler-v1.json')
const fixtureBytes = readFileSync(FROZEN_FIXTURE_PATH)
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as any

const HASH_1 = '1'.repeat(64)
const HASH_2 = '2'.repeat(64)

const discovery: FinalRenderCapabilities = {
  format: 'studio.render.gateway-capabilities.v1',
  private: true,
  chargeable: false,
  owner_scope: '11111111-1111-4111-8111-111111111111',
  gateway_instance_id: '22222222-2222-4222-8222-222222222222',
  story_instance_id: '33333333-3333-4333-8333-333333333333',
  eligible: 0,
  idle: 0,
  server_time: 1_797_113_600,
  profile_descriptor_utf8: '{"format":"studio.render.profile.v1","production_eligible":false}',
  profile_digest: HASH_1,
  tools: { descriptor_utf8: '{"format":"studio.render.tools.v1"}', digest: HASH_2 },
  compiler: { descriptor_utf8: '{"format":"studio.render.compiler.v1"}', digest: '3'.repeat(64) },
}

function job(): Job {
  return {
    job_id: 'export-test-job',
    project_slug: 'export-test-project',
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Export test',
    status: 'running',
    created_at: '2026-10-15T00:00:00.000Z',
    started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
  }
}

function opts(overrides: Partial<CompositionOpts> = {}): CompositionOpts {
  return {
    videoInputPath: '/schema/assets/base.mp4',
    premixedAudioPath: '/schema/assets/audio.wav',
    targetDuration: 2,
    w: 128,
    h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4',
    outputFile: '/schema/output/final.mp4',
    encodingEffort: 'ultrafast',
    codec: 'h264',
    job: job(),
    ...overrides,
  }
}

function exportable(value: ReturnType<typeof describeFinalRenderExport>) {
  if (value.kind !== 'exportable') assert.fail(`expected exportable description, got ${value.reason}`)
  assert.equal(value.kind, 'exportable')
  return value
}

const FIELD_POLICY = {
  videoInputPath: 'source',
  premixedAudioPath: 'source',
  logo: 'recipe',
  targetDuration: 'recipe',
  w: 'recipe',
  h: 'recipe',
  quality: 'recipe',
  format: 'recipe',
  outputFile: 'local-orchestration',
  colorGrading: 'recipe',
  vignette: 'recipe',
  chromaKey: 'recipe',
  overlays: 'recipe',
  filmGrain: 'recipe',
  agedArchiveFilm: 'recipe',
  letterbox: 'recipe',
  frame: 'recipe',
  subtitles: 'unsupported-when-active',
  contextualCues: 'unsupported-when-active',
  sceneEffects: 'unsupported-when-active',
  episodeStack: 'unsupported-when-active',
  excludeIntroFromEffects: 'recipe',
  preSceneDuration: 'recipe',
  sceneTimelineOffsetSec: 'local-orchestration',
  postAudioStart: 'recipe',
  encodingEffort: 'recipe',
  codec: 'recipe',
  videoBitrateKbps: 'recipe',
  resolvedLoudness: 'captured-authority',
  finalCheckExpected: 'captured-authority',
  narrationOffsetSec: 'captured-authority',
  segmentation: 'optimizer-hint',
  stillTailFromSec: 'optimizer-hint',
  // Drawn by the local composer after the base video; not part of the exported
  // recipe, so it must never be classified as one.
  sleepTitle: 'unsupported-when-active',
  job: 'local-orchestration',
} as const satisfies Record<keyof CompositionOpts, 'source' | 'recipe' | 'captured-authority' | 'local-orchestration' | 'optimizer-hint' | 'unsupported-when-active'>

test('every current composition option has an explicit export policy', () => {
  assert.deepEqual(Object.keys(FIELD_POLICY), [
    'videoInputPath', 'premixedAudioPath', 'logo', 'targetDuration', 'w', 'h', 'quality', 'format',
    'outputFile', 'colorGrading', 'vignette', 'chromaKey', 'overlays', 'filmGrain',
    'agedArchiveFilm', 'letterbox', 'frame', 'subtitles', 'contextualCues', 'sceneEffects',
    'episodeStack', 'excludeIntroFromEffects', 'preSceneDuration', 'sceneTimelineOffsetSec',
    'postAudioStart', 'encodingEffort', 'codec', 'videoBitrateKbps', 'resolvedLoudness', 'finalCheckExpected', 'narrationOffsetSec',
    'segmentation', 'stillTailFromSec', 'sleepTitle', 'job',
  ])
})

test('compilation defaults map to one ordered single-frame foreground without mutating caller data', () => {
  const input = opts({
    targetDuration: 8.5,
    w: 1920,
    h: 1080,
    quality: { crf: 18, preset: 'slow', fps: 30 },
    encodingEffort: 'slow',
    overlays: {
      enabled: true,
      layers: [{
        id: 'compilation-scene-1',
        enabled: true,
        source_path: '/schema/assets/chapter-1.png',
        chroma_key: { color: '#FFFFFF', similarity: 0.15, blend: 0.10 },
        opacity: 1,
        scale_pct: 0.5,
        position_anchor: 'center',
        time_range: { start_s: 0, end_s: 8.5 },
        loop: false,
      }],
    },
  })
  const before = structuredClone(input)
  const beforeDiscovery = structuredClone(discovery)
  const description = exportable(describeFinalRenderExport(input, discovery))

  assert.deepEqual(description.recipe.operations, [{
    kind: 'overlay_layer',
    asset: { type: 'asset_ref', logical_id: 'overlay_0001' },
    input_mode: { kind: 'single' },
    opacity: 1,
    sizing: { mode: 'width_fraction', value: 0.5 },
    placement: { mode: 'anchor', value: 'center' },
    time_range: { start_sec: 0, end_sec: 8.5 },
    chroma: { color: '#FFFFFF', similarity: 0.15, blend: 0.10 },
  }])
  assert.deepEqual(description.source_requirements, [
    { logical_id: 'base', role: 'base_video', source_path: '/schema/assets/base.mp4' },
    { logical_id: 'audio', role: 'premixed_audio', source_path: '/schema/assets/audio.wav' },
    { logical_id: 'overlay_0001', role: 'overlay', source_path: '/schema/assets/chapter-1.png' },
  ])
  assert.deepEqual(description.composition, {
    execution_strategy: 'whole_video',
    local_segmentation_offered: false,
    still_tail_from_sec: null,
    recipe_sha256: renderHash('recipe', description.recipe),
  })
  assert.deepEqual(input, before)
  assert.deepEqual(discovery, beforeDiscovery)
})

test('F0 finalization binds literal verified bytes and returns the frozen packet unchanged', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '923bff7b3955f69b0fe9b4e140f56eedb05c5c8fa2dd93e7d249ae8d67b848e7')
  const description = exportable(describeFinalRenderExport(opts(), discovery))
  const assets: FinalRenderVerifiedAsset[] = [
    {
      logical_id: 'base', role: 'base_video', safe_name: 'base.mp4',
      size_bytes: 21, sha256: '5dfc42c5e8f02125444d7b9862814d0163a49147dde44f56ec2a986d217340a1',
      input_mode: { kind: 'single' },
    },
    {
      logical_id: 'audio', role: 'premixed_audio', safe_name: 'audio.wav',
      size_bytes: 22, sha256: '7d9b42b32ad2007a4ca2abf19180e3380b729c2afd9e2e3e22c73cd1993ee684',
      input_mode: { kind: 'single' },
    },
  ]
  const beforeDescription = structuredClone(description)
  const beforeAssets = structuredClone(assets)
  const finalized = finalizeFinalRenderPacket(description, assets)

  assert.deepEqual(finalized.packet, fixture.f0_base_audio.packet)
  assert.deepEqual(finalized.source_requirements, description.source_requirements)
  assert.deepEqual(finalized.composition, description.composition)
  assert.deepEqual(description, beforeDescription)
  assert.deepEqual(assets, beforeAssets)
})

test('standard classic mapping keeps full-duration semantics and records local optimizer hints', () => {
  const description = exportable(describeFinalRenderExport(opts({
    targetDuration: 1_800,
    quality: { crf: 18, preset: 'slow', fps: 30 },
    encodingEffort: 'slow',
    overlays: {
      enabled: true,
      layers: [
        { id: 'stream', enabled: true, source_path: '/schema/assets/overlay.webm', opacity: 0.75, scale: 'contain', position_anchor: 'center', time_range: { start_s: 0.1, end_s: 1_799 }, chroma_key: { color: '#00FF00', similarity: 0.15, blend: 0.1 } },
        { id: 'repeat', enabled: true, source_path: '/schema/assets/overlay.webp', opacity: 0.6, scale_pct: 0.25, position_anchor: 'lower-right', time_range: { start_s: 0, end_s: null } },
        { id: 'repeat-again', enabled: true, source_path: '/schema/assets/overlay.webp', opacity: 1, scale: 'native', position: { x: '0', y: '0' }, loop: false },
      ],
    },
    colorGrading: { enabled: true, preset: 'cinematic', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 },
    vignette: { enabled: true, strength: 0.4 },
    filmGrain: { enabled: true, strength: 7 },
    agedArchiveFilm: { enabled: true, strength: 20 },
    letterbox: { enabled: true, ratio: '1.85:1', mode: 'fit', color: 'black' },
    frame: { enabled: true, inset_pct: 4, border_width: 12, corner_radius: 20, border_color: '#F2C14E', background_color: '#111C34', background_path: '/schema/assets/frame.png', fit: 'cover' },
    logo: { enabled: true, image_path: '/schema/assets/logo.png', position: 'top-left', opacity: 0.8, scale: 0.2, margin: 4, hide_during_intro: false },
    excludeIntroFromEffects: true,
    preSceneDuration: 0.25,
    postAudioStart: 1_799.75,
    stillTailFromSec: 1_200,
    segmentation: { checkpoint: {} as any, persist: async () => {}, inputsFingerprint: 'f'.repeat(64) },
  }), discovery))

  assert.equal(description.recipe.target_duration_sec, 1_800)
  assert.deepEqual(description.recipe.effects_gate, { start_sec: 0.25, end_sec: 1_799.75 })
  assert.deepEqual(description.composition, {
    execution_strategy: 'whole_video',
    local_segmentation_offered: true,
    still_tail_from_sec: 1_200,
    recipe_sha256: renderHash('recipe', description.recipe),
  })
  assert.deepEqual(description.recipe.operations.map((operation: { kind: string }) => operation.kind), [
    'overlay_layer', 'overlay_layer', 'overlay_layer', 'classic_color_grade', 'classic_vignette',
    'classic_film_grain', 'aged_archive_film', 'classic_letterbox', 'presentation_frame', 'logo',
  ])
  assert.deepEqual(description.recipe.operations.slice(0, 3), [
    {
      kind: 'overlay_layer', asset: { type: 'asset_ref', logical_id: 'overlay_0001' },
      input_mode: { kind: 'loop_stream' }, opacity: 0.75, sizing: { mode: 'contain' },
      placement: { mode: 'anchor', value: 'center' }, time_range: { start_sec: 0.1, end_sec: 1_799 },
      chroma: { color: '#00FF00', similarity: 0.15, blend: 0.1 },
    },
    {
      kind: 'overlay_layer', asset: { type: 'asset_ref', logical_id: 'overlay_0002' },
      input_mode: { kind: 'loop_still', decoder: null }, opacity: 0.6,
      sizing: { mode: 'width_fraction', value: 0.25 }, placement: { mode: 'anchor', value: 'lower-right' },
      time_range: { start_sec: 0, end_sec: null }, chroma: null,
    },
    {
      kind: 'overlay_layer', asset: { type: 'asset_ref', logical_id: 'overlay_0003' },
      input_mode: { kind: 'single' }, opacity: 1, sizing: { mode: 'native' },
      placement: { mode: 'origin' }, time_range: null, chroma: null,
    },
  ])
  assert.deepEqual(description.source_requirements.filter(source => source.role === 'overlay').map(source => source.source_path), [
    '/schema/assets/overlay.webm', '/schema/assets/overlay.webp', '/schema/assets/overlay.webp',
  ], 'repeated source paths remain distinct ordered occurrences')
})

function compositionFence(value: ReturnType<typeof exportable>): string {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from('studio.render.story.sources.v1\0'),
    Buffer.from(canonicalRenderValue({
      sources: value.source_requirements,
      composition: value.composition,
    })),
  ])).digest('hex')
}

test('recipe digest binds creative, encoder, and canvas settings into the source-generation fence', () => {
  const cases = [
    exportable(describeFinalRenderExport(opts(), discovery)),
    exportable(describeFinalRenderExport(opts({
      colorGrading: { enabled: true, preset: 'cinematic', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 },
    }), discovery)),
    exportable(describeFinalRenderExport(opts({ codec: 'h265', encodingEffort: 'hardware' }), discovery)),
    exportable(describeFinalRenderExport(opts({ w: 1920, h: 1080 }), discovery)),
  ]

  for (const value of cases) {
    assert.deepEqual(value.source_requirements, cases[0]!.source_requirements)
    assert.equal(value.composition.recipe_sha256, renderHash('recipe', value.recipe))
  }
  assert.equal(new Set(cases.map(compositionFence)).size, cases.length)
})

test('resolved effort, codec, container, bitrate, and quality pairs pass through without remote inference', () => {
  const cases = [
    {
      input: opts({ format: 'mp4', encodingEffort: 'hardware', codec: 'h265', videoBitrateKbps: 8_000, quality: { crf: 18, preset: 'slow', fps: 30 } }),
      expected: { container: 'mp4', requested_codec: 'h265', requested_effort: 'hardware', crf: 18, quality_cpu_preset: 'slow', bitrate_kbps: 8_000 },
    },
    {
      input: opts({ format: 'webm', encodingEffort: undefined, codec: undefined, quality: { crf: 23, preset: 'medium', fps: 24 } }),
      expected: { container: 'webm', requested_codec: 'h264', requested_effort: 'medium', crf: 23, quality_cpu_preset: 'medium', bitrate_kbps: null },
    },
  ]
  for (const item of cases) {
    assert.deepEqual(exportable(describeFinalRenderExport(item.input, discovery)).recipe.encode, item.expected)
  }
})

test('the requested encode and the packet encode are one and the same tuple', () => {
  const hardware = opts({
    encodingEffort: 'hardware', codec: 'h264',
    quality: { crf: 23, preset: 'medium', fps: 24 },
  })
  const capped = opts({
    encodingEffort: 'hardware', codec: 'h264', videoBitrateKbps: 8_000,
    quality: { crf: 23, preset: 'medium', fps: 24 },
  })
  const hardwareTuple = {
    container: 'mp4', requested_codec: 'h264', requested_effort: 'hardware',
    crf: 23, quality_cpu_preset: 'medium', bitrate_kbps: null,
  }
  const cappedTuple = { ...hardwareTuple, bitrate_kbps: 8_000 }

  assert.deepEqual(finalRenderRequestedEncode(hardware), hardwareTuple)
  assert.deepEqual(finalRenderRequestedEncode(capped), cappedTuple)
  assert.deepEqual(exportable(describeFinalRenderExport(hardware, discovery)).recipe.encode, hardwareTuple)
  assert.deepEqual(exportable(describeFinalRenderExport(capped, discovery)).recipe.encode, cappedTuple)
  // No cap and a positive cap are different tuples, never the same answer.
  assert.notDeepEqual(finalRenderRequestedEncode(hardware), finalRenderRequestedEncode(capped))

  // An encode Story cannot packet is not offered to the Gateway as a requestable one.
  assert.equal(finalRenderRequestedEncode(opts({ codec: 'unsupported' as CompositionOpts['codec'] })), null)
  assert.equal(finalRenderRequestedEncode(opts({ videoBitrateKbps: 100 })), null)
  assert.equal(finalRenderRequestedEncode(opts({ quality: { crf: 20, preset: 'medium', fps: 24 } })), null)
})

test('a prepared shaped logo exports the shaped asset and never the unshaped original', () => {
  const logo: NonNullable<CompositionOpts['logo']> = {
    enabled: true, image_path: '/schema/assets/logo.jpg', position: 'top-left',
    opacity: 0.8, scale: 0.2, margin: 4, hide_during_intro: false,
    shape: 'rounded', corner_radius_pct: 25,
  }
  assert.deepEqual(
    describeFinalRenderExport(opts({ logo }), discovery),
    { kind: 'local-only', reason: 'logo_shape' },
    'without the cut asset the composition stays local, never unshaped',
  )

  const description = exportable(describeFinalRenderExport(
    opts({ logo }), discovery, undefined, undefined, { path: '/schema/assets/logo-rounded.png' },
  ))
  assert.deepEqual(description.source_requirements.filter(item => item.role === 'logo'), [
    { logical_id: 'logo', role: 'logo', source_path: '/schema/assets/logo-rounded.png' },
  ])
  assert.deepEqual(description.recipe.operations.find((operation: any) => operation.kind === 'logo'), {
    kind: 'logo', asset: { type: 'asset_ref', logical_id: 'logo' }, opacity: 0.8,
    scale: 0.2, anchor: 'top-left', margin_px: 4, gate: 'always',
  })
})

test('active unsupported creative choices and ambiguous classic values stay local before commitment', () => {
  const cases: Array<[string, Partial<CompositionOpts>, string]> = [
    ['subtitles', { subtitles: { enabled: true, source: 'upload', srt_path: '/schema/captions.srt', style: {} as any } }, 'subtitles_capability_unavailable'],
    ['contextual cues', { contextualCues: [{ id: 'cue', text: 'cue', start_sec: 1, end_sec: 2 } as any] }, 'contextual_cues'],
    ['scene effects', { sceneEffects: { enabled: true, overlays: [{ id: 'film', enabled: true }] } as any }, 'scene_effects'],
    ['episode stack', { episodeStack: { entries: [{}] } as any }, 'episode_stack'],
    ['sleep title', { sleepTitle: { text: 'A quiet journey', start_s: 0.5, end_s: 1.5 } }, 'sleep_title'],
    ['custom logo placement', { logo: { enabled: true, image_path: '/schema/logo.png', position: 'custom', custom_x: 4, custom_y: 5, opacity: 1, scale: 0.1, margin: 20, hide_during_intro: false } }, 'logo_custom_position'],
    ['unprepared shaped logo', { logo: { enabled: true, image_path: '/schema/logo.png', position: 'top-left', opacity: 1, scale: 0.1, margin: 20, hide_during_intro: false, shape: 'circle' } }, 'logo_shape'],
    ['literal zero logo margin', { logo: { enabled: true, image_path: '/schema/logo.png', position: 'top-left', opacity: 1, scale: 0.1, margin: 0, hide_during_intro: false } }, 'logo_margin_default'],
    ['custom overlay expression', { overlays: { enabled: true, layers: [{ id: 'custom', enabled: true, source_path: '/schema/overlay.png', position: { x: 'W-w-7', y: 'H-h-9' } }] } }, 'overlay_custom_position'],
    ['out-of-range overlay scale', { overlays: { enabled: true, layers: [{ id: 'wide', enabled: true, source_path: '/schema/overlay.png', scale_pct: 1.2 }] } }, 'overlay_scale'],
    ['enabled overlay without a source', { overlays: { enabled: true, layers: [{ id: 'missing', enabled: true, source_path: '' }] } }, 'overlay_source'],
    ['enabled legacy chroma without a source', { chromaKey: { enabled: true, source_path: '', color: '#00FF00', similarity: 0.15, blend: 0.1 } }, 'overlay_source'],
    ['enabled logo without a source', { logo: { enabled: true, image_path: '', position: 'top-left', opacity: 1, scale: 0.1, margin: 20, hide_during_intro: false } }, 'logo_source'],
  ]
  for (const [label, override, reason] of cases) {
    const result = describeFinalRenderExport(opts(override), discovery)
    assert.deepEqual(result, { kind: 'local-only', reason }, label)
  }
})

test('finalization refuses missing mode facts and compiler letterbox no-op instead of approximating', () => {
  const overlay = exportable(describeFinalRenderExport(opts({
    overlays: { enabled: true, layers: [{ id: 'still', enabled: true, source_path: '/schema/still.png' }] },
  }), discovery))
  assert.throws(() => finalizeFinalRenderPacket(overlay, [
    { logical_id: 'base', role: 'base_video', safe_name: 'base.mp4', size_bytes: 1, sha256: HASH_1, input_mode: { kind: 'single' } },
    { logical_id: 'audio', role: 'premixed_audio', safe_name: 'audio.wav', size_bytes: 1, sha256: HASH_2, input_mode: { kind: 'single' } },
    { logical_id: 'overlay_0001', role: 'overlay', safe_name: 'overlay_0001.png', size_bytes: 1, sha256: '3'.repeat(64), input_mode: null as any },
  ]), /mode|decoder|verified/i)

  const noOpLetterbox = exportable(describeFinalRenderExport(opts({
    w: 148,
    h: 80,
    letterbox: { enabled: true, ratio: '1.85:1', mode: 'fit', color: 'black' },
  }), discovery))
  assert.throws(() => finalizeFinalRenderPacket(noOpLetterbox, [
    { logical_id: 'base', role: 'base_video', safe_name: 'base.mp4', size_bytes: 1, sha256: HASH_1, input_mode: { kind: 'single' } },
    { logical_id: 'audio', role: 'premixed_audio', safe_name: 'audio.wav', size_bytes: 1, sha256: HASH_2, input_mode: { kind: 'single' } },
  ]), /letterbox_noop|letterbox/i)
})

function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const result: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      result.push((statement.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  return result
}

test('pure exporter has no runtime filesystem, service, process, or network dependency', () => {
  const sourcePath = path.join(SERVER_ROOT, 'lib/final-render-export.ts')
  const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.deepEqual(runtimeSpecifiers(source).sort(), [
    './final-render-compiler.js',
    './final-render-recipe.js',
    './render-hash-v1.js',
  ])
})
