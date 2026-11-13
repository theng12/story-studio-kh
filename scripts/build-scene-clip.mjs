#!/usr/bin/env node
/**
 * build-scene-clip.mjs — compiles and assembles Story Studio KH Helper.app.
 *
 *   native/scene-clip/*.swift -> Contents/MacOS/Story Studio KH Helper
 *
 * One render executable, one user-visible name: "Story Studio KH Helper".
 *
 * Why a render helper at all: an Apple-silicon Mac renders a Ken-Burns scene clip with Metal and
 * encodes it on the media engine for about 1 CPU-second, where FFmpeg's `zoompan` chain costs
 * 30-45. The Node side (electron/server/lib/native-scene-clip.ts) falls back to FFmpeg per clip, so
 * a missing binary costs speed, never correctness; the release check still insists on it so the
 * speed-up cannot be lost silently.
 *
 * Plain `swiftc`, no SwiftPM: three source files, no dependencies, and it works on a Mac that only
 * has the Command Line Tools. Output lands in `bundled/` beside ffmpeg.
 *
 *   node scripts/build-scene-clip.mjs            build the bundle (always rebuilds)
 *   node scripts/build-scene-clip.mjs --check    compile the render helper into a temp dir, run
 *                                                `--version`, retire to _trash
 *   node scripts/build-scene-clip.mjs --output-dir /abs/path   retain an isolated render-helper
 *                                                proof build (the old scene-clip binary only)
 *
 * The render helper version printed by `--version` must equal NATIVE_SCENE_CLIP_VERSION in
 * native-scene-clip.ts; the app refuses a helper whose version disagrees.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_NAME = 'Story Studio KH Helper'
const bundle = path.join(root, 'bundled', `${APP_NAME}.app`)
const renderSources = ['main.swift', 'SketchDraw.swift'].map(file => path.join(root, 'native', 'scene-clip', file))
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const check = process.argv.includes('--check')
const outputArg = process.argv.indexOf('--output-dir')
const isolated = outputArg >= 0 ? path.resolve(process.argv[outputArg + 1]) : null

if (process.platform !== 'darwin') {
  console.error('build-scene-clip: macOS only (Metal + VideoToolbox).')
  process.exit(1)
}

function compile(output, sources, label) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const result = spawnSync('swiftc', [
    '-O', '-whole-module-optimization',
    '-target', 'arm64-apple-macos13.0',
    // The AVAssetWriter APIs this uses are deprecated on the newest SDKs but present on every macOS the app supports.
    '-suppress-warnings',
    '-o', output,
    ...sources,
  ], { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    console.error(`build-scene-clip: swiftc failed for the ${label} (is the Xcode Command Line Tools install present?)`)
    process.exit(1)
  }
}

function versionOf(binary, expected, label) {
  const out = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  if (out.status !== 0 || !expected.test(out.stdout)) {
    console.error(`build-scene-clip: the built ${label} does not run:`, out.stderr || out.stdout)
    process.exit(1)
  }
  return out.stdout.trim()
}

if (isolated) {
  const binary = path.join(isolated, 'scene-clip')
  compile(binary, renderSources, 'render helper')
  const version = versionOf(binary, /^scene-clip \d+/, 'render helper')
  console.log(`build-scene-clip: ${version} -> ${path.relative(root, binary)}`)
  process.exit(0)
}

if (check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-helper-'))
  const binary = path.join(dir, APP_NAME)
  compile(binary, renderSources, 'render helper')
  const renderVersion = versionOf(binary, /^scene-clip \d+/, 'render helper')
  console.log(`build-scene-clip: ${renderVersion} (checked)`)
  const trash = path.join(root, '_trash', 'scene-clip-build-checks')
  fs.mkdirSync(trash, { recursive: true })
  fs.renameSync(dir, path.join(trash, path.basename(dir)))
  process.exit(0)
}

const contents = path.join(bundle, 'Contents')
const macos = path.join(contents, 'MacOS')
const resources = path.join(contents, 'Resources')
const renderBinary = path.join(macos, APP_NAME)
// Retire both old executables recoverably before replacing the swap helper.
const oldBinaries = [renderBinary, path.join(resources, APP_NAME)].filter(file => fs.existsSync(file))
if (oldBinaries.length) {
  const retired = path.join(root, '_trash', 'story-helper-swap-20261113', `binaries-${Date.now()}`)
  for (const file of oldBinaries) {
    const target = path.join(retired, path.basename(path.dirname(file)), APP_NAME)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(file, target)
  }
}
compile(renderBinary, renderSources, 'render helper')
const renderVersion = versionOf(renderBinary, /^scene-clip \d+/, 'render helper')
fs.mkdirSync(resources, { recursive: true })

fs.copyFileSync(path.join(root, 'build', 'icon.icns'), path.join(resources, 'AppIcon.icns'))
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIdentifier</key><string>com.storystudio.kh.helper</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleShortVersionString</key><string>${packageVersion}</string>
  <key>CFBundleVersion</key><string>${packageVersion}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`)

const swiftVersion = spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0]
const manifest = {
  helper: renderVersion,
  source_sha256: createHash('sha256').update(Buffer.concat(renderSources.map(source => fs.readFileSync(source)))).digest('hex'),
  binary_sha256: createHash('sha256').update(fs.readFileSync(renderBinary)).digest('hex'),
  toolchain: swiftVersion,
  target: 'arm64-apple-macos13.0',
}
fs.writeFileSync(path.join(resources, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`build-scene-clip: ${renderVersion} -> ${path.relative(root, bundle)}`)
