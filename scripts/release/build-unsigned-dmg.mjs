#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expandArtifactName } from './release-utils.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const { Arch, Platform, build } = require('electron-builder')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'))
const outputDir = path.join(root, 'dist', 'release-smoke')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`Unsigned DMG smoke packaging requires an arm64 Mac; got ${process.platform}/${process.arch}.`)
  process.exit(1)
}

const distRoot = path.join(root, 'dist') + path.sep
if (!outputDir.startsWith(distRoot)) throw new Error(`Refusing to clean unexpected output path: ${outputDir}`)

function runNpm(args) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${result.status}`)
}

// The smoke directory is dedicated generated output. Cleaning only this
// validated path prevents a stale app or DMG from satisfying verification.
fs.rmSync(outputDir, { recursive: true, force: true })

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
config.mac = {
  ...config.mac,
  identity: null,
  notarize: false,
}
config.forceCodeSigning = false

console.log(`[release-smoke] packaging unsigned ${contract.productName} v${pkg.version} (${contract.architectures[0]})`)
await build({
  targets: Platform.MAC.createTarget(['dmg'], Arch.arm64),
  config,
  publish: 'never',
})

const artifactName = expandArtifactName(contract.artifactName, {
  productName: contract.productName,
  version: pkg.version,
  arch: contract.architectures[0],
  ext: 'dmg',
})
const appPath = path.join(outputDir, 'mac-arm64', `${contract.productName}.app`)
const dmgPath = path.join(outputDir, artifactName)

const verify = spawnSync(process.execPath, [
  path.join(scriptDir, 'verify-desktop-artifact.mjs'),
  '--app', appPath,
  '--dmg', dmgPath,
], { cwd: root, stdio: 'inherit', env: process.env })
if (verify.error) throw verify.error
if (verify.status !== 0) throw new Error(`artifact verification exited ${verify.status}`)

console.log(`[release-smoke] ready: ${dmgPath}`)
