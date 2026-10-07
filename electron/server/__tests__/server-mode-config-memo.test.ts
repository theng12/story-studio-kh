import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

const isolated = await useTempDataDir()
process.env.STORY_STUDIO_SERVER_MODE = '1'
after(async () => {
  delete process.env.STORY_STUDIO_SERVER_MODE
  await isolated.cleanup()
})
const { getServerModeConfig } = await import('../lib/server-mode.js')
const settings = await import('../services/app-settings.js')

// S14: the server-mode block is parsed once per file identity, and every server-mode write is seen.
test('server-mode config is memoized per settings file and follows rotation and credential changes', async () => {
  await settings.setServerModeCredentials({ username: 'owner', password: 'correct horse battery' })
  const file = path.join(isolated.dir, 'app-settings.json')
  const stamp = new Date('2026-10-01T00:00:00Z')
  await fs.utimes(file, stamp, stamp)
  const first = getServerModeConfig()!.auth!
  assert.equal(first.username, 'owner')

  // Same size + same mtime + same inode: served from the memo (proves no re-parse).
  const raw = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, raw.replace('"owner"', '"OWNER"'))
  await fs.utimes(file, stamp, stamp)
  assert.equal(getServerModeConfig()!.auth!.username, 'owner', 'memo hit')
  await fs.writeFile(file, raw)

  // "Sign out everywhere" writes without announcing; the new secret must apply at once.
  await settings.rotateServerModeSessionSecret()
  const rotated = getServerModeConfig()!.auth!
  assert.notEqual(rotated.session_secret, first.session_secret)

  await settings.setServerModeCredentials({ username: 'second', password: 'another long password' })
  assert.equal(getServerModeConfig()!.auth!.username, 'second')
  await settings.setServerModeNetworking({ port: 9123 })
  assert.equal(getServerModeConfig()!.port, 9123)
})
