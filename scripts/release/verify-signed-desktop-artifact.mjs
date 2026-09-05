#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expandArtifactName } from './release-utils.mjs'
import { packagedDependencyFailures } from './verify-packaged-dependencies.mjs'
import { smokeLaunch } from './smoke-launch-artifact.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

const artifactName = expandArtifactName(contract.artifactName, {
  productName: contract.productName,
  version: pkg.version,
  arch: contract.architectures[0],
  ext: 'dmg',
})
const appPath = path.resolve(root, argValue('--app') || `dist/mac-${contract.architectures[0]}/${contract.productName}.app`)
const dmgPath = path.resolve(root, argValue('--dmg') || `dist/${artifactName}`)

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${output}`)
  return output
}

if (process.platform !== 'darwin') throw new Error('Signed artifact verification requires macOS.')
if (!fs.existsSync(appPath)) throw new Error(`Signed app is missing: ${appPath}`)
if (!fs.existsSync(dmgPath)) throw new Error(`Notarized DMG is missing: ${dmgPath}`)

// v1.4.69 — run these BEFORE the signing assertions. A correctly signed and
// notarized app that cannot start is still a dead app: v1.4.68 was packaged
// without its runtime dependencies and every structural check passed it.
// This path ships to real customers, so it gets the same floor as the smoke
// path — and running it first keeps the check reachable (and testable) on an
// ad-hoc build that has no Developer ID yet.
const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
const unpackedRoot = `${asarPath}.unpacked`
const dependencyResult = packagedDependencyFailures(asarPath, fs.existsSync(unpackedRoot) ? unpackedRoot : null)
if (dependencyResult.failures.length) {
  throw new Error(`Packaged runtime dependencies are incomplete:\n- ${dependencyResult.failures.join('\n- ')}`)
}

const launchResult = await smokeLaunch(appPath, { timeoutMs: Number(argValue('--launch-timeout') || 180_000) })
if (!launchResult.ok) {
  throw new Error(`The signed app does not run:\n- ${launchResult.errors.join('\n- ')}`)
}

capture('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
const signature = capture('codesign', ['-dv', '--verbose=4', appPath])
if (!/Authority=Developer ID Application/.test(signature)) {
  throw new Error('The app is not signed with a Developer ID Application certificate.')
}
if (/TeamIdentifier=not set/.test(signature) || !/TeamIdentifier=/.test(signature)) {
  throw new Error('The app signature has no Apple developer team identifier.')
}

capture('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
capture('xcrun', ['stapler', 'validate', appPath])
capture('xcrun', ['stapler', 'validate', dmgPath])

console.log(`Signed and notarized desktop artifact verified: ${dmgPath}`)
console.log(`  runtime dependency closure inside app.asar: ${dependencyResult.resolvedCount} packages`)
console.log(`  launch smoke test: booted and served /api/health + Upload Center overview on port ${launchResult.port} in ${launchResult.ms}ms`)
