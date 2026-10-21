import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { useTempDataDir } from './_helpers.js'

const execFileAsync = promisify(execFile)
const ENV_KEYS = ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const

type InventoryEntry = {
  path: string
  type: 'directory' | 'file'
  size?: number
  sha256?: string
}

type Inventory = {
  root: string
  entries: InventoryEntry[]
}

type RetainedFixture = {
  dir: string
  cleanup: () => Promise<void>
  runRoot: string
  register: (target: string, kind: 'work-dir' | 'snapshot') => Promise<void>
  preserveBeforeDestructive: (target: string, label: string) => Promise<{
    snapshot: string
    snapshotIdentity: { dev: number; ino: number }
    sourceInventory: Inventory
    snapshotInventory: Inventory
  }>
}

type Manifest = {
  revision: number
  phase: string
  registrations: Array<{ kind: string; path: string; inventory: Inventory }>
  snapshots: Array<{
    source: string
    snapshot: string
    snapshotIdentity?: { dev: number; ino: number }
    sourceInventory: Inventory
    snapshotInventory: Inventory
  }>
  error?: string
}

function saveEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number], string | undefined
  >
}

function restoreEnv(saved: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function startRetained(settle: () => Promise<void> = async () => {}): Promise<Partial<RetainedFixture>> {
  return (useTempDataDir as unknown as (
    options: { retain: true; settle: () => Promise<void> },
  ) => Promise<Partial<RetainedFixture>>)({ retain: true, settle })
}

function assertRetained(fixture: Partial<RetainedFixture>): asserts fixture is RetainedFixture {
  // This guard is intentionally first. Against the frozen helper, options are ignored and the
  // legacy cleanup deletes its tree; no test below may call cleanup or create a deletion-sensitive
  // payload until retained mode proves that it is active.
  assert.equal(typeof fixture.runRoot, 'string', 'retained mode must return its owned run root')
  assert.equal(typeof fixture.register, 'function', 'retained mode must return explicit registration')
  assert.equal(
    typeof fixture.preserveBeforeDestructive,
    'function',
    'retained mode must return verified pre-operation preservation',
  )
  assert.equal(typeof fixture.dir, 'string')
  assert.equal(typeof fixture.cleanup, 'function')
}

async function openRetained(settle: () => Promise<void> = async () => {}): Promise<RetainedFixture> {
  const fixture = await startRetained(settle)
  assertRetained(fixture)
  return fixture
}

async function manifests(runRoot: string): Promise<Array<{ name: string; value: Manifest }>> {
  const names = (await fs.readdir(runRoot))
    .filter(name => /^manifest-\d{4}\.json$/.test(name))
    .sort()
  return Promise.all(names.map(async name => ({
    name,
    value: JSON.parse(await fs.readFile(path.join(runRoot, name), 'utf8')) as Manifest,
  })))
}

function entries(inventory: Inventory): Map<string, InventoryEntry> {
  return new Map(inventory.entries.map(entry => [entry.path, entry]))
}

test('retained mode extends the legacy dir and cleanup shape before cleanup can run', async () => {
  const fixture = await openRetained()
  assert.deepEqual(
    Object.keys(fixture).sort(),
    ['cleanup', 'dir', 'preserveBeforeDestructive', 'register', 'runRoot'],
  )
  await fixture.cleanup()
})

test('simultaneous retained setup reserves one claim synchronously', async () => {
  const results = await Promise.allSettled([startRetained(), startRetained()])
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<Partial<RetainedFixture>> => result.status === 'fulfilled',
  )
  const rejected = results.filter(result => result.status === 'rejected')

  // Against the frozen helper both calls return legacy fixtures. This fails before either legacy
  // cleanup can run, so the RED retains both outer-runner-owned directories.
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(String(rejected[0].reason), /retained fixture is already active/i)
  assertRetained(fulfilled[0].value)
  await fulfilled[0].value.cleanup()
})

test('retained mode restores the exact environment and safeStorage state only after settle', async () => {
  const originalEnv = saveEnv()
  const storage = await import('./safe-storage-test-double.js')
  assert.equal(typeof storage.getTestSafeStorageAvailable, 'function')
  const originalSafeStorage = storage.getTestSafeStorageAvailable()
  const prior = {
    STORY_STUDIO_DATA_DIR: 'before-data',
    TMPDIR: 'before-tmpdir',
    TMP: 'before-tmp',
    TEMP: 'before-temp',
  } as const
  let settled = false

  try {
    Object.assign(process.env, prior)
    storage.setTestSafeStorageAvailable(false)
    const fixture = await openRetained(async () => { settled = true })

    assert.equal(process.env.STORY_STUDIO_DATA_DIR, fixture.dir)
    assert.equal(process.env.TMPDIR, path.join(fixture.runRoot, 'tmp'))
    assert.equal(process.env.TMP, path.join(fixture.runRoot, 'tmp'))
    assert.equal(process.env.TEMP, path.join(fixture.runRoot, 'tmp'))
    assert.equal(storage.getTestSafeStorageAvailable(), true)
    assert.equal(settled, false)

    await fixture.cleanup()

    assert.equal(settled, true)
    assert.deepEqual(saveEnv(), prior)
    assert.equal(storage.getTestSafeStorageAvailable(), false)
  } finally {
    restoreEnv(originalEnv)
    storage.setTestSafeStorageAvailable(originalSafeStorage)
  }
})

test('a failed settle keeps the retained environment claimed and refuses a second fixture', async () => {
  const before = saveEnv()
  let fail = true
  const fixture = await openRetained(async () => {
    if (fail) throw new Error('controlled settle failure')
  })

  await assert.rejects(fixture.cleanup(), /controlled settle failure/)
  assert.equal(process.env.STORY_STUDIO_DATA_DIR, fixture.dir)
  assert.equal(process.env.TMPDIR, path.join(fixture.runRoot, 'tmp'))
  await assert.rejects(openRetained(), /retained fixture is already active/i)

  fail = false
  await fixture.cleanup()
  assert.deepEqual(saveEnv(), before)
})

test('numbered manifests inventory owned data, temp, and registered work trees', async () => {
  const fixture = await openRetained()
  const work = path.join(fixture.runRoot, 'owned-work')
  await fs.mkdir(path.join(fixture.dir, 'nested'), { recursive: true, mode: 0o700 })
  await fs.mkdir(work, { mode: 0o700 })
  await fs.writeFile(path.join(fixture.dir, 'nested', 'payload.txt'), 'hello')
  await fs.writeFile(path.join(work, 'registered.txt'), 'registered')
  await fixture.register(work, 'work-dir')
  await fs.writeFile(path.join(work, 'after-registration.txt'), 'later')
  await fixture.cleanup()

  const revisions = await manifests(fixture.runRoot)
  assert.deepEqual(revisions.map(item => item.name), [
    'manifest-0001.json',
    'manifest-0002.json',
    'manifest-0003.json',
  ])
  assert.equal(revisions[0].value.phase, 'initial')
  assert.equal(revisions[1].value.phase, 'registered')
  assert.equal(revisions[2].value.phase, 'final')
  const final = revisions[2].value
  const data = final.registrations.find(item => item.kind === 'data')
  const tmp = final.registrations.find(item => item.kind === 'tmp')
  const registered = final.registrations.find(item => item.kind === 'work-dir')
  assert.ok(data)
  assert.ok(tmp)
  assert.ok(registered)
  assert.deepEqual(entries(data.inventory).get('nested/payload.txt'), {
    path: 'nested/payload.txt',
    type: 'file',
    size: 5,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  })
  assert.equal(entries(registered.inventory).get('after-registration.txt')?.size, 5)
  assert.equal(JSON.stringify(final).includes(fixture.runRoot), false)
})

test('registration rejects paths outside the run and no-follow link, hardlink, and special entries', async () => {
  const fixture = await openRetained()
  const rejected = path.join(fixture.runRoot, 'snapshots', 'rejected')
  const symlinks = path.join(rejected, 'symlinks')
  const hardlinks = path.join(rejected, 'hardlinks')
  const specials = path.join(rejected, 'specials')
  await fs.mkdir(symlinks, { recursive: true, mode: 0o700 })
  await fs.mkdir(hardlinks, { mode: 0o700 })
  await fs.mkdir(specials, { mode: 0o700 })

  await assert.rejects(
    fixture.register(process.env.STORY_STUDIO_TEST_HARNESS_ROOT!, 'work-dir'),
    /outside retained run root/i,
  )
  await fs.symlink(fixture.dir, path.join(symlinks, 'data-link'))
  await assert.rejects(fixture.register(symlinks, 'snapshot'), /symbolic link/i)

  const original = path.join(hardlinks, 'original.txt')
  await fs.writeFile(original, 'one inode')
  await fs.link(original, path.join(hardlinks, 'second-name.txt'))
  await assert.rejects(fixture.register(hardlinks, 'snapshot'), /hard link/i)

  const fifo = path.join(specials, 'named-pipe')
  await execFileAsync('/usr/bin/mkfifo', [fifo])
  await assert.rejects(fixture.register(specials, 'snapshot'), /special file/i)
  await fixture.cleanup()
})

test('pre-destructive preservation refuses a replaced snapshot parent before writing to replacement', async () => {
  const fixture = await openRetained()
  const target = path.join(fixture.dir, 'projects', 'snapshot-parent-replacement')
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(target, 'state.txt'), 'fixture state')

  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT!
  const outside = await fs.mkdtemp(path.join(harnessRoot, 'outside-snapshot-target-'))
  const sentinel = path.join(outside, 'owner-sentinel.txt')
  await fs.writeFile(sentinel, 'must remain byte-identical\n')
  const snapshots = path.join(fixture.runRoot, 'snapshots')
  const originalSnapshots = path.join(fixture.runRoot, 'snapshots-original')

  // Replace the parent's inode without a symlink, so restoration uses the same guarded renames.
  await fs.rename(snapshots, originalSnapshots)
  await fs.rename(outside, snapshots)

  await assert.rejects(
    fixture.preserveBeforeDestructive(target, 'replaced-parent'),
    /snapshot parent identity changed/i,
  )
  // The replacement directory retains its sentinel byte-identical and nothing was written to it.
  assert.equal(await fs.readFile(path.join(snapshots, 'owner-sentinel.txt'), 'utf8'), 'must remain byte-identical\n')
  assert.deepEqual(await fs.readdir(snapshots), ['owner-sentinel.txt'])
  // The target under retained data was never touched.
  assert.equal(await fs.readFile(path.join(target, 'state.txt'), 'utf8'), 'fixture state')

  // Move the replacement back to its outside location and restore the owned snapshots directory.
  await fs.rename(snapshots, outside)
  await fs.rename(originalSnapshots, snapshots)
  await fixture.cleanup()
})

test('pre-destructive preservation makes an independent verified byte copy', async () => {
  let settleCalls = 0
  const fixture = await openRetained(async () => { settleCalls++ })
  const target = path.join(fixture.dir, 'projects', 'fake-project', 'backups', 'v1')
  const file = path.join(target, 'state.bin')
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 255]))

  const preserved = await fixture.preserveBeforeDestructive(target, 'backup-v1')
  assert.equal(settleCalls, 1)
  assert.ok(preserved.snapshotIdentity.dev >= 0)
  assert.ok(preserved.snapshotIdentity.ino > 0)
  assert.deepEqual(preserved.sourceInventory.entries, preserved.snapshotInventory.entries)
  assert.deepEqual(await fs.readFile(path.join(preserved.snapshot, 'state.bin')), Buffer.from([0, 1, 2, 3, 255]))

  await fs.writeFile(file, Buffer.from([9, 9, 9]))
  assert.deepEqual(await fs.readFile(path.join(preserved.snapshot, 'state.bin')), Buffer.from([0, 1, 2, 3, 255]))
  const revision = (await manifests(fixture.runRoot)).at(-1)!.value
  assert.equal(revision.phase, 'preserved')
  assert.equal(revision.snapshots.at(-1)?.source, 'data/projects/fake-project/backups/v1')
  assert.match(revision.snapshots.at(-1)?.snapshot ?? '', /^snapshots\/backup-v1-/)
  assert.deepEqual(revision.snapshots.at(-1)?.snapshotIdentity, preserved.snapshotIdentity)
  await fixture.cleanup()
  assert.equal(settleCalls, 2)
})

test('pre-destructive preservation fails if the source changes while it is copied', async () => {
  const fixture = await openRetained()
  const target = path.join(fixture.dir, 'projects', 'changing-target')
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  await Promise.all(Array.from({ length: 256 }, (_, index) => (
    fs.writeFile(path.join(target, `${String(index).padStart(4, '0')}.txt`), `fixture-${index}`)
  )))

  const snapshotParent = path.join(fixture.runRoot, 'snapshots')
  let preservationFinished = false
  const mutateAfterSnapshotStarts = (async () => {
    while (!preservationFinished && (await fs.readdir(snapshotParent)).length === 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (!preservationFinished) {
      await fs.writeFile(path.join(target, 'source-changed.txt'), 'changed during copy')
    }
  })()
  try {
    await assert.rejects(
      fixture.preserveBeforeDestructive(target, 'changing-target'),
      /source changed during preservation/i,
    )
  } finally {
    preservationFinished = true
  }
  await mutateAfterSnapshotStarts
  const revision = (await manifests(fixture.runRoot)).at(-1)!.value
  assert.equal(revision.phase, 'preservation-failed')
  assert.match(revision.error ?? '', /source changed during preservation/i)
  await fixture.cleanup()
})

test('pre-destructive preservation refuses mutation during late journal and confirmation work', async () => {
  const fixture = await openRetained()
  const target = path.join(fixture.dir, 'projects', 'late-changing-target')
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  await Promise.all(Array.from({ length: 256 }, (_, index) => (
    fs.writeFile(path.join(target, `${String(index).padStart(4, '0')}.txt`), `fixture-${index}`)
  )))

  const journal = path.join(fixture.runRoot, 'manifest-0002.json')
  let preservationFinished = false
  const mutateAfterJournal = (async () => {
    while (!preservationFinished) {
      try {
        await fs.access(journal)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (!preservationFinished) {
      await fs.writeFile(path.join(target, 'late-source-change.txt'), 'changed after journal publication')
    }
  })()
  try {
    await assert.rejects(
      fixture.preserveBeforeDestructive(target, 'late-changing-target'),
      /source changed during final preservation confirmation/i,
    )
  } finally {
    preservationFinished = true
  }
  await mutateAfterJournal
  const revision = (await manifests(fixture.runRoot)).at(-1)!.value
  assert.equal(revision.phase, 'preservation-failed')
  assert.match(revision.error ?? '', /source changed during final preservation confirmation/i)
  await fixture.cleanup()
})

test('the runner same-device assertion refuses mismatch and names the untouched sandbox', async () => {
  type RunnerBoundary = {
    assertSameDeviceForRetention: (sandboxDevice: number, fixturesDevice: number, sandbox: string) => void
  }
  const isRunnerBoundary = (value: unknown): value is RunnerBoundary => (
    typeof value === 'object'
    && value !== null
    && 'assertSameDeviceForRetention' in value
    && typeof value.assertSameDeviceForRetention === 'function'
  )
  const runnerSpecifier = new URL('../../../scripts/testing/run-backend-tests.mjs', import.meta.url).href
  const runner: unknown = await import(runnerSpecifier)
  assert.ok(isRunnerBoundary(runner), 'runner preflight export is required')
  assert.doesNotThrow(() => runner.assertSameDeviceForRetention(7, 7, '/private/var/folders/original'))
  assert.throws(
    () => runner.assertSameDeviceForRetention(7, 8, '/private/var/folders/original'),
    error => {
      assert.match(String(error), /different devices/i)
      assert.match(String(error), /\/private\/var\/folders\/original/)
      return true
    },
  )
})

test('legacy useTempDataDir keeps its dir and cleanup return shape without running destructive cleanup', async () => {
  const legacy = await useTempDataDir()
  assert.equal(typeof legacy.dir, 'string')
  assert.equal(typeof legacy.cleanup, 'function')
  assert.deepEqual(Object.keys(legacy).sort(), ['cleanup', 'dir'])
  // Intentionally retained inside the runner-owned outer sandbox; legacy cleanup calls fs.rm.
})
