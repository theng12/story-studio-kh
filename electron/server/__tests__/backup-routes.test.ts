/**
 * Backup routes (1.4.287): settings, a background run read through /status, the owner-only prune,
 * and the automatic backup's conditions (drive present, queue idle, a day passed or drive replugged).
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitForValue } from './_timing.js'

let dir: string
let cleanup: () => Promise<void>
let app: express.Express
let runner: typeof import('../services/backup-runner.js')
let viaAutomationKey = false

before(async () => {
  const temp = await useTempDataDir()
  dir = temp.dir
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Route Channel' })
  runner = await import('../services/backup-runner.js')
  const { router } = await import('../routes/backup.js')
  app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => { if (viaAutomationKey) req.user = { via: 'automation_key' }; next() })
  app.use('/api', router)
})

after(async () => { await cleanup() })

const idle = () => waitForValue(async () => {
  const s = (await request(app).get('/api/backup/status')).body
  return s.running ? undefined : s
}, { label: 'backup task finished' })

test('a backup folder inside the Library is refused', async () => {
  const pm = await import('../services/project-manager.js')
  const res = await request(app).put('/api/backup/settings').send({ folder: path.join(pm.projectsRoot(), 'backups') })
  assert.equal(res.status, 400)
})

test('size check and backup run in the background and report through /status', async () => {
  const drive = path.join(dir, 'SSD')
  await fs.mkdir(drive)
  assert.equal((await request(app).put('/api/backup/settings').send({ folder: drive, options: { final_videos: true } })).status, 200)

  assert.deepEqual((await request(app).post('/api/backup/plan')).body, { started: true })
  const plan = await idle()
  assert.equal(plan.kind, 'plan')
  assert.equal(plan.error, '')
  assert.ok(plan.result.sizes.records > 0)
  assert.ok(Object.keys(plan.result.channels).length === 1)

  assert.deepEqual((await request(app).post('/api/backup/run')).body, { started: true })
  const done = await idle()
  assert.equal(done.error, '')
  assert.equal(done.result.complete, true)
  const overview = (await request(app).get('/api/backup')).body
  assert.equal(overview.drive_present, true)
  assert.equal(overview.settings.last.complete, true)
  assert.equal(overview.settings.options.final_videos, true)
  assert.ok(overview.on_drive.counts.library.files > 0)

  await request(app).post('/api/backup/verify')
  const checked = await idle()
  assert.equal(checked.result.missing.length + checked.result.damaged.length, 0)
})

test('pruning older copies needs a confirm and is refused to automation keys', async () => {
  assert.equal((await request(app).post('/api/backup/versions/prune').send({ stamps: ['2026-01-01_000000'] })).status, 400)
  viaAutomationKey = true
  try {
    const res = await request(app).post('/api/backup/versions/prune').send({ stamps: ['2026-01-01_000000'], confirm: true })
    assert.equal(res.status, 403)
  } finally {
    viaAutomationKey = false
  }
  const ok = await request(app).post('/api/backup/versions/prune').send({ stamps: ['2026-01-01_000000'], confirm: true })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.removed, [])
})

test('restore preview reads the drive and marks channels already in the Library', async () => {
  const res = await request(app).post('/api/backup/restore/preview').send({ source: path.join(dir, 'SSD') })
  assert.equal(res.status, 200)
  assert.equal(res.body.channels.length, 1)
  assert.equal(res.body.channels[0].exists_in_target, true)
  const missing = await request(app).post('/api/backup/restore/preview').send({ source: path.join(dir, 'nothing-here') })
  assert.equal(missing.status, 404)
})

test('automatic backup waits for the drive and a day, and runs again when the drive comes back', async () => {
  const drive = path.join(dir, 'SSD')
  await request(app).put('/api/backup/settings').send({ auto: true })
  assert.equal(await runner.autoBackupTick(), 'recent')
  assert.equal(await runner.autoBackupTick(Date.now() + 25 * 60 * 60 * 1000), 'started-daily')
  await idle()
  // Unplugged, then plugged back in.
  await fs.rename(drive, path.join(dir, 'SSD-away'))
  assert.equal(await runner.autoBackupTick(), 'drive-absent')
  await fs.rename(path.join(dir, 'SSD-away'), drive)
  assert.equal(await runner.autoBackupTick(), 'started-replugged')
  await idle()
  await request(app).put('/api/backup/settings').send({ auto: false })
  assert.equal(await runner.autoBackupTick(), 'off')
})
