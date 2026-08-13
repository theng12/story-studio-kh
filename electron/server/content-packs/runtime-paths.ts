import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getUserDataDir } from '../services/project-manager.js'
import type { ContentPackManifest } from './types.js'

export interface ContentPackRuntimePaths {
  root: string
  statePath: string
  stagingRoot: string
  installedRoot: string
  quarantineRoot: string
  /** Bundled, read-only recovery archives; this is deliberately outside userData. */
  recoveryRoot: string
}

const SAFE_SEGMENT = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const SAFE_VERIFIED_FILE_PATH = /^(?:content|assets)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/
const require = createRequire(import.meta.url)

function assertContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('content pack path must be contained by its root')
  }
  return resolvedCandidate
}

function assertSafeSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment) || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
    throw new Error('content pack path must be contained by its root')
  }
}

/**
 * Compiled development runs from `electron/dist/...`, while source runs from
 * `electron/server/...`. Walk to the repository marker instead of assuming
 * either layout; packaged Electron never calls this path.
 */
export function findContentPackSourceRoot(importerDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let cursor = path.resolve(importerDir)
  for (let depth = 0; depth < 12; depth += 1) {
    const sourceRoot = path.join(cursor, 'electron', 'server', 'content-packs')
    if (fs.existsSync(path.join(cursor, 'package.json')) && fs.existsSync(sourceRoot)) return sourceRoot
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(`unable to locate Story Studio Content Pack source root from ${importerDir}`)
}

function isPackagedApp(): boolean {
  if (!process.resourcesPath || process.env.ELECTRON_RUN_AS_NODE) return false
  try {
    const { app } = require('electron')
    return app?.isPackaged === true
  } catch {
    return false
  }
}

export interface ContentPackResourceRootOptions {
  packaged?: boolean
  resourcesPath?: string
  sourceContentPackRoot?: string
}

/** Kept injectable so dev Electron can never accidentally select a stale resource bundle. */
export function resolveContentPackRecoveryRoot(options: ContentPackResourceRootOptions = {}): string {
  const packaged = options.packaged ?? isPackagedApp()
  const sourceContentPackRoot = options.sourceContentPackRoot ?? findContentPackSourceRoot()
  if (!packaged) return path.join(sourceContentPackRoot, 'recovery')
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath) throw new Error('packaged Content Pack recovery resources are unavailable')
  return path.join(resourcesPath, 'content-packs', 'recovery')
}

/** Resolve only. Creating the runtime layout is an explicit write operation. */
export function getContentPackRuntimePaths(): ContentPackRuntimePaths {
  const root = path.join(getUserDataDir(), 'content-packs')
  const recoveryRoot = resolveContentPackRecoveryRoot()
  return {
    root,
    statePath: path.join(root, 'state.json'),
    stagingRoot: path.join(root, '.staging'),
    installedRoot: path.join(root, 'installed'),
    quarantineRoot: path.join(root, 'quarantine'),
    recoveryRoot,
  }
}

export function installedVersionPath(paths: ContentPackRuntimePaths, manifest: ContentPackManifest): string {
  assertSafeSegment(manifest.publisher_id)
  assertSafeSegment(manifest.pack_id)
  assertSafeSegment(manifest.version)
  return assertContained(paths.installedRoot, path.join(paths.installedRoot, manifest.publisher_id, manifest.pack_id, manifest.version))
}

/** Resolve only a manifest-declared forward-slash file path inside a verified version root. */
export function resolveVerifiedPackFile(versionRoot: string, relativePath: string): string {
  if (!SAFE_VERIFIED_FILE_PATH.test(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new Error('content pack path must be contained by its root')
  }
  const segments = relativePath.split('/')
  const candidate = assertContained(versionRoot, path.join(versionRoot, ...segments))
  let cursor = path.resolve(versionRoot)
  for (const segment of segments) {
    assertNoSymlink(cursor)
    cursor = path.join(cursor, segment)
  }
  assertNoSymlink(cursor)
  return candidate
}

/** Existing pack trees must be immutable regular directories/files; symlinks are never trusted. */
function assertNoSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('content pack path contains a symlink')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
