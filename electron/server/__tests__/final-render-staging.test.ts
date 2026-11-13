import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import ts from 'typescript'

import { canonicalRenderValue, renderHash } from '../lib/render-hash-v1.js'
import type { FinalRenderExportDescription } from '../lib/final-render-export.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import type { Job } from '../models/types.js'
import {
  _setFinalRenderStagingHooksForTesting,
  stageFinalRenderIntent,
  type FinalRenderStagingInput,
} from '../services/final-render-staging.js'
import { waitFor } from './_timing.js'
import '../../../scripts/testing/loopback-supertest.mjs'


const BASE_BYTES = Buffer.from('base-video\n')
const AUDIO_BYTES = Buffer.from('premixed-audio\n')
const EXISTING_BYTES = Buffer.from('existing-final\n')
const BASE_SHA = '6c4b95afb685f756a1246a9cc09cd921cff0316ed14d084a669fb300ea9c016f'
const AUDIO_SHA = '01aceef8ed46964df52e9ca0ee4592016f755f6354df750a16f83cc82e8f1697'
const EXISTING_SHA = 'c896853392d75ff2af650dbb8d1b0338b0ee1d9751216105c18759d3ac2e1ab4'
const COMMITTED_AT = '2026-10-15T01:02:03.000Z'
const INTENT_UUID = '44444444-4444-4444-8444-444444444444'
const ATTEMPT_UUID = '55555555-5555-4555-8555-555555555555'
const INTENT_ID = 'render_44444444444444448444444444444444'
const STORY_ID = '33333333-3333-4333-8333-333333333333'
const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const ORIGIN = 'https://private-render.invalid'
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))

const execFileAsync = promisify(execFile)
const previousEnvironment = new Map(
  ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]),
)
let retained: { dir: string; runRoot: string }
let queue: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let externalStore: typeof import('../services/external-video-store.js')
let trashMove: typeof import('../lib/trash-move.js')
const trackedJobIds = new Set<string>()

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function createRetainedFifo(filePath: string): Promise<void> {
  await execFileAsync('/usr/bin/mkfifo', [filePath])
  assert.equal((await fs.lstat(filePath)).isFIFO(), true, 'the retained special-node proof must be a real FIFO')
}

async function releaseBlockedFifoReader(filePath: string): Promise<void> {
  // ENXIO means no reader is attached yet, so a writer cannot be opened. Poll
  // for the attach on a scheduled-time budget: a fixed sleep here would bet on
  // this machine scheduling the poll promptly, which is false under load.
  await waitFor(async () => {
    try {
      const writer = await fs.open(filePath, constants.O_WRONLY | constants.O_NONBLOCK)
      await writer.close()
      return true
    } catch (error: any) {
      if (error?.code !== 'ENXIO') throw error
      return false
    }
  }, { label: `blocked FIFO reader release for ${filePath}`, timeoutMs: 2_000 })
}

async function assertRejectsWithoutBlockingOnFifo(attempt: Promise<unknown>, filePath: string, label: string): Promise<void> {
  let settled = false
  const observed = attempt.then(
    () => ({ kind: 'fulfilled' as const, error: null }),
    error => ({ kind: 'rejected' as const, error }),
  ).finally(() => { settled = true })
  // The attempt has to reject on its own, with no FIFO writer present. Waiting
  // for that on a scheduled-time budget replaces the old fixed 100ms sleep:
  // that sleep asserted the machine would schedule the attempt promptly, so a
  // loaded suite failed a correct product. The budget still bounds the wait.
  const settledBeforeRelease = await waitFor(() => settled, {
    label: `${label} rejection without a FIFO writer`,
    timeoutMs: 2_000,
  }).then(() => true, () => false)
  if (!settledBeforeRelease) await releaseBlockedFifoReader(filePath)
  const result = await within(observed, 2_000, `${label} physical FIFO settlement`)
  assert.equal(result.kind, 'rejected', `${label} must reject the FIFO`)
  assert.equal(settledBeforeRelease, true, `${label} must reject before a FIFO writer exists`)
}

async function settle(): Promise<void> {
  if (!queue) return
  await within((async () => {
    for (let turn = 0; turn < 500; turn++) {
      if ([...trackedJobIds].every(jobId => !queue._isJobWorkerActiveForTesting(jobId))) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok([...trackedJobIds].every(jobId => !queue._isJobWorkerActiveForTesting(jobId)), 'all physical workers must be idle')
    await queue._waitForJobPersistenceForTesting()
  })(), 5_000, 'queue/executor/persistence settlement')
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the retained root is isolated')
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(path.resolve(process.env[key] || ''), path.resolve(harnessRoot), `${key} must stay bound to the retained harness root`)
  }
  const root = await fs.mkdtemp(path.join(harnessRoot, 'final-render-staging-retained-'))
  await fs.chmod(root, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = root
  retained = { dir: root, runRoot: root }
  queue = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  externalStore = await import('../services/external-video-store.js')
  trashMove = await import('../lib/trash-move.js')
})

after(async () => {
  try {
    await settle()
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function profileUtf8(bounds: { max_asset_bytes?: number; max_total_input_bytes?: number } = {}): string {
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
      max_asset_bytes: bounds.max_asset_bytes ?? 64,
      max_total_input_bytes: bounds.max_total_input_bytes ?? 128,
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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function capabilities(bounds: { max_asset_bytes?: number; max_total_input_bytes?: number } = {}): FinalRenderCapabilities {
  const profile = profileUtf8(bounds)
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
    profile_digest: sha256(profile),
    tools: { descriptor_utf8: tools, digest: sha256(tools) },
    compiler: { descriptor_utf8: compiler, digest: sha256(compiler) },
  }
}

function description(basePath: string, audioPath: string, profileDigest: string): FinalRenderExportDescription {
  const recipe = {
    namespace: 'studio.render.final.v1' as const,
    profile_digest: profileDigest,
    base_video: { type: 'asset_ref' as const, logical_id: 'base' },
    premixed_audio: { type: 'asset_ref' as const, logical_id: 'audio' },
    canvas: { width: 128, height: 96, working_fps: 5 },
    target_duration_sec: 2,
    effects_gate: { start_sec: null, end_sec: null },
    operations: [],
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
    ],
    composition: {
      execution_strategy: 'whole_video',
      local_segmentation_offered: false,
      still_tail_from_sec: null,
      recipe_sha256: renderHash('recipe', recipe),
    },
  }
}

function makeJob(slug: string): Job {
  const result: Job = {
    job_id: `stage-${slug}`,
    project_slug: slug,
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Private stage',
    status: 'running',
    created_at: '2026-10-15T00:00:00.000Z',
    started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      bearer: 'secret-must-not-survive',
      arbitrary_project_settings: { private_note: 'full params must not survive' },
    },
  }
  trackedJobIds.add(result.job_id)
  return result
}

type Case = {
  input: FinalRenderStagingInput
  sourceDir: string
  destinationDir: string
  jobsPath: string
}

async function prepareCase(slug: string, options: {
  existingDestination?: boolean
  bounds?: { max_asset_bytes?: number; max_total_input_bytes?: number }
} = {}): Promise<Case> {
  const sourceDir = path.join(retained.runRoot, 'work', slug, 'sources')
  const projectDir = path.join(pm.projectsRoot(), slug)
  const destinationDir = path.join(projectDir, externalStore.CHANNEL_EXPORTS_DIR_NAME, 'Season 001', 'EP1 - Private stage')
  const projectTreeVideoDir = path.join(projectDir, 'episodes', 'EP1', 'video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(destinationDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectTreeVideoDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  assert.equal(pm.getProjectDir(slug), projectDir, 'fixture project must resolve through the registered Library')
  assert.equal(await externalStore.exportsAnchorFor(slug, destinationDir), projectDir,
    'prior-final fixture must use the channel Exports anchor')
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  await fs.writeFile(base, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(audio, AUDIO_BYTES, { mode: 0o600 })
  if (options.existingDestination) {
    await fs.writeFile(path.join(destinationDir, 'EP1_final_video.mp4'), EXISTING_BYTES, { mode: 0o600 })
  }
  const job = makeJob(slug)
  const jobsPath = path.join(projectDir, 'jobs.json')
  await fs.writeFile(jobsPath, JSON.stringify({ jobs: [job] }), { mode: 0o600 })
  queue._forgetProjectPersistenceForTesting(slug)
  const discovered = capabilities(options.bounds)
  return {
    sourceDir,
    destinationDir,
    jobsPath,
    input: {
      job,
      description: description(base, audio, discovered.profile_digest),
      discovery: discovered,
      scope: {
        origin: ORIGIN,
        owner_scope: OWNER_SCOPE,
        gateway_instance_id: GATEWAY_ID,
        story_instance_id: STORY_ID,
      },
      destination: {
        code: 'EP1',
        title: 'Private stage',
        format: 'mp4',
        project_tree_video_dir: projectTreeVideoDir,
      },
      loudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
    },
  }
}

function uuidFor(identity: number, kind: 'intent' | 'attempt'): string {
  const suffix = identity.toString(16).padStart(12, kind === 'intent' ? '4' : '5').slice(-12)
  return kind === 'intent'
    ? `44444444-4444-4444-8444-${suffix}`
    : `55555555-5555-4555-8555-${suffix}`
}

function intentIdFor(identity: number): string {
  return `render_${uuidFor(identity, 'intent').replaceAll('-', '')}`
}

function deterministicHooks(
  destinationDir: string,
  overrides: Parameters<typeof _setFinalRenderStagingHooksForTesting>[0] = {},
  identity = 0,
) {
  const ids = identity === 0
    ? [INTENT_UUID, ATTEMPT_UUID]
    : [uuidFor(identity, 'intent'), uuidFor(identity, 'attempt')]
  return _setFinalRenderStagingHooksForTesting({
    randomUUID: () => ids.shift()!,
    now: () => new Date(COMMITTED_AT),
    resolveExternalFinalVideoDir: async (_slug, _code, _title, _cache, options) => {
      assert.deepEqual(options, { forWrite: true })
      return destinationDir
    },
    ...overrides,
  })
}

function expectedHash(prefix: string, value: unknown): string {
  return sha256(Buffer.concat([Buffer.from(`${prefix}\0`), Buffer.from(canonicalRenderValue(value))]))
}

async function diskJob(caseValue: Case): Promise<any> {
  return JSON.parse(await fs.readFile(caseValue.jobsPath, 'utf8')).jobs[0]
}

test('copies the same opened bytes through short writes, publishes one private manifest, and commits exact readback', async t => {
  const value = await prepareCase(`success-${process.pid}`, { existingDestination: true })
  let shortWrites = 0
  const visibilityPhases: string[] = []
  const restore = deterministicHooks(value.destinationDir, {
    writeChunk: async (handle: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) => {
      shortWrites++
      return handle.write(buffer, offset, Math.min(length, 2), position)
    },
    probe: async event => {
      if (event.phase === 'before-manifest-publish') {
        visibilityPhases.push(event.phase)
        assert.equal(await fs.stat(event.manifest_path!).then(() => true, () => false), false,
          'the final manifest name must be absent before atomic publication')
      }
      if (event.phase === 'after-manifest-publish') {
        visibilityPhases.push(event.phase)
        const bytes = await fs.readFile(event.manifest_path!)
        const parsed = JSON.parse(bytes.toString('utf8'))
        assert.deepEqual(bytes, Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8'),
          'the first observable final-name bytes must already be complete and canonical')
      }
    },
  })
  t.after(restore)
  const result = await stageFinalRenderIntent(value.input)
  assert.deepEqual(result, { kind: 'video-assembly-remote-wait' })
  assert.ok(shortWrites > 2, 'the copier must loop after short writes')

  const intentDir = path.join(retained.dir, 'private-render', 'intents', INTENT_ID)
  const manifestPath = path.join(intentDir, 'manifest.json')
  const manifestBytes = await fs.readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const scratchName = (await fs.readdir(intentDir)).find(name => name.startsWith('manifest.partial-'))
  assert.ok(scratchName, 'the complete fsynced scratch remains retained beside the published manifest')
  const scratchStat = await fs.lstat(path.join(intentDir, scratchName))
  const manifestStat = await fs.lstat(manifestPath)
  assert.equal(scratchStat.dev, manifestStat.dev)
  assert.equal(scratchStat.ino, manifestStat.ino, 'atomic no-overwrite publication links the complete scratch inode')
  assert.equal(scratchStat.nlink, 2)
  assert.equal(manifestStat.nlink, 2)
  assert.deepEqual(visibilityPhases, ['before-manifest-publish', 'after-manifest-publish'])
  const baseCopy = path.join(intentDir, 'base.mp4')
  const audioCopy = path.join(intentDir, 'audio.wav')
  assert.deepEqual(await fs.readFile(baseCopy), BASE_BYTES)
  assert.deepEqual(await fs.readFile(audioCopy), AUDIO_BYTES)
  for (const directory of [
    path.join(retained.dir, 'private-render'),
    path.join(retained.dir, 'private-render', 'intents'),
    intentDir,
  ]) assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
  for (const file of [manifestPath, baseCopy, audioCopy]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600)

  assert.deepEqual(Object.keys(manifest), [
    'format', 'job_id', 'project_slug', 'episode_id', 'intent_id', 'story_instance_id',
    'story_attempt', 'gateway_attempt_key', 'committed_at', 'scope', 'packet', 'sources',
    'composition', 'destination', 'descriptors', 'loudness',
  ])
  assert.deepEqual(manifest.loudness, { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' })
  assert.equal(manifest.format, 'studio.render.story-intent.v1')
  assert.equal(manifest.intent_id, INTENT_ID)
  assert.equal(manifest.gateway_attempt_key, ATTEMPT_UUID)
  assert.equal(manifest.committed_at, COMMITTED_AT)
  assert.deepEqual(manifest.scope, {
    origin: ORIGIN,
    owner_scope: OWNER_SCOPE,
    gateway_instance_id: GATEWAY_ID,
    story_instance_id: STORY_ID,
  })
  assert.deepEqual(manifest.sources.map((source: any) => ({
    logical_id: source.logical_id,
    role: source.role,
    safe_name: source.safe_name,
    size_bytes: source.size_bytes,
    sha256: source.sha256,
  })), [
    { logical_id: 'base', role: 'base_video', safe_name: 'base.mp4', size_bytes: 11, sha256: BASE_SHA },
    { logical_id: 'audio', role: 'premixed_audio', safe_name: 'audio.wav', size_bytes: 15, sha256: AUDIO_SHA },
  ])
  assert.deepEqual(manifest.destination.state, { kind: 'file', size_bytes: 15, sha256: EXISTING_SHA })
  const registeredProject = pm.getProjectDir(value.input.job.project_slug)!
  const exportsAnchor = await externalStore.exportsAnchorFor(value.input.job.project_slug, value.destinationDir)
  assert.equal(exportsAnchor, registeredProject)
  assert.equal(manifest.destination.recovery_root,
    trashMove.trashRootFor(exportsAnchor, registeredProject, value.input.job.project_slug))
  assert.deepEqual(Object.keys(manifest.destination), ['pathname', 'route', 'state', 'recovery_root'])
  assert.equal(manifest.destination.pathname, path.join(await fs.realpath(value.destinationDir), 'EP1_final_video.mp4'))
  assert.equal(manifest.composition.execution_strategy, 'whole_video')
  assert.equal(manifest.packet.manifest.find((item: any) => item.logical_id === 'base').sha256, BASE_SHA)
  assert.equal(manifest.packet.manifest.find((item: any) => item.logical_id === 'audio').sha256, AUDIO_SHA)

  const persisted = await diskJob(value)
  assert.deepEqual(persisted.final_render_remote_wait, {
    version: 2,
    phase: 'intent_staged',
    revision: 1,
    job_id: value.input.job.job_id,
    intent_id: INTENT_ID,
    story_instance_id: STORY_ID,
    story_attempt: 1,
    gateway_attempt_key: ATTEMPT_UUID,
    packet_sha256: manifest.packet.packet_digest,
    staging_manifest_sha256: sha256(manifestBytes),
    submission_scope_sha256: expectedHash('studio.render.story.scope.v1', manifest.scope),
    destination_fence_sha256: expectedHash('studio.render.story.destination.v1', manifest.destination),
    source_generation_fence_sha256: expectedHash('studio.render.story.sources.v1', {
      sources: manifest.sources,
      composition: manifest.composition,
    }),
    committed_at: COMMITTED_AT,
    cancel_requested_at: null,
  })
  const privateText = manifestBytes.toString('utf8')
  assert.equal(privateText.includes('secret-must-not-survive'), false)
  assert.equal(privateText.includes('full params must not survive'), false)
  assert.equal(JSON.stringify(persisted.final_render_remote_wait).includes(value.sourceDir), false)
  assert.equal(JSON.stringify(persisted.final_render_remote_wait).includes(ORIGIN), false)
  assert.ok(intentDir.startsWith(path.join(retained.dir, 'private-render', 'intents')))
  assert.equal(intentDir.startsWith(path.join(retained.dir, 'projects')), false)
})

test('captures confirmed destination absence and uses the project tree only after a positive null resolver result', async t => {
  const value = await prepareCase(`absent-${process.pid}`)
  const identity = 1
  const restore = deterministicHooks(value.destinationDir, {
    resolveExternalFinalVideoDir: async (_slug, _code, _title, _cache, options) => {
      assert.deepEqual(options, { forWrite: true })
      return null
    },
  }, identity)
  t.after(restore)
  await stageFinalRenderIntent(value.input)
  const manifest = JSON.parse(await fs.readFile(path.join(retained.dir, 'private-render', 'intents', intentIdFor(identity), 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.destination.state, { kind: 'absent' })
  assert.equal(manifest.destination.recovery_root, null)
  assert.deepEqual(manifest.loudness, { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' })
  assert.equal(manifest.destination.pathname, path.join(await fs.realpath(value.input.destination.project_tree_video_dir), 'EP1_final_video.mp4'))
})

test('refuses replacement, mutation, links, special entries, descriptor bounds, and an exclusive intent collision without commitment', async t => {
  const cases: Array<{
    name: string
    prepare: (value: Case) => Promise<void>
    bounds?: { max_asset_bytes?: number; max_total_input_bytes?: number }
    hooks?: (value: Case) => Parameters<typeof _setFinalRenderStagingHooksForTesting>[0]
    error: RegExp
  }> = [
    {
      name: 'source replacement',
      prepare: async () => {},
      hooks: value => ({ probe: async event => {
        if (event.phase === 'after-source-open' && event.logical_id === 'base') {
          const old = path.join(value.sourceDir, 'base.mp4')
          await fs.rename(old, `${old}.replaced`)
          await fs.writeFile(old, 'replacement-source\n', { mode: 0o600 })
        }
      } }),
      error: /source.*changed|identity|entry/i,
    },
    {
      name: 'source mutation',
      prepare: async () => {},
      hooks: () => ({ probe: async event => {
        if (event.phase === 'after-source-open' && event.logical_id === 'base') await fs.appendFile(event.source_path!, 'mutation')
      } }),
      error: /source.*changed|size|time/i,
    },
    {
      name: 'symbolic link',
      prepare: async value => {
        const source = value.input.description.source_requirements[0]!.source_path
        await fs.rename(source, `${source}.real`)
        await fs.symlink(`${source}.real`, source)
      },
      error: /symbolic|no.?follow|regular/i,
    },
    {
      name: 'nonregular directory',
      prepare: async value => {
        const source = value.input.description.source_requirements[0]!.source_path
        await fs.rename(source, `${source}.real`)
        await fs.mkdir(source, { mode: 0o700 })
      },
      error: /regular|file/i,
    },
    {
      name: 'asset byte bound',
      prepare: async value => {
        const source = value.input.description.source_requirements[0]!.source_path
        await fs.writeFile(source, Buffer.alloc(65, 1))
      },
      bounds: { max_asset_bytes: 64 },
      error: /asset.*(bound|large|bytes)|size/i,
    },
    {
      name: 'total input byte bound',
      prepare: async () => {},
      bounds: { max_total_input_bytes: 25 },
      error: /total.*(bound|large|bytes)|size/i,
    },
    {
      name: 'exclusive intent collision',
      prepare: async () => {
        const collision = path.join(retained.dir, 'private-render', 'intents', intentIdFor(16))
        await fs.mkdir(collision, { recursive: true, mode: 0o700 })
        await fs.writeFile(path.join(collision, 'owner-sentinel'), 'keep', { mode: 0o600 })
      },
      error: /exist|collision|exclusive/i,
    },
  ]

  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]!
    const value = await prepareCase(`refuse-${index}-${process.pid}`, { bounds: item.bounds })
    await item.prepare(value)
    const restore = deterministicHooks(value.destinationDir, item.hooks?.(value), index + 10)
    t.after(restore)
    await assert.rejects(stageFinalRenderIntent(value.input), item.error, item.name)
    assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false, item.name)
  }
})

test('real source and destination FIFOs reject without waiting for a writer and settle their retained special nodes', async t => {
  for (const [index, kind] of ['source', 'destination'].entries()) {
    const value = await prepareCase(`fifo-${kind}-${process.pid}`)
    const identity = 50 + index
    const fifo = kind === 'source'
      ? value.input.description.source_requirements[0]!.source_path
      : path.join(value.destinationDir, 'EP1_final_video.mp4')
    if (kind === 'source') await fs.rename(fifo, `${fifo}.regular-retained`)
    await createRetainedFifo(fifo)
    const restore = deterministicHooks(value.destinationDir, {}, identity)
    t.after(restore)

    await assertRejectsWithoutBlockingOnFifo(stageFinalRenderIntent(value.input), fifo, `${kind} FIFO`)
    assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false)
    assert.equal((await fs.lstat(fifo)).isFIFO(), true)
  }
})

test('destination resolution errors and every pre/post-publication or readback ambiguity retain evidence and never commit', async t => {
  const scenarios: Array<{
    name: string
    hooks: (value: Case) => Parameters<typeof _setFinalRenderStagingHooksForTesting>[0]
    expectManifest: boolean
  }> = [
    {
      name: 'destination resolution',
      hooks: () => ({ resolveExternalFinalVideoDir: async () => { throw new Error('controlled destination failure') } }),
      expectManifest: false,
    },
    {
      name: 'before manifest publication',
      hooks: () => ({ probe: async event => {
        if (event.phase === 'before-manifest-publish') throw new Error('controlled prepublish failure')
      } }),
      expectManifest: false,
    },
    {
      name: 'after manifest publication',
      hooks: () => ({ probe: async event => {
        if (event.phase === 'after-manifest-publish') throw new Error('controlled postpublish ambiguity')
      } }),
      expectManifest: true,
    },
    {
      name: 'corrupt copied input before readback',
      hooks: () => ({ probe: async event => {
        if (event.phase === 'before-private-readback') await fs.appendFile(event.intent_dir + '/base.mp4', 'corrupt')
      } }),
      expectManifest: true,
    },
    {
      name: 'missing copied input before readback',
      hooks: () => ({ probe: async event => {
        if (event.phase === 'before-private-readback') await fs.rename(event.intent_dir + '/audio.wav', event.intent_dir + '/audio.missing')
      } }),
      expectManifest: true,
    },
    {
      name: 'corrupt manifest before readback',
      hooks: () => ({ probe: async event => {
        if (event.phase === 'before-private-readback') await fs.appendFile(event.manifest_path!, 'corrupt')
      } }),
      expectManifest: true,
    },
  ]

  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index]!
    const value = await prepareCase(`ambiguity-${index}-${process.pid}`)
    const identity = index + 30
    const restore = deterministicHooks(value.destinationDir, scenario.hooks(value), identity)
    t.after(restore)
    await assert.rejects(stageFinalRenderIntent(value.input), /destination|publish|readback|copy|manifest|hash|controlled|missing|corrupt/i, scenario.name)
    assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false, scenario.name)
    const intentDir = path.join(retained.dir, 'private-render', 'intents', intentIdFor(identity))
    const entries: string[] = await fs.readdir(intentDir).catch(() => [] as string[])
    assert.equal(entries.includes('manifest.json'), scenario.expectManifest, scenario.name)
    assert.ok(entries.length > 0 || scenario.name === 'destination resolution', `${scenario.name} retains partial evidence when created`)
  }
})

test('failure at the atomic publication boundary retains a complete scratch and never exposes a partial final name', async t => {
  const value = await prepareCase(`atomic-publish-${process.pid}`)
  const identity = 60
  let reachedAtomicBoundary = false
  const restore = deterministicHooks(value.destinationDir, {
    probe: async event => {
      if (String(event.phase) !== 'before-manifest-link') return
      reachedAtomicBoundary = true
      assert.equal(await fs.stat(event.manifest_path!).then(() => true, () => false), false)
      throw new Error('controlled atomic publication failure')
    },
  }, identity)
  t.after(restore)

  await assert.rejects(stageFinalRenderIntent(value.input), /safety check failed/i)
  assert.equal(reachedAtomicBoundary, true)
  assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false)
  const intentDir = path.join(retained.dir, 'private-render', 'intents', intentIdFor(identity))
  assert.equal(await fs.stat(path.join(intentDir, 'manifest.json')).then(() => true, () => false), false)
  const scratchName = (await fs.readdir(intentDir)).find(name => name.startsWith('manifest.partial-'))
  assert.ok(scratchName)
  const scratchBytes = await fs.readFile(path.join(intentDir, scratchName))
  const parsed = JSON.parse(scratchBytes.toString('utf8'))
  assert.deepEqual(scratchBytes, Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8'))
})

test('parent-directory sync failure retains the private snapshot and prevents canonical commitment', async t => {
  const value = await prepareCase(`parent-sync-${process.pid}`)
  const identity = 70
  const privateRoot = path.join(retained.dir, 'private-render')
  const intentsRoot = path.join(privateRoot, 'intents')
  const intentDir = path.join(intentsRoot, intentIdFor(identity))
  const synced: string[] = []
  const restore = deterministicHooks(value.destinationDir, {
    fsyncDirectory: async (directory: string) => {
      synced.push(directory)
      if (directory === intentsRoot) throw new Error('controlled parent directory sync failure')
      const handle = await fs.open(directory, 'r')
      try { await handle.sync() } finally { await handle.close() }
    },
  }, identity)
  t.after(restore)

  await assert.rejects(stageFinalRenderIntent(value.input), /safety check failed/i)
  assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false)
  assert.deepEqual(synced, [intentDir, retained.dir, privateRoot, intentsRoot])
  assert.deepEqual(await fs.readFile(path.join(intentDir, 'base.mp4')), BASE_BYTES)
  assert.deepEqual(await fs.readFile(path.join(intentDir, 'audio.wav')), AUDIO_BYTES)
  assert.ok((await fs.stat(path.join(intentDir, 'manifest.json'))).isFile())
})

test('aggregate budget limits each copy to the remaining bytes and never commits an over-budget snapshot', async t => {
  const value = await prepareCase(`aggregate-budget-${process.pid}`, {
    bounds: { max_asset_bytes: 64, max_total_input_bytes: 25 },
  })
  const identity = 71
  const restore = deterministicHooks(value.destinationDir, {}, identity)
  t.after(restore)

  await assert.rejects(stageFinalRenderIntent(value.input), /safety check failed/i)
  assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false)
  const intentDir = path.join(retained.dir, 'private-render', 'intents', intentIdFor(identity))
  const stagedBytes = await Promise.all(['base.mp4', 'audio.wav'].map(async name => (
    (await fs.stat(path.join(intentDir, name)).catch(() => null))?.size ?? 0
  )))
  assert.ok(stagedBytes.reduce((sum, size) => sum + size, 0) <= 25, `staged ${stagedBytes.join('+')} bytes`)
  assert.equal(await fs.stat(path.join(intentDir, 'manifest.json')).then(() => true, () => false), false)
})

test('stager reopens its exact pending or committed v2 lineage before consulting live paths or minting IDs', async t => {
  const value = await prepareCase(`adopt-own-lineage-${process.pid}`)
  const identity = 80
  const intentsRoot = path.join(retained.dir, 'private-render', 'intents')
  const before = new Set(await fs.readdir(intentsRoot).catch(() => []))
  const restoreInitialHooks = deterministicHooks(value.destinationDir, {}, identity)
  t.after(restoreInitialHooks)
  let failCanonicalWrite = true
  const restorePersist = queue._setJobFileLockProbeForTesting(operation => {
    if (operation === 'persist' && failCanonicalWrite) {
      failCanonicalWrite = false
      throw new Error('controlled canonical commitment failure')
    }
  })
  t.after(restorePersist)
  await assert.rejects(stageFinalRenderIntent(value.input), /safety check failed/i)
  restorePersist()
  restoreInitialHooks()
  assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false)

  const afterFailure = (await fs.readdir(intentsRoot)).filter(name => !before.has(name))
  assert.deepEqual(afterFailure, [intentIdFor(identity)])
  const manifestPath = path.join(intentsRoot, intentIdFor(identity), 'manifest.json')
  const originalManifestBytes = await fs.readFile(manifestPath)
  const originalManifest = JSON.parse(originalManifestBytes.toString('utf8'))
  await fs.writeFile(value.input.description.source_requirements[0]!.source_path, 'changed-live-source\n')
  await fs.writeFile(path.join(value.destinationDir, 'EP1_final_video.mp4'), 'changed-live-destination\n')

  const restoreRetryHooks = _setFinalRenderStagingHooksForTesting({
    randomUUID: () => { throw new Error('retry minted a new identity') },
    resolveExternalFinalVideoDir: async () => { throw new Error('retry consulted the live destination') },
    probe: async () => { throw new Error('retry recopied a live source') },
  })
  t.after(restoreRetryHooks)
  assert.deepEqual(await stageFinalRenderIntent(value.input), { kind: 'video-assembly-remote-wait' })
  let persisted = await diskJob(value)
  assert.equal(persisted.final_render_remote_wait.intent_id, originalManifest.intent_id)
  assert.equal(persisted.final_render_remote_wait.gateway_attempt_key, originalManifest.gateway_attempt_key)
  assert.equal(persisted.final_render_remote_wait.committed_at, originalManifest.committed_at)
  assert.equal(persisted.final_render_remote_wait.staging_manifest_sha256, sha256(originalManifestBytes))
  assert.deepEqual((await fs.readdir(intentsRoot)).filter(name => !before.has(name)), afterFailure)

  assert.deepEqual(await stageFinalRenderIntent(value.input), { kind: 'video-assembly-remote-wait' },
    'an already committed exact lineage reopens without a new snapshot')
  persisted = await diskJob(value)
  assert.equal(persisted.final_render_remote_wait.intent_id, originalManifest.intent_id)
  assert.deepEqual((await fs.readdir(intentsRoot)).filter(name => !before.has(name)), afterFailure)
})

test('a pre-canonical crash leaves an inert orphan and a later call creates a fresh lineage', async t => {
  const value = await prepareCase(`orphan-is-not-authority-${process.pid}`)
  const orphanIdentity = 81
  const freshIdentity = 82
  const restoreOrphan = deterministicHooks(value.destinationDir, {
    probe: event => {
      if (event.phase === 'after-manifest-publish') throw new Error('controlled crash before canonical fact')
    },
  }, orphanIdentity)
  t.after(restoreOrphan)
  await assert.rejects(stageFinalRenderIntent(value.input), /safety check failed/i)
  restoreOrphan()
  assert.equal(Object.hasOwn(await diskJob(value), 'final_render_remote_wait'), false)

  const restoreFresh = deterministicHooks(value.destinationDir, {}, freshIdentity)
  t.after(restoreFresh)
  assert.deepEqual(await stageFinalRenderIntent(value.input), { kind: 'video-assembly-remote-wait' })
  const persisted = await diskJob(value)
  assert.equal(persisted.final_render_remote_wait.intent_id, intentIdFor(freshIdentity))
  const intentsRoot = path.join(retained.dir, 'private-render', 'intents')
  assert.ok((await fs.readdir(intentsRoot)).includes(intentIdFor(orphanIdentity)), 'the orphan remains retained as unknown evidence')
  assert.ok((await fs.readdir(intentsRoot)).includes(intentIdFor(freshIdentity)))
})

test('staging service has no direct Gateway, HTTP, child-process, or generator runtime import and invokes no process API', async () => {
  const modulePath = path.resolve(TEST_DIR, '../services/final-render-staging.ts')
  const text = await fs.readFile(modulePath, 'utf8')
  const source = ts.createSourceFile(modulePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const runtimeImports = source.statements.flatMap(statement => (
    ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
      ? [(statement.moduleSpecifier as ts.StringLiteral).text]
      : []
  ))
  for (const forbidden of [
    'final-render-gateway-client', 'node:http', 'node:https', 'node:net', 'node:tls',
    'node:child_process', 'generators/video',
  ]) assert.equal(runtimeImports.some(specifier => specifier.includes(forbidden)), false,
    `staging must not have a runtime dependency on ${forbidden}`)
  for (const forbiddenCall of ['fetch(', 'spawn(', 'exec(']) {
    assert.equal(text.includes(forbiddenCall), false, `staging must not call ${forbiddenCall}`)
  }
})
