import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const macOnly = process.platform !== 'darwin'
const skip = macOnly ? 'macOS only' : false
const SERVICE = 'story-studio-keychain-guard-test'
const ACCOUNT = 'contract-account'
const ERR_SEC_AUTH_FAILED = -25293
const ERR_SEC_USER_CANCELED = -128

function nodeApiHeaders() {
  const candidates = [
    path.resolve(path.dirname(fs.realpathSync(process.execPath)), '..', 'include', 'node'),
    path.join(root, 'node_modules', 'node-api-headers', 'include', 'node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ]
  const caches = [
    path.join(os.homedir(), 'Library', 'Caches', 'node-gyp'),
    path.join(os.homedir(), '.cache', 'node-gyp'),
    path.join(os.homedir(), '.node-gyp'),
    path.join(os.homedir(), 'Library', 'Caches', 'electron-gyp'),
    path.join(os.homedir(), '.electron-gyp'),
  ]
  for (const cache of caches) {
    let versions = []
    try {
      versions = fs.readdirSync(cache)
    } catch {
      continue
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) candidates.push(path.join(cache, version, 'include', 'node'))
  }
  return candidates.find(dir => fs.existsSync(path.join(dir, 'node_api.h')))
}

function buildTestAddon() {
  const headers = nodeApiHeaders()
  assert.ok(headers, 'no local node_api.h found for the native contract fixture')
  const workRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT || process.env.STORY_STUDIO_TEST_WORK_ROOT || path.join(root, '.test-work')
  fs.mkdirSync(workRoot, { recursive: true })
  const outDir = fs.mkdtempSync(path.join(workRoot, 'keychain-guard-contract-'))
  const addon = path.join(outDir, 'keychain-guard-test.node')
  const source = path.join(root, 'native', 'keychain-guard', 'keychain-guard-test-fixture.cc')
  const compiled = spawnSync('clang++', [
    '-std=c++17', '-O2', '-fPIC', '-shared', '-mmacosx-version-min=11.0', '-DNAPI_VERSION=8',
    '-Wno-deprecated-declarations',
    '-undefined', 'dynamic_lookup',
    '-I', headers,
    '-o', addon,
    source,
  ], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, `clang++ failed:\n${compiled.stdout}${compiled.stderr}`)
  return addon
}

const addonPath = macOnly ? null : buildTestAddon()
if (addonPath) {
  // Abort the whole file before loading or invoking anything if a stub ever goes missing.
  const nm = spawnSync('nm', ['-u', addonPath], { encoding: 'utf8' })
  assert.equal(nm.status, 0, nm.stderr)
  assert.doesNotMatch(`${nm.stdout}${nm.stderr}`, /SecKeychain/)
}
const addon = addonPath ? createRequire(import.meta.url)(addonPath) : null

function run(scenario, interactive = false) {
  addon.reset(scenario)
  return addon.probe(SERVICE, ACCOUNT, interactive)
}

describe('keychain-guard native contract (stubbed Keychain)', { skip }, () => {
  test('exports both production functions and no real Security symbol', () => {
    assert.equal(typeof addon.setInteractionAllowed, 'function')
    assert.equal(typeof addon.probe, 'function')
  })

  test('success reads the exact service/account, frees the secret, restores false last', () => {
    assert.equal(run('success'), 0)
    assert.deepEqual(addon.trace(), [
      'set:false', `find:${SERVICE}/${ACCOUNT}`, 'free', 'set:false',
    ])
  })

  test('interactive success sets true only after the guard and restores false', () => {
    assert.equal(run('success', true), 0)
    assert.deepEqual(addon.trace(), [
      'set:false', 'set:true', `find:${SERVICE}/${ACCOUNT}`, 'free', 'set:false',
    ])
  })

  test('denial returns errSecAuthFailed and still restores false', () => {
    assert.equal(run('denied'), ERR_SEC_AUTH_FAILED)
    assert.deepEqual(addon.trace(), ['set:false', `find:${SERVICE}/${ACCOUNT}`, 'set:false'])
  })

  test('cancellation returns errSecUserCanceled and still restores false', () => {
    assert.equal(run('cancelled'), ERR_SEC_USER_CANCELED)
    assert.deepEqual(addon.trace(), ['set:false', `find:${SERVICE}/${ACCOUNT}`, 'set:false'])
  })

  test('guard setup failure throws before any read', () => {
    addon.reset('guard-setup-fails')
    assert.throws(
      () => addon.probe(SERVICE, ACCOUNT, false),
      /SecKeychainSetUserInteractionAllowed\(false\) failed/,
    )
    assert.deepEqual(addon.trace(), ['set:false'])
  })

  test('restore failure after a read throws, after freeing the secret', () => {
    addon.reset('guard-restore-fails')
    assert.throws(
      () => addon.probe(SERVICE, ACCOUNT, false),
      /restoring the keychain interaction guard failed/,
    )
    assert.deepEqual(addon.trace(), [
      'set:false', `find:${SERVICE}/${ACCOUNT}`, 'free', 'set:false',
    ])
  })

  test('interactive set failure restores false and refuses before reading', () => {
    addon.reset('interactive-set-fails')
    assert.throws(
      () => addon.probe(SERVICE, ACCOUNT, true),
      /SecKeychainSetUserInteractionAllowed\(true\) failed/,
    )
    assert.deepEqual(addon.trace(), ['set:false', 'set:true', 'set:false'])
  })

  test('invalid arguments are rejected before any native call', () => {
    addon.reset('success')
    assert.throws(() => addon.probe(), TypeError)
    assert.throws(() => addon.probe('', ACCOUNT, false), TypeError)
    assert.throws(() => addon.probe(SERVICE, ACCOUNT, 'yes'), TypeError)
    assert.throws(() => addon.probe(SERVICE, ACCOUNT, false, 'extra'), TypeError)
    assert.throws(() => addon.probe('service\u0000suffix', ACCOUNT, false), TypeError)
    assert.throws(() => addon.setInteractionAllowed('yes'), TypeError)
    assert.throws(() => addon.setInteractionAllowed(false, 'extra'), TypeError)
    assert.deepEqual(addon.trace(), [])
  })
})
