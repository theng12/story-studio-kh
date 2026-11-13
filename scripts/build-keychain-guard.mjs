#!/usr/bin/env node
/**
 * build-keychain-guard.mjs — compiles the native Keychain interaction guard addon.
 *
 *   native/keychain-guard/keychain-guard.cc  ->  electron/dist/keychain-guard.node
 *
 * Why an addon: Chromium's queryUIFail alone cannot prove this app may read its own file-based
 * Keychain item, and SecKeychainSetUserInteractionAllowed is process-local. N-API keeps it
 * dependency-free. Headers come from whatever Node/Electron development headers are already on this
 * Mac; nothing is downloaded or installed.
 *
 * macOS only: on another platform this exits 0 without building.
 *
 *   node scripts/build-keychain-guard.mjs
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'native', 'keychain-guard', 'keychain-guard.cc')
const outDir = path.join(root, 'electron', 'dist')
const addon = path.join(outDir, 'keychain-guard.node')

if (process.platform !== 'darwin') {
  console.log('build-keychain-guard: skipped (macOS only)')
  process.exit(0)
}

// Locally installed N-API headers only: project packages, then node-gyp/electron-gyp caches, then
// Homebrew-style prefixes. The current Node version sorts first inside each cache.
function headerCandidates() {
  const list = [
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
    for (const version of versions) list.push(path.join(cache, version, 'include', 'node'))
  }
  return list
}

const candidates = headerCandidates()
const headers = candidates.find(dir => fs.existsSync(path.join(dir, 'node_api.h')))
if (!headers) {
  console.error('build-keychain-guard: no local node_api.h found. Checked:')
  for (const dir of candidates) console.error(`  ${dir}`)
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const compiled = spawnSync('clang++', [
  '-std=c++17', '-O2', '-fPIC', '-shared', '-mmacosx-version-min=11.0', '-DNAPI_VERSION=8',
  // SecKeychain is deprecated but remains the only in-process guard for file-based Keychain items.
  '-Wno-deprecated-declarations',
  '-undefined', 'dynamic_lookup',
  '-I', headers,
  '-framework', 'Security', '-framework', 'CoreFoundation',
  '-o', addon,
  source,
], { stdio: 'inherit' })
if (compiled.error || compiled.status !== 0) {
  console.error('build-keychain-guard: clang++ failed (is the Xcode Command Line Tools install present?)')
  process.exit(1)
}

// Load shape only. Calling probe would touch a real Keychain, so it is never invoked here.
const loaded = createRequire(import.meta.url)(addon)
const shape = {
  setInteractionAllowed: typeof loaded.setInteractionAllowed,
  probe: typeof loaded.probe,
  delete: typeof loaded.delete,
  setInteractionAllowedArity: loaded.setInteractionAllowed?.length,
  probeArity: loaded.probe?.length,
}
if (shape.setInteractionAllowed !== 'function' || shape.probe !== 'function' || shape.delete !== 'function') {
  console.error('build-keychain-guard: built addon is missing an export:', shape)
  process.exit(1)
}
console.log(`build-keychain-guard: OK -> ${path.relative(root, addon)} (${JSON.stringify(shape)})`)
