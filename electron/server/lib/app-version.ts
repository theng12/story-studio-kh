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

  const sourceRoot = options.sourceRoot
    ? path.resolve(options.sourceRoot)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const packagePath = path.join(sourceRoot, 'package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(packagePath, 'utf8'))
  } catch (error) {
    throw new Error(`Story Studio package metadata is invalid: ${packagePath}`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Story Studio package metadata is invalid: ${packagePath}`)
  }
  return exactVersion((parsed as Record<string, unknown>).version, packagePath)
}
