/**
 * Server-mode automation keys: an agent on another Mac drives the headless
 * server with `Authorization: Bearer ssk_…` instead of the owner's password.
 *
 * The gate below is wired exactly as electron/server/app.ts wires it; the only
 * test-only piece is the first middleware, which sets the socket peer so the
 * requests are not loopback (loopback bypasses auth by design).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const isolated = await useTempDataDir()
process.env.STORY_STUDIO_SERVER_MODE = '1'
after(async () => {
  delete process.env.STORY_STUDIO_SERVER_MODE
  await isolated.cleanup()
})

const { buildRequireSession, readAutomationKeyHeader } = await import('../lib/auth-session.js')
const { getServerModeConfig } = await import('../lib/server-mode.js')
const settings = await import('../services/app-settings.js')
const { router: authRouter } = await import('../routes/auth.js')
const { router: appSettingsRouter } = await import('../routes/app-settings.js')

await settings.setServerModeCredentials({ username: 'owner', password: 'correct horse battery' })

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  Object.defineProperty(req, 'ip', { value: String(req.headers['x-test-peer'] || '100.64.0.9') })
  next()
})
app.use('/api', authRouter)
app.use('/api', buildRequireSession(() => getServerModeConfig()?.auth, {
  getKeys: () => getServerModeConfig()?.automation_keys || [],
  onKeyUsed: settings.recordAutomationKeyUse,
}))
app.get('/api/protected', (req: any, res) => res.json({ user: req.user }))
app.use('/api', appSettingsRouter)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const settingsFile = path.join(isolated.dir, 'app-settings.json')
const auditFile = path.join(isolated.dir, 'server-mode-key-audit.jsonl')

async function createKey(label: string): Promise<{ key: string; id: string }> {
  const { key, view } = await settings.createServerModeAutomationKey(label)
  return { key, id: view.automation_keys.find((k) => k.label === label)!.id }
}

test('a created key is shown once, stored only as a hash, and opens a protected route', async () => {
  const res = await request(app)
    .post('/api/app-settings/server-mode/automation-keys')
    .set('x-test-peer', '127.0.0.1') // the owner, at the mini
    .send({ label: 'Claude on Mac Studio' })
    .expect(201)
  const key: string = res.body.key
  assert.match(key, /^ssk_[A-Za-z0-9_-]{43}$/)

  const stored = await fs.readFile(settingsFile, 'utf8')
  assert.ok(!stored.includes(key), 'plaintext key must not be on disk')
  assert.ok(!stored.includes(key.slice(4)), 'nor its body without the prefix')
  const record = JSON.parse(stored).server_mode.automation_keys[0]
  assert.match(record.hash, /^[0-9a-f]{64}$/)
  assert.equal(record.last4, key.slice(-4))

  // Every later read is key-free and hash-free.
  const view = await request(app).get('/api/app-settings/server-mode').set('x-test-peer', '127.0.0.1').expect(200)
  const text = JSON.stringify(view.body)
  assert.ok(!text.includes(key) && !text.includes(record.hash))
  assert.equal(view.body.automation_keys[0].label, 'Claude on Mac Studio')

  const ok = await request(app).get('/api/protected').set('Authorization', `Bearer ${key}`).expect(200)
  assert.equal(ok.body.user.via, 'automation_key')
  assert.equal(ok.body.user.username, 'owner')
  await request(app).get('/api/protected').set('X-Story-Key', key).expect(200)

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${key}`).expect(200)
  assert.equal(me.body.via, 'automation_key')

  // Use is persisted (once, not per request) and audited without the key.
  await waitFor(async () => !!JSON.parse(await fs.readFile(settingsFile, 'utf8')).server_mode.automation_keys[0].last_used_at,
    { label: 'last_used_at recorded' })
  // The audit line is appended just after the settings write: wait for it too.
  await waitFor(async () => (await fs.readFile(auditFile, 'utf8')).includes('"used"'), { label: 'audit "used" line' })
  const audit = await fs.readFile(auditFile, 'utf8')
  assert.ok(!audit.includes(key))
  const lines = audit.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.event), ['created', 'used'], 'two calls in the same window are one line')
})

test('wrong, malformed and empty keys are 401 and count toward the login limiter', async () => {
  await settings.setServerModeRateLimit(3)
  const { key } = await createKey('limiter')
  const peer = '100.64.0.21'
  const wrong = `ssk_${'A'.repeat(43)}`
  await request(app).get('/api/protected').set('x-test-peer', peer).set('Authorization', `Bearer ${wrong}`).expect(401)
  await request(app).get('/api/protected').set('x-test-peer', peer).set('Authorization', 'Bearer not-a-key').expect(401)
  await request(app).get('/api/protected').set('x-test-peer', peer).set('X-Story-Key', '').expect(401)
  // Limit reached: even the right key, and the password login, now wait.
  await request(app).get('/api/protected').set('x-test-peer', peer).set('Authorization', `Bearer ${key}`).expect(429)
  await request(app).post('/api/auth/login').set('x-test-peer', peer)
    .send({ username: 'owner', password: 'correct horse battery' }).expect(429)
  // Other peers and successful uses are unaffected.
  for (let i = 0; i < 5; i++) {
    await request(app).get('/api/protected').set('x-test-peer', '100.64.0.22').set('Authorization', `Bearer ${key}`).expect(200)
  }
  await settings.setServerModeRateLimit(30)
})

test('revocation is immediate; rotating the session secret does not revoke', async () => {
  const { key, id } = await createKey('to revoke')
  const peer = '100.64.0.31'
  await request(app).get('/api/protected').set('x-test-peer', peer).set('Authorization', `Bearer ${key}`).expect(200)
  await settings.rotateServerModeSessionSecret()
  await request(app).get('/api/protected').set('x-test-peer', peer).set('Authorization', `Bearer ${key}`).expect(200)
  await request(app).delete(`/api/app-settings/server-mode/automation-keys/${id}`).set('x-test-peer', '127.0.0.1').expect(200)
  await request(app).get('/api/protected').set('x-test-peer', peer).set('Authorization', `Bearer ${key}`).expect(401)
  const audit = await fs.readFile(auditFile, 'utf8')
  assert.match(audit, /"event":"revoked"/)
})

test('a key cannot change sign-in settings, mint keys or revoke keys', async () => {
  const { key, id: own } = await createKey('agent')
  const { id: other } = await createKey('spare')
  // last_used_at may legitimately move; nothing else may.
  const signIn = async () => {
    const sm = JSON.parse(await fs.readFile(settingsFile, 'utf8')).server_mode
    return { auth: sm.auth, enabled: sm.enabled, bind: sm.bind, port: sm.port, keys: sm.automation_keys.map((k: any) => k.id) }
  }
  const before = await signIn()
  const refused = [
    request(app).put('/api/app-settings/server-mode/credentials').send({ username: 'x', password: 'takeover-password' }),
    request(app).put('/api/app-settings/server-mode').send({ enabled: false }),
    request(app).put('/api/app-settings/server-mode').send({ bind: '0.0.0.0', port: 9999 }),
    request(app).put('/api/app-settings/server-mode/rate-limit').send({ login_max_attempts_per_minute: 1000 }),
    request(app).post('/api/app-settings/server-mode/rotate-sessions'),
    request(app).post('/api/app-settings/server-mode/automation-keys').send({ label: 'persistence' }),
    request(app).delete(`/api/app-settings/server-mode/automation-keys/${other}`),
    request(app).delete(`/api/app-settings/server-mode/automation-keys/${own}`),
  ]
  for (const req of refused) {
    const res = await req.set('Authorization', `Bearer ${key}`).expect(403)
    assert.equal(res.body.detail, "Automation keys can't change sign-in settings — use your password session.")
  }
  assert.deepEqual(await signIn(), before, 'no sign-in setting changed and no key was revoked')
  // The owner's own session still can.
  await request(app).delete(`/api/app-settings/server-mode/automation-keys/${other}`).set('x-test-peer', '127.0.0.1').expect(200)
  await request(app).put('/api/app-settings/server-mode/rate-limit').set('x-test-peer', '127.0.0.1')
    .send({ login_max_attempts_per_minute: 30 }).expect(200)
})

test('session-cookie login is unchanged', async () => {
  const peer = '100.64.0.41'
  await request(app).get('/api/protected').set('x-test-peer', peer).expect(401)
  const login = await request(app).post('/api/auth/login').set('x-test-peer', peer)
    .send({ username: 'owner', password: 'correct horse battery' }).expect(200)
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const res = await request(app).get('/api/protected').set('x-test-peer', peer).set('Cookie', cookie).expect(200)
  assert.equal(res.body.user.username, 'owner')
  assert.equal(res.body.user.via, undefined)
})

test('labels are required and the number of keys is capped', async () => {
  await assert.rejects(settings.createServerModeAutomationKey('  '), /label/)
  const view = await settings.getServerModeSettingsSafe()
  for (let i = view.automation_keys.length; i < settings.MAX_AUTOMATION_KEYS; i++) await createKey(`k${i}`)
  await assert.rejects(settings.createServerModeAutomationKey('one too many'), /At most/)
})

test('reset-server-auth clears every automation key and audits it', async () => {
  const full = await settings.getServerModeSettingsSafe()
  await settings.revokeServerModeAutomationKey(full.automation_keys[0].id) // the cap test left 5
  const { key } = await createKey('before reset')
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'scripts/reset-server-auth.ts')], {
    cwd: repoRoot, env: { ...process.env, STORY_STUDIO_DATA_DIR: isolated.dir }, encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Revoked \d+ automation key/)
  const sm = JSON.parse(await fs.readFile(settingsFile, 'utf8')).server_mode
  assert.equal(sm.automation_keys, undefined)
  assert.equal(sm.auth, undefined)
  const last = JSON.parse((await fs.readFile(auditFile, 'utf8')).trim().split('\n').pop()!)
  assert.equal(last.event, 'reset')
  assert.ok(last.revoked.some((k: any) => k.label === 'before reset'))
  assert.ok(!JSON.stringify(last).includes(key))
  await request(app).get('/api/protected').set('x-test-peer', '100.64.0.51').set('Authorization', `Bearer ${key}`).expect(401)
})

test('desktop mode ignores the header', async () => {
  delete process.env.STORY_STUDIO_SERVER_MODE
  try {
    const me = await request(app).get('/api/auth/me').set('Authorization', 'Bearer junk').expect(200)
    assert.equal(me.body.mode, 'local')
  } finally {
    process.env.STORY_STUDIO_SERVER_MODE = '1'
  }
  // Only Bearer / X-Story-Key are read; other schemes fall through to the cookie path.
  assert.equal(readAutomationKeyHeader({ authorization: 'Basic abc' }), undefined)
})
