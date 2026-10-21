import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  RenderProvenanceError,
  readStoryRenderProvenanceFromPackageBytes,
  type StoryRenderProvenance,
} from './final-render-provenance-contract.js'

export type { DescriptorPins, QualificationProvenance, StoryRenderProvenance } from './final-render-provenance-contract.js'

export type InstalledStoryRenderProvenance =
  | Readonly<{ status: 'unavailable'; reason: 'development' | 'legacy' }>
  | Readonly<{ status: 'valid'; provenance: StoryRenderProvenance }>

export interface InstalledStoryRenderProvenanceReaderDependencies {
  packagedFacts: () => { isPackaged: boolean; appPath?: string; resourcesPath?: string }
  readBoundedBytes: (file: string, maximumBytes: number) => Promise<Uint8Array>
}

const MAX_PACKAGE_BYTES = 1024 * 1024
const require = createRequire(import.meta.url)

/** Each test closure owns its own immutable cache; it cannot change the production singleton. */
export function _createInstalledStoryRenderProvenanceReaderForTesting(
  dependencies: InstalledStoryRenderProvenanceReaderDependencies,
): () => Promise<InstalledStoryRenderProvenance> {
  let cached: Promise<InstalledStoryRenderProvenance> | undefined
  return () => {
    cached ??= Promise.resolve().then(async (): Promise<InstalledStoryRenderProvenance> => {
      try {
        const facts = dependencies.packagedFacts()
        if (facts.isPackaged !== true) return Object.freeze({ status: 'unavailable', reason: 'development' })
        const { appPath, resourcesPath } = facts
        if (typeof appPath !== 'string' || typeof resourcesPath !== 'string'
            || !path.isAbsolute(appPath) || !path.isAbsolute(resourcesPath)
            || path.normalize(appPath) !== appPath || path.normalize(resourcesPath) !== resourcesPath
            || appPath !== path.join(resourcesPath, 'app.asar')) {
          throw new RenderProvenanceError('packaged ASAR location is invalid')
        }
        const bytes = await dependencies.readBoundedBytes(path.join(appPath, 'package.json'), MAX_PACKAGE_BYTES + 1)
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PACKAGE_BYTES) {
          throw new RenderProvenanceError('package metadata exceeds the read bound')
        }
        const provenance = readStoryRenderProvenanceFromPackageBytes(bytes)
        return provenance === null
          ? Object.freeze({ status: 'unavailable', reason: 'legacy' })
          : Object.freeze({ status: 'valid', provenance })
      } catch (error) {
        if (error instanceof RenderProvenanceError) throw error
        throw new RenderProvenanceError('installed metadata is unreadable', { cause: error })
      }
    })
    return cached
  }
}

const installedReader = _createInstalledStoryRenderProvenanceReaderForTesting({
  packagedFacts: () => {
    let app: { isPackaged?: boolean; getAppPath?: () => string } | undefined
    try { app = require('electron').app as typeof app } catch { /* Plain Node/source execution is unavailable. */ }
    if (app?.isPackaged !== true) return { isPackaged: false }
    return { isPackaged: true, appPath: app.getAppPath?.(), resourcesPath: process.resourcesPath }
  },
  readBoundedBytes: async (file, maximumBytes) => {
    const handle = await fs.open(file, 'r')
    try {
      const bytes = Buffer.alloc(maximumBytes)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      return bytes.subarray(0, length)
    } finally {
      await handle.close()
    }
  },
})

/** Fixed packaged Electron authority only. No path, settings or environment override. */
export function readInstalledStoryRenderProvenance(): Promise<InstalledStoryRenderProvenance> {
  return installedReader()
}
