import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export interface StoryStudioVersionResolutionOptions {
  packaged?: boolean
  electronVersion?: string
  /** Test-only source root containing package.json. */
  sourceRoot?: string
  /** Test-only module directory used to exercise source and compiled layouts. */
  moduleDirectory?: string
}

function exactVersion(value: unknown, source: string): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Story Studio package metadata has no exact version: ${source}`)
  }
  return value
}

/** Work in source, compiled Electron, and packaged ASAR without a content-specific path. */
export async function resolveStoryStudioVersion(
  options: StoryStudioVersionResolutionOptions = {},
): Promise<string> {
  let electronApp: { isPackaged?: boolean; getVersion?: () => string } | undefined
  try { electronApp = require('electron').app as typeof electronApp } catch { /* node tests have no Electron app */ }
  const packaged = options.packaged ?? electronApp?.isPackaged === true
  if (packaged) {
    const version = options.electronVersion ?? electronApp?.getVersion?.()
    if (version === undefined) throw new Error('Story Studio packaged app version is unavailable')
    return exactVersion(version, 'Electron app metadata')
  }

  const moduleDirectory = options.moduleDirectory ?? path.dirname(fileURLToPath(import.meta.url))
  const sourceRoots = options.sourceRoot
    ? [path.resolve(options.sourceRoot)]
    : [
        path.resolve(moduleDirectory, '..', '..', '..'),
        path.resolve(moduleDirectory, '..', '..', '..', '..'),
      ]
  let lastError: unknown
  for (const sourceRoot of sourceRoots) {
    const packagePath = path.join(sourceRoot, 'package.json')
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(packagePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Story Studio package metadata is invalid: ${packagePath}`)
      }
      const metadata = parsed as Record<string, unknown>
      if (metadata.name !== 'story-studio-kh') continue
      return exactVersion(metadata.version, packagePath)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Story Studio package metadata is invalid: ${sourceRoots.map(root => path.join(root, 'package.json')).join(' or ')}`, { cause: lastError })
}
