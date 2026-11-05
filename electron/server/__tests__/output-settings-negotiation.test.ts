/**
 * Revision-4 output-settings negotiation (release 382): the paired Gateway's
 * `GET /v2/final-renders/capabilities` read, and the Settings status that must
 * keep Best unavailable with a reason. Protocol support is never workload
 * admission; a malformed or mismatched answer is a validation error, never support.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const ORIGIN = 'https://gateway.private.example'
const BEARER = 'cd'.repeat(32)
const OWNER_SCOPE = '33333333-3333-4333-8333-333333333333'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_OWNER_SCOPE = '44444444-4444-4444-8444-444444444444'

let retained: Awaited<ReturnType<typeof useTempDataDir>> | undefined
let storyInstanceId = ''
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

function digestUtf8(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const PROFILE_V2_UTF8 = canonicalJson({
  format: 'studio.render.profile.v2',
  implementation: 'story-classic-no-font-v2',
  recipe_namespace: 'studio.render.final.v2',
  compiler_artifact_sha256: '8'.repeat(64),
  tools_artifact_sha256: '1'.repeat(64),
  combination_set: 'retained-classic-no-font-candidate-v1',
  tier_policy: 'story-final-chain-v1',
  output_policy: 'story-final-output-v2',
  execution_bounds: {
    canvas_pairs: [{ width: 1920, height: 1080 }], working_fps: [24],
    max_duration_sec: 60, max_operations: 32, max_assets: 32,
    max_asset_bytes: 33_554_432, max_total_input_bytes: 67_108_864,
    max_pixel_frames: 24_883_200, scratch_reserve_bytes: 1,
    output_limit_bytes: 33_554_432, process_tree_rss_limit_bytes: 1,
    cumulative_wall_seconds: 60,
  },
  hardware_qualification_record_sha256: null,
  fidelity_record_sha256: null,
  production_eligible: false,
})
const PROFILE_V2_DIGEST = digestUtf8(PROFILE_V2_UTF8)

function capabilitiesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'studio.render.output-settings-capabilities.v1',
    private: true,
    chargeable: false,
    owner_scope: OWNER_SCOPE,
    gateway_instance_id: GATEWAY_ID,
    story_instance_id: storyInstanceId,
    server_time: Math.floor(Date.now() / 1000),
    supported: true,
    reason: null,
    profile_descriptor_utf8: PROFILE_V2_UTF8,
    profile_digest: PROFILE_V2_DIGEST,
    ...overrides,
  }
}

function serve(body: unknown, status = 200): void {
  globalThis.fetch = async () => Response.json(body, { status })
}

before(async () => {
  retained = await useTempDataDir({ retain: true, settle: async () => {} })
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const identity = await import('../services/private-render-identity.js')
  await settings.setGenStudioUrl(ORIGIN)
  await secrets.setApiKey('genstudio', BEARER)
  storyInstanceId = (await identity.getOrCreatePrivateRenderIdentity()).story_instance_id
  await identity.pinGatewayBinding({ origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  await settings.setPrivateFinalRenderSetting({ enabled: false })
})

beforeEach(() => { globalThis.fetch = originalFetch })

after(async () => {
  globalThis.fetch = originalFetch
  await retained?.cleanup()
})

test('a fully valid supported answer negotiates protocol support with a checked v2 profile', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  serve(capabilitiesBody())
  const result = await client.getFinalRenderOutputSettingsCapabilities()
  assert.equal(result.supported, true)
  assert.equal(result.reason, null)
  assert.equal(result.profile_descriptor_utf8, PROFILE_V2_UTF8)
  assert.equal(result.profile_digest, PROFILE_V2_DIGEST)
})

test('supported:false keeps the Gateway reason and null profiles', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  serve(capabilitiesBody({
    supported: false,
    reason: 'No node is admitted for this profile right now.',
    profile_descriptor_utf8: null,
    profile_digest: null,
  }))
  const result = await client.getFinalRenderOutputSettingsCapabilities()
  assert.equal(result.supported, false)
  assert.equal(result.reason, 'No node is admitted for this profile right now.')
  assert.equal(result.profile_descriptor_utf8, null)
  assert.equal(result.profile_digest, null)
})

test('HTTP 404 and 405 report the route is not offered, never support', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  for (const status of [404, 405]) {
    globalThis.fetch = async () => Response.json({ error: { code: 'NOT_FOUND' } }, { status })
    const result = await client.getFinalRenderOutputSettingsCapabilities()
    assert.equal(result.supported, false)
    assert.match(result.reason!, new RegExp(`HTTP ${status}`))
    assert.equal(result.profile_descriptor_utf8, null)
  }
})

test('an unimplemented capabilities version is unavailable with a reason, not a validation error', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  serve(capabilitiesBody({ format: 'studio.render.output-settings-capabilities.v2' }))
  const result = await client.getFinalRenderOutputSettingsCapabilities()
  assert.equal(result.supported, false)
  assert.match(result.reason!, /does not implement/)
})

test('a malformed closed shape, a null reason, or a profile while unsupported is a validation error', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  const unsupported = { supported: false, reason: null, profile_descriptor_utf8: null, profile_digest: null }
  for (const bad of [
    capabilitiesBody({ profile_digest: undefined, supported: false, reason: 'x', profile_descriptor_utf8: null }),
    capabilitiesBody({ ...unsupported, profile_digest: PROFILE_V2_DIGEST }),
    capabilitiesBody({ private: false }),
    { format: 'studio.render.output-settings-capabilities.v1' },
  ]) {
    serve(bad)
    await assert.rejects(
      client.getFinalRenderOutputSettingsCapabilities(),
      client.FinalRenderResponseValidationError,
      JSON.stringify(bad).slice(0, 80),
    )
  }
})

test('a mismatched Story or Gateway identity is a validation error, never support', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  serve(capabilitiesBody({ story_instance_id: '99999999-9999-4999-8999-999999999999' }))
  await assert.rejects(client.getFinalRenderOutputSettingsCapabilities(), /binding does not match/)
  serve(capabilitiesBody({ owner_scope: OTHER_OWNER_SCOPE }))
  await assert.rejects(client.getFinalRenderOutputSettingsCapabilities(), /binding does not match/)
})

test('a stale server_time is a validation error', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  serve(capabilitiesBody({ server_time: Math.floor(Date.now() / 1000) - 600 }))
  await assert.rejects(client.getFinalRenderOutputSettingsCapabilities(), /freshness/)
})

test('supported:true fails closed on a bad profile digest or a test-only profile format', async () => {
  const client = await import('../lib/final-render-gateway-client.js')
  serve(capabilitiesBody({ profile_digest: 'b'.repeat(64) }))
  await assert.rejects(client.getFinalRenderOutputSettingsCapabilities(), /byte digest does not match/)
  // The fixture's synthetic profile format must fail production admission.
  const fixtureProfile = canonicalJson({ ...JSON.parse(PROFILE_V2_UTF8), format: 'studio.render.fixture.profile.v1' })
  serve(capabilitiesBody({ profile_descriptor_utf8: fixtureProfile, profile_digest: digestUtf8(fixtureProfile) }))
  await assert.rejects(client.getFinalRenderOutputSettingsCapabilities(), /unsupported/)
})

async function statusViaRoute(): Promise<Record<string, unknown>> {
  const { router } = await import('../routes/app-settings.js')
  const app = express()
  app.use('/api', router)
  const response = await request(app).get('/api/app-settings/private-final-render/output-settings')
  assert.equal(response.status, 200)
  return response.body
}

test('Settings reads Best availability without calling the Gateway while private rendering is off', async () => {
  const settings = await import('../services/app-settings.js')
  await settings.setPrivateFinalRenderSetting({ enabled: false })
  globalThis.fetch = async () => { throw new Error('the Gateway must not be called while private rendering is off') }
  const status = await statusViaRoute()
  assert.equal(status.private_render_enabled, false)
  assert.equal(status.best_available, false)
  assert.match(String(status.reason), /has not been checked/)
})

test('Settings still reports Best unavailable when the protocol is supported', async () => {
  const settings = await import('../services/app-settings.js')
  await settings.setPrivateFinalRenderSetting({ enabled: true })
  serve(capabilitiesBody())
  const status = await statusViaRoute()
  assert.equal(status.private_render_enabled, true)
  assert.equal(status.best_available, false)
  assert.match(String(status.reason), /evidence/)
  await settings.setPrivateFinalRenderSetting({ enabled: false })
})

test('Settings reports an uncheckable negotiation as unavailable, not as support', async () => {
  const settings = await import('../services/app-settings.js')
  await settings.setPrivateFinalRenderSetting({ enabled: true })
  globalThis.fetch = async () => { throw new Error('gateway unreachable') }
  const status = await statusViaRoute()
  assert.equal(status.best_available, false)
  assert.match(String(status.reason), /could not be checked/)
  assert.match(String(status.reason), /gateway unreachable/)

  serve(capabilitiesBody({ story_instance_id: '99999999-9999-4999-8999-999999999999' }))
  const rejected = await statusViaRoute()
  assert.equal(rejected.best_available, false)
  assert.match(String(rejected.reason), /could not be checked/)
  await settings.setPrivateFinalRenderSetting({ enabled: false })
})
