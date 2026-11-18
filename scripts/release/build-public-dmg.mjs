#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createDmgBuildDirectory, expandArtifactName, packagingTreeErrors, promoteDmgBuild, restoreSourceManifests, snapshotSourceManifests } from './release-utils.mjs'
import { notarytoolCredentialArgs, publicReleaseCredentialErrors } from './public-release-credentials.mjs'
import { resolveTrashRootSync } from '../shared-paths.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const { Arch, Platform, build } = require('electron-builder')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'))
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const outputDir = path.join(root, 'dist')

function run(command, args, { redactArgs = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command}${redactArgs ? ' [credentials redacted]' : ` ${args.join(' ')}`} exited ${result.status}`)
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`Public DMG packaging requires an arm64 Mac; got ${process.platform}/${process.arch}.`)
}
const credentialErrors = publicReleaseCredentialErrors()
if (credentialErrors.length) {
  throw new Error(`Public release credentials are incomplete:\n- ${credentialErrors.join('\n- ')}`)
}

const treeErrors = packagingTreeErrors(root)
if (treeErrors.length) {
  throw new Error(`Cannot package from this tree:\n- ${treeErrors.join('\n- ')}`)
}

const trashDist = path.join(resolveTrashRootSync(), 'dist')
const buildDir = createDmgBuildDirectory(outputDir, trashDist)
run('npm', ['run', 'fetch:ffmpeg'])
run('npm', ['run', 'build:scene-clip'])
run('npm', ['run', 'build'])
run('npm', ['run', 'check:release', '--', '--built', '--package-input'])

const config = structuredClone(baseConfig)
config.directories = { ...config.directories, output: buildDir }
if (!fs.existsSync(path.join(electronDist, 'Electron.app'))) {
  throw new Error(`Lockfile-installed Electron runtime is missing: ${electronDist}`)
}
config.electronDist = electronDist
config.forceCodeSigning = true
config.mac = { ...config.mac, notarize: true }

const artifactName = expandArtifactName(contract.artifactName, {
  productName: contract.productName,
  version: pkg.version,
  arch: contract.architectures[0],
  ext: 'dmg',
})
const dmgPath = path.join(buildDir, artifactName)
// Keep existing installers intact until the staged package passes verification.

console.log(`[public-package] signing and packaging ${contract.productName} v${pkg.version}`)
// electron-builder has been seen to rewrite this checkout's own manifest into its
// trimmed packaging shape (NEW-11). Snapshot both manifests and put them back in a
// `finally`, so neither a successful build nor a failed one leaves a checkout where
// `npm run …` no longer works.
const manifestSnapshot = snapshotSourceManifests(root)
try {
  await build({
    targets: Platform.MAC.createTarget(['dmg'], Arch.arm64),
    config,
    publish: 'never',
  })

  // Electron Builder notarizes and staples the app before creating the DMG. The
  // finished container is a separate artifact and therefore receives its own
  // notary submission and ticket.
  run('xcrun', ['notarytool', 'submit', dmgPath, ...notarytoolCredentialArgs(), '--wait'], { redactArgs: true })
  run('xcrun', ['stapler', 'staple', dmgPath])

  const appPath = path.join(buildDir, 'mac-arm64', `${contract.productName}.app`)
  run(process.execPath, [
    path.join(scriptDir, 'verify-signed-desktop-artifact.mjs'),
    '--app', appPath,
    '--dmg', dmgPath,
  ])
} finally {
  const rewritten = restoreSourceManifests(root, manifestSnapshot)
  if (rewritten.length) {
    console.log(`[public-package] packaging rewrote ${rewritten.join(', ')}; restored the checkout's own copies (NEW-11)`)
  }
}

const backup = promoteDmgBuild(buildDir, outputDir, trashDist, artifactName)
console.log(`[public-package] previous candidate outputs preserved: ${backup}`)
console.log(`[public-package] ready: ${path.join(outputDir, artifactName)}`)
