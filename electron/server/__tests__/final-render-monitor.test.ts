import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import type { Job } from '../models/types.js'

type ReconcileIdentity = { project_slug: string; job_id: string }
type QueueModule = typeof import('../services/job-queue.js') & {
  listFinalRenderReconcileCandidates: (
    after: ReconcileIdentity | null,
    limit?: number,
  ) => ReconcileIdentity[]
}
type TransportModule = typeof import('../services/final-render-transport.js') & {
  reconcileSealedPrivateFinalRenderOnce: (projectSlug: string, jobId: string) => Promise<void>
}
type EvidenceModule = typeof import('../lib/final-render-transport-evidence.js')
type ReconcilerModule = {
  startFinalRenderReconciler: () => void
  runFinalRenderReconcilePassForTesting: (now?: number) => Promise<void>
  _resetFinalRenderReconcilerForTesting: () => Promise<void>
}
type SettingsModule = typeof import('../services/app-settings.js')
type IdentityModule = typeof import('../services/private-render-identity.js')
type WireCall = { method: string; url: string; body: Buffer; headers: Headers }
type BlobState = { sha256: string; size_bytes: number; offset: number }
type LookupMode =
  | 'pending'
  | 'not-found'
  | 'malformed'
  | 'foreign-story'
  | 'output-ready'
  | 'cancelled-terminal'
  | 'acknowledged'
  | 'unclassified-output'
  | 'unclassified-cancelled'
  | 'remote-failed'

const ORIGIN = 'https://gateway.private.example'
const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const BEARER = 'ab'.repeat(32)
const OUTPUT_SHA = 'f'.repeat(64)
const BASE_BYTES = Buffer.from('retained monitor private video bytes\n')
const AUDIO_BYTES = Buffer.from('retained monitor private audio bytes\n')
const LOOPBACK_SUPERTEST_PRELOAD = '../../../scripts/testing/loopback-supertest.mjs'
const originalFetch = globalThis.fetch
const environmentKeys = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP',
] as const
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]))
const fixtureParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../_trash/test-fixtures')

let retainedRoot = ''
let canaryPath = ''
let storyInstanceId = ''
let queue: QueueModule
let transport: TransportModule
let evidence: EvidenceModule
let reconciler: ReconcilerModule | null = null
let settings: SettingsModule
let identity: IdentityModule
let serial = 0
const trackedJobIds = new Set<string>()

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
    max_asset_bytes: 1024 * 1024, max_total_input_bytes: 2 * 1024 * 1024,
    max_pixel_frames: 128 * 96 * 5 * 60, scratch_reserve_bytes: 1,
    output_limit_bytes: 1024 * 1024, process_tree_rss_limit_bytes: 1024 * 1024,
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
  require('electron')
  const cached = require.cache[require.resolve('electron')]
  assert.ok(cached, 'Electron module has a cache entry')
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

async function requestBody(init: RequestInit): Promise<Buffer> {
  if (init.body === undefined || init.body === null) return Buffer.alloc(0)
  if (typeof init.body === 'string') return Buffer.from(init.body)
  if (init.body instanceof Uint8Array) return Buffer.from(init.body)
  const reader = (init.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Buffer[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(Buffer.from(next.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

type Accepted = {
  id: string
  key: string
  bytes: Buffer
  body: Record<string, any>
  packetDigest: string
  mode: LookupMode
  cancelMode: 'pending' | 'pending-reordered' | 'terminal' | 'unknown'
}

class FakeGateway {
  readonly calls: WireCall[] = []
  readonly blobs = new Map<string, BlobState>()
  readonly accepted = new Map<string, Accepted>()
  beforeCall?: (call: WireCall) => void | Promise<void>
  nextPostMode: 'accepted' | 'throw-after-record' = 'accepted'

  resetCalls(): void { this.calls.length = 0 }

  setMode(key: string, mode: LookupMode): void {
    const accepted = this.accepted.get(key)
    assert.ok(accepted, `Gateway fixture knows ${key}`)
    accepted.mode = mode
  }

  setCancelMode(key: string, mode: Accepted['cancelMode']): void {
    const accepted = this.accepted.get(key)
    assert.ok(accepted, `Gateway fixture knows ${key}`)
    accepted.cancelMode = mode
  }

  callsFor(key: string): WireCall[] {
    const accepted = this.accepted.get(key)
    const byKey = `/v1/final-renders/by-idempotency-key/${encodeURIComponent(key)}`
    const byId = accepted ? `/v1/final-renders/${accepted.id}` : null
    return this.calls.filter(call => {
      const pathname = new URL(call.url).pathname
      return pathname === byKey || pathname.startsWith(`${byKey}/`)
        || (byId !== null && (pathname === byId || pathname.startsWith(`${byId}/`)))
    })
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

  private pending(entry: Accepted): Record<string, unknown> {
    const result: Record<string, unknown> = {
      format: 'studio.render.gateway-job.v1', id: entry.id, state: 'accepted',
      gateway_attempt_key: entry.key, story_uuid: entry.body.story_uuid,
      intent_id: entry.body.intent_id, attempt_no: entry.body.attempt_no,
      output_ready: false, idempotent_replay: true, remote_state: 'rendering',
    }
    if (entry.mode === 'foreign-story') result.story_uuid = '99999999-9999-4999-8999-999999999999'
    if (entry.mode === 'cancelled-terminal') {
      result.cancel_state = 'cancelled'
      result.remote_state = 'cancelled'
      result.terminal_proof = {
        format: 'studio.render.gateway-terminal-proof.v1', kind: 'launched_stopped',
        gateway_job_id: entry.id, gateway_attempt_key: entry.key,
        hub_job_id: '33333333-3333-4333-8333-333333333333',
        hub_attempt_id: 'a'.repeat(32), stopped_evidence_digest: '6'.repeat(64),
      }
    }
    if (entry.mode === 'unclassified-output') result.remote_state = 'output_ready'
    if (entry.mode === 'unclassified-cancelled') {
      result.cancel_state = 'cancelled'
      result.remote_state = 'cancelled'
    }
    if (entry.mode === 'acknowledged') result.state = 'acknowledged'
    // The Gateway's bounded status tail: 30 answers it cannot accept settle the delivery
    // `remote_state: "failed"` while the row keeps its accepted state (render_service.py
    // `_status_answer_refused`). No output, no terminal proof — a settled failure.
    if (entry.mode === 'remote-failed') result.remote_state = 'failed'
    return result
  }

  private outputReady(entry: Accepted): Record<string, unknown> {
    const receiptUtf8 = canonicalJson({
      format: 'studio.render.gateway-output-receipt.v1', owner_scope: OWNER_SCOPE,
      gateway_instance_id: GATEWAY_ID, story_instance_id: storyInstanceId,
      gateway_job_id: entry.id, gateway_attempt_key: entry.key,
      story_uuid: entry.body.story_uuid, intent_id: entry.body.intent_id,
      attempt_no: entry.body.attempt_no, inbound_story_body_sha256: sha256(entry.bytes),
      packet_digest: entry.packetDigest, outbound_hub_body_sha256: '1'.repeat(64),
      hub_dispatch_key: `gateway:${entry.key}`, dispatch_fence: 'render-dispatch-fence-001',
      hub_owner_scope: 'site:controller:fleet',
      hub_job_id: '33333333-3333-4333-8333-333333333333', hub_attempt_id: 'a'.repeat(32),
      hub_receipt_digest: '2'.repeat(64),
      selected_machine: {
        id: 'node-m4-a', label: 'Private M4', chip: 'Apple M4', memory_gb: 32,
        hardware_class: 'mac-m4-32gb',
      },
      profile_digest: PROFILE_DIGEST, tools_digest: TOOLS_DIGEST,
      compiler_digest: COMPILER_DIGEST, qualification_digest: '3'.repeat(64),
      selected_tier: 'software-h264', generated_command_digest: '4'.repeat(64),
      feature_losses: [], output_sha256: OUTPUT_SHA, output_size_bytes: 32,
    })
    const receiptDigest = sha256(receiptUtf8)
    return {
      ...this.pending(entry), state: 'output_ready', remote_state: 'output_ready', output_ready: true,
      receipt_digest: receiptDigest,
      output: { sha256: OUTPUT_SHA, size_bytes: 32, receipt_digest: receiptDigest, receipt_utf8: receiptUtf8 },
    }
  }

  private async responseFor(entry: Accepted): Promise<Response> {
    if (entry.mode === 'not-found') return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
    if (entry.mode === 'malformed') return Response.json({ malformed: true })
    return Response.json(entry.mode === 'output-ready' ? this.outputReady(entry) : this.pending(entry))
  }

  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const call: WireCall = {
      method: init.method ?? 'GET', url: String(input), body: await requestBody(init), headers: new Headers(init.headers),
    }
    this.calls.push(call)
    assert.equal(call.headers.get('Authorization'), `Bearer ${BEARER}`)
    await this.beforeCall?.(call)
    const url = new URL(call.url)
    if (url.pathname === '/v1/final-renders/capabilities') return Response.json(capabilities())

    const status = /^\/v1\/final-renders\/blobs\/([0-9a-f]{64})\/status$/.exec(url.pathname)
    if (status) {
      const size = Number(url.searchParams.get('size_bytes'))
      const state = this.blobs.get(status[1]) ?? { sha256: status[1], size_bytes: size, offset: 0 }
      this.blobs.set(status[1], state)
      return Response.json(this.blobPublic(state))
    }
    const put = /^\/v1\/final-renders\/blobs\/([0-9a-f]{64})$/.exec(url.pathname)
    if (put && call.method === 'PUT') {
      const size = Number(url.searchParams.get('size_bytes'))
      const offset = Number(url.searchParams.get('offset'))
      const state = this.blobs.get(put[1]) ?? { sha256: put[1], size_bytes: size, offset: 0 }
      assert.equal(state.offset, offset)
      state.offset += call.body.byteLength
      this.blobs.set(put[1], state)
      return Response.json(this.blobPublic(state))
    }
    if (url.pathname === '/v1/final-renders' && call.method === 'POST') {
      const key = call.headers.get('Idempotency-Key')!
      const body = JSON.parse(call.body.toString('utf8'))
      const id = `55555555-5555-4555-8555-${String(++serial).padStart(12, '0')}`
      const entry: Accepted = {
        id, key, bytes: Buffer.from(call.body), body,
        packetDigest: sha256(JSON.stringify(body.packet)), mode: 'pending', cancelMode: 'pending',
      }
      this.accepted.set(key, entry)
      if (this.nextPostMode === 'throw-after-record') {
        this.nextPostMode = 'accepted'
        throw new Error('controlled unknown final-render POST outcome')
      }
      return Response.json({
        ...this.pending(entry), idempotent_replay: false,
        destination_node: 'node-m4-a', inbound_story_body_sha256: sha256(call.body),
      }, { status: 202 })
    }
    const lookup = /^\/v1\/final-renders\/by-idempotency-key\/([^/]+)$/.exec(url.pathname)
    if (lookup && call.method === 'GET') {
      const entry = this.accepted.get(decodeURIComponent(lookup[1]))
      if (!entry) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
      return this.responseFor(entry)
    }
    const cancel = /^\/v1\/final-renders\/by-idempotency-key\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancel && call.method === 'POST') {
      const key = decodeURIComponent(cancel[1])
      const entry = this.accepted.get(key)
      assert.ok(entry, 'cancel uses the original accepted key')
      if (entry.cancelMode === 'unknown') throw new Error('controlled unknown cancellation response')
      const expected = JSON.parse(call.body.toString('utf8')).expected_request_sha256
      if (entry.cancelMode === 'terminal') {
        const firstCancelAt = 1_799_000_001.5
        return Response.json({
          format: 'studio.render.gateway-cancel.v1', state: 'cancelled_before_acceptance',
          gateway_attempt_key: key, expected_request_sha256: expected,
          fence_receipt: '9'.repeat(32), first_cancel_at: firstCancelAt,
          terminal_proof: {
            format: 'studio.render.gateway-terminal-proof.v1', kind: 'never_launched',
            gateway_attempt_key: key, inbound_story_body_sha256: expected,
            fence_receipt: '9'.repeat(32), first_cancel_at: firstCancelAt,
          },
        })
      }
      if (entry.cancelMode === 'pending-reordered') {
        return Response.json({
          expected_request_sha256: expected, gateway_attempt_key: key,
          state: 'cancel_requested', format: 'studio.render.gateway-cancel.v1', gateway_job_id: entry.id,
        })
      }
      return Response.json({
        format: 'studio.render.gateway-cancel.v1', state: 'cancel_requested',
        gateway_attempt_key: key, expected_request_sha256: expected, gateway_job_id: entry.id,
      })
    }
    const byId = /^\/v1\/final-renders\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (byId && call.method === 'GET') {
      const entry = [...this.accepted.values()].find(candidate => candidate.id === byId[1])
      assert.ok(entry, 'status uses the bound Gateway ID')
      return this.responseFor(entry)
    }
    throw new Error(`unexpected fake private-render request ${call.method} ${call.url}`)
  }
}

const gateway = new FakeGateway()

function requireReconciler(): ReconcilerModule {
  assert.ok(reconciler, 'S2C provides the bounded final-render reconciler module')
  return reconciler
}

function requireReconcileOne(): TransportModule['reconcileSealedPrivateFinalRenderOnce'] {
  const candidate = (transport as Record<string, unknown>).reconcileSealedPrivateFinalRenderOnce
  assert.equal(typeof candidate, 'function', 'S2C exposes one monitor-only transport operation')
  return candidate as TransportModule['reconcileSealedPrivateFinalRenderOnce']
}

async function settle(): Promise<void> {
  if (reconciler) await reconciler._resetFinalRenderReconcilerForTesting()
  if (!queue) return
  for (let turn = 0; turn < 2_000; turn++) {
    if ([...trackedJobIds].every(id => !queue._isJobWorkerActiveForTesting(id))) break
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  assert.ok([...trackedJobIds].every(id => !queue._isJobWorkerActiveForTesting(id)), 'all queue workers settle')
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
  retainedRoot = await fs.mkdtemp(path.join(trustedFixtureParent, 'final-render-monitor-retained-'))
  await fs.chmod(retainedRoot, 0o700)
  const retainedStat = await fs.lstat(retainedRoot)
  assert.equal(retainedStat.isDirectory() && !retainedStat.isSymbolicLink(), true)
  assert.equal(retainedStat.mode & 0o077, 0, 'retained fixture child must be private')
  assert.equal(path.dirname(await fs.realpath(retainedRoot)), trustedFixtureParent,
    'retained fixture child must remain directly beneath the trusted parent')
  canaryPath = path.join(retainedRoot, 'retained-canary.txt')
  await fs.writeFile(canaryPath, 'final-render-monitor-retained\n', { mode: 0o600 })
  for (const key of environmentKeys) process.env[key] = retainedRoot
  await import(LOOPBACK_SUPERTEST_PRELOAD)
  await installPackagedDescriptorFixture()
  settings = await import('../services/app-settings.js')
  identity = await import('../services/private-render-identity.js')
  transport = await import('../services/final-render-transport.js') as TransportModule
  evidence = await import('../lib/final-render-transport-evidence.js')
  queue = await import('../services/job-queue.js') as QueueModule
  reconciler = await import('../services/final-render-reconciler.js').catch(() => null) as ReconcilerModule | null
  await settings.setGenStudioUrl(ORIGIN)
  const privateIdentity = await identity.getOrCreatePrivateRenderIdentity()
  storyInstanceId = privateIdentity.story_instance_id
  await (await import('../services/app-secrets-store.js')).setApiKey('genstudio', BEARER)
  await identity.pinGatewayBinding({ origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  await settings.setPrivateFinalRenderSetting({ enabled: true })
  globalThis.fetch = gateway.fetch.bind(gateway)
})

after(async () => {
  let physicallySettled = false
  let teardownError: unknown
  try {
    await settle()
    physicallySettled = true
    if (canaryPath) assert.equal(await fs.readFile(canaryPath, 'utf8'), 'final-render-monitor-retained\n')
  } catch (error) {
    teardownError = error
  } finally {
    // Setup can fail before Electron fixture or queue assignment. Restore in that
    // case, and after ordinary settlement, but never move an active writer to
    // another HOME/TMP/data root merely to make teardown finish.
    if (physicallySettled || !queue) {
      globalThis.fetch = originalFetch
      try {
        restoreElectron?.()
      } finally {
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  }
  if (teardownError) throw teardownError
})

function makeJob(projectSlug: string, jobId: string): Job {
  trackedJobIds.add(jobId)
  return {
    job_id: jobId, project_slug: projectSlug, type: 'video_assembly', episode_id: 'EP1',
    title: 'Retained final render monitor', status: 'running',
    created_at: '2026-10-15T00:00:00.000Z', started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null, error: null, output_lines: [], params: { retained: true },
  }
}

async function writeJob(job: Job): Promise<void> {
  const projectDir = path.join(retainedRoot, 'projects', job.project_slug)
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(projectDir, 'jobs.json'), `${JSON.stringify({ jobs: [job] })}\n`, { mode: 0o600 })
  queue._forgetProjectPersistenceForTesting(job.project_slug)
}

type Prepared = {
  job: Job
  key: string
  intentDir: string
  marker: Record<string, any>
}

async function canonicalMarker(prepared: Pick<Prepared, 'job'>): Promise<Record<string, any>> {
  const job = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.ok(job)
  return structuredClone(job.final_render_remote_wait) as Record<string, any>
}

async function prepareCase(label: string, advance = true): Promise<Prepared> {
  const index = ++serial
  const slug = `monitor-${label}-${process.pid}-${index}`
  const sourceDir = path.join(retainedRoot, 'work', slug, 'sources')
  const videoDir = path.join(retainedRoot, 'work', slug, 'video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(videoDir, { recursive: true, mode: 0o700 })
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  await fs.writeFile(base, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(audio, AUDIO_BYTES, { mode: 0o600 })
  const job = makeJob(slug, `monitor-${index.toString(36)}`)
  await writeJob(job)
  const composition = {
    videoInputPath: base, premixedAudioPath: audio, targetDuration: 2,
    w: 128, h: 96, quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4', outputFile: path.join(sourceDir, 'must-never-render-locally.mp4'),
    encodingEffort: 'ultrafast', codec: 'h264', code: 'EP1',
    titleHint: `Title ${label}`, videoDir, job,
    resolvedLoudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
  } satisfies CompositionOpts & { code: string; titleHint: string; videoDir: string }
  assert.deepEqual(await transport.preparePrivateFinalRenderDescriptor(composition), {
    kind: 'video-assembly-remote-wait',
  })
  let marker = await canonicalMarker({ job })
  const intentDir = path.join(retainedRoot, 'private-render', 'intents', marker.intent_id)
  if (advance) {
    await transport.advanceSealedPrivateFinalRenderTransport(slug, job.job_id)
    marker = await canonicalMarker({ job })
    const entry = gateway.accepted.get(marker.gateway_attempt_key)
    assert.ok(entry)
    entry.packetDigest = marker.packet_sha256
  }
  await queue.getJobs(slug, { view: 'full' })
  gateway.resetCalls()
  return { job, key: marker.gateway_attempt_key, intentDir, marker }
}

async function prepareRequestPersisted(label: string): Promise<Prepared> {
  const prepared = await prepareCase(label, false)
  const jobsFile = path.join(retainedRoot, 'projects', prepared.job.project_slug, 'jobs.json')
  let disabledAtRequestCommit = false
  const restore = queue._setJobFileLockProbeForTesting(async (operation, pathname) => {
    if (operation !== 'persist' || pathname !== jobsFile || disabledAtRequestCommit) return
    // This project's first transport canonical write is V2 ->
    // request_persisted. Disable the existing authority only while that write
    // finishes, so the next assertAuthority refuses before a send_may_start
    // revision or pending canonical transition can be created.
    disabledAtRequestCommit = true
    await settings.setPrivateFinalRenderSetting({ enabled: false })
  })
  try {
    await assert.rejects(
      transport.advanceSealedPrivateFinalRenderTransport(prepared.job.project_slug, prepared.job.job_id),
      /setting is no longer enabled/,
    )
  } finally {
    restore()
    if (disabledAtRequestCommit) await settings.setPrivateFinalRenderSetting({ enabled: true })
  }
  assert.equal(disabledAtRequestCommit, true)
  await queue._waitForJobPersistenceForTesting()
  const marker = await canonicalMarker(prepared)
  assert.equal(marker.phase, 'request_persisted')
  const events = (await revisions(prepared)).map(item => JSON.parse(item.bytes.toString('utf8')).event)
  assert.ok(events.includes('request_sealed'))
  assert.equal(events.includes('send_may_start'), false,
    'the retained request_persisted boundary has no private send intent to recover')
  gateway.resetCalls()
  return { ...prepared, marker }
}

async function prepareLookupNotFound(label: string): Promise<Prepared> {
  const prepared = await prepareCase(label, false)
  gateway.nextPostMode = 'throw-after-record'
  await assert.rejects(
    transport.advanceSealedPrivateFinalRenderTransport(prepared.job.project_slug, prepared.job.job_id),
    /unknown POST outcome|original-key lookup/i,
  )
  const entry = gateway.accepted.get(prepared.key)
  assert.ok(entry)
  entry.mode = 'not-found'
  await assert.rejects(
    transport.advanceSealedPrivateFinalRenderTransport(prepared.job.project_slug, prepared.job.job_id),
    /404|not found|Final render job/i,
  )
  const marker = await canonicalMarker(prepared)
  assert.equal(marker.phase, 'lookup_not_found')
  assert.equal(marker.gateway_job_id, null)
  gateway.resetCalls()
  return { ...prepared, marker }
}

async function revisions(prepared: Prepared): Promise<Array<{ name: string; bytes: Buffer }>> {
  const directory = path.join(prepared.intentDir, 'transport', 'revisions')
  const names = (await fs.readdir(directory)).sort()
  return Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(path.join(directory, name)) })))
}

type EvidenceInput = Parameters<EvidenceModule['validateFinalRenderTransportEvidence']>[0]

function stagedRoot(marker: Record<string, any>): EvidenceInput['staged'] {
  assert.equal(marker.version, 3)
  return {
    version: 2, phase: 'intent_staged', revision: 1,
    job_id: marker.job_id, intent_id: marker.intent_id,
    story_instance_id: marker.story_instance_id, story_attempt: marker.story_attempt,
    gateway_attempt_key: marker.gateway_attempt_key, packet_sha256: marker.packet_sha256,
    staging_manifest_sha256: marker.staging_manifest_sha256,
    submission_scope_sha256: marker.submission_scope_sha256,
    destination_fence_sha256: marker.destination_fence_sha256,
    source_generation_fence_sha256: marker.source_generation_fence_sha256,
    committed_at: marker.committed_at, cancel_requested_at: null,
  }
}

async function evidenceInput(prepared: Prepared): Promise<EvidenceInput> {
  const marker = await canonicalMarker(prepared)
  return {
    staged: stagedRoot(marker),
    canonical: marker as EvidenceInput['canonical'],
    manifestBytes: await fs.readFile(path.join(prepared.intentDir, 'manifest.json')),
    revisions: await revisions(prepared),
    requestBytes: await fs.readFile(path.join(prepared.intentDir, 'transport', 'request.json')),
    submissionBytes: await fs.readFile(path.join(prepared.intentDir, 'transport', 'submission.json')),
  }
}

function syntheticRevision(
  input: EvidenceInput,
  event: string,
  payload: Record<string, unknown>,
): EvidenceInput['revisions'][number] {
  const previous = input.revisions.at(-1)
  assert.ok(previous)
  const owner = JSON.parse(Buffer.from(previous.bytes).toString('utf8')) as Record<string, any>
  const value = {
    version: 1, sequence: input.revisions.length + 1,
    previous_sha256: sha256(previous.bytes),
    canonical_before_sha256: evidence.finalRenderCanonicalReceiptHash(input.canonical),
    event, recorded_at: '2026-10-15T00:00:01.000Z',
    owner_token: owner.owner_token, owner_epoch: owner.owner_epoch, payload,
  }
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  const digest = sha256(bytes)
  return { name: `${String(value.sequence).padStart(8, '0')}-${digest}.json`, bytes }
}

function terminalCancellationResponse(marker: Record<string, any>): Record<string, unknown> {
  const firstCancelAt = 1_799_000_001.5
  return {
    format: 'studio.render.gateway-cancel.v1', state: 'cancelled_before_acceptance',
    gateway_attempt_key: marker.gateway_attempt_key,
    expected_request_sha256: marker.request_body_sha256,
    fence_receipt: '9'.repeat(32), first_cancel_at: firstCancelAt,
    terminal_proof: {
      format: 'studio.render.gateway-terminal-proof.v1', kind: 'never_launched',
      gateway_attempt_key: marker.gateway_attempt_key,
      inbound_story_body_sha256: marker.request_body_sha256,
      fence_receipt: '9'.repeat(32), first_cancel_at: firstCancelAt,
    },
  }
}

async function privateSnapshot(prepared: Prepared): Promise<{ marker: Record<string, any>; revisions: string[] }> {
  const marker = await canonicalMarker(prepared)
  if (marker.version === 2 && marker.phase === 'intent_staged') {
    const directory = path.join(prepared.intentDir, 'transport', 'revisions')
    await assert.rejects(
      fs.stat(directory),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      'V2 intent_staged has no transport revisions directory',
    )
    return { marker, revisions: [] }
  }
  return {
    marker,
    revisions: (await revisions(prepared)).map(item => `${item.name}:${sha256(item.bytes)}`),
  }
}

function assertNoPrivateProjection(value: unknown): void {
  const text = JSON.stringify(value)
  for (const forbidden of [
    'final_render_remote_wait', 'transport_revision_sha256', 'request_body_sha256',
    BEARER, GATEWAY_ID, 'hub_attempt_id', 'receipt_utf8',
  ]) assert.equal(text.includes(forbidden), false, `public projection excludes ${forbidden}`)
}

test('boot singleton is bounded and awaited reset joins its held in-flight pass', async t => {
  const monitor = requireReconciler()
  assert.throws(() => monitor.startFinalRenderReconciler(), /boot|load|recovery/i)
  await queue.resumeInterruptedJobsAtBoot()
  assert.equal(queue.areBootJobsLoaded(), true)
  const prepared = await prepareCase('singleton-reset')
  const entered = deferred()
  const release = deferred()
  gateway.beforeCall = async call => {
    if (!call.url.includes(encodeURIComponent(prepared.key)) || call.method !== 'GET') return
    entered.resolve()
    await release.promise
  }
  t.after(() => { release.resolve(); gateway.beforeCall = undefined })

  const originalTimeout = globalThis.setTimeout
  const originalInterval = globalThis.setInterval
  const timers: Array<{ kind: 'timeout' | 'interval'; callback: () => void; delay: number; unref: number }> = []
  const fake = (kind: 'timeout' | 'interval') => ((callback: () => void, delay = 0) => {
    const item = { kind, callback, delay, unref: 0 }
    timers.push(item)
    return { unref: () => { item.unref += 1 } } as unknown as NodeJS.Timeout
  })
  globalThis.setTimeout = fake('timeout') as typeof setTimeout
  globalThis.setInterval = fake('interval') as typeof setInterval
  t.after(() => { globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval })

  monitor.startFinalRenderReconciler()
  monitor.startFinalRenderReconciler()
  assert.deepEqual(timers.map(timer => [timer.kind, timer.delay, timer.unref]), [
    ['timeout', 5_000, 1], ['interval', 30_000, 1],
  ])
  timers[0].callback()
  timers[1].callback()
  await entered.promise
  assert.equal(gateway.callsFor(prepared.key).filter(call => call.method === 'GET').length, 1,
    'overlapping timer callbacks share one in-flight pass')
  let resetSettled = false
  const reset = monitor._resetFinalRenderReconcilerForTesting().then(() => { resetSettled = true })
  await Promise.resolve()
  assert.equal(resetSettled, false, 'reset waits for the captured physical pass')
  release.resolve()
  await reset
  const callsAfterReset = gateway.calls.length
  timers.forEach(timer => timer.callback())
  await Promise.resolve()
  assert.equal(gateway.calls.length, callsAfterReset, 'cleared handles cannot start another request')
})

test('scheduler backoff advances without sleeps and caps one failing identity at thirty minutes', async () => {
  const monitor = requireReconciler()
  const prepared = await prepareCase('bounded-backoff')
  gateway.setMode(prepared.key, 'malformed')
  const base = 1_800_000_000_000
  gateway.resetCalls()
  await monitor.runFinalRenderReconcilePassForTesting(base)
  let calls = gateway.callsFor(prepared.key).length
  assert.equal(calls, 1)
  await monitor.runFinalRenderReconcilePassForTesting(base + 29_999)
  assert.equal(gateway.callsFor(prepared.key).length, calls, 'failure backoff skips the identity before 30 seconds')

  let due = base + 30_000
  for (const delay of [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]) {
    await monitor.runFinalRenderReconcilePassForTesting(due)
    calls += 1
    assert.equal(gateway.callsFor(prepared.key).length, calls)
    await monitor.runFinalRenderReconcilePassForTesting(due + delay - 1)
    assert.equal(gateway.callsFor(prepared.key).length, calls)
    due += delay
  }
  await monitor.runFinalRenderReconcilePassForTesting(due)
  assert.equal(gateway.callsFor(prepared.key).length, calls + 1,
    'the next retry is due after the capped thirty-minute interval')
  await monitor._resetFinalRenderReconcilerForTesting()
})

// Real scheduler passes. An hour apart, so an earlier failure's backoff never hides a row; three
// bounded pages reach every row these dispatch tests leave behind.
let passClock = 1_900_000_000_000
async function reconcilePasses(count = 3, stepMs = 3_600_000): Promise<void> {
  for (let pass = 0; pass < count; pass++) {
    passClock += stepMs
    await requireReconciler().runFinalRenderReconcilePassForTesting(passClock)
  }
}

function submissions(key: string): WireCall[] {
  return gateway.calls.filter(call => call.method === 'POST'
    && new URL(call.url).pathname === '/v1/final-renders' && call.headers.get('Idempotency-Key') === key)
}

test('reconciler passes advance V2 and request_persisted rows with exactly one POST each', async () => {
  const staged = await prepareCase('dispatch-v2', false)
  const persisted = await prepareRequestPersisted('dispatch-persisted')
  await reconcilePasses()
  for (const prepared of [staged, persisted]) {
    const marker = await canonicalMarker(prepared)
    assert.equal(marker.phase, 'remote_wait')
    assert.equal(marker.gateway_attempt_key, prepared.key, 'the persisted per-hop key is the one sent')
    assert.equal(submissions(prepared.key).length, 1, 'later passes only observe; they never resend')
  }
})

test('an interrupted send and an unknown POST are only looked up by their original key', async () => {
  const unknown = await prepareCase('dispatch-send-unknown', false)
  gateway.nextPostMode = 'throw-after-record'
  await assert.rejects(
    transport.advanceSealedPrivateFinalRenderTransport(unknown.job.project_slug, unknown.job.job_id),
    /unknown POST outcome|original-key lookup/i,
  )
  const unsure = await canonicalMarker(unknown)
  assert.equal(unsure.phase, 'send_unknown')

  // A send granted by a fresh CAS whose POST never left (the app stopped first): restart sees send_may_start.
  const interrupted = await prepareRequestPersisted('dispatch-send-may-start')
  const jobsFile = path.join(retainedRoot, 'projects', interrupted.job.project_slug, 'jobs.json')
  let disabled = false
  const restore = queue._setJobFileLockProbeForTesting(async (operation, pathname) => {
    if (operation !== 'persist' || pathname !== jobsFile || disabled) return
    disabled = true
    await settings.setPrivateFinalRenderSetting({ enabled: false })
  })
  try {
    await assert.rejects(
      transport.advanceSealedPrivateFinalRenderTransport(interrupted.job.project_slug, interrupted.job.job_id),
      /no longer enabled/,
    )
  } finally {
    restore()
    await settings.setPrivateFinalRenderSetting({ enabled: true })
  }
  const granted = await canonicalMarker(interrupted)
  assert.equal(granted.phase, 'send_may_start')
  assert.equal(submissions(interrupted.key).length, 0)
  // The Gateway did receive it before the stop; only the original key can find it.
  const request = await fs.readFile(path.join(interrupted.intentDir, 'transport', 'request.json'))
  gateway.accepted.set(interrupted.key, {
    id: '55555555-5555-4555-8555-999999999999', key: interrupted.key, bytes: request,
    body: JSON.parse(request.toString('utf8')), packetDigest: granted.packet_sha256,
    mode: 'pending', cancelMode: 'pending',
  })
  queue._forgetProjectPersistenceForTesting(interrupted.job.project_slug)

  gateway.resetCalls()
  await reconcilePasses()
  for (const [prepared, before] of [[unknown, unsure], [interrupted, granted]] as const) {
    const marker = await canonicalMarker(prepared)
    assert.equal(marker.phase, 'remote_wait')
    assert.equal(marker.gateway_attempt_key, before.gateway_attempt_key)
    assert.equal(marker.story_attempt, before.story_attempt, 'the attempt number never increments')
    assert.equal(submissions(prepared.key).length, 0, 'no re-POST after a possible send')
    assert.ok(gateway.callsFor(prepared.key).some(call => call.method === 'GET'
      && new URL(call.url).pathname.startsWith('/v1/final-renders/by-idempotency-key/')))
  }
  assert.equal((await canonicalMarker(interrupted)).gateway_job_id, '55555555-5555-4555-8555-999999999999')
})

test('a paused queue sends and imports nothing while monitoring and cancellation still run', async () => {
  const staged = await prepareCase('dispatch-paused-v2', false)
  const watched = await prepareCase('dispatch-paused-watch')
  const cancelling = await prepareCase('dispatch-paused-cancel')
  await queue.requestFinalRenderRemoteWaitCancellation(cancelling.job.project_slug, cancelling.job.job_id)
  const ready = await prepareCase('dispatch-paused-ready')
  gateway.setMode(ready.key, 'output-ready')
  await requireReconcileOne()(ready.job.project_slug, ready.job.job_id)
  assert.equal((await canonicalMarker(ready)).phase, 'output_ready')
  gateway.resetCalls()
  await queue.setQueuePaused(true)
  try {
    await reconcilePasses()
    assert.equal(submissions(staged.key).length, 0)
    assert.equal((await canonicalMarker(staged)).version, 2)
    assert.equal(gateway.callsFor(ready.key).length, 0, 'no import read while paused')
    assert.equal((await canonicalMarker(ready)).phase, 'output_ready')
    assert.ok(gateway.callsFor(watched.key).some(call => call.method === 'GET'), 'monitoring continues')
    assert.ok(gateway.callsFor(cancelling.key).some(call => call.method === 'POST'
      && new URL(call.url).pathname.endsWith('/cancel')), 'cancellation continues')
  } finally {
    await queue.setQueuePaused(false)
  }
  await reconcilePasses()
  assert.equal(submissions(staged.key).length, 1, 'resuming the queue sends the held intent once')
})

test('with the setting off nothing is sent, and turning it on sends without a backoff wait', async () => {
  const staged = await prepareCase('dispatch-setting-off', false)
  await settings.setPrivateFinalRenderSetting({ enabled: false })
  try {
    await reconcilePasses()
    assert.equal(submissions(staged.key).length, 0)
    assert.equal((await canonicalMarker(staged)).version, 2)
  } finally {
    await settings.setPrivateFinalRenderSetting({ enabled: true })
  }
  await reconcilePasses(2, 1)
  assert.equal(submissions(staged.key).length, 1)
  assert.equal((await canonicalMarker(staged)).phase, 'remote_wait')
})

test('unsent V2 and request_persisted cancellation remain no-network monitor holds', async () => {
  const v2 = await prepareCase('no-admission-v2', false)
  const v3 = await prepareRequestPersisted('no-admission-v3')
  await queue.requestFinalRenderRemoteWaitCancellation(v2.job.project_slug, v2.job.job_id)
  await queue.requestFinalRenderRemoteWaitCancellation(v3.job.project_slug, v3.job.job_id)
  const beforeV2 = await privateSnapshot(v2)
  const beforeV3 = await privateSnapshot(v3)
  gateway.resetCalls()
  await requireReconcileOne()(v2.job.project_slug, v2.job.job_id)
  await requireReconcileOne()(v3.job.project_slug, v3.job.job_id)
  assert.equal(gateway.calls.length, 0)
  assert.deepEqual(await privateSnapshot(v2), beforeV2)
  assert.deepEqual(await privateSnapshot(v3), beforeV3)
  assert.ok((await canonicalMarker(v2)).cancel_requested_at)
  assert.ok((await canonicalMarker(v3)).cancel_requested_at)
})

test('original-key lookup precedes status and pending digest truth clears only its transient foreign hold', async () => {
  const prepared = await prepareCase('strict-pending')
  gateway.setMode(prepared.key, 'foreign-story')
  const before = await privateSnapshot(prepared)
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
  assert.deepEqual(await privateSnapshot(prepared), before, 'foreign data creates no durable remote fact')
  const held = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0] as any
  assert.equal(held.final_render_wait?.state, 'recovery_hold')
  assert.equal(JSON.stringify(held).includes('99999999-9999-4999-8999-999999999999'), false)

  gateway.resetCalls()
  gateway.setMode(prepared.key, 'pending')
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
  assert.deepEqual(await privateSnapshot(prepared), before, 'an unchanged pending view creates no journal churn')
  const recovered = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0] as any
  assert.equal(recovered.final_render_wait?.state, 'remote_wait')
  const paths = gateway.callsFor(prepared.key).map(call => new URL(call.url).pathname)
  assert.equal(paths[0], `/v1/final-renders/by-idempotency-key/${encodeURIComponent(prepared.key)}`)
  assert.equal(paths[1], `/v1/final-renders/${prepared.marker.gateway_job_id}`)
  assert.equal(paths.some(value => value.endsWith('/cancel')), false)
})

test('unknown reads write nothing while authenticated absence records only its exact bounded hold', async () => {
  const malformed = await prepareCase('malformed-read')
  gateway.setMode(malformed.key, 'malformed')
  const malformedBefore = await privateSnapshot(malformed)
  await requireReconcileOne()(malformed.job.project_slug, malformed.job.job_id)
  assert.deepEqual(await privateSnapshot(malformed), malformedBefore)

  const missing = await prepareCase('bound-404')
  gateway.setMode(missing.key, 'not-found')
  await requireReconcileOne()(missing.job.project_slug, missing.job.job_id)
  const after = await canonicalMarker(missing)
  assert.equal(after.phase, 'recovery_hold')
  assert.equal(after.gateway_job_id, missing.marker.gateway_job_id)
  assert.equal(gateway.callsFor(missing.key).some(call => call.method === 'POST'), false)
  const once = await revisions(missing)
  await requireReconcileOne()(missing.job.project_slug, missing.job.job_id)
  assert.deepEqual(await revisions(missing), once, 'replayed bound absence does not grow the chain')
})

test('output-ready commits private proof before canonical readback and performs no importer action', async () => {
  const prepared = await prepareCase('output-ready')
  gateway.setMode(prepared.key, 'output-ready')
  const events: unknown[] = []
  const listener = (value: unknown) => events.push(value)
  queue.jobEvents.on('update', listener)
  try {
    await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
    queue._flushDirtyJobStreamsForTesting()
  } finally {
    queue.jobEvents.off('update', listener)
  }
  const marker = await canonicalMarker(prepared)
  assert.equal(marker.phase, 'output_ready')
  const chain = await revisions(prepared)
  assert.ok(chain.some(item => item.name.includes(marker.transport_revision_sha256)))
  const calls = gateway.callsFor(prepared.key)
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET'])
  assert.equal(calls.some(call => /output|ack/.test(new URL(call.url).pathname)), false)
  const full = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0]
  const stream = (await queue.getJobs(prepared.job.project_slug, { view: 'stream' }))[0]
  const single = queue.getPublicJob(prepared.job.job_id)
  ;[full, stream, single, ...events].forEach(assertNoPrivateProjection)
  assert.equal(full.status, 'running', 'S2C stops before local import and completion')
})

test('cancellation uses GET-only terminal and bound-404 holds, and POST only for pre-bound ID-null absence', async () => {
  const terminal = await prepareCase('cancel-terminal')
  await queue.requestFinalRenderRemoteWaitCancellation(terminal.job.project_slug, terminal.job.job_id)
  gateway.setMode(terminal.key, 'cancelled-terminal')
  gateway.resetCalls()
  await requireReconcileOne()(terminal.job.project_slug, terminal.job.job_id)
  assert.equal((await canonicalMarker(terminal)).phase, 'recovery_hold')
  assert.deepEqual(gateway.callsFor(terminal.key).map(call => call.method), ['GET'])

  const boundMissing = await prepareCase('cancel-bound-404')
  await queue.requestFinalRenderRemoteWaitCancellation(boundMissing.job.project_slug, boundMissing.job.job_id)
  const boundBeforeRevisions = await revisions(boundMissing)
  gateway.setMode(boundMissing.key, 'not-found')
  gateway.resetCalls()
  await requireReconcileOne()(boundMissing.job.project_slug, boundMissing.job.job_id)
  const boundAfter = await canonicalMarker(boundMissing)
  assert.equal(boundAfter.phase, 'recovery_hold')
  assert.equal(boundAfter.gateway_job_id, boundMissing.marker.gateway_job_id)
  assert.deepEqual(gateway.callsFor(boundMissing.key).map(call => call.method), ['GET'])
  const boundAdded = (await revisions(boundMissing)).slice(boundBeforeRevisions.length)
    .map(item => JSON.parse(item.bytes.toString('utf8')) as Record<string, any>)
  const boundMonitorEvents = boundAdded.filter(value => String(value.event).startsWith('monitor_'))
  assert.deepEqual(boundMonitorEvents.map(value => value.event), ['monitor_recovery_hold'])
  assert.deepEqual(Object.keys(boundMonitorEvents[0].payload).sort(), ['after', 'reason', 'status'])
  assert.equal(boundMonitorEvents[0].payload.reason, 'bound_key_not_found')
  assert.equal(boundMonitorEvents[0].payload.status, 404)
  assert.equal(boundAdded.some(value => (
    value.event === 'monitor_cancel_intent' || value.event === 'monitor_cancel_terminal'
  )), false, 'a bound-ID 404 cannot be reclassified as a pre-bound cancellation tombstone')

  const prebound = await prepareLookupNotFound('cancel-prebound')
  const entry = gateway.accepted.get(prebound.key)!
  await queue.requestFinalRenderRemoteWaitCancellation(prebound.job.project_slug, prebound.job.job_id)
  entry.mode = 'not-found'
  entry.cancelMode = 'terminal'
  gateway.resetCalls()
  await requireReconcileOne()(prebound.job.project_slug, prebound.job.job_id)
  assert.deepEqual(gateway.callsFor(prebound.key).map(call => call.method), ['GET', 'POST'])
  assert.equal((await canonicalMarker(prebound)).phase, 'recovery_hold')
  const chainText = Buffer.concat((await revisions(prebound)).map(item => item.bytes)).toString('utf8')
  assert.match(chainText, /monitor_cancel_intent/)
  assert.match(chainText, /monitor_cancel_terminal/)
})

test('pre-bound terminal key proof binds its ID and holds without status GET or cancellation POST', async () => {
  const prepared = await prepareLookupNotFound('prebound-terminal-proof')
  const accepted = gateway.accepted.get(prepared.key)!
  await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  accepted.mode = 'cancelled-terminal'
  gateway.resetCalls()

  const before = await revisions(prepared)
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)

  const marker = await canonicalMarker(prepared)
  assert.equal(marker.phase, 'recovery_hold')
  assert.equal(marker.gateway_job_id, accepted.id, 'the authenticated key response binds the one Gateway ID')
  const calls = gateway.callsFor(prepared.key)
  assert.deepEqual(calls.map(call => [call.method, new URL(call.url).pathname]), [
    ['GET', `/v1/final-renders/by-idempotency-key/${encodeURIComponent(prepared.key)}`],
  ])
  const added = (await revisions(prepared)).slice(before.length)
    .map(item => JSON.parse(item.bytes.toString('utf8')) as Record<string, any>)
  assert.deepEqual(added.filter(item => item.event === 'monitor_cancel_intent'), [])
  assert.deepEqual(added.filter(item => item.event === 'monitor_cancel_observed'), [])
  assert.deepEqual(added.filter(item => item.event === 'monitor_cancel_unknown'), [])
  assert.deepEqual(added.filter(item => item.event === 'monitor_recovery_hold').map(item => item.payload.reason), [
    'remote_cancelled',
  ])
})

test('pure cancellation evidence rejects two outcomes or terminal reuse for one dispatch intent', async () => {
  const prepared = await prepareLookupNotFound('cancel-intent-reuse')
  const accepted = gateway.accepted.get(prepared.key)!
  await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  accepted.mode = 'not-found'
  accepted.cancelMode = 'pending'
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)

  const input = await evidenceInput(prepared)
  evidence.validateFinalRenderTransportEvidence(input)
  const parsed = input.revisions.map(item => ({
    item,
    value: JSON.parse(Buffer.from(item.bytes).toString('utf8')) as Record<string, any>,
  }))
  const intent = parsed.find(item => item.value.event === 'monitor_cancel_intent')
  assert.ok(intent)
  const intentSha = sha256(intent.item.bytes)

  const unknown = syntheticRevision(input, 'monitor_cancel_unknown', {
    cancel_intent_sha256: intentSha, failure_class: 'network',
  })
  assert.throws(() => evidence.validateFinalRenderTransportEvidence({
    ...input, revisions: [...input.revisions, unknown],
  }), /cancel|outcome|consum|reuse/i)

  const marker = input.canonical as Record<string, any>
  assert.equal(input.canonical.version, 3)
  const { transport_revision_sha256: _backlink, ...after } = {
    ...input.canonical, phase: 'recovery_hold' as const, revision: input.canonical.revision + 1,
  }
  const terminal = syntheticRevision(input, 'monitor_cancel_terminal', {
    cancel_intent_sha256: intentSha,
    response: terminalCancellationResponse(marker),
    after,
  })
  assert.throws(() => evidence.validateFinalRenderTransportEvidence({
    ...input,
    canonical: { ...after, transport_revision_sha256: sha256(terminal.bytes) } as EvidenceInput['canonical'],
    revisions: [...input.revisions, terminal],
  }), /cancel|outcome|consum|reuse/i)
})

test('reordered strict cancellation response does not append a duplicate observed outcome', async () => {
  const prepared = await prepareCase('cancel-response-order')
  const accepted = gateway.accepted.get(prepared.key)!
  await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  accepted.mode = 'pending'
  accepted.cancelMode = 'pending'
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
  const observedCount = async () => (await revisions(prepared))
    .map(item => JSON.parse(item.bytes.toString('utf8')) as Record<string, any>)
    .filter(item => item.event === 'monitor_cancel_observed').length
  assert.equal(await observedCount(), 1)

  accepted.cancelMode = 'pending-reordered'
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(await observedCount(), 1,
    'strictly equal response values do not grow evidence when JSON key order changes')
})

test('pause and disabled setting block fresh mutation but still observe already accepted work safely', async () => {
  const prepared = await prepareCase('pause-observe')
  gateway.setMode(prepared.key, 'pending')
  await queue.setQueuePaused(true)
  await settings.setPrivateFinalRenderSetting({ enabled: false })
  try {
    await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
    assert.deepEqual(gateway.callsFor(prepared.key).map(call => call.method), ['GET', 'GET'])
    assert.equal(gateway.callsFor(prepared.key).some(call => call.method === 'POST'), false)
  } finally {
    await settings.setPrivateFinalRenderSetting({ enabled: true })
    await queue.setQueuePaused(false)
  }
})

test('authority change during an awaited observation prevents stale checkpoint', async t => {
  const prepared = await prepareCase('authority-race')
  gateway.setMode(prepared.key, 'output-ready')
  const entered = deferred()
  const release = deferred()
  gateway.beforeCall = async call => {
    if (!call.url.includes(encodeURIComponent(prepared.key)) || call.method !== 'GET') return
    entered.resolve()
    await release.promise
  }
  t.after(() => { release.resolve(); gateway.beforeCall = undefined })
  const stale = requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
  await entered.promise
  const cancelled = await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
  const winner = structuredClone(cancelled.final_render_remote_wait)
  release.resolve()
  await assert.rejects(stale, /changed|authority|owner|cancel|lineage|recovery/i)
  assert.deepEqual(await canonicalMarker(prepared), winner)
})

test('seventeen-row scheduler advances its real cursor past backoff-skipped early identities', async () => {
  const monitor = requireReconciler()
  await monitor._resetFinalRenderReconcilerForTesting()
  if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()
  const prepared: Prepared[] = []
  for (let index = 0; index < 17; index++) {
    prepared.push(await prepareCase(`000-fair-${String(index).padStart(2, '0')}`))
  }
  const list = (queue as unknown as Record<string, unknown>).listFinalRenderReconcileCandidates
  assert.equal(typeof list, 'function', 'queue exposes identifier-only bounded candidate enumeration')
  let cursor: ReconcileIdentity | null = null
  const visited: string[] = []
  for (let pass = 0; pass < 3; pass++) {
    const batch: ReconcileIdentity[] = (list as QueueModule['listFinalRenderReconcileCandidates'])(cursor, 8)
    assert.ok(batch.length <= 8)
    for (const candidate of batch) {
      visited.push(`${candidate.project_slug}\0${candidate.job_id}`)
      cursor = candidate
    }
  }
  for (const item of prepared) {
    assert.ok(visited.includes(`${item.job.project_slug}\0${item.job.job_id}`),
      `composite ring reaches ${item.job.project_slug}/${item.job.job_id}`)
    const full = (await queue.getJobs(item.job.project_slug, { view: 'full' }))[0]
    const stream = (await queue.getJobs(item.job.project_slug, { view: 'stream' }))[0]
    assertNoPrivateProjection(full)
    assertNoPrivateProjection(stream)
  }
  const wrapped = (list as QueueModule['listFinalRenderReconcileCandidates'])(
    { project_slug: 'zzzz-after-owned-monitor-projects', job_id: 'zzzz-after-owned-monitor-jobs' },
    8,
  )
  assert.deepEqual(wrapped, (list as QueueModule['listFinalRenderReconcileCandidates'])(null, 8),
    'a cursor above every owned identity wraps to the first bounded page')

  for (const item of prepared.slice(0, 8)) gateway.setMode(item.key, 'malformed')
  gateway.resetCalls()
  const now = 1_800_100_000_000
  await monitor.runFinalRenderReconcilePassForTesting(now)
  await monitor.runFinalRenderReconcilePassForTesting(now)
  await monitor.runFinalRenderReconcilePassForTesting(now)
  for (const item of prepared.slice(0, 8)) {
    assert.equal(gateway.callsFor(item.key).length, 1,
      `backoff suppresses a second visit to ${item.job.project_slug}/${item.job.job_id}`)
  }
  for (const item of prepared.slice(8)) {
    assert.ok(gateway.callsFor(item.key).length >= 2,
      `real monitor passes reach ${item.job.project_slug}/${item.job.job_id} after skipped rows`)
  }
  await monitor._resetFinalRenderReconcilerForTesting()
})

test('unclassified strict remote views hold without cancellation dispatch or terminal evidence', async t => {
  const cases: Array<{
    label: string
    mode: Extract<LookupMode, 'unclassified-output' | 'unclassified-cancelled'>
  }> = [
    { label: 'output-ready-false', mode: 'unclassified-output' },
    { label: 'cancelled-without-launched-stopped', mode: 'unclassified-cancelled' },
  ]

  for (const item of cases) {
    await t.test(item.label, async () => {
      const prepared = await prepareCase(`unclassified-${item.label}`)
      await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
      gateway.setMode(prepared.key, item.mode)
      gateway.resetCalls()
      const before = await privateSnapshot(prepared)

      await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)

      assert.equal(gateway.callsFor(prepared.key).some(call => call.method === 'POST'), false,
        `${item.label} cannot authorize cancellation dispatch`)
      assert.deepEqual(await privateSnapshot(prepared), before,
        `${item.label} cannot become a private cancellation or terminal fact`)
      assert.equal(queue.hasFinalRenderMonitorTransientHold(prepared.job.project_slug, prepared.job.job_id), true,
        `${item.label} is held by the independently tagged transient diagnostic`)
      const publicJob = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0] as any
      assert.equal(publicJob.final_render_wait?.state, 'recovery_hold')
      assertNoPrivateProjection(publicJob)
    })
  }
})

/**
 * The Gateway's bounded status tail (render_service.py `_status_answer_refused`, commit 41fe7b1)
 * settles a render it can never accept as `remote_state: "failed"` — the delivery state the commit
 * says Story "already reads as a remote refusal and falls back locally from". Story did not: it
 * wrote a `recovery_hold` for `remote_failed` and then stopped for ever. The reconciler returns
 * false for any hold, the monitor returns early for any hold, and `isRefusedFinalRenderReceipt`
 * demanded `phase === 'refused'` with `gateway_job_id === null`, which a submitted render can never
 * be. A settled remote failure must hand the episode back to this Mac and say so.
 */
test('a render the Gateway settles failed finishes on this Mac instead of holding for ever', async () => {
  const monitor = requireReconciler()
  const prepared = await prepareCase('remote-failed')
  gateway.setMode(prepared.key, 'remote-failed')

  // The first observation records the Gateway's own settled verdict as durable, attributable
  // evidence. Driven directly so the test owns the timing (the scheduler's own clock is exercised
  // by its dedicated backoff test).
  await requireReconcileOne()(prepared.job.project_slug, prepared.job.job_id)
  const settled = await canonicalMarker(prepared)
  assert.equal(settled.phase, 'remote_failed',
    'a settled remote failure is its own phase, not a hold that nothing advances')
  assert.equal(settled.gateway_job_id, prepared.marker.gateway_job_id,
    'the bound Gateway id is kept, so the verdict is attributable to this render')
  const events = (await revisions(prepared))
    .map(item => JSON.parse(item.bytes.toString('utf8')) as Record<string, any>)
  assert.ok(events.some(item => item.payload?.reason === 'remote_failed'),
    "the Gateway's failed answer is recorded rather than discarded")

  // The next passes must hand the episode to the local lane rather than wait for ever. The
  // scheduler advances a bounded batch per pass, so drive it until this row has been reached.
  let job: any = null
  for (let pass = 0; pass < 40; pass++) {
    await monitor.runFinalRenderReconcilePassForTesting()
    job = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0]
    const reached = ((job?.output_lines || []) as string[])
      .some(line => /renders on this Mac/i.test(line))
    if (reached || job?.status !== 'running') break
  }
  const lines: string[] = job.output_lines || []
  assert.ok(lines.some(line => /renders on this Mac/i.test(line)),
    `the job must say the video renders here; its last lines were ${JSON.stringify(lines.slice(-6))}`)
  assert.notEqual(job.status, 'error', 'a settled remote failure is a local fallback, not an error')
  assert.equal(queue.hasFinalRenderMonitorTransientHold(prepared.job.project_slug, prepared.job.job_id), false,
    'the settled row no longer needs an attention hold')
})

/**
 * The fallback must state the real reason. Two settled outcomes reach this Mac and they mean
 * different things: a refused render never became a remote job, while a settled failure ran (or may
 * have run) on a fleet Mac. The owner reads one line, and it must say which one happened — AGENTS
 * §1/§8: name what happened and never a reason the customer will mistake for another.
 */
test('the local fallback names a settled remote failure as its own outcome, not a refusal', async () => {
  const monitor = requireReconciler()
  const refused = await prepareCase('message-refused')
  // A definite refusal is the POST the Gateway never accepted, so no Gateway id is bound.
  assert.equal((await canonicalMarker(refused)).gateway_job_id !== null, true,
    'this fixture starts from an accepted render')

  const failed = await prepareCase('message-remote-failed')
  gateway.setMode(failed.key, 'remote-failed')
  await requireReconcileOne()(failed.job.project_slug, failed.job.job_id)

  let job: any = null
  for (let pass = 0; pass < 40; pass++) {
    await monitor.runFinalRenderReconcilePassForTesting()
    job = (await queue.getJobs(failed.job.project_slug, { view: 'full' }))[0]
    if (((job?.output_lines || []) as string[]).some(line => /renders on this Mac/i.test(line))) break
  }
  const line = ((job?.output_lines || []) as string[]).find(value => /renders on this Mac/i.test(value))
  assert.ok(line, 'the fallback states a reason')
  assert.match(line!, /settled this render as failed/i,
    'the line says the Gateway settled it failed')
  assert.equal(/refused/i.test(line!), false,
    'a settled failure is not described as a refusal: no refusal happened on that Gateway')
})
