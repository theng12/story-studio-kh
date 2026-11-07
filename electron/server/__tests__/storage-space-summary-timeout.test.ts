import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test'

import { useTempDataDir, type RetainedTempDataDir } from './_helpers.js'
import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'

installTestSafeStorage()

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

interface PartialSpaceSummary {
  free_bytes: number | null
  project_trash_bytes: number | null
  library_trash_bytes: number | null
  app_trash_bytes: number | null
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

function measurementClock(t: Pick<TestContext, 'mock'>) {
  const setTimeout = globalThis.setTimeout
  const clearTimeout = globalThis.clearTimeout
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>()
  // Advance measurement time only after unrelated real filesystem work settles.
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 30) return setTimeout(callback, ms, ...args)
    const timer = {} as ReturnType<typeof setTimeout>
    deadlines.set(timer, () => callback(...args))
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
    if (!deadlines.delete(timer as ReturnType<typeof setTimeout>)) clearTimeout(timer)
  })
  return async (blockedPhases: number): Promise<void> => {
    const until = Date.now() + 400
    while (deadlines.size !== blockedPhases) {
      assert.ok(Date.now() < until, 'unblocked measurements must settle before advancing their siblings deadline')
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    for (const [timer, expire] of deadlines) {
      deadlines.delete(timer)
      expire()
    }
  }
}

const savedTimeout = process.env.STORY_STORAGE_SUMMARY_TIMEOUT_MS
let retained: RetainedTempDataDir | undefined
let fixtureRoot = ''
let baselineSnapshot: string[] = []
let slug = ''
let secondSlug = ''
let projectDir = ''
let secondProjectDir = ''
let libraryTrash = ''
let storageSpaceSummary: (slug: string) => Promise<PartialSpaceSummary>

async function writeFixture(file: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, Buffer.alloc(bytes, 1))
}

async function treeSnapshot(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      const relative = path.relative(root, file)
      if (entry.isDirectory()) {
        result.push(`directory:${relative}`)
        await visit(file)
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(file)
        result.push(`file:${relative}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}`)
      }
    }
  }
  await visit(root)
  return result
}

async function observeBeforeRelease<T>(work: Promise<T>, label: string): Promise<{ result?: T; error?: unknown }> {
  try {
    return { result: await within(work, 400, `storageSpaceSummary withheld the whole response behind ${label}`) }
  } catch (error) {
    return { error }
  }
}

describe('storage space summary timeout boundaries', () => {
  let expireMeasurements: ReturnType<typeof measurementClock>
  beforeEach(t => { expireMeasurements = measurementClock(t) })

  before(async () => {
    // The fixture is a RETAINED one: it must survive the run and must never be
    // tidied by automation. The retained helper puts it inside the harness
    // sandbox (which the harness keeps under `_trash/test-fixtures`), so the
    // atomic project writes it makes — temp file plus rename — stay inside the
    // sandbox the retained-filesystem preload governs.
    retained = await useTempDataDir({ retain: true, settle: async () => {} })
    fixtureRoot = retained.dir
    process.env.STORY_STORAGE_SUMMARY_TIMEOUT_MS = '30'
    setTestSafeStorageAvailable(true)

    const pm = await import('../services/project-manager.js')
    const storage = await import('../services/storage-audit.js')
    const updater = await import('../services/app-update.js')
    const project = await pm.createProject({ name: 'Space timeout fixture' })
    const secondProject = await pm.createProject({ name: 'Second space timeout fixture' })
    slug = project.slug
    secondSlug = secondProject.slug
    projectDir = pm.getProjectDir(slug)!
    secondProjectDir = pm.getProjectDir(secondSlug)!
    libraryTrash = path.join(path.dirname(projectDir), '_trash')

    await writeFixture(path.join(libraryTrash, slug, 'test-fixtures', 'project-trash.bin'), 11)
    await writeFixture(path.join(projectDir, '_trash', 'test-fixtures', 'legacy-project-trash.bin'), 13)
    await writeFixture(path.join(updater.previousAppsDir(), 'test-fixtures', 'app-trash.bin'), 17)
    storageSpaceSummary = storage.storageSpaceSummary
    baselineSnapshot = await treeSnapshot(fixtureRoot)
  })

  after(async () => {
    try {
      // Settles the retained fixture: the final manifest revision is written and
      // the claimed environment is restored. Nothing is deleted.
      await retained?.cleanup()
    } finally {
      if (savedTimeout === undefined) delete process.env.STORY_STORAGE_SUMMARY_TIMEOUT_MS
      else process.env.STORY_STORAGE_SUMMARY_TIMEOUT_MS = savedTimeout
      setTestSafeStorageAvailable(true)
    }
    // Owner contract: retained fixtures in `_trash` are never deleted or tidied by automation.
  })

  test('returns measured Trash totals while free-space measurement remains in flight', async t => {
    const entered = deferred()
    const release = deferred()
    const lateCallSettled = deferred()
    const originalStatfs = fs.statfs.bind(fs)
    const originalStat = fs.stat.bind(fs)
    // Real fixture reads deliberately outlast the former 30ms filesystem race.
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
      await new Promise<void>(resolve => setTimeout(resolve, 35))
      return originalStat(...args)
    })
    t.mock.method(fs, 'statfs', async (...args: Parameters<typeof fs.statfs>) => {
      if (path.resolve(String(args[0])) !== path.resolve(projectDir)) return originalStatfs(...args)
      entered.resolve()
      try {
        await release.promise
        return { bsize: 4096, bavail: 32 } as Awaited<ReturnType<typeof fs.statfs>>
      } finally {
        lateCallSettled.resolve()
      }
    })

    const pending = storageSpaceSummary(slug)
    let seamEntered = false
    let observed: Awaited<ReturnType<typeof observeBeforeRelease<PartialSpaceSummary>>> = {}
    try {
      await within(entered.promise, 400, 'the real free-space measurement seam was not exercised')
      seamEntered = true
      await expireMeasurements(1)
      observed = await observeBeforeRelease(pending, 'free_bytes past 400ms')
    } finally {
      release.resolve()
      if (seamEntered) await within(lateCallSettled.promise, 400, 'the released free-space callback did not settle')
      await within(pending, 400, 'the released summary did not drain')
    }
    assert.deepEqual(await treeSnapshot(fixtureRoot), baselineSnapshot, 'measurement must not mutate the retained fixture')
    if (observed.error) throw observed.error

    const result = observed.result!
    const detached = structuredClone(result)
    assert.deepEqual(result, {
      free_bytes: null,
      project_trash_bytes: 24,
      library_trash_bytes: 24,
      app_trash_bytes: 17,
    })
    assert.deepEqual(result, detached, 'a late free-space callback must not mutate the returned snapshot')
  })

  test('returns other measurements while the whole-Library Trash traversal remains in flight', async t => {
    const entered = deferred()
    const release = deferred()
    const lateCallSettled = deferred()
    const originalReaddir = fs.readdir.bind(fs)
    const originalStatfs = fs.statfs.bind(fs)
    let blocking = true
    t.mock.method(fs, 'statfs', async (...args: Parameters<typeof fs.statfs>) => {
      if (path.resolve(String(args[0])) !== path.resolve(projectDir)) return originalStatfs(...args)
      return { bsize: 4096, bavail: 2 } as Awaited<ReturnType<typeof fs.statfs>>
    })
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (!blocking || path.resolve(String(args[0])) !== path.resolve(libraryTrash)) return originalReaddir(...args)
      entered.resolve()
      try {
        await release.promise
        return await originalReaddir(...args)
      } finally {
        lateCallSettled.resolve()
      }
    })

    const pending = storageSpaceSummary(slug)
    let seamEntered = false
    let observed: Awaited<ReturnType<typeof observeBeforeRelease<PartialSpaceSummary>>> = {}
    try {
      await within(entered.promise, 400, 'the real Library Trash traversal seam was not exercised')
      seamEntered = true
      await expireMeasurements(1)
      observed = await observeBeforeRelease(pending, 'library_trash_bytes past 400ms')
    } finally {
      release.resolve()
      if (seamEntered) await within(lateCallSettled.promise, 400, 'the released Library Trash callback did not settle')
      await within(pending, 400, 'the released summary did not drain')
      blocking = false
    }
    assert.deepEqual(await treeSnapshot(fixtureRoot), baselineSnapshot, 'measurement must not mutate the retained fixture')
    if (observed.error) throw observed.error

    const result = observed.result!
    const detached = structuredClone(result)
    assert.deepEqual(result, {
      free_bytes: 8192,
      project_trash_bytes: 24,
      library_trash_bytes: null,
      app_trash_bytes: 17,
    })
    assert.deepEqual(result, detached, 'a late Trash callback must not mutate the returned snapshot')
  })

  test('reuses a timed-out raw project measurement, then measures fresh after actual settlement', async t => {
    const entered = deferred()
    const release = deferred()
    const lateCallSettled = deferred()
    const originalStatfs = fs.statfs.bind(fs)
    let freeAttempts = 0
    t.mock.method(fs, 'statfs', async (...args: Parameters<typeof fs.statfs>) => {
      if (path.resolve(String(args[0])) !== path.resolve(projectDir)) return originalStatfs(...args)
      freeAttempts++
      if (freeAttempts === 1) {
        entered.resolve()
        try { await release.promise } finally { lateCallSettled.resolve() }
      }
      return { bsize: 4096, bavail: 3 } as Awaited<ReturnType<typeof fs.statfs>>
    })

    const firstPending = storageSpaceSummary(slug)
    let first: PartialSpaceSummary | undefined
    let second: PartialSpaceSummary | undefined
    let seamEntered = false
    try {
      await within(entered.promise, 400, 'the project measurement did not enter the barrier')
      seamEntered = true
      await expireMeasurements(1)
      first = await within(firstPending, 400, 'the first caller did not receive its bounded partial result')
      second = await within(storageSpaceSummary(slug), 400, 'the repeated caller did not reuse the bounded project result')
      assert.equal(freeAttempts, 1, 'a caller deadline must not start a second raw project measurement')
    } finally {
      release.resolve()
      if (seamEntered) await within(lateCallSettled.promise, 400, 'the released project measurement did not settle')
      await within(firstPending, 400, 'the first bounded result did not drain')
    }

    assert.equal(first!.free_bytes, null)
    assert.equal(second!.free_bytes, null)
    const firstDetached = structuredClone(first)
    const third = await within(storageSpaceSummary(slug), 400, 'a settled measurement was not refreshed')
    assert.equal(freeAttempts, 2, 'completed raw work must be removed so the next call measures fresh')
    assert.equal(third.free_bytes, 12_288)
    assert.deepEqual(first, firstDetached, 'fresh work must not mutate a prior partial response')
    assert.deepEqual(await treeSnapshot(fixtureRoot), baselineSnapshot, 'measurement must remain read-only')
  })

  test('shares a still-running whole-Library Trash traversal across project slugs', async t => {
    const entered = deferred()
    const release = deferred()
    const lateCallSettled = deferred()
    const originalReaddir = fs.readdir.bind(fs)
    const originalStatfs = fs.statfs.bind(fs)
    let libraryAttempts = 0
    let blocking = true
    t.mock.method(fs, 'statfs', async (...args: Parameters<typeof fs.statfs>) => {
      const target = path.resolve(String(args[0]))
      if (target !== path.resolve(projectDir) && target !== path.resolve(secondProjectDir)) return originalStatfs(...args)
      return { bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof fs.statfs>>
    })
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (!blocking || path.resolve(String(args[0])) !== path.resolve(libraryTrash)) return originalReaddir(...args)
      libraryAttempts++
      entered.resolve()
      try {
        await release.promise
        return await originalReaddir(...args)
      } finally {
        lateCallSettled.resolve()
      }
    })

    const firstPending = storageSpaceSummary(slug)
    let first: PartialSpaceSummary | undefined
    let second: PartialSpaceSummary | undefined
    let seamEntered = false
    try {
      await within(entered.promise, 400, 'the shared Library Trash traversal did not enter the barrier')
      seamEntered = true
      await expireMeasurements(1)
      first = await within(firstPending, 400, 'the first project did not receive its partial result')
      second = await within(storageSpaceSummary(secondSlug), 400, 'the second project did not reuse the shared result')
      assert.equal(libraryAttempts, 1, 'different slugs must share the same still-running whole-Library traversal')
    } finally {
      release.resolve()
      if (seamEntered) await within(lateCallSettled.promise, 400, 'the released shared traversal did not settle')
      await within(firstPending, 400, 'the first shared result did not drain')
      blocking = false
    }

    assert.equal(first!.library_trash_bytes, null)
    assert.equal(second!.library_trash_bytes, null)
    assert.equal(first!.project_trash_bytes, 24)
    assert.equal(second!.project_trash_bytes, 0)
    assert.deepEqual(await treeSnapshot(fixtureRoot), baselineSnapshot, 'shared measurement must remain read-only')
  })

  test('retains coalescing until every started root walk settles after a sibling errors', async t => {
    const release = deferred()
    const bothBlockedWalksSettled = deferred()
    const bothBlockedWalksEntered = deferred()
    const originalReaddir = fs.readdir.bind(fs)
    const originalStatfs = fs.statfs.bind(fs)
    const projectLibraryTrash = path.join(libraryTrash, slug)
    const oldProjectTrash = path.join(projectDir, '_trash')
    let blockedWalks = 0
    let settledWalks = 0
    let blocking = true
    t.mock.method(fs, 'statfs', async (...args: Parameters<typeof fs.statfs>) => {
      if (path.resolve(String(args[0])) !== path.resolve(projectDir)) return originalStatfs(...args)
      return { bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof fs.statfs>>
    })
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      const target = path.resolve(String(args[0]))
      if (blocking && target === path.resolve(oldProjectTrash)) {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' })
      }
      if (!blocking || target !== path.resolve(projectLibraryTrash)) return originalReaddir(...args)
      blockedWalks++
      if (blockedWalks === 2) bothBlockedWalksEntered.resolve()
      try {
        await release.promise
        return await originalReaddir(...args)
      } finally {
        settledWalks++
        if (settledWalks === 2) bothBlockedWalksSettled.resolve()
      }
    })

    const firstPending = storageSpaceSummary(slug)
    let first: PartialSpaceSummary | undefined
    let second: PartialSpaceSummary | undefined
    try {
      await within(bothBlockedWalksEntered.promise, 400, 'both root walks must enter before advancing their deadlines')
      await expireMeasurements(2)
      first = await within(firstPending, 400, 'the mixed error/pending summary did not return its bounded result')
      second = await within(storageSpaceSummary(slug), 400, 'the repeated mixed-root summary did not reuse in-flight work')
      assert.equal(blockedWalks, 2, 'project and shared Library phases each start one walk, then remain coalesced')
    } finally {
      release.resolve()
      await within(bothBlockedWalksSettled.promise, 400, 'not every started root walk settled after release')
      await within(firstPending, 400, 'the first mixed-root result did not drain')
      blocking = false
    }

    assert.equal(first!.project_trash_bytes, null)
    assert.equal(first!.library_trash_bytes, null)
    assert.equal(second!.project_trash_bytes, null)
    assert.equal(second!.library_trash_bytes, null)
    assert.equal(blockedWalks, 2, 'a sibling error must not evict the phase while another started walk remains live')
    assert.deepEqual(await treeSnapshot(fixtureRoot), baselineSnapshot, 'mixed-root error handling must remain read-only')
  })

  test('reports unreadable Trash as unknown but a missing Trash branch as measured zero', async t => {
    const originalReaddir = fs.readdir.bind(fs)
    const originalStatfs = fs.statfs.bind(fs)
    const oldProjectTrash = path.join(projectDir, '_trash')
    let fault: 'EACCES' | 'ENOENT' | null = 'EACCES'
    t.mock.method(fs, 'statfs', async (...args: Parameters<typeof fs.statfs>) => {
      if (path.resolve(String(args[0])) !== path.resolve(projectDir)) return originalStatfs(...args)
      return { bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof fs.statfs>>
    })
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (fault && path.resolve(String(args[0])) === path.resolve(oldProjectTrash)) {
        throw Object.assign(new Error(`simulated ${fault}`), { code: fault })
      }
      return originalReaddir(...args)
    })

    const unreadable = await within(storageSpaceSummary(slug), 400, 'unreadable Trash did not return a bounded result')
    assert.equal(unreadable.project_trash_bytes, null)
    assert.equal(unreadable.library_trash_bytes, null)

    fault = 'ENOENT'
    const missing = await within(storageSpaceSummary(slug), 400, 'missing Trash did not return a measured result')
    assert.deepEqual(missing, {
      free_bytes: 4096,
      project_trash_bytes: 11,
      library_trash_bytes: 11,
      app_trash_bytes: 17,
    })
    fault = null
    assert.deepEqual(await treeSnapshot(fixtureRoot), baselineSnapshot, 'error handling must not mutate the retained fixture')
  })
})
