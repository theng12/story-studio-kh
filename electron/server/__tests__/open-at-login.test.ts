import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import * as login from '../services/open-at-login.js'
import { dataDir, updateDir, trashDir, previousAppsDir } from '../lib/app-paths.js'
import { router } from '../routes/app-settings.js'

let fixture: Awaited<ReturnType<typeof useTempDataDir>>
beforeEach(async () => { fixture = await useTempDataDir() })
afterEach(async () => { await fixture.cleanup() })

test('the shared data paths retain their existing values', () => {
  assert.equal(dataDir(), fixture.dir)
  assert.equal(updateDir(), path.join(fixture.dir, 'app-update'))
  assert.equal(trashDir(), path.join(fixture.dir, '_trash'))
  assert.equal(previousAppsDir(), path.join(fixture.dir, 'previous-apps'))
})

test('Open at Login relaunches after crashes only and retires its plist recoverably', async () => {
  const home = path.join(fixture.dir, 'home')
  const executable = '/Applications/Story Studio KH.app/Contents/MacOS/Story Studio KH'
  await login.setOpenAtLogin(true, executable, home)
  const plist = login.agentPlistPath(home)
  execFileSync('/usr/bin/plutil', ['-lint', plist])
  const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]).toString())
  assert.deepEqual(json.KeepAlive, { Crashed: true })
  assert.deepEqual(json.ProgramArguments, [executable])
  assert.equal(json.RunAtLoad, true)
  assert.equal(json.Label, login.AGENT_LABEL)
  assert.equal(login.openAtLogin(home), true)
  await login.setOpenAtLogin(false, executable, home)
  assert.equal(login.openAtLogin(home), false)
  const { projectsRoot } = await import('../services/project-manager.js')
  assert.equal(fs.readdirSync(path.join(projectsRoot(), '_trash', '_story-studio', 'launch-agent')).length, 1)
  await assert.rejects(login.setOpenAtLogin(true, '/usr/local/bin/node', home), /installed app/)
})

test('the settings route reads and writes the login state without changing old updater settings', async t => {
  t.mock.method(os, 'homedir', () => path.join(fixture.dir, 'home'))
  const executable = process.execPath
  process.execPath = '/Applications/Story Studio KH.app/Contents/MacOS/Story Studio KH'
  try {
    const { resolveAppSettingsPath } = await import('../lib/server-mode.js')
    const stored = '{"app_update":{"auto_install":true,"trusted_publisher_key":"leave untouched"}}\n'
    fs.writeFileSync(resolveAppSettingsPath(), stored)
    const app = express().use(express.json(), router)
    assert.deepEqual((await request(app).get('/app-settings/open-at-login').expect(200)).body, { enabled: false })
    assert.deepEqual((await request(app).put('/app-settings/open-at-login').send({ enabled: true }).expect(200)).body, { enabled: true })
    assert.deepEqual((await request(app).put('/app-settings/open-at-login').send({ enabled: false }).expect(200)).body, { enabled: false })
    assert.equal(fs.readFileSync(resolveAppSettingsPath(), 'utf8'), stored)
  } finally { process.execPath = executable }
})

test('development login writes return the detail and all old updater routes are absent', async () => {
  const app = express().use(express.json(), router)
  const result = await request(app).put('/app-settings/open-at-login').send({ enabled: true }).expect(400)
  assert.match(result.body.detail, /installed app/)
  for (const route of ['check', 'install-now', 'open-launcher', 'trust-new-key']) {
    await request(app).post(`/app-update/${route}`).expect(404)
  }
  await request(app).get('/app-update/status').expect(404)
  await request(app).put('/app-update/settings').expect(404)
  await request(app).put('/app-update/open-at-login').expect(404)
  const mounts = fs.readFileSync(new URL('../routes/index.ts', import.meta.url), 'utf8')
  const main = fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(mounts, /app-update|appUpdateRouter/)
  assert.doesNotMatch(main, /startStoryUpdater|openLauncher/)
  assert.equal(fs.existsSync(new URL('../services/app-update.ts', import.meta.url)), false)
  assert.equal(fs.existsSync(new URL('../routes/app-update.ts', import.meta.url)), false)
})
