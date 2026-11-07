import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let baselines: typeof import('../services/settings-baseline.js')
let app: express.Express
before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  baselines = await import('../services/settings-baseline.js')
  app = express().use(express.json())
  app.use('/api', (await import('../routes/settings-baselines.js')).router)
})
after(async () => { await cleanup() })

test('baseline routes preview, confirm and verify only the reusable settings', async () => {
  const project = await pm.createProject({ name: 'Baseline Route Apply' })
  await pm.updateConfig(project.slug, { audio_quality: { mode: 'off' } } as any)
  const baseline = await baselines.createBaseline('Route apply', { audio_quality: { mode: 'flag_issues' } })
  const body = { baseline_id: baseline.id, channel_slugs: [project.slug] }
  const preview = await request(app).post('/api/settings-baselines/preview').send(body).expect(200)
  assert.equal(preview.body[0].has_changes, true)
  await request(app).post('/api/settings-baselines/apply').send(body).expect(400)
  assert.deepEqual((await pm.getConfig(project.slug) as any).audio_quality, { mode: 'off' })
  const result = await request(app).post('/api/settings-baselines/apply').send({ ...body, explicit_confirm: true }).expect(200)
  assert.equal(result.body.success_count, 1)
  assert.equal(result.body.channels[project.slug].readback.status, 'verified')
  await request(app).post('/api/settings-baselines/preview').send({ ...body, channel_slugs: ['../foreign'] }).expect(400)
})

test('restore routes expose identities and changed keys without snapshot values', async () => {
  const project = await pm.createProject({ name: 'Baseline Route Restore' })
  await pm.updateConfig(project.slug, { custom_restore_marker: 'private snapshot bytes', audio_quality: { mode: 'off' } } as any)
  const snapshot = await baselines.createChannelSnapshot(project.slug, 'manual_snapshot')
  await pm.updateConfig(project.slug, { custom_restore_marker: 'newer private bytes', audio_quality: { mode: 'flag_issues' } } as any)
  const list = await request(app).get('/api/settings-baselines/snapshots').expect(200)
  const listed = list.body.find((entry: { id: string }) => entry.id === snapshot.id)
  assert.ok(listed)
  assert.equal(Object.hasOwn(listed, 'config_snapshot'), false)
  assert.doesNotMatch(JSON.stringify(list.body), /private snapshot bytes|newer private bytes/)
  const body = { restore_point_id: snapshot.id, channel_slug: project.slug }
  const preview = await request(app).post('/api/settings-baselines/restore/preview').send(body).expect(200)
  assert.ok(preview.body.diffs.some((diff: { key: string }) => diff.key === 'custom_restore_marker'))
  assert.doesNotMatch(JSON.stringify(preview.body), /private snapshot bytes|newer private bytes|current_value|proposed_value/)
  await request(app).post('/api/settings-baselines/restore').send({ ...body, expected_current_sha256: preview.body.current_sha256 }).expect(400)
  const restored = await request(app).post('/api/settings-baselines/restore').send({
    ...body, explicit_confirm: true, expected_current_sha256: preview.body.current_sha256,
  }).expect(200)
  assert.equal(restored.body.success, true)
  assert.equal(restored.body.readback.status, 'verified')
  assert.equal((await pm.getConfig(project.slug) as any).custom_restore_marker, 'private snapshot bytes')
})
