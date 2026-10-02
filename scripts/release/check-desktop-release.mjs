#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  localStartupPath,
  contentStoreAssetErrors,
  remoteStartupReferences,
  startupReferences,
  validateServiceBaseUrl,
  walkFiles,
} from './release-utils.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const built = process.argv.includes('--built')
const packageInput = process.argv.includes('--package-input')
const failures = []

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const json = (relative) => JSON.parse(read(relative))
const fail = (message) => failures.push(message)

const contract = json('release/desktop-release-contract.json')
const pkg = json('package.json')
const builder = json('electron-builder.json')

if (contract.schemaVersion !== 1) fail('release contract: unsupported schemaVersion')
if (pkg.productName !== contract.productName) fail('package.json: productName changed from the upgrade-stable release contract')
if (pkg.main !== contract.main) fail(`package.json: main must remain ${contract.main}`)
if (builder.appId !== contract.appId) fail('electron-builder.json: appId changed; that breaks upgrade identity')
if (builder.productName !== contract.productName) fail('electron-builder.json: productName changed; that moves macOS userData')
if (builder.directories?.output !== 'dist') fail('electron-builder.json: release output must remain dist')

const target = builder.mac?.target
const targetName = typeof target === 'string' ? target : target?.target
const targetArch = typeof target === 'object' && Array.isArray(target.arch) ? target.arch : []
if (targetName !== 'dmg') fail('electron-builder.json: mac target must be dmg')
if (JSON.stringify(targetArch) !== JSON.stringify(contract.architectures)) {
  fail(`electron-builder.json: expected architectures ${contract.architectures.join(', ')}`)
}
if (builder.mac?.artifactName !== contract.artifactName) fail('electron-builder.json: mac artifactName differs from contract')
if (builder.dmg?.artifactName !== contract.artifactName) fail('electron-builder.json: DMG artifactName differs from contract')

const packageFiles = Array.isArray(builder.files) ? builder.files : []
for (const exclusion of contract.requiredPackageExclusions) {
  if (!packageFiles.includes(exclusion)) fail(`electron-builder.json: missing package exclusion ${exclusion}`)
}

const mappings = (builder.extraResources || []).map(({ from, to }) => `${from}\u0000${to}`)
for (const mapping of contract.requiredResourceMappings) {
  if (!mappings.includes(`${mapping.from}\u0000${mapping.to}`)) {
    fail(`electron-builder.json: missing resource mapping ${mapping.from} -> ${mapping.to}`)
  }
}

// A packaged app starts Electron's embedded main process. It must not rely on
// start.sh, npm, npx, Pinokio, or a developer shell being present.
if (!packageFiles.includes('electron/dist/**/*')) fail('electron-builder.json: compiled Electron output is not packaged')
if (!packageFiles.includes('frontend/.output/public/**/*')) fail('electron-builder.json: generated frontend is not packaged')
if (packageFiles.some((entry) => /(?:^|\/)start\.sh$/.test(entry))) fail('electron-builder.json: start.sh must not be a runtime dependency')

const settingsSource = read('electron/server/services/app-settings.ts')
const defaultUrlMatch = settingsSource.match(/export const DEFAULT_GENSTUDIO_URL\s*=\s*['"`]([^'"`]+)['"`]/)
if (!defaultUrlMatch) {
  fail('GenStudio config: DEFAULT_GENSTUDIO_URL is not statically auditable')
} else {
  const defaultUrl = defaultUrlMatch[1]
  const urlProblem = validateServiceBaseUrl(defaultUrl, contract.genStudio)
  if (urlProblem) fail(`GenStudio config: default base URL ${urlProblem}`)
  for (const fragment of contract.genStudio.forbiddenUrlFragments) {
    if (defaultUrl.toLowerCase().includes(fragment.toLowerCase())) {
      fail(`GenStudio config: default base URL contains forbidden developer fragment ${fragment}`)
    }
  }
}
if (!new RegExp(`GENSTUDIO_URL_KEY\\s*=\\s*['\"]${contract.genStudio.settingKey}['\"]`).test(settingsSource)) {
  fail(`GenStudio config: expected per-machine setting key ${contract.genStudio.settingKey}`)
}
if (!/getGenStudioUrl[\s\S]{0,800}getAppSetting\(GENSTUDIO_URL_KEY\)/.test(settingsSource)) {
  fail('GenStudio config: the per-machine URL override is not read before using the default')
}

function checkBuiltOutputs() {
  const electronRoot = path.join(root, 'electron', 'dist')
  const publicRoot = path.join(root, 'frontend', '.output', 'public')
  const mainPath = path.join(root, contract.main)
  const indexPath = path.join(publicRoot, 'index.html')

  if (!fs.existsSync(mainPath)) fail(`${contract.main}: compiled startup entry is missing`)
  if (!fs.existsSync(indexPath)) fail('frontend/.output/public/index.html: offline startup document is missing')

  const electronFiles = walkFiles(electronRoot)
  const publicFiles = walkFiles(publicRoot)
  const contentStoreErrors = contentStoreAssetErrors(
    publicFiles.map(file => path.relative(root, file).replace(/\\/g, '/')),
    entry => fs.readFileSync(path.join(root, entry), 'utf8'),
  )
  for (const error of contentStoreErrors) fail(`frontend Content Store: ${error}`)
  for (const file of electronFiles) {
    const relative = path.relative(root, file).replace(/\\/g, '/')
    if (/(?:^|\/)(?:__tests__|tests|test)(?:\/|$)/.test(relative) || /\.test\.js$/.test(relative)) {
      fail(`${relative}: test code reached the production compilation output`)
    }
    if (file.endsWith('.map')) fail(`${relative}: source map reached the production compilation output`)
  }

  if (fs.existsSync(indexPath)) {
    const index = fs.readFileSync(indexPath, 'utf8')
    for (const reference of remoteStartupReferences(index)) {
      fail(`frontend index: remote startup dependency ${reference}`)
    }
    for (const reference of new Set(startupReferences(index))) {
      const localPath = localStartupPath(publicRoot, reference)
      if (localPath && !fs.existsSync(localPath)) fail(`frontend index: missing local startup asset ${reference}`)
    }
    if (!index.includes(`appVersion:"${pkg.version}"`) && !index.includes(`"appVersion":"${pkg.version}"`)) {
      fail(`frontend index: runtime What's New version is not v${pkg.version}`)
    }
  }

  for (const css of walkFiles(publicRoot).filter((file) => file.endsWith('.css'))) {
    const source = fs.readFileSync(css, 'utf8')
    if (/@import\s+(?:url\()?\s*['"]?(?:https?:)?\/\//i.test(source) || /url\(\s*['"]?(?:https?:)?\/\//i.test(source)) {
      fail(`${path.relative(root, css)}: CSS needs a network resource at startup`)
    }
  }

  const machinePaths = [root, path.join(os.homedir(), 'pinokio'), path.join(os.homedir(), '.pinokio')]
  const textExt = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.txt', '.xml', '.yml', '.yaml'])
  for (const file of [...electronFiles, ...walkFiles(publicRoot)]) {
    if (!textExt.has(path.extname(file).toLowerCase()) || fs.statSync(file).size > 20 * 1024 * 1024) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const machinePath of machinePaths) {
      if (machinePath && source.includes(machinePath)) {
        fail(`${path.relative(root, file)}: embeds developer-only path ${machinePath}`)
      }
    }
  }
}

function checkPackageInputs() {
  for (const relative of ['bundled/ffmpeg/ffmpeg', 'bundled/ffmpeg/ffprobe', 'bundled/ffmpeg/MANIFEST.json']) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) fail(`${relative}: required offline FFmpeg input is missing`)
  }
  // The native scene-clip helper (built by `npm run build:scene-clip`). The app falls back to FFmpeg without
  // it, so this is about not shipping the slow path by accident.
  for (const relative of ['bundled/scene-clip/scene-clip', 'bundled/scene-clip/MANIFEST.json']) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) fail(`${relative}: native scene-clip helper is missing (run npm run build:scene-clip)`)
  }
  for (const relative of ['bundled/ffmpeg/ffmpeg', 'bundled/ffmpeg/ffprobe', 'bundled/scene-clip/scene-clip']) {
    const file = path.join(root, relative)
    if (fs.existsSync(file) && (fs.statSync(file).mode & 0o111) === 0) fail(`${relative}: binary is not executable`)
  }
}

if (built) checkBuiltOutputs()
if (packageInput) checkPackageInputs()

if (failures.length) {
  console.error('Desktop release check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

const scopes = ['source contract', built && 'built startup', packageInput && 'package inputs'].filter(Boolean)
console.log(`Desktop release check passed (${scopes.join(', ')}).`)
