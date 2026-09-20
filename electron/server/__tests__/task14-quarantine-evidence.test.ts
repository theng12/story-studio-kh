import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { PathLike } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { emptyContentPackState, readContentPackState } from '../content-packs/state.js'

const INVALID_STATE = '{"schema_version":1,"packs":{},"surprise":true}\n'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function invalidStateFixture(): Promise<{
  paths: ContentPackRuntimePaths
  quarantinePath: string
}> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const hash = createHash('sha256').update(INVALID_STATE).digest('hex')
  const quarantinePath = path.join(paths.quarantineRoot, `state-invalid-${hash}.json`)
  await fs.mkdir(paths.quarantineRoot, { recursive: true, mode: 0o700 })
  await fs.writeFile(paths.statePath, INVALID_STATE, { mode: 0o600 })
  return { paths, quarantinePath }
}

async function captureRecovery(paths: ContentPackRuntimePaths): Promise<unknown> {
  return readContentPackState(paths).then(
    () => undefined,
    error => error,
  )
}

async function assertRecoveryStopped(paths: ContentPackRuntimePaths, outcome: unknown): Promise<void> {
  assert.equal(await fs.readFile(paths.statePath, 'utf8'), INVALID_STATE,
    'the original invalid state must remain authoritative without proven durable quarantine evidence')
  assert.ok(outcome instanceof Error, 'recovery must fail closed')
  await assert.rejects(fs.lstat(paths.recoveryStatePath), { code: 'ENOENT' })
}

async function withInjectedSyncFailure(
  targetPath: string,
  message: string,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  const originalOpen = fs.open
  const normalizedTarget = path.resolve(targetPath)
  fs.open = (async (candidate: PathLike, flags: string | number, mode?: number): Promise<FileHandle> => {
    const handle = await originalOpen(candidate, flags, mode)
    if (typeof candidate !== 'string' || path.resolve(candidate) !== normalizedTarget) return handle
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') return async () => { throw new Error(message) }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }) as typeof fs.open
  try {
    return await operation()
  } finally {
    fs.open = originalOpen
  }
}

test('wrong regular-file quarantine collision preserves the original invalid state', async () => {
  const { paths, quarantinePath } = await invalidStateFixture()
  await fs.writeFile(quarantinePath, 'different bytes\n', { mode: 0o600 })

  await assertRecoveryStopped(paths, await captureRecovery(paths))
  assert.equal(await fs.readFile(quarantinePath, 'utf8'), 'different bytes\n')
})

test('directory quarantine collision preserves the original invalid state', async () => {
  const { paths, quarantinePath } = await invalidStateFixture()
  await fs.mkdir(quarantinePath)

  await assertRecoveryStopped(paths, await captureRecovery(paths))
  assert.equal((await fs.lstat(quarantinePath)).isDirectory(), true)
})

test('symlink quarantine collision preserves the original invalid state even when its target bytes match', async () => {
  const { paths, quarantinePath } = await invalidStateFixture()
  const symlinkTarget = path.join(paths.root, 'outside-quarantine-evidence.json')
  await fs.writeFile(symlinkTarget, INVALID_STATE, { mode: 0o600 })
  await fs.symlink(symlinkTarget, quarantinePath)

  await assertRecoveryStopped(paths, await captureRecovery(paths))
  assert.equal((await fs.lstat(quarantinePath)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(symlinkTarget, 'utf8'), INVALID_STATE)
})

test('identical single-link regular-file quarantine collision is idempotent', async () => {
  const { paths, quarantinePath } = await invalidStateFixture()
  await fs.writeFile(quarantinePath, INVALID_STATE, { mode: 0o600 })

  assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
  assert.equal(await fs.readFile(quarantinePath, 'utf8'), INVALID_STATE)
  assert.deepEqual(JSON.parse(await fs.readFile(paths.statePath, 'utf8')), emptyContentPackState())
  const marker = JSON.parse(await fs.readFile(paths.recoveryStatePath, 'utf8'))
  assert.equal(marker.incident.quarantine_sha256, createHash('sha256').update(INVALID_STATE).digest('hex'))
})

test('quarantine evidence file sync failure stops before marker or state reset', async () => {
  const { paths, quarantinePath } = await invalidStateFixture()
  const outcome = await withInjectedSyncFailure(
    quarantinePath,
    'injected quarantine evidence file sync failure',
    () => captureRecovery(paths),
  )

  await assertRecoveryStopped(paths, outcome)
  assert.match(String((outcome as Error).message), /injected quarantine evidence file sync failure/)
})

test('quarantine directory sync failure stops before marker or state reset', async () => {
  const { paths } = await invalidStateFixture()
  const outcome = await withInjectedSyncFailure(
    paths.quarantineRoot,
    'injected quarantine directory sync failure',
    () => captureRecovery(paths),
  )

  await assertRecoveryStopped(paths, outcome)
  assert.match(String((outcome as Error).message), /injected quarantine directory sync failure/)
})

test('matching existing quarantine evidence must be file-synced before state reset', async () => {
  const { paths, quarantinePath } = await invalidStateFixture()
  await fs.writeFile(quarantinePath, INVALID_STATE, { mode: 0o600 })
  const outcome = await withInjectedSyncFailure(
    quarantinePath,
    'injected existing quarantine evidence file sync failure',
    () => captureRecovery(paths),
  )

  await assertRecoveryStopped(paths, outcome)
  assert.match(String((outcome as Error).message), /injected existing quarantine evidence file sync failure/)
})
