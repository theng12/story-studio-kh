import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { after, before, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CompositionOpts } from '../generators/video.js'
import type { FinalCheckExpectation, FinalCheckResult } from '../lib/final-video-check.js'
import type { LoudnessTarget } from '../lib/final-loudness.js'
import type { FinalRenderCapabilities, FinalRenderJobView, FinalRenderOutputReceipt } from '../lib/final-render-gateway-client.js'
import type { TrashIndexEntry } from '../lib/trash-move.js'
import type { FinalRenderTransportReceiptV3, Job } from '../models/types.js'
import { waitFor } from './_timing.js'

const LOOPBACK_SUPERTEST_PRELOAD = '../../../scripts/testing/loopback-supertest.mjs'

type ProjectManagerModule = typeof import('../services/project-manager.js')
type StagingModule = typeof import('../services/final-render-staging.js')
type TrashModule = typeof import('../lib/trash-move.js')
type QueueModule = typeof import('../services/job-queue.js')
type TransportModule = typeof import('../services/final-render-transport.js')
type SettingsModule = typeof import('../services/app-settings.js')
type IdentityModule = typeof import('../services/private-render-identity.js')
type SafeStorageModule = typeof import('./safe-storage-test-double.js')
type EvidenceModule = typeof import('../lib/final-render-transport-evidence.js')
type MediaModule = typeof import('../lib/ffmpeg-validation.js') & {
  classifyFinalRenderContainerEvidence: (input: {
    containerNames: string[]
    containerBrand: string | null
  }) => 'mp4' | 'mov' | 'webm' | 'unknown'
}
type ImportProbe = {
  phase: string
  candidate_path?: string
  destination_path?: string
  project_slug: string
  job_id: string
}
type MediaObservation = {
  durationSec: number
  videoDurationSec: number | null
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string
  audioCodec: string
  width: number
  height: number
  frameRate: number
  containerNames: string[]
  containerBrand: string | null
  container: 'mp4' | 'mov' | 'webm' | 'unknown'
  loudness: { lufs: number; true_peak_db: number }
}
type SharedFinalCheckRequest = {
  code: string
  format: string
  finalPath: string
  plannedSec: number
  expected: FinalCheckExpectation
  loudness: LoudnessTarget
  stagedCandidate: boolean
}
type SharedFinalCheckResult = FinalCheckResult
type ImporterModule = {
  recoverFinalRenderImport: (projectSlug: string, jobId: string) => Promise<void>
  _setFinalRenderImportHooksForTesting: (hooks: {
    inspectMedia?: (pathname: string) => Promise<MediaObservation>
    probe?: (value: ImportProbe) => void | Promise<void>
    verifyFinal?: (job: Job, request: SharedFinalCheckRequest) => Promise<SharedFinalCheckResult | null>
  }) => () => void
}
type WireCall = { method: string; url: string; body: Buffer; headers: Headers }
type BlobState = { sha256: string; size_bytes: number; offset: number }
type Accepted = {
  id: string
  key: string
  bytes: Buffer
  body: Record<string, unknown>
  packetDigest: string
  acknowledged: boolean
}
type CompositionWithAuthority = CompositionOpts & {
  code: string
  titleHint: string
  videoDir: string
  resolvedLoudness: { lufs: number; true_peak_db: number; tolerance_pct: number; check: 'off' | 'warn' | 'block' }
}

const ORIGIN = 'https://gateway.private.example'
const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const BEARER = 'ab'.repeat(32)
const BASE_BYTES = Buffer.from('retained importer base video\n')
const AUDIO_BYTES = Buffer.from('retained importer premixed audio\n')
const OUTPUT_BYTES = Buffer.alloc(8 * 1024 * 1024 + 37, 0x6d)
const OUTPUT_SHA = createHash('sha256').update(OUTPUT_BYTES).digest('hex')
/** The exact plan these fixtures freeze for their 2 s, 128x96, files-only render. */
const FINAL_CHECK_PLAN = {
  planned_sec: 2, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
  width: 128, height: 96, subtitles_path: null, speech_end_sec: 2,
}
const DEFAULT_RESOLVED_LOUDNESS = { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' as const }
const fixtureParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../_trash/test-fixtures')
const originalFetch = globalThis.fetch
const environmentKeys = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP',
] as const
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]))

let retainedRoot = ''
let canaryPath = ''
let storyInstanceId = ''
let pm: ProjectManagerModule
let staging: StagingModule
let trash: TrashModule
let queue: QueueModule
let transport: TransportModule
let settings: SettingsModule
let identity: IdentityModule
let safeStorage: SafeStorageModule | undefined
let evidence: EvidenceModule
let media: MediaModule
let importer: ImporterModule | null = null
let serial = 0
const trackedJobIds = new Set<string>()

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.keys(entry as Record<string, unknown>).sort()
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
    canvas_pairs: [{ width: 128, height: 96 }], working_fps: [5], max_duration_sec: 60,
    max_operations: 32, max_assets: 32, max_asset_bytes: 16 * 1024 * 1024,
    max_total_input_bytes: 32 * 1024 * 1024, max_pixel_frames: 128 * 96 * 5 * 60,
    scratch_reserve_bytes: 1, output_limit_bytes: 16 * 1024 * 1024,
    process_tree_rss_limit_bytes: 1024 * 1024, cumulative_wall_seconds: 60,
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
    owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID, story_instance_id: storyInstanceId,
    eligible: 0, idle: 0, server_time: Math.floor(Date.now() / 1000),
    profile_descriptor_utf8: PROFILE_UTF8, profile_digest: PROFILE_DIGEST,
    tools: { descriptor_utf8: TOOLS_UTF8, digest: TOOLS_DIGEST },
    compiler: { descriptor_utf8: COMPILER_UTF8, digest: COMPILER_DIGEST },
  }
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

class FakeGateway {
  readonly calls: WireCall[] = []
  readonly blobs = new Map<string, BlobState>()
  readonly accepted = new Map<string, Accepted>()
  ackMode: 'observed' | 'unknown-recorded' | 'unknown-unrecorded' = 'observed'
  viewMode: 'output-ready' | 'foreign' | 'missing' = 'output-ready'

  resetCalls(): void { this.calls.length = 0 }

  callsFor(key: string): WireCall[] {
    const accepted = this.accepted.get(key)
    const byKey = `/v1/final-renders/by-idempotency-key/${encodeURIComponent(key)}`
    const byId = accepted ? `/v1/final-renders/${accepted.id}` : ''
    return this.calls.filter(call => {
      const pathname = new URL(call.url).pathname
      return pathname === byKey || pathname.startsWith(`${byKey}/`)
        || (byId !== '' && (pathname === byId || pathname.startsWith(`${byId}/`)))
    })
  }

  private blobPublic(state: BlobState): Record<string, unknown> {
    if (state.offset === 0) return {
      format: 'studio.render.gateway-blob.v1', sha256: state.sha256,
      size_bytes: state.size_bytes, state: 'missing', offset: 0,
    }
    const uploadId = state.sha256.slice(32)
    if (state.offset === state.size_bytes) return {
      format: 'studio.render.gateway-blob.v1', sha256: state.sha256,
      size_bytes: state.size_bytes, state: 'complete', offset: state.offset,
      upload_id: uploadId, asset_handle: state.sha256.slice(0, 32),
    }
    return {
      format: 'studio.render.gateway-blob.v1', sha256: state.sha256,
      size_bytes: state.size_bytes, state: 'uploading', offset: state.offset, upload_id: uploadId,
    }
  }

  private outputReceipt(entry: Accepted): { utf8: string; digest: string } {
    const utf8 = canonicalJson({
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
      selected_machine: { id: 'node-m4-a', label: 'Private M4', chip: 'Apple M4', memory_gb: 32,
        hardware_class: 'mac-m4-32gb' },
      profile_digest: PROFILE_DIGEST, tools_digest: TOOLS_DIGEST,
      compiler_digest: COMPILER_DIGEST, qualification_digest: '3'.repeat(64),
      selected_tier: 'software-h264', generated_command_digest: '4'.repeat(64), feature_losses: [],
      output_sha256: OUTPUT_SHA, output_size_bytes: OUTPUT_BYTES.byteLength,
    })
    return { utf8, digest: sha256(utf8) }
  }

  private view(entry: Accepted): Record<string, unknown> {
    const receipt = this.outputReceipt(entry)
    const result: Record<string, unknown> = {
      format: 'studio.render.gateway-job.v1', id: entry.id,
      state: entry.acknowledged ? 'acknowledged' : 'output_ready',
      gateway_attempt_key: entry.key, story_uuid: entry.body.story_uuid,
      intent_id: entry.body.intent_id, attempt_no: entry.body.attempt_no,
      output_ready: true, idempotent_replay: true, remote_state: 'output_ready',
      receipt_digest: receipt.digest,
      output: { sha256: OUTPUT_SHA, size_bytes: OUTPUT_BYTES.byteLength,
        receipt_digest: receipt.digest, receipt_utf8: receipt.utf8 },
    }
    if (this.viewMode === 'foreign') result.story_uuid = '99999999-9999-4999-8999-999999999999'
    return result
  }

  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const call: WireCall = {
      method: init.method ?? 'GET', url: String(input), body: await requestBody(init),
      headers: new Headers(init.headers),
    }
    this.calls.push(call)
    assert.equal(call.headers.get('Authorization'), `Bearer ${BEARER}`)
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
      const body = JSON.parse(call.body.toString('utf8')) as Record<string, unknown>
      const id = `55555555-5555-4555-8555-${String(++serial).padStart(12, '0')}`
      const entry: Accepted = {
        id, key, bytes: Buffer.from(call.body), body,
        packetDigest: sha256(JSON.stringify(body.packet)), acknowledged: false,
      }
      this.accepted.set(key, entry)
      return Response.json({
        format: 'studio.render.gateway-job.v1', id, state: 'accepted',
        gateway_attempt_key: key, story_uuid: body.story_uuid, intent_id: body.intent_id,
        attempt_no: body.attempt_no, output_ready: false, idempotent_replay: false,
        remote_state: 'rendering', destination_node: 'node-m4-a',
        inbound_story_body_sha256: sha256(call.body),
      }, { status: 202 })
    }
    const keyLookup = /^\/v1\/final-renders\/by-idempotency-key\/([^/]+)$/.exec(url.pathname)
    if (keyLookup && call.method === 'GET') {
      const entry = this.accepted.get(decodeURIComponent(keyLookup[1]))
      if (!entry || this.viewMode === 'missing') return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
      return Response.json(this.view(entry))
    }
    const output = /^\/v1\/final-renders\/([0-9a-f-]{36})\/output$/.exec(url.pathname)
    if (output && call.method === 'GET') {
      const entry = [...this.accepted.values()].find(item => item.id === output[1])
      assert.ok(entry)
      const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(call.headers.get('Range') ?? '')
      assert.ok(match)
      const start = Number(match[1])
      const end = Number(match[2])
      const bytes = OUTPUT_BYTES.subarray(start, end + 1)
      return new Response(new Uint8Array(bytes), { status: 206, headers: {
        'Accept-Ranges': 'bytes', ETag: `"${OUTPUT_SHA}"`, 'Content-Type': 'video/mp4',
        'Content-Length': String(bytes.byteLength),
        'Content-Range': `bytes ${start}-${end}/${OUTPUT_BYTES.byteLength}`,
      } })
    }
    const ack = /^\/v1\/final-renders\/([0-9a-f-]{36})\/ack$/.exec(url.pathname)
    if (ack && call.method === 'POST') {
      const entry = [...this.accepted.values()].find(item => item.id === ack[1])
      assert.ok(entry)
      const body = JSON.parse(call.body.toString('utf8')) as { expected_receipt_digest: string }
      if (this.ackMode === 'unknown-recorded') {
        entry.acknowledged = true
        throw new Error('controlled lost ACK reply after durable Gateway acceptance')
      }
      if (this.ackMode === 'unknown-unrecorded') {
        throw new Error('controlled lost ACK reply before Gateway acceptance')
      }
      entry.acknowledged = true
      return Response.json({
        format: 'studio.render.gateway-ack.v1', id: entry.id,
        acknowledged: true, receipt_digest: body.expected_receipt_digest,
      })
    }
    const byId = /^\/v1\/final-renders\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (byId && call.method === 'GET') {
      const entry = [...this.accepted.values()].find(item => item.id === byId[1])
      assert.ok(entry)
      return Response.json(this.view(entry))
    }
    throw new Error(`unexpected fake Gateway request ${call.method} ${call.url}`)
  }
}

const gateway = new FakeGateway()

function requireImporter(): ImporterModule {
  assert.ok(importer, 'output import slice exports the retained final-render importer')
  return importer
}

function mediaObservation(overrides: Partial<MediaObservation> = {}): MediaObservation {
  return {
    durationSec: 2, videoDurationSec: 2, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac',
    width: 128, height: 96, frameRate: 5,
    containerNames: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'], containerBrand: 'isom', container: 'mp4',
    loudness: { lufs: -14, true_peak_db: -1 }, ...overrides,
  }
}

/**
 * A passing stand-in for the shared final checks. These fixtures download filler bytes, so the
 * app's real media passes cannot run here; the importer's production path always runs them. The
 * stand-in still refuses a request that does not carry the frozen plan or the right file name, so
 * the fixture cannot quietly check the wrong thing.
 */
function passingSharedFinalCheck(job: Job, request: SharedFinalCheckRequest): Promise<SharedFinalCheckResult> {
  assert.deepEqual(request.expected, FINAL_CHECK_PLAN, 'the check measures the frozen plan')
  assert.ok(request.plannedSec > 0, 'the check measures the plan\'s own length')
  assert.match(request.code, /^EP\d+$/)
  assert.equal(request.format, 'mp4')
  if (request.stagedCandidate) {
    assert.ok(request.finalPath.includes(`.${request.code}_final_video.${request.format}.`),
      'the pre-publication check runs on the downloaded candidate')
  } else {
    assert.equal(path.basename(request.finalPath), `${request.code}_final_video.${request.format}`,
      'the post-publication check runs on the published final')
  }
  job.result = { ...(job.result || {}), final_check: { passed: true, issues: [] } }
  return Promise.resolve({
    checked_at: '2026-10-15T00:00:00.000Z',
    file: { size: OUTPUT_BYTES.length, mtime_ms: 0 },
    expected: structuredClone(request.expected),
    actual: {
      duration_sec: request.plannedSec, video_sec: request.plannedSec, audio_sec: request.plannedSec,
      width: request.expected.width, height: request.expected.height,
      tail_lufs: null, black: [], silence: [],
    },
    passed: true,
    issues: [],
  })
}

type ImportHooksArg = {
  inspectMedia?: (pathname: string) => Promise<MediaObservation>
  probe?: (value: ImportProbe) => void | Promise<void>
  verifyFinal?: ((job: Job, request: SharedFinalCheckRequest) => Promise<SharedFinalCheckResult | null>) | 'real'
}

function installHooks(t: TestContext, hooks: ImportHooksArg = {}): void {
  const { verifyFinal, ...rest } = hooks
  const restore = requireImporter()._setFinalRenderImportHooksForTesting({
    inspectMedia: async () => mediaObservation(),
    ...(verifyFinal === 'real' ? {} : { verifyFinal: verifyFinal ?? passingSharedFinalCheck }),
    ...rest,
  })
  t.after(restore)
}


function observeTrashIndexIo(t: TestContext, indexPath: string) {
  const failedWrites: NodeJS.ErrnoException[] = []
  const synced: string[] = []
  const descriptors = new Map<number, string>()
  const append = nodeFs.appendFileSync
  const openSync = nodeFs.openSync
  const fsync = nodeFs.fsyncSync
  const close = nodeFs.closeSync
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, 'open')!
  const open = fs.open
  const target = (value: unknown) => typeof value === 'number' ? descriptors.has(value)
    : typeof value === 'string' && path.resolve(value) === indexPath
  const appendMock = t.mock.method(nodeFs, 'appendFileSync', (...args: Parameters<typeof nodeFs.appendFileSync>) => {
    try { return append(...args) } catch (error) {
      if (target(args[0])) failedWrites.push(error as NodeJS.ErrnoException)
      throw error
    }
  })
  const openMock = t.mock.method(nodeFs, 'openSync', (...args: Parameters<typeof nodeFs.openSync>) => {
    try {
      const descriptor = openSync(...args)
      if (target(args[0]) && nodeFs.fstatSync(descriptor).isFile()) descriptors.set(descriptor, indexPath)
      return descriptor
    } catch (error) {
      if (target(args[0])) failedWrites.push(error as NodeJS.ErrnoException)
      throw error
    }
  })
  const syncMock = t.mock.method(nodeFs, 'fsyncSync', (descriptor: number) => {
    fsync(descriptor)
    if (descriptors.has(descriptor)) synced.push(indexPath)
  })
  const closeMock = t.mock.method(nodeFs, 'closeSync', (descriptor: number) => {
    close(descriptor)
    descriptors.delete(descriptor)
  })
  Object.defineProperty(fs, 'open', {
    ...openDescriptor,
    value: async (...args: Parameters<typeof fs.open>) => {
      try {
        const handle = await open(...args)
        if (target(args[0]) && (await handle.stat()).isFile()) {
          const sync = handle.sync.bind(handle)
          handle.sync = async () => { await sync(); synced.push(indexPath) }
        }
        return handle
      } catch (error) {
        if (target(args[0])) failedWrites.push(error as NodeJS.ErrnoException)
        throw error
      }
    },
  })
  syncBuiltinESMExports()
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    Object.defineProperty(fs, 'open', openDescriptor)
    for (const mocked of [appendMock, openMock, syncMock, closeMock]) mocked.mock.restore()
    syncBuiltinESMExports()
  }
  t.after(restore)
  return { failedWrites, synced, restore }
}

type MediaIoMeasurement = {
  reads: Array<{ pathname: string; requested: number; bytesRead: number; afterAckObserved: boolean }>
  readFiles: string[]
  allocations: Array<{ method: 'alloc' | 'allocUnsafe'; size: number }>
  restore: () => void
}

function measureActualMediaIo(
  t: TestContext,
  mediaPaths: readonly string[],
  afterAckObserved: () => boolean,
): MediaIoMeasurement {
  const targets = new Set(mediaPaths.map(value => path.resolve(value)))
  const reads: MediaIoMeasurement['reads'] = []
  const readFiles: string[] = []
  const allocations: MediaIoMeasurement['allocations'] = []
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, 'open')!
  const readFileDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFile')!
  const allocDescriptor = Object.getOwnPropertyDescriptor(Buffer, 'alloc')!
  const allocUnsafeDescriptor = Object.getOwnPropertyDescriptor(Buffer, 'allocUnsafe')!
  const originalOpen = fs.open
  const originalReadFile = fs.readFile
  const originalAlloc = Buffer.alloc
  const originalAllocUnsafe = Buffer.allocUnsafe
  const pathnameOf = (value: unknown): string | null => {
    if (typeof value === 'string') return path.resolve(value)
    if (value instanceof URL) return path.resolve(fileURLToPath(value))
    if (Buffer.isBuffer(value)) return path.resolve(value.toString())
    return null
  }
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    Object.defineProperty(fs, 'open', openDescriptor)
    Object.defineProperty(fs, 'readFile', readFileDescriptor)
    Object.defineProperty(Buffer, 'alloc', allocDescriptor)
    Object.defineProperty(Buffer, 'allocUnsafe', allocUnsafeDescriptor)
  }
  t.after(restore)
  Object.defineProperty(fs, 'open', {
    ...openDescriptor,
    value: async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fs, args) as Awaited<ReturnType<typeof fs.open>>
      const pathname = pathnameOf(args[0])
      if (!pathname || !targets.has(pathname)) return handle
      const originalRead = handle.read
      Object.defineProperty(handle, 'read', {
        configurable: true,
        writable: true,
        value: async (...readArgs: unknown[]) => {
          const requested = typeof readArgs[2] === 'number'
            ? readArgs[2]
            : ArrayBuffer.isView(readArgs[0]) ? readArgs[0].byteLength : 0
          const result = await Reflect.apply(originalRead, handle, readArgs) as { bytesRead: number }
          reads.push({ pathname, requested, bytesRead: result.bytesRead, afterAckObserved: afterAckObserved() })
          return result
        },
      })
      return handle
    },
  })
  Object.defineProperty(fs, 'readFile', {
    ...readFileDescriptor,
    value: async (...args: unknown[]) => {
      const pathname = pathnameOf(args[0])
      if (pathname && targets.has(pathname)) readFiles.push(pathname)
      return Reflect.apply(originalReadFile, fs, args)
    },
  })
  Object.defineProperty(Buffer, 'alloc', {
    ...allocDescriptor,
    value: (size: number, ...args: unknown[]) => {
      allocations.push({ method: 'alloc', size })
      return Reflect.apply(originalAlloc, Buffer, [size, ...args])
    },
  })
  Object.defineProperty(Buffer, 'allocUnsafe', {
    ...allocUnsafeDescriptor,
    value: (size: number) => {
      allocations.push({ method: 'allocUnsafe', size })
      return originalAllocUnsafe(size)
    },
  })
  return { reads, readFiles, allocations, restore }
}

async function settle(): Promise<void> {
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
  retainedRoot = await fs.mkdtemp(path.join(trustedFixtureParent, 'final-render-import-retained-'))
  await fs.chmod(retainedRoot, 0o700)
  const retainedStat = await fs.lstat(retainedRoot)
  assert.equal(retainedStat.isDirectory() && !retainedStat.isSymbolicLink(), true)
  assert.equal(retainedStat.mode & 0o077, 0, 'retained fixture child must be private')
  assert.equal(path.dirname(await fs.realpath(retainedRoot)), trustedFixtureParent,
    'retained fixture child must remain directly beneath the trusted parent')
  canaryPath = path.join(retainedRoot, 'retained-canary.txt')
  await fs.writeFile(canaryPath, 'final-render-import-retained\n', { mode: 0o600 })
  for (const key of environmentKeys) process.env[key] = retainedRoot
  await import(LOOPBACK_SUPERTEST_PRELOAD)
  safeStorage = await import('./safe-storage-test-double.js')
  safeStorage.installTestSafeStorage()
  await installPackagedDescriptorFixture()
  safeStorage.setTestSafeStorageAvailable(true)
  settings = await import('../services/app-settings.js')
  pm = await import('../services/project-manager.js')
  staging = await import('../services/final-render-staging.js')
  trash = await import('../lib/trash-move.js')
  identity = await import('../services/private-render-identity.js')
  transport = await import('../services/final-render-transport.js')
  evidence = await import('../lib/final-render-transport-evidence.js')
  media = await import('../lib/ffmpeg-validation.js') as MediaModule
  queue = await import('../services/job-queue.js')
  importer = await import('../services/final-render-import.js').catch(error => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_MODULE_NOT_FOUND' && error instanceof Error
        && error.message.includes('/services/final-render-import')) return null
    throw error
  }) as ImporterModule | null
  await settings.setGenStudioUrl(ORIGIN)
  const privateIdentity = await identity.getOrCreatePrivateRenderIdentity()
  storyInstanceId = privateIdentity.story_instance_id
  await (await import('../services/app-secrets-store.js')).setApiKey('genstudio', BEARER)
  await identity.pinGatewayBinding({ origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  await settings.setPrivateFinalRenderSetting({ enabled: true })
  globalThis.fetch = gateway.fetch.bind(gateway)
})

after(async () => {
  let settled = false
  let failure: unknown
  try {
    await settle()
    settled = true
    assert.equal(await fs.readFile(canaryPath, 'utf8'), 'final-render-import-retained\n')
  } catch (error) {
    failure = error
  } finally {
    if (settled || !queue) {
      globalThis.fetch = originalFetch
      try {
        restoreElectron?.()
        if (safeStorage) safeStorage.setTestSafeStorageAvailable(true)
      } finally {
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  }
  if (failure) throw failure
})

function makeJob(slug: string, id: string, pipeline = false): Job {
  trackedJobIds.add(id)
  return {
    job_id: id, project_slug: slug, type: 'video_assembly', episode_id: 'EP1',
    title: 'Retained final-render import', status: 'running',
    created_at: '2026-10-15T00:00:00.000Z', started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null, error: null, output_lines: [],
    params: pipeline ? {
      retained: true,
      pipeline_chain: [{ type: 'audio', title: 'Next audio', params: { retained_child: true } }],
    } : { retained: true },
  }
}

async function writeJob(job: Job): Promise<void> {
  const projectDir = pm.getProjectDir(job.project_slug) ?? path.join(retainedRoot, 'projects', job.project_slug)
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(projectDir, 'jobs.json'), `${JSON.stringify({ jobs: [job] })}\n`, { mode: 0o600 })
  queue._forgetProjectPersistenceForTesting(job.project_slug)
}

type Prepared = {
  job: Job
  key: string
  intentDir: string
  destination: string
  marker: FinalRenderTransportReceiptV3
  manifest: Record<string, unknown>
}

async function canonicalMarker(prepared: Pick<Prepared, 'job'>): Promise<FinalRenderTransportReceiptV3> {
  const job = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.ok(job)
  const marker = job.final_render_remote_wait
  if (!marker || marker.version !== 3) assert.fail('expected authoritative V3 final-render receipt')
  return structuredClone(marker)
}

type PrepareOptions = {
  slug?: string
  videoDir?: string
  priorDestinationBytes?: Buffer
  priorDestinationPath?: string
  resolvedLoudness?: CompositionWithAuthority['resolvedLoudness']
  finalCheckExpected?: CompositionWithAuthority['finalCheckExpected']
  narrationOffsetSec?: number
  /** Simulate an intent staged by a build that did not freeze a render plan. */
  withoutPlan?: boolean
  resolveExternalFinalVideoDir?: Parameters<StagingModule['_setFinalRenderStagingHooksForTesting']>[0]['resolveExternalFinalVideoDir']
  prepareJob?: (job: Job) => Promise<void>
}

async function prepareOutputReady(
  label: string, pipeline = false, options: PrepareOptions = {},
): Promise<Prepared> {
  const index = ++serial
  gateway.ackMode = 'observed'
  gateway.viewMode = 'output-ready'
  const slug = options.slug ?? `import-${label}-${process.pid}-${index}`
  const sourceDir = path.join(retainedRoot, 'work', slug, 'sources')
  const videoDir = options.videoDir ?? path.join(retainedRoot, 'work', slug, 'video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(videoDir, { recursive: true, mode: 0o700 })
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  await fs.writeFile(base, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(audio, AUDIO_BYTES, { mode: 0o600 })
  const job = makeJob(slug, `import-${index.toString(36)}`, pipeline)
  await options.prepareJob?.(job)
  // generateVideo always saves these before it hands the composition over; a fixture that does
  // not model that (and is not simulating a build without a plan) gets the same baseline.
  if (!options.withoutPlan && !job.result?.final_render_finish?.code) {
    job.result = {
      ...(job.result || {}),
      final_render_finish: { code: job.episode_id, visual_source: 'scene_plan', image_pool: null },
    }
  }
  await writeJob(job)
  if (options.priorDestinationBytes) {
    await fs.writeFile(
      options.priorDestinationPath ?? path.join(videoDir, 'EP1_final_video.mp4'), options.priorDestinationBytes,
      { flag: 'wx', mode: 0o600 },
    )
  }
  const composition: CompositionWithAuthority = {
    videoInputPath: base, premixedAudioPath: audio, targetDuration: 2,
    w: 128, h: 96, quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4', outputFile: path.join(sourceDir, 'must-never-render-locally.mp4'),
    encodingEffort: 'ultrafast', codec: 'h264', code: 'EP1', titleHint: `Title ${label}`,
    videoDir, job,
    resolvedLoudness: options.resolvedLoudness ?? DEFAULT_RESOLVED_LOUDNESS,
    narrationOffsetSec: options.narrationOffsetSec,
    ...(options.withoutPlan ? {} : { finalCheckExpected: options.finalCheckExpected ?? FINAL_CHECK_PLAN }),
  }
  const restoreStaging = options.resolveExternalFinalVideoDir
    ? staging._setFinalRenderStagingHooksForTesting({
        resolveExternalFinalVideoDir: options.resolveExternalFinalVideoDir,
      })
    : () => undefined
  try {
    assert.deepEqual(await transport.preparePrivateFinalRenderDescriptor(composition), {
      kind: 'video-assembly-remote-wait',
    })
  } finally {
    restoreStaging()
  }
  await transport.advanceSealedPrivateFinalRenderTransport(slug, job.job_id)
  let marker = await canonicalMarker({ job })
  const key = String(marker.gateway_attempt_key)
  const accepted = gateway.accepted.get(key)
  assert.ok(accepted)
  accepted.packetDigest = String(marker.packet_sha256)
  await transport.reconcileSealedPrivateFinalRenderOnce(slug, job.job_id)
  marker = await canonicalMarker({ job })
  assert.equal(marker.phase, 'output_ready')
  const intentDir = path.join(retainedRoot, 'private-render', 'intents', String(marker.intent_id))
  const manifest = JSON.parse(await fs.readFile(path.join(intentDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const destination = String((manifest.destination as Record<string, unknown>).pathname)
  gateway.resetCalls()
  return { job, key, intentDir, destination, marker, manifest }
}

async function revisionEntries(prepared: Prepared): Promise<Array<{ name: string; bytes: Buffer }>> {
  const directory = path.join(prepared.intentDir, 'transport', 'revisions')
  const names = (await fs.readdir(directory)).sort()
  return Promise.all(names.map(async name => ({
    name, bytes: await fs.readFile(path.join(directory, name)),
  })))
}

async function revisions(prepared: Prepared): Promise<Array<Record<string, unknown>>> {
  return (await revisionEntries(prepared)).map(item => (
    JSON.parse(item.bytes.toString('utf8')) as Record<string, unknown>
  ))
}

type EvidenceInput = Parameters<EvidenceModule['validateFinalRenderTransportEvidence']>[0]

function stagedRoot(marker: FinalRenderTransportReceiptV3): EvidenceInput['staged'] {
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
    canonical: marker,
    manifestBytes: await fs.readFile(path.join(prepared.intentDir, 'manifest.json')),
    revisions: await revisionEntries(prepared),
    requestBytes: await fs.readFile(path.join(prepared.intentDir, 'transport', 'request.json')),
    submissionBytes: await fs.readFile(path.join(prepared.intentDir, 'transport', 'submission.json')),
  }
}

async function terminal(prepared: Prepared): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(prepared.intentDir, 'final-render-terminal.json'), 'utf8')) as Record<string, unknown>
}

type RevisionValue = ReturnType<EvidenceModule['validateFinalRenderTransportEvidence']>['records'][number]['value']

function remapRevisionHashes(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value
  if (Array.isArray(value)) return value.map(item => remapRevisionHashes(item, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, remapRevisionHashes(item, replacements)]))
  }
  return value
}

function forgedEvidence(
  input: EvidenceInput,
  mutate: (records: RevisionValue[]) => void,
): EvidenceInput {
  const parsed = [...input.revisions].sort((a, b) => a.name.localeCompare(b.name)).map(file => ({
    originalSha256: /^\d{8}-([0-9a-f]{64})\.json$/.exec(file.name)?.[1] ?? assert.fail('revision name'),
    value: JSON.parse(Buffer.from(file.bytes).toString('utf8')) as RevisionValue,
  }))
  mutate(parsed.map(item => item.value))
  const replacements = new Map<string, string>()
  let previousSha256: string | null = null
  let canonical: EvidenceInput['canonical'] = structuredClone(input.staged)
  const revisions = parsed.map((item, index) => {
    const value = structuredClone(item.value)
    value.sequence = index + 1
    value.previous_sha256 = previousSha256
    value.canonical_before_sha256 = evidence.finalRenderCanonicalReceiptHash(canonical)
    value.payload = remapRevisionHashes(value.payload, replacements) as Record<string, unknown>
    const bytes = Buffer.from(JSON.stringify(value), 'utf8')
    const nextSha256 = sha256(bytes)
    replacements.set(item.originalSha256, nextSha256)
    previousSha256 = nextSha256
    if (value.payload.after && typeof value.payload.after === 'object') {
      canonical = {
        ...(value.payload.after as Omit<FinalRenderTransportReceiptV3, 'transport_revision_sha256'>),
        transport_revision_sha256: nextSha256,
      }
    }
    return { name: `${String(index + 1).padStart(8, '0')}-${nextSha256}.json`, bytes }
  })
  return { ...input, canonical, revisions }
}

// A fresh Node owns every boot read; no query-string import or in-process queue reset stands in for restart.
async function coldLoadImportQueue(acknowledged: Prepared, cancelled: Prepared, dispatchLog: string) {
  const childSource = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs/promises'
    const [projectSlug, parentId, cancelledSlug, cancelledId, dispatchLog] = process.argv.slice(1)
    await import(${JSON.stringify(new URL(LOOPBACK_SUPERTEST_PRELOAD, import.meta.url).href)})
    const storage = await import(${JSON.stringify(new URL('./safe-storage-test-double.ts', import.meta.url).href)})
    storage.installTestSafeStorage()
    storage.setTestSafeStorageAvailable(true)
    let networkCalls = 0
    globalThis.fetch = async () => { networkCalls++; throw new Error('cold boot must not contact a provider') }
    const queue = await import(${JSON.stringify(new URL('../services/job-queue.ts', import.meta.url).href)})
    const { waitFor } = await import(${JSON.stringify(new URL('./_timing.ts', import.meta.url).href)})
    const childId = 'pipeline-handoff-' + parentId
    assert.equal(queue.getJob(parentId), null, 'fresh module has no inherited live parent')
    assert.equal(queue.getJob(cancelledId), null, 'fresh module has no inherited cancelled parent')
    queue.registerExecutor('audio', async child => {
      assert.equal(child.job_id, childId, 'only the saved exact continuation may run')
      await fs.appendFile(dispatchLog, child.job_id + '\\n', { mode: 0o600 })
      child.result = { complete: true, completion: { label: 'Cold-load child', expected: 1, completed: 1, complete: true } }
    })
    await queue.initializeQueuePauseState()
    await queue.resumeInterruptedJobsAtBoot()
    assert.equal(queue.areBootJobsLoaded(), true)
    if (queue.getJob(childId)) {
      await waitFor(() => !queue._isJobWorkerActiveForTesting(childId)
        && queue.getJob(childId)?.status === 'done', {
        label: 'cold-load exact handoff worker settlement', timeoutMs: 5_000, maxWallClockMs: 20_000,
      })
    }
    await queue._waitForJobPersistenceForTesting()
    const report = {
      pid: process.pid, networkCalls,
      acknowledged: queue.getJob(parentId),
      cancelled: queue.getJob(cancelledId),
      child: queue.getJob(childId),
      cancelledChild: queue.getJob('pipeline-handoff-' + cancelledId),
      acknowledgedDisk: await queue.loadAuthoritativeJob(projectSlug, parentId),
      cancelledDisk: await queue.loadAuthoritativeJob(cancelledSlug, cancelledId),
      dispatches: await fs.readFile(dispatchLog, 'utf8').then(text => text.trim().split('\\n').filter(Boolean),
        error => { if (error.code === 'ENOENT') return []; throw error }),
    }
    console.log('IMPORT_COLD_LOAD=' + JSON.stringify(report))
  `
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', childSource,
    acknowledged.job.project_slug, acknowledged.job.job_id,
    cancelled.job.project_slug, cancelled.job.job_id, dispatchLog,
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    env: { ...process.env }, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
  })
  const line = stdout.split('\n').find(value => value.startsWith('IMPORT_COLD_LOAD='))
  assert.ok(line, 'fresh boot process must finish and return a settled live/durable snapshot')
  return JSON.parse(line.slice('IMPORT_COLD_LOAD='.length)) as {
    pid: number
    networkCalls: number
    acknowledged: Job | null
    cancelled: Job | null
    child: Job | null
    cancelledChild: Job | null
    acknowledgedDisk: Job | null
    cancelledDisk: Job | null
    dispatches: string[]
  }
}

function outputGets(prepared: Prepared): WireCall[] {
  return gateway.callsFor(prepared.key).filter(call => (
    call.method === 'GET' && new URL(call.url).pathname.endsWith('/output')
  ))
}

function ackPosts(prepared: Prepared): WireCall[] {
  return gateway.callsFor(prepared.key).filter(call => (
    call.method === 'POST' && new URL(call.url).pathname.endsWith('/ack')
  ))
}

// ── The scheduler drives a private final render to done on its own row ─────
// These run first, while the reconcile ring holds only their own rows.

let passClock = 1_900_000_000_000

async function reconcilePasses(count = 1): Promise<void> {
  const reconciler = await import('../services/final-render-reconciler.js')
  for (let pass = 0; pass < count; pass++) {
    passClock += 3_600_000
    await reconciler.runFinalRenderReconcilePassForTesting(passClock)
  }
}

/**
 * What generateVideo leaves on the row before composition: the finish facts with its kept work folder, plus a
 * checkpoint naming that folder (a compilation-layout render has none).
 */
async function rememberFinish(job: Job, checkpoint = true): Promise<string> {
  const { getWorkTempDir } = await import('../lib/work-tempdir.js')
  const { createVideoAssemblyCheckpoint } = await import('../lib/video-assembly-checkpoint.js')
  const workDir = await getWorkTempDir(job.project_slug, job.episode_id)
  await fs.writeFile(path.join(workDir, 'scene_0000.mp4'), 'kept while the fleet renders\n')
  job.result = {
    ...job.result,
    final_render_finish: { code: job.episode_id, visual_source: 'scene_plan', image_pool: null, work_dir: workDir },
    ...(checkpoint ? { video_assembly_checkpoint: createVideoAssemblyCheckpoint(job, workDir, 'c'.repeat(64)) } : {}),
  }
  return workDir
}

function stampPath(destination: string): string {
  return path.join(path.dirname(destination), 'EP1_video_assembly_source.json')
}

async function assertFinishedOnce(job: Job, destination: string, workDir: string): Promise<void> {
  const disk = await queue.loadAuthoritativeJob(job.project_slug, job.job_id)
  assert.equal(disk?.status, 'done')
  assert.equal(disk?.output_lines.filter(line => line === `Video saved: ${path.basename(destination)}`).length, 1,
    'the finish tail runs exactly once')
  assert.equal(disk?.output_dir, path.dirname(destination))
  assert.equal(disk?.result?.video_assembly_checkpoint, undefined, 'the kept checkpoint is cleared')
  await assert.rejects(fs.stat(workDir), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  const stamp = JSON.parse(await fs.readFile(
    path.join(path.dirname(destination), `${job.episode_id}_video_assembly_source.json`), 'utf8',
  )) as { final_video: { size: number } }
  assert.equal(stamp.final_video.size, OUTPUT_BYTES.byteLength, 'stamped from the published file')
}

test('a final render staged by the queue goes to the fleet and comes back done on the same job', async t => {
  if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()
  installHooks(t)
  const project = await pm.createProject({ name: `0 Fleet Lane ${++serial}` })
  const workDirs = new Map<string, string>()
  const calls: string[] = []
  let firstId = ''
  let firstParkedWhenSecondPrepared = false
  // Mirrors generateVideo's boundary: facts saved durably, then the composition is handed over.
  const restore = queue._setExecutorForTesting('video_assembly', async current => {
    calls.push(current.job_id)
    if (calls.length === 2) {
      firstParkedWhenSecondPrepared = !queue._isJobWorkerActiveForTesting(firstId)
        && queue.getJob(firstId)?.status === 'running'
    }
    workDirs.set(current.job_id, await rememberFinish(current))
    await queue.checkpointJobState(current)
    const sourceDir = path.join(retainedRoot, 'work', project.slug, current.episode_id)
    await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(sourceDir, 'base.mp4'), BASE_BYTES, { mode: 0o600 })
    await fs.writeFile(path.join(sourceDir, 'audio.wav'), AUDIO_BYTES, { mode: 0o600 })
    const videoDir = path.join(retainedRoot, 'work', project.slug, `${current.episode_id}-video`)
    await fs.mkdir(videoDir, { recursive: true, mode: 0o700 })
    return await transport.preparePrivateFinalRenderDescriptor({
      videoInputPath: path.join(sourceDir, 'base.mp4'), premixedAudioPath: path.join(sourceDir, 'audio.wav'),
      targetDuration: 2, w: 128, h: 96, quality: { crf: 23, preset: 'ultrafast', fps: 5 },
      format: 'mp4', outputFile: path.join(sourceDir, 'must-never-render-locally.mp4'),
      encodingEffort: 'ultrafast', codec: 'h264', code: current.episode_id, titleHint: `Title ${current.episode_id}`,
      videoDir, job: current,
      resolvedLoudness: DEFAULT_RESOLVED_LOUDNESS,
      finalCheckExpected: FINAL_CHECK_PLAN,
    }) ?? undefined
  })
  t.after(restore)
  const first = queue.enqueuePreparedForTest({
    project_slug: project.slug, episode_id: 'EP1', type: 'video_assembly', title: 'First', params: {},
  })
  firstId = first.job_id
  const second = queue.enqueuePreparedForTest({
    project_slug: project.slug, episode_id: 'EP2', type: 'video_assembly', title: 'Second', params: {},
  })
  const jobs = [first, second]
  for (const job of jobs) trackedJobIds.add(job.job_id)
  await waitFor(() => calls.length === 2 && jobs.every(job => !queue._isJobWorkerActiveForTesting(job.job_id)), {
    label: 'both episodes parked remotely',
  })
  restore()
  await queue._waitForJobPersistenceForTesting()
  assert.deepEqual(calls, [first.job_id, second.job_id])
  assert.equal(firstParkedWhenSecondPrepared, true, 'the first parks and frees the lane before the second prepares')
  for (const job of jobs) {
    assert.equal(queue.getJob(job.job_id)?.status, 'running')
    assert.equal((await queue.loadAuthoritativeJob(project.slug, job.job_id))?.final_render_remote_wait?.version, 2)
  }

  await reconcilePasses()
  for (const job of jobs) {
    const marker = await canonicalMarker({ job })
    assert.equal(marker.phase, 'remote_wait')
    const accepted = gateway.accepted.get(marker.gateway_attempt_key)
    assert.ok(accepted)
    accepted.packetDigest = String(marker.packet_sha256)
  }
  await reconcilePasses()
  for (const job of jobs) assert.equal((await canonicalMarker({ job })).phase, 'output_ready')
  await reconcilePasses()
  await settle()
  for (const job of jobs) {
    const done = await queue.loadAuthoritativeJob(project.slug, job.job_id)
    assert.equal(done?.job_id, job.job_id)
    const destination = String(done?.result?.final_render_destination?.pathname)
    assert.equal(path.basename(destination), `${job.episode_id}_final_video.mp4`)
    await assertFinishedOnce(job, destination, workDirs.get(job.job_id)!)
    assert.equal(gateway.calls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/v1/final-renders'
      && call.headers.get('Idempotency-Key') === done?.final_render_remote_wait?.gateway_attempt_key).length, 1)
  }
  await reconcilePasses()
  for (const job of jobs) {
    const done = await queue.loadAuthoritativeJob(project.slug, job.job_id)
    await assertFinishedOnce(job, String(done?.result?.final_render_destination?.pathname), workDirs.get(job.job_id)!)
  }
})

test('importing and imported rows go back to the importer, never to the monitor', async t => {
  if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()
  const importing = await prepareOutputReady('0-route-importing')
  installHooks(t, {
    probe: value => {
      if (value.phase === 'before-output-publication' && value.job_id === importing.job.job_id) {
        throw new Error('controlled stop before publication')
      }
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(importing.job.project_slug, importing.job.job_id),
    /controlled stop before publication/,
  )
  assert.equal((await canonicalMarker(importing)).phase, 'importing')
  const imported = await prepareOutputReady('0-route-imported')
  gateway.ackMode = 'unknown-unrecorded'
  await requireImporter().recoverFinalRenderImport(imported.job.project_slug, imported.job.job_id)
  assert.equal((await canonicalMarker(imported)).phase, 'imported')

  installHooks(t)
  gateway.ackMode = 'observed'
  const before = new Map<Prepared, number>()
  for (const prepared of [importing, imported]) {
    before.set(prepared, (await revisions(prepared)).length)
    await queue.getJobs(prepared.job.project_slug, { view: 'full' })
  }
  gateway.resetCalls()
  await reconcilePasses()
  await settle()
  for (const prepared of [importing, imported]) {
    assert.equal((await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))?.status, 'done')
    const id = gateway.accepted.get(prepared.key)!.id
    assert.equal(gateway.calls.some(call => call.method === 'GET' && new URL(call.url).pathname === `/v1/final-renders/${id}`),
      false, 'no monitor status read')
    const added = (await revisions(prepared)).slice(before.get(prepared))
    assert.equal(added.some(value => String(value.event).startsWith('monitor_')), false, 'no monitor transition')
  }
})

test('older remote facts without narration timing leave the stamp unmeasured', async t => {
  installHooks(t)
  const prepared = await prepareOutputReady('old-narration-offset')
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const stamp = JSON.parse(await fs.readFile(stampPath(prepared.destination), 'utf8'))
  assert.equal(Object.hasOwn(stamp, 'narration_offset_sec'), false)
})

test('the finish tail runs once after publication and never for a cancelled import', async t => {
  installHooks(t)
  let workDir = ''
  const finished = await prepareOutputReady('0-tail-once', false, {
    prepareJob: async job => { workDir = await rememberFinish(job) },
    narrationOffsetSec: 5.25,
  })
  // Restart readback: the facts are in the saved row, and an ordinary write cannot drop them.
  const running = await queue.loadAuthoritativeJob(finished.job.project_slug, finished.job.job_id)
  await queue.writeAuthoritativeJob({ ...running!, result: undefined })
  const jobsFile = path.join(
    pm.getProjectDir(finished.job.project_slug) ?? path.join(retainedRoot, 'projects', finished.job.project_slug),
    'jobs.json',
  )
  const saved = (JSON.parse(await fs.readFile(jobsFile, 'utf8')).jobs as Job[])
    .find(row => row.job_id === finished.job.job_id)
  assert.deepEqual(saved?.result?.final_render_finish, {
    code: 'EP1', visual_source: 'scene_plan', image_pool: null, work_dir: workDir,
    format: 'mp4', total_render_duration: 2,
    final_check_expected: FINAL_CHECK_PLAN, loudness: DEFAULT_RESOLVED_LOUDNESS, narration_offset_sec: 5.25,
  })

  await requireImporter().recoverFinalRenderImport(finished.job.project_slug, finished.job.job_id)
  await assertFinishedOnce(finished.job, finished.destination, workDir)
  assert.equal(JSON.parse(await fs.readFile(stampPath(finished.destination), 'utf8')).narration_offset_sec, 5.25)
  await requireImporter().recoverFinalRenderImport(finished.job.project_slug, finished.job.job_id)
  await assertFinishedOnce(finished.job, finished.destination, workDir)

  let keptWorkDir = ''
  const cancelled = await prepareOutputReady('0-tail-cancel', false, {
    prepareJob: async job => { keptWorkDir = await rememberFinish(job) },
  })
  let cancellationRecorded = false
  installHooks(t, {
    probe: async value => {
      if (value.phase !== 'before-output-ack' || value.job_id !== cancelled.job.job_id || cancellationRecorded) return
      cancellationRecorded = true
      await queue.requestFinalRenderRemoteWaitCancellation(cancelled.job.project_slug, cancelled.job.job_id)
    },
  })
  await requireImporter().recoverFinalRenderImport(cancelled.job.project_slug, cancelled.job.job_id)
  let disk = await queue.loadAuthoritativeJob(cancelled.job.project_slug, cancelled.job.job_id)
  if (disk?.status === 'running') {
    await requireImporter().recoverFinalRenderImport(cancelled.job.project_slug, cancelled.job.job_id)
    disk = await queue.loadAuthoritativeJob(cancelled.job.project_slug, cancelled.job.job_id)
  }
  assert.equal(cancellationRecorded, true)
  assert.equal(disk?.status, 'cancelled')
  assert.equal(sha256(await fs.readFile(cancelled.destination)), OUTPUT_SHA, 'published before the cancellation')
  assert.equal(disk?.output_lines.some(line => line.startsWith('Video saved:')), false)
  await assert.rejects(fs.stat(stampPath(cancelled.destination)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  assert.ok((await fs.stat(keptWorkDir)).isDirectory(), 'a cancelled render keeps its work folder, like a failed one')
})

test('a staged render plan checks the candidate before the previous final is kept, publication, and ACK', async t => {
  let publicationProbes = 0
  installHooks(t, {
    verifyFinal: 'real',
    probe: value => { if (value.phase === 'before-output-publication') publicationProbes += 1 },
  })
  const prepared = await prepareOutputReady('0-plan-check', false, {
    prepareJob: async job => { await rememberFinish(job) },
    finalCheckExpected: FINAL_CHECK_PLAN,
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /Final video assembly incomplete[\s\S]*EP1_final_video\.mp4 \(its length could not be measured\)/,
    'the downloaded candidate must pass the plan\'s own final check and loudness verification',
  )
  const disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(disk?.status, 'running', 'a failed check does not complete the row')
  assert.equal(publicationProbes, 0, 'the check runs before the prior final is moved and anything is published')
  assert.equal(ackPosts(prepared).length, 0, 'an unverified file is never acknowledged')
  await assert.rejects(fs.stat(prepared.destination),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    'the canonical destination is left untouched')
  assert.ok(outputGets(prepared).length > 0, 'the checked candidate was downloaded and kept as evidence')
  assert.equal(disk?.output_lines.some(line => line.startsWith('Video saved:')), false,
    'the local finish tail is not reached')
  assert.equal((disk?.result?.final_render_finish as any)?.final_check_expected?.planned_sec, 2,
    'the exact plan was persisted with the staged intent')
  await assert.rejects(fs.stat(stampPath(prepared.destination)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')

  // The scheduler retries with backoff, but a real shared-check failure must be visible on the row
  // instead of staying silent forever.
  // The scheduler only visits rows in the live queue map. This fixture writes jobs.json directly
  // after boot, so load the project once, exactly as a row enqueued through the queue would be.
  await queue.getJobs(prepared.job.project_slug, { view: 'full' })
  await reconcilePasses()
  const surfaced = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(surfaced?.status, 'running')
  assert.match(surfaced?.error ?? '',
    /^Final render needs attention: .*Final video assembly incomplete[\s\S]*EP1_final_video\.mp4/)
  assert.equal(surfaced?.output_lines.filter(line => line.startsWith('Final render needs attention:')).length, 1,
    'the cause is written once, not once per retry')
  assert.equal(ackPosts(prepared).length, 0, 'a surfaced failure still acknowledges nothing')
  assert.equal(publicationProbes, 0, 'a surfaced failure still publishes nothing')
  await assert.rejects(fs.stat(prepared.destination),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')

  // A restart empties the in-memory backoff, so the shared completion path itself must drop the
  // stale cause: a later verified attempt completes clean and keeps only the attention history.
  const reconciler = await import('../services/final-render-reconciler.js')
  await reconciler._resetFinalRenderReconcilerForTesting()
  installHooks(t)
  await reconcilePasses()
  const completed = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(completed?.status, 'done', 'the retried render completes normally')
  assert.equal(completed?.error, null, 'a verified completion does not inherit the stale attention cause')
  assert.equal(completed?.output_lines.filter(line => line.startsWith('Final render needs attention:')).length, 1,
    'the attention history stays in the log')
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA,
    'the retried candidate is published after it passes')
})

test('an intent staged without its render plan holds before promotion, ACK, or completion', async t => {
  let publicationProbes = 0
  installHooks(t, {
    probe: value => { if (value.phase === 'before-output-publication') publicationProbes += 1 },
  })
  const priorFinal = Buffer.from('prior canonical final stays exactly where it was\n')
  const prepared = await prepareOutputReady('0-no-plan', false, {
    withoutPlan: true,
    prepareJob: async job => { await rememberFinish(job) },
    priorDestinationBytes: priorFinal,
  })
  const candidate = path.join(
    path.dirname(prepared.destination),
    `.${path.basename(prepared.destination)}.${prepared.marker.intent_id}.output-import.partial`,
  )
  const holds = (error: unknown) => error instanceof Error && error.name === 'FinalRenderCheckHold'
    && (error as { reason?: string }).reason === 'staged-without-plan'

  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id), holds,
    'a plan-less import is an explicit, recoverable hold',
  )
  let disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(disk?.status, 'running', 'the row stays running; a hold is not a completion')
  assert.equal(disk?.local_execution_complete, false)
  assert.equal(disk?.error?.startsWith('Final render check hold:'), true, 'the row carries its cause')
  assert.equal(disk?.output_lines.filter(line => line.startsWith('Final check hold:')).length, 1,
    'the durable hold line is written once')
  assert.equal(disk?.result?.final_render_finish?.final_check_expected, undefined,
    'no plan is invented for the row')
  assert.equal(disk?.result?.final_check, undefined, 'no verdict is invented for a plan that was never saved')
  assert.equal(disk?.result?.final_render_check_hold, undefined,
    'the hold lives where a frozen row can keep it, not in result')
  assert.equal(publicationProbes, 0, 'nothing is published before the check')
  assert.equal(ackPosts(prepared).length, 0, 'an unverified import is never acknowledged')
  assert.deepEqual(await fs.readFile(prepared.destination), priorFinal,
    'the existing canonical final is untouched')
  assert.equal(sha256(await fs.readFile(candidate)), OUTPUT_SHA,
    'the downloaded candidate and its evidence are kept for recovery')
  assert.ok(outputGets(prepared).length > 0, 'the candidate was downloaded before it was held')
  assert.equal(disk?.output_lines.some(line => line.startsWith('Video saved:')), false)
  await assert.rejects(fs.stat(stampPath(prepared.destination)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  await assert.rejects(fs.stat(path.join(prepared.intentDir, 'final-render-terminal.json')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    'no terminal was consumed for a held import')

  // The condition is on the row, so a second pass holds again without inventing a new line or a pass.
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id), holds,
  )
  disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(disk?.status, 'running')
  assert.equal(disk?.output_lines.filter(line => line.startsWith('Final check hold:')).length, 1)
  assert.equal(ackPosts(prepared).length, 0)
  assert.deepEqual(await fs.readFile(prepared.destination), priorFinal)
  assert.equal(sha256(await fs.readFile(candidate)), OUTPUT_SHA)
})

test('a crash after publication without a frozen plan refuses ACK and completion', async t => {
  let interrupted = false
  const prepared = await prepareOutputReady('0-crash-no-plan', false, {
    prepareJob: async job => { await rememberFinish(job) },
  })
  installHooks(t, {
    probe: value => {
      if (value.phase !== 'before-output-ack' || interrupted) return
      interrupted = true
      throw new Error('controlled crash after publication')
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /controlled crash after publication/,
  )
  assert.equal(interrupted, true)
  assert.equal((await canonicalMarker(prepared)).phase, 'imported')
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA, 'publication landed before the crash')

  // A row written by a build that published without freezing a plan. Ordinary queue writes pin
  // `result` to this durable row, so the old row is written directly, exactly as it would be read.
  await queue._waitForJobPersistenceForTesting()
  const published = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.ok(published)
  const olderRow = structuredClone(published)
  delete olderRow.result!.final_render_finish
  await writeJob(olderRow)
  assert.equal((await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))
    ?.result?.final_render_finish, undefined)

  gateway.resetCalls()
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    (error: unknown) => error instanceof Error && error.name === 'FinalRenderCheckHold'
      && (error as { reason?: string }).reason === 'staged-without-plan',
    'the pre-ACK recovery path holds instead of acking an unverifiable import',
  )
  const held = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(held?.status, 'running', 'the row is not completed')
  assert.equal(held?.local_execution_complete, false)
  assert.equal(held?.error?.startsWith('Final render check hold:'), true)
  assert.equal(ackPosts(prepared).length, 0, 'a held import is never acknowledged')
  assert.equal((await canonicalMarker(prepared)).phase, 'imported')
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA, 'the published final is kept')
  await assert.rejects(fs.stat(path.join(prepared.intentDir, 'final-render-terminal.json')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  assert.equal(held?.output_lines.some(line => line.startsWith('Video saved:')), false)
})

test('a kept work folder goes only once done is on disk, and only when it is the job\'s own', async t => {
  let workDir = ''
  const compilation = await prepareOutputReady('0-keep-until-done', false, {
    prepareJob: async job => { workDir = await rememberFinish(job, false) },
  })
  const jobsFile = path.join(
    pm.getProjectDir(compilation.job.project_slug) ?? path.join(retainedRoot, 'projects', compilation.job.project_slug),
    'jobs.json',
  )
  let failCompletion = false
  installHooks(t, {
    probe: value => {
      if (value.phase === 'after-output-ack-observed' && value.job_id === compilation.job.job_id) failCompletion = true
    },
  })
  const restoreProbe = queue._setJobFileLockProbeForTesting((operation, pathname) => {
    if (failCompletion && operation === 'persist' && pathname === jobsFile) throw new Error('controlled completion write failure')
  })
  try {
    await assert.rejects(
      requireImporter().recoverFinalRenderImport(compilation.job.project_slug, compilation.job.job_id),
      /controlled completion write failure/,
    )
    // The app stops before the done write lands: only what is on disk survives.
    await queue._waitForJobPersistenceForTesting()
    queue._forgetProjectPersistenceForTesting(compilation.job.project_slug)
  } finally {
    restoreProbe()
  }
  const unfinished = await queue.loadAuthoritativeJob(compilation.job.project_slug, compilation.job.job_id)
  assert.equal(unfinished?.status, 'running')
  assert.ok((await fs.stat(workDir)).isDirectory(), 'a completion that did not land keeps the work folder')
  await requireImporter().recoverFinalRenderImport(compilation.job.project_slug, compilation.job.job_id)
  await assertFinishedOnce(compilation.job, compilation.destination, workDir)

  const foreign = path.join(retainedRoot, 'not-a-work-temp', '.tmp_1')
  await fs.mkdir(foreign, { recursive: true })
  const outside = await prepareOutputReady('0-keep-foreign', false, {
    prepareJob: async job => {
      await rememberFinish(job, false)
      job.result!.final_render_finish.work_dir = foreign
    },
  })
  await requireImporter().recoverFinalRenderImport(outside.job.project_slug, outside.job.job_id)
  assert.equal((await queue.loadAuthoritativeJob(outside.job.project_slug, outside.job.job_id))?.status, 'done')
  assert.ok((await fs.stat(foreign)).isDirectory(), 'nothing outside the job\'s own work-temp folder is removed')
})

test('power lost after done but before the folder removal: recovery removes the job\'s own folder', async t => {
  installHooks(t)
  let workDir = ''
  const prepared = await prepareOutputReady('0-keep-after-power-cut', false, {
    prepareJob: async job => { workDir = await rememberFinish(job, false) },
  })
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  await assertFinishedOnce(prepared.job, prepared.destination, workDir)
  // The folder survived: done reached disk, the app died before the removal ran.
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'scene_0000.mp4'), 'left behind by a power cut\n')
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  await assert.rejects(fs.stat(workDir), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  assert.equal((await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))?.status, 'done')
})

test('a row staged by an older build without a render plan is held instead of finished', async t => {
  installHooks(t)
  const project = await pm.createProject({ name: `0 Tail Rebuilt ${++serial}` })
  const older = await prepareOutputReady('0-tail-rebuilt', false, { slug: project.slug, withoutPlan: true })
  assert.equal((await queue.loadAuthoritativeJob(older.job.project_slug, older.job.job_id))?.result?.final_render_finish,
    undefined, 'this fixture really has no plan')
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(older.job.project_slug, older.job.job_id),
    (error: unknown) => error instanceof Error && error.name === 'FinalRenderCheckHold',
    'the old finish-tail fallback must not stamp an unverified import',
  )
  const disk = await queue.loadAuthoritativeJob(older.job.project_slug, older.job.job_id)
  assert.equal(disk?.status, 'running')
  assert.equal(disk?.error?.startsWith('Final render check hold:'), true)
  assert.equal(ackPosts(older).length, 0)
  await assert.rejects(fs.stat(older.destination),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  await assert.rejects(fs.stat(stampPath(older.destination)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  assert.equal(disk?.output_lines.some(line => line.startsWith('Video saved:')), false)
})

test('MP4 staging freezes resolved loudness before importer authority', async () => {
  const prepared = await prepareOutputReady('manifest-authority')
  assert.deepEqual(prepared.manifest.loudness, {
    lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn',
  })

  const unsupported = makeJob(`${prepared.job.project_slug}-unsupported`, `${prepared.job.job_id}-unsupported`)
  await writeJob(unsupported)
  const unsupportedBase = path.join(retainedRoot, 'unsupported-base.mov')
  const unsupportedAudio = path.join(retainedRoot, 'unsupported-audio.wav')
  await fs.writeFile(unsupportedBase, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(unsupportedAudio, AUDIO_BYTES, { mode: 0o600 })
  const result = await transport.preparePrivateFinalRenderDescriptor({
    videoInputPath: unsupportedBase,
    premixedAudioPath: unsupportedAudio,
    targetDuration: 2, w: 128, h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 }, format: 'mov',
    outputFile: path.join(retainedRoot, 'must-stay-local.mov'), job: unsupported,
    code: 'EP1', titleHint: 'Unsupported MOV', videoDir: retainedRoot,
    resolvedLoudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'block' },
  } as CompositionWithAuthority)
  assert.equal(result, null, 'unsupported wire containers create no private intent')
})

test('durable range prefix resumes once and refuses a replaced candidate', async t => {
  const prepared = await prepareOutputReady('prefix-resume')
  let interrupted = false
  let candidate = ''
  installHooks(t, {
    probe: async value => {
      if (value.phase !== 'after-output-download-prefix' || interrupted) return
      interrupted = true
      candidate = value.candidate_path!
      throw new Error('controlled crash after durable first prefix')
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /controlled crash/,
  )
  assert.equal(outputGets(prepared).length, 1)
  assert.equal(outputGets(prepared)[0].headers.get('Range'), `bytes=0-${8 * 1024 * 1024 - 1}`)
  assert.equal(outputGets(prepared)[0].headers.get('If-Match'), `"${OUTPUT_SHA}"`)
  gateway.resetCalls()
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(outputGets(prepared)[0]?.headers.get('Range'), `bytes=${8 * 1024 * 1024}-${OUTPUT_BYTES.byteLength - 1}`)

  const replaced = await prepareOutputReady('prefix-replaced')
  let replacedPath = ''
  installHooks(t, {
    probe: async value => {
      if (value.phase !== 'after-output-download-prefix' || replacedPath) return
      replacedPath = value.candidate_path!
      await fs.rename(replacedPath, `${replacedPath}.retained-original`)
      await fs.writeFile(replacedPath, 'replacement', { mode: 0o600 })
      throw new Error('controlled candidate replacement')
    },
  })
  await assert.rejects(requireImporter().recoverFinalRenderImport(replaced.job.project_slug, replaced.job.job_id))
  gateway.resetCalls()
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(replaced.job.project_slug, replaced.job.job_id),
    /candidate|prefix|identity|recovery/i,
  )
  assert.equal(outputGets(replaced).length, 0)
  assert.equal((await canonicalMarker(replaced)).phase, 'importing')
})

test('shared MOV demuxer names require a corroborating bounded ISO-BMFF brand', () => {
  const sharedNames = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']
  assert.equal(media.classifyFinalRenderContainerEvidence({
    containerNames: sharedNames, containerBrand: 'isom',
  }), 'mp4')
  assert.equal(media.classifyFinalRenderContainerEvidence({
    containerNames: sharedNames, containerBrand: 'qt  ',
  }), 'mov', 'the same FFmpeg demuxer names cannot turn a QuickTime brand into MP4')
  assert.equal(media.classifyFinalRenderContainerEvidence({
    containerNames: sharedNames, containerBrand: null,
  }), 'unknown', 'ambiguous shared names without a brand are unsupported')
  assert.throws(() => media.classifyFinalRenderContainerEvidence({
    containerNames: sharedNames, containerBrand: 'x'.repeat(65),
  }), /brand|bounded|container/i)
})

test('strict output lineage and normalized media facts fence publication and ACK', async t => {
  const foreign = await prepareOutputReady('foreign-view')
  gateway.viewMode = 'foreign'
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(foreign.job.project_slug, foreign.job.job_id)
  const foreignPublic = (await queue.getJobs(foreign.job.project_slug, { view: 'full' }))[0]
  assert.equal(foreignPublic?.final_render_wait?.state, 'recovery_hold')
  await assert.rejects(fs.stat(foreign.destination), (error: unknown) => (
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  ))
  assert.equal(ackPosts(foreign).length, 0)

  const badMedia = await prepareOutputReady('bad-media')
  gateway.viewMode = 'output-ready'
  installHooks(t, { inspectMedia: async () => mediaObservation({
    videoCodec: 'vp9', containerNames: ['matroska', 'webm'], containerBrand: null, container: 'webm',
  }) })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(badMedia.job.project_slug, badMedia.job.job_id),
    /container|codec|media|validation/i,
  )
  await assert.rejects(fs.stat(badMedia.destination), (error: unknown) => (
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  ))
  assert.equal(ackPosts(badMedia).length, 0)

  // A full-length container must not carry a picture that stopped early: the local encode guard
  // refuses this shape, so the remote import must refuse it too.
  const shortPicture = await prepareOutputReady('short-picture')
  installHooks(t, { inspectMedia: async () => mediaObservation({ videoDurationSec: 1.5 }) })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(shortPicture.job.project_slug, shortPicture.job.job_id),
    /picture/i,
  )
  await assert.rejects(fs.stat(shortPicture.destination), (error: unknown) => (
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  ))
  assert.equal(ackPosts(shortPicture).length, 0)
})

test('destination writer conflict preserves both files and sends no ACK', async t => {
  const prepared = await prepareOutputReady('destination-conflict')
  const competing = Buffer.from('competing writer output\n')
  let candidate = ''
  installHooks(t, {
    probe: async value => {
      if (value.phase !== 'before-output-publication') return
      candidate = value.candidate_path!
      await fs.mkdir(path.dirname(value.destination_path!), { recursive: true, mode: 0o700 })
      await fs.writeFile(value.destination_path!, competing, { flag: 'wx', mode: 0o600 })
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /exists|destination|writer|fence/i,
  )
  assert.deepEqual(await fs.readFile(prepared.destination), competing)
  assert.equal(sha256(await fs.readFile(candidate)), OUTPUT_SHA)
  assert.equal(ackPosts(prepared).length, 0)
})

test('cancellation terminal consumes without publication or Pipeline handoff', async t => {
  const cases = [
    { phase: 'before-output-publication', expectedAckPosts: 0, destinationExists: false },
    { phase: 'before-output-ack', expectedAckPosts: 0, destinationExists: true },
    { phase: 'after-output-ack-unknown', expectedAckPosts: 1, destinationExists: true },
    { phase: 'after-output-ack-observed', expectedAckPosts: 1, destinationExists: true },
  ] as const
  for (const item of cases) {
    await t.test(item.phase, async st => {
      const prepared = await prepareOutputReady(`cancel-${item.phase}`, true)
      if (item.phase === 'after-output-ack-unknown') gateway.ackMode = 'unknown-recorded'
      let cancellationRecorded = false
      installHooks(st, {
        probe: async value => {
          if (value.phase !== item.phase || cancellationRecorded) return
          cancellationRecorded = true
          await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
        },
      })
      await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
      let disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
      if (disk?.status === 'running' && cancellationRecorded) {
        await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
        disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
      }
      assert.equal(cancellationRecorded, true, `${item.phase} reached its retained cancellation boundary`)
      assert.equal(disk?.status, 'cancelled')
      assert.equal((await terminal(prepared)).outcome, 'cancelled')
      assert.equal(ackPosts(prepared).length, item.expectedAckPosts)
      if (item.destinationExists) {
        assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA)
      } else {
        await assert.rejects(fs.stat(prepared.destination), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ))
      }
      const child = await queue.loadAuthoritativeJob(
        prepared.job.project_slug, `pipeline-handoff-${prepared.job.job_id}`,
      )
      assert.equal(child, null, 'cancelled import cannot dispatch the saved Pipeline continuation')
    })
  }
})

test('prior-final cancellation at output_ready and before publication consumes without ACK or Pipeline', async t => {
  for (const phase of ['output_ready', 'before-output-publication'] as const) {
    await t.test(phase, async st => {
      const project = await pm.createProject({ name: `Import Prior Cancel ${phase} ${++serial}` })
      const projectDir = pm.getProjectDir(project.slug)!
      const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
      const prior = Buffer.from(`retained prior final before ${phase}\n`)
      const prepared = await prepareOutputReady(`prior-cancel-${phase}`, true, {
        slug: project.slug, videoDir, priorDestinationBytes: prior,
        resolveExternalFinalVideoDir: async () => null,
      })
      let candidate = ''
      let cancelledAt: string | null = null
      const recordCancellation = async () => {
        const row = await queue.requestFinalRenderRemoteWaitCancellation(prepared.job.project_slug, prepared.job.job_id)
        cancelledAt = row.final_render_remote_wait!.cancel_requested_at
      }
      installHooks(st, {
        probe: async value => {
          if (phase !== 'before-output-publication' || value.phase !== phase || cancelledAt) return
          candidate = value.candidate_path!
          await recordCancellation()
        },
      })
      if (phase === 'output_ready') await recordCancellation()
      let importError: unknown
      try {
        await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
        if ((await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id))?.status === 'running') {
          await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
        }
      } catch (error) { importError = error }
      const disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
      assert.ok(cancelledAt, `${phase} must actually record the first cancellation instant`)
      assert.deepEqual(await fs.readFile(prepared.destination), prior)
      assert.equal(ackPosts(prepared).length, 0)
      assert.equal((await revisions(prepared)).some(value => value.event === 'output_imported'), false)
      assert.equal(await queue.loadAuthoritativeJob(project.slug, `pipeline-handoff-${prepared.job.job_id}`), null)
      if (candidate) assert.equal(sha256(await fs.readFile(candidate)), OUTPUT_SHA)
      assert.equal(disk?.status, 'cancelled',
        `${phase} must consume prior-final cancellation; importer error: ${String(importError)}`)
      assert.equal(disk?.local_execution_complete, false)
      assert.equal(disk?.final_render_remote_wait?.cancel_requested_at, cancelledAt)
      const cancelledTerminal = await terminal(prepared)
      assert.equal(cancelledTerminal.outcome, 'cancelled')
      assert.equal(cancelledTerminal.destination, null)
      assert.equal((cancelledTerminal.evidence as Record<string, unknown>).destination_mutated, false)
      assert.equal(cancelledTerminal.cancel_requested_at, cancelledAt)
      assert.equal(importError, undefined)
    })
  }
})

test('unknown ACK reconciles the original key once without a duplicate POST', async t => {
  const prepared = await prepareOutputReady('ack-unknown-recorded')
  gateway.ackMode = 'unknown-recorded'
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(ackPosts(prepared).length, 1)
  const ackBody = JSON.parse(ackPosts(prepared)[0].body.toString('utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(ackBody), ['expected_receipt_digest'])
  assert.equal(typeof ackBody.expected_receipt_digest, 'string')
  assert.equal((await canonicalMarker(prepared)).phase, 'imported')
  assert.ok((await revisions(prepared)).some(value => value.event === 'output_ack_unknown'))

  gateway.resetCalls()
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(ackPosts(prepared).length, 0)
  assert.equal((await canonicalMarker(prepared)).phase, 'acknowledged')
  const outcomes = (await revisions(prepared)).filter(value => (
    value.event === 'output_ack_observed' || value.event === 'output_ack_reconciled'
  ))
  assert.equal(outcomes.length, 1)
})

test('not-acknowledged reconciliation consumes the old intent before one identical retry', async t => {
  const prepared = await prepareOutputReady('ack-unknown-unrecorded')
  gateway.ackMode = 'unknown-unrecorded'
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const firstBody = Buffer.from(ackPosts(prepared)[0].body)
  gateway.resetCalls()
  gateway.ackMode = 'observed'
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(ackPosts(prepared).length, 1)
  assert.deepEqual(ackPosts(prepared)[0].body, firstBody)
  const values = await revisions(prepared)
  const reconciled = values.find(value => value.event === 'output_ack_reconciled')
  assert.equal((reconciled?.payload as Record<string, unknown>).result, 'not_acknowledged')
  assert.equal(values.filter(value => value.event === 'output_ack_intent').length, 2)
})

test('acknowledged import completes the original UUID and drains one Pipeline handoff', async t => {
  const project = await pm.createProject({ name: `Import Completion Drain ${++serial}` })
  const prepared = await prepareOutputReady('completion-drain', true, { slug: project.slug })
  if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()
  let childRuns = 0
  const restoreExecutor = queue._setExecutorForTesting('audio', async child => {
    childRuns += 1
    child.result = { complete: true, completion: { label: 'Retained child', expected: 1, completed: 1, complete: true } }
  })
  t.after(restoreExecutor)
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  await settle()

  const parent = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(parent?.status, 'done')
  assert.equal(parent?.local_execution_complete, true)
  assert.equal(parent?.result?.completion?.expected, 1)
  assert.equal(parent?.result?.completion?.completed, 1)
  assert.equal(childRuns, 1)
  const child = await queue.loadAuthoritativeJob(
    prepared.job.project_slug, `pipeline-handoff-${prepared.job.job_id}`,
  )
  assert.equal(child?.status, 'done')

  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  await settle()
  assert.equal(childRuns, 1, 'matching terminal re-entry cannot dispatch a second continuation')
})

test('cold-load boot retains consumed acknowledged and cancelled terminals and dispatches one pending handoff', async t => {
  const acknowledgedProject = await pm.createProject({ name: `Import Cold Acknowledged ${++serial}` })
  const cancelledProject = await pm.createProject({ name: `Import Cold Cancelled ${++serial}` })
  const acknowledged = await prepareOutputReady('cold-acknowledged', true, { slug: acknowledgedProject.slug })
  const cancelled = await prepareOutputReady('cold-cancelled', true, { slug: cancelledProject.slug })
  installHooks(t)
  await queue.requestFinalRenderRemoteWaitCancellation(cancelled.job.project_slug, cancelled.job.job_id)
  await requireImporter().recoverFinalRenderImport(cancelled.job.project_slug, cancelled.job.job_id)
  assert.equal((await queue.loadAuthoritativeJob(cancelled.job.project_slug, cancelled.job.job_id))?.status, 'cancelled')

  const outputLock = path.join(retainedRoot, 'private-render', 'locks', `${acknowledged.marker.intent_id}.output.lock`)
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'unlink')!
  const originalUnlink = fs.unlink
  let interruptedAfterConsume = false
  // The real release happens first. The throw models process loss between consumed-parent readback and drain.
  Object.defineProperty(fs, 'unlink', {
    ...descriptor,
    value: async (...args: Parameters<typeof fs.unlink>) => {
      await originalUnlink(...args)
      if (String(args[0]) !== outputLock || interruptedAfterConsume) return
      const disk = await queue.loadAuthoritativeJob(acknowledged.job.project_slug, acknowledged.job.job_id)
      if (disk?.status !== 'done') return
      interruptedAfterConsume = true
      throw new Error('controlled stop after terminal consumption before handoff drain')
    },
  })
  try {
    await assert.rejects(
      requireImporter().recoverFinalRenderImport(acknowledged.job.project_slug, acknowledged.job.job_id),
      /controlled stop after terminal consumption/,
    )
  } finally {
    Object.defineProperty(fs, 'unlink', descriptor)
  }
  await settle()
  assert.equal(interruptedAfterConsume, true)
  const acknowledgedDisk = await queue.loadAuthoritativeJob(acknowledged.job.project_slug, acknowledged.job.job_id)
  const cancelledDisk = await queue.loadAuthoritativeJob(cancelled.job.project_slug, cancelled.job.job_id)
  assert.ok(acknowledgedDisk && cancelledDisk)
  assert.equal(acknowledgedDisk.status, 'done')
  assert.equal(acknowledgedDisk.local_execution_complete, true)
  assert.equal((acknowledgedDisk as Job & { pipeline_handoff: { state: string } }).pipeline_handoff.state, 'pending')
  assert.equal(await queue.loadAuthoritativeJob(
    acknowledged.job.project_slug, `pipeline-handoff-${acknowledged.job.job_id}`,
  ), null, 'the original process never dispatched the saved child')
  assert.equal((await terminal(acknowledged)).outcome, 'acknowledged')
  assert.equal((await terminal(cancelled)).outcome, 'cancelled')
  const retainedTerminal = await fs.readFile(path.join(acknowledged.intentDir, 'final-render-terminal.json'))
  const retainedRevisions = await revisionEntries(acknowledged)
  const dispatchLog = path.join(retainedRoot, `cold-load-dispatch-${++serial}.jsonl`)
  gateway.resetCalls()

  const first = await coldLoadImportQueue(acknowledged, cancelled, dispatchLog)
  const second = await coldLoadImportQueue(acknowledged, cancelled, dispatchLog)
  assert.notEqual(first.pid, process.pid)
  assert.notEqual(second.pid, first.pid)
  assert.equal(first.networkCalls, 0)
  assert.equal(second.networkCalls, 0)
  await t.test('acknowledged live projection after both cold boots', () => {
    for (const loaded of [first, second]) {
      assert.equal(loaded.acknowledged?.status, 'done', 'cold boot must retain the verified live success projection')
      assert.equal(loaded.acknowledged?.local_execution_complete, true)
      assert.equal(loaded.acknowledged?.finished_at, acknowledgedDisk.finished_at)
      assert.deepEqual(loaded.acknowledged?.result, acknowledgedDisk.result)
      assert.deepEqual(loaded.acknowledged?.final_render_remote_wait, acknowledgedDisk.final_render_remote_wait)
      assert.equal(loaded.acknowledgedDisk?.status, 'done')
    }
  })
  await t.test('cancelled live projection after both cold boots', () => {
    for (const loaded of [first, second]) {
      assert.equal(loaded.cancelled?.status, 'cancelled', 'cold boot must retain the verified live cancellation projection')
      assert.equal(loaded.cancelled?.local_execution_complete, false)
      assert.equal(loaded.cancelled?.finished_at, cancelledDisk.finished_at)
      assert.deepEqual(loaded.cancelled?.result, cancelledDisk.result)
      assert.deepEqual(loaded.cancelled?.final_render_remote_wait, cancelledDisk.final_render_remote_wait)
      assert.equal(loaded.cancelledDisk?.status, 'cancelled')
      assert.equal(loaded.cancelledChild, null)
    }
  })
  await t.test('existing pending handoff dispatches exactly once across both cold boots', () => {
    for (const loaded of [first, second]) {
      assert.equal(loaded.child?.status, 'done')
      assert.deepEqual(loaded.dispatches, [`pipeline-handoff-${acknowledged.job.job_id}`],
        'the existing same-UUID pending continuation runs exactly once across two cold boots')
      assert.equal((loaded.acknowledgedDisk as Job & { pipeline_handoff: { state: string } }).pipeline_handoff.state,
        'dispatched')
    }
  })
  assert.deepEqual(await fs.readFile(path.join(acknowledged.intentDir, 'final-render-terminal.json')), retainedTerminal)
  assert.deepEqual(await revisionEntries(acknowledged), retainedRevisions, 'cold boot does not manufacture new import proof')
  assert.equal(gateway.callsFor(acknowledged.key).length, 0)
})

test('boot restore keeps a consumed terminal done when a later accepted render replaced its destination', async t => {
  installHooks(t)
  const prepared = await prepareOutputReady('superseded-destination')
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const finished = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.ok(finished)
  assert.equal(finished.status, 'done')
  assert.equal(finished.local_execution_complete, true)
  assert.equal(typeof finished.result?.final_render_terminal_sha256, 'string')
  // A later accepted render of the same episode publishes over the same final name. The retained
  // terminal is still this row's own proof, so boot must not reopen it (1.4.388 Production).
  const newerBytes = Buffer.concat([OUTPUT_BYTES, Buffer.from('newer accepted render\n')])
  await fs.writeFile(prepared.destination, newerBytes, { mode: 0o600 })
  gateway.resetCalls()
  queue._restartProjectForTesting(prepared.job.project_slug)
  const [loaded] = await queue.getJobs(prepared.job.project_slug)
  assert.equal(loaded?.status, 'done')
  assert.equal(loaded?.local_execution_complete, true)
  assert.equal(loaded?.finished_at, finished.finished_at)
  assert.deepEqual(loaded?.result, finished.result)
  const disk = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(disk?.status, 'done')
  assert.deepEqual(await fs.readFile(prepared.destination), newerBytes, 'the newer accepted final is untouched')
  assert.equal(gateway.calls.length, 0, 'a boot restore makes no provider call')
})

test('boot restore still parks a genuinely pending remote render', async t => {
  installHooks(t)
  const pending = await prepareOutputReady('still-pending')
  gateway.resetCalls()
  queue._restartProjectForTesting(pending.job.project_slug)
  const [loaded] = await queue.getJobs(pending.job.project_slug)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.local_execution_complete, false)
  assert.equal(loaded?.final_render_wait?.state, 'output_ready')
  assert.equal(gateway.calls.length, 0, 'a parked remote render makes no provider call')
})

test('the supported reconcile restores only a reopened consumed terminal', async t => {
  installHooks(t)
  const prepared = await prepareOutputReady('reconcile-reopened')
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const finished = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.ok(finished)
  const jobsFile = path.join(
    pm.getProjectDir(prepared.job.project_slug) ?? path.join(retainedRoot, 'projects', prepared.job.project_slug),
    'jobs.json',
  )
  await queue._waitForJobPersistenceForTesting()
  const saved = JSON.parse(await fs.readFile(jobsFile, 'utf8')) as { jobs: Job[] }
  const row = saved.jobs.find(job => job.job_id === prepared.job.job_id)!
  // The exact 1.4.388 shape: a finished row a boot reopened, with its result evidence intact.
  row.status = 'running'
  row.finished_at = null
  row.local_execution_complete = false
  row.output_lines.push('Remote video render is parked pending reconciliation.')
  await fs.writeFile(jobsFile, JSON.stringify(saved))
  queue._forgetProjectPersistenceForTesting(prepared.job.project_slug)

  const newerBytes = Buffer.concat([OUTPUT_BYTES, Buffer.from('newer accepted outro render\n')])
  await fs.writeFile(prepared.destination, newerBytes)
  const result = await queue.reconcileReopenedFinalRenderTerminal(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(result.changed, true)
  assert.equal(result.job.status, 'done')
  assert.equal(result.job.local_execution_complete, true)
  assert.equal(result.job.finished_at, null, 'a transport event is not substituted for a lost completion time')
  assert.ok(result.job.output_lines.some(line => line.includes('original completion time was not retained')))
  assert.deepEqual(result.job.params, finished.params)
  assert.deepEqual(result.job.result, finished.result)
  assert.deepEqual(await fs.readFile(prepared.destination), newerBytes, 'the newer accepted final is untouched')
  const replay = await queue.reconcileReopenedFinalRenderTerminal(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(replay.changed, false, 'a replay is a no-op')

  const unrelated = await prepareOutputReady('reconcile-refused')
  await assert.rejects(
    queue.reconcileReopenedFinalRenderTerminal(unrelated.job.project_slug, unrelated.job.job_id),
    /no retained final render terminal/,
    'an unfinished remote render is never terminalized',
  )
})

test('ordinary queue persistence cannot forge a verified final-render terminal', async () => {
  const prepared = await prepareOutputReady('terminal-forgery')
  const forged = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.ok(forged)
  forged.status = 'done'
  forged.finished_at = new Date().toISOString()
  forged.local_execution_complete = true
  forged.result = {
    complete: true,
    final_render_terminal_sha256: 'f'.repeat(64),
    completion: { label: 'Forged terminal', expected: 1, completed: 1, complete: true },
  }
  await queue.writeAuthoritativeJob(forged)
  const retained = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(retained?.status, 'running')
  assert.equal(retained?.local_execution_complete, false)
  assert.equal(retained?.result?.final_render_terminal_sha256, undefined)
  assert.deepEqual(retained?.final_render_remote_wait, prepared.marker)
})

/** A published final stays hard-linked to its candidate; the retained harness refuses to rename hard links. */
async function moveLinkedFile(from: string, to: string): Promise<void> {
  await fs.link(from, to)
  await fs.unlink(from)
}

test('failed terminal destination readback stays recoverable without repeating ACK', async t => {
  const prepared = await prepareOutputReady('terminal-readback-recovery')
  const retainedDestination = `${prepared.destination}.verified-before-terminal`
  const competingDestination = `${prepared.destination}.conflicting-retained`
  let changed = false
  installHooks(t, {
    probe: async value => {
      if (value.phase !== 'after-output-ack-observed' || changed) return
      changed = true
      await moveLinkedFile(prepared.destination, retainedDestination)
      await fs.writeFile(prepared.destination, 'changed after ACK\n', { flag: 'wx', mode: 0o600 })
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /destination readback changed/i,
  )
  const held = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(held?.status, 'running')
  assert.ok(held?.local_execution_complete === false || held?.local_execution_complete === undefined)
  assert.equal((held?.final_render_remote_wait as FinalRenderTransportReceiptV3).phase, 'acknowledged')
  assert.equal(ackPosts(prepared).length, 1)

  await fs.rename(prepared.destination, competingDestination)
  await moveLinkedFile(retainedDestination, prepared.destination)
  gateway.resetCalls()
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const completed = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(completed?.status, 'done')
  assert.equal(completed?.local_execution_complete, true)
  assert.equal(ackPosts(prepared).length, 0)
  assert.equal(sha256(await fs.readFile(competingDestination)), sha256('changed after ACK\n'))
})

test('a failure after the observed ACK never records ACK uncertainty and recovery completes without a second ACK', async t => {
  const prepared = await prepareOutputReady('failure-after-observed-ack')
  let interrupted = false
  installHooks(t, {
    probe: value => {
      if (value.phase !== 'after-output-ack-observed' || interrupted) return
      interrupted = true
      throw new Error('controlled interruption after observed ACK')
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /controlled interruption after observed ACK/,
  )
  assert.equal((await revisions(prepared)).some(value => value.event === 'output_ack_unknown'), false)
  assert.equal(ackPosts(prepared).length, 1)

  installHooks(t)
  gateway.resetCalls()
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const completed = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(completed?.status, 'done')
  assert.equal(ackPosts(prepared).length, 0)
})

test('released owner succession and pure evidence reject an obsolete owner at the current epoch', async t => {
  const prepared = await prepareOutputReady('owner-succession')
  let interrupted = false
  installHooks(t, {
    probe: value => {
      if (value.phase !== 'after-output-owner-acquired' || interrupted) return
      interrupted = true
      throw new Error('controlled interruption after first output owner acquisition')
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /controlled interruption/,
  )
  const firstOwners = (await revisions(prepared)).filter(value => value.event === 'owner_acquired')
  const released = firstOwners.at(-1)
  assert.ok(released)

  installHooks(t)
  gateway.resetCalls()
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const allOwners = (await revisions(prepared)).filter(value => value.event === 'owner_acquired')
  const successor = allOwners.at(-1)
  assert.ok(successor)
  assert.notEqual(successor.owner_token, released.owner_token)
  assert.ok(Number(successor.owner_epoch) > Number(released.owner_epoch))
  assert.equal((await revisions(prepared)).filter(value => value.event === 'output_import_intent').length, 1)

  const pure = await prepareOutputReady('owner-pure-evidence')
  const input = await evidenceInput(pure)
  const current = evidence.validateFinalRenderTransportEvidence(input)
  assert.ok(current.ownerToken)
  assert.ok(current.ownerEpoch > 1)
  const realOwners = current.records.filter(record => record.value.event === 'owner_acquired')
  const obsolete = realOwners.find(record => record.value.owner_token !== current.ownerToken)
  assert.ok(obsolete, 'the retained real chain contains a released predecessor owner')
  evidence.validateFinalRenderTransportEvidence({
    ...input, expectedOwner: { token: current.ownerToken, epoch: current.ownerEpoch },
  })
  assert.throws(() => evidence.validateFinalRenderTransportEvidence({
    ...input,
    expectedOwner: { token: obsolete.value.owner_token, epoch: current.ownerEpoch },
  }), /current owner does not match the reopened chain/i,
  'a forged obsolete-token/current-epoch authority cannot validate')
})


test('multi-range recovery and terminal audit use fixed buffers with linear reads', async t => {
  const prepared = await prepareOutputReady('bounded-readback')
  const candidate = path.join(
    path.dirname(prepared.destination),
    `.${path.basename(prepared.destination)}.${prepared.marker.intent_id}.output-import.partial`,
  )
  let interrupted = false
  let ackObserved = false
  installHooks(t, {
    probe: value => {
      if (value.phase === 'after-output-ack-observed') ackObserved = true
      if (value.phase !== 'after-output-download-prefix' || interrupted) return
      interrupted = true
      throw new Error('controlled retained-prefix restart')
    },
  })
  const io = measureActualMediaIo(t, [candidate, prepared.destination], () => ackObserved)
  let completionError: unknown
  try {
    await assert.rejects(
      requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
      /controlled retained-prefix restart/,
    )
    gateway.resetCalls()
    installHooks(t, {
      probe: value => { if (value.phase === 'after-output-ack-observed') ackObserved = true },
    })
    try {
      await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
    } catch (error) {
      completionError = error
    }
  } finally {
    io.restore()
  }

  assert.equal(outputGets(prepared).length, 1)
  assert.equal(outputGets(prepared)[0].headers.get('Range'), `bytes=${8 * 1024 * 1024}-${OUTPUT_BYTES.byteLength - 1}`)
  assert.deepEqual(io.readFiles, [], 'media bytes must never use whole-file fs.readFile')
  assert.ok(io.reads.length > 0, 'actual candidate and destination FileHandle reads were measured')
  assert.ok(io.reads.every(value => value.requested > 0 && value.requested <= 1024 * 1024),
    'every actual media hash/readback request stays within the fixed 1 MiB ceiling')
  assert.ok(io.reads.every(value => value.bytesRead >= 0 && value.bytesRead <= value.requested),
    'bounded FileHandle reads may include one zero-byte EOF observation')
  assert.ok(io.allocations.every(value => value.size <= 8 * 1024 * 1024),
    'direct allocations stay within the already bounded 8 MiB network-range ceiling')
  const total = io.reads.reduce((sum, value) => sum + value.bytesRead, 0)
  assert.ok(total <= OUTPUT_BYTES.byteLength * 8, 'all actual media scans remain a fixed linear multiple')
  assert.ok(io.reads.some(value => value.pathname === path.resolve(candidate)))
  assert.ok(io.reads.some(value => (
    value.pathname === path.resolve(prepared.destination) && value.afterAckObserved
  )), 'the queue terminal auditor performs a measured bounded destination readback')
  if (completionError) throw completionError
})

test('candidate replacement before publication preserves the captured destination and all evidence', async t => {
  for (const prior of [null, Buffer.from('captured prior final\n')]) {
    await t.test(prior ? 'prior destination' : 'absent destination', async st => {
      const registered = prior
        ? await pm.createProject({ name: `Import Candidate Prior ${++serial}` })
        : null
      const registeredVideoDir = registered
        ? path.join(pm.getProjectDir(registered.slug)!, 'Episodes', 'EP1', 'Video')
        : undefined
      const prepared = await prepareOutputReady(
        prior ? 'candidate-replacement-prior' : 'candidate-replacement-absent',
        false,
        {
          slug: registered?.slug,
          videoDir: registeredVideoDir,
          priorDestinationBytes: prior ?? undefined,
          priorDestinationPath: registeredVideoDir
            ? path.join(registeredVideoDir, 'EP1_final_video.mp4') : undefined,
          resolveExternalFinalVideoDir: registered ? async () => null : undefined,
        },
      )
      const replacement = Buffer.alloc(OUTPUT_BYTES.byteLength, 0x72)
      let validatedCandidate = ''
      let retainedValidatedCandidate = ''
      installHooks(st, {
        probe: async value => {
          if (value.phase !== 'before-output-publication' || validatedCandidate) return
          validatedCandidate = value.candidate_path!
          retainedValidatedCandidate = `${validatedCandidate}.validated-retained`
          await fs.rename(validatedCandidate, retainedValidatedCandidate)
          await fs.writeFile(validatedCandidate, replacement, { flag: 'wx', mode: 0o600 })
        },
      })
      await requireImporter().recoverFinalRenderImport(
        prepared.job.project_slug, prepared.job.job_id,
      ).catch(() => undefined)

      assert.ok(validatedCandidate)
      assert.equal(sha256(await fs.readFile(retainedValidatedCandidate)), OUTPUT_SHA)
      assert.equal(sha256(await fs.readFile(validatedCandidate)), sha256(replacement))
      if (prior) {
        assert.deepEqual(await fs.readFile(prepared.destination), prior)
      } else {
        await assert.rejects(fs.stat(prepared.destination), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ))
      }
      assert.equal((await revisions(prepared)).filter(value => value.event === 'output_imported').length, 0)
      assert.equal(ackPosts(prepared).length, 0)
    })
  }
})

test('destination changes fence fresh and reconciled ACK attempts', async t => {
  for (const mode of ['replace', 'remove'] as const) {
    await t.test(`fresh ACK ${mode}`, async st => {
      const prepared = await prepareOutputReady(`fresh-ack-${mode}`)
      let retainedPublished = ''
      installHooks(st, {
        probe: async value => {
          if (value.phase !== 'before-output-ack' || retainedPublished) return
          retainedPublished = `${value.destination_path!}.retained-before-ack`
          await moveLinkedFile(value.destination_path!, retainedPublished)
          if (mode === 'replace') {
            await fs.writeFile(value.destination_path!, 'competing destination\n', { flag: 'wx', mode: 0o600 })
          }
        },
      })
      await requireImporter().recoverFinalRenderImport(
        prepared.job.project_slug, prepared.job.job_id,
      ).catch(() => undefined)
      assert.equal(sha256(await fs.readFile(retainedPublished)), OUTPUT_SHA)
      assert.equal(ackPosts(prepared).length, 0)
      assert.equal((await canonicalMarker(prepared)).phase, 'imported')
    })
  }

  await t.test('not-acknowledged original-key reconciliation', async st => {
    const prepared = await prepareOutputReady('reconciled-ack-destination')
    gateway.ackMode = 'unknown-unrecorded'
    installHooks(st)
    await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
    assert.equal(ackPosts(prepared).length, 1)

    gateway.resetCalls()
    gateway.ackMode = 'observed'
    let retainedPublished = ''
    installHooks(st, {
      probe: async value => {
        if (value.phase !== 'before-output-ack' || retainedPublished) return
        retainedPublished = `${value.destination_path!}.retained-after-not-acknowledged`
        await moveLinkedFile(value.destination_path!, retainedPublished)
      },
    })
    await requireImporter().recoverFinalRenderImport(
      prepared.job.project_slug, prepared.job.job_id,
    ).catch(() => undefined)
    const values = await revisions(prepared)
    assert.ok(values.some(value => (
      value.event === 'output_ack_reconciled'
      && (value.payload as Record<string, unknown>).result === 'not_acknowledged'
    )))
    assert.equal(sha256(await fs.readFile(retainedPublished)), OUTPUT_SHA)
    assert.equal(ackPosts(prepared).length, 0)
    assert.equal((await canonicalMarker(prepared)).phase, 'imported')
  })
})

test('pure import evidence binds media, target, candidate, destination, recovery, and publication links', async t => {
  const prepared = await prepareOutputReady('pure-import-bindings')
  installHooks(t, {
    probe: value => {
      if (value.phase === 'before-output-ack') throw new Error('controlled imported-chain capture')
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /controlled imported-chain capture/,
  )
  const input = await evidenceInput(prepared)
  evidence.validateFinalRenderTransportEvidence(input)
  const legacy = forgedEvidence(input, records => {
    delete records.find(item => item.event === 'output_validation_observed')!.payload.media.videoDurationSec
  })
  assert.doesNotThrow(() => evidence.validateFinalRenderTransportEvidence(legacy), 'existing v3 history remains readable')
  const unrelated = path.join(retainedRoot, 'unrelated-final.mp4')
  const cases: Array<{ name: string; mutate: (records: RevisionValue[]) => void }> = [
    {
      name: 'short picture behind full audio', mutate: records => {
        const media = records.find(item => item.event === 'output_validation_observed')!.payload.media
        const recipe = (prepared.manifest.packet as Record<string, any>).recipe
        media.videoDurationSec = Number(recipe.target_duration_sec) - 0.5
      },
    },
    {
      name: 'unmeasurable picture', mutate: records => {
        records.find(item => item.event === 'output_validation_observed')!.payload.media.videoDurationSec = null
      },
    },
    {
      name: 'media facts', mutate: records => {
        const value = records.find(item => item.event === 'output_validation_observed')!
        ;(value.payload.media as Record<string, unknown>).videoCodec = 'vp9'
      },
    },
    {
      name: 'loudness target', mutate: records => {
        const value = records.find(item => item.event === 'output_validation_observed')!
        ;(value.payload.target as Record<string, unknown>).lufs = -6
      },
    },
    {
      name: 'candidate identity', mutate: records => {
        for (const value of records.filter(item => item.event === 'output_download_prefix')) {
          value.payload.candidate = { pathname: unrelated, dev: '999', ino: '999' }
        }
      },
    },
    {
      name: 'destination path', mutate: records => {
        records.find(item => item.event === 'output_publish_intent')!.payload.destination = unrelated
      },
    },
    {
      name: 'expected destination state', mutate: records => {
        records.find(item => item.event === 'output_publish_intent')!.payload.expected_state = {
          kind: 'file', sha256: 'a'.repeat(64), size_bytes: 1,
        }
      },
    },
    {
      name: 'recovery path', mutate: records => {
        records.find(item => item.event === 'output_publish_intent')!.payload.recovery_path = path.join(
          retainedRoot, 'unregistered-recovery', 'prior.mp4',
        )
      },
    },
    {
      name: 'import-to-intent destination link', mutate: records => {
        const value = records.find(item => item.event === 'output_imported')!
        ;(value.payload.destination as Record<string, unknown>).pathname = unrelated
      },
    },
  ]
  for (const item of cases) {
    await t.test(item.name, () => {
      assert.throws(
        () => evidence.validateFinalRenderTransportEvidence(forgedEvidence(input, item.mutate)),
        /private final render evidence/i,
      )
    })
  }
})

test('pure import evidence rejects rehashed blocking loudness contradictions in both measurement copies', async t => {
  const prepared = await prepareOutputReady('pure-blocking-loudness', false, {
    resolvedLoudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'block' },
  })
  installHooks(t, {
    probe: value => {
      if (value.phase === 'before-output-ack') throw new Error('controlled blocking-chain capture')
    },
  })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /controlled blocking-chain capture/,
  )
  const input = await evidenceInput(prepared)
  evidence.validateFinalRenderTransportEvidence(input)
  assert.equal(prepared.manifest.loudness && (prepared.manifest.loudness as Record<string, unknown>).check, 'block')
  const forged = forgedEvidence(input, records => {
    const validation = records.find(value => value.event === 'output_validation_observed')!
    validation.payload.loudness = { lufs: -30, true_peak_db: 0 }
    validation.payload.media.loudness = structuredClone(validation.payload.loudness)
    assert.deepEqual(validation.payload.target, prepared.manifest.loudness)
    assert.equal(validation.payload.verdict, 'pass')
  })
  assert.throws(() => evidence.validateFinalRenderTransportEvidence(forged),
    /private final render evidence/i,
    'a self-consistent rehashed pass cannot contradict the captured blocking loudness policy')
})

test('pure import evidence rejects coherently replaced ACK reconciliation output for both outcomes', async t => {
  for (const outcome of ['acknowledged', 'not_acknowledged'] as const) {
    await t.test(outcome, async st => {
      const prepared = await prepareOutputReady(`pure-reconciled-${outcome}`)
      gateway.ackMode = outcome === 'acknowledged' ? 'unknown-recorded' : 'unknown-unrecorded'
      installHooks(st)
      await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
      assert.equal(ackPosts(prepared).length, 1)
      gateway.ackMode = 'observed'
      await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
      const input = await evidenceInput(prepared)
      evidence.validateFinalRenderTransportEvidence(input)
      const client = await import('../lib/final-render-gateway-client.js')
      for (const changed of ['output digest', 'selected machine'] as const) {
        await st.test(changed, () => {
          const forged = forgedEvidence(input, records => {
            const reconciled = records.find(value => value.event === 'output_ack_reconciled')!
            assert.equal(reconciled.payload.result, outcome)
            const response = reconciled.payload.response as FinalRenderJobView
            const pinned = records.find(value => value.event === 'output_import_intent')!.payload.response as FinalRenderJobView
            assert.ok(response.output && pinned.output)
            const receipt = JSON.parse(response.output.receipt_utf8) as FinalRenderOutputReceipt
            if (changed === 'output digest') receipt.output_sha256 = 'e'.repeat(64)
            else receipt.selected_machine = { ...receipt.selected_machine, id: 'node-m4-replacement', label: 'Other M4' }
            response.output.sha256 = receipt.output_sha256
            response.output.receipt_utf8 = canonicalJson(receipt)
            response.output.receipt_digest = sha256(response.output.receipt_utf8)
            response.receipt_digest = response.output.receipt_digest
            for (const key of ['id', 'gateway_attempt_key', 'story_uuid', 'intent_id', 'attempt_no'] as const) {
              assert.equal(response[key], pinned[key], `replacement keeps original ${key}`)
            }
            assert.equal(receipt.inbound_story_body_sha256, sha256(input.requestBytes!))
            assert.equal(receipt.packet_digest, prepared.marker.packet_sha256)
            assert.notEqual(response.output.receipt_digest, pinned.output.receipt_digest)
            client.validateFinalRenderJobEvidence(response, {
              owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID, story_instance_id: storyInstanceId,
            }, {
              id: pinned.id, key: pinned.gateway_attempt_key, storyUuid: pinned.story_uuid,
              intent: pinned.intent_id, attemptNo: pinned.attempt_no,
              inboundDigest: sha256(input.requestBytes!), packetDigest: prepared.marker.packet_sha256, acceptance: false,
            })
          })
          assert.throws(() => evidence.validateFinalRenderTransportEvidence(forged),
            /private final render evidence/i,
            `${outcome} must consume only the exact imported output/receipt, even after full rehashing`)
        })
      }
    })
  }
})

test('contradictory ISO-BMFF names and an isom brand remain unknown', () => {
  assert.equal(media.classifyFinalRenderContainerEvidence({
    containerNames: ['avi'], containerBrand: 'isom',
  }), 'unknown')
})

test('original-key 404 installs a visible hold without private import facts', async t => {
  const prepared = await prepareOutputReady('output-404-hold')
  gateway.viewMode = 'missing'
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const publicJob = (await queue.getJobs(prepared.job.project_slug, { view: 'full' }))[0]
  assert.equal(publicJob?.final_render_wait?.state, 'recovery_hold')
  const importEvents = (await revisions(prepared)).filter(value => {
    if (typeof value.event !== 'string') assert.fail('revision event must be a string')
    return value.event.startsWith('output_')
  })
  assert.deepEqual(importEvents, [])
  assert.equal(outputGets(prepared).length, 0)
  assert.equal(ackPosts(prepared).length, 0)
  await assert.rejects(fs.stat(prepared.destination), (error: unknown) => (
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  ))
})

test('a remote import that replaces a final keeps the previous one for three days', async t => {
  const project = await pm.createProject({ name: `Import Keeps Previous ${++serial}` })
  const projectDir = pm.getProjectDir(project.slug)!
  const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
  const prior = Buffer.from('accepted final from the earlier render\n')
  const prepared = await prepareOutputReady('keeps-previous', false, {
    slug: project.slug, videoDir, priorDestinationBytes: prior,
    resolveExternalFinalVideoDir: async () => null,
  })
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)

  const retention = await import('../services/final-video-retention.js')
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA, 'the new final took the name')

  const kept = retention.readRetainedFinalVideos(projectDir)
  assert.equal(kept.length, 1, 'the channel record names exactly one kept final')
  const [entry] = kept
  assert.equal(entry!.final_name, 'EP1_final_video.mp4')
  assert.equal(entry!.code, 'EP1')
  assert.equal(
    path.dirname(entry!.retained_path),
    path.join(path.dirname(prepared.destination), retention.PREVIOUS_FINALS_DIRNAME),
    'the kept folder sits beside the final, on the final\'s own drive',
  )
  assert.deepEqual(
    await fs.readFile(path.join(entry!.retained_path, 'EP1_final_video.mp4')), prior,
    'the accepted final itself is the copy that was kept',
  )
  const age = Date.now() - Date.parse(entry!.retained_at)
  assert.ok(age >= 0 && age < 60 * 60 * 1000, 'the retention window starts when it was replaced')

  const job = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(job?.status, 'done')
  const line = job?.output_lines.find(value => value.startsWith('Previous final kept for '))
  assert.ok(line, `the job log says what was kept and where: ${job?.output_lines.join(' | ')}`)
  assert.match(line!, /Previous final kept for 3 days:/)
  assert.ok(line!.includes(entry!.retained_path), 'the log names the exact folder')
  assert.equal(
    job!.output_lines.filter(value => value.startsWith('Previous final kept for ')).length, 1,
    'the line is written once, not once per pass',
  )
})

test('a failed import leaves the accepted final exactly where it was and keeps no copy', async t => {
  const project = await pm.createProject({ name: `Import Fails Keeps Nothing ${++serial}` })
  const projectDir = pm.getProjectDir(project.slug)!
  const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
  const prior = Buffer.from('accepted final that must survive a failed import\n')
  const prepared = await prepareOutputReady('fails-keeps-nothing', false, {
    slug: project.slug, videoDir, priorDestinationBytes: prior,
    resolveExternalFinalVideoDir: async () => null,
  })
  installHooks(t, { verifyFinal: async () => { throw new Error('the finished video is 12 s short of the plan') } })
  await assert.rejects(
    requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id),
    /12 s short/,
  )

  const retention = await import('../services/final-video-retention.js')
  assert.deepEqual(await fs.readFile(prepared.destination), prior, 'the accepted final is untouched')
  assert.deepEqual(retention.readRetainedFinalVideos(projectDir), [], 'nothing was kept because nothing was replaced')
  await assert.rejects(fs.stat(path.join(videoDir, retention.PREVIOUS_FINALS_DIRNAME)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  assert.equal(ackPosts(prepared).length, 0)
})

test('a first-ever remote final keeps nothing and records nothing', async t => {
  const project = await pm.createProject({ name: `Import First Final ${++serial}` })
  const projectDir = pm.getProjectDir(project.slug)!
  const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
  const prepared = await prepareOutputReady('first-final', false, {
    slug: project.slug, videoDir, resolveExternalFinalVideoDir: async () => null,
  })
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)

  const retention = await import('../services/final-video-retention.js')
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA)
  assert.deepEqual(retention.readRetainedFinalVideos(projectDir), [])
  await assert.rejects(fs.stat(path.join(videoDir, retention.PREVIOUS_FINALS_DIRNAME)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
  assert.equal(existsSync(path.join(projectDir, retention.FINAL_VIDEO_REPLACEMENTS_SIDECAR)), false,
    'a first final creates no retention record')
  const job = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(job?.output_lines.some(value => value.startsWith('Previous final kept for ')), false)
})

test('after three days the daily sweep hands the kept final to Story\'s Trash with an index entry', async t => {
  const project = await pm.createProject({ name: `Import Kept Sweep ${++serial}` })
  const projectDir = pm.getProjectDir(project.slug)!
  const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
  const prior = Buffer.from('accepted final that ages into the trash\n')
  const prepared = await prepareOutputReady('kept-sweep', false, {
    slug: project.slug, videoDir, priorDestinationBytes: prior,
    resolveExternalFinalVideoDir: async () => null,
  })
  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)

  const retention = await import('../services/final-video-retention.js')
  const [entry] = retention.readRetainedFinalVideos(projectDir)
  assert.ok(entry)
  const inside = await retention.sweepChannelRetainedFinalVideos({ projectDir, slug: project.slug })
  assert.equal(inside.swept, 0, 'inside the window it stays restorable')
  assert.equal(existsSync(entry!.retained_path), true)

  const later = Date.now() + (retention.FINAL_VIDEO_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000
  const swept = await retention.sweepChannelRetainedFinalVideos({ projectDir, slug: project.slug, now: later })
  assert.equal(swept.swept, 1)
  assert.equal(swept.deferred, 0)
  assert.equal(existsSync(entry!.retained_path), false)
  assert.deepEqual(retention.readRetainedFinalVideos(projectDir), [])

  const trashRoot = trash.trashRootFor(projectDir, projectDir, project.slug)
  const index = await fs.readFile(path.join(path.dirname(trashRoot), '.trash-index.jsonl'), 'utf8')
  const moved = index.trim().split('\n').map(value => JSON.parse(value) as TrashIndexEntry)
    .find(row => row.from === entry!.retained_path)
  assert.ok(moved, 'the move has a Restore entry')
  assert.equal(moved!.kind, 'final-video')
  assert.equal(existsSync(path.join(moved!.to, 'EP1_final_video.mp4')), true, 'the video travelled with the folder')
})

test('a crash between keeping the previous final and publishing it still converges', async t => {
  const project = await pm.createProject({ name: `Import Crash After Keep ${++serial}` })
  const projectDir = pm.getProjectDir(project.slug)!
  const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
  const prior = Buffer.from('accepted final kept across a crash mid-import\n')
  const prepared = await prepareOutputReady('crash-after-keep', false, {
    slug: project.slug, videoDir, priorDestinationBytes: prior,
    resolveExternalFinalVideoDir: async () => null,
  })
  let crashed = false
  installHooks(t, {
    probe: value => {
      if (value.phase !== 'after-output-keep' || crashed) return
      crashed = true
      throw new Error('simulated power loss after the keep')
    },
  })
  let firstError: unknown
  try {
    await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  } catch (error) { firstError = error }

  const retention = await import('../services/final-video-retention.js')
  assert.equal(crashed, true, `the first pass reached the keep: ${String(firstError)}`)
  assert.equal((await canonicalMarker(prepared)).phase, 'importing', 'publication never completed')
  assert.equal(ackPosts(prepared).length, 0, 'an unpublished import never acknowledges')
  const keptDuringCrash = retention.readRetainedFinalVideos(projectDir)
  assert.equal(keptDuringCrash.length, 1, 'the accepted final was kept before the crash')
  assert.deepEqual(
    await fs.readFile(path.join(keptDuringCrash[0]!.retained_path, 'EP1_final_video.mp4')), prior,
  )

  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)
  const recovered = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(recovered?.status, 'done', 'the restart publishes and completes')
  assert.equal(recovered?.local_execution_complete, true)
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA)

  const kept = retention.readRetainedFinalVideos(projectDir)
  assert.equal(kept.length, 1, 'exactly one kept copy, not one per attempt')
  assert.deepEqual(await fs.readFile(path.join(kept[0]!.retained_path, 'EP1_final_video.mp4')), prior)
  assert.equal(ackPosts(prepared).length, 1)
})

test('a keep whose record never reached disk is repaired from its folder and converges', async t => {
  const project = await pm.createProject({ name: `Import Kept Without Record ${++serial}` })
  const projectDir = pm.getProjectDir(project.slug)!
  const videoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
  const prior = Buffer.from('accepted final moved aside before its record was written\n')
  const prepared = await prepareOutputReady('kept-without-record', false, {
    slug: project.slug, videoDir, priorDestinationBytes: prior,
    resolveExternalFinalVideoDir: async () => null,
  })
  // The exact disk state a power loss between the keep and the record write leaves behind.
  const retention = await import('../services/final-video-retention.js')
  const orphan = path.join(
    path.dirname(prepared.destination), retention.PREVIOUS_FINALS_DIRNAME, '2026-10-27T00-00-00-000Z_EP1',
  )
  await fs.mkdir(orphan, { recursive: true, mode: 0o700 })
  await fs.rename(prepared.destination, path.join(orphan, 'EP1_final_video.mp4'))
  assert.deepEqual(retention.readRetainedFinalVideos(projectDir), [], 'no record yet')

  installHooks(t)
  await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)

  const recovered = await queue.loadAuthoritativeJob(prepared.job.project_slug, prepared.job.job_id)
  assert.equal(recovered?.status, 'done', 'the import converges instead of stranding the displaced final')
  assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA)
  const kept = retention.readRetainedFinalVideos(projectDir)
  assert.equal(kept.length, 1, 'the moved-aside final is back on the channel record')
  assert.deepEqual(await fs.readFile(path.join(kept[0]!.retained_path, 'EP1_final_video.mp4')), prior)
})

test('the kept final sits beside a registered project or external final, never in the trash early', async t => {
  const previousLibrary = await settings.getAppSetting('library_root')
  const previousExports = await settings.getAppSetting('exports_root')
  t.after(async () => {
    await settings.setAppSetting('exports_root', previousExports)
    await settings.setAppSetting('library_root', previousLibrary)
  })
  const libraryRoot = path.join(retainedRoot, `kept-beside-library-${++serial}`)
  await fs.mkdir(path.join(libraryRoot, 'Exports'), { recursive: true, mode: 0o700 })
  await settings.setAppSetting('library_root', libraryRoot)
  await settings.setAppSetting('exports_root', '')
  const retention = await import('../services/final-video-retention.js')

  for (const route of ['project-tree', 'external'] as const) {
    await t.test(route, async st => {
      const project = await pm.createProject({ name: `Import Kept Beside ${route} ${serial}` })
      const projectDir = pm.getProjectDir(project.slug)
      assert.ok(projectDir)
      const prior = Buffer.from(`prior ${route} final kept beside the episode\n`)
      const projectVideoDir = path.join(projectDir, 'Episodes', 'EP1', 'Video')
      const selectedDir = route === 'external'
        ? path.join(libraryRoot, 'Exports', project.slug, 'Season 001', 'EP1 - Kept Beside')
        : projectVideoDir
      await fs.mkdir(selectedDir, { recursive: true, mode: 0o700 })
      const destination = path.join(selectedDir, 'EP1_final_video.mp4')
      const prepared = await prepareOutputReady(`kept-beside-${route}`, false, {
        slug: project.slug,
        videoDir: projectVideoDir,
        priorDestinationBytes: prior,
        priorDestinationPath: destination,
        resolveExternalFinalVideoDir: async () => route === 'external' ? selectedDir : null,
      })
      installHooks(st)
      await requireImporter().recoverFinalRenderImport(prepared.job.project_slug, prepared.job.job_id)

      assert.equal(sha256(await fs.readFile(prepared.destination)), OUTPUT_SHA)
      const [entry] = retention.readRetainedFinalVideos(projectDir)
      assert.ok(entry, 'the channel record names the kept final')
      assert.equal(path.dirname(entry.retained_path),
        path.join(path.dirname(prepared.destination), retention.PREVIOUS_FINALS_DIRNAME),
        'the kept folder is beside the final it belonged to, whichever folder that is')
      assert.deepEqual(await fs.readFile(path.join(entry.retained_path, 'EP1_final_video.mp4')), prior)
      // Nothing reached Story's Trash early: the three-day sweep is the only thing that moves it.
      const anchor = route === 'external' ? path.join(libraryRoot, 'Exports') : projectDir
      const earlyTrash = path.join(path.dirname(trash.trashRootFor(anchor, projectDir, project.slug)), '.trash-index.jsonl')
      const lines = await fs.readFile(earlyTrash, 'utf8').catch(() => '')
      assert.equal(lines.includes(entry.retained_path), false, 'the kept copy is not in the trash yet')
    })
  }
})
