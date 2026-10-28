import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const BEARER = 'ef'.repeat(32)
const ORIGIN = 'https://gateway.private.example'
const OWNER_SCOPE = '33333333-3333-4333-8333-333333333333'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
let retained: Awaited<ReturnType<typeof useTempDataDir>> | undefined
let app: express.Express
let automationKey: string
let storyInstanceId: string

before(async () => {
  retained = await useTempDataDir({ retain: true, settle: async () => {} })
  process.env.STORY_STUDIO_SERVER_MODE = '1'

  const settings = await import('../services/app-settings.js')
  const identity = await import('../services/private-render-identity.js')
  const { getServerModeConfig } = await import('../lib/server-mode.js')
  const { buildRequireSession } = await import('../lib/auth-session.js')
  const { router: authRouter } = await import('../routes/auth.js')
  const { router: settingsRouter } = await import('../routes/app-settings.js')

  await settings.setServerModeCredentials({ username: 'owner', password: 'correct horse battery' })
  automationKey = (await settings.createServerModeAutomationKey('private render owner')).key
  await settings.setGenStudioUrl(ORIGIN)
  await (await import('../services/app-secrets-store.js')).setApiKey('genstudio', BEARER)
  storyInstanceId = (await identity.getOrCreatePrivateRenderIdentity()).story_instance_id

  app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    Object.defineProperty(req, 'ip', { value: String(req.headers['x-test-peer'] || '127.0.0.1') })
    if (req.headers['x-test-skip-auth'] === '1') req.skip_auth = true
    if (req.headers['x-test-local-user'] === '1') req.user = { username: '__local__' }
    next()
  })
  app.use('/api', authRouter)
  app.use('/api', buildRequireSession(() => getServerModeConfig()?.auth, {
    getKeys: () => getServerModeConfig()?.automation_keys || [],
  }))
  app.get('/api/existing-loopback-route', (_req, res) => res.json({ ok: true }))
  app.use('/api', settingsRouter)
})

after(async () => {
  delete process.env.STORY_STUDIO_SERVER_MODE
  await retained?.cleanup()
})

test('private render mutations require fresh owner credentials even on loopback while default auth remains unchanged', async () => {
  await request(app).get('/api/existing-loopback-route').expect(200, { ok: true })

  const initial = await request(app).get('/api/app-settings/private-final-render').expect(200)
  assert.deepEqual(initial.body, { enabled: false })

  for (const pending of [
    request(app).put('/api/app-settings/private-final-render').send({ enabled: true }),
    request(app).put('/api/app-settings/private-final-render')
      .set('x-test-skip-auth', '1').send({ enabled: true }),
    request(app).put('/api/app-settings/private-final-render')
      .set('x-test-local-user', '1').send({ enabled: true }),
    request(app).put('/api/app-settings/private-final-render')
      .set('Authorization', 'Bearer gsk_ordinary_generation_key').send({ enabled: true }),
  ]) {
    const response = await pending
    assert.ok([401, 503].includes(response.status), response.text)
  }

  // The separate render bearer is gone: there is no pairing import route left to admit.
  await request(app)
    .post('/api/app-settings/private-final-render/pairing')
    .set('Authorization', `Bearer ${automationKey}`)
    .send({})
    .expect(404)
  const admitted = await request(app)
    .put('/api/app-settings/private-final-render')
    .set('Authorization', `Bearer ${automationKey}`)
    .send({ enabled: false })
    .expect(200)
  assert.deepEqual(admitted.body, { enabled: false })
  assert.deepEqual((await request(app).get('/api/app-settings/private-final-render/binding').expect(200)).body, {
    bound: false, story_instance_id: storyInstanceId,
    configured_origin: 'https://gateway.private.example',
    matches_configured_gateway: null, repaired_from: null,
  })

  const login = await request(app).post('/api/auth/login')
    .send({ username: 'owner', password: 'correct horse battery' })
    .expect(200)
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const enabled = await request(app)
    .put('/api/app-settings/private-final-render')
    .set('Cookie', cookie)
    .send({ enabled: true })
    .expect(200)
  assert.deepEqual(enabled.body, { enabled: true })
  assert.deepEqual((await request(app).get('/api/app-settings/private-final-render').expect(200)).body, { enabled: true })

  const settings = await import('../services/app-settings.js')
  await settings.rotateServerModeSessionSecret()
  await request(app)
    .put('/api/app-settings/private-final-render')
    .set('Cookie', cookie)
    .send({ enabled: false })
    .expect(401)

  const identity = await import('../services/private-render-identity.js')
  await identity.pinGatewayBinding({ origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  const status = await request(app).get('/api/app-settings/private-final-render/binding').expect(200)
  assert.deepEqual(status.body, {
    bound: true, story_instance_id: storyInstanceId,
    origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID,
    configured_origin: ORIGIN, matches_configured_gateway: true, repaired_from: null,
  })
  assert.ok(!JSON.stringify(status.body).includes(BEARER))
})

test('strong-auth option is opt-in and malformed writes do not change admitted state', async () => {
  const { buildRequireSession } = await import('../lib/auth-session.js')
  const defaultGate = buildRequireSession(() => undefined)
  const strongGate = buildRequireSession(() => undefined, { allowLocalBypass: false })

  const invoke = (gate: ReturnType<typeof buildRequireSession>, overrides: Record<string, unknown> = {}) => {
    let nextCalls = 0
    let status = 0
    const req = { ip: '127.0.0.1', headers: {}, ...overrides }
    const res = {
      status(code: number) { status = code; return this },
      json() { return this },
    }
    gate(req, res, () => { nextCalls += 1 })
    return { nextCalls, status }
  }

  assert.deepEqual(invoke(defaultGate), { nextCalls: 1, status: 0 })
  assert.deepEqual(invoke(defaultGate, { skip_auth: true, ip: '100.64.0.10' }), { nextCalls: 1, status: 0 })
  assert.deepEqual(invoke(strongGate), { nextCalls: 0, status: 503 })
  assert.deepEqual(invoke(strongGate, { skip_auth: true, ip: '100.64.0.10' }), { nextCalls: 0, status: 503 })

  const before = await request(app).get('/api/app-settings/private-final-render').expect(200)
  for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: true }, null]) {
    const pending = request(app).put('/api/app-settings/private-final-render').set('Authorization', `Bearer ${automationKey}`)
    const response = body === null ? await pending.type('json').send('null') : await pending.send(body)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.deepEqual((await request(app).get('/api/app-settings/private-final-render').expect(200)).body, before.body)
})
