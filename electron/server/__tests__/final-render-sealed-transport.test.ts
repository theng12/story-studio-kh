import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import '../../../scripts/testing/loopback-supertest.mjs'
import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import { parseFinalRenderRemoteWaitReceipt } from '../lib/final-render-remote-wait.js'
import type { Job } from '../models/types.js'

const ORIGIN = 'https://gateway.private.example'
const OTHER_ORIGIN = 'https://changed-gateway.private.example'
const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const GATEWAY_JOB_ID = '55555555-5555-4555-8555-555555555555'
const BEARER = 'ab'.repeat(32)
const ROTATED_BEARER = 'cd'.repeat(32)
let gatewayKey = BEARER
const SMALL_BASE = Buffer.from('retained sealed private video bytes\n')
const SMALL_AUDIO = Buffer.from('retained sealed private audio bytes\n')
const MAX_CHUNK = 8 * 1024 * 1024
const originalFetch = globalThis.fetch
const previousEnvironment = new Map(
  ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]),
)

type QueueModule = typeof import('../services/job-queue.js')
type TransportModule = typeof import('../services/final-render-transport.js')
type GatewayClientModule = typeof import('../lib/final-render-gateway-client.js')
type EvidenceModule = typeof import('../lib/final-render-transport-evidence.js')
type SettingsModule = typeof import('../services/app-settings.js')
type IdentityModule = typeof import('../services/private-render-identity.js')
type SafeStorageModule = typeof import('./safe-storage-test-double.js')
type WireCall = {
  method: string
  url: string
  body: Buffer
  headers: Headers
}
type BlobState = { sha256: string; size_bytes: number; offset: number }
type Advance = (projectSlug: string, jobId: string) => Promise<unknown>
type CommitTransition = (
  projectSlug: string,
  jobId: string,
  expected: Record<string, unknown>,
  after: Record<string, unknown>,
) => Promise<{ kind: 'fresh_transition' | 'already_after'; receipt: Record<string, unknown> }>

let retainedRoot = ''
let storyInstanceId = ''
let queue: QueueModule
let transport: TransportModule
let gatewayClient: GatewayClientModule
let evidence: EvidenceModule
let settings: SettingsModule
let identity: IdentityModule
let safeStorage: SafeStorageModule
let serial = 0
const trackedJobIds = new Set<string>()
const fixtureParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../_trash/test-fixtures')

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.keys(entry as Record<string, unknown>)
        .sort()
        .map(key => [key, sort((entry as Record<string, unknown>)[key])]))
    }
    return entry
  }
  return JSON.stringify(sort(value))
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const TOOLS_UTF8 = canonicalJson({
  format: 'studio.render.tools.v1', platform: 'macos-arm64',
  ffmpeg_sha256: '1'.repeat(64), ffmpeg_size_bytes: 132_141_880,
  ffprobe_sha256: '2'.repeat(64), ffprobe_size_bytes: 131_770_248,
  architecture_evidence_sha256: '3'.repeat(64), minimum_os_evidence_sha256: '4'.repeat(64),
  linked_libraries_evidence_sha256: '5'.repeat(64), build_configuration_evidence_sha256: '6'.repeat(64),
  capability_inventory_evidence_sha256: '7'.repeat(64),
})
const COMPILER_UTF8 = canonicalJson({
  format: 'studio.render.compiler.v1', implementation: 'hub-final-render-v1',
  python_runtime_sha256: '8'.repeat(64), render_hash_sha256: '9'.repeat(64),
  render_contract_sha256: 'b'.repeat(64), final_render_compiler_sha256: 'c'.repeat(64),
})
const TOOLS_DIGEST = sha256(TOOLS_UTF8)
const COMPILER_DIGEST = sha256(COMPILER_UTF8)
const PROFILE_UTF8 = canonicalJson({
  format: 'studio.render.profile.v1', implementation: 'story-classic-no-font-v1',
  recipe_namespace: 'studio.render.final.v1', compiler_artifact_sha256: COMPILER_DIGEST,
  tools_artifact_sha256: TOOLS_DIGEST, combination_set: 'retained-classic-no-font-candidate-v1',
  tier_policy: 'story-final-chain-v1', output_policy: 'story-final-output-v1',
  execution_bounds: {
    canvas_pairs: [{ width: 128, height: 96 }], working_fps: [5],
    max_duration_sec: 60, max_operations: 32, max_assets: 32,
    max_asset_bytes: 12 * 1024 * 1024, max_total_input_bytes: 24 * 1024 * 1024,
    max_pixel_frames: 128 * 96 * 5 * 60, scratch_reserve_bytes: 1,
    output_limit_bytes: 12 * 1024 * 1024, process_tree_rss_limit_bytes: 12 * 1024 * 1024,
    cumulative_wall_seconds: 60,
  },
  hardware_qualification_record_sha256: null, fidelity_record_sha256: null,
  production_eligible: false,
})
const PROFILE_DIGEST = sha256(PROFILE_UTF8)
const require = createRequire(import.meta.url)
let restoreElectron: (() => void) | undefined

async function installPackagedDescriptorFixture(): Promise<void> {
  const resourcesPath = path.join(retainedRoot, 'packaged-resources')
  const appPath = path.join(resourcesPath, 'app.asar')
  await fs.mkdir(appPath, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify({
    name: 'story-studio-kh', main: 'electron/dist/main.js', type: 'module',
    storyRenderProvenance: {
      format: 'studio.render.story-build-provenance.v1', mode: 'descriptor-only',
      descriptors: { profile_digest: PROFILE_DIGEST, tools_digest: TOOLS_DIGEST, compiler_digest: COMPILER_DIGEST },
      qualification: null,
    },
  }), { mode: 0o600 })
  const cached = require.cache[require.resolve('electron')]
  assert.ok(cached, 'safeStorage setup installs the test Electron cache entry')
  const previousExports = cached.exports
  const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  restoreElectron = () => {
    cached.exports = previousExports
    if (previousResources) Object.defineProperty(process, 'resourcesPath', previousResources)
    else Reflect.deleteProperty(process, 'resourcesPath')
  }
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true, enumerable: previousResources?.enumerable ?? true, writable: true, value: resourcesPath,
  })
  cached.exports = {
    ...previousExports,
    app: { ...previousExports.app, isPackaged: true, getAppPath: () => appPath },
  }
}

function capabilities(): FinalRenderCapabilities {
  return {
    format: 'studio.render.gateway-capabilities.v1', private: true, chargeable: false,
    owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID,
    story_instance_id: storyInstanceId, eligible: 0, idle: 0,
    server_time: Math.floor(Date.now() / 1000),
    profile_descriptor_utf8: PROFILE_UTF8, profile_digest: PROFILE_DIGEST,
    tools: { descriptor_utf8: TOOLS_UTF8, digest: TOOLS_DIGEST },
    compiler: { descriptor_utf8: COMPILER_UTF8, digest: COMPILER_DIGEST },
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

async function requestBody(init: RequestInit): Promise<Buffer> {
  if (init.body === undefined || init.body === null) return Buffer.alloc(0)
  if (typeof init.body === 'string') return Buffer.from(init.body)
  if (init.body instanceof Uint8Array) return Buffer.from(init.body)
  const stream = init.body as ReadableStream<Uint8Array>
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

class FakeGateway {
  readonly calls: WireCall[] = []
  readonly blobs = new Map<string, BlobState>()
  acceptedBody: Buffer | null = null
  postMode: 'accepted' | 'throw-after-record' = 'accepted'
  postError: { status: number; code: string } | null = null
  lookupMode: 'accepted' | 'not-found' | 'malformed' | 'wrong-key' | 'wrong-story' | 'wrong-intent' | 'wrong-attempt' = 'accepted'
  lostPut: 'none' | 'before-commit-once' | 'after-commit-once' = 'none'
  beforeCall?: (call: WireCall) => void | Promise<void>
  private lostPutUsed = false

  resetCalls(): void { this.calls.length = 0 }

  resetScenario(): void {
    this.resetCalls()
    this.blobs.clear()
    this.acceptedBody = null
    this.postMode = 'accepted'
    this.postError = null
    this.lookupMode = 'accepted'
    this.lostPut = 'none'
    this.lostPutUsed = false
    this.beforeCall = undefined
  }

  private blobPublic(state: BlobState): Record<string, unknown> {
    if (state.offset === 0) {
      return { format: 'studio.render.gateway-blob.v1', sha256: state.sha256,
        size_bytes: state.size_bytes, state: 'missing', offset: 0 }
    }
    const uploadId = state.sha256.slice(32)
    if (state.offset === state.size_bytes) {
      return { format: 'studio.render.gateway-blob.v1', sha256: state.sha256,
        size_bytes: state.size_bytes, state: 'complete', offset: state.offset,
        upload_id: uploadId, asset_handle: state.sha256.slice(0, 32) }
    }
    return { format: 'studio.render.gateway-blob.v1', sha256: state.sha256,
      size_bytes: state.size_bytes, state: 'uploading', offset: state.offset,
      upload_id: uploadId }
  }

  private accepted(request: Record<string, any>, replay: boolean): Record<string, unknown> {
    return {
      format: 'studio.render.gateway-job.v1', id: GATEWAY_JOB_ID, state: 'accepted',
      gateway_attempt_key: request.gateway_attempt_key,
      story_uuid: request.body.story_uuid, intent_id: request.body.intent_id,
      attempt_no: request.body.attempt_no, output_ready: false, idempotent_replay: replay,
      ...(replay ? {} : {
        destination_node: 'node-m4-a', inbound_story_body_sha256: sha256(request.bytes),
      }),
    }
  }

  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const call: WireCall = {
      method: init.method ?? 'GET', url: String(input), body: await requestBody(init), headers: new Headers(init.headers),
    }
    this.calls.push(call)
    assert.equal(call.headers.get('Authorization'), `Bearer ${gatewayKey}`)
    assert.equal(call.headers.get('X-Story-Instance'), storyInstanceId)
    await this.beforeCall?.(call)
    const url = new URL(call.url)
    if (url.pathname === '/v1/final-renders/capabilities') return Response.json(capabilities())

    const status = /^\/v1\/final-renders\/blobs\/([0-9a-f]{64})\/status$/.exec(url.pathname)
    if (status) {
      const size = Number(url.searchParams.get('size_bytes'))
      const current = this.blobs.get(status[1]) ?? { sha256: status[1], size_bytes: size, offset: 0 }
      assert.equal(current.size_bytes, size)
      this.blobs.set(status[1], current)
      return Response.json(this.blobPublic(current))
    }

    const put = /^\/v1\/final-renders\/blobs\/([0-9a-f]{64})$/.exec(url.pathname)
    if (put && call.method === 'PUT') {
      const size = Number(url.searchParams.get('size_bytes'))
      const offset = Number(url.searchParams.get('offset'))
      assert.equal(call.body.byteLength, Number(call.headers.get('Content-Length')))
      assert.equal(call.headers.get('Content-Range'), `bytes ${offset}-${offset + call.body.byteLength - 1}/${size}`)
      assert.ok(call.body.byteLength > 0 && call.body.byteLength <= MAX_CHUNK)
      const current = this.blobs.get(put[1]) ?? { sha256: put[1], size_bytes: size, offset: 0 }
      assert.equal(current.offset, offset)
      if (!this.lostPutUsed && this.lostPut !== 'none') {
        this.lostPutUsed = true
        if (this.lostPut === 'after-commit-once') current.offset += call.body.byteLength
        this.blobs.set(put[1], current)
        throw new Error('controlled uncertain PUT outcome')
      }
      current.offset += call.body.byteLength
      this.blobs.set(put[1], current)
      return Response.json(this.blobPublic(current))
    }

    if (url.pathname === '/v1/final-renders' && call.method === 'POST') {
      const body = JSON.parse(call.body.toString('utf8'))
      const request = { gateway_attempt_key: call.headers.get('Idempotency-Key'), body, bytes: call.body }
      if (this.postError) return Response.json({ error: { code: this.postError.code } }, { status: this.postError.status })
      this.acceptedBody = Buffer.from(call.body)
      if (this.postMode === 'throw-after-record') throw new Error('controlled unknown POST outcome')
      return Response.json(this.accepted(request, false), { status: 202 })
    }

    const lookup = /^\/v1\/final-renders\/by-idempotency-key\/([^/]+)$/.exec(url.pathname)
    if (lookup && call.method === 'GET') {
      if (this.lookupMode === 'not-found') return Response.json({ error: { code: 'RENDER_NOT_FOUND' } }, { status: 404 })
      if (this.lookupMode === 'malformed') return Response.json({ malformed: true })
      assert.ok(this.acceptedBody, 'lookup fixture has the original accepted request bytes')
      const body = JSON.parse(this.acceptedBody.toString('utf8'))
      const request = {
        gateway_attempt_key: decodeURIComponent(lookup[1]), body, bytes: this.acceptedBody,
      }
      const result = this.accepted(request, true)
      if (this.lookupMode === 'wrong-key') result.gateway_attempt_key = 'wrong-attempt-key'
      if (this.lookupMode === 'wrong-story') result.story_uuid = '99999999-9999-4999-8999-999999999999'
      if (this.lookupMode === 'wrong-intent') result.intent_id = '88888888-8888-4888-8888-888888888888'
      if (this.lookupMode === 'wrong-attempt') result.attempt_no = Number(result.attempt_no) + 1
      return Response.json(result)
    }
    throw new Error(`unexpected fake private-render request ${call.method} ${call.url}`)
  }
}

const gateway = new FakeGateway()

async function settle(): Promise<void> {
  if (!queue) return
  for (let turn = 0; turn < 2_000; turn++) {
    if ([...trackedJobIds].every(id => !queue._isJobWorkerActiveForTesting(id))) break
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  assert.ok([...trackedJobIds].every(id => !queue._isJobWorkerActiveForTesting(id)), 'all physical workers settle')
  await queue._waitForJobPersistenceForTesting()
}

before(async () => {
  const inheritedHarnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  let trustedFixtureParent: string
  if (inheritedHarnessRoot !== undefined) {
    assert.equal(path.isAbsolute(inheritedHarnessRoot), true, 'inherited test harness root must be absolute')
    assert.equal(path.resolve(inheritedHarnessRoot), inheritedHarnessRoot,
      'inherited test harness root must be lexically canonical')
    const harnessStat = await fs.lstat(inheritedHarnessRoot)
    assert.equal(harnessStat.isDirectory() && !harnessStat.isSymbolicLink(), true,
      'inherited test harness root must be a real directory')
    if (typeof process.getuid === 'function') {
      assert.equal(harnessStat.uid, process.getuid(),
        'inherited test harness root must be owned by this process user')
    }
    trustedFixtureParent = await fs.realpath(inheritedHarnessRoot)
    assert.equal(trustedFixtureParent, inheritedHarnessRoot,
      'inherited test harness root must already be its canonical real path')
  } else {
    await fs.mkdir(fixtureParent, { recursive: true, mode: 0o700 })
    trustedFixtureParent = await fs.realpath(fixtureParent)
  }
  retainedRoot = await fs.mkdtemp(path.join(trustedFixtureParent, 'final-render-sealed-transport-retained-'))
  await fs.chmod(retainedRoot, 0o700)
  const retainedStat = await fs.lstat(retainedRoot)
  assert.equal(retainedStat.isDirectory() && !retainedStat.isSymbolicLink(), true)
  assert.equal(retainedStat.mode & 0o077, 0, 'retained fixture child must be private')
  assert.equal(path.dirname(await fs.realpath(retainedRoot)), trustedFixtureParent,
    'retained fixture child must remain directly beneath the trusted parent')
  process.env.STORY_STUDIO_DATA_DIR = retainedRoot
  process.env.TMPDIR = retainedRoot
  process.env.TMP = retainedRoot
  process.env.TEMP = retainedRoot
  safeStorage = await import('./safe-storage-test-double.js')
  safeStorage.installTestSafeStorage()
  await installPackagedDescriptorFixture()
  safeStorage.setTestSafeStorageAvailable(true)
  settings = await import('../services/app-settings.js')
  identity = await import('../services/private-render-identity.js')
  transport = await import('../services/final-render-transport.js')
  gatewayClient = await import('../lib/final-render-gateway-client.js')
  evidence = await import('../lib/final-render-transport-evidence.js')
  queue = await import('../services/job-queue.js')
  await settings.setGenStudioUrl(ORIGIN)
  const privateIdentity = await identity.getOrCreatePrivateRenderIdentity()
  storyInstanceId = privateIdentity.story_instance_id
  await (await import('../services/app-secrets-store.js')).setApiKey('genstudio', BEARER)
  await identity.pinGatewayBinding({ origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  globalThis.fetch = gateway.fetch.bind(gateway)
})

after(async () => {
  try {
    await settle()
  } finally {
    globalThis.fetch = originalFetch
    restoreElectron?.()
    safeStorage.setTestSafeStorageAvailable(true)
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function requireAdvance(): Advance {
  const candidate = (transport as unknown as Record<string, unknown>).advanceSealedPrivateFinalRenderTransport
  assert.equal(typeof candidate, 'function',
    'S2B1B requires the real sealed transport advance helper after durable V3 prerequisites')
  return candidate as Advance
}

function requireCommitTransition(): CommitTransition {
  const candidate = (queue as unknown as Record<string, unknown>).commitFinalRenderTransportTransition
  assert.equal(typeof candidate, 'function', 'queue exposes one exact private V3 transition boundary')
  return candidate as CommitTransition
}

function makeJob(slug: string, id: string): Job {
  const job: Job = {
    job_id: id, project_slug: slug, type: 'video_assembly', episode_id: 'EP1',
    title: 'Sealed private final render', status: 'running',
    created_at: '2026-10-15T00:00:00.000Z', started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null, error: null, output_lines: [], params: { retained: true },
  }
  trackedJobIds.add(id)
  return job
}

async function writeJob(job: Job): Promise<void> {
  const directory = path.join(retainedRoot, 'projects', job.project_slug)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(directory, 'jobs.json'), `${JSON.stringify({ jobs: [job] })}\n`, { mode: 0o600 })
  queue._forgetProjectPersistenceForTesting(job.project_slug)
}

type Prepared = {
  job: Job
  composition: CompositionOpts & { code: string; titleHint: string; videoDir: string }
  receipt: Record<string, any>
  manifest: Record<string, any>
  intentDir: string
}

async function prepareCase(
  label: string,
  options: { duplicateLargeSources?: boolean; jobId?: string } = {},
): Promise<Prepared> {
  serial += 1
  gateway.resetScenario()
  await settings.setGenStudioUrl(ORIGIN)
  await settings.setPrivateFinalRenderSetting({ enabled: true })
  const slug = `sealed-${label}-${process.pid}-${serial}`
  const sourceDir = path.join(retainedRoot, 'work', slug, 'sources')
  const videoDir = path.join(retainedRoot, 'work', slug, 'video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(videoDir, { recursive: true, mode: 0o700 })
  const common = options.duplicateLargeSources ? Buffer.alloc(MAX_CHUNK + 17, 0x5a) : null
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  await fs.writeFile(base, common ?? SMALL_BASE, { mode: 0o600 })
  await fs.writeFile(audio, common ?? SMALL_AUDIO, { mode: 0o600 })
  const job = makeJob(slug, options.jobId ?? `s2b-${serial.toString(36)}`)
  await writeJob(job)
  const composition = {
    videoInputPath: base, premixedAudioPath: audio, targetDuration: 2,
    w: 128, h: 96, quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4', outputFile: path.join(sourceDir, 'must-not-render-locally.mp4'),
    encodingEffort: 'ultrafast', codec: 'h264', code: 'EP1',
    titleHint: `Title ${label}`, videoDir, job,
    resolvedLoudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
  } satisfies CompositionOpts & { code: string; titleHint: string; videoDir: string }
  assert.deepEqual(await transport.preparePrivateFinalRenderDescriptor(composition), {
    kind: 'video-assembly-remote-wait',
  })
  const canonical = await queue.loadAuthoritativeJob(slug, job.job_id)
  const receipt = structuredClone(canonical?.final_render_remote_wait) as Record<string, any>
  assert.equal(receipt.version, 2)
  assert.equal(receipt.phase, 'intent_staged')
  const intentDir = path.join(retainedRoot, 'private-render', 'intents', receipt.intent_id)
  const manifest = JSON.parse(await fs.readFile(path.join(intentDir, 'manifest.json'), 'utf8'))
  gateway.resetCalls()
  return { job, composition, receipt, manifest, intentDir }
}

async function revisionFiles(value: Prepared): Promise<string[]> {
  const directory = path.join(value.intentDir, 'transport', 'revisions')
  return (await fs.readdir(directory)).sort().map(name => path.join(directory, name))
}

async function latestRevision(value: Prepared): Promise<{ path: string; bytes: Buffer; value: Record<string, any> }> {
  const files = await revisionFiles(value)
  assert.ok(files.length > 0, 'at least one immutable private transport revision exists')
  const pathname = files.at(-1)!
  const bytes = await fs.readFile(pathname)
  return { path: pathname, bytes, value: JSON.parse(bytes.toString('utf8')) }
}

async function revisions(value: Prepared): Promise<Array<{ path: string; bytes: Buffer; value: Record<string, any> }>> {
  return Promise.all((await revisionFiles(value)).map(async pathname => {
    const bytes = await fs.readFile(pathname)
    return { path: pathname, bytes, value: JSON.parse(bytes.toString('utf8')) as Record<string, any> }
  }))
}

function encodeRevisionValues(values: Array<Record<string, any>>): Array<{
  name: string
  bytes: Buffer
  value: Record<string, any>
}> {
  let previous: string | null = null
  return values.map((source, index) => {
    const value = structuredClone(source)
    value.sequence = index + 1
    value.previous_sha256 = previous
    const bytes = Buffer.from(JSON.stringify(value), 'utf8')
    const digest = sha256(bytes)
    previous = digest
    return { name: `${String(index + 1).padStart(8, '0')}-${digest}.json`, bytes, value }
  })
}

async function replaceRevisionChain(
  prepared: Prepared,
  label: string,
  values: Array<Record<string, any>>,
): Promise<ReturnType<typeof encodeRevisionValues>> {
  const directory = path.join(prepared.intentDir, 'transport', 'revisions')
  await fs.rename(directory, `${directory}.retained-${label}`)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const encoded = encodeRevisionValues(values)
  for (const revision of encoded) {
    await fs.writeFile(path.join(directory, revision.name), revision.bytes, { flag: 'wx', mode: 0o600 })
  }
  return encoded
}

async function retainPrivateRequestSeal(prepared: Prepared, label: string): Promise<void> {
  let refused = false
  const restore = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || refused) return
    const current = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', prepared.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]?.final_render_remote_wait
    if (current?.version === 2) {
      refused = true
      throw new Error(`controlled ${label} request-seal refusal`)
    }
  })
  try {
    await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
      new RegExp(`controlled ${label} request-seal refusal`))
    assert.equal(refused, true)
    const staged = await canonicalReceipt(prepared)
    const parsedStaged = parseFinalRenderRemoteWaitReceipt(staged, prepared.job.job_id)
    assert.ok(parsedStaged.ok, 'the retained staged receipt passes the production parser')
    assert.equal(parsedStaged.receipt.version, 2)
    assert.ok((await revisions(prepared)).some(item => item.value.event === 'request_sealed'))
    restore()
    const sealed = await canonicalAfterEvent(prepared, 'request_sealed')
    assert.equal((await requireCommitTransition()(
      prepared.job.project_slug, prepared.job.job_id, staged, sealed,
    )).kind, 'fresh_transition', 'the controlled pending row is settled before evidence mutation')
    const committed = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
    assert.ok(committed)
    const fixtureJob: Job = {
      ...committed,
      final_render_remote_wait: structuredClone(parsedStaged.receipt),
    }
    await writeJob(fixtureJob)
    assert.deepEqual(await canonicalReceipt(prepared), staged,
      'the retained fixture models the crash boundary before canonical request-seal CAS')
  } finally {
    restore()
  }
}

async function pureEvidenceRejects(
  prepared: Prepared,
  revisionValues: Array<Record<string, any>>,
): Promise<boolean> {
  try {
    evidence.validateFinalRenderTransportEvidence({
      staged: prepared.receipt as Parameters<EvidenceModule['validateFinalRenderTransportEvidence']>[0]['staged'],
      canonical: prepared.receipt as Parameters<EvidenceModule['validateFinalRenderTransportEvidence']>[0]['canonical'],
      manifestBytes: await fs.readFile(path.join(prepared.intentDir, 'manifest.json')),
      revisions: encodeRevisionValues(revisionValues),
    })
    return false
  } catch {
    return true
  }
}

async function referencedRevision(value: Prepared, digest: string) {
  const match = (await revisions(value)).find(revision => sha256(revision.bytes) === digest)
  assert.ok(match, `canonical transport revision ${digest} exists in the retained chain`)
  return match
}

async function canonicalAfterEvent(value: Prepared, event: string): Promise<Record<string, any>> {
  const revision = (await revisions(value)).filter(item => item.value.event === event).at(-1)
  assert.ok(revision?.value.payload?.after, `${event} has a closed private after projection`)
  assert.equal(Object.hasOwn(revision.value.payload.after, 'transport_revision_sha256'), false)
  return { ...revision.value.payload.after, transport_revision_sha256: sha256(revision.bytes) }
}

async function requestBytes(value: Prepared): Promise<Buffer> {
  return fs.readFile(path.join(value.intentDir, 'transport', 'request.json'))
}

async function canonicalReceipt(value: Prepared): Promise<Record<string, any>> {
  const job = await queue.loadAuthoritativeJob(value.job.project_slug, value.job.job_id)
  return structuredClone(job?.final_render_remote_wait) as Record<string, any>
}

const V3_KEYS = [
  'version', 'phase', 'revision', 'job_id', 'intent_id', 'story_instance_id', 'story_attempt',
  'gateway_attempt_key', 'packet_sha256', 'staging_manifest_sha256', 'submission_scope_sha256',
  'destination_fence_sha256', 'source_generation_fence_sha256', 'committed_at',
  'cancel_requested_at', 'request_body_sha256', 'request_body_bytes', 'gateway_job_id',
  'transport_revision_sha256',
] as const

async function assertExactV3(
  prepared: Prepared,
  expected: { phase: string; revision: number; gateway_job_id: string | null },
): Promise<Record<string, any>> {
  const receipt = await canonicalReceipt(prepared)
  const request = await requestBytes(prepared)
  const revision = await referencedRevision(prepared, receipt.transport_revision_sha256)
  assert.deepEqual(new Set(Object.keys(receipt)), new Set(V3_KEYS))
  assert.equal(receipt.version, 3)
  assert.equal(receipt.phase, expected.phase)
  assert.equal(receipt.revision, expected.revision)
  assert.equal(receipt.gateway_job_id, expected.gateway_job_id)
  assert.equal(receipt.request_body_sha256, sha256(request))
  assert.equal(receipt.request_body_bytes, request.byteLength)
  assert.equal(receipt.transport_revision_sha256, sha256(revision.bytes))
  assert.ok(revision.value.payload?.after && typeof revision.value.payload.after === 'object')
  assert.equal(Object.hasOwn(revision.value.payload.after, 'transport_revision_sha256'), false,
    'the closed after projection cannot contain its own revision digest')
  assert.deepEqual(receipt, {
    ...revision.value.payload.after,
    transport_revision_sha256: sha256(revision.bytes),
  }, 'canonical V3 is exactly the acyclic private after projection plus its finalized revision digest')
  assert.equal(revision.value.event, {
    request_persisted: 'request_sealed',
    send_may_start: 'send_may_start',
    send_unknown: 'post_unknown',
    lookup_not_found: 'lookup_not_found',
    remote_wait: revision.value.event,
  }[receipt.phase], 'the canonical phase cites its exact transition revision')
  if (receipt.phase === 'remote_wait') {
    assert.ok(['post_accepted', 'lookup_accepted'].includes(revision.value.event))
  }
  for (const key of [
    'job_id', 'intent_id', 'story_instance_id', 'story_attempt', 'gateway_attempt_key',
    'packet_sha256', 'staging_manifest_sha256', 'submission_scope_sha256',
    'destination_fence_sha256', 'source_generation_fence_sha256', 'committed_at',
  ]) assert.equal(receipt[key], prepared.receipt[key], `${key} stays byte-identical to V2`)
  return receipt
}


function requireValidateSubmitBytes(): (bytes: Uint8Array) => unknown {
  const candidate = (gatewayClient as unknown as Record<string, unknown>).validateSubmitBytes
  assert.equal(typeof candidate, 'function', 'S2B1B reuses the real pure six-key submit-byte validator')
  return candidate as (bytes: Uint8Array) => unknown
}

test('persists each exact blob hop before GET/PUT and resumes the same uncertain range', async () => {
  const prepared = await prepareCase('hops', { duplicateLargeSources: true })
  gateway.lostPut = 'before-commit-once'
  gateway.beforeCall = async call => {
    if (!call.url.includes('/blobs/')) return
    const revision = await latestRevision(prepared)
    const expected = call.method === 'PUT' ? 'blob_put_intent' : 'blob_status_intent'
    assert.equal(revision.value.event, expected, `${expected} is durable before network`)
    assert.deepEqual(Object.keys(revision.value), [
      'version', 'sequence', 'previous_sha256', 'canonical_before_sha256', 'event',
      'recorded_at', 'owner_token', 'owner_epoch', 'payload',
    ])
    assert.equal(revision.value.canonical_before_sha256, sha256(JSON.stringify(prepared.receipt)))
    assert.equal(revision.value.payload.offset, Number(new URL(call.url).searchParams.get('offset') ?? revision.value.payload.offset))
    assert.match(revision.value.payload.hop_id, /^[0-9a-f]{32}$/)
    assert.ok(Buffer.byteLength(JSON.stringify(revision.value.payload)) <= 64 * 1024)
    assert.match(revision.value.owner_token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.ok(Number.isSafeInteger(revision.value.owner_epoch) && revision.value.owner_epoch > 0)
  }
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /PUT|uncertain|render/i)
  const firstPut = gateway.calls.find(call => call.method === 'PUT')!
  assert.equal(firstPut.body.byteLength, MAX_CHUNK)
  assert.deepEqual(firstPut.body, Buffer.alloc(MAX_CHUNK, 0x5a))

  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const puts = gateway.calls.filter(call => call.method === 'PUT')
  assert.equal(puts.length, 3, 'the exact refused first range is retried once, then the final 17 bytes upload')
  assert.deepEqual(puts[1].body, puts[0].body)
  assert.equal(puts[1].headers.get('Content-Range'), puts[0].headers.get('Content-Range'))
  assert.equal(puts[2].body.byteLength, 17)
  const request = JSON.parse((await requestBytes(prepared)).toString('utf8'))
  assert.equal(request.assets.base, request.assets.audio, 'identical digest/size sources reuse one verified handle')
  assert.match(request.assets.base, /^[0-9a-f]{32}$/, 'Gateway asset handles use the actual 32-hex wire shape')
  for (const state of gateway.blobs.values()) {
    assert.match(state.sha256.slice(32), /^[0-9a-f]{32}$/, 'Gateway upload IDs use the actual 32-hex wire shape')
  }
  const chain = await revisions(prepared)
  assert.ok(chain.length <= 16_384)
  for (const [index, revision] of chain.entries()) {
    assert.equal(revision.value.sequence, index + 1)
    assert.equal(revision.value.previous_sha256, index === 0 ? null : sha256(chain[index - 1].bytes))
    if (revision.value.event.endsWith('_observed')) {
      assert.deepEqual(Object.keys(revision.value.payload), ['hop_id', 'response'])
      assert.match(revision.value.payload.hop_id, /^[0-9a-f]{32}$/)
      if (revision.value.payload.response.upload_id !== undefined) {
        assert.match(revision.value.payload.response.upload_id, /^[0-9a-f]{32}$/)
      }
    }
  }
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
  await assertExactV3(prepared, { phase: 'remote_wait', revision: 4, gateway_job_id: GATEWAY_JOB_ID })
})

test('compute ownership and every authority reread fence stale work while stage-only cancel retains partial upload', async () => {
  const prepared = await prepareCase('authority')
  const entered = deferred()
  const release = deferred()
  gateway.blobs.set(prepared.manifest.sources[0].sha256, {
    sha256: prepared.manifest.sources[0].sha256,
    size_bytes: prepared.manifest.sources[0].size_bytes,
    offset: Math.min(3, prepared.manifest.sources[0].size_bytes - 1),
  })
  gateway.beforeCall = async call => {
    if (call.method === 'GET' && call.url.includes('/blobs/')) {
      entered.resolve()
      await release.promise
    }
  }
  const first = requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  await entered.promise
  const second = requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const cancelled = await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  const firstCancel = (cancelled.final_render_remote_wait as any).cancel_requested_at
  assert.ok(firstCancel)
  release.resolve()
  await Promise.allSettled([first, second])
  const replay = await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  assert.equal((replay.final_render_remote_wait as any).cancel_requested_at, firstCancel)
  assert.equal(gateway.calls.some(call => call.method === 'PUT' || call.method === 'POST'), false)
  assert.equal((await canonicalReceipt(prepared)).version, 2)
  assert.equal((await canonicalReceipt(prepared)).revision, 2)
  assert.equal((await canonicalReceipt(prepared)).request_body_sha256, undefined)

  const settingCase = await prepareCase('authority-setting')
  const settingEntered = deferred()
  const settingRelease = deferred()
  gateway.beforeCall = async call => {
    if (call.method === 'GET' && call.url.includes('/blobs/')) {
      settingEntered.resolve()
      await settingRelease.promise
    }
  }
  const settingRun = requireAdvance()(settingCase.job.project_slug, settingCase.job.job_id)
  await settingEntered.promise
  await settings.setPrivateFinalRenderSetting({ enabled: false })
  settingRelease.resolve()
  await assert.rejects(settingRun, /setting|enabled|authority|render/i)
  assert.equal(gateway.calls.some(call => call.method === 'PUT' || call.method === 'POST'), false)

  const pairingCase = await prepareCase('authority-pairing')
  const pairingEntered = deferred()
  const pairingRelease = deferred()
  gateway.beforeCall = async call => {
    if (call.method === 'GET' && call.url.includes('/blobs/')) {
      pairingEntered.resolve()
      await pairingRelease.promise
    }
  }
  const pairingRun = requireAdvance()(pairingCase.job.project_slug, pairingCase.job.job_id)
  await pairingEntered.promise
  await settings.setGenStudioUrl(OTHER_ORIGIN)
  pairingRelease.resolve()
  await assert.rejects(pairingRun, /origin|pairing|authority|render/i)
  assert.equal(gateway.calls.some(call => call.method === 'PUT' || call.method === 'POST'), false)
  await settings.setGenStudioUrl(ORIGIN)

  const rotationCase = await prepareCase('authority-key-rotation')
  const rotationEntered = deferred()
  const rotationRelease = deferred()
  gateway.beforeCall = async call => {
    if (call.method === 'GET' && call.url.includes('/blobs/')) {
      rotationEntered.resolve()
      await rotationRelease.promise
    }
  }
  const secrets = await import('../services/app-secrets-store.js')
  const rotationRun = requireAdvance()(rotationCase.job.project_slug, rotationCase.job.job_id)
  await rotationEntered.promise
  await secrets.setApiKey('genstudio', ROTATED_BEARER)
  gatewayKey = ROTATED_BEARER
  rotationRelease.resolve()
  try {
    await rotationRun
    assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1, 'Gateway API key rotation does not abort the transfer')
  } finally {
    await secrets.setApiKey('genstudio', BEARER)
    gatewayKey = BEARER
    gateway.beforeCall = undefined
  }

  const recoveryCase = await prepareCase('authority-dead-owner')
  gateway.lostPut = 'before-commit-once'
  await assert.rejects(requireAdvance()(recoveryCase.job.project_slug, recoveryCase.job.job_id))
  const firstOwner = (await revisions(recoveryCase)).filter(item => item.value.event === 'owner_acquired').at(-1)!
  const computeKey = path.join(retainedRoot, 'private-render', 'locks', `${recoveryCase.receipt.intent_id}.compute`)
  await fs.mkdir(path.dirname(computeKey), { recursive: true, mode: 0o700 })
  await fs.writeFile(`${computeKey}.lock`, JSON.stringify({
    token: '77777777-7777-4777-8777-777777777777',
    pid: 1_073_741_823,
    hostname: os.hostname(),
    created_at_ms: 1,
  }), { mode: 0o600 })
  gateway.lostPut = 'none'
  await requireAdvance()(recoveryCase.job.project_slug, recoveryCase.job.job_id)
  const recoveredChain = await revisions(recoveryCase)
  const secondOwner = recoveredChain.filter(item => item.value.event === 'owner_acquired').at(-1)!
  assert.equal(secondOwner.value.owner_epoch, firstOwner.value.owner_epoch + 1)
  assert.notEqual(secondOwner.value.owner_token, firstOwner.value.owner_token)
  const secondOwnerIndex = recoveredChain.indexOf(secondOwner)
  for (const revision of recoveredChain.slice(secondOwnerIndex)) {
    assert.equal(revision.value.owner_token, secondOwner.value.owner_token,
      'the stale owner cannot append or release its successor after epoch handoff')
  }
})

test('seals exact six-key bytes and constructibly promotes V2 to request_persisted', async t => {
  const prepared = await prepareCase('seal')
  let refusedSendPromotion = false
  const restore = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || refusedSendPromotion) return
    const current = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', prepared.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]?.final_render_remote_wait
    if (current?.version === 3 && current.phase === 'request_persisted') {
      refusedSendPromotion = true
      throw new Error('controlled send promotion refusal')
    }
  })
  t.after(restore)
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /controlled send promotion refusal/)
  assert.equal(refusedSendPromotion, true)
  const request = await requestBytes(prepared)
  const body = JSON.parse(request.toString('utf8'))
  assert.deepEqual(Object.keys(body), ['format', 'story_uuid', 'intent_id', 'attempt_no', 'packet', 'assets'])
  assert.doesNotThrow(() => requireValidateSubmitBytes()(request))
  assert.equal(body.format, 'studio.render.gateway-request.v1')
  assert.equal(body.story_uuid, storyInstanceId)
  assert.notEqual(body.story_uuid, prepared.job.job_id, 'short queue id is never sent as Story UUID')
  assert.equal(body.intent_id, prepared.receipt.intent_id)
  assert.equal(body.attempt_no, 1)
  assert.deepEqual(body.packet, prepared.manifest.packet)
  assert.deepEqual(new Set(Object.keys(body.assets)), new Set(prepared.manifest.packet.manifest.map((item: any) => item.logical_id)))
  const submissionBytes = await fs.readFile(path.join(prepared.intentDir, 'transport', 'submission.json'))
  const submission = JSON.parse(submissionBytes.toString('utf8'))
  assert.equal(submission.request_body_sha256, sha256(request))
  assert.equal(submission.request_body_bytes, request.byteLength)
  assert.equal(JSON.stringify(submission).includes(BEARER), false)
  const revision = await latestRevision(prepared)
  assert.equal(revision.value.event, 'send_may_start')
  assert.equal(Object.hasOwn(revision.value, 'canonical_after_sha256'), false)
  assert.equal(Object.hasOwn(revision.value.payload.after, 'transport_revision_sha256'), false)
  await assertExactV3(prepared, { phase: 'request_persisted', revision: 2, gateway_job_id: null })
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 0)
  restore()

  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  assert.deepEqual(await requestBytes(prepared), request, 'recovery uses the same immutable request bytes')
  assert.deepEqual(await fs.readFile(path.join(prepared.intentDir, 'transport', 'submission.json')), submissionBytes)
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)

  const changedCase = await prepareCase('seal-changed-private-bytes')
  let changedCaseRefused = false
  const restoreChanged = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || changedCaseRefused) return
    const current = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', changedCase.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]?.final_render_remote_wait
    if (current.version === 3 && current.phase === 'request_persisted') {
      changedCaseRefused = true
      throw new Error('controlled changed-bytes promotion refusal')
    }
  })
  t.after(restoreChanged)
  await assert.rejects(requireAdvance()(changedCase.job.project_slug, changedCase.job.job_id),
    /controlled changed-bytes promotion refusal/)
  const changedRequest = path.join(changedCase.intentDir, 'transport', 'request.json')
  await fs.rename(changedRequest, `${changedRequest}.retained-original`)
  await fs.writeFile(changedRequest, Buffer.from('{"changed":true}\n'), { mode: 0o600 })
  restoreChanged()
  await assert.rejects(requireAdvance()(changedCase.job.project_slug, changedCase.job.job_id),
    /request|immutable|hash|recovery|render/i)
  assert.equal(gateway.calls.some(call => call.method === 'POST'), false)

  const brokenHopCase = await prepareCase('seal-broken-hop')
  gateway.lostPut = 'before-commit-once'
  await assert.rejects(requireAdvance()(brokenHopCase.job.project_slug, brokenHopCase.job.job_id))
  const observed = (await revisions(brokenHopCase)).find(item => item.value.event === 'blob_status_observed')!
  await fs.rename(observed.path, `${observed.path}.retained-original`)
  observed.value.payload.hop_id = '0'.repeat(32)
  await fs.writeFile(observed.path, JSON.stringify(observed.value), { mode: 0o600 })
  gateway.lostPut = 'none'
  await assert.rejects(requireAdvance()(brokenHopCase.job.project_slug, brokenHopCase.job.job_id),
    /hop|revision|chain|recovery|render/i)
})

test('canonical send_may_start readback precedes exactly one POST', async t => {
  const prepared = await prepareCase('one-post')
  const entered = deferred()
  const release = deferred()
  gateway.beforeCall = async call => {
    if (call.method !== 'POST') return
    const receipt = await assertExactV3(prepared, { phase: 'send_may_start', revision: 3, gateway_job_id: null })
    const revision = await latestRevision(prepared)
    assert.equal(revision.value.event, 'send_may_start')
    assert.equal(receipt.transport_revision_sha256, sha256(revision.bytes))
    assert.deepEqual(call.body, await requestBytes(prepared))
    entered.resolve()
    await release.promise
  }
  const running = requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  await entered.promise
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
  release.resolve()
  await running
  await assertExactV3(prepared, { phase: 'remote_wait', revision: 4, gateway_job_id: GATEWAY_JOB_ID })
  gateway.resetCalls()
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 0)

  const alreadyCase = await prepareCase('already-after')
  let refusedSendPromotion = false
  const restore = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || refusedSendPromotion) return
    const current = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', alreadyCase.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]?.final_render_remote_wait
    if (current?.version === 3 && current.phase === 'request_persisted') {
      refusedSendPromotion = true
      throw new Error('controlled already-after promotion refusal')
    }
  })
  t.after(restore)
  await assert.rejects(requireAdvance()(alreadyCase.job.project_slug, alreadyCase.job.job_id),
    /controlled already-after promotion refusal/)
  restore()
  const beforeSend = await canonicalReceipt(alreadyCase)
  const afterSend = await canonicalAfterEvent(alreadyCase, 'send_may_start')
  const fresh = await requireCommitTransition()(
    alreadyCase.job.project_slug, alreadyCase.job.job_id, beforeSend, afterSend,
  )
  assert.equal(fresh.kind, 'fresh_transition')
  const alreadyAfter = await requireCommitTransition()(
    alreadyCase.job.project_slug, alreadyCase.job.job_id, beforeSend, afterSend,
  )
  assert.equal(alreadyAfter.kind, 'already_after')
  gateway.acceptedBody = await requestBytes(alreadyCase)
  gateway.resetCalls()
  await requireAdvance()(alreadyCase.job.project_slug, alreadyCase.job.job_id)
  assert.deepEqual(gateway.calls.map(call => call.method), ['GET'])
  assert.equal(gateway.calls.some(call => call.method === 'POST'), false)
})

test('unknown POST and restart use original-key lookup only', async () => {
  const prepared = await prepareCase('unknown')
  gateway.postMode = 'throw-after-record'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /unknown POST|render/i)
  const originalBody = Buffer.from(gateway.acceptedBody!)
  const request = JSON.parse(originalBody.toString('utf8'))
  const originalKey = prepared.receipt.gateway_attempt_key
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
  const unknownReceipt = await assertExactV3(prepared, { phase: 'send_unknown', revision: 4, gateway_job_id: null })

  gateway.resetCalls()
  gateway.postMode = 'accepted'
  gateway.lookupMode = 'accepted'
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  assert.deepEqual(gateway.calls.map(call => call.method), ['GET'])
  assert.equal(new URL(gateway.calls[0].url).pathname,
    `/v1/final-renders/by-idempotency-key/${encodeURIComponent(originalKey)}`)
  assert.deepEqual(gateway.acceptedBody, originalBody)
  assert.equal(request.story_uuid, storyInstanceId)
  await assertExactV3(prepared, { phase: 'remote_wait', revision: 5, gateway_job_id: GATEWAY_JOB_ID })
  const reopenedOwner = (await revisions(prepared)).filter(item => item.value.event === 'owner_acquired').at(-1)!
  assert.equal(reopenedOwner.value.canonical_before_sha256, sha256(JSON.stringify(unknownReceipt)),
    'reopened V3 ownership hashes the current canonical marker')

  for (const lookupMode of ['wrong-key', 'wrong-story', 'wrong-intent', 'wrong-attempt'] as const) {
    const mismatch = await prepareCase(`lookup-${lookupMode}`)
    gateway.postMode = 'throw-after-record'
    await assert.rejects(requireAdvance()(mismatch.job.project_slug, mismatch.job.job_id))
    const heldBefore = await assertExactV3(mismatch, {
      phase: 'send_unknown', revision: 4, gateway_job_id: null,
    })
    gateway.resetCalls()
    gateway.lookupMode = lookupMode
    await assert.rejects(requireAdvance()(mismatch.job.project_slug, mismatch.job.job_id),
      /key|story|intent|attempt|lineage|recovery|render/i)
    assert.deepEqual(await canonicalReceipt(mismatch), heldBefore)
    assert.deepEqual(gateway.calls.map(call => call.method), ['GET'])
    assert.equal(gateway.calls.some(call => call.method === 'POST'), false)
  }
})

test('authenticated lookup 404 is typed and remains a nonrunnable recovery hold', async () => {
  const prepared = await prepareCase('lookup-404')
  gateway.postMode = 'throw-after-record'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
  gateway.resetCalls()
  gateway.lookupMode = 'not-found'
  await assert.rejects(
    requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
    error => {
      assert.equal((error as any)?.name, 'FinalRenderHttpError')
      assert.equal((error as any)?.status, 404)
      return true
    },
  )
  assert.deepEqual(gateway.calls.map(call => call.method), ['GET'])
  const held = await assertExactV3(prepared, {
    phase: 'lookup_not_found', revision: 5, gateway_job_id: null,
  })
  assert.equal(held.gateway_job_id, null)
  assert.equal((await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))?.status, 'running')
  assert.equal(gateway.calls.some(call => call.method === 'POST'), false)
  const publicHeld = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0] as any
  assert.equal(publicHeld.final_render_wait?.state, 'recovery_hold')
  await assert.rejects(fs.stat(prepared.composition.outputFile), /ENOENT/)

  queue._forgetProjectPersistenceForTesting(prepared.job.project_slug)
  gateway.resetCalls()
  gateway.lookupMode = 'accepted'
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  assert.deepEqual(gateway.calls.map(call => call.method), ['GET'])
  assert.equal(new URL(gateway.calls[0].url).pathname,
    `/v1/final-renders/by-idempotency-key/${encodeURIComponent(prepared.receipt.gateway_attempt_key)}`)
  assert.equal(gateway.calls.some(call => call.method === 'POST'), false)
  await assertExactV3(prepared, { phase: 'remote_wait', revision: 6, gateway_job_id: GATEWAY_JOB_ID })
})

test('exact transition retry and every public projection preserve private lineage', async t => {
  const prepared = await prepareCase('exact-projection')
  const updates: unknown[] = []
  const listener = (value: unknown) => { updates.push(structuredClone(value)) }
  queue.jobEvents.on('update', listener)
  t.after(() => queue.jobEvents.off('update', listener))
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const accepted = await assertExactV3(prepared, {
    phase: 'remote_wait', revision: 4, gateway_job_id: GATEWAY_JOB_ID,
  })

  const commit = requireCommitTransition()
  for (const changed of [
    { ...accepted, phase: 'send_unknown', gateway_job_id: null },
    { ...accepted, gateway_job_id: '66666666-6666-4666-8666-666666666666' },
    { ...accepted, request_body_sha256: '0'.repeat(64) },
    { ...accepted, revision: accepted.revision + 1 },
    { ...accepted, transport_revision_sha256: 'f'.repeat(64) },
  ]) {
    await assert.rejects(
      commit(
        prepared.job.project_slug, prepared.job.job_id, accepted, changed,
      ),
      /canonical|changed|transition|lineage|recovery/i,
    )
  }
  assert.deepEqual(await canonicalReceipt(prepared), accepted)

  const full = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0] as any
  const stream = (await queue.getJobs(prepared.job.project_slug, { view: 'stream' }))[0] as any
  const single = queue.getPublicJob(prepared.job.job_id) as any
  queue._flushDirtyJobStreamsForTesting()
  assert.ok(updates.length > 0, 'SSE observed at least one sanitized queue transition')
  const sealedRequest = JSON.parse((await requestBytes(prepared)).toString('utf8'))
  for (const projection of [full, stream, single, ...updates]) {
    const text = JSON.stringify(projection)
    assert.equal(text.includes('final_render_remote_wait'), false)
    assert.equal(text.includes(accepted.request_body_sha256), false)
    assert.equal(text.includes(accepted.transport_revision_sha256), false)
    assert.equal(text.includes(BEARER), false)
    assert.equal(text.includes(GATEWAY_ID), false)
    assert.equal(text.includes(sealedRequest.assets.base), false)
  }
  assert.equal(full.final_render_wait?.state, 'remote_wait')
  assert.equal(stream.final_render_wait?.state, 'remote_wait')
  assert.equal(single.final_render_wait?.gateway_id_known, true)

  const sharedJobId = 'samejob1'
  const projectA = await prepareCase('collision-a', { jobId: sharedJobId })
  const projectB = await prepareCase('collision-b', { jobId: sharedJobId })
  let refusedA = false
  const restore = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || refusedA) return
    const currentA = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', projectA.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]?.final_render_remote_wait
    if (currentA.version === 2) {
      refusedA = true
      throw new Error('controlled project-A transition refusal')
    }
  })
  t.after(restore)
  await assert.rejects(requireAdvance()(projectA.job.project_slug, sharedJobId),
    /controlled project-A transition refusal/)
  assert.equal(refusedA, true)
  await requireAdvance()(projectB.job.project_slug, sharedJobId)
  const heldA = await canonicalReceipt(projectA)
  const completeB = await canonicalReceipt(projectB)
  assert.equal(heldA.story_instance_id, projectA.receipt.story_instance_id)
  assert.equal(heldA.intent_id, projectA.receipt.intent_id)
  assert.equal(completeB.story_instance_id, projectB.receipt.story_instance_id)
  assert.equal(completeB.intent_id, projectB.receipt.intent_id)
  assert.notEqual(heldA.intent_id, completeB.intent_id)
  assert.equal(completeB.phase, 'remote_wait')
  restore()
  await requireAdvance()(projectA.job.project_slug, sharedJobId)
  assert.equal((await canonicalReceipt(projectA)).phase, 'remote_wait')
  assert.equal((await canonicalReceipt(projectB)).phase, 'remote_wait')
})

test('independent queue CAS rejects a self-consistent orphan transport revision', async () => {
  const prepared = await prepareCase('r1-orphan-cas')
  const transportDir = path.join(prepared.intentDir, 'transport')
  const revisionsDir = path.join(transportDir, 'revisions')
  await fs.mkdir(revisionsDir, { recursive: true, mode: 0o700 })
  const assets = Object.fromEntries(
    prepared.manifest.packet.manifest.map((item: any, index: number) => [
      item.logical_id, String(index + 1).padStart(32, 'a').slice(-32),
    ]),
  )
  const request = Buffer.from(JSON.stringify({
    format: 'studio.render.gateway-request.v1', story_uuid: storyInstanceId,
    intent_id: prepared.receipt.intent_id, attempt_no: prepared.receipt.story_attempt,
    packet: prepared.manifest.packet, assets,
  }), 'utf8')
  assert.doesNotThrow(() => gatewayClient.validateSubmitBytes(request))
  await fs.writeFile(path.join(transportDir, 'request.json'), request, { flag: 'wx', mode: 0o600 })
  const pairingProjection = {
    origin: ORIGIN, owner_scope: OWNER_SCOPE,
    gateway_instance_id: GATEWAY_ID, story_instance_id: storyInstanceId,
  }
  const submission = {
    format: 'studio.render.story-submission.v1', job_id: prepared.job.job_id,
    intent_id: prepared.receipt.intent_id, story_instance_id: storyInstanceId,
    story_attempt: 1, gateway_attempt_key: prepared.receipt.gateway_attempt_key,
    request_body_sha256: sha256(request), request_body_bytes: request.byteLength,
    packet_sha256: prepared.receipt.packet_sha256,
    staging_manifest_sha256: prepared.receipt.staging_manifest_sha256,
    pairing_identity_sha256: sha256(JSON.stringify(pairingProjection)),
    profile_sha256: prepared.manifest.descriptors.profile.sha256,
    tools_sha256: prepared.manifest.descriptors.tools.sha256,
    compiler_sha256: prepared.manifest.descriptors.compiler.sha256,
    sources: prepared.manifest.sources.map((source: any) => ({
      logical_id: source.logical_id, safe_name: source.safe_name,
      source_sha256: source.sha256, size_bytes: source.size_bytes,
      gateway_asset_handle: assets[source.logical_id],
    })),
  }
  await fs.writeFile(path.join(transportDir, 'submission.json'), JSON.stringify(submission), { flag: 'wx', mode: 0o600 })
  const after = {
    ...prepared.receipt, version: 3, phase: 'request_persisted', revision: 2,
    request_body_sha256: sha256(request), request_body_bytes: request.byteLength,
    gateway_job_id: null,
  }
  const orphan = {
    version: 1, sequence: 9, previous_sha256: '0'.repeat(64),
    canonical_before_sha256: 'f'.repeat(64), event: 'request_sealed',
    recorded_at: '2026-10-15T00:00:01.000Z',
    owner_token: '77777777-7777-4777-8777-777777777777', owner_epoch: 7,
    payload: { after },
  }
  const orphanBytes = Buffer.from(JSON.stringify(orphan), 'utf8')
  const orphanDigest = sha256(orphanBytes)
  await fs.writeFile(path.join(revisionsDir, `00000009-${orphanDigest}.json`), orphanBytes, { flag: 'wx', mode: 0o600 })
  const proposed = { ...after, transport_revision_sha256: orphanDigest }
  const beforeDisk = await canonicalReceipt(prepared)
  await assert.rejects(
    requireCommitTransition()(prepared.job.project_slug, prepared.job.job_id, prepared.receipt, proposed),
    /chain|orphan|sequence|previous|owner|canonical|evidence|recovery/i,
  )
  assert.deepEqual(await canonicalReceipt(prepared), beforeDisk,
    'an orphan revision cannot mutate the independent canonical queue authority')
})

test('independent queue CAS requires every sealed handle to have exact complete blob proof', async () => {
  const outcomes: Array<{
    label: string
    rejected: boolean
    before: Record<string, any>
    after: Record<string, any>
  }> = []

  const noProof = await prepareCase('r2-seal-no-complete-proof')
  await retainPrivateRequestSeal(noProof, 'no-complete-proof')
  const noProofValues = (await revisions(noProof))
    .filter(item => item.value.event === 'owner_acquired' || item.value.event === 'request_sealed')
    .map(item => item.value)
  const noProofChain = await replaceRevisionChain(noProof, 'no-complete-proof', noProofValues)
  const noProofSeal = noProofChain.find(item => item.value.event === 'request_sealed')!
  const noProofProposed = {
    ...noProofSeal.value.payload.after,
    transport_revision_sha256: sha256(noProofSeal.bytes),
  }
  const noProofBefore = await canonicalReceipt(noProof)
  let noProofRejected = false
  try {
    await requireCommitTransition()(
      noProof.job.project_slug, noProof.job.job_id, noProofBefore, noProofProposed,
    )
  } catch { noProofRejected = true }
  outcomes.push({
    label: 'no complete proof', rejected: noProofRejected,
    before: noProofBefore, after: await canonicalReceipt(noProof),
  })

  const invented = await prepareCase('r2-seal-invented-handle')
  await retainPrivateRequestSeal(invented, 'invented-handle')
  const requestPath = path.join(invented.intentDir, 'transport', 'request.json')
  const submissionPath = path.join(invented.intentDir, 'transport', 'submission.json')
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8')) as Record<string, any>
  const submission = JSON.parse(await fs.readFile(submissionPath, 'utf8')) as Record<string, any>
  const logicalId = invented.manifest.sources[0].logical_id as string
  const inventedHandle = 'f'.repeat(32)
  assert.notEqual(request.assets[logicalId], inventedHandle)
  request.assets[logicalId] = inventedHandle
  submission.sources.find((source: Record<string, any>) => source.logical_id === logicalId).gateway_asset_handle = inventedHandle
  const changedRequest = Buffer.from(JSON.stringify(request), 'utf8')
  const changedSubmission = Buffer.from(JSON.stringify({
    ...submission,
    request_body_sha256: sha256(changedRequest),
    request_body_bytes: changedRequest.byteLength,
  }), 'utf8')
  await fs.rename(requestPath, `${requestPath}.retained-r2-real-handle`)
  await fs.rename(submissionPath, `${submissionPath}.retained-r2-real-handle`)
  await fs.writeFile(requestPath, changedRequest, { flag: 'wx', mode: 0o600 })
  await fs.writeFile(submissionPath, changedSubmission, { flag: 'wx', mode: 0o600 })
  const inventedValues = (await revisions(invented)).map(item => {
    const value = structuredClone(item.value)
    if (value.event === 'request_sealed') {
      value.payload.after.request_body_sha256 = sha256(changedRequest)
      value.payload.after.request_body_bytes = changedRequest.byteLength
    }
    return value
  })
  const inventedChain = await replaceRevisionChain(invented, 'invented-handle', inventedValues)
  const inventedSeal = inventedChain.find(item => item.value.event === 'request_sealed')!
  const inventedProposed = {
    ...inventedSeal.value.payload.after,
    transport_revision_sha256: sha256(inventedSeal.bytes),
  }
  const inventedBefore = await canonicalReceipt(invented)
  let inventedRejected = false
  try {
    await requireCommitTransition()(
      invented.job.project_slug, invented.job.job_id, inventedBefore, inventedProposed,
    )
  } catch { inventedRejected = true }
  outcomes.push({
    label: 'invented handle', rejected: inventedRejected,
    before: inventedBefore, after: await canonicalReceipt(invented),
  })

  for (const outcome of outcomes) {
    assert.equal(outcome.rejected, true, `${outcome.label} is rejected by the independent queue CAS`)
    assert.deepEqual(outcome.after, outcome.before, `${outcome.label} cannot mutate canonical disk bytes`)
  }
})

test('pure reconciliation proof requires a later owner and preserves the exact repeat obligation', async () => {
  async function linkedStartCase(label: string): Promise<{
    prepared: Prepared
    values: Array<Record<string, any>>
    originalPut: Record<string, any>
    linkedIntent: Record<string, any>
    linkedObservation: Record<string, any>
    successorOwner: Record<string, any>
  }> {
    const prepared = await prepareCase(label, { duplicateLargeSources: true })
    gateway.lostPut = 'before-commit-once'
    await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /PUT|uncertain|render/i)
    const first = await revisions(prepared)
    const originalPut = first.find(item => item.value.event === 'blob_put_intent')!.value
    const source = prepared.manifest.sources.find(
      (item: Record<string, any>) => item.logical_id === originalPut.payload.logical_id,
    )
    const sourcePath = path.join(prepared.intentDir, source.safe_name)
    const retainedOriginal = `${sourcePath}.retained-r2-repeat-original`
    const retainedChanged = `${sourcePath}.retained-r2-repeat-changed`
    let replaced = false
    gateway.lostPut = 'none'
    gateway.beforeCall = async call => {
      if (replaced || call.method !== 'GET' || !call.url.includes('/blobs/')) return
      replaced = true
      await fs.rename(sourcePath, retainedOriginal)
      await fs.writeFile(sourcePath, Buffer.alloc(source.size_bytes, 0x41), { mode: 0o600 })
    }
    try {
      await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
        /source|identity|changed|render|recovery/i)
      assert.equal(replaced, true)
    } finally {
      gateway.beforeCall = undefined
      await fs.rename(sourcePath, retainedChanged)
      await fs.rename(retainedOriginal, sourcePath)
    }
    const values = (await revisions(prepared)).map(item => item.value)
    const linkedIntent = values.find(value => (
      value.event === 'blob_status_intent' && value.payload.reconciles_hop_id === originalPut.payload.hop_id
    ))!
    const linkedObservation = values.find(value => (
      value.event === 'blob_status_observed' && value.payload.hop_id === linkedIntent.payload.hop_id
    ))!
    const successorOwner = values.filter(value => value.event === 'owner_acquired').at(-1)!
    assert.equal(linkedObservation.payload.response.offset, originalPut.payload.offset)
    return { prepared, values, originalPut, linkedIntent, linkedObservation, successorOwner }
  }

  const sameOwner = await linkedStartCase('r2-same-owner-link')
  const sameOwnerValues = sameOwner.values
    .filter(value => value.sequence <= sameOwner.linkedObservation.sequence
      && value.sequence !== sameOwner.successorOwner.sequence)
    .map(value => {
      const changed = structuredClone(value)
      if (changed.sequence === sameOwner.linkedIntent.sequence
        || changed.sequence === sameOwner.linkedObservation.sequence) {
        changed.owner_token = sameOwner.originalPut.owner_token
        changed.owner_epoch = sameOwner.originalPut.owner_epoch
      }
      return changed
    })
  const sameOwnerRejected = await pureEvidenceRejects(sameOwner.prepared, sameOwnerValues)

  const changedRepeat = await linkedStartCase('r2-changed-repeat')
  const changedValues = changedRepeat.values
    .filter(value => value.sequence <= changedRepeat.linkedObservation.sequence)
    .map(value => structuredClone(value))
  const nextOwnerEpoch = changedRepeat.successorOwner.owner_epoch + 1
  const nextOwnerToken = '99999999-9999-4999-8999-999999999999'
  changedValues.push({
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(changedRepeat.prepared.receipt)),
    event: 'owner_acquired', recorded_at: '2026-10-15T00:00:20.000Z',
    owner_token: nextOwnerToken, owner_epoch: nextOwnerEpoch,
    payload: {
      lineage: structuredClone(changedRepeat.successorOwner.payload.lineage),
      previous_owner_epoch: changedRepeat.successorOwner.owner_epoch,
      owner_epoch: nextOwnerEpoch,
    },
  }, {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(changedRepeat.prepared.receipt)),
    event: 'blob_put_intent', recorded_at: '2026-10-15T00:00:21.000Z',
    owner_token: nextOwnerToken, owner_epoch: nextOwnerEpoch,
    payload: {
      ...structuredClone(changedRepeat.originalPut.payload),
      hop_id: 'e'.repeat(32),
      chunk_sha256: 'f'.repeat(64),
    },
  })
  const changedRepeatRejected = await pureEvidenceRejects(changedRepeat.prepared, changedValues)

  assert.equal(sameOwnerRejected, true,
    'a same-owner status observation cannot reconcile its own uncertain PUT')
  assert.equal(changedRepeatRejected, true,
    'an offset-at-start observation retains the exact range and chunk digest across another reopen')
})

test('distinct second-source uncertain PUT resumes after status-only confirmation of the first source', async () => {
  const prepared = await prepareCase('r3-distinct-second-source')
  const packetSources = prepared.manifest.packet.manifest as Array<Record<string, any>>
  assert.equal(packetSources.length, 2)
  const [first, second] = packetSources
  assert.notEqual(first.sha256, second.sha256, 'the recovery fixture uses two distinct source blobs')

  let armedSecond = false
  gateway.beforeCall = call => {
    if (call.method !== 'PUT' || !call.url.includes(`/blobs/${second.sha256}`)) return
    armedSecond = true
    gateway.lostPut = 'before-commit-once'
  }
  try {
    await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
      /PUT|uncertain|render/i)
  } finally {
    gateway.beforeCall = undefined
  }
  assert.equal(armedSecond, true, 'the controlled unknown response belongs to the second source PUT')
  assert.equal(gateway.blobs.get(first.sha256)?.offset, first.size_bytes,
    'the first source is already complete before the second source outcome becomes unknown')
  assert.equal(gateway.blobs.get(second.sha256)?.offset, 0,
    'the unknown second-source PUT committed no remote bytes')
  const originalSecondPut = gateway.calls.find(call => (
    call.method === 'PUT' && call.url.includes(`/blobs/${second.sha256}`)
  ))!
  assert.ok(originalSecondPut)

  gateway.resetCalls()
  gateway.lostPut = 'none'
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)

  const firstReopenCalls = gateway.calls.filter(call => call.url.includes(`/blobs/${first.sha256}`))
  assert.deepEqual(firstReopenCalls.map(call => call.method), ['GET'],
    'a preceding complete source is confirmed in fixed order without another PUT')
  const secondReopenCalls = gateway.calls.filter(call => call.url.includes(`/blobs/${second.sha256}`))
  assert.deepEqual(secondReopenCalls.map(call => call.method), ['GET', 'PUT'],
    'the reopen reaches the exact second-source recovery after the status-only predecessor')
  assert.deepEqual(secondReopenCalls[1].body, originalSecondPut.body)
  assert.equal(secondReopenCalls[1].headers.get('Content-Range'), originalSecondPut.headers.get('Content-Range'))
  const secondPutRevisions = (await revisions(prepared)).filter(item => (
    item.value.event === 'blob_put_intent' && item.value.payload.asset_sha256 === second.sha256
  ))
  assert.equal(secondPutRevisions.length, 2)
  assert.deepEqual({
    offset: secondPutRevisions[1].value.payload.offset,
    length: secondPutRevisions[1].value.payload.length,
    chunk_sha256: secondPutRevisions[1].value.payload.chunk_sha256,
  }, {
    offset: secondPutRevisions[0].value.payload.offset,
    length: secondPutRevisions[0].value.payload.length,
    chunk_sha256: secondPutRevisions[0].value.payload.chunk_sha256,
  }, 'the second source repeats its exact retained range and digest')
  await assertExactV3(prepared, { phase: 'remote_wait', revision: 4, gateway_job_id: GATEWAY_JOB_ID })
})

test('pure chain refuses unresolved B when reconciliation of A creates an exact-repeat obligation', async () => {
  const prepared = await prepareCase('r3-dual-put-obligation')
  gateway.lostPut = 'before-commit-once'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
    /PUT|uncertain|render/i)
  const prefix = (await revisions(prepared)).map(item => item.value)
  const putA = prefix.find(value => value.event === 'blob_put_intent')!
  const ownerA = prefix.find(value => value.event === 'owner_acquired')!
  assert.equal(putA.payload.offset, 0)
  const sourceB = prepared.manifest.sources.find(
    (source: Record<string, any>) => source.logical_id !== putA.payload.logical_id,
  )!
  assert.ok(sourceB)
  const sourceBBytes = await fs.readFile(path.join(prepared.intentDir, sourceB.safe_name))
  assert.equal(sourceBBytes.byteLength, sourceB.size_bytes)
  const ownerBToken = '99999999-9999-4999-8999-999999999999'
  const ownerB = {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(prepared.receipt)),
    event: 'owner_acquired', recorded_at: '2026-10-15T00:00:30.000Z',
    owner_token: ownerBToken, owner_epoch: ownerA.owner_epoch + 1,
    payload: {
      lineage: structuredClone(ownerA.payload.lineage),
      previous_owner_epoch: ownerA.owner_epoch,
      owner_epoch: ownerA.owner_epoch + 1,
    },
  }
  const reconcileHop = 'c'.repeat(32)
  const reconcileA = {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(prepared.receipt)),
    event: 'blob_status_intent', recorded_at: '2026-10-15T00:00:31.000Z',
    owner_token: ownerBToken, owner_epoch: ownerA.owner_epoch + 1,
    payload: {
      hop_id: reconcileHop, logical_id: putA.payload.logical_id, safe_name: putA.payload.safe_name,
      asset_sha256: putA.payload.asset_sha256, size_bytes: putA.payload.size_bytes,
      offset: putA.payload.offset, length: 0, reconciles_hop_id: putA.payload.hop_id,
    },
  }
  const observeAStart = {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(prepared.receipt)),
    event: 'blob_status_observed', recorded_at: '2026-10-15T00:00:32.000Z',
    owner_token: ownerBToken, owner_epoch: ownerA.owner_epoch + 1,
    payload: {
      hop_id: reconcileHop,
      response: {
        format: 'studio.render.gateway-blob.v1', sha256: putA.payload.asset_sha256,
        size_bytes: putA.payload.size_bytes, state: 'missing', offset: putA.payload.offset,
      },
    },
  }
  const manifestBytes = await fs.readFile(path.join(prepared.intentDir, 'manifest.json'))
  const input = (values: Array<Record<string, any>>) => ({
    staged: prepared.receipt as Parameters<EvidenceModule['validateFinalRenderTransportEvidence']>[0]['staged'],
    canonical: prepared.receipt as Parameters<EvidenceModule['validateFinalRenderTransportEvidence']>[0]['canonical'],
    manifestBytes,
    revisions: encodeRevisionValues(values),
  })
  const validSingle = evidence.validateFinalRenderTransportEvidence(
    input([...prefix, ownerB, reconcileA, observeAStart]),
  )
  assert.equal(validSingle.repeatPut?.payload.hop_id, putA.payload.hop_id,
    'the otherwise-valid prefix retains A as the sole exact-repeat obligation')
  assert.equal(validSingle.unresolvedPut, null)

  const statusBHop = 'a'.repeat(32)
  const statusB = {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(prepared.receipt)),
    event: 'blob_status_intent', recorded_at: '2026-10-15T00:00:27.000Z',
    owner_token: ownerA.owner_token, owner_epoch: ownerA.owner_epoch,
    payload: {
      hop_id: statusBHop, logical_id: sourceB.logical_id, safe_name: sourceB.safe_name,
      asset_sha256: sourceB.sha256, size_bytes: sourceB.size_bytes,
      offset: 0, length: 0, reconciles_hop_id: null,
    },
  }
  const observeBMissing = {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(prepared.receipt)),
    event: 'blob_status_observed', recorded_at: '2026-10-15T00:00:28.000Z',
    owner_token: ownerA.owner_token, owner_epoch: ownerA.owner_epoch,
    payload: {
      hop_id: statusBHop,
      response: {
        format: 'studio.render.gateway-blob.v1', sha256: sourceB.sha256,
        size_bytes: sourceB.size_bytes, state: 'missing', offset: 0,
      },
    },
  }
  const putB = {
    version: 1, sequence: 0, previous_sha256: null,
    canonical_before_sha256: sha256(JSON.stringify(prepared.receipt)),
    event: 'blob_put_intent', recorded_at: '2026-10-15T00:00:29.000Z',
    owner_token: ownerA.owner_token, owner_epoch: ownerA.owner_epoch,
    payload: {
      hop_id: 'b'.repeat(32), logical_id: sourceB.logical_id, safe_name: sourceB.safe_name,
      asset_sha256: sourceB.sha256, size_bytes: sourceB.size_bytes,
      offset: 0, length: sourceB.size_bytes, chunk_sha256: sha256(sourceBBytes),
    },
  }
  assert.throws(() => evidence.validateFinalRenderTransportEvidence(
    input([...prefix, statusB, observeBMissing, putB, ownerB, reconcileA, observeAStart]),
  ), /evidence|PUT|unresolved|obligation|reconciliation/i,
  'the exact prefix cannot return repeat A alongside unresolved B')
})

test('uncertain PUT reconciliation closes once and a later reopen repeats only the exact retained range', async () => {
  const prepared = await prepareCase('r1-uncertain-reopen', { duplicateLargeSources: true })
  gateway.lostPut = 'before-commit-once'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /PUT|uncertain|render/i)
  const firstChain = await revisions(prepared)
  const originalPut = firstChain.find(item => item.value.event === 'blob_put_intent')!
  assert.ok(originalPut)
  const source = prepared.manifest.sources.find((item: any) => item.logical_id === originalPut.value.payload.logical_id)!
  const sourcePath = path.join(prepared.intentDir, source.safe_name)
  const retainedOriginal = `${sourcePath}.retained-original-r1-reconcile`
  const retainedChanged = `${sourcePath}.retained-changed-r1-reconcile`
  let replaced = false
  gateway.lostPut = 'none'
  gateway.beforeCall = async call => {
    if (replaced || call.method !== 'GET' || !call.url.includes('/blobs/')) return
    replaced = true
    await fs.rename(sourcePath, retainedOriginal)
    await fs.writeFile(sourcePath, Buffer.alloc(source.size_bytes, 0x31), { mode: 0o600 })
  }
  const putsBeforeRefusal = gateway.calls.filter(call => call.method === 'PUT').length
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /source|identity|changed|render|recovery/i)
  assert.equal(gateway.calls.filter(call => call.method === 'PUT').length, putsBeforeRefusal,
    'the linked reconciliation status is durable before changed local bytes can trigger a PUT')
  const linkedChain = await revisions(prepared)
  const linkedIntent = linkedChain.find(item => (
    item.value.event === 'blob_status_intent'
      && item.value.payload.reconciles_hop_id === originalPut.value.payload.hop_id
  ))!
  const linkedObservation = linkedChain.find(item => (
    item.value.event === 'blob_status_observed'
      && item.value.payload.hop_id === linkedIntent.value.payload.hop_id
  ))!
  assert.equal(linkedIntent.value.owner_epoch, originalPut.value.owner_epoch + 1)
  assert.notEqual(linkedIntent.value.owner_token, originalPut.value.owner_token)
  assert.equal(linkedObservation.value.owner_epoch, linkedIntent.value.owner_epoch)
  assert.equal(linkedObservation.value.owner_token, linkedIntent.value.owner_token)
  assert.deepEqual(Object.keys(linkedObservation.value.payload.response), [
    'format', 'sha256', 'size_bytes', 'state', 'offset',
  ], 'the exact missing-blob response closes the cross-owner reconciliation link')
  await fs.rename(sourcePath, retainedChanged)
  await fs.rename(retainedOriginal, sourcePath)
  gateway.beforeCall = undefined
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const finalChain = await revisions(prepared)
  const reconciliationLinks = finalChain.filter(item => (
    item.value.event === 'blob_status_intent'
      && item.value.payload.reconciles_hop_id === originalPut.value.payload.hop_id
  ))
  assert.equal(reconciliationLinks.length, 1,
    'a linked observed status durably resolves the predecessor and is not reinterpreted on another owner')
  const repeatedPut = finalChain.filter(item => item.value.event === 'blob_put_intent')
    .find(item => item.value.sequence > reconciliationLinks[0].value.sequence)!
  assert.deepEqual({
    asset_sha256: repeatedPut.value.payload.asset_sha256,
    size_bytes: repeatedPut.value.payload.size_bytes,
    offset: repeatedPut.value.payload.offset,
    length: repeatedPut.value.payload.length,
    chunk_sha256: repeatedPut.value.payload.chunk_sha256,
  }, {
    asset_sha256: originalPut.value.payload.asset_sha256,
    size_bytes: originalPut.value.payload.size_bytes,
    offset: originalPut.value.payload.offset,
    length: originalPut.value.payload.length,
    chunk_sha256: originalPut.value.payload.chunk_sha256,
  }, 'offset-at-start recovery repeats the exact retained range and digest')
})

test('staged source replacement after status validation emits zero PUT bytes', async () => {
  const prepared = await prepareCase('r1-source-replacement')
  const firstPacketSource = prepared.manifest.packet.manifest[0]
  const source = prepared.manifest.sources.find((candidate: Record<string, any>) => (
    candidate.logical_id === firstPacketSource.logical_id
  ))
  assert.ok(source, 'the first packet source is present in the retained staging manifest')
  const sourcePath = path.join(prepared.intentDir, source.safe_name)
  const retainedOriginal = `${sourcePath}.retained-original-r1-source`
  let replaced = false
  gateway.beforeCall = async call => {
    if (replaced || call.method !== 'GET' || !call.url.includes('/blobs/')) return
    replaced = true
    await fs.rename(sourcePath, retainedOriginal)
    await fs.writeFile(sourcePath, Buffer.alloc(source.size_bytes, 0x52), { mode: 0o600 })
  }
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
    /source|identity|changed|render|recovery/i)
  assert.equal(replaced, true)
  assert.equal(gateway.calls.some(call => call.method === 'PUT'), false,
    'a path replacement after status read is refused before the first mutating upload')
  assert.equal(gateway.calls.some(call => call.method === 'POST'), false)
})

test('V3 cancellation replays the first instant and reports it truthfully from recovery hold', async () => {
  const prepared = await prepareCase('r1-v3-cancel')
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const accepted = await canonicalReceipt(prepared)
  assert.equal(accepted.version, 3)
  assert.equal(accepted.phase, 'remote_wait')
  gateway.resetCalls()
  const cancelled = await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  const cancelledReceipt = cancelled.final_render_remote_wait as any
  const replay = await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  const replayReceipt = replay.final_render_remote_wait as any
  assert.equal(cancelledReceipt.revision, accepted.revision + 1)
  assert.equal(cancelledReceipt.phase, accepted.phase)
  assert.equal(cancelledReceipt.transport_revision_sha256, accepted.transport_revision_sha256)
  assert.ok(cancelledReceipt.cancel_requested_at)
  for (const key of V3_KEYS) {
    if (key === 'revision' || key === 'cancel_requested_at') continue
    assert.deepEqual(cancelledReceipt[key], accepted[key], `${key} is immutable across the cancellation overlay`)
  }
  assert.equal(replayReceipt.cancel_requested_at, cancelledReceipt.cancel_requested_at)
  assert.equal(replayReceipt.revision, cancelledReceipt.revision)
  const publicJob = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0] as any
  assert.equal(publicJob.final_render_wait?.state, 'recovery_hold')
  assert.equal(publicJob.final_render_wait?.cancellation_requested, true)
  assert.equal(publicJob.final_render_wait?.committed_at, accepted.committed_at)
  assert.equal(JSON.stringify(publicJob).includes('transport_revision_sha256'), false)
  assert.equal(gateway.calls.length, 0, 'this slice records cancellation locally without a remote call')
})

test('executor fence settlement cannot replace another project sharing the short job id', async t => {
  const entered = deferred()
  const release = deferred()
  const restoreExecutor = queue._setExecutorForTesting('video_assembly', async job => {
    job.status = 'error'
    entered.resolve()
    await release.promise
    return { kind: 'video-assembly-remote-wait' }
  })
  let runningJobId = ''
  t.after(async () => {
    release.resolve()
    try {
      for (let turn = 0; turn < 2_000 && runningJobId && queue._isJobWorkerActiveForTesting(runningJobId); turn++) {
        await new Promise<void>(resolve => setTimeout(resolve, 2))
      }
      const settled = !runningJobId || !queue._isJobWorkerActiveForTesting(runningJobId)
      if (settled) await queue._waitForJobPersistenceForTesting()
      assert.equal(settled, true, 'the controlled Project A worker settles before fixture teardown')
    } finally {
      restoreExecutor()
    }
  })
  const projectA = `r1-fence-a-${process.pid}-${++serial}`
  const running = queue.enqueuePreparedForTest({
    project_slug: projectA, type: 'video_assembly', episode_id: 'EP1-A',
    title: 'Project A unwinding fence', params: {},
  })
  runningJobId = running.job_id
  trackedJobIds.add(running.job_id)
  await entered.promise
  const collision = await prepareCase('r1-fence-b', { jobId: running.job_id })
  assert.equal(queue.removeTerminalJob(projectA, running.job_id), true)
  await queue._waitForJobPersistenceForTesting()
  const loaded = await queue.getJobs(collision.job.project_slug, { view: 'full' })
  assert.equal(loaded[0]?.final_render_wait?.state, 'intent_staged')
  assert.equal(queue.getJob(running.job_id)?.project_slug, collision.job.project_slug)
  release.resolve()
  for (let turn = 0; turn < 2_000 && queue._isJobWorkerActiveForTesting(running.job_id); turn++) {
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  assert.equal(queue._isJobWorkerActiveForTesting(running.job_id), false)
  await queue._waitForJobPersistenceForTesting()
  assert.equal(queue.getJob(running.job_id)?.project_slug, collision.job.project_slug,
    'the older project worker cannot Object.assign or jobs.set over the current project owner')
})

test('reconciled fresh send CAS acquires the current owner before its one POST', async t => {
  const prepared = await prepareCase('r1-current-owner-before-post')
  let refused = false
  const restore = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || refused) return
    const current = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', prepared.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]?.final_render_remote_wait
    if (current?.version === 3 && current.phase === 'request_persisted') {
      refused = true
      throw new Error('controlled current-owner send-CAS refusal')
    }
  })
  t.after(restore)
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id),
    /controlled current-owner send-CAS refusal/)
  restore()
  const predecessorOwner = (await revisions(prepared)).filter(item => item.value.event === 'owner_acquired').at(-1)!
  const requestPersisted = await canonicalReceipt(prepared)
  assert.equal(requestPersisted.phase, 'request_persisted')
  gateway.beforeCall = async call => {
    if (call.method !== 'POST') return
    const current = await canonicalReceipt(prepared)
    assert.equal(current.phase, 'send_may_start')
    const currentOwner = (await revisions(prepared)).at(-1)!
    assert.equal(currentOwner.value.event, 'owner_acquired')
    assert.equal(currentOwner.value.owner_epoch, predecessorOwner.value.owner_epoch + 1)
    assert.notEqual(currentOwner.value.owner_token, predecessorOwner.value.owner_token)
    assert.equal(currentOwner.value.canonical_before_sha256, sha256(JSON.stringify(current)))
  }
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
  await assertExactV3(prepared, { phase: 'remote_wait', revision: 4, gateway_job_id: GATEWAY_JOB_ID })
})


async function validatedChain(prepared: Prepared, values?: Array<Record<string, any>>) {
  return evidence.validateFinalRenderTransportEvidence({
    staged: prepared.receipt as any,
    canonical: (values ? prepared.receipt : await canonicalReceipt(prepared)) as any,
    manifestBytes: await fs.readFile(path.join(prepared.intentDir, 'manifest.json')),
    requestBytes: await requestBytes(prepared),
    submissionBytes: await fs.readFile(path.join(prepared.intentDir, 'transport', 'submission.json')),
    revisions: values ? encodeRevisionValues(values) : (await revisions(prepared)).map(item => ({
      name: path.basename(item.path), bytes: item.bytes,
    })),
  })
}

for (const [status, code] of [
  [400, 'IDEMPOTENCY_KEY_INVALID'], [400, 'RENDER_REQUEST_INVALID'], [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'], [404, 'RENDER_ASSET_NOT_FOUND'], [413, 'RENDER_REQUEST_INVALID'],
  [422, 'RENDER_REQUEST_INVALID'], [422, 'IDEMPOTENCY_KEY_REQUIRED'],
] as const) {
  test(`definite create refusal ${status}/${code} durably rejoins the same local job without another send`, async () => {
    const prepared = await prepareCase(`refused-${status}-${code}`)
    gateway.postError = { status, code }
    assert.deepEqual(await requireAdvance()(prepared.job.project_slug, prepared.job.job_id), { kind: 'video-assembly-local' })
    assert.equal((await canonicalReceipt(prepared)).phase, 'refused')
    const chain = await validatedChain(prepared)
    const refusal = chain.records.find(item => item.value.event === 'post_refused')!
    assert.equal(refusal.value.payload.status, status)
    assert.equal(refusal.value.payload.code, code)
    assert.equal(gateway.acceptedBody, null)
    await queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id)
    const local = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
    assert.equal(local?.job_id, prepared.job.job_id)
    assert.equal(local?.status, 'queued')
    assert.equal(local?.output_lines.filter(line => line ===
      `Private final render: the paired Gateway refused this render (${code}), so this video renders on this Mac.`).length, 1)
    await settings.setPrivateFinalRenderSetting({ enabled: false })
    assert.equal(await transport.preparePrivateFinalRenderDescriptor(prepared.composition), null,
      'durable refusal grants ordinary local composition even after remote is switched off')
    await queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id)
    assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(gateway.calls.filter(call => call.method === 'GET' && call.url.includes('by-idempotency-key')).length, 0)
  })
}

for (const [status, code] of [
  [500, 'INTERNAL_ERROR'], [503, 'RENDER_DESTINATION_UNAVAILABLE'], [409, 'IDEMPOTENCY_KEY_CONFLICT'],
  [408, 'RENDER_REQUEST_INVALID'], [425, 'RENDER_REQUEST_INVALID'], [429, 'RENDER_REQUEST_INVALID'],
  [422, 'UNRECOGNISED_CODE'], [403, 'RENDER_REQUEST_INVALID'],
] as const) {
  test(`ambiguous create ${status}/${code} keeps original-key lookup and never resends`, async () => {
    const prepared = await prepareCase(`ambiguous-${status}-${code}`)
    gateway.postError = { status, code }
    await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /unknown POST outcome/)
    assert.equal((await canonicalReceipt(prepared)).phase, 'send_unknown')
    assert.equal((await validatedChain(prepared)).records.find(item => item.value.event === 'post_unknown')?.value.payload.failure_class, 'http')
    gateway.lookupMode = 'not-found'
    await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
    assert.equal((await canonicalReceipt(prepared)).phase, 'lookup_not_found')
    assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
  })
}

test('two authoritative 404s ten minutes apart after an HTTP failure recover locally; closer reads do not', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const prepared = await prepareCase('old-http-absent')
  gateway.postError = { status: 503, code: 'RENDER_DESTINATION_UNAVAILABLE' }
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /unknown POST/)
  gateway.lookupMode = 'not-found'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
  t.mock.timers.tick(evidence.FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS - 1)
  await transport.reconcileSealedPrivateFinalRenderOnce(prepared.job.project_slug, prepared.job.job_id)
  assert.equal((await canonicalReceipt(prepared)).phase, 'lookup_not_found')
  t.mock.timers.tick(1)
  await transport.reconcileSealedPrivateFinalRenderOnce(prepared.job.project_slug, prepared.job.job_id)
  assert.equal((await canonicalReceipt(prepared)).phase, 'refused')
  await validatedChain(prepared)
  const tooClose = (await revisions(prepared)).map(item => structuredClone(item.value))
  const firstAbsence = tooClose.find(item => item.event === 'lookup_not_found')!
  tooClose.find(item => item.event === 'lookup_refused')!.recorded_at =
    new Date(Date.parse(firstAbsence.recorded_at) + evidence.FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS - 1).toISOString()
  await assert.rejects(validatedChain(prepared, tooClose), /lookup refusal proof/)
  await queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id)
  const local = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(local?.status, 'queued')
  assert.ok(local?.output_lines.some(line => line.includes('Gateway never accepted this render, so this video renders on this Mac.')))
  gateway.lookupMode = 'accepted'
  const calls = gateway.calls.length
  await transport.reconcileSealedPrivateFinalRenderOnce(prepared.job.project_slug, prepared.job.job_id).catch(() => undefined)
  assert.equal(gateway.calls.length, calls, 'late remote acceptance cannot reactivate a refused lineage')
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
})

test('network uncertainty remains held after repeated spaced absence, never local and never resent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const prepared = await prepareCase('network-absent')
  gateway.postMode = 'throw-after-record'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /unknown POST/)
  gateway.lookupMode = 'not-found'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
  t.mock.timers.tick(2 * evidence.FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS)
  await transport.reconcileSealedPrivateFinalRenderOnce(prepared.job.project_slug, prepared.job.job_id)
  assert.equal((await canonicalReceipt(prepared)).phase, 'lookup_not_found')
  await assert.rejects(queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id))
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
})

test('refusal validator and independent queue CAS reject missing proof, ambiguous status, and illegal reactivation', async () => {
  const prepared = await prepareCase('refusal-illegal')
  gateway.postError = { status: 422, code: 'RENDER_REQUEST_INVALID' }
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const original = (await revisions(prepared)).map(item => item.value)
  await validatedChain(prepared)
  assert.ok(original.some(item => item.event === 'post_refused'))
  for (const change of [
    (value: any) => { value.payload.status = 409 },
    (value: any) => { value.payload.code = 'UNKNOWN' },
    (value: any) => { value.event = 'lookup_refused' },
    (value: any) => { value.payload.after.phase = 'remote_wait'; value.payload.after.gateway_job_id = GATEWAY_JOB_ID },
    (value: any) => { value.payload.after.gateway_job_id = GATEWAY_JOB_ID },
  ]) {
    const altered = structuredClone(original)
    change(altered.find(item => item.event === 'post_refused'))
    await assert.rejects(validatedChain(prepared, altered), /evidence/)
  }
  const before = await canonicalReceipt(prepared)
  for (const phase of ['send_may_start', 'send_unknown', 'remote_wait', 'lookup_not_found', 'recovery_hold']) {
    await assert.rejects(requireCommitTransition()(prepared.job.project_slug, prepared.job.job_id, before, {
      ...before, phase, revision: before.revision + 1, gateway_job_id: phase === 'remote_wait' ? GATEWAY_JOB_ID : null,
    }))
  }
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
})

test('durable ID-null parked recovery holds allow updater drain; invalid or unreadable receipts still block', async () => {
  const prepared = await prepareCase('drain-parked')
  gateway.postMode = 'throw-after-record'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
  gateway.lookupMode = 'not-found'
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
  await queue.getJobs(prepared.job.project_slug, { view: 'full' })
  const marker = await canonicalReceipt(prepared)
  // A rejected exact CAS sets the in-process recovery hold without changing the durable parked row.
  await assert.rejects(requireCommitTransition()(prepared.job.project_slug, prepared.job.job_id,
    { ...marker, revision: marker.revision + 10 }, { ...marker, phase: 'recovery_hold', revision: marker.revision + 11 }))
  assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(prepared.job.job_id), true)
  assert.equal((await queue.runningJobsThatWouldNotResume()).some(job => job.job_id === prepared.job.job_id), false)
  const disk = (await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))!
  const file = path.join(retainedRoot, 'projects', prepared.job.project_slug, 'jobs.json')
  for (const value of [{ ...disk, final_render_remote_wait: { broken: true } }, null]) {
    await fs.writeFile(file, value === null ? 'unreadable JSON' : JSON.stringify({ jobs: [value] }))
    assert.equal((await queue.runningJobsThatWouldNotResume()).some(job => job.job_id === prepared.job.job_id), true)
  }
  await fs.writeFile(file, JSON.stringify({ jobs: [{ ...disk, final_render_remote_wait: { ...marker, phase: 'recovery_hold' } }] }))
  assert.equal((await queue.runningJobsThatWouldNotResume()).some(job => job.job_id === prepared.job.job_id), false)
  await fs.writeFile(file, JSON.stringify({ jobs: [disk] }))
})

test('local fallback publication preserves an accepted final and the new candidate', async () => {
  const { _publishLocalFinalVideoForTesting } = await import('../generators/video.js')
  const prepared = await prepareCase('local-preserves-final')
  gateway.postError = { status: 422, code: 'RENDER_REQUEST_INVALID' }
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const job = (await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))!
  const final = path.join(prepared.composition.videoDir, 'EP1_final_video.mp4')
  const candidate = path.join(prepared.composition.videoDir, 'candidate.mp4')
  await fs.writeFile(final, 'accepted final')
  await fs.writeFile(candidate, 'new candidate')
  let mutations = 0
  await assert.rejects(_publishLocalFinalVideoForTesting(job, candidate, final, async () => {
    mutations++
    await fs.rename(candidate, final)
  }), /preserved the accepted final/)
  assert.equal(mutations, 0)
  assert.equal(await fs.readFile(final, 'utf8'), 'accepted final')
  assert.equal(await fs.readFile(candidate, 'utf8'), 'new candidate')
})


test('refusal before canonical CAS recovers its one immutable transition without another POST', async t => {
  const prepared = await prepareCase('refused-cas-crash')
  gateway.postError = { status: 422, code: 'RENDER_REQUEST_INVALID' }
  let injected = false
  const restore = queue._setJobFileLockProbeForTesting(async operation => {
    if (operation !== 'persist' || injected) return
    // Read the file directly: the queue's own loader waits on the lock this probe runs inside.
    const disk = JSON.parse(await fs.readFile(
      path.join(retainedRoot, 'projects', prepared.job.project_slug, 'jobs.json'), 'utf8',
    )).jobs[0]
    if (disk?.final_render_remote_wait?.phase === 'send_may_start') {
      injected = true
      throw new Error('controlled refusal CAS interruption')
    }
  })
  t.after(restore)
  await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id), /controlled refusal CAS interruption/)
  restore()
  assert.equal(injected, true)
  assert.equal((await canonicalReceipt(prepared)).phase, 'send_may_start')
  assert.deepEqual(await requireAdvance()(prepared.job.project_slug, prepared.job.job_id), { kind: 'video-assembly-local' })
  assert.equal((await canonicalReceipt(prepared)).phase, 'refused')
  assert.equal((await revisions(prepared)).filter(item => item.value.event === 'post_refused').length, 1)
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
})


test('a refused job runs the real local encoder and shared final checks without another remote request', async () => {
  const prepared = await prepareCase('real-local-after-refusal')
  gateway.postError = { status: 422, code: 'RENDER_REQUEST_INVALID' }
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  await queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id)
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  const { _runFinalCompositionForTesting, _publishLocalFinalVideoForTesting, verifyImportedFinalVideo } =
    await import('../generators/video.js')
  // Real disposable media replaces the filler live inputs; the refused immutable intent stays intact.
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=5', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', prepared.composition.videoInputPath])
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
    '-c:a', 'pcm_s16le', prepared.composition.premixedAudioPath])
  const job = (await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))!
  const composition = { ...prepared.composition, job }
  const calls = gateway.calls.length
  assert.equal(await _runFinalCompositionForTesting(composition), undefined)
  assert.ok((await fs.stat(composition.outputFile)).size > 0)
  const final = path.join(composition.videoDir, 'EP1_final_video.mp4')
  await _publishLocalFinalVideoForTesting(job, composition.outputFile, final, async () => {
    assert.fail('fallback uses exclusive publication')
  })
  await verifyImportedFinalVideo(job, 'EP1', 'mp4', final, 2, {
    planned_sec: 2, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
    width: 128, height: 96, subtitles_path: null,
  }, { lufs: -14, true_peak_db: -1, tolerance_pct: 100, check: 'warn' })
  assert.equal(job.result?.complete, true)
  assert.ok(job.result?.final_check, 'shared final checks really ran')
  assert.ok(job.result?.final_loudness, 'shared loudness measurement really ran')
  assert.equal(gateway.calls.length, calls)
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
})



test('lookup refusal proof rejects network, missing first absence, insufficient gap, and cancellation', async () => {
  for (const kind of ['network', 'missing-absence', 'too-close', 'cancelled'] as const) {
    const prepared = await prepareCase(`bad-recovery-${kind}`)
    if (kind === 'network') gateway.postMode = 'throw-after-record'
    else gateway.postError = { status: 503, code: 'RENDER_DESTINATION_UNAVAILABLE' }
    await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
    gateway.lookupMode = 'not-found'
    if (kind !== 'missing-absence') await assert.rejects(requireAdvance()(prepared.job.project_slug, prepared.job.job_id))
    if (kind === 'cancelled') await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
    const current = await canonicalReceipt(prepared)
    const records = (await revisions(prepared)).map(item => item.value)
    const owner = records.filter(item => item.event === 'owner_acquired').at(-1)!
    const { transport_revision_sha256: _digest, ...after } = current
    records.push({
      version: 1, sequence: records.length + 1, previous_sha256: '',
      canonical_before_sha256: evidence.finalRenderCanonicalReceiptHash(current as any),
      event: 'lookup_refused', recorded_at: new Date(Date.now() + (kind === 'too-close' ? 0 : 2 * evidence.FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS)).toISOString(),
      owner_token: owner.owner_token, owner_epoch: owner.owner_epoch,
      payload: { after: { ...after, phase: 'refused', revision: current.revision + 1 }, status: 404, code: 'RENDER_NOT_FOUND' },
    })
    await assert.rejects(validatedChain(prepared, records), /refusal|transition|evidence/)
    assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('concurrent local handoffs execute each refused row once on its original job ID', async t => {
  const prepared = await prepareCase('local-single-execution')
  gateway.postError = { status: 422, code: 'RENDER_REQUEST_INVALID' }
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  const counts = new Map<string, number>()
  const entered = deferred()
  const release = deferred()
  const restore = queue._setExecutorForTesting('video_assembly', async job => {
    counts.set(job.job_id, (counts.get(job.job_id) ?? 0) + 1)
    if (job.job_id === prepared.job.job_id) {
      entered.resolve()
      await release.promise
    }
    job.result = { complete: true, completion: { label: 'controlled local fixture', expected: 1, completed: 1, complete: true } }
  })
  t.after(() => { release.resolve(); restore() })
  await queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id)
  await entered.promise
  await Promise.all([
    queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id),
    queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id),
  ])
  release.resolve()
  await settle()
  const done = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(done?.status, 'done')
  assert.equal(done?.final_render_remote_wait?.phase, 'refused', 'durable no-remote proof survives local completion')
  assert.equal(counts.get(prepared.job.job_id), 1)
  assert.ok([...counts.values()].every(count => count === 1))
  assert.equal(gateway.calls.filter(call => call.method === 'POST').length, 1)
})

// ── A refused render that finished locally survives a restart as done ───────
//
// 2026-10-25, Wonder-in-ink WI0005/7/8/9/10/11/12: eight remote renders the Gateway never
// accepted went local, seven rendered to completion, and after the next restart every one of
// them read `queued` with a complete result and was about to render the whole episode again.
// A refused row keeps its receipt as proof, so its local completion has no remote terminal
// digest to pin it; these tests pin the two boundaries that must decide from the row's own
// verified completion instead (AGENTS.md §8).

async function runRefusedRenderToCompletion(t: { after: (fn: () => void) => void }, label: string): Promise<{
  prepared: Prepared
  outputDir: string
  runs: () => number
}> {
  const prepared = await prepareCase(label)
  const outputDir = path.join(retainedRoot, 'work', prepared.job.project_slug, 'Exports')
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 })
  gateway.postError = { status: 422, code: 'RENDER_REQUEST_INVALID' }
  await requireAdvance()(prepared.job.project_slug, prepared.job.job_id)
  let runs = 0
  const restore = queue._setExecutorForTesting('video_assembly', async job => {
    runs += 1
    // The published final and the audited completion declaration the real final checks write.
    await fs.writeFile(path.join(outputDir, `${String(job.episode_id).toUpperCase()}_final_video.mp4`), 'verified final video')
    job.progress = 100
    job.output_dir = outputDir
    job.result = {
      complete: true,
      completion: { label: 'Final video assembly', expected: 1, completed: 1, complete: true },
      final_check: { passed: true, issues: [] },
      final_loudness: { lufs: -14, true_peak_db: -1 },
    }
  })
  t.after(restore)
  await queue.resumeRefusedFinalRenderLocally(prepared.job.project_slug, prepared.job.job_id)
  await settle()
  const done = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(done?.status, 'done', 'the controlled local render completed on its own row')
  assert.equal(done?.local_execution_complete, true)
  assert.equal(done?.final_render_remote_wait?.phase, 'refused', 'the refusal proof is kept')
  assert.equal(runs, 1)
  return { prepared, outputDir, runs: () => runs }
}

/** The exact shape jobs.json kept after the 2026-10-25 restart: resume's queued copy plus the finished result. */
function interruptedLocalCopy(done: Job): Job {
  return {
    ...structuredClone(done),
    status: 'queued',
    started_at: null,
    finished_at: null,
    local_execution_complete: false,
    error: null,
  }
}

test('a refused render that already finished locally is read as done on restart, never rendered again', async t => {
  const { prepared, runs } = await runRefusedRenderToCompletion(t, 'refused-restart-done')
  const done = (await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))!
  await writeJob(interruptedLocalCopy(done))
  // A real boot scan, not the persistence reset alone: drop every in-memory trace and reload.
  queue._restartProjectForTesting(prepared.job.project_slug)
  await queue.getJobs(prepared.job.project_slug, { view: 'full' })
  await settle()
  const reloaded = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(runs(), 1, 'the finished video is not rendered a second time')
  assert.equal(reloaded?.status, 'done', 'the completed local render is not put back in the lane')
  assert.equal(reloaded?.local_execution_complete, true)
  assert.equal(reloaded?.finished_at !== null, true)
  assert.equal(reloaded?.final_render_remote_wait?.phase, 'refused', 'the refusal proof still stands')
  assert.ok(reloaded?.output_lines.some(line => line.startsWith('✔ This video already finished on this Mac')),
    'the recovery is announced, not silent (AGENTS.md §4)')
  assert.equal(queue._isJobWorkerActiveForTesting(prepared.job.job_id), false)
})

test('a late non-terminal copy cannot reopen a refused row that finished locally', async t => {
  const { prepared, runs } = await runRefusedRenderToCompletion(t, 'refused-terminal-sticky')
  const slug = prepared.job.project_slug
  const jobId = prepared.job.job_id
  // Exactly what the recovery-hold merge and a stale project snapshot write: a non-terminal copy.
  await queue.mutateAuthoritativeJob(slug, jobId, job => ({
    ...job, status: 'running', finished_at: null, local_execution_complete: false,
  }))
  const sticky = await queue.loadAuthoritativeJob(slug, jobId)
  assert.equal(sticky?.status, 'done', 'a verified local completion is a terminal, not a status to overwrite')
  assert.equal(sticky?.local_execution_complete, true)
  // What final-render-reconciler.reconcileOne does for a refused receipt. On a done row it must do nothing.
  await queue.resumeRefusedFinalRenderLocally(slug, jobId)
  const after = await queue.loadAuthoritativeJob(slug, jobId)
  assert.equal(after?.status, 'done')
  assert.equal(after?.local_execution_complete, true)
  assert.equal(runs(), 1, 'no second render')
})

test('a refused row with an incomplete result still renders locally on restart', async t => {
  const { prepared, runs } = await runRefusedRenderToCompletion(t, 'refused-restart-incomplete')
  const done = (await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))!
  const interrupted = interruptedLocalCopy(done)
  interrupted.result = { ...done.result, complete: false }
  await writeJob(interrupted)
  queue._restartProjectForTesting(prepared.job.project_slug)
  await queue.getJobs(prepared.job.project_slug, { view: 'full' })
  await settle()
  assert.equal(runs(), 2, 'an unproven completion must keep its normal local recovery')
})

test('a refused row whose published final is missing still renders locally on restart', async t => {
  const { prepared, outputDir, runs } = await runRefusedRenderToCompletion(t, 'refused-restart-stale')
  const done = (await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))!
  await fs.rm(path.join(outputDir, `${String(done.episode_id).toUpperCase()}_final_video.mp4`))
  await writeJob(interruptedLocalCopy(done))
  queue._restartProjectForTesting(prepared.job.project_slug)
  await queue.getJobs(prepared.job.project_slug, { view: 'full' })
  await settle()
  assert.equal(runs(), 2, 'a completion declaration without its published file is not proof')
})
