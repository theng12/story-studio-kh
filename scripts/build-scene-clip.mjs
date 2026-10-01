#!/usr/bin/env node
/**
 * build-scene-clip.mjs — compiles the native scene-clip helper that ships inside the .app.
 *
 *   native/scene-clip/main.swift  ->  bundled/scene-clip/scene-clip  (arm64, macOS 13+)
 *
 * Why a helper at all: an Apple-silicon Mac renders a Ken-Burns scene clip with Metal and encodes it
 * on the media engine for about 1 CPU-second, where FFmpeg's `zoompan` chain costs 30-45. The Node
 * side (electron/server/lib/native-scene-clip.ts) falls back to FFmpeg per clip, so a missing binary
 * costs speed, never correctness; the release check still insists on it so the speed-up cannot be
 * lost silently.
 *
 * Plain `swiftc`, no SwiftPM: one source file, no dependencies, and it works on a Mac that only has
 * the Command Line Tools. Output lands in `bundled/` beside ffmpeg (electron-builder excludes
 * `build/` from extraResources; see fetch-ffmpeg.mjs).
 *
 *   node scripts/build-scene-clip.mjs            build (always rebuilds)
 *   node scripts/build-scene-clip.mjs --check    build into a temp dir, run `--version`, discard
 *
 * The helper version printed by `--version` must equal NATIVE_SCENE_CLIP_VERSION in
 * native-scene-clip.ts; the app refuses a helper whose version disagrees.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'native', 'scene-clip', 'main.swift')
const check = process.argv.includes('--check')
const outDir = check ? fs.mkdtempSync(path.join(os.tmpdir(), 'scene-clip-')) : path.join(root, 'bundled', 'scene-clip')
const binary = path.join(outDir, 'scene-clip')

if (process.platform !== 'darwin') {
  console.error('build-scene-clip: macOS only (Metal + VideoToolbox).')
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const swift = spawnSync('swiftc', [
  '-O', '-whole-module-optimization',
  '-target', 'arm64-apple-macos13.0',
  // The AVAssetWriter APIs this uses are deprecated on the newest SDKs but present on every macOS the app supports.
  '-suppress-warnings',
  '-o', binary,
  source,
], { stdio: 'inherit' })
if (swift.error || swift.status !== 0) {
  console.error('build-scene-clip: swiftc failed (is the Xcode Command Line Tools install present?)')
  process.exit(1)
}

const version = spawnSync(binary, ['--version'], { encoding: 'utf8' })
if (version.status !== 0 || !/^scene-clip \d+/.test(version.stdout)) {
  console.error('build-scene-clip: the built helper does not run:', version.stderr || version.stdout)
  process.exit(1)
}

if (!check) {
  const swiftVersion = spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0]
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify({
    helper: version.stdout.trim(),
    source_sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    binary_sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    toolchain: swiftVersion,
    target: 'arm64-apple-macos13.0',
  }, null, 2) + '\n')
}
console.log(`build-scene-clip: ${version.stdout.trim()} -> ${check ? '(checked, discarded)' : path.relative(root, binary)}`)
if (check) fs.rmSync(outDir, { recursive: true, force: true })
