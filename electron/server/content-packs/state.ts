import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { emptyContentPackState, ContentPackRuntimeStateSchema, type ContentPackRuntimeState } from './runtime-types.js'
import { getContentPackRuntimePaths, installedVersionPath, type ContentPackRuntimePaths } from './runtime-paths.js'

const STATE_MODE = 0o600
const LOCK_WAIT_MS = 10_000
const STALE_LOCK_MS = 60_000
const execFile = promisify(execFileCallback)

export { emptyContentPackState } from './runtime-types.js'

/**
 * State locks live below userData, so prove that root and the state parent are
 * ordinary directories before creating a lock file. This is intentionally
 * shared by every state transaction rather than left to individual callers.
 */
export async function prepareContentPackRuntimeRoot(paths: ContentPackRuntimePaths): Promise<void> {
  assertWriteIsolatedInTests(paths.root, 'content-pack-state')
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 })
  const root = await fs.lstat(paths.root)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Content Pack runtime root is unsafe: ${paths.root}`)
  const stateParent = path.dirname(paths.statePath)
  if (path.resolve(stateParent) !== path.resolve(paths.root)) throw new Error('Content Pack state path must live directly below its runtime root')
  const parent = await fs.lstat(stateParent)
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`Content Pack state parent is unsafe: ${stateParent}`)
}

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
  await prepareContentPackRuntimeRoot(paths)
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
  return withContentPackStateTransaction(mutate, paths)
}

/**
 * Run a complete Content Pack transaction under the same cross-process lock
 * that protects state. Callers may stage immutable files before mutating the
 * supplied state; if they throw, no state document is written.
 */
export async function withContentPackStateTransaction<T>(
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
  hostname: string
  process_incarnation: string
}

interface StateLockIdentity {
  hostname: string
  pid: number
  process_incarnation: string
}

export interface ContentPackStateLockRuntime {
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  current: () => Promise<StateLockIdentity>
  processIncarnation: (pid: number) => Promise<string | null>
}

export interface ContentPackStateLockTestOptions {
  lockWaitMs?: number
  staleLockMs?: number
  runtime?: Partial<ContentPackStateLockRuntime>
  hooks?: {
    afterRecoveryGuardAcquired?: () => Promise<void>
  }
}

export interface ContentPackStateLockHandle {
  owner: StateLockOwner
  release: () => Promise<void>
}

function stateLockPath(statePath: string): string {
  return `${statePath}.lock`
}

function recoveryGuardPath(lockPath: string): string {
  return `${lockPath}.recovery`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function processIncarnation(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      const startTime = afterCommand[19]
      if (!startTime) throw new Error('missing /proc start time')
      return `linux:${startTime}`
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFile('ps', ['-o', 'lstart=', '-p', String(pid)])
      const value = stdout.trim()
      return value || null
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`])
      const value = stdout.trim()
      return value || null
    }
    throw new Error(`process incarnation is unsupported on ${process.platform}`)
  } catch (error: unknown) {
    // An unavailable `/proc`, `ps`, or PowerShell is not evidence that a PID is
    // dead. Probe the OS separately: only ESRCH permits stale-lock recovery.
    try {
      process.kill(pid, 0)
    } catch (probeError: unknown) {
      if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return null
      throw new Error(`unable to inspect process incarnation for PID ${pid}`, { cause: error })
    }
    throw new Error(`unable to inspect process incarnation for PID ${pid}`, { cause: error })
  }
}

async function currentStateLockIdentity(): Promise<StateLockIdentity> {
  const incarnation = await processIncarnation(process.pid)
  if (!incarnation) throw new Error('unable to determine current process incarnation for Content Pack state lock')
  return { hostname: os.hostname(), pid: process.pid, process_incarnation: incarnation }
}

function defaultStateLockRuntime(): ContentPackStateLockRuntime {
  return { now: Date.now, sleep, current: currentStateLockIdentity, processIncarnation }
}

function parseStateLockOwner(raw: string): StateLockOwner {
  try {
    const parsed = JSON.parse(raw) as Partial<StateLockOwner>
    if (!Number.isInteger(parsed.pid) || !Number.isFinite(parsed.created_at_ms) || typeof parsed.token !== 'string' || !parsed.token
      || typeof parsed.hostname !== 'string' || !parsed.hostname || typeof parsed.process_incarnation !== 'string' || !parsed.process_incarnation) {
      throw new Error('invalid fields')
    }
    return parsed as StateLockOwner
  } catch (error) {
    throw new Error('Content Pack state lock record is corrupt; manual recovery is required', { cause: error })
  }
}

async function readStateLockOwner(lockPath: string): Promise<StateLockOwner | null> {
  try {
    return parseStateLockOwner(await fs.readFile(lockPath, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((error as Error).message.startsWith('Content Pack state lock record is corrupt')) throw error
    throw error
  }
}

async function fsyncParent(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function publishStateLock(lockPath: string, owner: StateLockOwner): Promise<boolean> {
  const directory = path.dirname(lockPath)
  const temporary = path.join(directory, `.${path.basename(lockPath)}.${owner.token}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', STATE_MODE)
    await handle.writeFile(`${JSON.stringify(owner)}\n`)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  try {
    await fs.link(temporary, lockPath)
    await fsyncParent(directory).catch(() => {})
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

async function releaseStateLock(lockPath: string, owner: StateLockOwner): Promise<void> {
  const canonical = await readStateLockOwner(lockPath)
  // If another actor has replaced the canonical path, never delete it.
  if (!canonical || canonical.token !== owner.token || canonical.hostname !== owner.hostname || canonical.process_incarnation !== owner.process_incarnation) return
  await fs.unlink(lockPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

async function acquireRecoveryGuard(
  lockPath: string,
  current: StateLockIdentity,
  runtime: ContentPackStateLockRuntime,
  deadline: number,
): Promise<ContentPackStateLockHandle> {
  const guardPath = recoveryGuardPath(lockPath)
  const owner: StateLockOwner = { ...current, created_at_ms: runtime.now(), token: randomUUID() }
  while (true) {
    if (await publishStateLock(guardPath, owner)) {
      return { owner, release: () => releaseStateLock(guardPath, owner) }
    }
    const existing = await readStateLockOwner(guardPath)
    if (!existing) continue
    if (existing.hostname !== current.hostname) {
      throw new Error(`Content Pack state recovery guard belongs to foreign host ${existing.hostname}; manual recovery is required`)
    }
    // Recovery guards are never age-stolen: a crash or malformed record is a
    // manual-recovery condition, not authority to touch the canonical lock.
    if (runtime.now() >= deadline) throw new Error('timed out waiting for Content Pack state recovery guard')
    await runtime.sleep(10 + Math.floor(Math.random() * 20))
  }
}

async function isProvenStaleOwner(
  owner: StateLockOwner,
  current: StateLockIdentity,
  runtime: ContentPackStateLockRuntime,
  staleLockMs: number,
): Promise<boolean> {
  if (owner.hostname !== current.hostname) {
    throw new Error(`Content Pack state lock belongs to foreign host ${owner.hostname}; manual recovery is required`)
  }
  if (runtime.now() - owner.created_at_ms < staleLockMs) return false
  const observedIncarnation = await runtime.processIncarnation(owner.pid)
  return observedIncarnation !== owner.process_incarnation
}

async function reclaimStateLockIfProvenStale(
  lockPath: string,
  current: StateLockIdentity,
  runtime: ContentPackStateLockRuntime,
  staleLockMs: number,
  deadline: number,
  hooks?: ContentPackStateLockTestOptions['hooks'],
): Promise<boolean> {
  const observed = await readStateLockOwner(lockPath)
  if (!observed) return true
  if (!await isProvenStaleOwner(observed, current, runtime, staleLockMs)) return false
  const guard = await acquireRecoveryGuard(lockPath, current, runtime, deadline)
  try {
    await hooks?.afterRecoveryGuardAcquired?.()
    // A separate contender may have recovered or published after the initial
    // observation. Re-check both identity and stale proof while we own the
    // non-stealable recovery guard before unlinking anything.
    const currentCanonical = await readStateLockOwner(lockPath)
    if (!currentCanonical) return true
    if (currentCanonical.token !== observed.token
      || currentCanonical.hostname !== observed.hostname
      || currentCanonical.process_incarnation !== observed.process_incarnation) return false
    if (!await isProvenStaleOwner(currentCanonical, current, runtime, staleLockMs)) return false
    await fs.unlink(lockPath)
    return true
  } finally {
    await guard.release()
  }
}

async function acquireFilesystemStateLock(
  paths: ContentPackRuntimePaths,
  options: ContentPackStateLockTestOptions = {},
): Promise<ContentPackStateLockHandle> {
  const lockPath = stateLockPath(paths.statePath)
  const defaultRuntime = defaultStateLockRuntime()
  const runtime: ContentPackStateLockRuntime = { ...defaultRuntime, ...options.runtime }
  const identity = await runtime.current()
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS
  const deadline = runtime.now() + lockWaitMs
  const owner: StateLockOwner = {
    ...identity,
    created_at_ms: runtime.now(),
    token: randomUUID(),
  }
  await prepareContentPackRuntimeRoot(paths)
  if (path.resolve(path.dirname(lockPath)) !== path.resolve(paths.root)) throw new Error('Content Pack state lock must live directly below its runtime root')
  while (true) {
    if (await publishStateLock(lockPath, owner)) break
    if (await reclaimStateLockIfProvenStale(lockPath, identity, runtime, staleLockMs, deadline, options.hooks)) continue
    if (runtime.now() >= deadline) throw new Error('timed out waiting for Content Pack state lock')
    await runtime.sleep(10 + Math.floor(Math.random() * 20))
  }
  return {
    owner,
    release: () => releaseStateLock(lockPath, owner),
  }
}

/** Test-only seam for adversarial lock protocol tests; renderer code never imports this module. */
export function __testAcquireContentPackStateLock(
  paths: ContentPackRuntimePaths,
  options?: ContentPackStateLockTestOptions,
): Promise<ContentPackStateLockHandle> {
  return acquireFilesystemStateLock(paths, options)
}

async function withFilesystemStateLock<T>(paths: ContentPackRuntimePaths, work: () => Promise<T>): Promise<T> {
  const lock = await acquireFilesystemStateLock(paths)
  try {
    return await work()
  } finally {
    await lock.release()
  }
}

function withContentPackStateLock<T>(paths: ContentPackRuntimePaths, work: () => Promise<T>): Promise<T> {
  return withLock(paths.statePath, () => withFilesystemStateLock(paths, work))
}
