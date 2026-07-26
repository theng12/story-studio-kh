#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expandArtifactName } from './release-utils.mjs'

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
