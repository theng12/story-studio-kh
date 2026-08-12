#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expandArtifactName } from './release-utils.mjs'
import { notarytoolCredentialArgs, publicReleaseCredentialErrors } from './public-release-credentials.mjs'

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

run('npm', ['run', 'fetch:ffmpeg'])
run('npm', ['run', 'build'])
run('npm', ['run', 'check:release', '--', '--built', '--package-input'])

const config = structuredClone(baseConfig)
config.directories = { ...config.directories, output: outputDir }
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
const appOutputDir = path.join(outputDir, 'mac-arm64')
const dmgPath = path.join(outputDir, artifactName)
fs.rmSync(appOutputDir, { recursive: true, force: true })
fs.rmSync(dmgPath, { force: true })

console.log(`[public-package] signing and packaging ${contract.productName} v${pkg.version}`)
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

const appPath = path.join(outputDir, 'mac-arm64', `${contract.productName}.app`)
run(process.execPath, [
  path.join(scriptDir, 'verify-signed-desktop-artifact.mjs'),
  '--app', appPath,
  '--dmg', dmgPath,
])

console.log(`[public-package] ready: ${dmgPath}`)
