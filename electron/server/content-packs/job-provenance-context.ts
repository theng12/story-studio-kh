import { AsyncLocalStorage } from 'node:async_hooks'

import type { ContentPackProvenance } from './runtime-types.js'

const storage = new AsyncLocalStorage<readonly ContentPackProvenance[]>()

export function runWithJobContentPackProvenance<T>(
  provenance: readonly ContentPackProvenance[] | undefined,
  work: () => T,
): T {
  return storage.run(provenance ?? [], work)
}

export function currentJobContentPackProvenance(): readonly ContentPackProvenance[] | undefined {
  return storage.getStore()
}
