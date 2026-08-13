import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { emptyContentPackState, ContentPackRuntimeStateSchema, type ContentPackRuntimeState } from './runtime-types.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'

const STATE_MODE = 0o600

export { emptyContentPackState } from './runtime-types.js'

type StateRead =
  | { kind: 'missing' }
  | { kind: 'valid'; state: ContentPackRuntimeState }
  | { kind: 'invalid'; bytes: Uint8Array }

async function readStateFile(statePath: string): Promise<StateRead> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(statePath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'invalid', bytes: new Uint8Array() }
  }
  try {
    return { kind: 'valid', state: ContentPackRuntimeStateSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) }
  } catch {
    return { kind: 'invalid', bytes }
  }
}

function invalidStatePath(paths: ContentPackRuntimePaths, bytes: Uint8Array): string {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return path.join(paths.quarantineRoot, `state-invalid-${hash}.json`)
}

async function resetInvalidState(paths: ContentPackRuntimePaths, bytes: Uint8Array): Promise<ContentPackRuntimeState> {
  assertWriteIsolatedInTests(paths.root, 'content-pack-state')
  await fs.mkdir(paths.quarantineRoot, { recursive: true, mode: 0o700 })
  const quarantined = invalidStatePath(paths, bytes)
  await fs.writeFile(quarantined, bytes, { flag: 'wx', mode: STATE_MODE }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const empty = emptyContentPackState()
  await writeJsonAtomic(paths.statePath, empty, { mode: STATE_MODE })
  return empty
}

async function readOrResetState(paths: ContentPackRuntimePaths): Promise<ContentPackRuntimeState> {
  const result = await readStateFile(paths.statePath)
  if (result.kind === 'valid') return result.state
  if (result.kind === 'missing') return emptyContentPackState()
  return resetInvalidState(paths, result.bytes)
}

/** Read state without creating userData directories unless recovery is required. */
export async function readContentPackState(paths: ContentPackRuntimePaths = getContentPackRuntimePaths()): Promise<ContentPackRuntimeState> {
  const initial = await readStateFile(paths.statePath)
  if (initial.kind === 'valid') return initial.state
  if (initial.kind === 'missing') return emptyContentPackState()
  return withLock(paths.statePath, async () => readOrResetState(paths))
}

/**
 * Serialise all state mutations, validate before persistence, and use the
 * existing crash-safe 0600 JSON writer. The callback may mutate the supplied
 * state in place, but an invalid result is never committed.
 */
export async function mutateContentPackState<T>(
  mutate: (state: ContentPackRuntimeState) => Promise<T> | T,
  paths: ContentPackRuntimePaths = getContentPackRuntimePaths(),
): Promise<T> {
  return withLock(paths.statePath, async () => {
    const state = await readOrResetState(paths)
    const result = await mutate(state)
    const validated = ContentPackRuntimeStateSchema.parse(state)
    assertWriteIsolatedInTests(paths.statePath, 'content-pack-state')
    await writeJsonAtomic(paths.statePath, validated, { mode: STATE_MODE })
    return result
  })
}
