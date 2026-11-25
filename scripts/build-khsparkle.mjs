#!/usr/bin/env node
/**
 * Compiles the one shim call site the packaged app loads. N-API, no node-gyp:
 * headers come from the installed Electron/Node on this Mac. The addon keeps
 * @rpath so dyld resolves Sparkle from Contents/Frameworks in the bundle.
 * Nothing is loaded at test time: start() needs the app's own Info.plist.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor', 'khsparkle')
const source = path.join(root, 'native', 'khsparkle', 'khsparkle-addon.c')
const lib = path.join(vendor, 'libkhsparkle.a')
const header = path.join(vendor, 'khsparkle.h')
const addon = path.join(root, 'electron', 'dist', 'khsparkle.node')

if (process.platform !== 'darwin') {
  console.log('build-khsparkle: skipped (macOS only)')
  process.exit(0)
}
for (const needed of [source, lib, header, path.join(vendor, 'Sparkle.framework')]) {
  if (!fs.existsSync(needed)) {
    console.error(`build-khsparkle: missing ${path.relative(root, needed)}`)
    process.exit(1)
  }
}

function headerCandidates() {
  const list = [
    path.resolve(path.dirname(fs.realpathSync(process.execPath)), '..', 'include', 'node'),
    path.join(root, 'node_modules', 'node-api-headers', 'include', 'node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ]
  const caches = [
    path.join(os.homedir(), 'Library', 'Caches', 'electron-gyp'),
    path.join(os.homedir(), '.electron-gyp'),
    path.join(os.homedir(), 'Library', 'Caches', 'node-gyp'),
    path.join(os.homedir(), '.cache', 'node-gyp'),
    path.join(os.homedir(), '.node-gyp'),
  ]
  for (const cache of caches) {
    let versions = []
    try { versions = fs.readdirSync(cache) } catch { continue }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) list.push(path.join(cache, version, 'include', 'node'))
  }
  return list
}

const headers = headerCandidates().find((dir) => fs.existsSync(path.join(dir, 'node_api.h')))
if (!headers) {
  console.error('build-khsparkle: no local node_api.h found; install the Xcode Command Line Tools or Electron headers')
  process.exit(1)
}

fs.mkdirSync(path.dirname(addon), { recursive: true })
const compiled = spawnSync('clang', [
  '-std=c11', '-O2', '-fPIC', '-shared', '-mmacosx-version-min=12.0', '-DNAPI_VERSION=8',
  '-undefined', 'dynamic_lookup',
  '-Wl,-install_name,@rpath/khsparkle.node',
  '-Wl,-rpath,@executable_path/../Frameworks',
  '-I', headers, '-I', vendor,
  '-F', vendor, '-framework', 'Sparkle', '-framework', 'Foundation',
  '-o', addon,
  source, lib,
], { stdio: 'inherit' })
if (compiled.error || compiled.status !== 0) {
  console.error('build-khsparkle: clang failed; the packaged app cannot check for updates')
  process.exit(1)
}

// Load shape only, in a child: outside a bundle @executable_path/../Frameworks does
// not point at our framework. start() is never called here (it needs Info.plist).
const probe = spawnSync(process.execPath, [
  '-e', `const l=require(${JSON.stringify(addon)});console.log(JSON.stringify({start:typeof l.start,lastError:typeof l.lastError}))`,
], { env: { ...process.env, DYLD_FRAMEWORK_PATH: vendor }, encoding: 'utf8' })
let shape
try { shape = JSON.parse(probe.stdout.trim()) } catch { shape = {} }
if (probe.status !== 0 || shape.start !== 'function' || shape.lastError !== 'function') {
  console.error('build-khsparkle: built addon failed to load or is missing an export:', shape, probe.stderr)
  process.exit(1)
}
console.log(`build-khsparkle: OK -> ${path.relative(root, addon)} (${JSON.stringify(shape)})`)
