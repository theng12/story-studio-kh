#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expandArtifactName, packagingTreeErrors, restoreSourceManifests, snapshotSourceManifests, trashOldDmgs } from './release-utils.mjs'
import { localSigningConfig } from './local-signing.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const { Arch, Platform, build } = require('electron-builder')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'))
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
// The file name is legacy: this is the normal release build, and it now signs
// with the shared local identity through electron-builder instead of ad-hoc.
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

// Fail before the expensive build steps when the shared identity is not usable.
// Never consume Developer ID or notarization credentials for the normal
// release. The local identity is a certificate name, not a credential.
for (const name of [
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME',
  'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE',
]) delete process.env[name]
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

let signing
try {
  signing = localSigningConfig()
} catch (error) {
  console.error(`[release-package] ${error.message}`)
  process.exit(1)
}

runNpm(['run', 'fetch:ffmpeg'])
runNpm(['run', 'build:scene-clip'])
runNpm(['run', 'build'])
runNpm(['run', 'check:release', '--', '--built', '--package-input'])

const config = structuredClone(baseConfig)
config.directories = { ...config.directories, output: outputDir }
if (!fs.existsSync(path.join(electronDist, 'Electron.app'))) {
  throw new Error(`Lockfile-installed Electron runtime is missing: ${electronDist}`)
}
config.electronDist = electronDist
// Let electron-builder sign nested code and then the bundle with the shared
// local identity. No post-build hand-sealing and no `codesign --deep` signing.
config.mac = {
  ...config.mac,
  ...signing.mac,
}
config.forceCodeSigning = signing.forceCodeSigning

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
trashOldDmgs(outputDir, path.join(root, '_trash', 'dist'))

console.log(`[release-package] packaging ${contract.productName} v${pkg.version} (${contract.architectures[0]}) into dist/ signed as "${signing.status.identity}"`)
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
    '--require-identity', signing.status.identity,
  ], { cwd: root, stdio: 'inherit', env: process.env })
  if (verify.error) throw verify.error
  if (verify.status !== 0) throw new Error(`artifact verification exited ${verify.status}`)

  const signingProof = spawnSync(process.execPath, [
    path.join(scriptDir, 'verify-macos-signing.mjs'),
    '--app', appPath,
    '--identity', signing.status.identity,
    '--receipt', path.join(outputDir, `signing-${pkg.version}.json`),
  ], { cwd: root, stdio: 'inherit', env: process.env })
  if (signingProof.error) throw signingProof.error
  if (signingProof.status !== 0) throw new Error(`packaged signing and launchd verification exited ${signingProof.status}`)
} finally {
  const rewritten = restoreSourceManifests(root, manifestSnapshot)
  if (rewritten.length) {
    console.log(`[release-package] packaging rewrote ${rewritten.join(', ')}; restored the checkout's own copies (NEW-11)`)
  }
}

console.log(`[release-package] ready: ${dmgOutputPath}`)
