/**
 * Registry of B-Roll fetch adapters. Routes go through this so they
 * never reference a specific provider directly — adding NASA later
 * means importing it here, dropping it in the map, and the route +
 * UI pick it up automatically.
 */

import type { FetchAdapter, FetchProvider } from './types.js'
import { pexels } from './pexels.js'
import { pixabay } from './pixabay.js'
import { nasa } from './nasa.js'
import { freesound } from './freesound.js'

export const ADAPTERS: Record<FetchProvider, FetchAdapter> = {
  pexels,
  pixabay,
  nasa,
  freesound,
}

export function getAdapter(provider: FetchProvider): FetchAdapter {
  const a = ADAPTERS[provider]
  if (!a) throw new Error(`Unknown B-Roll fetch provider: ${provider}`)
  return a
}

export type { FetchAdapter, FetchProvider, FetchResult, FetchFile, FetchQuality, SearchOptions, DownloadOptions } from './types.js'
export { pickFile } from './types.js'
