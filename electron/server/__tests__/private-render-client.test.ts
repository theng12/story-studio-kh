import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

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
