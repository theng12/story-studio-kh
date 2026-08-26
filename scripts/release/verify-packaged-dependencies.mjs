#!/usr/bin/env node
/**
 * verify-packaged-dependencies.mjs — refuse a package whose runtime
 * dependencies are not actually in it.
 *
 * Why this exists (v1.4.69):
 *   v1.4.68 was built from a scratch worktree whose `node_modules` was a
 *   symlink to the main checkout. electron-builder did not follow it, so
 *   `node_modules/**` matched almost nothing and the shipped app.asar carried
 *   72 node_modules entries and zero express. `verify:artifact` passed it —
 *   signature, Info.plist, asar structure and DMG mounting were all correct.
 *   The owner double-clicked it and got:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'
 *       imported from .../app.asar/electron/dist/server/app.js
 *
 *   A structural check is not a launch. This one asserts the thing that
 *   actually broke: that every package the app declares as a runtime
 *   dependency — and everything those packages depend on in turn — is present
 *   inside the package, resolvable the way Node will resolve it at runtime.
 *
 *   It reads the closure from the packaged manifests rather than a list kept
 *   here, so it cannot drift out of date and there is no count to rot.
 *
 * Usage:
 *   node scripts/release/verify-packaged-dependencies.mjs [--app <path.app>]
 *   node scripts/release/verify-packaged-dependencies.mjs --asar <path.asar>
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedDependencyClosure } from './release-utils.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')

function argValue(name) {
  const exact = process.argv.indexOf(name)
  if (exact >= 0) return process.argv[exact + 1]
  const prefix = `${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

/**
 * Build the checker for one packaged app. Exported so verify-desktop-artifact
 * can reuse it without spawning a second process.
 */
export function packagedDependencyFailures(asarPath, unpackedRoot) {
  const failures = []
  const bail = (message) => ({ failures: [message], declared: [], resolvedCount: 0, entryCount: 0 })
  if (!fs.existsSync(asarPath)) return bail(`app.asar is missing: ${asarPath}`)

  const entries = new Set(asar.listPackage(asarPath).map((entry) => entry.replace(/^\/+/, '')))
  const hasEntry = (relative) =>
    entries.has(relative) || (unpackedRoot ? fs.existsSync(path.join(unpackedRoot, relative)) : false)

  const readText = (relative) => {
    if (entries.has(relative)) {
      try {
        return asar.extractFile(asarPath, relative).toString('utf8')
      } catch {
        /* fall through to the unpacked copy */
      }
    }
    const onDisk = unpackedRoot ? path.join(unpackedRoot, relative) : null
    if (onDisk && fs.existsSync(onDisk)) return fs.readFileSync(onDisk, 'utf8')
    return null
  }

  const readManifest = (dir) => {
    const raw = readText(dir ? `${dir}/package.json` : 'package.json')
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (error) {
      failures.push(`${dir}/package.json is not readable JSON: ${error.message}`)
      return null
    }
  }

  const rootManifest = readManifest('')
  if (!rootManifest) return bail(`app.asar package.json is missing or unreadable: ${asarPath}`)

  const declared = Object.keys(rootManifest.dependencies || {})
  if (!declared.length) {
    return bail('app.asar package.json declares no runtime dependencies — the manifest was not packaged correctly')
  }

  const { missing, resolved } = packagedDependencyClosure(rootManifest, hasEntry, readManifest)
  for (const entry of missing) {
    failures.push(
      `runtime dependency '${entry.name}' (required by ${entry.requiredBy}) is not in the package — `
        + 'the app will fail at launch with ERR_MODULE_NOT_FOUND',
    )
  }

  return { failures, declared, resolvedCount: resolved.size, entryCount: entries.size }
}

function run() {
  const appPath = path.resolve(root, argValue('--app') || path.join('dist', 'mac-arm64', 'Story Studio KH.app'))
  const explicitAsar = argValue('--asar')
  const asarPath = explicitAsar
    ? path.resolve(root, explicitAsar)
    : path.join(appPath, 'Contents', 'Resources', 'app.asar')
  const unpackedRoot = `${asarPath}.unpacked`

  const result = packagedDependencyFailures(asarPath, fs.existsSync(unpackedRoot) ? unpackedRoot : null)

  if (result.failures.length) {
    console.error('Packaged runtime dependencies are incomplete:')
    for (const failure of result.failures) console.error(`- ${failure}`)
    console.error(
      `  (app.asar holds ${result.entryCount} entries; ${result.resolvedCount} of the declared closure resolved)`,
    )
    process.exit(1)
  }

  console.log(`Packaged runtime dependencies verified: ${asarPath}`)
  console.log(`  declared: ${result.declared.join(', ')}`)
  console.log(`  dependency closure resolved inside the package: ${result.resolvedCount} packages`)
}

if (import.meta.url === `file://${process.argv[1]}`) run()
