#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expandArtifactName, packagingTreeErrors, restoreSourceManifests, snapshotSourceManifests } from './release-utils.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const { Arch, Platform, build } = require('electron-builder')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'))
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
// The unsigned verification build is still a smoke candidate, but its DMG is
// the artifact users need to pick up. Keep it in the normal dist handoff
// folder instead of hiding it inside a release-smoke subdirectory.
const outputDir = path.join(root, 'dist')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`Unsigned DMG smoke packaging requires an arm64 Mac; got ${process.platform}/${process.arch}.`)
  process.exit(1)
}

function runNpm(args) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${result.status}`)
}

const treeErrors = packagingTreeErrors(root)
if (treeErrors.length) {
  console.error('Cannot package from this tree:')
  for (const error of treeErrors) console.error(`- ${error}`)
  process.exit(1)
}

runNpm(['run', 'fetch:ffmpeg'])
runNpm(['run', 'build'])
runNpm(['run', 'check:release', '--', '--built', '--package-input'])

// Never consume signing or notarization credentials for a smoke artifact.
for (const name of [
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME',
  'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE',
]) delete process.env[name]
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

const config = structuredClone(baseConfig)
config.directories = { ...config.directories, output: outputDir }
if (!fs.existsSync(path.join(electronDist, 'Electron.app'))) {
  throw new Error(`Lockfile-installed Electron runtime is missing: ${electronDist}`)
}
config.electronDist = electronDist
config.mac = {
  ...config.mac,
  identity: null,
  notarize: false,
}
config.forceCodeSigning = false

const artifactName = expandArtifactName(contract.artifactName, {
  productName: contract.productName,
  version: pkg.version,
  arch: contract.architectures[0],
  ext: 'dmg',
})
const appOutputDir = path.join(outputDir, 'mac-arm64')
const dmgOutputPath = path.join(outputDir, artifactName)
// Never clean the whole dist folder: it is the visible handoff location and
// may contain prior releases. Remove only this version's app + DMG so stale
// files cannot satisfy the verification that follows.
fs.rmSync(appOutputDir, { recursive: true, force: true })
// **The owner's rule, 2026-09-26: an old DMG moves to `_trash/dist/`; it is never `rm`d.**
// This line was `fs.rmSync(dmgOutputPath, { force: true })`, so a rebuild of the same version
// destroyed the previous artefact, and every other version's DMG simply stayed in `dist/` for
// ever. Both now move aside. `mac-arm64/` above is a working tree electron-builder regenerates,
// not an artefact anyone keeps, so removing that one stands.
const trashDist = path.join(root, '_trash', 'dist')
fs.mkdirSync(trashDist, { recursive: true })
const dmgStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
for (const entry of fs.readdirSync(outputDir)) {
  if (!entry.endsWith('.dmg') && !entry.endsWith('.dmg.blockmap')) continue
  // The stamp goes BEFORE the extension, so a trashed blockmap still reads as one:
  // `…-arm64-<stamp>.dmg.blockmap`. Stripping only the last extension left
  // `…-arm64.dmg-<stamp>.blockmap`, which reads as a blockmap of a `.dmg-…` file.
  const suffix = entry.endsWith('.blockmap') ? '.dmg.blockmap' : '.dmg'
  const stem = entry.slice(0, -suffix.length)
  fs.renameSync(path.join(outputDir, entry), path.join(trashDist, `${stem}-${dmgStamp}${suffix}`))
}

console.log(`[unsigned-package] packaging ${contract.productName} v${pkg.version} (${contract.architectures[0]}) into dist/`)
// NEW-11 is NOT this build's doing — see the corrected note on `snapshotSourceManifests`.
// The manifest was overwritten by `npx asar extract-file … package.json` run from the repo
// root, which writes the packaged manifest into the current working directory. This guard
// is kept as cheap insurance against a future electron-builder that really does rewrite it;
// the test that actually catches the symptom is source-manifest-integrity.test.ts.
const manifestSnapshot = snapshotSourceManifests(root)
try {
  await build({
    targets: Platform.MAC.createTarget(['dmg'], Arch.arm64),
    config,
    publish: 'never',
  })

  const appPath = path.join(outputDir, 'mac-arm64', `${contract.productName}.app`)

  const verify = spawnSync(process.execPath, [
    path.join(scriptDir, 'verify-desktop-artifact.mjs'),
    '--app', appPath,
    '--dmg', dmgOutputPath,
  ], { cwd: root, stdio: 'inherit', env: process.env })
  if (verify.error) throw verify.error
  if (verify.status !== 0) throw new Error(`artifact verification exited ${verify.status}`)
} finally {
  const rewritten = restoreSourceManifests(root, manifestSnapshot)
  if (rewritten.length) {
    console.log(`[unsigned-package] packaging rewrote ${rewritten.join(', ')}; restored the checkout's own copies (NEW-11)`)
  }
}

console.log(`[unsigned-package] ready: ${dmgOutputPath}`)
