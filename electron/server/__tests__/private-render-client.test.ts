import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import type { FinalRenderEncodeEntry } from '../lib/final-render-gateway-client.js'

const GATEWAY_JOB_ID = '55555555-5555-4555-8555-555555555555'
const HUB_JOB_ID = '77777777-7777-4777-8777-777777777777'
const STORY_UUID = '66666666-6666-4666-8666-666666666666'
const OWNER_SCOPE = '33333333-3333-4333-8333-333333333333'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const BEARER = 'cd'.repeat(32)
const SHA = 'a'.repeat(64)
const OUTPUT_SHA = 'e'.repeat(64)
const KEY = 'gateway-attempt-001'
const ORIGIN = 'https://gateway.private.example'
const UPLOAD_ID = '8'.repeat(32)
const ASSET_HANDLE = 'f'.repeat(32)

let retained: Awaited<ReturnType<typeof useTempDataDir>> | undefined
let pairedStoryInstanceId = ''
const originalFetch = globalThis.fetch

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

function digestUtf8(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const TOOLS_UTF8 = canonicalJson({
  format: 'studio.render.tools.v1', platform: 'macos-arm64',
  ffmpeg_sha256: '1'.repeat(64), ffmpeg_size_bytes: 132_141_880,
  ffprobe_sha256: '2'.repeat(64), ffprobe_size_bytes: 131_770_248,
  architecture_evidence_sha256: '3'.repeat(64),
  minimum_os_evidence_sha256: '4'.repeat(64),
  linked_libraries_evidence_sha256: '5'.repeat(64),
  build_configuration_evidence_sha256: '6'.repeat(64),
  capability_inventory_evidence_sha256: '7'.repeat(64),
})
const COMPILER_UTF8 = canonicalJson({
  format: 'studio.render.compiler.v1', implementation: 'hub-final-render-v1',
  python_runtime_sha256: '8'.repeat(64), render_hash_sha256: '9'.repeat(64),
  render_contract_sha256: 'b'.repeat(64), final_render_compiler_sha256: 'c'.repeat(64),
})
const TOOLS_DIGEST = digestUtf8(TOOLS_UTF8)
const COMPILER_DIGEST = digestUtf8(COMPILER_UTF8)
const PROFILE_UTF8 = canonicalJson({
  format: 'studio.render.profile.v1', implementation: 'story-classic-no-font-v1',
  recipe_namespace: 'studio.render.final.v1', compiler_artifact_sha256: COMPILER_DIGEST,
  tools_artifact_sha256: TOOLS_DIGEST,
  combination_set: 'retained-classic-no-font-candidate-v1',
  tier_policy: 'story-final-chain-v1', output_policy: 'story-final-output-v1',
  execution_bounds: {
    canvas_pairs: [{ width: 1920, height: 1080 }], working_fps: [24],
    max_duration_sec: 60, max_operations: 32, max_assets: 32,
    max_asset_bytes: 32 * 1024 * 1024, max_total_input_bytes: 64 * 1024 * 1024,
    max_pixel_frames: 1920 * 1080 * 24 * 60, scratch_reserve_bytes: 1,
    output_limit_bytes: 32 * 1024 * 1024, process_tree_rss_limit_bytes: 1,
    cumulative_wall_seconds: 60,
  },
  hardware_qualification_record_sha256: null, fidelity_record_sha256: null,
  production_eligible: false,
})
const PROFILE_DIGEST = digestUtf8(PROFILE_UTF8)
const LATE_LABEL_MOTIONS = ['none', 'pop', 'slide', 'float', 'pulse', 'wipe', 'line-draw'] as const
const LATE_COMPILER_UTF8 = canonicalJson({
  format: 'studio.render.compiler.v1', implementation: 'hub-final-render-late-label-v3',
  python_runtime_sha256: '8'.repeat(64), render_hash_sha256: '9'.repeat(64),
  render_contract_sha256: 'b'.repeat(64), final_render_compiler_sha256: 'c'.repeat(64),
})
const LATE_COMPILER_DIGEST = digestUtf8(LATE_COMPILER_UTF8)
const LATE_PROFILE_UTF8 = canonicalJson({
  ...JSON.parse(PROFILE_UTF8),
  format: 'studio.render.profile.v3', implementation: 'story-classic-late-label-v3',
  combination_set: 'retained-classic-late-label-candidate-v3',
  compiler_artifact_sha256: LATE_COMPILER_DIGEST,
})
const LATE_PROFILE_DIGEST = digestUtf8(LATE_PROFILE_UTF8)
const LATE_CAPABILITIES = {
  format: 'studio.render.late-label.v3',
  motions: [...LATE_LABEL_MOTIONS],
}
const SUBTITLE_COMPILER_UTF8 = canonicalJson({
  format: 'studio.render.compiler.v1', implementation: 'hub-final-render-subtitle-v1',
  python_runtime_sha256: '8'.repeat(64), render_hash_sha256: '9'.repeat(64),
  render_contract_sha256: 'b'.repeat(64), final_render_compiler_sha256: 'c'.repeat(64),
})
const SUBTITLE_COMPILER_DIGEST = digestUtf8(SUBTITLE_COMPILER_UTF8)
/** The real frozen v4 subtitle bounds: version 2 plus the three required subtitle counters. */
const SUBTITLE_BOUNDS = {
  bounds_version: 2, canvas_range: { max_edge: 3840, max_pixels: 8_294_400 },
  working_fps: [24, 25, 30, 60], max_duration_sec: 10_800, max_operations: 32,
  max_assets: 32, max_asset_bytes: 8_589_934_592, max_total_input_bytes: 17_179_869_184,
  max_pixel_frames: 5_374_771_200_000, scratch_reserve_bytes: 17_179_869_184,
  output_limit_bytes: 8_589_934_592, process_tree_rss_limit_bytes: 10_737_418_240,
  cumulative_wall_seconds: 14_400, max_subtitle_ass_bytes: 4_194_304,
  max_subtitle_font_bytes: 33_554_432, max_subtitle_fonts: 8,
}
const SUBTITLE_PROFILE_UTF8 = canonicalJson({
  format: 'studio.render.profile.v4', implementation: 'story-classic-subtitle-v1',
  recipe_namespace: 'studio.render.final.v1', compiler_artifact_sha256: SUBTITLE_COMPILER_DIGEST,
  tools_artifact_sha256: TOOLS_DIGEST,
  combination_set: 'retained-classic-subtitle-candidate-v1',
  tier_policy: 'story-final-chain-v1', output_policy: 'story-final-output-v1',
  execution_bounds: SUBTITLE_BOUNDS,
  hardware_qualification_record_sha256: null, fidelity_record_sha256: null,
  production_eligible: false,
})
const SUBTITLE_PROFILE_DIGEST = digestUtf8(SUBTITLE_PROFILE_UTF8)
const SUBTITLE_CAPABILITIES = { format: 'studio.render.subtitle.v1' }
/** The same paired profile under the v2 canvas rule: a version and a range, in place of the pairs. */
const BOUNDS_V2 = {
  bounds_version: 2, canvas_range: { max_edge: 3840, max_pixels: 8_294_400 },
  working_fps: [24, 25, 30, 60], max_duration_sec: 10_800, max_operations: 32,
  max_assets: 32, max_asset_bytes: 32 * 1024 * 1024, max_total_input_bytes: 64 * 1024 * 1024,
  max_pixel_frames: 5_374_771_200_000, scratch_reserve_bytes: 1,
  output_limit_bytes: 32 * 1024 * 1024, process_tree_rss_limit_bytes: 1,
  cumulative_wall_seconds: 14_400,
}
function profileV2(executionBounds: Record<string, unknown>): string {
  return canonicalJson({ ...JSON.parse(PROFILE_UTF8), execution_bounds: executionBounds })
}
const PROFILE_V2_UTF8 = profileV2(BOUNDS_V2)

before(async () => {
  retained = await useTempDataDir({ retain: true, settle: async () => {} })
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const identity = await import('../services/private-render-identity.js')
  await settings.setGenStudioUrl(ORIGIN)
  await secrets.setApiKey('genstudio', BEARER)
  const local = await identity.getOrCreatePrivateRenderIdentity()
  pairedStoryInstanceId = local.story_instance_id
  assert.match(pairedStoryInstanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

async function bindingRecord(): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(retained!.dir, 'private-render', 'gateway-binding.json'), 'utf8'))
}

after(async () => {
  globalThis.fetch = originalFetch
  await retained?.cleanup()
})

async function submitBytes(): Promise<Uint8Array> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const fixture = JSON.parse(await fs.readFile(
    path.join(here, 'fixtures', 'final-render-packet-syntax-v1.json'),
    'utf8',
  ))
  const packet = fixture.cases[0].packet
  const assets = Object.fromEntries(packet.manifest.map(
    (entry: { logical_id: string }, index: number) => [
      entry.logical_id,
      (index + 1).toString(16).padStart(32, '0'),
    ],
  ))
  return new TextEncoder().encode(JSON.stringify({
    format: 'studio.render.gateway-request.v1',
    story_uuid: STORY_UUID,
    intent_id: 'episode-final',
    attempt_no: 1,
    packet,
    assets,
  }))
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
    size += next.value.byteLength
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function capabilities(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'studio.render.gateway-capabilities.v1', private: true, chargeable: false,
    owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID,
    story_instance_id: pairedStoryInstanceId, eligible: 0, idle: 0,
    server_time: Math.floor(Date.now() / 1000),
    profile_descriptor_utf8: PROFILE_UTF8, profile_digest: PROFILE_DIGEST,
    tools: { descriptor_utf8: TOOLS_UTF8, digest: TOOLS_DIGEST },
    compiler: { descriptor_utf8: COMPILER_UTF8, digest: COMPILER_DIGEST },
    ...overrides,
  }
}

function outputReceipt(inboundDigest: string, overrides: Record<string, unknown> = {}): {
  utf8: string
  digest: string
} {
  const utf8 = canonicalJson({
    format: 'studio.render.gateway-output-receipt.v1', owner_scope: OWNER_SCOPE,
    gateway_instance_id: GATEWAY_ID, story_instance_id: pairedStoryInstanceId,
    gateway_job_id: GATEWAY_JOB_ID, gateway_attempt_key: KEY, story_uuid: STORY_UUID,
    intent_id: 'episode-final', attempt_no: 1, inbound_story_body_sha256: inboundDigest,
    packet_digest: 'd'.repeat(64), outbound_hub_body_sha256: '1'.repeat(64),
    hub_dispatch_key: `gateway:${KEY}`, dispatch_fence: 'render-dispatch-fence-001',
    hub_owner_scope: 'site:controller:fleet', hub_job_id: HUB_JOB_ID,
    hub_attempt_id: 'abcdefabcdefabcdefabcdefabcdefab', hub_receipt_digest: '2'.repeat(64),
    selected_machine: {
      id: 'node-m4-a', label: 'Private M4', chip: 'Apple M4', memory_gb: 32,
      hardware_class: 'mac-m4-32gb',
    },
    profile_digest: PROFILE_DIGEST, tools_digest: TOOLS_DIGEST,
    compiler_digest: COMPILER_DIGEST, qualification_digest: '3'.repeat(64),
    selected_tier: 'software-h264', generated_command_digest: '4'.repeat(64),
    feature_losses: [], output_sha256: OUTPUT_SHA, output_size_bytes: 32,
    ...overrides,
  })
  return { utf8, digest: digestUtf8(utf8) }
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'studio.render.gateway-job.v1', id: GATEWAY_JOB_ID, state: 'accepted',
    gateway_attempt_key: KEY, story_uuid: STORY_UUID, intent_id: 'episode-final',
    attempt_no: 1, output_ready: false, idempotent_replay: false,
    remote_state: 'accepted', ...overrides,
  }
}

function outputReadyJob(inboundDigest: string, receiptOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const receipt = outputReceipt(inboundDigest, receiptOverrides)
  return job({
    state: 'output_ready', output_ready: true, remote_state: 'output_ready',
    receipt_digest: receipt.digest,
    output: {
      sha256: OUTPUT_SHA, size_bytes: 32, receipt_digest: receipt.digest,
      receipt_utf8: receipt.utf8,
    },
  })
}

function launchedStoppedProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'studio.render.gateway-terminal-proof.v1', kind: 'launched_stopped',
    gateway_job_id: GATEWAY_JOB_ID, gateway_attempt_key: KEY,
    hub_job_id: HUB_JOB_ID, hub_attempt_id: 'a'.repeat(32),
    stopped_evidence_digest: '6'.repeat(64),
    ...overrides,
  }
}

function neverLaunchedProof(inboundDigest: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'studio.render.gateway-terminal-proof.v1', kind: 'never_launched',
    gateway_attempt_key: KEY, inbound_story_body_sha256: inboundDigest,
    fence_receipt: '9'.repeat(32), first_cancel_at: 1_799_000_001.5,
    ...overrides,
  }
}

test('private render client accepts only the closed paired projections on its fixed routes', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const request = await submitBytes()
  const inboundDigest = digestUtf8(request)
  const receipt = outputReceipt(inboundDigest)
  const outputBytes = Uint8Array.from({ length: 10 }, (_, index) => index + 10)
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = async () => { throw new Error('no route but capabilities may run before the Gateway binding is pinned') }
  await assert.rejects(client.submitFinalRender(request, KEY), /binding/i)
  await assert.rejects(bindingRecord(), /ENOENT/)
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const url = String(input)
    if (url.endsWith('/capabilities')) return Response.json(capabilities())
    if (url.includes(`/blobs/${SHA}/status`)) {
      return Response.json({
        format: 'studio.render.gateway-blob.v1', sha256: SHA, size_bytes: 3,
        state: 'uploading', offset: 1, upload_id: UPLOAD_ID,
      })
    }
    if (init.method === 'PUT' && url.includes(`/blobs/${SHA}?`)) {
      assert.deepEqual(
        await readStream(init.body as unknown as ReadableStream<Uint8Array>),
        new Uint8Array([1, 2, 3]),
      )
      return Response.json({
        format: 'studio.render.gateway-blob.v1', sha256: SHA, size_bytes: 3,
        state: 'complete', offset: 3, upload_id: UPLOAD_ID, asset_handle: ASSET_HANDLE,
      })
    }
    if (url.endsWith(`/by-idempotency-key/${KEY}/cancel`)) {
      return Response.json({
        format: 'studio.render.gateway-cancel.v1', state: 'cancelled_before_acceptance',
        gateway_attempt_key: KEY, expected_request_sha256: inboundDigest,
        fence_receipt: '9'.repeat(32),
        first_cancel_at: 1_799_000_001.5,
      })
    }
    if (url.endsWith(`/by-idempotency-key/${KEY}`)) return Response.json(job())
    if (url.endsWith(`/${GATEWAY_JOB_ID}/cancel`)) {
      return Response.json({
        format: 'studio.render.gateway-cancel.v1', state: 'cancel_requested',
        gateway_attempt_key: KEY, expected_request_sha256: inboundDigest,
        gateway_job_id: GATEWAY_JOB_ID,
      })
    }
    if (url.endsWith(`/${GATEWAY_JOB_ID}/output`)) {
      return new Response(outputBytes, {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes', ETag: `"${OUTPUT_SHA}"`,
          'Content-Length': String(outputBytes.byteLength),
          'Content-Range': 'bytes 10-19/32', 'Content-Type': 'video/mp4',
        },
      })
    }
    if (url.endsWith(`/${GATEWAY_JOB_ID}/ack`)) {
      return Response.json({
        format: 'studio.render.gateway-ack.v1', id: GATEWAY_JOB_ID,
        acknowledged: true, receipt_digest: receipt.digest,
      })
    }
    if (url.endsWith(`/${GATEWAY_JOB_ID}`)) return Response.json(outputReadyJob(inboundDigest))
    if (url.endsWith('/v1/final-renders')) {
      return Response.json({
        ...job(), destination_node: 'node-m4-a',
        inbound_story_body_sha256: inboundDigest,
      }, { status: 202 })
    }
    throw new Error(`unexpected fake request ${init.method} ${url}`)
  }

  await client.getFinalRenderCapabilities()
  assert.deepEqual(await bindingRecord(), { origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  const uploading = await client.getFinalRenderBlobStatus(SHA, 3)
  const complete = await client.putFinalRenderBlob({
    sha256: SHA,
    total_bytes: 3,
    offset: 0,
    length: 3,
    body: byteStream(new Uint8Array([1, 2, 3])),
  })
  assert.equal(uploading.upload_id, UPLOAD_ID)
  assert.equal(complete.upload_id, UPLOAD_ID)
  await client.submitFinalRender(request, KEY)
  await client.lookupFinalRenderByKey(KEY)
  await client.getFinalRenderStatus(GATEWAY_JOB_ID)
  await client.cancelFinalRenderByKey(KEY, inboundDigest)
  await client.cancelFinalRender(GATEWAY_JOB_ID)
  await client.downloadFinalRenderOutputRange({
    gateway_job_id: GATEWAY_JOB_ID,
    start: 10,
    end_inclusive: 19,
    etag: `"${OUTPUT_SHA}"`,
  })
  await client.ackFinalRender(GATEWAY_JOB_ID, receipt.digest)

  assert.deepEqual(calls.map(call => [call.init.method, call.url]), [
    ['GET', `${ORIGIN}/v1/final-renders/capabilities`],
    ['GET', `${ORIGIN}/v1/final-renders/blobs/${SHA}/status?size_bytes=3`],
    ['PUT', `${ORIGIN}/v1/final-renders/blobs/${SHA}?size_bytes=3&offset=0`],
    ['POST', `${ORIGIN}/v1/final-renders`],
    ['GET', `${ORIGIN}/v1/final-renders/by-idempotency-key/${KEY}`],
    ['GET', `${ORIGIN}/v1/final-renders/${GATEWAY_JOB_ID}`],
    ['POST', `${ORIGIN}/v1/final-renders/by-idempotency-key/${KEY}/cancel`],
    ['POST', `${ORIGIN}/v1/final-renders/${GATEWAY_JOB_ID}/cancel`],
    ['GET', `${ORIGIN}/v1/final-renders/${GATEWAY_JOB_ID}/output`],
    ['POST', `${ORIGIN}/v1/final-renders/${GATEWAY_JOB_ID}/ack`],
  ])
  for (const { init } of calls) {
    const headers = new Headers(init.headers)
    assert.equal(headers.get('Authorization'), `Bearer ${BEARER}`)
    assert.equal(headers.get('X-Story-Instance'), pairedStoryInstanceId)
    assert.equal(headers.get('X-Api-Key'), null)
    assert.equal(init.redirect, 'error')
  }

  const upload = calls[2]!
  assert.equal(new Headers(upload.init.headers).get('Content-Range'), 'bytes 0-2/3')
  assert.equal(new Headers(upload.init.headers).get('Content-Length'), '3')
  const submit = calls[3]!
  assert.equal(new Headers(submit.init.headers).get('Idempotency-Key'), KEY)
  assert.deepEqual(new Uint8Array(submit.init.body as Uint8Array), request)
  const sent = JSON.parse(new TextDecoder().decode(submit.init.body as Uint8Array))
  assert.deepEqual(Object.keys(sent.assets), sent.packet.manifest.map((entry: { logical_id: string }) => entry.logical_id))
  for (const handle of Object.values(sent.assets)) assert.match(String(handle), /^[0-9a-f]{32}$/)
  assert.equal(calls[6]!.init.body, JSON.stringify({ expected_request_sha256: inboundDigest }))
  assert.equal(new Headers(calls[8]!.init.headers).get('Range'), 'bytes=10-19')
  assert.equal(new Headers(calls[8]!.init.headers).get('If-Match'), `"${OUTPUT_SHA}"`)
  const ackBytes = new TextEncoder().encode(JSON.stringify({ expected_receipt_digest: receipt.digest }))
  assert.deepEqual(new Uint8Array(calls[9]!.init.body as Uint8Array), ackBytes)
  assert.equal(new Headers(calls[9]!.init.headers).get('Content-Length'), String(ackBytes.byteLength))
})

test('a scoped capability read asks about the exact encode and refuses a wrong echo', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const requested: FinalRenderEncodeEntry = {
    container: 'mp4', requested_codec: 'h264', requested_effort: 'hardware',
    crf: 23, quality_cpu_preset: 'medium', bitrate_kbps: null,
  }
  const capped: FinalRenderEncodeEntry = { ...requested, bitrate_kbps: 8_000 }
  const seen: string[] = []
  const answer = (overrides: Record<string, unknown> = {}) => {
    globalThis.fetch = async (input) => {
      seen.push(String(input))
      return Response.json(capabilities(overrides))
    }
  }

  // The query carries exactly the six fields, URL-encoded, and nothing else.
  answer({ requested_encode: requested })
  const echoed = await client.getFinalRenderCapabilities(requested)
  assert.equal(echoed.requested_encode?.requested_effort, 'hardware')
  const url = new URL(seen[0]!)
  assert.equal(url.pathname, '/v1/final-renders/capabilities')
  assert.deepEqual(JSON.parse(url.searchParams.get('requested_encode')!), requested)
  assert.deepEqual([...url.searchParams.keys()], ['requested_encode'], 'no other query value rides along')

  // A positive cap is its own tuple and never equals no cap.
  answer({ requested_encode: capped })
  const cappedEcho = await client.getFinalRenderCapabilities(capped)
  assert.equal(cappedEcho.requested_encode?.bitrate_kbps, 8_000)
  assert.notDeepEqual(cappedEcho.requested_encode, echoed.requested_encode)

  const reject = async (overrides: Record<string, unknown>, pattern: RegExp, asked = true) => {
    answer(overrides)
    await assert.rejects(
      asked ? client.getFinalRenderCapabilities(requested) : client.getFinalRenderCapabilities(),
      pattern,
    )
  }
  // An echo of a different tuple is refused.
  await reject({ requested_encode: { ...requested, crf: 18 } }, /echo|requested|encode|response|invalid/i)
  // An unsolicited echo — one Story never asked for — is refused.
  await reject({ requested_encode: requested }, /echo|requested|encode|response|invalid/i, false)
  // An echoed scope that lists another tuple is refused.
  await reject({
    requested_encode: requested,
    encode: { format: 'studio.render.encode-authority.v1', entries: [{ ...requested, bitrate_kbps: 8_000 }] },
  }, /entry|encode|response|invalid/i)
  await reject({
    requested_encode: requested, eligible: 0, idle: 0,
    encode: { format: 'studio.render.encode-authority.v1', entries: [requested] },
  }, /eligible|response|invalid/i)
  answer({
    requested_encode: requested, eligible: 1, idle: 0,
    encode: { format: 'studio.render.encode-authority.v1', entries: [requested] },
  })
  assert.equal((await client.getFinalRenderCapabilities(requested)).idle, 0)
  // An echoed scope with an extra field is refused.
  await reject({ requested_encode: { ...requested, extra: true } }, /field|exact|response|invalid/i)
})

test('a late-label-scoped read requests the exact contract and accepts only its paired response', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const requested: FinalRenderEncodeEntry = {
    container: 'mp4', requested_codec: 'h264', requested_effort: 'hardware',
    crf: 23, quality_cpu_preset: 'medium', bitrate_kbps: null,
  }
  const seen: string[] = []
  const answer = (overrides: Record<string, unknown> = {}) => {
    globalThis.fetch = async (input) => {
      seen.push(String(input))
      return Response.json(capabilities(overrides))
    }
  }
  const lateOverrides = (overrides: Record<string, unknown> = {}) => ({
    profile_descriptor_utf8: LATE_PROFILE_UTF8,
    profile_digest: LATE_PROFILE_DIGEST,
    compiler: { descriptor_utf8: LATE_COMPILER_UTF8, digest: LATE_COMPILER_DIGEST },
    late_labels: LATE_CAPABILITIES,
    ...overrides,
  })

  // The contract query rides after the exact encode tuple when both are asked for.
  answer(lateOverrides({ requested_encode: requested }))
  const scoped = await client.getFinalRenderCapabilities(requested, { requestedLateLabels: true })
  assert.deepEqual(scoped.late_labels, LATE_CAPABILITIES)
  const url = new URL(seen[0]!)
  assert.equal(url.pathname, '/v1/final-renders/capabilities')
  assert.equal(url.searchParams.get('requested_encode'), JSON.stringify(requested))
  assert.equal(url.searchParams.get('requested_contract'), 'studio.render.late-label.v3')
  assert.deepEqual([...url.searchParams.keys()], ['requested_encode', 'requested_contract'])

  // A cue composition can ask without an encode scope; the contract remains exact.
  answer(lateOverrides())
  const cueOnly = await client.getFinalRenderCapabilities(undefined, { requestedLateLabels: true })
  assert.equal(cueOnly.late_labels?.format, 'studio.render.late-label.v3')
  assert.equal(seen[1]!.includes('requested_encode='), false)

  // A Gateway that ignores the query answers with the existing v1 pair and no late-label field.
  answer()
  const oldGateway = await client.getFinalRenderCapabilities(requested, { requestedLateLabels: true })
  assert.equal(oldGateway.late_labels, undefined)
  assert.equal(oldGateway.profile_descriptor_utf8, PROFILE_UTF8)
  assert.equal(oldGateway.compiler.descriptor_utf8, COMPILER_UTF8)

  const reject = async (overrides: Record<string, unknown>, pattern: RegExp) => {
    answer(lateOverrides(overrides))
    await assert.rejects(
      client.getFinalRenderCapabilities(undefined, { requestedLateLabels: true }),
      pattern,
    )
  }
  await reject({ late_labels: { format: 'studio.render.late-label.v1', motions: ['none'] } },
    /late_labels|unsupported|response|invalid/i)
  await reject({ late_labels: { format: 'studio.render.late-label.v3', motions: ['none', 'float'] } },
    /complete supported set|response|invalid/i)
  await reject({ late_labels: { format: 'studio.render.late-label.v3', motions: ['none', 'none'] } },
    /motions|duplicated|response|invalid/i)
  await reject({ late_labels: { format: 'studio.render.late-label.v3', motions: ['none', 'float', 'float'] } },
    /motions|unsupported|response|invalid/i)
  await reject({ late_labels: { format: 'studio.render.late-label.v3', motions: ['none', 'float'], extra: true } },
    /field|exact|response|invalid/i)
  await reject({ late_labels: LATE_CAPABILITIES, compiler: { descriptor_utf8: COMPILER_UTF8, digest: COMPILER_DIGEST } },
    /compiler|unsupported|response|invalid/i)
  await reject({ late_labels: LATE_CAPABILITIES, profile_descriptor_utf8: PROFILE_UTF8, profile_digest: PROFILE_DIGEST },
    /profile|unsupported|response|invalid/i)

  // An unsolicited late-label field in a normal read fails closed.
  answer({ late_labels: LATE_CAPABILITIES })
  await assert.rejects(
    client.getFinalRenderCapabilities(),
    /late labels|requested|response|invalid/i,
  )
})

test('a subtitle-scoped read requests the exact contract and fails closed until descriptor pins freeze', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const requested: FinalRenderEncodeEntry = {
    container: 'mp4', requested_codec: 'h264', requested_effort: 'hardware',
    crf: 23, quality_cpu_preset: 'medium', bitrate_kbps: null,
  }
  const seen: string[] = []
  const answer = (overrides: Record<string, unknown> = {}) => {
    globalThis.fetch = async (input) => {
      seen.push(String(input))
      return Response.json(capabilities(overrides))
    }
  }

  // The subtitle contract takes the single requested_contract slot, alone.
  answer()
  const scoped = await client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true })
  assert.equal(scoped.subtitles, undefined)
  const url = new URL(seen[0]!)
  assert.equal(url.pathname, '/v1/final-renders/capabilities')
  assert.equal(url.searchParams.get('requested_contract'), 'studio.render.subtitle.v1')
  assert.deepEqual([...url.searchParams.keys()], ['requested_contract'])

  // An encode-scoped subtitle read carries both values and nothing else.
  answer({ requested_encode: requested })
  await client.getFinalRenderCapabilities(requested, { requestedSubtitles: true })
  const both = new URL(seen[1]!)
  assert.equal(both.searchParams.get('requested_contract'), 'studio.render.subtitle.v1')
  assert.deepEqual(JSON.parse(both.searchParams.get('requested_encode')!), requested)
  assert.deepEqual([...both.searchParams.keys()], ['requested_encode', 'requested_contract'])

  // An old Gateway answers the v1 pair with no subtitle field: accepted, no authority.
  answer()
  const oldGateway = await client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true })
  assert.equal(oldGateway.subtitles, undefined)

  // Combined cue+subtitle scope asks the subtitle contract in the single slot. The
  // response must carry the v4 subtitle descriptor pair; a late-label envelope may
  // then ride alongside it on the same candidate, and both authorities are read.
  answer({
    profile_descriptor_utf8: SUBTITLE_PROFILE_UTF8,
    profile_digest: SUBTITLE_PROFILE_DIGEST,
    compiler: { descriptor_utf8: SUBTITLE_COMPILER_UTF8, digest: SUBTITLE_COMPILER_DIGEST },
    subtitles: SUBTITLE_CAPABILITIES,
    late_labels: LATE_CAPABILITIES,
  })
  const combined = await client.getFinalRenderCapabilities(undefined, { requestedLateLabels: true, requestedSubtitles: true })
  assert.equal(combined.late_labels?.format, 'studio.render.late-label.v3')
  assert.equal(combined.subtitles?.format, 'studio.render.subtitle.v1')
  assert.equal(new URL(seen[3]!).searchParams.get('requested_contract'), 'studio.render.subtitle.v1')
  // A late-label descriptor pair answering a combined query carries no subtitle field,
  // so it is the "no subtitle authority" answer: late-label authority is read and kept,
  // and no subtitle authority is granted. The descriptor pair still matches its scope.
  answer({
    profile_descriptor_utf8: LATE_PROFILE_UTF8,
    profile_digest: LATE_PROFILE_DIGEST,
    compiler: { descriptor_utf8: LATE_COMPILER_UTF8, digest: LATE_COMPILER_DIGEST },
    late_labels: LATE_CAPABILITIES,
  })
  const noSubtitleAuthority = await client.getFinalRenderCapabilities(undefined, { requestedLateLabels: true, requestedSubtitles: true })
  assert.equal(noSubtitleAuthority.late_labels?.format, 'studio.render.late-label.v3')
  assert.equal(noSubtitleAuthority.subtitles, undefined)

  // The frozen v4 descriptor triple is admitted: profile studio.render.profile.v4 with the
  // subtitle implementation, compiler hub-final-render-subtitle-v1, and the three subtitle
  // execution counters present. Its execution bounds carry the published subtitle ceilings.
  answer({
    profile_descriptor_utf8: SUBTITLE_PROFILE_UTF8,
    profile_digest: SUBTITLE_PROFILE_DIGEST,
    compiler: { descriptor_utf8: SUBTITLE_COMPILER_UTF8, digest: SUBTITLE_COMPILER_DIGEST },
    subtitles: SUBTITLE_CAPABILITIES,
  })
  const admitted = await client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true })
  assert.equal(admitted.subtitles?.format, 'studio.render.subtitle.v1')
  const admittedBounds = admitted.execution_bounds!
  assert.equal('max_subtitle_fonts' in admittedBounds ? admittedBounds.max_subtitle_fonts : undefined, 8)
  assert.equal('max_subtitle_ass_bytes' in admittedBounds ? admittedBounds.max_subtitle_ass_bytes : undefined, 4_194_304)
  // A well-formed subtitle record under a non-subtitle descriptor pair is refused: a
  // capability flag never grants authority under a profile this build does not accept.
  answer({ subtitles: SUBTITLE_CAPABILITIES })
  await assert.rejects(
    client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true }),
    /profile|compiler|unsupported|invalid/i,
  )
  // A subtitle-scoped v4 profile missing a required subtitle counter is refused.
  answer({
    profile_descriptor_utf8: canonicalJson({
      ...JSON.parse(SUBTITLE_PROFILE_UTF8),
      execution_bounds: Object.fromEntries(
        Object.entries(SUBTITLE_BOUNDS).filter(([key]) => key !== 'max_subtitle_font_bytes')),
    }),
    profile_digest: digestUtf8(canonicalJson({
      ...JSON.parse(SUBTITLE_PROFILE_UTF8),
      execution_bounds: Object.fromEntries(
        Object.entries(SUBTITLE_BOUNDS).filter(([key]) => key !== 'max_subtitle_font_bytes')),
    })),
    compiler: { descriptor_utf8: SUBTITLE_COMPILER_UTF8, digest: SUBTITLE_COMPILER_DIGEST },
    subtitles: SUBTITLE_CAPABILITIES,
  })
  await assert.rejects(
    client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true }),
    /execution_bounds|subtitle|invalid|exact/i,
  )
  // The record shape itself is still exact.
  answer({ subtitles: { format: 'studio.render.subtitle.v9' } })
  await assert.rejects(
    client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true }),
    /format|unsupported|response|invalid/i,
  )
  // Unsolicited subtitle authority in a normal read fails closed.
  answer({ subtitles: SUBTITLE_CAPABILITIES })
  await assert.rejects(
    client.getFinalRenderCapabilities(),
    /subtitles|requested|response|invalid/i,
  )
  // A subtitle-scoped answer may not smuggle in a late-label envelope.
  answer({ late_labels: LATE_CAPABILITIES })
  await assert.rejects(
    client.getFinalRenderCapabilities(undefined, { requestedSubtitles: true }),
    /field|exact|response|invalid/i,
  )
  // A base (non-subtitle) profile may not smuggle in the subtitle counters.
  answer({
    profile_descriptor_utf8: canonicalJson({
      ...JSON.parse(PROFILE_UTF8),
      execution_bounds: { ...BOUNDS_V2, max_subtitle_fonts: 8 },
    }),
    profile_digest: digestUtf8(canonicalJson({
      ...JSON.parse(PROFILE_UTF8),
      execution_bounds: { ...BOUNDS_V2, max_subtitle_fonts: 8 },
    })),
  })
  await assert.rejects(
    client.getFinalRenderCapabilities(),
    /execution_bounds|exact|invalid/i,
  )
})

test('closed client rejects wrong response bindings, digests, states, ranges, and extra fields', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const request = await submitBytes()
  const inboundDigest = digestUtf8(request)
  const receipt = outputReceipt(inboundDigest)

  async function rejectJson(call: () => Promise<unknown>, value: unknown, status = 200): Promise<void> {
    globalThis.fetch = async () => Response.json(value, { status })
    await assert.rejects(call(), /response|schema|contract|binding|digest|state|field|invalid|fresh/i)
  }

  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    capabilities({ owner_scope: '11111111-1111-4111-8111-111111111111' }),
  )
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    capabilities({ gateway_instance_id: '11111111-1111-4111-8111-111111111111' }),
  )
  assert.deepEqual(await bindingRecord(), { origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID },
    'a different Gateway identity is refused and never re-pairs')
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    capabilities({ profile_digest: '0'.repeat(64) }),
  )
  const extendedProfile = canonicalJson({ ...JSON.parse(PROFILE_UTF8), extra: true })
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    capabilities({
      profile_descriptor_utf8: extendedProfile,
      profile_digest: digestUtf8(extendedProfile),
    }),
  )
  const changedTools = canonicalJson({ ...JSON.parse(TOOLS_UTF8), ffmpeg_size_bytes: 1 })
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    capabilities({ tools: { descriptor_utf8: changedTools, digest: digestUtf8(changedTools) } }),
  )
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    capabilities({ server_time: Math.floor(Date.now() / 1000) - 121 }),
  )
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    // Well past the +30s window: +31 flaked when the clock ticked a second before the client's own check.
    capabilities({ server_time: Math.floor(Date.now() / 1000) + 60 }),
  )
  await rejectJson(
    () => client.getFinalRenderCapabilities(),
    { ...capabilities(), extra: true },
  )
  await rejectJson(
    () => client.submitFinalRender(request, KEY),
    {
      ...job(), destination_node: 'node-m4-a',
      inbound_story_body_sha256: '0'.repeat(64),
    },
    202,
  )
  await rejectJson(
    () => client.lookupFinalRenderByKey(KEY),
    job({ state: 'queued' }),
  )
  await rejectJson(
    () => client.getFinalRenderStatus(GATEWAY_JOB_ID),
    { ...job(), extra: true },
  )
  await rejectJson(
    () => client.getFinalRenderStatus(GATEWAY_JOB_ID),
    outputReadyJob(inboundDigest, { gateway_instance_id: '11111111-1111-4111-8111-111111111111' }),
  )
  const receiptWithExtra = outputReceipt(inboundDigest, { extra: true })
  await rejectJson(
    () => client.getFinalRenderStatus(GATEWAY_JOB_ID),
    job({
      state: 'output_ready', output_ready: true, remote_state: 'output_ready',
      receipt_digest: receiptWithExtra.digest,
      output: {
        sha256: OUTPUT_SHA, size_bytes: 32, receipt_digest: receiptWithExtra.digest,
        receipt_utf8: receiptWithExtra.utf8,
      },
    }),
  )
  const validOutput = outputReadyJob(inboundDigest)
  await rejectJson(
    () => client.getFinalRenderStatus(GATEWAY_JOB_ID),
    { ...validOutput, receipt_digest: '0'.repeat(64) },
  )
  await rejectJson(
    () => client.getFinalRenderBlobStatus(SHA, 3),
    {
      format: 'studio.render.gateway-blob.v1', sha256: SHA, size_bytes: 3,
      state: 'complete', offset: 2, upload_id: UPLOAD_ID, asset_handle: ASSET_HANDLE,
    },
  )
  await rejectJson(
    () => client.cancelFinalRenderByKey(KEY, inboundDigest),
    {
      format: 'studio.render.gateway-cancel.v1', state: 'cancel_requested',
      gateway_attempt_key: KEY, expected_request_sha256: '0'.repeat(64),
      gateway_job_id: GATEWAY_JOB_ID,
    },
  )
  await rejectJson(
    () => client.cancelFinalRender(GATEWAY_JOB_ID),
    {
      format: 'studio.render.gateway-cancel.v1', state: 'stopped',
      gateway_attempt_key: KEY, expected_request_sha256: inboundDigest,
      gateway_job_id: GATEWAY_JOB_ID,
    },
  )
  await rejectJson(
    () => client.ackFinalRender(GATEWAY_JOB_ID, receipt.digest),
    {
      format: 'studio.render.gateway-ack.v1', id: GATEWAY_JOB_ID,
      acknowledged: true, receipt_digest: receipt.digest, extra: true,
    },
  )

  globalThis.fetch = async () => new Response(new Uint8Array(10), {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes', ETag: `"${OUTPUT_SHA}"`, 'Content-Length': '10',
      'Content-Range': 'bytes 11-20/32', 'Content-Type': 'video/mp4',
    },
  })
  await assert.rejects(client.downloadFinalRenderOutputRange({
    gateway_job_id: GATEWAY_JOB_ID, start: 10, end_inclusive: 19,
    etag: `"${OUTPUT_SHA}"`,
  }), /output|range|contract|schema|descriptor/i)
})

test('strict raw JSON decoding rejects duplicate decoded keys at every client boundary', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const request = await submitBytes()
  const inboundDigest = digestUtf8(request)
  const accepted: string[] = []

  async function mustReject(label: string, call: () => Promise<unknown>): Promise<void> {
    try {
      await call()
      accepted.push(label)
    } catch (error) {
      assert.match(String(error), /duplicate|response|schema|contract|field|invalid/i, label)
    }
  }

  const outer = canonicalJson(capabilities()).replace(
    `"owner_scope":"${OWNER_SCOPE}"`,
    `"owner_scope":"11111111-1111-4111-8111-111111111111","owner_scope":"${OWNER_SCOPE}"`,
  )
  globalThis.fetch = async () => new Response(outer)
  await mustReject('outer response', () => client.getFinalRenderCapabilities())

  const duplicateTools = TOOLS_UTF8.replace(
    `"ffmpeg_sha256":"${'1'.repeat(64)}"`,
    `"ffmpeg_sha256":"${'0'.repeat(64)}","ffmpeg\\u005fsha256":"${'1'.repeat(64)}"`,
  )
  const duplicateToolsDigest = digestUtf8(duplicateTools)
  const linkedProfile = canonicalJson({
    ...JSON.parse(PROFILE_UTF8),
    tools_artifact_sha256: duplicateToolsDigest,
  })
  globalThis.fetch = async () => Response.json(capabilities({
    tools: { descriptor_utf8: duplicateTools, digest: duplicateToolsDigest },
    profile_descriptor_utf8: linkedProfile,
    profile_digest: digestUtf8(linkedProfile),
  }))
  await mustReject('tools descriptor', () => client.getFinalRenderCapabilities())

  const receipt = outputReceipt(inboundDigest)
  const duplicateReceipt = receipt.utf8.replace(
    `"gateway_instance_id":"${GATEWAY_ID}"`,
    `"gateway_instance_id":"11111111-1111-4111-8111-111111111111","gateway\\u005finstance_id":"${GATEWAY_ID}"`,
  )
  const duplicateReceiptDigest = digestUtf8(duplicateReceipt)
  globalThis.fetch = async () => Response.json(job({
    state: 'output_ready', output_ready: true, remote_state: 'output_ready',
    receipt_digest: duplicateReceiptDigest,
    output: {
      sha256: OUTPUT_SHA, size_bytes: 32, receipt_digest: duplicateReceiptDigest,
      receipt_utf8: duplicateReceipt,
    },
  }))
  await mustReject('output receipt', () => client.getFinalRenderStatus(GATEWAY_JOB_ID))

  const requestText = new TextDecoder().decode(request)
  const duplicateRequestText = requestText.replace(
    '"attempt_no":1',
    '"attempt_no":2,"attempt\\u005fno":1',
  )
  const duplicateRequest = new TextEncoder().encode(duplicateRequestText)
  let requestCalls = 0
  globalThis.fetch = async () => {
    requestCalls += 1
    return Response.json({
      ...job(), destination_node: 'node-m4-a',
      inbound_story_body_sha256: digestUtf8(duplicateRequest),
    }, { status: 202 })
  }
  await mustReject('request envelope', () => client.submitFinalRender(duplicateRequest, KEY))

  assert.deepEqual(accepted, [])
  assert.equal(requestCalls, 0)
})

test('strict raw JSON decoding rejects BOM, lone surrogates, and unsafe integers', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const request = await submitBytes()
  const inboundDigest = digestUtf8(request)

  globalThis.fetch = async () => new Response(`\ufeff${canonicalJson(capabilities())}`)
  await assert.rejects(client.getFinalRenderCapabilities(), /response|schema|contract|invalid/i)

  const serverTime = Math.floor(Date.now() / 1000)
  const unsafeInteger = canonicalJson(capabilities({ server_time: serverTime })).replace(
    `"server_time":${serverTime}`,
    '"server_time":9007199254740993',
  )
  globalThis.fetch = async () => new Response(unsafeInteger)
  await assert.rejects(client.getFinalRenderCapabilities(), /response|schema|safe|invalid/i)

  const receipt = outputReceipt(inboundDigest)
  const surrogateReceipt = receipt.utf8.replace(
    '"label":"Private M4"',
    '"label":"\\ud800"',
  )
  const surrogateDigest = digestUtf8(surrogateReceipt)
  globalThis.fetch = async () => Response.json(job({
    state: 'output_ready', output_ready: true, remote_state: 'output_ready',
    receipt_digest: surrogateDigest,
    output: {
      sha256: OUTPUT_SHA, size_bytes: 32, receipt_digest: surrogateDigest,
      receipt_utf8: surrogateReceipt,
    },
  }))
  await assert.rejects(
    client.getFinalRenderStatus(GATEWAY_JOB_ID),
    /response|schema|contract|surrogate|invalid/i,
  )
})

test('terminal proof is an optional exact projection bound to the known job or cancellation', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const request = await submitBytes()
  const inboundDigest = digestUtf8(request)
  const launched = launchedStoppedProof()
  const never = neverLaunchedProof(inboundDigest)

  globalThis.fetch = async () => Response.json(job({
    cancel_state: 'cancelled', remote_state: 'cancelled', terminal_proof: launched,
  }))
  const status = await client.getFinalRenderStatus(GATEWAY_JOB_ID)
  assert.deepEqual(status.terminal_proof, launched)

  globalThis.fetch = async () => Response.json({
    format: 'studio.render.gateway-cancel.v1', state: 'cancelled_before_acceptance',
    gateway_attempt_key: KEY, expected_request_sha256: inboundDigest,
    fence_receipt: never.fence_receipt, first_cancel_at: never.first_cancel_at,
    terminal_proof: never,
  })
  const cancelled = await client.cancelFinalRenderByKey(KEY, inboundDigest)
  assert.deepEqual(cancelled.terminal_proof, never)

  globalThis.fetch = async () => Response.json(job())
  const pending = await client.getFinalRenderStatus(GATEWAY_JOB_ID)
  assert.equal(Object.hasOwn(pending, 'terminal_proof'), false)
})

test('terminal proof rejects null, partial, extra, alias, and mismatched identity fields', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const request = await submitBytes()
  const inboundDigest = digestUtf8(request)

  async function rejectStatus(terminalProof: unknown): Promise<void> {
    globalThis.fetch = async () => Response.json(job({
      cancel_state: 'cancelled', remote_state: 'cancelled', terminal_proof: terminalProof,
    }))
    await assert.rejects(
      client.getFinalRenderStatus(GATEWAY_JOB_ID),
      /terminal|proof|response|schema|contract|binding|field|invalid/i,
    )
  }

  for (const invalid of [
    null,
    { ...launchedStoppedProof(), stopped_evidence_digest: undefined },
    { ...launchedStoppedProof(), extra: true },
    (() => {
      const { stopped_evidence_digest: stopped, ...proof } = launchedStoppedProof()
      return { ...proof, stopped_digest: stopped }
    })(),
    launchedStoppedProof({ gateway_job_id: '11111111-1111-4111-8111-111111111111' }),
    launchedStoppedProof({ gateway_attempt_key: 'different-key' }),
    launchedStoppedProof({ hub_attempt_id: 'not-hex' }),
  ]) await rejectStatus(invalid)

  async function rejectCancel(terminalProof: unknown): Promise<void> {
    globalThis.fetch = async () => Response.json({
      format: 'studio.render.gateway-cancel.v1', state: 'cancelled_before_acceptance',
      gateway_attempt_key: KEY, expected_request_sha256: inboundDigest,
      fence_receipt: '9'.repeat(32), first_cancel_at: 1_799_000_001.5,
      terminal_proof: terminalProof,
    })
    await assert.rejects(
      client.cancelFinalRenderByKey(KEY, inboundDigest),
      /terminal|proof|response|schema|contract|binding|digest|field|invalid/i,
    )
  }

  for (const invalid of [
    { ...neverLaunchedProof(inboundDigest), inbound_story_body_sha256: '0'.repeat(64) },
    { ...neverLaunchedProof(inboundDigest), gateway_attempt_key: 'different-key' },
    { ...neverLaunchedProof(inboundDigest), fence_receipt: '99999999-9999-4999-8999-999999999999' },
    { ...neverLaunchedProof(inboundDigest), first_cancel_at: -1 },
  ]) await rejectCancel(invalid)
})

test('closed client rejects caller-shaped routes, envelope extensions, and malformed identifiers before fetch', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({})
  }
  const exact = JSON.parse(new TextDecoder().decode(await submitBytes()))
  const extended = new TextEncoder().encode(JSON.stringify({
    ...exact,
    profile_id: 'caller-selected-profile',
  }))

  assert.throws(() => client.submitFinalRender(extended, KEY), /envelope|field|exact|invalid/i)
  assert.throws(() => client.lookupFinalRenderByKey('../arbitrary'), /key|invalid/i)
  assert.throws(() => client.getFinalRenderStatus('https://elsewhere.example/job'), /job|uuid|invalid/i)
  assert.throws(() => client.getFinalRenderBlobStatus('not-a-sha', 3), /sha|digest|invalid/i)
  assert.equal(calls, 0)

  for (const metadata of [
    { total_bytes: 3, offset: 0, length: 0 },
    { total_bytes: 3, offset: 0, length: 1.5 },
    { total_bytes: Number.MAX_SAFE_INTEGER + 1, offset: 0, length: 1 },
    { total_bytes: 3, offset: 0.5, length: 1 },
    { total_bytes: 3, offset: 3, length: 1 },
    { total_bytes: 8 * 1024 * 1024 + 1, offset: 0, length: 8 * 1024 * 1024 + 1 },
  ]) {
    let readerRequested = false
    const body = new ReadableStream<Uint8Array>()
    const getReader = body.getReader.bind(body)
    Object.defineProperty(body, 'getReader', {
      value: () => {
        readerRequested = true
        return getReader()
      },
    })
    await assert.rejects(client.putFinalRenderBlob({ sha256: SHA, ...metadata, body }), /length|range|safe|invalid/i)
    assert.equal(readerRequested, false, JSON.stringify(metadata))
    assert.equal(calls, 0, JSON.stringify(metadata))
  }

  globalThis.fetch = async (_input, init = {}) => {
    calls += 1
    await readStream(init.body as unknown as ReadableStream<Uint8Array>)
    return Response.json({})
  }
  for (const bytes of [new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4])]) {
    await assert.rejects(client.putFinalRenderBlob({
      sha256: SHA,
      total_bytes: 3,
      offset: 0,
      length: 3,
      body: byteStream(bytes),
    }), /body|length|bytes/i)
  }
})

test('the paired profile is read at the bounds version it states, and an unknown one is refused', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const serve = (profile: string) => {
    globalThis.fetch = async () => Response.json(capabilities({
      profile_descriptor_utf8: profile, profile_digest: digestUtf8(profile),
    }))
  }
  const refuses = async (profile: string, message: string): Promise<void> => {
    serve(profile)
    await assert.rejects(client.getFinalRenderCapabilities(), error => {
      const text = String(error)
      assert.match(text, /Invalid private final render/)
      assert.ok(text.includes(message), `expected ${message} in ${text}`)
      return true
    })
  }

  // v1, unchanged: an open pair list and no version key at all, so an older Gateway still pairs.
  serve(PROFILE_UTF8)
  const versionOne = await client.getFinalRenderCapabilities()
  const versionOneBounds = versionOne.execution_bounds
  assert.ok(versionOneBounds && 'canvas_pairs' in versionOneBounds, 'v1 bounds are an open pair list')
  assert.deepEqual(versionOneBounds.canvas_pairs, [{ width: 1920, height: 1080 }])
  assert.deepEqual(versionOneBounds.working_fps, [24])
  assert.equal(Object.hasOwn(versionOneBounds, 'bounds_version'), false)
  assert.equal(Object.hasOwn(versionOneBounds, 'canvas_range'), false)

  // v2: the version it states, the range it states, and no pairs.
  serve(PROFILE_V2_UTF8)
  const versionTwo = await client.getFinalRenderCapabilities()
  const versionTwoBounds = versionTwo.execution_bounds
  assert.ok(versionTwoBounds && 'canvas_range' in versionTwoBounds, 'v2 bounds state a range')
  assert.deepEqual(versionTwoBounds, BOUNDS_V2)
  assert.equal(Object.hasOwn(versionTwoBounds, 'canvas_pairs'), false)

  // Each rule's fields are closed, so a version and the other rule's shape cannot both be read.
  await refuses(profileV2({ ...BOUNDS_V2, canvas_pairs: [{ width: 1920, height: 1080 }] }),
    'profile descriptor.execution_bounds must have the exact closed fields')
  await refuses(canonicalJson({
    ...JSON.parse(PROFILE_UTF8),
    execution_bounds: {
      ...(JSON.parse(PROFILE_UTF8).execution_bounds as Record<string, unknown>),
      canvas_range: { max_edge: 3840, max_pixels: 8_294_400 },
    },
  }), 'profile descriptor.execution_bounds must have the exact closed fields')

  // An unknown version is refused by name: never read as v1 because a pair list is absent, and never
  // read as v2 because the shape looks close enough.
  for (const version of [1, 3, '2', null, 2.5, true]) {
    await refuses(profileV2({ ...BOUNDS_V2, bounds_version: version }),
      `profile descriptor.execution_bounds.bounds_version ${JSON.stringify(version)} is unsupported`)
  }
  await refuses(profileV2({ ...BOUNDS_V2, canvas_range: { max_edge: 3840, max_pixels: 8_294_400, extra: 1 } }),
    'profile descriptor.execution_bounds.canvas_range must have the exact closed fields')
  await refuses(profileV2({ ...BOUNDS_V2, canvas_range: { max_edge: 0, max_pixels: 8_294_400 } }),
    'profile descriptor.execution_bounds.canvas_range.max_edge must be a positive safe integer')
  await refuses(profileV2({ ...BOUNDS_V2, canvas_range: { max_edge: 3840, max_pixels: 0 } }),
    'profile descriptor.execution_bounds.canvas_range.max_pixels must be a positive safe integer')
  await refuses(profileV2({ ...BOUNDS_V2, canvas_range: { max_edge: 3840 } }),
    'profile descriptor.execution_bounds.canvas_range must have the exact closed fields')
})

test('a Gateway moved to another origin re-pairs from the capabilities call, and its old pairing goes to Story Trash', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const settings = await import('../services/app-settings.js')
  const queue = await import('../services/job-queue.js')
  const MOVED = 'https://moved.private.example'
  const MOVED_ID = '44444444-4444-4444-8444-444444444444'
  const pinnedAtOrigin = { origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID }
  const restoreFetch = () => { globalThis.fetch = originalFetch }
  try {
    if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()
    await settings.setGenStudioUrl(MOVED)
    globalThis.fetch = async (input, init = {}) => {
      assert.equal(String(input), `${MOVED}/v1/final-renders/capabilities`)
      assert.equal(init.method, 'GET')
      return Response.json(capabilities({ gateway_instance_id: MOVED_ID }))
    }
    await client.getFinalRenderCapabilities()
    assert.deepEqual(await bindingRecord(), {
      origin: MOVED, owner_scope: OWNER_SCOPE, gateway_instance_id: MOVED_ID,
    }, 'the pairing follows the origin the owner set')
    const trashed = await fs.readdir(path.join(retained!.dir, 'projects', '_trash', '_story-studio', 'private-render'))
    assert.equal(trashed.length, 1)
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(
        retained!.dir, 'projects', '_trash', '_story-studio', 'private-render', trashed[0]!,
      ), 'utf8')),
      pinnedAtOrigin,
      'the old pairing is kept in Story Trash, not destroyed',
    )

    // A different identity at the SAME origin is still the replacement case, never a re-pair.
    globalThis.fetch = async () => Response.json(capabilities({
      gateway_instance_id: '55555555-5555-4555-8555-555555555555',
    }))
    await assert.rejects(client.getFinalRenderCapabilities(), /binding|response|invalid/i)
    assert.deepEqual(await bindingRecord(), {
      origin: MOVED, owner_scope: OWNER_SCOPE, gateway_instance_id: MOVED_ID,
    }, 'the moved pairing is untouched by a same-origin identity change')
  } finally {
    // Put the fixture's own pairing back for any later read in this file.
    await settings.setGenStudioUrl(ORIGIN)
    globalThis.fetch = async () => Response.json(capabilities())
    await client.getFinalRenderCapabilities()
    restoreFetch()
  }
})
