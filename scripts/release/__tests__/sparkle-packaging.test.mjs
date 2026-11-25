import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

test('the packaged bundle carries a usable feed, key and hold route', () => {
  const builder = JSON.parse(read('electron-builder.json'))
  const info = builder.mac.extendInfo
  const feed = 'https://theng12.github.io/story-studio-kh/appcast.xml'
  assert.equal(info.SUFeedURL, feed)
  assert.match(read('docs/appcast.xml'), new RegExp(`<link>${feed.replaceAll('/', '\\/')}</link>`))
  assert.match(info.SUPublicEDKey, /^[A-Za-z0-9+/]{43}=$/, 'Ed25519 public key is 32 raw bytes in base64')
  const ownKey = path.join(os.homedir(), '.kh-sparkle', 'com.storystudio.kh', 'private.key.pub')
  if (fs.existsSync(ownKey)) {
    assert.equal(info.SUPublicEDKey, fs.readFileSync(ownKey, 'utf8').trim())
  }
  assert.equal(info.KHHoldURL, 'http://127.0.0.1:8647/api/maintenance/hold')
  assert.equal(info.KHHoldTokenFile, '~/Library/KHUpdater/state/hold-token')
  assert.equal(info.SUEnableAutomaticChecks, true)
  assert.match(read('electron/server/hold-endpoint.ts'), /HOLD_ENDPOINT_PORT = 8647/)
  assert.equal(builder.afterPack, 'scripts/release/after-pack.cjs')
})

test('the Electron addon and entitlements are built into the signed bundle', () => {
  const builder = JSON.parse(read('electron-builder.json'))
  assert.equal(builder.mac.hardenedRuntime, true)
  const entitlements = read('scripts/release/entitlements.mac.plist')
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) assert.match(entitlements, new RegExp(`<key>${key}</key>`))
  assert.match(read('package.json'), /node scripts\/build-khsparkle\.mjs/)
  const vendor = path.join(root, 'vendor', 'khsparkle')
  assert.ok(fs.existsSync(path.join(vendor, 'Sparkle.framework', 'Versions', 'B', 'Sparkle')))
  const addon = fs.readFileSync(path.join(vendor, 'libkhsparkle.a'))
  assert.equal(
    createHash('sha256').update(addon).digest('hex'),
    '2bce760e7749a0f21dfa378c53c391d039401355012e774a81b691043a3cb17f',
    'vendored shim must match the estate pin',
  )
})
