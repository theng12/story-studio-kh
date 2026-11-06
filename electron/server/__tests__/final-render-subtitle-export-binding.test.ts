/**
 * Subtitle export binding — the capability gate, the preparation-failure
 * reasons, the minted `studio.render.subtitle.v1` stage shape (bare `ass`
 * asset_ref, ordered generated font ids, manifest-equal font hashes), and
 * staging of the ASS/font files through the same copy path every other staged
 * asset takes — including the extension-per-role rule and a post-prepare
 * swap of the font bytes.
 *
 * Focused; intentionally NOT run by the authoring worker (the 383 runtime
 * slot is reserved elsewhere — the lead releases suites).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import type { CompositionOpts } from '../generators/video.js'
import { compileFinalRenderPacket } from '../lib/final-render-compiler.js'
import {
  describeFinalRenderExport,
  finalizeFinalRenderPacket,
  type FinalRenderExportDescription,
  type FinalRenderVerifiedAsset,
} from '../lib/final-render-export.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import type { PreparedSubtitleAssets, SubtitlePreparation } from '../lib/final-render-subtitle-assets.js'
import {
  _setFinalRenderStagingHooksForTesting,
  stageFinalRenderIntent,
  type FinalRenderStagingInput,
} from '../services/final-render-staging.js'
import type { Job } from '../models/types.js'
import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'
import '../../../scripts/testing/loopback-supertest.mjs'

installTestSafeStorage()

const HASH_1 = '1'.repeat(64)
const HASH_2 = '2'.repeat(64)
const ASS_SHA = '5'.repeat(64)
const FONT_SHA = '6'.repeat(64)
const BASE_BYTES = Buffer.from('base-video\n')
const AUDIO_BYTES = Buffer.from('premixed-audio\n')
const ASS_BYTES = Buffer.from('[Script Info]\nTitle: fixture\n')
const FONT_BYTES = Buffer.alloc(48, 0x46)

const previousDataDir = process.env.STORY_STUDIO_DATA_DIR
let dataRoot: string
let projectsRoot: string
let activeDestination: string
const probes: string[] = []

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function discovery(withSubtitles = true): FinalRenderCapabilities {
  const base: FinalRenderCapabilities = {
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
  if (withSubtitles) base.subtitles = { format: 'studio.render.subtitle.v1' }
  return base
}

function job(jobId: string): Job {
  return {
    job_id: jobId,
    project_slug: 'subtitle-binding',
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Subtitle binding',
    status: 'running',
    created_at: '2026-11-05T00:00:00.000Z',
    started_at: '2026-11-05T00:00:00.000Z',
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
    subtitles: {
      enabled: true,
      source: 'upload',
      srt_path: '/schema/captions.srt',
      // The describe seam never reads the style; normalizeSubtitleStyle is the
      // validating boundary when a payload is actually prepared.
      style: {} as NonNullable<CompositionOpts['subtitles']>['style'],
    },
    job: job('subtitle-export-test'),
    ...overrides,
  }
}

function prepared(): PreparedSubtitleAssets {
  return {
    ass: { path: '/scratch/subtitles-burn.ass', sha256: ASS_SHA, size_bytes: ASS_BYTES.length },
    fonts: [{
      id: 'subtitle_font_0000',
      family: 'Inter',
      path: '/scratch/Inter.ttf',
      sha256: FONT_SHA,
      size_bytes: FONT_BYTES.length,
    }],
  }
}

function exportable(value: ReturnType<typeof describeFinalRenderExport>) {
  if (value.kind !== 'exportable') assert.fail(`expected exportable description, got ${value.reason}`)
  return value
}

function subtitleOperation(description: FinalRenderExportDescription): Record<string, any> {
  const op = (description.recipe.operations as Record<string, any>[])
    .find(item => item.kind === 'subtitle_stage')
  assert.ok(op, 'the description must mint a subtitle_stage operation')
  return op
}

test('the capability gate refuses a subtitle composition before any payload reason', () => {
  const result = describeFinalRenderExport(opts(), discovery(false), undefined, { ok: true, prepared: prepared() })
  assert.deepEqual(result, { kind: 'local-only', reason: 'subtitles_capability_unavailable' })
  // Without the payload the gate still names the missing capability first.
  assert.deepEqual(
    describeFinalRenderExport(opts(), discovery(false)),
    { kind: 'local-only', reason: 'subtitles_capability_unavailable' },
  )
})

test('a failed preparation returns its own exact reason, never the umbrella', () => {
  const cases: Array<Extract<SubtitlePreparation, { ok: false }>> = [
    { ok: false, reason: 'subtitles_ass_unavailable', detail: 'the caption file has no cues' },
    { ok: false, reason: 'subtitles_payload_unsupported', detail: 'ASS PlayRes is 0x0 but the canvas is 128x96' },
    { ok: false, reason: 'subtitles_font_unresolved', detail: 'Helvetica' },
    { ok: false, reason: 'subtitles_font_integrity', detail: 'Inter' },
  ]
  for (const preparation of cases) {
    assert.deepEqual(
      describeFinalRenderExport(opts(), discovery(), undefined, preparation),
      { kind: 'local-only', reason: preparation.reason },
      preparation.detail,
    )
  }
  // Malformed prepared payloads keep the contract's defensive reasons.
  assert.deepEqual(
    describeFinalRenderExport(opts(), discovery(), undefined, { ok: true, prepared: { ...prepared(), fonts: [] } }),
    { kind: 'local-only', reason: 'subtitles_font_unresolved' },
  )
  assert.deepEqual(
    describeFinalRenderExport(opts(), discovery(), undefined, {
      ok: true,
      prepared: { ...prepared(), fonts: [{ ...prepared().fonts[0]!, family: 'Inter/evil' }] },
    }),
    { kind: 'local-only', reason: 'subtitles_font_unresolved' },
  )
  assert.deepEqual(
    describeFinalRenderExport(opts(), discovery(), undefined, {
      ok: true,
      prepared: { ...prepared(), fonts: [{ ...prepared().fonts[0]!, sha256: 'not-a-hash' }] },
    }),
    { kind: 'local-only', reason: 'subtitles_font_integrity' },
  )
  assert.deepEqual(
    describeFinalRenderExport(opts(), discovery(), undefined, {
      ok: true,
      prepared: { ...prepared(), ass: { ...prepared().ass, sha256: 'not-a-hash' } },
    }),
    { kind: 'local-only', reason: 'subtitles_ass_unavailable' },
  )
})

test('the minted stage carries a bare ass ref, ordered font records, and matching facts', () => {
  const description = exportable(describeFinalRenderExport(opts(), discovery(), undefined, { ok: true, prepared: prepared() }))
  const op = subtitleOperation(description)
  assert.equal(op.contract, 'studio.render.subtitle.v1')
  assert.deepEqual(op.ass, { type: 'asset_ref', logical_id: 'subtitle_ass' })
  assert.deepEqual(op.fonts, [{
    asset: { type: 'asset_ref', logical_id: 'subtitle_font_0000' },
    family: 'Inter',
    sha256: FONT_SHA,
  }])
  const requirements = description.source_requirements.filter(item =>
    item.role === 'subtitle_ass' || item.role === 'subtitle_font')
  assert.deepEqual(requirements.map(item => [item.logical_id, item.role, path.basename(item.source_path)]).sort(), [
    ['subtitle_ass', 'subtitle_ass', 'subtitles-burn.ass'],
    ['subtitle_font_0000', 'subtitle_font', 'Inter.ttf'],
  ])

  // Facts: subtitle roles hash to the prepared values; everything else to its id.
  const verified: FinalRenderVerifiedAsset[] = description.source_requirements.map(requirement => ({
    logical_id: requirement.logical_id,
    role: requirement.role,
    safe_name: `${requirement.logical_id}${path.extname(requirement.source_path)}`,
    size_bytes: requirement.logical_id === 'subtitle_ass' ? ASS_BYTES.length
      : requirement.logical_id === 'subtitle_font_0000' ? FONT_BYTES.length : 10,
    sha256: requirement.logical_id === 'subtitle_ass' ? ASS_SHA
      : requirement.logical_id === 'subtitle_font_0000' ? FONT_SHA : hash(requirement.logical_id),
    input_mode: { kind: 'single' as const },
  }))
  // The frozen recipe validator is the contract: font-record hashes must equal
  // the manifest's, and .ass/.ttf safe names must be admissible.
  const finalized = finalizeFinalRenderPacket(description, verified)
  const finalizedOp = (finalized.packet.recipe as Record<string, any>).operations
    .find((item: Record<string, any>) => item.kind === 'subtitle_stage')
  assert.deepEqual(finalizedOp.ass, { type: 'asset_ref', logical_id: 'subtitle_ass' })
  assert.equal(finalizedOp.fonts[0].sha256, FONT_SHA)
})

test('the compiler passes subtitle output to the final map and to a following logo', () => {
  for (const withLogo of [false, true]) {
    const description = exportable(describeFinalRenderExport(opts(withLogo ? {
      logo: {
        enabled: true, image_path: '/schema/assets/logo.png', position: 'top-left',
        opacity: 1, scale: 0.1, margin: 4, hide_during_intro: false,
      },
    } : {}), discovery(), undefined, prepared()))
    const verified: FinalRenderVerifiedAsset[] = description.source_requirements.map(item => ({
      logical_id: item.logical_id, role: item.role,
      safe_name: `${item.logical_id}${path.extname(item.source_path)}`,
      size_bytes: 10,
      sha256: item.role === 'subtitle_font' ? FONT_SHA : hash(item.logical_id),
      input_mode: { kind: 'single' as const },
    }))
    const { packet } = finalizeFinalRenderPacket(description, verified)
    const assets = new Map(verified.map(item => [item.logical_id, `/schema/staged/${item.safe_name}`]))
    const compiled = compileFinalRenderPacket(packet, assets, '/schema/output/final.mp4')
    const argv = compiled.tiers[0]!.build()
    const graph = argv[argv.indexOf('-filter_complex') + 1]!
    const subtitleFilter = graph.split(';').find(line => line.includes('ass=filename='))?.trim()
    assert.ok(subtitleFilter, 'subtitle filter must be in the full graph')
    const output = /(\[v\d+\])$/.exec(subtitleFilter)?.[1]
    assert.ok(output, 'subtitle filter must expose a named output')
    assert.ok(graph.includes(withLogo ? `${output}[logo]overlay` : `${output}null[vout]`),
      'the following stage must consume the subtitled stream')
  }
})

// ---- staging seam (mirrors late-label-export-binding.test.ts fixtures) ----

const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const STORY_ID = '33333333-3333-4333-8333-333333333333'
const ORIGIN = 'https://private-render.invalid'

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
    subtitles: { format: 'studio.render.subtitle.v1' },
  }
}

async function prepareStagingCase(
  slug: string,
  mode: 'control' | 'wrong-extension' | 'swapped-font',
): Promise<FinalRenderStagingInput> {
  const projectDir = path.join(projectsRoot, slug)
  const sourceDir = path.join(dataRoot, 'work', slug, 'sources')
  const projectTreeVideoDir = path.join(projectDir, 'episodes', 'EP1', 'video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(activeDestination, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectTreeVideoDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  const assPath = path.join(sourceDir, 'subtitles-burn.ass')
  const fontPath = path.join(sourceDir, mode === 'wrong-extension' ? 'Inter.png' : 'Inter.ttf')
  await fs.writeFile(base, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(audio, AUDIO_BYTES, { mode: 0o600 })
  await fs.writeFile(assPath, ASS_BYTES, { mode: 0o600 })
  // Facts are taken from the prepared bytes BEFORE any post-prepare mutation.
  await fs.writeFile(fontPath, FONT_BYTES, { mode: 0o600 })
  if (mode === 'swapped-font') {
    await fs.writeFile(fontPath, Buffer.alloc(48, 0x47), { mode: 0o600 })
  }
  const stagingJob: Job = {
    job_id: `subtitle-${slug}`,
    project_slug: slug,
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Subtitle binding',
    status: 'running',
    created_at: '2026-11-05T00:00:00.000Z',
    started_at: '2026-11-05T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
  }
  await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [stagingJob] }), { mode: 0o600 })
  const queue = await import('../services/job-queue.js')
  queue._forgetProjectPersistenceForTesting(slug)
  const discovered = stagingCapabilities()
  const preparedPayload: PreparedSubtitleAssets = {
    ass: {
      path: assPath,
      sha256: createHash('sha256').update(ASS_BYTES).digest('hex'),
      size_bytes: ASS_BYTES.length,
    },
    fonts: [{
      id: 'subtitle_font_0000',
      family: 'Inter',
      path: fontPath,
      // The prepared fact is the ORIGINAL bytes' hash in every mode; the swap
      // mutates the file afterwards, so staging must refuse the disagreement.
      sha256: createHash('sha256').update(FONT_BYTES).digest('hex'),
      size_bytes: FONT_BYTES.length,
    }],
  }
  const description = describeFinalRenderExport(opts({ videoInputPath: base, premixedAudioPath: audio }), discovered, undefined, { ok: true, prepared: preparedPayload })
  return {
    job: stagingJob,
    description: exportable(description),
    discovery: discovered,
    scope: {
      origin: ORIGIN,
      owner_scope: OWNER_SCOPE,
      gateway_instance_id: GATEWAY_ID,
      story_instance_id: STORY_ID,
    },
    destination: {
      code: 'EP1',
      title: 'Subtitle binding',
      format: 'mp4',
      project_tree_video_dir: projectTreeVideoDir,
    },
    loudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
  }
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT ?? os.tmpdir()
  dataRoot = await fs.mkdtemp(path.join(harnessRoot, 'subtitle-binding-data-'))
  await fs.chmod(dataRoot, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = dataRoot
  setTestSafeStorageAvailable(true)
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
  setTestSafeStorageAvailable(true)
  if (previousDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = previousDataDir
})

test('staging copies the ASS and font through the ordinary source path', async () => {
  const control = await prepareStagingCase(`ok-${process.pid}`, 'control')
  probes.length = 0
  const result = await stageFinalRenderIntent(control)
  assert.equal(result.kind, 'video-assembly-remote-wait')
  assert.equal(probes.filter(phase => phase === 'after-source-open').length, 4, 'control opens all four sources')
  assert.ok(probes.includes('before-manifest-publish'), 'control must publish its manifest')
})

test('staging refuses a font whose extension does not match its role', async () => {
  const wrong = await prepareStagingCase(`ext-${process.pid}`, 'wrong-extension')
  probes.length = 0
  await assert.rejects(
    stageFinalRenderIntent(wrong),
    /safety check failed/,
    'a subtitle_font source with a .png extension must fail staging',
  )
  assert.equal(probes.filter(phase => phase === 'after-source-open').length, 2,
    'base and audio must open before the font extension is refused')
  assert.equal(probes.includes('before-manifest-publish'), false,
    'the wrong-extension case must never publish a manifest')
})

test('staging refuses font bytes swapped after preparation', async () => {
  const swapped = await prepareStagingCase(`swap-${process.pid}`, 'swapped-font')
  probes.length = 0
  await assert.rejects(
    stageFinalRenderIntent(swapped),
    /safety check failed|Invalid render packet|review/i,
    'font bytes that disagree with the prepared hash must fail staging',
  )
  assert.equal(probes.filter(phase => phase === 'after-source-open').length, 4,
    'all sources must open before the prepared font hash is refused')
  assert.equal(probes.includes('before-manifest-publish'), false,
    'the swapped case must never publish a manifest')
})
