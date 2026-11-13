/**
 * Late-label export binding — the three verified source defects of release 383:
 *
 * 1. The pure exporter minted `label` as the BOOLEAN `ref()` result (and pushed
 *    `line` bare) where the frozen recipe takes `{asset: asset_ref}` for both.
 * 2. Scratch filenames sanitised the raw cue id, so `a_b` and `a-b` collided and
 *    overwrote each other before staging.
 * 3. Staging verified prepared cue facts through a bag keyed role/size/hash, so
 *    two cue files swapped after preparation could satisfy each other's facts.
 *
 * Tests are focused and intentionally NOT run by the authoring worker (Updater
 * gate reruns only; see the task brief).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import type { CompositionOpts } from '../generators/video.js'
import {
  describeFinalRenderExport,
  finalizeFinalRenderPacket,
  type FinalRenderExportDescription,
  type FinalRenderVerifiedAsset,
} from '../lib/final-render-export.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import {
  packetCueId,
  prepareFinalRenderLabelAssets,
  type PreparedLabelAssetFile,
  type PreparedLabelRevealFrames,
  type PreparedLateLabel,
} from '../lib/final-render-label-assets.js'
import { renderHash } from '../lib/render-hash-v1.js'
import type { ContextualCue, Job } from '../models/types.js'
import {
  _setFinalRenderStagingHooksForTesting,
  stageFinalRenderIntent,
  type FinalRenderStagingInput,
} from '../services/final-render-staging.js'
import '../../../scripts/testing/loopback-supertest.mjs'


const HASH_1 = '1'.repeat(64)
const HASH_2 = '2'.repeat(64)
const FRAME_COUNT = 3 // max(2, ceil(fps 5 * 0.3) + 1)
const BASE_BYTES = Buffer.from('base-video\n')
const AUDIO_BYTES = Buffer.from('premixed-audio\n')
const LABEL_BYTES = Buffer.alloc(16, 0x41)
const LINE_BYTES = Buffer.alloc(16, 0x42)

const previousDataDir = process.env.STORY_STUDIO_DATA_DIR
let dataRoot: string
let projectsRoot: string

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function discovery(): FinalRenderCapabilities {
  return {
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
    late_labels: {
      format: 'studio.render.late-label.v3',
      motions: ['none', 'pop', 'slide', 'float', 'pulse', 'wipe', 'line-draw'],
    },
  }
}

function job(jobId: string): Job {
  return {
    job_id: jobId,
    project_slug: 'late-label-binding',
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Late label binding',
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
    job: job('late-label-export-test'),
    contextualCues: [cueFixture('any-cue')],
    ...overrides,
  }
}

function cueFixture(id: string, overrides: Partial<ContextualCue> = {}): ContextualCue {
  return {
    id, scene_id: 'scene-1', start_sec: 0.5, end_sec: 1.5,
    title: id, kind: 'location_date', placement: 'top-left',
    template: 'label:location-pin', entrance: 'fade', exit: 'fade',
    status: 'approved', created_at: '', updated_at: '', ...overrides,
  }
}

function exportable(value: ReturnType<typeof describeFinalRenderExport>) {
  if (value.kind !== 'exportable') assert.fail(`expected exportable description, got ${value.reason}`)
  return value
}

function scratch(name: string, width: number, height: number): PreparedLabelAssetFile {
  return { path: `/scratch/${name}`, width, height, sha256: hash(name), size_bytes: 64 }
}

function revealFrames(purpose: string): PreparedLabelRevealFrames {
  const frames = []
  for (let index = 0; index < FRAME_COUNT; index++) {
    const name = `${purpose}${String(index).padStart(4, '0')}`
    frames.push({
      path: `/scratch/${name}.png`,
      progress: index / (FRAME_COUNT - 1),
      sha256: hash(name),
      size_bytes: 64,
    })
  }
  return { frames, width: 32, height: 16 }
}

function staticLabel(): PreparedLateLabel {
  return {
    cue_id: 'static-cue', motion: 'none',
    start_sec: 0.5, end_sec: 1.5, x_px: 4, y_px: 8,
    label: scratch('label-static.png', 32, 16), reveal: null,
    line: scratch('line-static.png', 128, 96), line_reveal: null,
  }
}

function wipeLabel(): PreparedLateLabel {
  return {
    cue_id: 'wipe-cue', motion: 'wipe',
    start_sec: 0.5, end_sec: 1.5, x_px: 4, y_px: 8,
    label: null, reveal: revealFrames('r'), line: null, line_reveal: null,
  }
}

function lineDrawLabel(): PreparedLateLabel {
  return {
    cue_id: 'line-cue', motion: 'line-draw',
    start_sec: 0.5, end_sec: 1.5, x_px: 4, y_px: 8,
    label: scratch('label-linedraw.png', 32, 16), reveal: null,
    line: null, line_reveal: revealFrames('lr'),
  }
}

function describeWith(prepared: PreparedLateLabel) {
  return exportable(describeFinalRenderExport(opts(), discovery(), {
    labels: [prepared], drawtext_cue_ids: [], unknown_cue_ids: [],
  }))
}

/** Verified-asset facts derived from the description's own requirements — no IO. */
function verifiedFrom(description: FinalRenderExportDescription): FinalRenderVerifiedAsset[] {
  return description.source_requirements.map(requirement => ({
    logical_id: requirement.logical_id,
    role: requirement.role,
    safe_name: `${requirement.logical_id}${path.extname(requirement.source_path)}`,
    size_bytes: 10,
    sha256: hash(requirement.logical_id),
    input_mode: { kind: 'single' as const },
  }))
}

function operation(description: FinalRenderExportDescription): Record<string, any> {
  const operations = description.recipe.operations as Record<string, any>[]
  assert.equal(operations.length, 1, 'the cue is the composition\'s only operation')
  return operations[0]!
}

test('a static label and leader line finalize as nested {asset} refs, never a bare ref or boolean', () => {
  const description = describeWith(staticLabel())
  const op = operation(description)
  assert.deepEqual(op.label, { asset: { type: 'asset_ref', logical_id: 'cue_0000_label' } })
  assert.deepEqual(op.line, { asset: { type: 'asset_ref', logical_id: 'cue_0000_line' } })
  assert.equal(op.reveal, null)
  assert.equal(op.line_reveal, null)
  assert.equal(op.cue_id, 'static-cue')
  const cueRequirements = description.source_requirements.filter(item => item.role === 'cue_label')
  assert.deepEqual(cueRequirements.map(item => [item.logical_id, path.basename(item.source_path)]).sort(), [
    ['cue_0000_label', 'label-static.png'],
    ['cue_0000_line', 'line-static.png'],
  ])
  // The frozen recipe validator is the contract: a boolean or bare ref throws here.
  const finalized = finalizeFinalRenderPacket(description, verifiedFrom(description))
  const finalizedOp = (finalized.packet.recipe as Record<string, any>).operations[0]
  assert.deepEqual(finalizedOp.label, { asset: { type: 'asset_ref', logical_id: 'cue_0000_label' } })
  assert.deepEqual(finalizedOp.line, { asset: { type: 'asset_ref', logical_id: 'cue_0000_line' } })
})

test('a wipe cue finalizes with its reveal frames and a null label', () => {
  const description = describeWith(wipeLabel())
  const op = operation(description)
  assert.equal(op.label, null)
  assert.equal(op.line, null)
  assert.equal(op.line_reveal, null)
  assert.equal(op.reveal.duration_sec, 0.3)
  assert.equal(op.reveal.frames.length, FRAME_COUNT)
  op.reveal.frames.forEach((frame: any, index: number) => {
    assert.deepEqual(frame, {
      asset: { type: 'asset_ref', logical_id: `cue_0000_r${String(index).padStart(4, '0')}` },
      progress: index / (FRAME_COUNT - 1),
    })
  })
  finalizeFinalRenderPacket(description, verifiedFrom(description))
})

test('a line-draw cue finalizes with leader reveal frames and a null line', () => {
  const description = describeWith(lineDrawLabel())
  const op = operation(description)
  assert.equal(op.line, null)
  assert.equal(op.reveal, null)
  assert.deepEqual(op.label, { asset: { type: 'asset_ref', logical_id: 'cue_0000_label' } })
  assert.equal(op.line_reveal.duration_sec, 0.3)
  assert.equal(op.line_reveal.frames.length, FRAME_COUNT)
  op.line_reveal.frames.forEach((frame: any, index: number) => {
    assert.deepEqual(frame, {
      asset: { type: 'asset_ref', logical_id: `cue_0000_lr${String(index).padStart(4, '0')}` },
      progress: index / (FRAME_COUNT - 1),
    })
  })
  finalizeFinalRenderPacket(description, verifiedFrom(description))
})

test('colliding raw cue ids keep distinct scratch files and packet ids', async () => {
  // Retained under the harness data root (§10): the harness lifecycle retires it,
  // so this test never deletes anything itself.
  const dir = await fs.mkdtemp(path.join(dataRoot, 'late-label-scratch-'))
  const prepared = await prepareFinalRenderLabelAssets({
    cues: [
      cueFixture('a_b', { title: 'ALPHA-LABEL' }),
      cueFixture('a-b', { title: 'BETA-LABEL' }),
    ],
    frame_w: 640, frame_h: 360, fps: 5, offset_sec: 0, dir,
  })
  assert.equal(prepared.drawtext_cue_ids.length, 0)
  assert.equal(prepared.unknown_cue_ids.length, 0)
  assert.equal(prepared.labels.length, 2)
  const [first, second] = prepared.labels
  assert.equal(first!.cue_id, 'a_b')
  assert.equal(second!.cue_id, 'a-b')
  assert.notEqual(first!.cue_id, second!.cue_id)
  const labelPaths = [first!.label!.path, second!.label!.path]
  assert.notEqual(labelPaths[0], labelPaths[1])
  assert.deepEqual(labelPaths.map(p => path.basename(p)).sort(), ['label-a-b.png', 'label-a_b.png'])
  const [firstBytes, secondBytes] = await Promise.all(labelPaths.map(p => fs.readFile(p)))
  // Both files exist and differ: without unique names the second cue overwrote the first.
  assert.notDeepEqual(firstBytes, secondBytes)
  const allPaths = prepared.labels.flatMap(item => [
    item.label?.path, item.line?.path,
    ...(item.reveal?.frames ?? []).map(frame => frame.path),
    ...(item.line_reveal?.frames ?? []).map(frame => frame.path),
  ]).filter((p): p is string => typeof p === 'string')
  assert.equal(new Set(allPaths).size, allPaths.length, 'every scratch path is unique')
})

// ---- staging seam (mirrors final-render-staging.test.ts fixtures) ----

const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const STORY_ID = '33333333-3333-4333-8333-333333333333'
const ORIGIN = 'https://private-render.invalid'
const probes: string[] = []
let activeDestination: string

function profileUtf8(): string {
  return JSON.stringify({
    format: 'studio.render.profile.v1',
    implementation: 'story-classic-no-font-v1',
    recipe_namespace: 'studio.render.final.v1',
    compiler_artifact_sha256: 'c'.repeat(64),
    tools_artifact_sha256: 'd'.repeat(64),
    combination_set: 'retained-classic-no-font-candidate-v1',
    tier_policy: 'story-final-chain-v1',
    output_policy: 'story-final-output-v1',
    execution_bounds: {
      canvas_pairs: [{ width: 128, height: 96 }],
      working_fps: [5],
      max_duration_sec: 60,
      max_operations: 32,
      max_assets: 32,
      max_asset_bytes: 64,
      max_total_input_bytes: 128,
      max_pixel_frames: 128 * 96 * 5 * 60,
      scratch_reserve_bytes: 1,
      output_limit_bytes: 1_048_576,
      process_tree_rss_limit_bytes: 1_048_576,
      cumulative_wall_seconds: 60,
    },
    hardware_qualification_record_sha256: null,
    fidelity_record_sha256: null,
    production_eligible: false,
  })
}

function stagingCapabilities(): FinalRenderCapabilities {
  const profile = profileUtf8()
  const tools = '{"format":"studio.render.tools.v1"}'
  const compiler = '{"format":"studio.render.compiler.v1"}'
  return {
    format: 'studio.render.gateway-capabilities.v1',
    private: true,
    chargeable: false,
    owner_scope: OWNER_SCOPE,
    gateway_instance_id: GATEWAY_ID,
    story_instance_id: STORY_ID,
    eligible: 0,
    idle: 0,
    server_time: 1_797_113_600,
    profile_descriptor_utf8: profile,
    profile_digest: hash(profile),
    tools: { descriptor_utf8: tools, digest: hash(tools) },
    compiler: { descriptor_utf8: compiler, digest: hash(compiler) },
    late_labels: { format: 'studio.render.late-label.v3', motions: ['none'] },
  }
}

function lateLabelOp(): Record<string, any> {
  return {
    kind: 'late_label_stage',
    contract: 'studio.render.late-label.v3',
    cue_id: 'cue-a',
    enable: { start_sec: 0.5, end_sec: 1.5 },
    placement: { x_px: 4, y_px: 8 },
    motion: { kind: 'none', entrance_sec: 0.3 },
    label: { asset: { type: 'asset_ref', logical_id: 'cue_0000_label' } },
    reveal: null,
    line: { asset: { type: 'asset_ref', logical_id: 'cue_0000_line' } },
    line_reveal: null,
  }
}

function stagingDescription(
  basePath: string, audioPath: string, labelPath: string, linePath: string, profileDigest: string,
): FinalRenderExportDescription {
  const recipe = {
    namespace: 'studio.render.final.v1' as const,
    profile_digest: profileDigest,
    base_video: { type: 'asset_ref' as const, logical_id: 'base' },
    premixed_audio: { type: 'asset_ref' as const, logical_id: 'audio' },
    canvas: { width: 128, height: 96, working_fps: 5 },
    target_duration_sec: 2,
    effects_gate: { start_sec: null, end_sec: null },
    operations: [lateLabelOp()],
    encode: {
      container: 'mp4' as const, requested_codec: 'h264' as const, requested_effort: 'ultrafast' as const,
      crf: 23, quality_cpu_preset: 'ultrafast' as const, bitrate_kbps: null,
    },
  }
  return {
    kind: 'exportable',
    recipe,
    source_requirements: [
      { logical_id: 'base', role: 'base_video', source_path: basePath },
      { logical_id: 'audio', role: 'premixed_audio', source_path: audioPath },
      { logical_id: 'cue_0000_label', role: 'cue_label', source_path: labelPath },
      { logical_id: 'cue_0000_line', role: 'cue_label', source_path: linePath },
    ],
    composition: {
      execution_strategy: 'whole_video',
      local_segmentation_offered: false,
      still_tail_from_sec: null,
      recipe_sha256: renderHash('recipe', recipe),
    },
  }
}

async function prepareStagingCase(slug: string, swapped: boolean): Promise<FinalRenderStagingInput> {
  const projectDir = path.join(projectsRoot, slug)
  const sourceDir = path.join(dataRoot, 'work', slug, 'sources')
  const projectTreeVideoDir = path.join(projectDir, 'episodes', 'EP1', 'video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(activeDestination, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectTreeVideoDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  const labelPath = path.join(sourceDir, 'label-cue-a.png')
  const linePath = path.join(sourceDir, 'line-cue-a.png')
  await fs.writeFile(base, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(audio, AUDIO_BYTES, { mode: 0o600 })
  // Facts are taken from the prepared bytes BEFORE any post-prepare mutation.
  await fs.writeFile(labelPath, LABEL_BYTES, { mode: 0o600 })
  await fs.writeFile(linePath, LINE_BYTES, { mode: 0o600 })
  const labelFacts = { path: labelPath, sha256: createHash('sha256').update(LABEL_BYTES).digest('hex'), size_bytes: LABEL_BYTES.length }
  const lineFacts = { path: linePath, sha256: createHash('sha256').update(LINE_BYTES).digest('hex'), size_bytes: LINE_BYTES.length }
  if (swapped) {
    await fs.writeFile(labelPath, LINE_BYTES, { mode: 0o600 })
    await fs.writeFile(linePath, LABEL_BYTES, { mode: 0o600 })
  }
  const stagingJob: Job = {
    job_id: `late-label-${slug}`,
    project_slug: slug,
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Late label binding',
    status: 'running',
    created_at: '2026-10-15T00:00:00.000Z',
    started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
  }
  await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [stagingJob] }), { mode: 0o600 })
  const queue = await import('../services/job-queue.js')
  queue._forgetProjectPersistenceForTesting(slug)
  const discovered = stagingCapabilities()
  return {
    job: stagingJob,
    description: stagingDescription(base, audio, labelPath, linePath, discovered.profile_digest),
    discovery: discovered,
    scope: {
      origin: ORIGIN,
      owner_scope: OWNER_SCOPE,
      gateway_instance_id: GATEWAY_ID,
      story_instance_id: STORY_ID,
    },
    destination: {
      code: 'EP1',
      title: 'Late label binding',
      format: 'mp4',
      project_tree_video_dir: projectTreeVideoDir,
    },
    loudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
    late_label_assets: {
      labels: [{
        cue_id: 'cue-a',
        label: labelFacts,
        reveal: null,
        line: lineFacts,
        line_reveal: null,
      }],
    },
  }
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT ?? os.tmpdir()
  dataRoot = await fs.mkdtemp(path.join(harnessRoot, 'late-label-binding-data-'))
  await fs.chmod(dataRoot, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = dataRoot
  const pm = await import('../services/project-manager.js')
  projectsRoot = pm.projectsRoot()
  activeDestination = path.join(dataRoot, 'destination')
  await fs.mkdir(activeDestination, { recursive: true, mode: 0o700 })
  _setFinalRenderStagingHooksForTesting({
    resolveExternalFinalVideoDir: async () => activeDestination,
    probe: event => { probes.push(event.phase) },
  })
})

after(() => {
  if (previousDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = previousDataDir
})

test('staging accepts the prepared cue pair, and rejects the same pair swapped after preparation', async () => {
  const control = await prepareStagingCase(`ok-${process.pid}`, false)
  probes.length = 0
  const result = await stageFinalRenderIntent(control)
  assert.equal(result.kind, 'video-assembly-remote-wait')
  assert.equal(probes.filter(phase => phase === 'after-source-open').length, 4, 'control opens all four sources')
  assert.ok(probes.includes('before-manifest-publish'), 'control must publish its manifest')

  const swapped = await prepareStagingCase(`swap-${process.pid}`, true)
  probes.length = 0
  await assert.rejects(
    stageFinalRenderIntent(swapped),
    /safety check failed/,
    'a cue file swapped after preparation must fail staging',
  )
  assert.equal(probes.filter(phase => phase === 'after-source-open').length, 4,
    'all four sources open before the cue binding check')
  assert.equal(probes.includes('before-manifest-publish'), false,
    'the swapped pair must never publish a manifest')
})

test('packetCueId keeps raw ids distinct inside one recipe', () => {
  const used = new Set<string>()
  assert.equal(packetCueId('a_b', used), 'a_b')
  assert.equal(packetCueId('a-b', used), 'a-b')
  assert.notEqual(packetCueId('a_b', used), packetCueId('a-b', used))
})
