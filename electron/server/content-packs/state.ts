import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { emptyContentPackState, ContentPackRuntimeStateSchema, type ContentPackRuntimeState } from './runtime-types.js'
import { getContentPackRuntimePaths, installedVersionPath, type ContentPackRuntimePaths } from './runtime-paths.js'

const STATE_MODE = 0o600
const LOCK_MODE = 0o700
const LOCK_WAIT_MS = 10_000
const STALE_LOCK_MS = 60_000

export { emptyContentPackState } from './runtime-types.js'

type StateRead =
  | { kind: 'missing' }
  | { kind: 'valid'; state: ContentPackRuntimeState }
  | { kind: 'invalid'; bytes: Uint8Array }
  | { kind: 'io-error'; error: unknown }

async function readStateFile(paths: ContentPackRuntimePaths): Promise<StateRead> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(paths.statePath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'io-error', error }
  }
  try {
    return { kind: 'valid', state: validateStateForPaths(ContentPackRuntimeStateSchema.parse(JSON.parse(new TextDecoder().decode(bytes))), paths) }
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
  const result = await readStateFile(paths)
  if (result.kind === 'valid') return result.state
  if (result.kind === 'missing') return emptyContentPackState()
  if (result.kind === 'io-error') throw result.error
  return resetInvalidState(paths, result.bytes)
}

/** Read state without creating userData directories unless recovery is required. */
export async function readContentPackState(paths: ContentPackRuntimePaths = getContentPackRuntimePaths()): Promise<ContentPackRuntimeState> {
  const initial = await readStateFile(paths)
  if (initial.kind === 'valid') return initial.state
  if (initial.kind === 'missing') return emptyContentPackState()
  if (initial.kind === 'io-error') throw initial.error
  return withContentPackStateLock(paths, async () => readOrResetState(paths))
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
  return withContentPackStateLock(paths, async () => {
    const state = await readOrResetState(paths)
    const result = await mutate(state)
    const validated = validateStateForPaths(ContentPackRuntimeStateSchema.parse(state), paths)
    assertWriteIsolatedInTests(paths.statePath, 'content-pack-state')
    await writeJsonAtomic(paths.statePath, validated, { mode: STATE_MODE })
    return result
  })
}

function validateStateForPaths(state: ContentPackRuntimeState, paths: ContentPackRuntimePaths): ContentPackRuntimeState {
  for (const [packId, pack] of Object.entries(state.packs)) {
    if (pack.active_version && !pack.versions[pack.active_version]) {
      throw new Error(`Content Pack state active version is not installed: ${packId}@${pack.active_version}`)
    }
    for (const [version, installed] of Object.entries(pack.versions)) {
      if (installed.manifest.pack_id !== packId || installed.manifest.version !== version) {
        throw new Error(`Content Pack state identity does not match manifest: ${packId}@${version}`)
      }
      const expectedPath = installedVersionPath(paths, installed.manifest)
      if (installed.install_path !== expectedPath) {
        throw new Error(`Content Pack state install path does not match manifest: ${packId}@${version}`)
      }
    }
  }
  return state
}

interface StateLockOwner {
  pid: number
  created_at_ms: number
  token: string
}

function stateLockPath(statePath: string): string {
  return `${statePath}.lock`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function reclaimStaleStateLock(lockPath: string): Promise<boolean> {
  let owner: StateLockOwner | undefined
  let ageMs: number
  try {
    const [ownerText, stat] = await Promise.all([
      fs.readFile(path.join(lockPath, 'owner.json'), 'utf8').catch(() => ''),
      fs.stat(lockPath),
    ])
    try {
      const parsed = JSON.parse(ownerText) as Partial<StateLockOwner>
      if (typeof parsed.pid === 'number' && typeof parsed.created_at_ms === 'number' && typeof parsed.token === 'string') {
        owner = parsed as StateLockOwner
      }
    } catch {
      // A half-written owner record is only reclaimable after the directory itself is stale.
    }
    ageMs = Date.now() - (owner?.created_at_ms ?? stat.mtimeMs)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
  if (ageMs < STALE_LOCK_MS || (owner && isProcessAlive(owner.pid))) return false
  const tombstone = `${lockPath}.stale-${randomUUID()}`
  try {
    await fs.rename(lockPath, tombstone)
    await fs.rm(tombstone, { recursive: true, force: true })
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

async function withFilesystemStateLock<T>(paths: ContentPackRuntimePaths, work: () => Promise<T>): Promise<T> {
  const lockPath = stateLockPath(paths.statePath)
  const deadline = Date.now() + LOCK_WAIT_MS
  const owner: StateLockOwner = { pid: process.pid, created_at_ms: Date.now(), token: randomUUID() }
  assertWriteIsolatedInTests(paths.root, 'content-pack-state')
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: LOCK_MODE })
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: LOCK_MODE })
      try {
        await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: STATE_MODE })
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await reclaimStaleStateLock(lockPath)) continue
      if (Date.now() >= deadline) throw new Error('timed out waiting for Content Pack state lock')
      await sleep(10 + Math.floor(Math.random() * 20))
    }
  }
  try {
    return await work()
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
  }
}

function withContentPackStateLock<T>(paths: ContentPackRuntimePaths, work: () => Promise<T>): Promise<T> {
  return withLock(paths.statePath, () => withFilesystemStateLock(paths, work))
}
