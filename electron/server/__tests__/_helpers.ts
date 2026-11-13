/**
 * Shared test helpers. Provides isolated temp dirs and an API fixture.
 */

import { constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The backend runner preloads this via NODE_OPTIONS; anything else that drives Story's routes
// with supertest (a single `node --test` file, the Gateway's Story content-delivery round trip)
// only imports this helper, and without it a local daemon on 127.0.0.1 could answer instead
// (seen 2026-10-03: "Story series-formula install refusal: HTTP 404 no-code"). Idempotent.
import '../../../scripts/testing/loopback-supertest.mjs'


type LegacyTempDataDir = { dir: string; cleanup: () => Promise<void> }
type RetainedRegistrationKind = 'work-dir' | 'snapshot'
type RetainedManifestKind = 'data' | 'tmp' | RetainedRegistrationKind
type RetainedEntry = {
  path: string
  type: 'directory' | 'file'
  size?: number
  sha256?: string
}

export type RetainedInventory = {
  root: string
  entries: RetainedEntry[]
}

export type RetainedTempDataDir = LegacyTempDataDir & {
  runRoot: string
  register: (target: string, kind: RetainedRegistrationKind) => Promise<void>
  preserveBeforeDestructive: (target: string, label: string) => Promise<{
    snapshot: string
    snapshotIdentity: Identity
    sourceInventory: RetainedInventory
    snapshotInventory: RetainedInventory
  }>
}

export type RetainedTempOptions = {
  retain: true
  settle: () => Promise<void>
}

type Registration = { target: string; kind: RetainedManifestKind }
type SnapshotRecord = {
  source: string
  snapshot: string
  status: 'verified' | 'failed'
  sourceInventory?: RetainedInventory
  snapshotInventory?: RetainedInventory
  snapshotIdentity?: Identity
  error?: string
}
type Identity = { dev: number; ino: number }
type ActiveRetainedClaim = { runRoot?: string; bindingEstablished: boolean }

const RETAINED_ENV_KEYS = ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const
let activeRetainedClaim: ActiveRetainedClaim | undefined

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function relativeToRun(runRoot: string, target: string): string {
  if (!isWithin(runRoot, target)) throw new Error('Path is outside retained run root')
  const relative = path.relative(runRoot, target)
  return relative === '' ? '.' : relative.split(path.sep).join('/')
}

function sameIdentity(stat: { dev: number; ino: number }, expected: Identity): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino
}

async function assertDirectoryIdentity(
  target: string,
  expected: Identity,
  label: string,
  containingRoot?: string,
): Promise<void> {
  const before = await fs.lstat(target)
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, expected)) {
    throw new Error(`${label} identity changed while retained fixture was active`)
  }
  const canonical = await fs.realpath(target)
  const after = await fs.lstat(target)
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, expected)) {
    throw new Error(`${label} identity changed while retained fixture was active`)
  }
  if (canonical !== target || (containingRoot && !isWithin(containingRoot, canonical))) {
    throw new Error(`${label} escaped its retained owner`)
  }
}

async function trustedHarnessRoot(): Promise<{ root: string; identity: Identity }> {
  const configured = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  if (!configured) throw new Error('Retained fixtures require STORY_STUDIO_TEST_HARNESS_ROOT')
  const configuredStat = await fs.lstat(configured)
  if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
    throw new Error('STORY_STUDIO_TEST_HARNESS_ROOT must name a real directory leaf')
  }
  if ((configuredStat.mode & 0o077) !== 0) {
    throw new Error('STORY_STUDIO_TEST_HARNESS_ROOT must be private to the current user')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && configuredStat.uid !== uid) {
    throw new Error('STORY_STUDIO_TEST_HARNESS_ROOT must be owned by the current user')
  }
  const root = await fs.realpath(configured)
  const stat = await fs.lstat(root)
  return { root, identity: { dev: stat.dev, ino: stat.ino } }
}

async function inventoryTree(
  runRoot: string,
  target: string,
  runDevice: number,
  expectedRoot?: Identity,
): Promise<RetainedInventory> {
  const leaf = await fs.lstat(target)
  if (leaf.isSymbolicLink()) throw new Error('Retained inventory refuses a symbolic link')
  if (expectedRoot && !sameIdentity(leaf, expectedRoot)) {
    throw new Error('Retained inventory root identity changed')
  }
  const canonical = await fs.realpath(target)
  if (!isWithin(runRoot, canonical) || canonical !== target) throw new Error('Path is outside retained run root')

  const entries: RetainedEntry[] = []
  async function visit(absolute: string, relative: string): Promise<void> {
    const before = await fs.lstat(absolute)
    if (before.dev !== runDevice) throw new Error(`Retained inventory refuses a device escape at ${relative || '.'}`)
    if (before.isSymbolicLink()) throw new Error(`Retained inventory refuses a symbolic link at ${relative || '.'}`)
    const canonicalEntry = await fs.realpath(absolute)
    const confirmed = await fs.lstat(absolute)
    if (canonicalEntry !== absolute || !isWithin(runRoot, canonicalEntry) || !sameIdentity(confirmed, before)) {
      throw new Error(`Retained inventory path changed at ${relative || '.'}`)
    }
    if (before.isDirectory()) {
      entries.push({ path: relative || '.', type: 'directory' })
      const children = await fs.readdir(absolute)
      children.sort((a, b) => a.localeCompare(b))
      for (const child of children) await visit(path.join(absolute, child), relative ? `${relative}/${child}` : child)
      const childrenAfter = await fs.readdir(absolute)
      childrenAfter.sort((a, b) => a.localeCompare(b))
      const after = await fs.lstat(absolute)
      if (!sameIdentity(after, before) || JSON.stringify(childrenAfter) !== JSON.stringify(children)) {
        throw new Error(`Retained directory changed while reading ${relative || '.'}`)
      }
      return
    }
    if (!before.isFile()) throw new Error(`Retained inventory refuses a special file at ${relative || '.'}`)
    if (before.nlink !== 1) throw new Error(`Retained inventory refuses a hard link at ${relative || '.'}`)
    const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, before)) {
        throw new Error(`Retained source changed while opening ${relative || '.'}`)
      }
      bytes = await handle.readFile()
      const afterRead = await handle.stat()
      if (
        !sameIdentity(afterRead, opened)
        || afterRead.size !== opened.size
        || afterRead.mtimeMs !== opened.mtimeMs
        || afterRead.ctimeMs !== opened.ctimeMs
      ) {
        throw new Error(`Retained source changed while reading ${relative || '.'}`)
      }
    } finally {
      await handle.close()
    }
    const after = await fs.lstat(absolute)
    if (!after.isFile() || !sameIdentity(after, before) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Retained source changed after reading ${relative || '.'}`)
    }
    entries.push({
      path: relative || '.',
      type: 'file',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }

  await visit(canonical, '')
  return { root: relativeToRun(runRoot, canonical), entries }
}

async function readStableFile(source: string, runRoot: string, runDevice: number, relative: string): Promise<Buffer> {
  const before = await fs.lstat(source)
  if (before.dev !== runDevice) throw new Error(`Snapshot refuses a device escape at ${relative}`)
  if (before.isSymbolicLink()) throw new Error(`Snapshot refuses a symbolic link at ${relative}`)
  if (!before.isFile()) throw new Error(`Snapshot refuses a special file at ${relative}`)
  if (before.nlink !== 1) throw new Error(`Snapshot refuses a hard link at ${relative}`)
  const canonical = await fs.realpath(source)
  const confirmed = await fs.lstat(source)
  if (canonical !== source || !isWithin(runRoot, canonical) || !sameIdentity(confirmed, before)) {
    throw new Error(`Snapshot source path changed at ${relative}`)
  }

  const handle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, before)) {
      throw new Error(`Snapshot source changed while opening ${relative}`)
    }
    const bytes = await handle.readFile()
    const afterRead = await handle.stat()
    if (
      !sameIdentity(afterRead, opened)
      || afterRead.size !== opened.size
      || afterRead.mtimeMs !== opened.mtimeMs
      || afterRead.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Snapshot source changed while reading ${relative}`)
    }
    const after = await fs.lstat(source)
    if (!after.isFile() || !sameIdentity(after, before) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Snapshot source changed after reading ${relative}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function copyTree(
  runRoot: string,
  source: string,
  destination: string,
  runDevice: number,
  destinationIdentity: Identity,
  assertSnapshotParent: () => Promise<void>,
  prefix = '',
): Promise<void> {
  await assertSnapshotParent()
  await assertDirectoryIdentity(destination, destinationIdentity, 'Snapshot destination', runRoot)
  const sourceIdentity = await fs.lstat(source)
  if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink() || sourceIdentity.dev !== runDevice) {
    throw new Error(`Snapshot refuses an invalid directory at ${prefix || '.'}`)
  }
  const canonicalSource = await fs.realpath(source)
  if (canonicalSource !== source || !isWithin(runRoot, canonicalSource)) {
    throw new Error(`Snapshot source path changed at ${prefix || '.'}`)
  }
  const children = await fs.readdir(source)
  children.sort((a, b) => a.localeCompare(b))
  for (const child of children) {
    const from = path.join(source, child)
    const to = path.join(destination, child)
    const relative = prefix ? `${prefix}/${child}` : child
    const stat = await fs.lstat(from)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const canonical = await fs.realpath(from)
      const confirmed = await fs.lstat(from)
      if (canonical !== from || !isWithin(runRoot, canonical) || !sameIdentity(confirmed, stat) || stat.dev !== runDevice) {
        throw new Error(`Snapshot source path changed at ${relative}`)
      }
      await assertSnapshotParent()
      await assertDirectoryIdentity(destination, destinationIdentity, 'Snapshot destination', runRoot)
      await fs.mkdir(to, { mode: 0o700 })
      const created = await fs.lstat(to)
      if (!created.isDirectory() || created.isSymbolicLink() || created.dev !== runDevice) {
        throw new Error(`Snapshot destination changed at ${relative}`)
      }
      await copyTree(
        runRoot,
        from,
        to,
        runDevice,
        { dev: created.dev, ino: created.ino },
        assertSnapshotParent,
        relative,
      )
    } else {
      const bytes = await readStableFile(from, runRoot, runDevice, relative)
      await assertSnapshotParent()
      await assertDirectoryIdentity(destination, destinationIdentity, 'Snapshot destination', runRoot)
      const handle = await fs.open(
        to,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
    }
  }
  const childrenAfter = await fs.readdir(source)
  childrenAfter.sort((a, b) => a.localeCompare(b))
  const after = await fs.lstat(source)
  if (!sameIdentity(after, sourceIdentity) || JSON.stringify(childrenAfter) !== JSON.stringify(children)) {
    throw new Error(`Snapshot source changed while copying ${prefix || '.'}`)
  }
}

function sameEntries(left: RetainedInventory, right: RetainedInventory): boolean {
  return JSON.stringify(left.entries) === JSON.stringify(right.entries)
}

/** Create a fresh temp data dir and point STORY_STUDIO_DATA_DIR at it. */
export async function useTempDataDir(options: RetainedTempOptions): Promise<RetainedTempDataDir>
export async function useTempDataDir(): Promise<LegacyTempDataDir>
export async function useTempDataDir(options?: RetainedTempOptions): Promise<LegacyTempDataDir | RetainedTempDataDir> {
  if (options?.retain) return useRetainedTempDataDir(options)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-test-'))
  process.env.STORY_STUDIO_DATA_DIR = dir
  return {
    dir,
    cleanup: async () => {
      delete process.env.STORY_STUDIO_DATA_DIR
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

async function useRetainedTempDataDir(options: RetainedTempOptions): Promise<RetainedTempDataDir> {
  if (activeRetainedClaim) {
    const location = activeRetainedClaim.runRoot ? ` at ${activeRetainedClaim.runRoot}` : ''
    throw new Error(`A retained fixture is already active${location}`)
  }
  // An async function runs synchronously through this assignment. Reserve the process-global
  // environment before the first await so two callers cannot both begin setup.
  const claim: ActiveRetainedClaim = { bindingEstablished: false }
  activeRetainedClaim = claim

  let harness: { root: string; identity: Identity } | undefined
  let runRoot: string | undefined
  let runIdentity: Identity | undefined
  let snapshotsIdentity: Identity | undefined
  const registrations: Registration[] = []
  const snapshotRecords: SnapshotRecord[] = []
  let revision = 0
  let lastRegistrations: Array<{ kind: RetainedManifestKind; path: string; inventory: RetainedInventory }> = []

  const recordSetupFailure = async (error: unknown): Promise<void> => {
    if (!runRoot || !runIdentity || !harness) return
    try {
      await assertDirectoryIdentity(harness.root, harness.identity, 'Test harness root')
      await assertDirectoryIdentity(runRoot, runIdentity, 'Retained run root', harness.root)
      const next = revision + 1
      await fs.writeFile(
        path.join(runRoot, `manifest-${String(next).padStart(4, '0')}.json`),
        `${JSON.stringify({
          version: 1,
          revision: next,
          phase: 'setup-failed',
          root: '.',
          rootIdentity: runIdentity,
          registrations: lastRegistrations,
          snapshots: snapshotRecords,
          error: errorMessage(error),
        }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      revision = next
    } catch {
      // Preserve the original setup error and every physical byte already created.
    }
  }

  try {
    harness = await trustedHarnessRoot()
    runRoot = await fs.mkdtemp(path.join(harness.root, 'retained-test-fixture-'))
    claim.runRoot = runRoot
    await fs.chmod(runRoot, 0o700)
    const runStat = await fs.lstat(runRoot)
    runIdentity = { dev: runStat.dev, ino: runStat.ino }
    const dataDir = path.join(runRoot, 'data')
    const tmpDir = path.join(runRoot, 'tmp')
    const snapshotsDir = path.join(runRoot, 'snapshots')
    await fs.mkdir(dataDir, { mode: 0o700 })
    await fs.mkdir(tmpDir, { mode: 0o700 })
    await fs.mkdir(snapshotsDir, { mode: 0o700 })
    const snapshotsStat = await fs.lstat(snapshotsDir)
    snapshotsIdentity = { dev: snapshotsStat.dev, ino: snapshotsStat.ino }
    registrations.push(
      { target: dataDir, kind: 'data' },
      { target: tmpDir, kind: 'tmp' },
    )

    const assertClaimOwner = (): void => {
      if (activeRetainedClaim !== claim) {
        throw new Error('Retained fixture no longer owns the process environment claim')
      }
    }

    const assertSnapshotParent = async (): Promise<void> => {
      assertClaimOwner()
      await assertDirectoryIdentity(snapshotsDir, snapshotsIdentity!, 'Snapshot parent', runRoot!)
    }

    const assertRoots = async (): Promise<void> => {
      assertClaimOwner()
      await assertDirectoryIdentity(harness!.root, harness!.identity, 'Test harness root')
      await assertDirectoryIdentity(runRoot!, runIdentity!, 'Retained run root', harness!.root)
      await assertSnapshotParent()
    }

    const writeRevision = async (phase: string, error?: string): Promise<void> => {
      await assertRoots()
      const inventoried = []
      for (const registration of registrations) {
        inventoried.push({
          kind: registration.kind,
          path: relativeToRun(runRoot!, registration.target),
          inventory: await inventoryTree(runRoot!, registration.target, runIdentity!.dev),
        })
      }
      const next = revision + 1
      const manifest = {
        version: 1,
        revision: next,
        phase,
        root: '.',
        rootIdentity: runIdentity,
        registrations: inventoried,
        snapshots: snapshotRecords,
        ...(error ? { error } : {}),
      }
      await assertRoots()
      await fs.writeFile(
        path.join(runRoot!, `manifest-${String(next).padStart(4, '0')}.json`),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      revision = next
      lastRegistrations = inventoried
    }

    const writeFailureRevision = async (phase: string, error: unknown): Promise<void> => {
      try {
        await assertRoots()
        const next = revision + 1
        await fs.writeFile(
          path.join(runRoot!, `manifest-${String(next).padStart(4, '0')}.json`),
          `${JSON.stringify({
            version: 1,
            revision: next,
            phase,
            root: '.',
            rootIdentity: runIdentity,
            registrations: lastRegistrations,
            snapshots: snapshotRecords,
            error: errorMessage(error),
          }, null, 2)}\n`,
          { flag: 'wx', mode: 0o600 },
        )
        revision = next
      } catch {
        // The original failure remains authoritative; the physical run tree is still retained.
      }
    }

    await writeRevision('initial')

    const previousEnv = Object.fromEntries(RETAINED_ENV_KEYS.map(key => [key, process.env[key]])) as Record<
      (typeof RETAINED_ENV_KEYS)[number], string | undefined
    >
    // From this point on, a failure must retain the claim and bindings. There are no awaits between
    // binding and returning the fixture to its caller.
    claim.bindingEstablished = true
    process.env.STORY_STUDIO_DATA_DIR = dataDir
    process.env.TMPDIR = tmpDir
    process.env.TMP = tmpDir
    process.env.TEMP = tmpDir

    const register = async (target: string, kind: RetainedRegistrationKind): Promise<void> => {
      if (kind !== 'work-dir' && kind !== 'snapshot') throw new Error(`Unsupported retained registration kind: ${kind}`)
      await assertRoots()
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink()) throw new Error('Retained registration refuses a symbolic link')
      const canonical = await fs.realpath(target)
      if (!isWithin(runRoot!, canonical) || canonical !== target) throw new Error('Path is outside retained run root')
      if (registrations.some(registration => registration.target === canonical)) {
        throw new Error(`Retained path is already registered: ${relativeToRun(runRoot!, canonical)}`)
      }
      await inventoryTree(runRoot!, canonical, runIdentity!.dev)
      registrations.push({ target: canonical, kind })
      await writeRevision('registered')
    }

    const preserveBeforeDestructive = async (target: string, label: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
        throw new Error('Snapshot label must contain only letters, numbers, dot, underscore, or hyphen')
      }
      let sourceRelative = 'not-validated'
      let snapshot = ''
      try {
        // The caller supplies the one explicit quiescence boundary for every controlled writer.
        await options.settle()
        await assertRoots()
        const sourceStat = await fs.lstat(target)
        if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
          throw new Error('Pre-destructive preservation requires a real directory target')
        }
        const source = await fs.realpath(target)
        if (source === dataDir || !isWithin(dataDir, source) || source !== target) {
          throw new Error('Pre-destructive preservation only accepts an exact fake-domain target inside retained data')
        }
        const sourceIdentity = { dev: sourceStat.dev, ino: sourceStat.ino }
        sourceRelative = relativeToRun(runRoot!, source)
        const sourceInventory = await inventoryTree(runRoot!, source, runIdentity!.dev, sourceIdentity)

        await assertSnapshotParent()
        snapshot = await fs.mkdtemp(path.join(snapshotsDir, `${label}-`))
        await assertSnapshotParent()
        const snapshotIdentity = await (async (): Promise<Identity> => {
          const snapshotHandle = await fs.open(
            snapshot,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          )
          try {
            await snapshotHandle.chmod(0o700)
            const snapshotStat = await snapshotHandle.stat()
            if (!snapshotStat.isDirectory() || snapshotStat.dev !== runIdentity!.dev) {
              throw new Error('Snapshot destination is not an owned directory')
            }
            return { dev: snapshotStat.dev, ino: snapshotStat.ino }
          } finally {
            await snapshotHandle.close()
          }
        })()
        await assertSnapshotParent()
        await assertDirectoryIdentity(snapshot, snapshotIdentity, 'Snapshot destination', runRoot!)
        try {
          await copyTree(
            runRoot!,
            source,
            snapshot,
            runIdentity!.dev,
            snapshotIdentity,
            assertSnapshotParent,
          )
        } catch (error) {
          if (/source changed|directory changed/i.test(errorMessage(error))) {
            throw new Error('Source changed during preservation; destructive operation is refused')
          }
          throw error
        }
        await assertSnapshotParent()
        const sourceAfter = await inventoryTree(runRoot!, source, runIdentity!.dev, sourceIdentity)
        if (!sameEntries(sourceInventory, sourceAfter)) {
          throw new Error('Source changed during preservation; destructive operation is refused')
        }
        const snapshotInventory = await inventoryTree(runRoot!, snapshot, runIdentity!.dev, snapshotIdentity)
        if (!sameEntries(sourceInventory, snapshotInventory)) {
          throw new Error('Snapshot inventory does not match source; destructive operation is refused')
        }
        snapshotRecords.push({
          source: sourceRelative,
          snapshot: relativeToRun(runRoot!, snapshot),
          status: 'verified',
          sourceInventory,
          snapshotInventory,
          snapshotIdentity,
        })
        registrations.push({ target: snapshot, kind: 'snapshot' })
        await writeRevision('preserved')

        // The manifest work above is deliberately followed by one final proof. This inventory is
        // current only at return; the caller must not mutate the target before its domain operation.
        await assertSnapshotParent()
        await assertDirectoryIdentity(snapshot, snapshotIdentity, 'Snapshot destination', runRoot!)
        const finalSnapshotInventory = await inventoryTree(
          runRoot!,
          snapshot,
          runIdentity!.dev,
          snapshotIdentity,
        )
        await assertSnapshotParent()
        let finalSourceInventory: RetainedInventory
        try {
          await assertDirectoryIdentity(source, sourceIdentity, 'Preservation source', dataDir)
          finalSourceInventory = await inventoryTree(runRoot!, source, runIdentity!.dev, sourceIdentity)
        } catch (error) {
          throw new Error(
            `Source changed during final preservation confirmation; destructive operation is refused: ${errorMessage(error)}`,
          )
        }
        if (
          !sameEntries(sourceInventory, finalSourceInventory)
          || !sameEntries(snapshotInventory, finalSnapshotInventory)
          || !sameEntries(finalSourceInventory, finalSnapshotInventory)
        ) {
          throw new Error('Source changed during final preservation confirmation; destructive operation is refused')
        }
        return {
          snapshot,
          snapshotIdentity,
          sourceInventory: finalSourceInventory,
          snapshotInventory: finalSnapshotInventory,
        }
      } catch (error) {
        snapshotRecords.push({
          source: sourceRelative,
          snapshot: snapshot && isWithin(runRoot!, snapshot) ? relativeToRun(runRoot!, snapshot) : 'not-created',
          status: 'failed',
          error: errorMessage(error),
        })
        await writeFailureRevision('preservation-failed', error)
        throw error
      }
    }

    let completed = false
    let finishing: Promise<void> | undefined
    const cleanup = (): Promise<void> => {
      if (completed) return Promise.resolve()
      if (finishing) return finishing
      const attempt = (async () => {
        assertClaimOwner()
        try {
          await options.settle()
        } catch (error) {
          await writeFailureRevision('settle-failed', error)
          throw error
        }
        try {
          await writeRevision('final')
        } catch (error) {
          await writeFailureRevision('finalization-failed', error)
          throw error
        }
        // No await follows this ownership check. Another fixture cannot claim the process while
        // this one restores the exact environment and fixture state it captured.
        assertClaimOwner()
        for (const key of RETAINED_ENV_KEYS) {
          const value = previousEnv[key]
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        activeRetainedClaim = undefined
        completed = true
      })()
      finishing = attempt.finally(() => {
        if (!completed) finishing = undefined
      })
      return finishing
    }

    return { dir: dataDir, runRoot, register, preserveBeforeDestructive, cleanup }
  } catch (error) {
    await recordSetupFailure(error)
    if (!claim.bindingEstablished && activeRetainedClaim === claim) activeRetainedClaim = undefined
    throw error
  }
}
