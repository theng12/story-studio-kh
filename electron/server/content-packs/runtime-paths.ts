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

function projectContentPackRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'content-packs')
}

/** Resolve only. Creating the runtime layout is an explicit write operation. */
export function getContentPackRuntimePaths(): ContentPackRuntimePaths {
  const root = path.join(getUserDataDir(), 'content-packs')
  const recoveryRoot = process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE
    ? path.join(process.resourcesPath, 'content-packs')
    : projectContentPackRoot()
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
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.endsWith('/')) {
    throw new Error('content pack path must be contained by its root')
  }
  const segments = relativePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('content pack path must be contained by its root')
  }
  return assertContained(versionRoot, path.join(versionRoot, ...segments))
}
