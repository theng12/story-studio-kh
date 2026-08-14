#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  expandArtifactName,
  contentStoreAssetErrors,
  forbiddenPackageEntry,
  parseChangelog,
  remoteStartupReferences,
  startupReferences,
  walkFiles,
} from './release-utils.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const builder = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'))
const failures = []

function argValue(name) {
  const exact = process.argv.indexOf(name)
  if (exact >= 0) return process.argv[exact + 1]
  const prefix = `${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const outputDir = path.resolve(root, argValue('--output') || 'dist')
const arch = contract.architectures[0]
const artifactName = expandArtifactName(contract.artifactName, {
  productName: contract.productName,
  version: pkg.version,
  arch,
  ext: 'dmg',
})
const appPath = path.resolve(root, argValue('--app') || path.join(outputDir, `mac-${arch}`, `${contract.productName}.app`))
const dmgPath = path.resolve(root, argValue('--dmg') || path.join(outputDir, artifactName))

const fail = (message) => failures.push(message)

function capture(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) {
    if (!allowFailure) fail(`${command}: ${result.error.message}`)
    return { ok: false, output: result.error.message }
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.status !== 0 && !allowFailure) fail(`${command} ${args.join(' ')} failed: ${output}`)
  return { ok: result.status === 0, output }
}

function plistValue(key) {
  const plist = path.join(appPath, 'Contents', 'Info.plist')
  return capture('plutil', ['-extract', key, 'raw', '-o', '-', plist]).output
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

if (process.platform !== contract.platform) fail(`artifact verification requires ${contract.platform}`)
if (path.basename(dmgPath) !== artifactName) fail(`DMG name must be exactly ${artifactName}`)
if (!fs.existsSync(appPath)) fail(`packaged app is missing: ${appPath}`)
if (!fs.existsSync(dmgPath)) fail(`DMG is missing: ${dmgPath}`)

let signatureKind = 'unavailable'
if (fs.existsSync(appPath)) {
  if (plistValue('CFBundleIdentifier') !== contract.appId) fail('Info.plist: bundle identifier differs from release contract')
  if (plistValue('CFBundleShortVersionString') !== pkg.version) fail('Info.plist: short version differs from package.json')
  if (plistValue('CFBundleVersion') !== pkg.version) fail('Info.plist: bundle version differs from package.json')
  if (plistValue('CFBundleName') !== contract.productName) fail('Info.plist: bundle name differs from release contract')

  const executable = path.join(appPath, 'Contents', 'MacOS', contract.executableName)
  const executableArchs = capture('lipo', ['-archs', executable]).output.split(/\s+/).filter(Boolean)
  if (JSON.stringify(executableArchs) !== JSON.stringify(contract.architectures)) {
    fail(`app executable architectures are ${executableArchs.join(', ') || '(none)'}, expected ${contract.architectures.join(', ')}`)
  }

  const signature = capture('codesign', ['-dv', '--verbose=2', appPath], { allowFailure: true })
  signatureKind = signature.ok ? (/Signature=adhoc/i.test(signature.output) ? 'ad-hoc' : 'signed') : 'unsigned'
  if (/Authority=Developer ID|TeamIdentifier=(?!not set)/i.test(signature.output)) {
    fail('smoke artifact unexpectedly has a Developer ID/team signature')
  }

  const resources = path.join(appPath, 'Contents', 'Resources')
  for (const relative of contract.requiredPackagedResources) {
    if (!fs.existsSync(path.join(resources, relative))) fail(`packaged resource is missing: ${relative}`)
  }

  const asarPath = path.join(resources, 'app.asar')
  if (!fs.existsSync(asarPath)) {
    fail('Contents/Resources/app.asar is missing')
  } else {
    const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/^\/+/, ''))
    const entrySet = new Set(entries)
    for (const required of [contract.main, 'electron/preload.cjs', 'frontend/.output/public/index.html', 'package.json']) {
      if (!entrySet.has(required)) fail(`app.asar is missing ${required}`)
    }
    const contentStoreErrors = contentStoreAssetErrors(entries, (entry) => {
      if (!entry.startsWith('frontend/.output/public/_nuxt/')) return ''
      return asar.extractFile(asarPath, entry).toString('utf8')
    })
    for (const error of contentStoreErrors) fail(`packaged frontend Content Store: ${error}`)
    for (const entry of entries) {
      if (forbiddenPackageEntry(entry)) fail(`forbidden file reached app.asar: ${entry}`)
    }

    try {
      const packagedPkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
      if (packagedPkg.version !== pkg.version) fail('app.asar package.json version differs from release version')
      if (packagedPkg.main !== contract.main) fail('app.asar package.json main differs from release contract')
    } catch (error) {
      fail(`could not inspect app.asar package.json: ${error.message}`)
    }

    try {
      const indexEntry = 'frontend/.output/public/index.html'
      const index = asar.extractFile(asarPath, indexEntry).toString('utf8')
      for (const reference of remoteStartupReferences(index)) fail(`packaged frontend has remote startup dependency ${reference}`)
      for (const reference of startupReferences(index)) {
        if (!reference || /^(?:[a-z]+:|#|\/\/)/i.test(reference)) continue
        const expected = `frontend/.output/public/${reference.split(/[?#]/, 1)[0].replace(/^\/+/, '')}`
        if (!entrySet.has(expected)) fail(`packaged frontend is missing startup asset ${reference}`)
      }
      if (!index.includes(`appVersion:"${pkg.version}"`) && !index.includes(`"appVersion":"${pkg.version}"`)) {
        fail(`packaged frontend does not expose runtime version ${pkg.version}`)
      }
    } catch (error) {
      fail(`could not inspect packaged offline frontend: ${error.message}`)
    }

    const textExt = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.txt', '.xml', '.yml', '.yaml'])
    const forbiddenContent = [root, path.join(os.homedir(), 'pinokio'), path.join(os.homedir(), '.pinokio')]
    for (const entry of entries) {
      if (!entry.startsWith('electron/dist/') && !entry.startsWith('frontend/.output/public/')) continue
      if (!textExt.has(path.extname(entry).toLowerCase())) continue
      try {
        const contents = asar.extractFile(asarPath, entry)
        if (contents.length > 20 * 1024 * 1024) continue
        const text = contents.toString('utf8')
        for (const forbidden of forbiddenContent) {
          if (forbidden && text.includes(forbidden)) fail(`${entry}: embeds developer-only path ${forbidden}`)
        }
      } catch (error) {
        fail(`could not inspect ${entry}: ${error.message}`)
      }
    }
  }

  for (const file of walkFiles(path.join(resources, 'app.asar.unpacked'))) {
    const relative = path.relative(path.join(resources, 'app.asar.unpacked'), file)
    if (forbiddenPackageEntry(relative)) fail(`forbidden file reached app.asar.unpacked: ${relative}`)
  }

  const packagedChangelog = path.join(resources, 'CHANGELOG.md')
  if (fs.existsSync(packagedChangelog)) {
    const first = parseChangelog(fs.readFileSync(packagedChangelog, 'utf8'))[0]
    if (first?.version !== pkg.version || !first.body.trim()) {
      fail(`packaged What's New entry does not match v${pkg.version}`)
    }
  }
}

let dmgMounted = false
if (fs.existsSync(dmgPath) && process.platform === 'darwin') {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-dmg-'))
  const mountPoint = path.join(tempRoot, 'mount')
  fs.mkdirSync(mountPoint)
  try {
    const attached = capture('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath])
    dmgMounted = attached.ok
    if (attached.ok) {
      if (!fs.existsSync(path.join(mountPoint, `${contract.productName}.app`))) fail('DMG does not contain the app bundle')
      if (!fs.existsSync(path.join(mountPoint, 'Applications'))) fail('DMG does not contain the Applications link')
      if (!fs.existsSync(path.join(mountPoint, 'READ ME FIRST.txt'))) fail('DMG does not contain READ ME FIRST.txt')
    }
  } finally {
    if (dmgMounted) capture('hdiutil', ['detach', mountPoint])
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (failures.length) {
  console.error('Desktop artifact verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

const digest = await sha256(dmgPath)
const size = fs.statSync(dmgPath).size
console.log(`Desktop artifact verified: ${dmgPath}`)
console.log(`  app: ${contract.appId} v${pkg.version} (${contract.architectures.join(', ')})`)
console.log(`  signature: ${signatureKind} (no Developer ID)`)
console.log(`  DMG mounted read-only: ${dmgMounted ? 'yes' : 'no'}`)
console.log(`  bytes: ${size}`)
console.log(`  sha256: ${digest}`)
