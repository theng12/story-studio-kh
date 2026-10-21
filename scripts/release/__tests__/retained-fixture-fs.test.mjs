/**
 * Contract tests for the runner-only retained-fixture filesystem preload.
 *
 * Every fixture is created under this project's `_trash/` and deliberately
 * retained. The preload is exercised only in fresh child processes with an
 * exact private sandbox and a separate same-device snapshot root.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ADAPTER = path.join(ROOT, 'scripts', 'testing', 'retained-fixture-fs.mjs')
const RETAINED_PARENT = path.join(ROOT, '_trash', 'test-fixtures')
const BARRIER_CONTROL = '.retained-fixture-fs-test-barrier.json'
const BARRIER_REACHED = '.retained-fixture-fs-test-barrier-reached.json'
const BARRIER_RESUME = '.retained-fixture-fs-test-barrier-resume'
const BOOTSTRAP_PARENT_PREFIX = '.retained-fixture-fs-bootstrap-'
const BOOTSTRAP_ABSENT_CHILD = 'absent'
const OLD_ASYNC_LOCK_TIMEOUT_MS = 5_000
// The same absolute backstop the shared backend helper uses (_timing.ts
// DEFAULT_MAX_WALL_CLOCK_MS). A scheduled-time budget stretches under load, so
// a stuck condition still needs a wall-clock cap or it would hang the run.
const MAX_WALL_CLOCK_MS = 120_000
await fs.mkdir(RETAINED_PARENT, { recursive: true, mode: 0o700 })
const RUN_ROOT = await fs.realpath(await fs.mkdtemp(path.join(RETAINED_PARENT, 'retained-fixture-fs-contract-')))
await fs.chmod(RUN_ROOT, 0o700)
console.log(`[retained-fixture-fs] retained contract fixtures: ${RUN_ROOT}`)

let childNumber = 0

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function makeCase(label) {
  const root = await fs.mkdtemp(path.join(RUN_ROOT, `${label}-`))
  const sandbox = path.join(root, 'sandbox')
  const snapshots = path.join(root, 'snapshots')
  await fs.mkdir(sandbox, { mode: 0o700 })
  await fs.mkdir(snapshots, { mode: 0o700 })
  const [sandboxStat, snapshotsStat] = await Promise.all([fs.lstat(sandbox), fs.lstat(snapshots)])
  assert.equal(sandboxStat.dev, snapshotsStat.dev, 'fixture and snapshot roots must share a device')
  return { root, sandbox, snapshots }
}

async function runChild(fixture, source, {
  adapter = true,
  env: extraEnv = {},
  afterSpawn,
  preloadSource,
  timeoutMs = 10_000,
} = {}) {
  const script = path.join(fixture.root, `driver-${String(++childNumber).padStart(3, '0')}.mjs`)
  await fs.writeFile(script, source, { mode: 0o600 })
  const env = {
    ...process.env,
    STORY_STUDIO_TEST_HARNESS_ROOT: fixture.sandbox,
    STORY_STUDIO_RETAINED_SNAPSHOT_ROOT: fixture.snapshots,
    ...extraEnv,
  }
  delete env.NODE_TEST_CONTEXT
  const preloads = []
  if (preloadSource) {
    const preload = path.join(fixture.root, `native-dispatch-${String(childNumber).padStart(3, '0')}.mjs`)
    await fs.writeFile(preload, preloadSource, { mode: 0o600 })
    preloads.push(pathToFileURL(preload).href)
  }
  if (adapter) preloads.push(pathToFileURL(ADAPTER).href)
  if (preloads.length) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, ...preloads.map(file => `--import ${file}`)].filter(Boolean).join(' ')
  }

  const child = spawn(process.execPath, [script], {
    cwd: fixture.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  let childError
  const closed = new Promise(resolve => {
    child.once('error', error => {
      childError = error
      clearTimeout(watchdog)
    })
    child.once('close', (code, signal) => {
      clearTimeout(watchdog)
      resolve({ code, signal })
    })
  })
  try {
    if (afterSpawn) await afterSpawn({ child })
    const { code, signal } = await closed
    const exitCode = code ?? 1
    if (childError) throw childError
    if (timedOut) throw new Error(`retained-fixture child timed out after ${timeoutMs}ms; evidence: ${fixture.root}`)
    if (!adapter) {
      const manifests = (await fs.readdir(fixture.snapshots)).filter(name => /^manifest-.*\.jsonl$/.test(name))
      assert.deepEqual(manifests, [],
        'native control incompatible with inherited retained adapter: expected zero manifest files, including empty files')
      assert.equal(exitCode, 0, `native control child failed; inherited preload may be incompatible:\n${stderr || stdout}`)
    }
    return { exitCode, code, signal, stdout, stderr }
  } catch (error) {
    if (!child.killed) child.kill('SIGKILL')
    await closed
    throw error
  } finally {
    clearTimeout(watchdog)
  }
}

async function waitForFile(file, timeoutMs = 5_000) {
  // Poll for the barrier on a SCHEDULED-time budget, not on the wall clock:
  // the barrier is written by a child process, so a loaded machine can push
  // the write past a wall-clock ceiling that says nothing about the product.
  // The budget decides pass or fail; the absolute wall-clock cap is a
  // backstop so a stuck condition can never hang the run.
  const started = Date.now()
  let budgetMs = timeoutMs
  let cappedOut = false
  const pollMs = 10
  for (;;) {
    try {
      await fs.access(file)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const before = Date.now()
    await delay(pollMs)
    // Credit back only the part we did not ask for: the scheduler delay.
    budgetMs += Math.max(0, Date.now() - before - pollMs)
    const elapsed = Date.now() - started
    if (elapsed >= MAX_WALL_CLOCK_MS) { cappedOut = true; break }
    if (elapsed >= budgetMs) break
  }
  const waited = Date.now() - started
  throw new Error(cappedOut
    ? `timed out waiting for retained-fixture barrier: ${file}; hit the ${MAX_WALL_CLOCK_MS}ms wall-clock backstop after ${waited}ms`
    : `timed out waiting for retained-fixture barrier: ${file}`)
}

async function configureBarrier(fixture, phase) {
  assert.ok(['after-baseline', 'before-final-verification'].includes(phase))
  await fs.writeFile(
    path.join(fixture.snapshots, BARRIER_CONTROL),
    `${JSON.stringify({ phase })}\n`,
    { flag: 'wx', mode: 0o600 },
  )
}

async function crossBarrier(fixture, phase, action) {
  const reached = path.join(fixture.snapshots, BARRIER_REACHED)
  await waitForFile(reached)
  const checkpoint = JSON.parse(await fs.readFile(reached, 'utf8'))
  assert.equal(checkpoint.phase, phase)
  await action(checkpoint)
  await fs.writeFile(path.join(fixture.snapshots, BARRIER_RESUME), `${phase}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}

function lastJson(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean)
  return JSON.parse(lines.at(-1))
}

async function records(fixture) {
  const names = (await fs.readdir(fixture.snapshots)).filter(name => /^manifest-.*\.jsonl$/.test(name)).sort()
  const out = []
  for (const name of names) {
    const raw = await fs.readFile(path.join(fixture.snapshots, name), 'utf8')
    for (const line of raw.split('\n').filter(Boolean)) out.push(JSON.parse(line))
  }
  return out
}

async function optionalJsonLines(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function collectorFailure(fixture) {
  const { retainedFsEvidenceFailure } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
  )
  return retainedFsEvidenceFailure(fixture.snapshots)
}

async function waitUntil(deadline) {
  while (Date.now() < deadline) await delay(Math.min(25, deadline - Date.now()))
}

async function holdGlobalCapture(fixture, target) {
  await configureBarrier(fixture, 'after-baseline')
  let child
  const result = runChild(fixture, `
    import fs from 'node:fs/promises'
    await fs.unlink(${JSON.stringify(target)})
  `, { afterSpawn: async value => { child = value.child } })
  const reached = path.join(fixture.snapshots, BARRIER_REACHED)
  await waitForFile(reached)
  const checkpoint = JSON.parse(await fs.readFile(reached, 'utf8'))
  assert.equal(checkpoint.phase, 'after-baseline')
  assert.equal(checkpoint.target, path.relative(fixture.sandbox, target).split(path.sep).join('/'))
  await fs.rename(
    path.join(fixture.snapshots, BARRIER_CONTROL),
    path.join(fixture.snapshots, `retained-${BARRIER_CONTROL}`),
  )
  let released = false
  return {
    child,
    result,
    async release() {
      if (!released) {
        released = true
        await fs.writeFile(path.join(fixture.snapshots, BARRIER_RESUME), 'after-baseline\n', {
          flag: 'wx',
          mode: 0o600,
        })
      }
      return result
    },
  }
}

function holdingPromiseUnlinkPreload(readyFile) {
  return `
    import nativeFs from 'node:fs'
    import nativePromises from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    nativePromises.unlink = function heldUnlink() {
      nativeFs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid), { flag: 'wx' })
      return new Promise(() => {})
    }
    nativeFs.promises.unlink = nativePromises.unlink
    syncBuiltinESMExports()
  `
}

function assertProcessGone(pid) {
  assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH')
}

function refusingPromiseUnlinkPreload(attemptFile) {
  return `
    import nativeFs from 'node:fs'
    import nativePromises from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const append = nativeFs.appendFileSync.bind(nativeFs)
    const refuse = async target => {
      append(${JSON.stringify(attemptFile)}, JSON.stringify({
        kind: Buffer.isBuffer(target) ? 'buffer' : typeof target,
        target: Buffer.isBuffer(target) ? target.toString('hex') : String(target),
      }) + '\\n')
      const error = new Error('test native unlink refused before deletion')
      error.code = 'ERR_TEST_NATIVE_DISPATCH_REFUSED'
      throw error
    }
    nativePromises.unlink = refuse
    nativeFs.promises.unlink = refuse
    syncBuiltinESMExports()
  `
}

function guardedCallbackRmPreload(fixture, attemptFile) {
  return `
    import nativeFs from 'node:fs'
    import nativePath from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const originalRm = nativeFs.rm
    const append = nativeFs.appendFileSync.bind(nativeFs)
    const sandbox = nativeFs.realpathSync(${JSON.stringify(fixture.sandbox)})
    const sandboxStat = nativeFs.lstatSync(sandbox)
    function isSafeBootstrap(target, args) {
      if (typeof target !== 'string' || args.length !== 2 || typeof args[1] !== 'function') return false
      const options = args[0]
      if (!options || Object.keys(options).length !== 1 || options.force !== true) return false
      const parent = nativePath.dirname(target)
      if (nativePath.dirname(parent) !== sandbox
        || !nativePath.basename(parent).startsWith(${JSON.stringify(BOOTSTRAP_PARENT_PREFIX)})
        || nativePath.basename(target) !== ${JSON.stringify(BOOTSTRAP_ABSENT_CHILD)}) return false
      try {
        nativeFs.lstatSync(target)
        return false
      } catch (error) {
        if (error?.code !== 'ENOENT') return false
      }
      try {
        const parentStat = nativeFs.lstatSync(parent)
        return parentStat.isDirectory()
          && !parentStat.isSymbolicLink()
          && (parentStat.mode & 0o777) === 0o700
          && parentStat.dev === sandboxStat.dev
          && (typeof process.getuid !== 'function' || parentStat.uid === process.getuid())
      } catch { return false }
    }
    nativeFs.rm = function guardedRm(target, ...args) {
      if (isSafeBootstrap(target, args)) {
        append(${JSON.stringify(attemptFile)}, JSON.stringify({ kind: 'bootstrap', allowed: true }) + '\\n')
        return Reflect.apply(originalRm, this, [target, ...args])
      }
      append(${JSON.stringify(attemptFile)}, JSON.stringify({
        kind: 'uncaptured-target',
        target: Buffer.isBuffer(target) ? target.toString('hex') : String(target),
        argumentTypes: args.map(value => typeof value),
      }) + '\\n')
      const error = new Error('test native rm refused before uncaptured deletion')
      error.code = 'ERR_TEST_NATIVE_DISPATCH_REFUSED'
      throw error
    }
    syncBuiltinESMExports()
  `
}

function guardedCallbackUnlinkPreload(fixture, attemptFile) {
  return `
    import nativeFs from 'node:fs'
    import nativePath from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const originalUnlink = nativeFs.unlink
    const append = nativeFs.appendFileSync.bind(nativeFs)
    const read = nativeFs.readFileSync.bind(nativeFs)
    const readdir = nativeFs.readdirSync.bind(nativeFs)
    function hasCompleteProof(target) {
      try {
        const matches = []
        for (const name of readdir(${JSON.stringify(fixture.snapshots)}).filter(name => /^manifest-.*\\.jsonl$/.test(name))) {
          const raw = read(nativePath.join(${JSON.stringify(fixture.snapshots)}, name), 'utf8')
          if (!raw.endsWith('\\n')) return false
          for (const line of raw.split('\\n').filter(Boolean)) {
            const record = JSON.parse(line)
            if (record.phase === 'snapshot-verified' && record.operation === 'unlink' && record.api === 'callback') {
              matches.push(record)
            }
          }
        }
        if (matches.length !== 1) return false
        const record = matches[0]
        const payload = nativePath.join(${JSON.stringify(fixture.snapshots)}, record.snapshot, record.payload)
        return Buffer.from(read(payload)).equals(Buffer.from(read(target)))
      } catch { return false }
    }
    nativeFs.unlink = function guardedUnlink(target, callback, ...trailing) {
      const proven = hasCompleteProof(target)
      append(${JSON.stringify(attemptFile)}, JSON.stringify({ proven, trailing: trailing.map(value => typeof value) }) + '\\n')
      if (!proven) {
        const error = new Error('test native unlink refused without a complete matching snapshot')
        error.code = 'ERR_TEST_NATIVE_DISPATCH_REFUSED'
        process.nextTick(() => callback(error))
        return undefined
      }
      return Reflect.apply(originalUnlink, this, [target, callback, ...trailing])
    }
    syncBuiltinESMExports()
  `
}

function guardedShortWriteRmPreload(fixture, attemptFile, writeBehavior) {
  assert.ok(['short-once', 'zero-once'].includes(writeBehavior))
  return `
    import nativeFs from 'node:fs'
    import nativePromises from 'node:fs/promises'
    import nativePath from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const originalOpen = nativeFs.openSync
    const originalWrite = nativeFs.writeSync
    const originalRm = nativePromises.rm
    const append = nativeFs.appendFileSync.bind(nativeFs)
    const read = nativeFs.readFileSync.bind(nativeFs)
    const readdir = nativeFs.readdirSync.bind(nativeFs)
    const manifests = new Set()
    let injected = false
    nativeFs.openSync = function trackedOpen(file, ...args) {
      const descriptor = Reflect.apply(originalOpen, this, [file, ...args])
      if (/manifest-.*\\.jsonl$/.test(String(file))) manifests.add(descriptor)
      return descriptor
    }
    nativeFs.writeSync = function controlledWrite(descriptor, data, ...args) {
      const offset = typeof data === 'string' ? 0 : (args[0] ?? 0)
      const length = typeof data === 'string'
        ? Buffer.byteLength(data, typeof args[1] === 'string' ? args[1] : 'utf8')
        : (args[1] ?? data.byteLength - offset)
      const bytes = typeof data === 'string'
        ? Buffer.from(data, typeof args[1] === 'string' ? args[1] : 'utf8')
        : Buffer.from(data.buffer, data.byteOffset + offset, length)
      if (!injected && manifests.has(descriptor) && bytes.includes(Buffer.from('"phase":"snapshot-verified"'))) {
        injected = true
        if (${JSON.stringify(writeBehavior)} === 'zero-once') return 0
        const shortLength = Math.max(1, Math.floor(bytes.byteLength / 2))
        return originalWrite(descriptor, bytes, 0, shortLength)
      }
      return Reflect.apply(originalWrite, this, [descriptor, data, ...args])
    }
    function hasCompleteProof(target) {
      try {
        const matches = []
        for (const name of readdir(${JSON.stringify(fixture.snapshots)}).filter(name => /^manifest-.*\\.jsonl$/.test(name))) {
          const raw = read(nativePath.join(${JSON.stringify(fixture.snapshots)}, name), 'utf8')
          if (!raw.endsWith('\\n')) return false
          for (const line of raw.split('\\n').filter(Boolean)) {
            const record = JSON.parse(line)
            if (record.phase === 'snapshot-verified' && record.operation === 'rm' && record.api === 'promise') {
              matches.push(record)
            }
          }
        }
        if (matches.length !== 1) return false
        const record = matches[0]
        const payload = nativePath.join(${JSON.stringify(fixture.snapshots)}, record.snapshot, record.payload)
        return Buffer.from(read(payload)).equals(Buffer.from(read(target)))
      } catch { return false }
    }
    nativePromises.rm = async function guardedRm(target, ...args) {
      const proven = hasCompleteProof(target)
      append(${JSON.stringify(attemptFile)}, JSON.stringify({ proven }) + '\\n')
      if (!proven) {
        const error = new Error('test native rm refused without a complete matching snapshot')
        error.code = 'ERR_TEST_NATIVE_DISPATCH_REFUSED'
        throw error
      }
      return Reflect.apply(originalRm, this, [target, ...args])
    }
    nativeFs.promises.rm = nativePromises.rm
    syncBuiltinESMExports()
  `
}

async function verifiedFor(fixture, target, operation) {
  const relative = path.relative(fixture.sandbox, target).split(path.sep).join('/') || '.'
  const matches = (await records(fixture)).filter(record => record.phase === 'snapshot-verified'
    && record.operation === operation && record.target === relative)
  assert.equal(matches.length, 1, `expected one verified ${operation} snapshot for ${relative}`)
  return matches[0]
}

async function snapshotPayload(fixture, record) {
  assert.equal(record.payload, 'payload')
  return path.join(fixture.snapshots, record.snapshot, record.payload)
}

async function assertMissing(target) {
  await assert.rejects(fs.lstat(target), error => error?.code === 'ENOENT')
}

test('promise rm preserves exact file bytes before the original path disappears', async () => {
  const fixture = await makeCase('promise-file')
  const target = path.join(fixture.sandbox, 'fixture.bin')
  const bytes = Buffer.from([0, 1, 2, 3, 254, 255, 10, 13])
  await fs.writeFile(target, bytes)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    await fs.rm(${JSON.stringify(target)})
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'rm')
  assert.equal(receipt.api, 'promise')
  assert.equal(receipt.sourceInventory.entries[0].sha256, sha256(bytes))
  assert.deepEqual(receipt.sourceInventory.entries, receipt.snapshotInventory.entries)
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, receipt)), bytes)
})

test('recursive rm preserves a verified tree and still performs the real prune', async () => {
  const fixture = await makeCase('recursive-tree')
  const target = path.join(fixture.sandbox, 'versions', '2026-10-15_010203')
  await fs.mkdir(path.join(target, 'nested'), { recursive: true })
  await fs.writeFile(path.join(target, 'root.txt'), 'root bytes\n')
  await fs.writeFile(path.join(target, 'nested', 'leaf.bin'), Buffer.from([9, 8, 7, 6]))

  const result = await runChild(fixture, `
    import { rm } from 'node:fs/promises'
    await rm(${JSON.stringify(target)}, { recursive: true })
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'rm')
  const payload = await snapshotPayload(fixture, receipt)
  assert.equal(await fs.readFile(path.join(payload, 'root.txt'), 'utf8'), 'root bytes\n')
  assert.deepEqual(await fs.readFile(path.join(payload, 'nested', 'leaf.bin')), Buffer.from([9, 8, 7, 6]))
  assert.deepEqual(receipt.sourceInventory.entries, receipt.snapshotInventory.entries)
})

test('recursive rm retains a symbolic link as an object without following or copying its target', async () => {
  const fixture = await makeCase('recursive-symlink')
  const tree = path.join(fixture.sandbox, 'tree')
  const outsideDirectory = path.join(fixture.sandbox, 'outside')
  const secret = path.join(outsideDirectory, 'secret.txt')
  await fs.mkdir(tree)
  await fs.mkdir(outsideDirectory)
  await fs.writeFile(secret, 'must never be copied\n')
  await fs.symlink('../outside/secret.txt', path.join(tree, 'escape-link'))
  await fs.symlink('../outside', path.join(tree, 'relative-link'))

  const result = await runChild(fixture, `
    import { rm } from 'node:fs/promises'
    await rm(${JSON.stringify(tree)}, { recursive: true })
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  await assertMissing(tree)
  assert.equal(await fs.readFile(secret, 'utf8'), 'must never be copied\n')
  const receipt = await verifiedFor(fixture, tree, 'rm')
  assert.deepEqual(receipt.sourceInventory.entries.filter(entry => entry.type === 'symlink'), [
    { path: 'escape-link', type: 'symlink', target: '../outside/secret.txt' },
    { path: 'relative-link', type: 'symlink', target: '../outside' },
  ])
  assert.deepEqual(receipt.sourceInventory.entries, receipt.snapshotInventory.entries)
  const payload = await snapshotPayload(fixture, receipt)
  assert.deepEqual((await fs.readdir(payload)).sort(), ['escape-link', 'relative-link'])
  assert.equal((await fs.lstat(path.join(payload, 'escape-link'))).isSymbolicLink(), true)
  assert.equal(await fs.readlink(path.join(payload, 'escape-link')), '../outside/secret.txt')
  assert.equal(await fs.readlink(path.join(payload, 'relative-link')), '../outside')
  assert.equal(await collectorFailure(fixture), null)
})

test('a worker thread creates no unsettleable manifest and refuses retained destructive work', async () => {
  const fixture = await makeCase('worker-thread')
  const target = path.join(fixture.sandbox, 'worker-target.txt')
  await fs.writeFile(target, 'keep\n')
  const workerPath = path.join(fixture.root, 'retained-worker.mjs')
  await fs.writeFile(workerPath, `
    import fs from 'node:fs'
    import { parentPort, isMainThread } from 'node:worker_threads'
    let outcome = 'allowed'
    try {
      fs.rmSync(${JSON.stringify(target)}, { recursive: true })
    } catch (error) {
      outcome = error.code
    }
    parentPort.postMessage({
      outcome,
      isMainThread,
      targetSurvived: fs.existsSync(${JSON.stringify(target)}),
    })
  `, { mode: 0o600 })

  // A file-backed worker with `execArgv: []` is esbuild's transformSync shape:
  // NODE_OPTIONS still evaluates the preload in the worker, which must not claim
  // a second process manifest it can never settle.
  const result = await runChild(fixture, `
    import { Worker } from 'node:worker_threads'
    const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(workerPath).href)}), { execArgv: [] })
    const message = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => { if (code !== 0) reject(new Error('worker exit ' + code)) })
    })
    console.log(JSON.stringify(message))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const outcome = lastJson(result.stdout)
  assert.equal(outcome.isMainThread, false)
  assert.equal(outcome.outcome, 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED')
  assert.equal(outcome.targetSurvived, true)
  assert.equal(await fs.readFile(target, 'utf8'), 'keep\n')
  const manifests = (await fs.readdir(fixture.snapshots)).filter(name => /^manifest-.*\.jsonl$/.test(name))
  assert.equal(manifests.length, 1, 'only the main thread owns durable process evidence')
  assert.equal(await collectorFailure(fixture), null)
})

test('rename replacement preserves the old destination and keeps native rename semantics', async () => {
  const fixture = await makeCase('rename-replacement')
  const source = path.join(fixture.sandbox, 'replacement.txt')
  const destination = path.join(fixture.sandbox, 'current.txt')
  await fs.writeFile(source, 'new bytes\n')
  await fs.writeFile(destination, 'old bytes\n')

  const result = await runChild(fixture, `
    import { rename } from 'node:fs/promises'
    await rename(${JSON.stringify(source)}, ${JSON.stringify(destination)})
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  await assertMissing(source)
  assert.equal(await fs.readFile(destination, 'utf8'), 'new bytes\n')
  const receipt = await verifiedFor(fixture, destination, 'rename')
  assert.equal(receipt.source, path.relative(fixture.sandbox, source).split(path.sep).join('/'))
  assert.equal(await fs.readFile(await snapshotPayload(fixture, receipt), 'utf8'), 'old bytes\n')
})

test('default, named, CommonJS, callback, sync, promise, Buffer and URL aliases are intercepted', async () => {
  const fixture = await makeCase('api-aliases')
  const p = name => path.join(fixture.sandbox, name)
  const paths = {
    callbackRm: p('callback-rm.txt'),
    namedCallbackUnlink: p('named-callback-unlink.txt'),
    callbackRenameSource: p('callback-rename-source.txt'),
    callbackRenameDestination: p('callback-rename-destination.txt'),
    syncRm: p('sync-rm.txt'),
    syncUnlink: p('sync-unlink.txt'),
    syncRmdir: p('sync-rmdir'),
    namedSyncRenameSource: p('named-sync-rename-source.txt'),
    namedSyncRenameDestination: p('named-sync-rename-destination.txt'),
    defaultPromiseRm: p('default-promise-rm'),
    namedPromiseUnlink: p('named-promise-unlink.txt'),
    promiseRmdir: p('promise-rmdir'),
    cjsRmdir: p('cjs-rmdir'),
    cjsPromiseRenameSource: p('cjs-promise-rename-source.txt'),
    cjsPromiseRenameDestination: p('cjs-promise-rename-destination.txt'),
  }
  for (const target of [
    paths.callbackRm,
    paths.namedCallbackUnlink,
    paths.callbackRenameSource,
    paths.callbackRenameDestination,
    paths.syncRm,
    paths.syncUnlink,
    paths.namedSyncRenameSource,
    paths.namedSyncRenameDestination,
    paths.namedPromiseUnlink,
    paths.cjsPromiseRenameSource,
    paths.cjsPromiseRenameDestination,
  ]) await fs.writeFile(target, path.basename(target))
  for (const target of [
    paths.syncRmdir,
    paths.defaultPromiseRm,
    paths.promiseRmdir,
    paths.cjsRmdir,
  ]) await fs.mkdir(target)

  const result = await runChild(fixture, `
    import fsDefault, { unlink as namedCallbackUnlink, rename as namedCallbackRename,
      unlinkSync, rmdirSync, renameSync } from 'node:fs'
    import fsPromisesDefault, { unlink as namedPromiseUnlink, rmdir as namedPromiseRmdir } from 'node:fs/promises'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    const paths = ${JSON.stringify(paths)}
    const require = createRequire(import.meta.url)
    const cjsFs = require('fs')
    const cjsPromises = require('fs/promises')
    const callback = start => new Promise((resolve, reject) => start(error => error ? reject(error) : resolve()))

    await callback(done => fsDefault.rm(paths.callbackRm, done))
    await callback(done => namedCallbackUnlink(Buffer.from(paths.namedCallbackUnlink), done))
    await callback(done => namedCallbackRename(paths.callbackRenameSource, paths.callbackRenameDestination, done))
    fsDefault.rmSync(paths.syncRm)
    unlinkSync(paths.syncUnlink)
    rmdirSync(paths.syncRmdir)
    renameSync(paths.namedSyncRenameSource, paths.namedSyncRenameDestination)
    await fsPromisesDefault.rm(paths.defaultPromiseRm, { recursive: true })
    await namedPromiseUnlink(pathToFileURL(paths.namedPromiseUnlink))
    await namedPromiseRmdir(paths.promiseRmdir)
    await callback(done => cjsFs.rmdir(paths.cjsRmdir, done))
    await cjsPromises.rename(paths.cjsPromiseRenameSource, paths.cjsPromiseRenameDestination)
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  for (const target of [
    paths.callbackRm,
    paths.namedCallbackUnlink,
    paths.callbackRenameSource,
    paths.syncRm,
    paths.syncUnlink,
    paths.syncRmdir,
    paths.namedSyncRenameSource,
    paths.defaultPromiseRm,
    paths.namedPromiseUnlink,
    paths.promiseRmdir,
    paths.cjsRmdir,
    paths.cjsPromiseRenameSource,
  ]) await assertMissing(target)
  assert.equal(await fs.readFile(paths.callbackRenameDestination, 'utf8'), 'callback-rename-source.txt')
  assert.equal(await fs.readFile(paths.namedSyncRenameDestination, 'utf8'), 'named-sync-rename-source.txt')
  assert.equal(await fs.readFile(paths.cjsPromiseRenameDestination, 'utf8'), 'cjs-promise-rename-source.txt')
  const verified = (await records(fixture)).filter(record => record.phase === 'snapshot-verified')
  assert.equal(verified.length, 12)
  assert.deepEqual(new Set(verified.map(record => record.api)), new Set(['callback', 'sync', 'promise']))
})

test('missing paths, force options and nonempty rmdir match the unadapted Node results', async () => {
  async function exercise(adapter) {
    const fixture = await makeCase(adapter ? 'native-semantics-adapted' : 'native-semantics-control')
    const nonempty = path.join(fixture.sandbox, 'nonempty')
    const missing = path.join(fixture.sandbox, 'missing')
    await fs.mkdir(nonempty)
    await fs.writeFile(path.join(nonempty, 'kept.txt'), 'kept\n')
    const result = await runChild(fixture, `
      import fs from 'node:fs/promises'
      const capture = async operation => {
        try { await operation(); return { ok: true } }
        catch (error) { return { ok: false, name: error.name, code: error.code } }
      }
      const outcomes = {
        nonempty: await capture(() => fs.rmdir(${JSON.stringify(nonempty)})),
        missingRmdir: await capture(() => fs.rmdir(${JSON.stringify(missing)})),
        missingRm: await capture(() => fs.rm(${JSON.stringify(missing)})),
        missingForcedRm: await capture(() => fs.rm(${JSON.stringify(missing)}, { force: true })),
      }
      console.log(JSON.stringify(outcomes))
    `, { adapter })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    return { fixture, nonempty, outcomes: lastJson(result.stdout) }
  }

  const control = await exercise(false)
  const adapted = await exercise(true)
  assert.deepEqual(adapted.outcomes, control.outcomes)
  assert.equal(await fs.readFile(path.join(adapted.nonempty, 'kept.txt'), 'utf8'), 'kept\n')
  await verifiedFor(adapted.fixture, adapted.nonempty, 'rmdir')
  assert.equal((await records(adapted.fixture)).filter(record => record.phase === 'snapshot-verified').length, 1,
    'missing paths have nothing to preserve')
})

test('invalid sync arguments and async callback errors match native outcomes without snapshots', async () => {
  async function invalidOutcome(adapter) {
    const fixture = await makeCase(adapter ? 'invalid-adapted' : 'invalid-control')
    const target = path.join(fixture.sandbox, 'must-stay.txt')
    const missing = path.join(fixture.sandbox, 'missing.txt')
    await fs.writeFile(target, 'must stay\n')
    const result = await runChild(fixture, `
      import fs from 'node:fs'
      const events = []
      const capture = operation => {
        try { operation(); events.push('returned'); return { threw: false } }
        catch (error) { events.push('threw'); return { threw: true, name: error.name, code: error.code } }
      }
      const noPath = capture(() => fs.rmSync())
      let sameTurn = true
      let calls = 0
      const missingCallback = await new Promise(resolve => {
        fs.rm(${JSON.stringify(missing)}, error => {
          calls += 1
          events.push(sameTurn ? 'callback-same-turn' : 'callback-later')
          resolve({ name: error?.name, code: error?.code })
        }, 123)
        events.push('after-call')
        sameTurn = false
      })
      console.log(JSON.stringify({ noPath, missingCallback, calls, events }))
    `, { adapter })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    assert.equal(await fs.readFile(target, 'utf8'), 'must stay\n')
    return { fixture, value: lastJson(result.stdout) }
  }

  const control = await invalidOutcome(false)
  const adapted = await invalidOutcome(true)
  assert.deepEqual(adapted.value, control.value)
  assert.equal(adapted.value.calls, 1)
  assert.deepEqual(adapted.value.events, ['threw', 'after-call', 'callback-later'])
  assert.equal((await records(adapted.fixture)).filter(record => record.phase === 'snapshot-verified').length, 0)
})

test('rm with a missing or nonfunction callback refuses before native dispatch', async () => {
  const fixture = await makeCase('invalid-rm-callback-refusal')
  const target = path.join(fixture.sandbox, 'must-stay.txt')
  const attemptFile = path.join(fixture.root, 'native-rm-dispatch.jsonl')
  const before = Buffer.from('missing callback must not remove these bytes\n')
  await fs.writeFile(target, before)
  const result = await runChild(fixture, `
    import fs from 'node:fs'
    const capture = operation => {
      try { operation(); return { ok: true } }
      catch (error) { return { ok: false, name: error.name, code: error.code } }
    }
    const outcomes = [
      capture(() => fs.rm(${JSON.stringify(target)})),
      capture(() => fs.rm(${JSON.stringify(target)}, { force: true }, 123)),
    ]
    console.log(JSON.stringify(outcomes))
  `, { preloadSource: guardedCallbackRmPreload(fixture, attemptFile) })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(await fs.readFile(target), before)
  assert.deepEqual(lastJson(result.stdout), Array(2).fill({
    ok: false,
    name: 'Error',
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  }))
  assert.deepEqual(await optionalJsonLines(attemptFile), [{ kind: 'bootstrap', allowed: true }])
  assert.equal((await records(fixture)).some(record => record.phase === 'snapshot-verified'), false)
})

test('callback completion stays asynchronous, ordered and single-shot', async () => {
  const fixture = await makeCase('callback-order')
  const target = path.join(fixture.sandbox, 'callback.txt')
  await fs.writeFile(target, 'callback bytes\n')
  const result = await runChild(fixture, `
    import fs from 'node:fs'
    const events = ['before']
    let sameTurn = true
    let calls = 0
    await new Promise((resolve, reject) => {
      fs.unlink(${JSON.stringify(target)}, error => {
        calls += 1
        events.push(sameTurn ? 'callback-same-turn' : 'callback-later')
        if (error) reject(error)
        else resolve()
      })
      events.push('after-call')
      sameTurn = false
    })
    events.push('after-await')
    console.log(JSON.stringify({ calls, events }))
  `)
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), {
    calls: 1,
    events: ['before', 'after-call', 'callback-later', 'after-await'],
  })
  await assertMissing(target)
})

for (const trailing of [
  { label: 'nonfunction', source: '123', expectedType: 'number' },
  { label: 'function', source: '() => { extraCalls += 1 }', expectedType: 'function' },
]) {
  test(`callback unlink preserves its fixed callback slot with a trailing ${trailing.label} argument`, async () => {
    const fixture = await makeCase(`callback-trailing-${trailing.label}`)
    const target = path.join(fixture.sandbox, 'callback.txt')
    const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
    const before = Buffer.from(`callback bytes with trailing ${trailing.label}\n`)
    await fs.writeFile(target, before)
    const result = await runChild(fixture, `
      import fs from 'node:fs'
      const events = ['before']
      let sameTurn = true
      let calls = 0
      let extraCalls = 0
      const outcome = await new Promise(resolve => {
        fs.unlink(${JSON.stringify(target)}, error => {
          calls += 1
          events.push(sameTurn ? 'callback-same-turn' : 'callback-later')
          resolve({ error: error?.code ?? null })
        }, ${trailing.source})
        events.push('after-call')
        sameTurn = false
      })
      events.push('after-await')
      console.log(JSON.stringify({ ...outcome, calls, extraCalls, events }))
    `, { preloadSource: guardedCallbackUnlinkPreload(fixture, attemptFile) })

    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    assert.deepEqual(lastJson(result.stdout), {
      error: null,
      calls: 1,
      extraCalls: 0,
      events: ['before', 'after-call', 'callback-later', 'after-await'],
    })
    await assertMissing(target)
    assert.deepEqual(await optionalJsonLines(attemptFile), [{ proven: true, trailing: [trailing.expectedType] }])
    const receipt = await verifiedFor(fixture, target, 'unlink')
    assert.equal(receipt.api, 'callback')
    assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, receipt)), before)
    const evidence = await records(fixture)
    assert.equal(evidence.filter(record => record.phase === 'snapshot-verified'
      && record.receiptId === receipt.receiptId).length, 1)
    assert.equal(evidence.filter(record => record.phase === 'operation-settled'
      && record.receiptId === receipt.receiptId && record.outcome === 'success').length, 1)
    assert.equal(evidence.at(-1).phase, 'child-settled')
  })
}

test('snapshot failure refuses the real operation and emits no verified receipt', async () => {
  const fixture = await makeCase('snapshot-failure')
  const target = path.join(fixture.sandbox, 'must-survive.txt')
  await fs.writeFile(target, 'survives snapshot failure\n')
  const result = await runChild(fixture, `
    import fs from 'node:fs'
    import fsp from 'node:fs/promises'
    fs.chmodSync(${JSON.stringify(fixture.snapshots)}, 0o500)
    let outcome
    try { await fsp.rm(${JSON.stringify(target)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    finally { fs.chmodSync(${JSON.stringify(fixture.snapshots)}, 0o700) }
    console.log(JSON.stringify(outcome))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: false, code: 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT' })
  assert.equal(await fs.readFile(target, 'utf8'), 'survives snapshot failure\n')
  assert.equal((await records(fixture)).filter(record => record.phase === 'snapshot-verified').length, 0)
})

test('a positive short verified-receipt write is completed before native rm', async () => {
  const fixture = await makeCase('receipt-short-write')
  const target = path.join(fixture.sandbox, 'short-write.txt')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const before = Buffer.from('retained across a positive short receipt write\n')
  await fs.writeFile(target, before)
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rm(${JSON.stringify(target)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, {
    preloadSource: guardedShortWriteRmPreload(fixture, attemptFile, 'short-once'),
  })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: true })
  await assertMissing(target)
  assert.deepEqual(await optionalJsonLines(attemptFile), [{ proven: true }])
  const receipt = await verifiedFor(fixture, target, 'rm')
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, receipt)), before)
  const evidence = await records(fixture)
  assert.equal(evidence.filter(record => record.phase === 'operation-settled'
    && record.receiptId === receipt.receiptId && record.outcome === 'success').length, 1)
})

test('a zero-progress verified-receipt write refuses native rm and retains the target', async () => {
  const fixture = await makeCase('receipt-zero-write')
  const target = path.join(fixture.sandbox, 'zero-write.txt')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const before = Buffer.from('must survive a zero-progress receipt write\n')
  await fs.writeFile(target, before)
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rm(${JSON.stringify(target)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, {
    preloadSource: guardedShortWriteRmPreload(fixture, attemptFile, 'zero-once'),
  })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: false, code: 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT' })
  assert.deepEqual(await fs.readFile(target), before)
  assert.deepEqual(await optionalJsonLines(attemptFile), [], 'native rm must not be attempted without a complete receipt')
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'
    && record.code === 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT'), true)
})

test('a source mutation during capture refuses deletion and retains failure evidence', async () => {
  const fixture = await makeCase('source-mutation')
  const target = path.join(fixture.sandbox, 'changing-tree')
  await fs.mkdir(target)
  const changing = path.join(target, 'changing.txt')
  const before = Buffer.from('before\n')
  await fs.writeFile(changing, before)
  await configureBarrier(fixture, 'after-baseline')
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try {
      await fs.rm(${JSON.stringify(target)}, { recursive: true })
      outcome = { ok: true }
    } catch (error) {
      outcome = { ok: false, code: error.code }
    }
    console.log(JSON.stringify(outcome))
  `, {
    afterSpawn: () => crossBarrier(fixture, 'after-baseline', async checkpoint => {
      assert.equal(checkpoint.target, 'changing-tree')
      const entry = checkpoint.sourceInventory.entries.find(candidate => candidate.path === 'changing.txt')
      assert.equal(entry.sha256, sha256(before), 'the barrier must expose the pre-mutation baseline')
      await fs.appendFile(changing, 'during\n')
    }),
  })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: false, code: 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT' })
  assert.equal(await fs.readFile(changing, 'utf8'), 'before\nduring\n')
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'), true)
})

test('final verification failure happens before any verified receipt or real deletion', async () => {
  const fixture = await makeCase('final-verification')
  const target = path.join(fixture.sandbox, 'final-check.txt')
  const before = Buffer.from('captured before final check\n')
  await fs.writeFile(target, before)
  await configureBarrier(fixture, 'before-final-verification')
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rm(${JSON.stringify(target)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, {
    afterSpawn: () => crossBarrier(fixture, 'before-final-verification', async checkpoint => {
      assert.equal(checkpoint.target, 'final-check.txt')
      assert.equal(checkpoint.sourceInventory.entries[0].sha256, sha256(before))
      assert.deepEqual(checkpoint.sourceInventory.entries, checkpoint.snapshotInventory.entries)
      await fs.appendFile(target, 'changed before final verification\n')
    }),
  })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: false, code: 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT' })
  assert.equal(await fs.readFile(target, 'utf8'), 'captured before final check\nchanged before final verification\n')
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'), true)
})

test('outside, symlink, hardlink and snapshot-root targets are refused without changing bytes', async () => {
  const fixture = await makeCase('boundary-refusals')
  const outside = path.join(fixture.root, 'outside.txt')
  const outsideTarget = path.join(fixture.root, 'outside-target.txt')
  const symlink = path.join(fixture.sandbox, 'outside-link')
  const original = path.join(fixture.sandbox, 'original.txt')
  const hardlink = path.join(fixture.sandbox, 'hardlink.txt')
  await fs.writeFile(outside, 'outside\n')
  await fs.writeFile(outsideTarget, 'outside target\n')
  await fs.symlink(outsideTarget, symlink)
  await fs.writeFile(original, 'hardlinked bytes\n')
  await fs.link(original, hardlink)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    const targets = ${JSON.stringify([outside, symlink, hardlink, fixture.snapshots])}
    const outcomes = []
    for (const target of targets) {
      try { await fs.rm(target, { recursive: true, force: true }); outcomes.push({ ok: true }) }
      catch (error) { outcomes.push({ ok: false, code: error.code }) }
    }
    console.log(JSON.stringify(outcomes))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), Array(4).fill({
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  }))
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside\n')
  assert.equal(await fs.readFile(outsideTarget, 'utf8'), 'outside target\n')
  assert.equal((await fs.lstat(symlink)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(original, 'utf8'), 'hardlinked bytes\n')
  assert.equal(await fs.readFile(hardlink, 'utf8'), 'hardlinked bytes\n')
  assert.equal((await records(fixture)).some(record => record.phase === 'snapshot-verified'), false)
})

test('raw string and Buffer symlink-dotdot paths are refused before native dispatch', async () => {
  const fixture = await makeCase('raw-symlink-dotdot')
  const inside = path.join(fixture.sandbox, 'victim.txt')
  const outside = path.join(fixture.root, 'outside')
  const outsideChild = path.join(outside, 'child')
  const outsideVictim = path.join(outside, 'victim.txt')
  const link = path.join(fixture.sandbox, 'link')
  const rawTarget = `${link}${path.sep}..${path.sep}victim.txt`
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const insideBytes = Buffer.from('inside victim must remain\n')
  const outsideBytes = Buffer.from('outside victim must remain\n')
  await fs.mkdir(outsideChild, { recursive: true })
  await fs.writeFile(inside, insideBytes)
  await fs.writeFile(outsideVictim, outsideBytes)
  await fs.symlink(outsideChild, link, 'dir')

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    const outcomes = []
    for (const target of [${JSON.stringify(rawTarget)}, Buffer.from(${JSON.stringify(rawTarget)})]) {
      try { await fs.unlink(target); outcomes.push({ ok: true }) }
      catch (error) { outcomes.push({ ok: false, code: error.code }) }
    }
    console.log(JSON.stringify(outcomes))
  `, { preloadSource: refusingPromiseUnlinkPreload(attemptFile) })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), Array(2).fill({
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  }))
  assert.deepEqual(await fs.readFile(inside), insideBytes)
  assert.deepEqual(await fs.readFile(outsideVictim), outsideBytes)
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
  assert.deepEqual(await optionalJsonLines(attemptFile), [], 'raw unsafe paths must not reach native unlink')
  assert.equal((await records(fixture)).some(record => record.phase === 'snapshot-verified'), false)
})

test('a FIFO is refused promptly without a blocking source open', async () => {
  const fixture = await makeCase('fifo-refusal')
  const target = path.join(fixture.sandbox, 'fixture.fifo')
  const created = spawnSync('mkfifo', [target], { encoding: 'utf8' })
  assert.equal(created.status, 0, created.stderr)
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rm(${JSON.stringify(target)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, { timeoutMs: 5_000 })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: false, code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED' })
  assert.equal((await fs.lstat(target)).isFIFO(), true)
  assert.equal((await records(fixture)).some(record => record.phase === 'snapshot-verified'), false)
})

test('snapshot bytes are independent and made read-only after the original is recreated', async () => {
  const fixture = await makeCase('immutable-snapshot')
  const target = path.join(fixture.sandbox, 'mutable.txt')
  await fs.writeFile(target, 'original\n')
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    await fs.unlink(${JSON.stringify(target)})
    await fs.writeFile(${JSON.stringify(target)}, 'replacement\\n')
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const receipt = await verifiedFor(fixture, target, 'unlink')
  const payload = await snapshotPayload(fixture, receipt)
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement\n')
  assert.equal(await fs.readFile(payload, 'utf8'), 'original\n')
  assert.equal((await fs.lstat(payload)).mode & 0o222, 0, 'snapshot payload must have no write bit')
})

test('concurrent aliases of one target serialize to one snapshot and preserve both native outcomes', async () => {
  const fixture = await makeCase('alias-concurrency')
  const aliasDir = path.join(fixture.sandbox, 'alias')
  const target = path.join(fixture.sandbox, 'shared.txt')
  const alias = `${aliasDir}${path.sep}..${path.sep}shared.txt`
  await fs.mkdir(aliasDir)
  await fs.writeFile(target, 'one source\n')
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    import { pathToFileURL } from 'node:url'
    const outcomes = await Promise.all([
      fs.rm(${JSON.stringify(alias)}, { force: true }).then(() => 'ok', error => error.code),
      fs.rm(pathToFileURL(${JSON.stringify(target)}), { force: true }).then(() => 'ok', error => error.code),
    ])
    console.log(JSON.stringify(outcomes))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), ['ok', 'ok'])
  await assertMissing(target)
  const verified = (await records(fixture)).filter(record => record.phase === 'snapshot-verified'
    && record.target === 'shared.txt')
  assert.equal(verified.length, 1, 'one source state must never produce racing snapshots')
  assert.equal(await fs.readFile(await snapshotPayload(fixture, verified[0]), 'utf8'), 'one source\n')
})

test('async capture waits for a legitimate owner beyond the old five-second ceiling', async () => {
  const fixture = await makeCase('contention-beyond-old-ceiling')
  const ownerTarget = path.join(fixture.sandbox, 'owner.txt')
  const waitingTarget = path.join(fixture.sandbox, 'waiter.txt')
  const ready = path.join(fixture.root, 'waiter-ready')
  const ownerBytes = Buffer.from('global lock owner\n')
  const waitingBytes = Buffer.from('patient global lock waiter\n')
  await fs.writeFile(ownerTarget, ownerBytes)
  await fs.writeFile(waitingTarget, waitingBytes)

  const owner = await holdGlobalCapture(fixture, ownerTarget)
  let waitingChild
  const waiting = runChild(fixture, `
    import fs from 'node:fs/promises'
    const operation = fs.unlink(${JSON.stringify(waitingTarget)}).then(
      () => ({ ok: true }),
      error => ({ ok: false, code: error.code }),
    )
    await fs.writeFile(${JSON.stringify(ready)}, 'ready\\n', { flag: 'wx' })
    console.log(JSON.stringify(await operation))
  `, { afterSpawn: async value => { waitingChild = value.child } })

  await waitForFile(ready)
  await waitUntil(Date.now() + OLD_ASYNC_LOCK_TIMEOUT_MS + 250)
  const ownerResult = await owner.release()
  const waitingResult = await waiting

  assert.equal(ownerResult.exitCode, 0, ownerResult.stderr || ownerResult.stdout)
  assert.equal(waitingResult.exitCode, 0, waitingResult.stderr || waitingResult.stdout)
  assert.deepEqual(lastJson(waitingResult.stdout), { ok: true })
  await assertMissing(ownerTarget)
  await assertMissing(waitingTarget)
  const ownerReceipt = await verifiedFor(fixture, ownerTarget, 'unlink')
  const waitingReceipt = await verifiedFor(fixture, waitingTarget, 'unlink')
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, ownerReceipt)), ownerBytes)
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, waitingReceipt)), waitingBytes)
  const evidence = await records(fixture)
  for (const receipt of [ownerReceipt, waitingReceipt]) {
    assert.equal(evidence.filter(record => record.phase === 'operation-settled'
      && record.receiptId === receipt.receiptId && record.outcome === 'success').length, 1)
    const final = evidence.filter(record => record.pid === receipt.pid).at(-1)
    assert.equal(final.phase, 'child-settled')
    assert.equal(final.activeOperations, 0)
    assert.equal(final.pendingCaptures, 0)
  }
  await assertMissing(path.join(fixture.snapshots, '.retained-fixture-fs.lock'))
  assert.equal(await collectorFailure(fixture), null)
  assertProcessGone(owner.child.pid)
  assertProcessGone(waitingChild.pid)
})

test('native SIGTERM publishes durable settled evidence and remains signal termination', async () => {
  const fixture = await makeCase('settled-native-sigterm')
  const target = path.join(fixture.sandbox, 'settled-before-signal.txt')
  const ready = path.join(fixture.root, 'settled-ready')
  const bytes = Buffer.from('retained before native SIGTERM\n')
  await fs.writeFile(target, bytes)
  let signalledChild
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    await fs.unlink(${JSON.stringify(target)})
    await fs.writeFile(${JSON.stringify(ready)}, 'ready\\n', { flag: 'wx' })
    setInterval(() => {}, 1_000)
  `, {
    afterSpawn: async ({ child }) => {
      signalledChild = child
      await waitForFile(ready)
      assert.equal(child.kill('SIGTERM'), true)
    },
  })

  assert.equal(result.code, null, result.stderr || result.stdout)
  assert.equal(result.signal, 'SIGTERM', result.stderr || result.stdout)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'unlink')
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, receipt)), bytes)
  const childRecords = (await records(fixture)).filter(record => record.pid === signalledChild.pid)
  const settledIndex = childRecords.findIndex(record => record.phase === 'operation-settled'
    && record.receiptId === receipt.receiptId && record.outcome === 'success')
  assert.ok(settledIndex >= 0)
  assert.equal(childRecords.filter(record => record.phase === 'child-signal-settled').length, 1)
  const final = childRecords.at(-1)
  assert.ok(childRecords.length - 1 > settledIndex)
  assert.equal(final.phase, 'child-signal-settled')
  assert.equal(final.signal, 'SIGTERM')
  assert.equal(final.activeOperations, 0)
  assert.equal(final.pendingCaptures, 0)
  assert.equal(await collectorFailure(fixture), null)
  assertProcessGone(signalledChild.pid)
})

test('SIGTERM during pending capture acquisition is durable but unsettled', async () => {
  const fixture = await makeCase('pending-capture-sigterm')
  const ownerTarget = path.join(fixture.sandbox, 'owner.txt')
  const waitingTarget = path.join(fixture.sandbox, 'waiting.txt')
  const ready = path.join(fixture.root, 'waiting-ready')
  const waitingBytes = Buffer.from('must remain while capture is pending\n')
  await fs.writeFile(ownerTarget, 'owner\n')
  await fs.writeFile(waitingTarget, waitingBytes)
  const owner = await holdGlobalCapture(fixture, ownerTarget)
  let waitingChild
  const waiting = runChild(fixture, `
    import fs from 'node:fs/promises'
    const operation = fs.unlink(${JSON.stringify(waitingTarget)})
    await fs.writeFile(${JSON.stringify(ready)}, 'ready\\n', { flag: 'wx' })
    await operation
  `, {
    afterSpawn: async ({ child }) => {
      waitingChild = child
      await waitForFile(ready)
      assert.equal(child.kill('SIGTERM'), true)
    },
  })

  const waitingResult = await waiting
  const ownerResult = await owner.release()
  assert.equal(waitingResult.code, null, waitingResult.stderr || waitingResult.stdout)
  assert.equal(waitingResult.signal, 'SIGTERM', waitingResult.stderr || waitingResult.stdout)
  assert.equal(ownerResult.exitCode, 0, ownerResult.stderr || ownerResult.stdout)
  assert.deepEqual(await fs.readFile(waitingTarget), waitingBytes)
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.pid === waitingChild.pid
    && record.phase === 'snapshot-verified'), false)
  const waitingRecords = evidence.filter(record => record.pid === waitingChild.pid)
  const final = waitingRecords.at(-1)
  assert.ok(final, 'pending SIGTERM must publish a final retained-work record')
  assert.equal(final.phase, 'child-signal-unsettled')
  assert.equal(final.signal, 'SIGTERM')
  assert.equal(final.activeOperations, 0)
  assert.ok(Number.isInteger(final.pendingCaptures) && final.pendingCaptures > 0)
  assert.match(String(await collectorFailure(fixture)), /unsettled retained filesystem work/i)
  assertProcessGone(owner.child.pid)
  assertProcessGone(waitingChild.pid)
})

test('SIGTERM during an active retained operation is durable but unsettled', async () => {
  const fixture = await makeCase('active-operation-sigterm')
  const target = path.join(fixture.sandbox, 'active.txt')
  const ready = path.join(fixture.root, 'native-dispatch-ready')
  const bytes = Buffer.from('captured but native dispatch never settled\n')
  await fs.writeFile(target, bytes)
  let signalledChild
  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    setInterval(() => {}, 1_000)
    await fs.unlink(${JSON.stringify(target)})
  `, {
    preloadSource: holdingPromiseUnlinkPreload(ready),
    afterSpawn: async ({ child }) => {
      signalledChild = child
      await waitForFile(ready)
      assert.equal(child.kill('SIGTERM'), true)
    },
  })

  assert.equal(result.code, null, result.stderr || result.stdout)
  assert.equal(result.signal, 'SIGTERM', result.stderr || result.stdout)
  assert.deepEqual(await fs.readFile(target), bytes)
  const receipt = await verifiedFor(fixture, target, 'unlink')
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, receipt)), bytes)
  const childRecords = (await records(fixture)).filter(record => record.pid === signalledChild.pid)
  assert.equal(childRecords.some(record => record.phase === 'operation-settled'
    && record.receiptId === receipt.receiptId), false)
  const final = childRecords.at(-1)
  assert.equal(final.phase, 'child-signal-unsettled')
  assert.equal(final.signal, 'SIGTERM')
  assert.ok(Number.isInteger(final.activeOperations) && final.activeOperations > 0)
  assert.equal(final.pendingCaptures, 0)
  assert.match(String(await collectorFailure(fixture)), /unsettled retained filesystem work/i)
  assertProcessGone(signalledChild.pid)
})

test('normal exit during pending capture acquisition is durable but unsettled', async () => {
  const fixture = await makeCase('pending-capture-normal-exit')
  const ownerTarget = path.join(fixture.sandbox, 'owner.txt')
  const waitingTarget = path.join(fixture.sandbox, 'waiting.txt')
  const ready = path.join(fixture.root, 'waiting-ready')
  const waitingBytes = Buffer.from('must remain after explicit normal exit\n')
  await fs.writeFile(ownerTarget, 'owner\n')
  await fs.writeFile(waitingTarget, waitingBytes)
  const owner = await holdGlobalCapture(fixture, ownerTarget)
  let waitingChild
  const waitingResult = await runChild(fixture, `
    import fs from 'node:fs/promises'
    fs.unlink(${JSON.stringify(waitingTarget)})
    await fs.writeFile(${JSON.stringify(ready)}, 'ready\\n', { flag: 'wx' })
    process.exit(23)
  `, { afterSpawn: async value => { waitingChild = value.child } })
  const ownerResult = await owner.release()

  assert.equal(waitingResult.code, 23, waitingResult.stderr || waitingResult.stdout)
  assert.equal(waitingResult.signal, null, waitingResult.stderr || waitingResult.stdout)
  assert.equal(ownerResult.exitCode, 0, ownerResult.stderr || ownerResult.stdout)
  assert.deepEqual(await fs.readFile(waitingTarget), waitingBytes)
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.pid === waitingChild.pid
    && record.phase === 'snapshot-verified'), false)
  const final = evidence.filter(record => record.pid === waitingChild.pid).at(-1)
  assert.equal(final.phase, 'child-unsettled')
  assert.equal(final.exitCode, 23)
  assert.equal(final.activeOperations, 0)
  assert.ok(Number.isInteger(final.pendingCaptures) && final.pendingCaptures > 0)
  assert.match(String(await collectorFailure(fixture)), /unsettled retained filesystem work/i)
  assertProcessGone(owner.child.pid)
  assertProcessGone(waitingChild.pid)
})

test('an application SIGTERM listener keeps native listener semantics', async () => {
  const fixture = await makeCase('application-sigterm-listener')
  const ready = path.join(fixture.root, 'listener-ready')
  const called = path.join(fixture.root, 'listener-called')
  let signalledChild
  const result = await runChild(fixture, `
    import fs from 'node:fs'
    process.once('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(called)}, String(process.pid), { flag: 'wx' })
      process.exit(37)
    })
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready\\n', { flag: 'wx' })
    setInterval(() => {}, 1_000)
  `, {
    afterSpawn: async ({ child }) => {
      signalledChild = child
      await waitForFile(ready)
      assert.equal(child.kill('SIGTERM'), true)
    },
  })

  assert.equal(result.code, 37, result.stderr || result.stdout)
  assert.equal(result.signal, null, result.stderr || result.stdout)
  assert.equal(await fs.readFile(called, 'utf8'), String(signalledChild.pid))
  const childRecords = (await records(fixture)).filter(record => record.pid === signalledChild.pid)
  assert.equal(childRecords.some(record => record.phase.startsWith('child-signal-')), false)
  assert.equal(childRecords.filter(record => record.phase === 'child-settled').length, 1)
  const final = childRecords.at(-1)
  assert.equal(final.phase, 'child-settled')
  assert.equal(final.exitCode, 37)
  assert.equal(final.activeOperations, 0)
  assert.equal(final.pendingCaptures, 0)
  assert.equal(await collectorFailure(fixture), null)
  assertProcessGone(signalledChild.pid)
})

test('nested children inherit the preload and retain evidence even when the nested child fails', async () => {
  const fixture = await makeCase('nested-child')
  const target = path.join(fixture.sandbox, 'nested-delete.txt')
  const nested = path.join(fixture.root, 'nested.mjs')
  await fs.writeFile(target, 'nested bytes\n')
  await fs.writeFile(nested, `
    import fs from 'node:fs/promises'
    await fs.rm(${JSON.stringify(target)})
    process.exit(23)
  `)
  const result = await runChild(fixture, `
    import { spawnSync } from 'node:child_process'
    const nested = spawnSync(process.execPath, [${JSON.stringify(nested)}], {
      env: process.env,
      encoding: 'utf8',
      timeout: 4_000,
      killSignal: 'SIGKILL',
    })
    console.log(JSON.stringify({
      status: nested.status,
      signal: nested.signal,
      error: nested.error && { name: nested.error.name, code: nested.error.code, message: nested.error.message },
      stderr: nested.stderr,
    }))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const nestedResult = lastJson(result.stdout)
  assert.equal(nestedResult.error, undefined)
  assert.equal(nestedResult.signal, null)
  assert.equal(nestedResult.status, 23)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'rm')
  assert.equal(await fs.readFile(await snapshotPayload(fixture, receipt), 'utf8'), 'nested bytes\n')
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'child-settled' && record.exitCode === 23
    && record.activeOperations === 0), true)
})

test('the actual exit publishes one final receipt after beforeExit schedules retained work', async () => {
  const fixture = await makeCase('before-exit-settlement')
  const target = path.join(fixture.sandbox, 'before-exit-delete.txt')
  const nested = path.join(fixture.root, 'before-exit-child.mjs')
  await fs.writeFile(target, 'removed during beforeExit\n')
  await fs.writeFile(nested, `
    import fs from 'node:fs/promises'
    process.once('beforeExit', async () => {
      await fs.rm(${JSON.stringify(target)})
      process.exitCode = 27
    })
  `)
  const result = await runChild(fixture, `
    import { spawnSync } from 'node:child_process'
    const nested = spawnSync(process.execPath, [${JSON.stringify(nested)}], {
      env: process.env,
      encoding: 'utf8',
      timeout: 4_000,
      killSignal: 'SIGKILL',
    })
    console.log(JSON.stringify({
      status: nested.status,
      signal: nested.signal,
      error: nested.error && { name: nested.error.name, code: nested.error.code, message: nested.error.message },
      stderr: nested.stderr,
    }))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const nestedResult = lastJson(result.stdout)
  assert.equal(nestedResult.error, undefined)
  assert.equal(nestedResult.signal, null)
  assert.equal(nestedResult.status, 27)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'rm')
  assert.equal(await fs.readFile(await snapshotPayload(fixture, receipt), 'utf8'), 'removed during beforeExit\n')
  const childRecords = (await records(fixture)).filter(record => record.pid === receipt.pid)
  assert.equal(childRecords.some(record => record.phase === 'operation-settled'
    && record.receiptId === receipt.receiptId && record.outcome === 'success'), true)
  assert.equal(childRecords.filter(record => record.phase === 'child-settled').length, 1)
  assert.equal(childRecords.some(record => record.phase === 'child-unsettled'), false)
  const finalRecord = childRecords.at(-1)
  assert.equal(finalRecord.phase, 'child-settled')
  assert.equal(finalRecord.exitCode, 27)
  assert.equal(finalRecord.activeOperations, 0)
})

test('a late synchronous exit listener settles its retained removal before the final receipt', async () => {
  const fixture = await makeCase('late-exit-listener')
  const target = path.join(fixture.sandbox, 'late-exit-delete.txt')
  await fs.writeFile(target, 'removed from a late exit listener\n')
  const result = await runChild(fixture, `
    import fs from 'node:fs'
    process.on('exit', () => fs.rmSync(${JSON.stringify(target)}))
    process.exitCode = 29
  `)

  assert.equal(result.exitCode, 29, result.stderr || result.stdout)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'rm')
  assert.equal(receipt.api, 'sync')
  assert.equal(await fs.readFile(await snapshotPayload(fixture, receipt), 'utf8'), 'removed from a late exit listener\n')
  const childRecords = (await records(fixture)).filter(record => record.pid === receipt.pid)
  const settledIndex = childRecords.findIndex(record => record.phase === 'operation-settled'
    && record.receiptId === receipt.receiptId && record.outcome === 'success')
  const finalIndex = childRecords.findIndex(record => record.phase === 'child-settled')
  assert.ok(settledIndex >= 0)
  assert.equal(finalIndex, childRecords.length - 1)
  assert.ok(finalIndex > settledIndex)
  assert.equal(childRecords[finalIndex].exitCode, 29)
  assert.equal(childRecords[finalIndex].activeOperations, 0)
})

test('a throwing synchronous exit listener cannot publish successful final evidence', async () => {
  const fixture = await makeCase('throwing-exit-listener')
  const target = path.join(fixture.sandbox, 'throwing-exit-delete.txt')
  await fs.writeFile(target, 'removed before the exit failure\n')
  const result = await runChild(fixture, `
    import fs from 'node:fs'
    process.on('exit', () => {
      fs.rmSync(${JSON.stringify(target)})
      throw new Error('late exit listener failed')
    })
  `)

  assert.notEqual(result.exitCode, 0)
  assert.match(result.stderr, /late exit listener failed/)
  await assertMissing(target)
  const receipt = await verifiedFor(fixture, target, 'rm')
  const childRecords = (await records(fixture)).filter(record => record.pid === receipt.pid)
  assert.equal(childRecords.some(record => record.phase === 'operation-settled'
    && record.receiptId === receipt.receiptId && record.outcome === 'success'), true)
  assert.equal(childRecords.some(record => record.phase === 'child-settled'), false)
  assert.equal(childRecords.at(-1).phase, 'child-unsettled')
})

test('a timed-out known nested child is force-killed and reaped below the outer deadline', async () => {
  const fixture = await makeCase('nested-timeout')
  const target = path.join(fixture.sandbox, 'nested-hang.txt')
  const nested = path.join(fixture.root, 'nested-hang-child.mjs')
  const pidFile = path.join(fixture.root, 'nested-hang.pid')
  const before = Buffer.from('must survive the timed-out child\n')
  await fs.writeFile(target, before)
  await fs.writeFile(nested, `
    import fs from 'node:fs/promises'
    await fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid), { flag: 'wx' })
    await fs.rm(${JSON.stringify(target)})
  `)
  await configureBarrier(fixture, 'after-baseline')
  const result = await runChild(fixture, `
    import { spawnSync } from 'node:child_process'
    const startedAt = Date.now()
    const nested = spawnSync(process.execPath, [${JSON.stringify(nested)}], {
      env: process.env,
      encoding: 'utf8',
      timeout: 4_000,
      killSignal: 'SIGKILL',
    })
    console.log(JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      status: nested.status,
      signal: nested.signal,
      error: nested.error && { name: nested.error.name, code: nested.error.code, message: nested.error.message },
      stderr: nested.stderr,
    }))
  `, {
    afterSpawn: async () => {
      const reached = path.join(fixture.snapshots, BARRIER_REACHED)
      await waitForFile(reached)
      const checkpoint = JSON.parse(await fs.readFile(reached, 'utf8'))
      assert.equal(checkpoint.phase, 'after-baseline')
      assert.equal(checkpoint.target, 'nested-hang.txt')
      assert.equal(checkpoint.sourceInventory.entries[0].sha256, sha256(before))
    },
  })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const nestedResult = lastJson(result.stdout)
  assert.equal(nestedResult.status, null)
  assert.equal(nestedResult.signal, 'SIGKILL')
  assert.equal(nestedResult.error.code, 'ETIMEDOUT')
  assert.ok(nestedResult.elapsedMs < 7_500, `nested timeout took ${nestedResult.elapsedMs}ms`)
  const nestedPid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10)
  assert.ok(Number.isSafeInteger(nestedPid) && nestedPid > 0)
  assert.throws(() => process.kill(nestedPid, 0), error => error?.code === 'ESRCH')
  assert.deepEqual(await fs.readFile(target), before)
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.pid === nestedPid && record.phase === 'child-settled'), false)
})

test('non-private or aliased configured roots fail preload before any operation', async () => {
  const fixture = await makeCase('root-validation')
  const target = path.join(fixture.sandbox, 'untouched.txt')
  await fs.writeFile(target, 'untouched\n')
  await fs.chmod(fixture.sandbox, 0o755)
  const publicRoot = await runChild(fixture, `
    import fs from 'node:fs/promises'
    await fs.rm(${JSON.stringify(target)})
  `)
  await fs.chmod(fixture.sandbox, 0o700)
  assert.notEqual(publicRoot.exitCode, 0)
  assert.match(publicRoot.stderr, /private|mode|permission/i)
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched\n')

  const sameRoot = await runChild(fixture, `console.log('must not run')`, {
    env: { STORY_STUDIO_RETAINED_SNAPSHOT_ROOT: fixture.sandbox },
  })
  assert.notEqual(sameRoot.exitCode, 0)
  assert.match(sameRoot.stderr, /snapshot|separate|identity/i)
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched\n')
})

function guardedHardlinkUnlinkPreload(fixture, attemptFile, { refuseEntryStatsUnder = null } = {}) {
  return `
    import { createHash } from 'node:crypto'
    import nativeFs from 'node:fs'
    import nativePromises from 'node:fs/promises'
    import nativePath from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const originalCallbackUnlink = nativeFs.unlink
    const originalSyncUnlink = nativeFs.unlinkSync
    const originalPromiseUnlink = nativePromises.unlink
    const append = nativeFs.appendFileSync.bind(nativeFs)
    const lstat = nativeFs.lstatSync.bind(nativeFs)
    const read = nativeFs.readFileSync.bind(nativeFs)
    const readdir = nativeFs.readdirSync.bind(nativeFs)
    const sandbox = nativeFs.realpathSync(${JSON.stringify(fixture.sandbox)})
    const snapshots = nativeFs.realpathSync(${JSON.stringify(fixture.snapshots)})
    const attemptFile = ${JSON.stringify(attemptFile)}
    const refuseEntryStatsUnder = ${JSON.stringify(refuseEntryStatsUnder)}

    function relative(target) {
      return nativePath.relative(sandbox, nativePath.resolve(String(target))).split(nativePath.sep).join('/') || '.'
    }

    function manifestRecords() {
      const output = []
      for (const name of readdir(snapshots).filter(name => /^manifest-.*\\.jsonl$/.test(name)).sort()) {
        const raw = read(nativePath.join(snapshots, name), 'utf8')
        if (!raw.endsWith('\\n')) return []
        for (const line of raw.split('\\n').filter(Boolean)) output.push(JSON.parse(line))
      }
      return output
    }

    function hasCompleteProof(target, api) {
      try {
        const absolute = nativePath.resolve(String(target))
        const targetRelative = relative(absolute)
        const matches = manifestRecords().filter(record => record.phase === 'snapshot-verified'
          && record.operation === 'unlink' && record.api === api && record.target === targetRelative)
        if (matches.length !== 1) return false
        const record = matches[0]
        const source = read(absolute)
        const payload = nativePath.join(snapshots, record.snapshot, record.payload)
        const payloadStat = lstat(payload)
        const payloadBytes = read(payload)
        const sourceHash = createHash('sha256').update(source).digest('hex')
        if (!payloadStat.isFile() || payloadStat.nlink !== 1 || (payloadStat.mode & 0o222) !== 0
          || !source.equals(payloadBytes)
          || record.sourceIdentity?.dev !== lstat(absolute).dev
          || record.sourceIdentity?.ino !== lstat(absolute).ino
          || record.sourceInventory?.entries?.[0]?.sha256 !== sourceHash
          || JSON.stringify(record.sourceInventory?.entries) !== JSON.stringify(record.snapshotInventory?.entries)) return false

        const targetStat = lstat(absolute)
        if (targetStat.nlink === 1) return record.hardlinkProof === undefined
        const parent = nativePath.dirname(absolute)
        const parentStat = lstat(parent)
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== targetStat.dev) return false
        const aliases = readdir(parent).flatMap(name => {
          const candidate = nativePath.join(parent, name)
          const stat = lstat(candidate)
          return stat.dev === targetStat.dev && stat.ino === targetStat.ino ? [relative(candidate)] : []
        }).sort()
        const proof = record.hardlinkProof
        return proof?.parent === relative(parent)
          && proof.parentIdentity?.dev === parentStat.dev
          && proof.parentIdentity?.ino === parentStat.ino
          && proof.nlink === targetStat.nlink
          && aliases.length === targetStat.nlink
          && JSON.stringify(proof.aliases) === JSON.stringify(aliases)
      } catch { return false }
    }

    function refusal() {
      const error = new Error('test native dispatch refused without a complete matching hardlink proof')
      error.code = 'ERR_TEST_NATIVE_DISPATCH_REFUSED'
      return error
    }

    function note(api, target, proven) {
      append(attemptFile, JSON.stringify({ api, target: relative(target), proven }) + '\\n')
    }

    nativeFs.unlink = function guardedCallbackUnlink(target, callback) {
      const proven = hasCompleteProof(target, 'callback')
      note('callback', target, proven)
      if (!proven) {
        process.nextTick(() => callback(refusal()))
        return undefined
      }
      return Reflect.apply(originalCallbackUnlink, this, [target, callback])
    }
    nativeFs.unlinkSync = function guardedSyncUnlink(target) {
      const proven = hasCompleteProof(target, 'sync')
      note('sync', target, proven)
      if (!proven) throw refusal()
      return Reflect.apply(originalSyncUnlink, this, [target])
    }
    const guardedPromiseUnlink = async function guardedPromiseUnlink(target) {
      const proven = hasCompleteProof(target, 'promise')
      note('promise', target, proven)
      if (!proven) throw refusal()
      return Reflect.apply(originalPromiseUnlink, this, [target])
    }
    const guardedPromiseRm = async function guardedPromiseRm(target) {
      note('promise-rm', target, false)
      throw refusal()
    }
    nativePromises.unlink = guardedPromiseUnlink
    nativeFs.promises.unlink = guardedPromiseUnlink
    nativePromises.rm = guardedPromiseRm
    nativeFs.promises.rm = guardedPromiseRm
    if (refuseEntryStatsUnder) {
      const guardedParent = nativePath.resolve(refuseEntryStatsUnder)
      nativeFs.lstatSync = function guardedLstat(target, ...args) {
        const absolute = nativePath.resolve(String(target))
        if (nativePath.dirname(absolute) === guardedParent && nativePath.basename(absolute) !== 'target.txt') {
          append(attemptFile, JSON.stringify({ api: 'entry-stat', target: relative(absolute), proven: false }) + '\\n')
          const error = new Error('test parent-entry stat refused beyond the bounded enumeration')
          error.code = 'ERR_TEST_PARENT_ENTRY_STAT'
          throw error
        }
        return lstat(target, ...args)
      }
    }
    syncBuiltinESMExports()
  `
}

function guardedHardlinkRmPreload(fixture, attemptFile) {
  return `
    import { createHash } from 'node:crypto'
    import nativeFs from 'node:fs'
    import nativePromises from 'node:fs/promises'
    import nativePath from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const originalCallbackRm = nativeFs.rm
    const originalSyncRm = nativeFs.rmSync
    const originalPromiseRm = nativePromises.rm
    const append = nativeFs.appendFileSync.bind(nativeFs)
    const lstat = nativeFs.lstatSync.bind(nativeFs)
    const read = nativeFs.readFileSync.bind(nativeFs)
    const readdir = nativeFs.readdirSync.bind(nativeFs)
    const sandbox = nativeFs.realpathSync(${JSON.stringify(fixture.sandbox)})
    const sandboxStat = lstat(sandbox)
    const snapshots = nativeFs.realpathSync(${JSON.stringify(fixture.snapshots)})
    const attemptFile = ${JSON.stringify(attemptFile)}

    function relative(target) {
      return nativePath.relative(sandbox, nativePath.resolve(String(target))).split(nativePath.sep).join('/') || '.'
    }

    function manifestRecords() {
      const output = []
      for (const name of readdir(snapshots).filter(name => /^manifest-.*\\.jsonl$/.test(name)).sort()) {
        const raw = read(nativePath.join(snapshots, name), 'utf8')
        if (!raw.endsWith('\\n')) return []
        for (const line of raw.split('\\n').filter(Boolean)) output.push(JSON.parse(line))
      }
      return output
    }

    function hasCompleteProof(target, api) {
      try {
        const absolute = nativePath.resolve(String(target))
        const targetRelative = relative(absolute)
        const matches = manifestRecords().filter(record => record.phase === 'snapshot-verified'
          && record.operation === 'rm' && record.api === api && record.target === targetRelative)
        if (matches.length !== 1) return false
        const record = matches[0]
        const targetStat = lstat(absolute)
        const source = read(absolute)
        const payload = nativePath.join(snapshots, record.snapshot, record.payload)
        const payloadStat = lstat(payload)
        const payloadBytes = read(payload)
        const sourceHash = createHash('sha256').update(source).digest('hex')
        if (!payloadStat.isFile() || payloadStat.nlink !== 1 || (payloadStat.mode & 0o222) !== 0
          || !source.equals(payloadBytes)
          || record.sourceIdentity?.dev !== targetStat.dev
          || record.sourceIdentity?.ino !== targetStat.ino
          || record.sourceInventory?.entries?.[0]?.sha256 !== sourceHash
          || JSON.stringify(record.sourceInventory?.entries) !== JSON.stringify(record.snapshotInventory?.entries)) return false

        if (targetStat.nlink === 1) return record.hardlinkProof === undefined
        const parent = nativePath.dirname(absolute)
        const parentStat = lstat(parent)
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== targetStat.dev) return false
        const aliases = readdir(parent).flatMap(name => {
          const candidate = nativePath.join(parent, name)
          const stat = lstat(candidate)
          return stat.dev === targetStat.dev && stat.ino === targetStat.ino ? [relative(candidate)] : []
        }).sort()
        const proof = record.hardlinkProof
        return proof?.parent === relative(parent)
          && proof.parentIdentity?.dev === parentStat.dev
          && proof.parentIdentity?.ino === parentStat.ino
          && proof.nlink === targetStat.nlink
          && aliases.length === targetStat.nlink
          && JSON.stringify(proof.aliases) === JSON.stringify(aliases)
      } catch { return false }
    }

    function isSafeBootstrap(target, args) {
      if (typeof target !== 'string' || args.length !== 2 || typeof args[1] !== 'function') return false
      const options = args[0]
      if (!options || Object.keys(options).length !== 1 || options.force !== true) return false
      const parent = nativePath.dirname(target)
      if (nativePath.dirname(parent) !== sandbox
        || !nativePath.basename(parent).startsWith(${JSON.stringify(BOOTSTRAP_PARENT_PREFIX)})
        || nativePath.basename(target) !== ${JSON.stringify(BOOTSTRAP_ABSENT_CHILD)}) return false
      try {
        lstat(target)
        return false
      } catch (error) {
        if (error?.code !== 'ENOENT') return false
      }
      try {
        const parentStat = lstat(parent)
        return parentStat.isDirectory()
          && !parentStat.isSymbolicLink()
          && (parentStat.mode & 0o777) === 0o700
          && parentStat.dev === sandboxStat.dev
          && (typeof process.getuid !== 'function' || parentStat.uid === process.getuid())
      } catch { return false }
    }

    function refusal() {
      const error = new Error('test native rm refused without a complete matching hardlink proof')
      error.code = 'ERR_TEST_NATIVE_DISPATCH_REFUSED'
      return error
    }

    function note(api, target, proven) {
      append(attemptFile, JSON.stringify({ api, target: relative(target), proven }) + '\\n')
    }

    nativeFs.rm = function guardedCallbackRm(target, ...args) {
      if (isSafeBootstrap(target, args)) return Reflect.apply(originalCallbackRm, this, [target, ...args])
      const callback = args[1]
      const proven = typeof callback === 'function' && args[0]?.recursive !== true && hasCompleteProof(target, 'callback')
      note('callback', target, proven)
      if (!proven) {
        process.nextTick(() => callback(refusal()))
        return undefined
      }
      return Reflect.apply(originalCallbackRm, this, [target, ...args])
    }
    nativeFs.rmSync = function guardedSyncRm(target, ...args) {
      const proven = args[0]?.recursive !== true && hasCompleteProof(target, 'sync')
      note('sync', target, proven)
      if (!proven) throw refusal()
      return Reflect.apply(originalSyncRm, this, [target, ...args])
    }
    const guardedPromiseRm = async function guardedPromiseRm(target, ...args) {
      const proven = args[0]?.recursive !== true && hasCompleteProof(target, 'promise')
      note('promise', target, proven)
      if (!proven) throw refusal()
      return Reflect.apply(originalPromiseRm, this, [target, ...args])
    }
    nativePromises.rm = guardedPromiseRm
    nativeFs.promises.rm = guardedPromiseRm
    syncBuiltinESMExports()
  `
}

async function crossBarrierOrChildExit(fixture, child, phase, action) {
  const reached = path.join(fixture.snapshots, BARRIER_REACHED)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    let isReached = false
    try {
      await fs.access(reached)
      isReached = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (isReached) {
      const checkpoint = JSON.parse(await fs.readFile(reached, 'utf8'))
      assert.equal(checkpoint.phase, phase)
      await action(checkpoint)
      await fs.writeFile(path.join(fixture.snapshots, BARRIER_RESUME), `${phase}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      return true
    }
    if (child.exitCode !== null || child.signalCode !== null) return false
    await delay(10)
  }
  throw new Error(`timed out waiting for retained-fixture barrier or child exit: ${fixture.root}`)
}

test('hardlink compatibility: production-shaped lock aliases are retained before both native unlinks', async () => {
  const fixture = await makeCase('hardlink-lock-lifecycle')
  const directory = path.join(fixture.sandbox, 'content-packs')
  const temporary = path.join(directory, '..coordination.lock.token.tmp')
  const canonical = path.join(directory, '.coordination.lock')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const bytes = Buffer.from('{"token":"owned-lock"}\n')
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(temporary, bytes, { mode: 0o600 })
  await fs.link(temporary, canonical)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try {
      await fs.unlink(${JSON.stringify(temporary)})
      const retainedAlias = await fs.readFile(${JSON.stringify(canonical)}, 'utf8')
      await fs.unlink(${JSON.stringify(canonical)})
      outcome = { ok: true, retainedAlias }
    } catch (error) {
      outcome = { ok: false, code: error.code }
    }
    console.log(JSON.stringify(outcome))
  `, { preloadSource: guardedHardlinkUnlinkPreload(fixture, attemptFile) })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const outcome = lastJson(result.stdout)
  if (!outcome.ok) {
    assert.deepEqual(await fs.readFile(temporary), bytes)
    assert.deepEqual(await fs.readFile(canonical), bytes)
    assert.deepEqual(await optionalJsonLines(attemptFile), [])
  }
  assert.deepEqual(outcome, { ok: true, retainedAlias: bytes.toString() })
  await assertMissing(temporary)
  await assertMissing(canonical)

  const temporaryReceipt = await verifiedFor(fixture, temporary, 'unlink')
  const canonicalReceipt = await verifiedFor(fixture, canonical, 'unlink')
  assert.equal(temporaryReceipt.api, 'promise')
  assert.deepEqual(temporaryReceipt.hardlinkProof, {
    parent: 'content-packs',
    parentIdentity: {
      dev: temporaryReceipt.hardlinkProof.parentIdentity.dev,
      ino: temporaryReceipt.hardlinkProof.parentIdentity.ino,
    },
    nlink: 2,
    aliases: ['content-packs/..coordination.lock.token.tmp', 'content-packs/.coordination.lock'],
  })
  assert.equal(canonicalReceipt.hardlinkProof, undefined)
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, temporaryReceipt)), bytes)
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, canonicalReceipt)), bytes)
  assert.deepEqual(await optionalJsonLines(attemptFile), [
    { api: 'promise', target: 'content-packs/..coordination.lock.token.tmp', proven: true },
    { api: 'promise', target: 'content-packs/.coordination.lock', proven: true },
  ])
})

test('hardlink compatibility: callback, sync and promise unlink share the local-alias proof', async () => {
  const cases = []
  for (const api of ['callback', 'sync', 'promise']) {
    const fixture = await makeCase(`hardlink-${api}`)
    const directory = path.join(fixture.sandbox, api)
    const target = path.join(directory, 'target.txt')
    const sibling = path.join(directory, 'sibling.txt')
    const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
    const bytes = Buffer.from(`${api} hardlink bytes\n`)
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(target, bytes)
    await fs.link(target, sibling)
    const operation = api === 'callback'
      ? `await new Promise(resolve => { let synchronous = true; fs.unlink(target, error => resolve({ ok: !error, code: error?.code, asynchronous: !synchronous })); synchronous = false })`
      : api === 'sync'
        ? `(() => { try { fs.unlinkSync(target); return { ok: true } } catch (error) { return { ok: false, code: error.code } } })()`
        : `await fs.promises.unlink(target).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }))`
    const result = await runChild(fixture, `
      import fs from 'node:fs'
      const target = ${JSON.stringify(target)}
      const outcome = ${operation}
      console.log(JSON.stringify(outcome))
    `, { preloadSource: guardedHardlinkUnlinkPreload(fixture, attemptFile) })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    const outcome = lastJson(result.stdout)
    const attempts = await optionalJsonLines(attemptFile)
    if (!outcome.ok) {
      assert.deepEqual(await fs.readFile(target), bytes)
      assert.deepEqual(await fs.readFile(sibling), bytes)
      assert.deepEqual(attempts, [])
    }
    cases.push({ api, fixture, target, sibling, attemptFile, bytes, outcome, attempts })
  }

  for (const entry of cases) {
    assert.equal(entry.outcome.ok, true)
    if (entry.api === 'callback') assert.equal(entry.outcome.asynchronous, true)
    await assertMissing(entry.target)
    assert.deepEqual(await fs.readFile(entry.sibling), entry.bytes)
    const receipt = await verifiedFor(entry.fixture, entry.target, 'unlink')
    assert.equal(receipt.api, entry.api)
    assert.equal(receipt.hardlinkProof.nlink, 2)
    assert.deepEqual(receipt.hardlinkProof.aliases, [`${entry.api}/sibling.txt`, `${entry.api}/target.txt`])
    assert.deepEqual(await fs.readFile(await snapshotPayload(entry.fixture, receipt)), entry.bytes)
    assert.deepEqual(entry.attempts, [{ api: entry.api, target: `${entry.api}/target.txt`, proven: true }])
  }
})

test('hardlink compatibility: sibling-parent and outside-root aliases remain refused before native dispatch', async () => {
  const fixture = await makeCase('hardlink-alias-deficit')
  const firstParent = path.join(fixture.sandbox, 'first')
  const secondParent = path.join(fixture.sandbox, 'second')
  const siblingTarget = path.join(firstParent, 'target.txt')
  const siblingAlias = path.join(secondParent, 'alias.txt')
  const outsideTarget = path.join(firstParent, 'outside-target.txt')
  const outsideAlias = path.join(fixture.root, 'outside-alias.txt')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const siblingBytes = Buffer.from('sibling-parent bytes\n')
  const outsideBytes = Buffer.from('outside-root bytes\n')
  await fs.mkdir(firstParent, { mode: 0o700 })
  await fs.mkdir(secondParent, { mode: 0o700 })
  await fs.writeFile(siblingTarget, siblingBytes)
  await fs.link(siblingTarget, siblingAlias)
  await fs.writeFile(outsideTarget, outsideBytes)
  await fs.link(outsideTarget, outsideAlias)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    const outcomes = []
    for (const target of ${JSON.stringify([siblingTarget, outsideTarget])}) {
      try { await fs.unlink(target); outcomes.push({ ok: true }) }
      catch (error) { outcomes.push({ ok: false, code: error.code }) }
    }
    console.log(JSON.stringify(outcomes))
  `, { preloadSource: guardedHardlinkUnlinkPreload(fixture, attemptFile) })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), Array(2).fill({
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  }))
  assert.deepEqual(await fs.readFile(siblingTarget), siblingBytes)
  assert.deepEqual(await fs.readFile(siblingAlias), siblingBytes)
  assert.deepEqual(await fs.readFile(outsideTarget), outsideBytes)
  assert.deepEqual(await fs.readFile(outsideAlias), outsideBytes)
  assert.deepEqual(await optionalJsonLines(attemptFile), [])
  const evidence = await records(fixture)
  assert.equal(evidence.filter(record => record.phase === 'snapshot-refused').length, 2)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
})

test('hardlink compatibility: alias and parent races fail before verified receipt or native unlink', async () => {
  const cases = []
  for (const mutation of ['add-alias', 'move-alias', 'replace-parent']) {
    const fixture = await makeCase(`hardlink-race-${mutation}`)
    const directory = path.join(fixture.sandbox, 'locks')
    const target = path.join(directory, 'target.txt')
    const alias = path.join(directory, 'alias.txt')
    const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
    const bytes = Buffer.from(`${mutation} bytes\n`)
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(target, bytes)
    await fs.link(target, alias)
    const phase = mutation === 'add-alias' ? 'after-baseline' : 'before-final-verification'
    await configureBarrier(fixture, phase)
    let crossed = false
    const result = await runChild(fixture, `
      import fs from 'node:fs/promises'
      let outcome
      try { await fs.unlink(${JSON.stringify(target)}); outcome = { ok: true } }
      catch (error) { outcome = { ok: false, code: error.code } }
      console.log(JSON.stringify(outcome))
    `, {
      preloadSource: guardedHardlinkUnlinkPreload(fixture, attemptFile),
      afterSpawn: async ({ child }) => {
        crossed = await crossBarrierOrChildExit(fixture, child, phase, async () => {
          if (mutation === 'add-alias') {
            await fs.link(target, path.join(directory, 'added.txt'))
          } else if (mutation === 'move-alias') {
            const moved = path.join(fixture.sandbox, 'moved')
            await fs.mkdir(moved, { mode: 0o700 })
            await fs.rename(alias, path.join(moved, 'alias.txt'))
          } else {
            const moved = path.join(fixture.sandbox, 'locks-before-replacement')
            await fs.rename(directory, moved)
            await fs.mkdir(directory, { mode: 0o700 })
          }
        })
      },
    })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    const outcome = lastJson(result.stdout)
    assert.deepEqual(await optionalJsonLines(attemptFile), [])
    assert.equal((await records(fixture)).some(record => record.phase === 'snapshot-verified'), false)
    if (mutation === 'add-alias') {
      assert.deepEqual(await fs.readFile(target), bytes)
      assert.deepEqual(await fs.readFile(alias), bytes)
      if (crossed) assert.deepEqual(await fs.readFile(path.join(directory, 'added.txt')), bytes)
    } else if (mutation === 'move-alias' && crossed) {
      assert.deepEqual(await fs.readFile(target), bytes)
      assert.deepEqual(await fs.readFile(path.join(fixture.sandbox, 'moved', 'alias.txt')), bytes)
    } else if (mutation === 'replace-parent' && crossed) {
      assert.deepEqual(await fs.readFile(path.join(fixture.sandbox, 'locks-before-replacement', 'target.txt')), bytes)
      assert.deepEqual(await fs.readFile(path.join(fixture.sandbox, 'locks-before-replacement', 'alias.txt')), bytes)
    } else {
      assert.deepEqual(await fs.readFile(target), bytes)
      assert.deepEqual(await fs.readFile(alias), bytes)
    }
    cases.push({ mutation, crossed, outcome })
  }

  for (const entry of cases) {
    assert.equal(entry.crossed, true, `${entry.mutation} must reach the deterministic post-baseline barrier`)
    assert.deepEqual(entry.outcome, { ok: false, code: 'ERR_STORY_STUDIO_RETAINED_FS_SNAPSHOT' })
  }
})

test('hardlink compatibility: a hardlinked directory descendant remains refused without native rm', async () => {
  const fixture = await makeCase('hardlink-directory-descendant')
  const directory = path.join(fixture.sandbox, 'tree')
  const target = path.join(directory, 'target.txt')
  const alias = path.join(directory, 'alias.txt')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const bytes = Buffer.from('directory descendant bytes\n')
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(target, bytes)
  await fs.link(target, alias)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rm(${JSON.stringify(directory)}, { recursive: true }); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, { preloadSource: guardedHardlinkUnlinkPreload(fixture, attemptFile) })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), {
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  })
  assert.deepEqual(await fs.readFile(target), bytes)
  assert.deepEqual(await fs.readFile(alias), bytes)
  assert.deepEqual(await optionalJsonLines(attemptFile), [])
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'), true)
})

test('hardlink compatibility: an oversized parent refuses before per-entry stat or native unlink', async () => {
  const fixture = await makeCase('hardlink-parent-entry-ceiling')
  const directory = path.join(fixture.sandbox, 'oversized')
  const target = path.join(directory, 'target.txt')
  const alias = path.join(directory, 'alias.txt')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const bytes = Buffer.from('oversized parent bytes\n')
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(target, bytes)
  await fs.link(target, alias)
  for (let start = 0; start < 4_095; start += 128) {
    await Promise.all(Array.from(
      { length: Math.min(128, 4_095 - start) },
      (_, offset) => fs.writeFile(path.join(directory, `filler-${String(start + offset).padStart(4, '0')}`), ''),
    ))
  }
  assert.equal((await fs.readdir(directory)).length, 4_097)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.unlink(${JSON.stringify(target)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, {
    preloadSource: guardedHardlinkUnlinkPreload(fixture, attemptFile, {
      refuseEntryStatsUnder: directory,
    }),
  })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), {
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  })
  assert.deepEqual(await fs.readFile(target), bytes)
  assert.deepEqual(await fs.readFile(alias), bytes)
  assert.equal((await fs.readdir(directory)).length, 4_097)
  assert.deepEqual(await optionalJsonLines(attemptFile), [])
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'), true)
})

test('hardlink compatibility: direct regular-file rm callback, sync and promise share the local-alias proof', async () => {
  const cases = []
  for (const api of ['callback', 'sync', 'promise']) {
    const fixture = await makeCase(`hardlink-rm-${api}`)
    const directory = path.join(fixture.sandbox, api)
    const target = path.join(directory, 'temporary.sspack')
    const alias = path.join(directory, 'published.sspack')
    const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
    const bytes = Buffer.from(`${api} direct-file rm bytes\n`)
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(target, bytes, { mode: 0o600 })
    await fs.link(target, alias)
    const operation = api === 'callback'
      ? `await new Promise(resolve => { let synchronous = true; fs.rm(target, { force: true }, error => resolve({ ok: !error, code: error?.code, asynchronous: !synchronous })); synchronous = false })`
      : api === 'sync'
        ? `(() => { try { fs.rmSync(target, { force: true }); return { ok: true } } catch (error) { return { ok: false, code: error.code } } })()`
        : `await fs.promises.rm(target, { force: true }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }))`
    const result = await runChild(fixture, `
      import fs from 'node:fs'
      const target = ${JSON.stringify(target)}
      const outcome = ${operation}
      console.log(JSON.stringify(outcome))
    `, { preloadSource: guardedHardlinkRmPreload(fixture, attemptFile) })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    const outcome = lastJson(result.stdout)
    const attempts = await optionalJsonLines(attemptFile)
    if (!outcome.ok) {
      assert.deepEqual(await fs.readFile(target), bytes)
      assert.deepEqual(await fs.readFile(alias), bytes)
      assert.equal((await fs.lstat(target)).nlink, 2)
      assert.equal((await fs.lstat(alias)).nlink, 2)
      assert.deepEqual(attempts, [])
    }
    cases.push({ api, fixture, target, alias, bytes, outcome, attempts })
  }

  for (const entry of cases) {
    assert.equal(entry.outcome.ok, true)
    if (entry.api === 'callback') assert.equal(entry.outcome.asynchronous, true)
    await assertMissing(entry.target)
    assert.deepEqual(await fs.readFile(entry.alias), entry.bytes)
    assert.equal((await fs.lstat(entry.alias)).nlink, 1)
    const receipt = await verifiedFor(entry.fixture, entry.target, 'rm')
    assert.equal(receipt.api, entry.api)
    assert.equal(receipt.sourceInventory.entries[0].sha256, sha256(entry.bytes))
    assert.deepEqual(receipt.sourceInventory.entries, receipt.snapshotInventory.entries)
    assert.equal(receipt.hardlinkProof.nlink, 2)
    assert.deepEqual(receipt.hardlinkProof.aliases, [`${entry.api}/published.sspack`, `${entry.api}/temporary.sspack`])
    const payload = await snapshotPayload(entry.fixture, receipt)
    assert.deepEqual(await fs.readFile(payload), entry.bytes)
    const payloadStat = await fs.lstat(payload)
    assert.equal(payloadStat.nlink, 1)
    assert.equal(payloadStat.mode & 0o222, 0)
    assert.deepEqual(entry.attempts, [{ api: entry.api, target: `${entry.api}/temporary.sspack`, proven: true }])
  }
})

test('hardlink compatibility: direct regular-file rm refuses an alias outside its parent before native dispatch', async () => {
  const fixture = await makeCase('hardlink-rm-alias-deficit')
  const firstParent = path.join(fixture.sandbox, 'first')
  const secondParent = path.join(fixture.sandbox, 'second')
  const target = path.join(firstParent, 'temporary.sspack')
  const alias = path.join(secondParent, 'published.sspack')
  const attemptFile = path.join(fixture.root, 'native-dispatch.jsonl')
  const bytes = Buffer.from('direct-file rm alias-deficit bytes\n')
  await fs.mkdir(firstParent, { mode: 0o700 })
  await fs.mkdir(secondParent, { mode: 0o700 })
  await fs.writeFile(target, bytes, { mode: 0o600 })
  await fs.link(target, alias)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rm(${JSON.stringify(target)}, { force: true }); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `, { preloadSource: guardedHardlinkRmPreload(fixture, attemptFile) })

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), {
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  })
  assert.deepEqual(await fs.readFile(target), bytes)
  assert.deepEqual(await fs.readFile(alias), bytes)
  assert.equal((await fs.lstat(target)).nlink, 2)
  assert.equal((await fs.lstat(alias)).nlink, 2)
  assert.deepEqual(await optionalJsonLines(attemptFile), [])
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'), true)
})

test('hardlink compatibility: a rename moves a hardlinked source across owned directories with its bytes and inode intact', async () => {
  const fixture = await makeCase('hardlink-rename-move')
  const library = path.join(fixture.sandbox, 'library')
  const trash = path.join(fixture.sandbox, 'trash')
  const target = path.join(library, 'target.txt')
  const sibling = path.join(library, 'sibling.txt')
  const destination = path.join(trash, 'moved.txt')
  const bytes = Buffer.from('owned hardlink move bytes\n')
  await fs.mkdir(library, { mode: 0o700 })
  await fs.mkdir(trash, { mode: 0o700 })
  await fs.writeFile(target, bytes)
  await fs.link(target, sibling)
  const before = await fs.lstat(target)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try {
      await fs.rename(${JSON.stringify(target)}, ${JSON.stringify(destination)})
      outcome = { ok: true }
    } catch (error) {
      outcome = { ok: false, code: error.code }
    }
    console.log(JSON.stringify(outcome))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: true })
  await assertMissing(target)
  const moved = await fs.lstat(destination)
  assert.equal(moved.dev, before.dev)
  assert.equal(moved.ino, before.ino, 'a rename moves the name; the inode and its bytes are the same file')
  assert.equal(moved.nlink, 2, 'the moved name and its sibling alias still share one inode')
  assert.deepEqual(await fs.readFile(destination), bytes)
  const siblingStat = await fs.lstat(sibling)
  assert.equal(siblingStat.dev, before.dev)
  assert.equal(siblingStat.ino, before.ino)
  assert.deepEqual(await fs.readFile(sibling), bytes)
  const evidence = await records(fixture)
  assert.equal(evidence.some(record => record.phase === 'snapshot-refused'), false)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false,
    'a rename onto a fresh name destroys nothing, so it is not snapshotted as a destructive target')
})

test('hardlink compatibility: a rename of a hardlinked source is refused when an alias sits outside its parent', async () => {
  const fixture = await makeCase('hardlink-rename-alias-deficit')
  const firstParent = path.join(fixture.sandbox, 'first')
  const secondParent = path.join(fixture.sandbox, 'second')
  const trash = path.join(fixture.sandbox, 'trash')
  const siblingTarget = path.join(firstParent, 'target.txt')
  const siblingAlias = path.join(secondParent, 'alias.txt')
  const outsideTarget = path.join(firstParent, 'outside-target.txt')
  const outsideAlias = path.join(fixture.root, 'outside-alias.txt')
  const siblingBytes = Buffer.from('sibling-parent bytes\n')
  const outsideBytes = Buffer.from('outside-root bytes\n')
  await fs.mkdir(firstParent, { mode: 0o700 })
  await fs.mkdir(secondParent, { mode: 0o700 })
  await fs.mkdir(trash, { mode: 0o700 })
  await fs.writeFile(siblingTarget, siblingBytes)
  await fs.link(siblingTarget, siblingAlias)
  await fs.writeFile(outsideTarget, outsideBytes)
  await fs.link(outsideTarget, outsideAlias)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    const outcomes = []
    for (const [source, destination] of ${JSON.stringify([
    [siblingTarget, path.join(trash, 'sibling-moved.txt')],
    [outsideTarget, path.join(trash, 'outside-moved.txt')],
  ])}) {
      try { await fs.rename(source, destination); outcomes.push({ ok: true }) }
      catch (error) { outcomes.push({ ok: false, code: error.code }) }
    }
    console.log(JSON.stringify(outcomes))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), Array(2).fill({
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  }))
  assert.deepEqual(await fs.readFile(siblingTarget), siblingBytes)
  assert.deepEqual(await fs.readFile(siblingAlias), siblingBytes)
  assert.deepEqual(await fs.readFile(outsideTarget), outsideBytes)
  assert.deepEqual(await fs.readFile(outsideAlias), outsideBytes)
  assert.equal((await fs.lstat(siblingTarget)).nlink, 2)
  assert.equal((await fs.lstat(outsideTarget)).nlink, 2)
  await assertMissing(path.join(trash, 'sibling-moved.txt'))
  await assertMissing(path.join(trash, 'outside-moved.txt'))
  const evidence = await records(fixture)
  assert.equal(evidence.filter(record => record.phase === 'snapshot-refused').length, 2)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
})

test('hardlink compatibility: a rename onto a hardlinked destination is still refused before native dispatch', async () => {
  const fixture = await makeCase('hardlink-rename-destination')
  const source = path.join(fixture.sandbox, 'source.txt')
  const trash = path.join(fixture.sandbox, 'trash')
  const destination = path.join(trash, 'destination.txt')
  const destinationAlias = path.join(trash, 'destination-alias.txt')
  const sourceBytes = Buffer.from('moving bytes\n')
  const destinationBytes = Buffer.from('destination bytes\n')
  await fs.mkdir(trash, { mode: 0o700 })
  await fs.writeFile(source, sourceBytes)
  await fs.writeFile(destination, destinationBytes)
  await fs.link(destination, destinationAlias)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rename(${JSON.stringify(source)}, ${JSON.stringify(destination)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), {
    ok: false,
    code: 'ERR_STORY_STUDIO_RETAINED_FS_REFUSED',
  })
  assert.deepEqual(await fs.readFile(source), sourceBytes)
  assert.deepEqual(await fs.readFile(destination), destinationBytes)
  assert.deepEqual(await fs.readFile(destinationAlias), destinationBytes)
  const evidence = await records(fixture)
  assert.equal(evidence.filter(record => record.phase === 'snapshot-refused').length, 1)
  assert.equal(evidence.some(record => record.phase === 'snapshot-verified'), false)
})

test('hardlink compatibility: a rename of a hardlinked source onto an existing destination records the source alias proof', async () => {
  const fixture = await makeCase('hardlink-rename-receipt')
  const library = path.join(fixture.sandbox, 'library')
  const trash = path.join(fixture.sandbox, 'trash')
  const target = path.join(library, 'target.txt')
  const sibling = path.join(library, 'sibling.txt')
  const destination = path.join(trash, 'destination.txt')
  const bytes = Buffer.from('recorded hardlink move bytes\n')
  const previousBytes = Buffer.from('previous destination bytes\n')
  await fs.mkdir(library, { mode: 0o700 })
  await fs.mkdir(trash, { mode: 0o700 })
  await fs.writeFile(target, bytes)
  await fs.link(target, sibling)
  await fs.writeFile(destination, previousBytes)

  const result = await runChild(fixture, `
    import fs from 'node:fs/promises'
    let outcome
    try { await fs.rename(${JSON.stringify(target)}, ${JSON.stringify(destination)}); outcome = { ok: true } }
    catch (error) { outcome = { ok: false, code: error.code } }
    console.log(JSON.stringify(outcome))
  `)

  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  assert.deepEqual(lastJson(result.stdout), { ok: true })
  await assertMissing(target)
  assert.deepEqual(await fs.readFile(destination), bytes)
  assert.deepEqual(await fs.readFile(sibling), bytes)
  const receipt = await verifiedFor(fixture, destination, 'rename')
  assert.equal(receipt.source, 'library/target.txt')
  assert.equal(receipt.sourceHardlinkProof.parent, 'library')
  assert.equal(receipt.sourceHardlinkProof.nlink, 2)
  assert.deepEqual(receipt.sourceHardlinkProof.aliases, ['library/sibling.txt', 'library/target.txt'])
  assert.deepEqual(await fs.readFile(await snapshotPayload(fixture, receipt)), previousBytes)
})
