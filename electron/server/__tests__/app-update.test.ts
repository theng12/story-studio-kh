/**
 * Remote updates (services/app-update.ts): signature verify, drain and resume, the boot settle,
 * the swap helper and its rollback, extraction, and the login agent. Everything runs in temp
 * dirs: a fake installed app, a fake staged app, a fake state file. No real bundle is touched.
 */

import { test, describe, beforeEach, afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { clearTimeout as clearRealTimeout, setTimeout as realSetTimeout } from 'node:timers'

import { useTempDataDir } from './_helpers.js'
import { diagnosticPhase, installDiagnosticHooks } from './_diagnostic-phases.js'
import { sleep, waitFor } from './_timing.js'
import * as updater from '../services/app-update.js'
import { __setFinalCheckRunnerForTests, runningFinalChecks, startFinalCheck } from '../lib/final-video-check.js'

/**
 * The swap helper `install()` spawns is detached and unref'd, so a test has no handle on it: it
 * waits for the app to quit and keeps writing into the fixture after the test is done. Mocking
 * `spawn` for that one call hands the test the helper's own ChildProcess, so "the helper has
 * finished" is its exit. Every other spawn is delegated untouched.
 */
type HelperProcess = {
  child: ChildProcess
  /** Resolves with the helper's exit code when the helper process is gone. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** A spawn that never started is a failure, not a quiet exit. */
  error: () => Error | undefined
}

function captureHelperSpawns(
  t: TestContext,
  script: string,
): { processes: HelperProcess[]; restore: () => void } {
  const childProcess = createRequire(import.meta.url)('node:child_process') as {
    spawn: (...args: any[]) => ChildProcess
  }
  const original = childProcess.spawn
  const processes: HelperProcess[] = []
  const mocked = t.mock.method(childProcess, 'spawn', (...args: any[]) => {
    const child = Reflect.apply(original, childProcess, args) as ChildProcess
    const [command, argv] = args as [string, string[]]
    if (command === '/bin/bash' && Array.isArray(argv) && argv.length === 1 && argv[0] === script) {
      let failure: Error | undefined
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
        child.once('error', (error: Error) => { failure = error; resolve({ code: null, signal: null }) })
      })
      processes.push({ child, exited, error: () => failure })
    }
    return child
  })
  // The updater imports `spawn` as an ESM named export: the facade has to see the mock.
  syncBuiltinESMExports()
  let restored = false
  return {
    processes,
    restore: () => {
      if (restored) return
      restored = true
      mocked.mock.restore()
      syncBuiltinESMExports()
    },
  }
}

/** `<Library>/_trash/_story-studio` in the test's own data folder. */
async function libraryAppTrash(): Promise<string> {
  const { projectsRoot } = await import('../services/project-manager.js')
  return path.join(projectsRoot(), '_trash', '_story-studio')
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64')

function signed(fields: Partial<updater.ReleaseDescriptor> = {}, key = privateKey, pub = PUB): updater.ReleaseDescriptor {
  const d: any = {
    schema: updater.RELEASE_SCHEMA, schema_version: 1, app: 'story', version: '1.4.258', build: '1.4.258',
    filename: 'Story Studio KH 1.4.258.zip', bytes: 10, sha256: 'a'.repeat(64), published_at: 1,
    publisher_id: 'gatewaykh', publisher_key_id: updater.fingerprint(pub), ...fields,
  }
  d.signature = sign(null, updater.canonicalBytes(d), key).toString('base64')
  return d
}

/** A tiny real .app: a Mach-O executable (so codesign works), an Info.plist, ad-hoc signed. */
function makeApp(dir: string, version: string): string {
  const app = path.join(dir, 'Story Studio KH.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Story Studio KH'))
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Story Studio KH</string>
<key>CFBundleIdentifier</key><string>test.story.update</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' })
  return app
}

function plistVersion(app: string): string {
  return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
    path.join(app, 'Contents', 'Info.plist')]).toString().trim()
}

function fakeQueue(running = 0, paused = false, queued = 0) {
  const q = {
    paused, owner: null as string | null, runningCount: running, queued, pausedJobs: 0, calls: [] as boolean[],
    isPaused: () => q.paused,
    setPaused: async (p: boolean) => { q.calls.push(p); q.paused = p; q.owner = null },
    pauseOwner: () => q.paused ? q.owner : null,
    acquirePause: async (token: string) => {
      if (q.paused) return q.owner === token
      const transition = q.setPaused(true)
      q.owner = token
      await transition
      return true
    },
    releasePause: async (token: string) => {
      if (!q.paused || q.owner !== token) return false
      await q.setPaused(false)
      return true
    },
    running: () => q.runningCount,
    summary: () => ({ running: q.runningCount, queued: q.queued, paused: q.pausedJobs }),
  }
  return q
}

/** The real wiring's four extra answers (routes/app-update.ts): submissions in flight, jobs that
 * would not resume, final checks still measuring, and the one non-queue maintenance operation
 * holding the Mac. */
function promptQueue(running = 0) {
  const q = Object.assign(fakeQueue(running), {
    submits: 0, notResuming: [] as string[], looks: 0, finalChecks: 0,
    maintenanceOp: null as { id: string; kind: string; status: string } | null,
  })
  return Object.assign(q, {
    inFlightSubmits: () => q.submits,
    wouldNotResume: async () => { q.looks++; return q.notResuming },
    maintenance: () => q.maintenanceOp,
    runningFinalChecks: () => q.finalChecks,
  })
}

let tmp: { dir: string; cleanup: () => Promise<void> }
let settings: updater.UpdateSettings

function options(queue: any, extra: Partial<updater.UpdaterOptions> = {}): updater.UpdaterOptions {
  return {
    currentVersion: '1.4.257', appBundle: path.join(tmp.dir, 'Applications', 'Story Studio KH.app'), port: 1,
    quit: () => {}, queue,
    getSettings: async () => settings,
    saveSettings: async (p) => { settings = { ...settings, ...p } },
    gateway: async () => ({ url: 'http://gateway.test', key: 'k' }),
    channels: async () => 4,
    ...extra,
  }
}

installDiagnosticHooks('app-update.test.ts')
beforeEach(async () => {
  tmp = await diagnosticPhase('fixture-create', () => useTempDataDir())
  settings = updater.defaultSettings(null)
  updater._resetForTesting()
})
afterEach(async () => {
  updater._resetForTesting()
  // A parked final check would hold the next test's drain for a check that never finishes.
  __setFinalCheckRunnerForTests(null)
  await diagnosticPhase('fixture-cleanup', () => tmp.cleanup())
})

describe('signature', () => {
  test('a signed release verifies; any change, or another key, does not', () => {
    const d = signed()
    assert.equal(updater.verifyRelease(d, PUB).version, '1.4.258')
    assert.throws(() => updater.verifyRelease({ ...d, version: '9.9.9' }, PUB), /signature does not verify/)
    const other = generateKeyPairSync('ed25519')
    const otherPub = (other.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64')
    assert.throws(() => updater.verifyRelease(signed({}, other.privateKey, otherPub), PUB), /does not trust/)
    assert.throws(() => updater.verifyRelease(signed({ app: 'hub' }), PUB), /not a Story Studio release/)
    assert.throws(() => updater.verifyRelease(signed({ filename: '../x.sh' }), PUB), /not a \.dmg or \.zip/)
  })

  test('versions order numerically', () => {
    assert.equal(updater.compareVersions('1.4.258', '1.4.257'), 1)
    assert.equal(updater.compareVersions('1.4.99', '1.4.100'), -1)
    assert.equal(updater.compareVersions('1.4', '1.4.0'), 0)
  })

  test('the key is pinned on first sight and a different one is then refused', async () => {
    const queue = fakeQueue()
    updater._configureForTesting(options(queue))
    // An older or equal release changes nothing and pins nothing.
    await updater.handleOffer({ release: signed({ version: '1.4.257' }), publisher: { public_key_base64: PUB } })
    assert.equal(settings.trusted_publisher_key, undefined)
    const other = generateKeyPairSync('ed25519')
    const otherPub = (other.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64')
    settings.trusted_publisher_key = PUB
    await assert.rejects(updater.handleOffer({ release: signed({}, other.privateKey, otherPub),
      publisher: { public_key_base64: otherPub } }), /does not trust/)
    assert.equal(settings.trusted_publisher_key, PUB)
  })
})

describe('download, stage, drain and resume', () => {
  test('a newer release is downloaded, checked, staged without quarantine, then pauses new work for a prompt install', async () => {
    const src = fs.mkdtempSync(path.join(tmp.dir, 'src-'))
    makeApp(src, '1.4.258')
    const zip = path.join(tmp.dir, 'Story Studio KH 1.4.258.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(src, 'Story Studio KH.app'), zip])
    const bytes = fs.readFileSync(zip)
    const release = signed({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    const queue = fakeQueue(2)
    const fetch = (async (url: string) => {
      assert.match(String(url), /\/v1\/apps\/story\/release\/file$/)
      return new Response(bytes)
    }) as any
    updater._configureForTesting(options(queue, { fetch }))

    await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
    const state = updater.readState()
    assert.equal(settings.trusted_publisher_key, PUB)
    assert.equal(state.phase, 'draining', 'staged: new work pauses at once (1.4.265)')
    assert.equal(plistVersion(state.staged_app!), '1.4.258')
    // A file this process wrote carries no quarantine attribute (the reason no `xattr -d` is needed).
    const downloaded = path.join(updater.updateDir(), 'staging', '1.4.258', release.filename)
    assert.throws(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', downloaded], { stdio: 'pipe' }))
    assert.deepEqual(queue.calls, [true], 'the updater pauses new intake itself')
    assert.ok(state.we_paused)
  })

  test('a download that is not fully available yet is "not ready": nothing is failed, the next check retries', async () => {
    const release = signed({ bytes: 3, sha256: createHash('sha256').update('xyz').digest('hex') })
    const answers: Array<() => Response> = [
      () => new Response('missing', { status: 404 }), // not uploaded yet
      () => new Response(Buffer.from('xy')), // short file
      () => new Response(Buffer.from('xyq')), // right size, wrong bytes (still uploading)
      () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([120])); c.error(new Error('connection dropped')) } })),
    ]
    let downloads = 0
    const fetch = (async () => answers[downloads++]()) as any
    updater._configureForTesting(options(fakeQueue(), { fetch }))
    settings.trusted_publisher_key = PUB
    for (let check = 1; check <= answers.length; check++) {
      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      const state = updater.readState()
      assert.equal(downloads, check, 'every check downloads again, from zero')
      assert.equal(state.phase, 'idle')
      assert.match(state.error!, /not fully available yet/)
      assert.equal(state.failed_signature ?? null, null, 'not recorded as a failed install')
    }
  })

  for (const stall of ['headers', 'body'] as const) {
    test(`a stalled download ${stall} aborts and releases the shared check for retry`, async (t) => {
      const release = signed()
      settings.trusted_publisher_key = PUB
      let downloads = 0, cancelled = false, rejectHeaders: ((e: Error) => void) | undefined
      let signal: AbortSignal | undefined
      const fetch = (async (url: string, init: RequestInit) => {
        if (String(url).endsWith('/checkin')) return Response.json({ release, publisher: { public_key_base64: PUB } })
        downloads++
        if (downloads > 1) return new Response('missing', { status: 404 })
        signal = init.signal ?? undefined
        if (stall === 'headers') return new Promise((_, reject) => {
          rejectHeaders = reject
          signal?.addEventListener('abort', () => reject(new Error('download aborted')), { once: true })
        })
        return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } }))
      }) as any
      updater._configureForTesting(options(fakeQueue(), { fetch }))
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const checking = updater.checkNow()
      assert.equal(checking, updater.checkNow(), 'in-flight checks share one promise')
      for (let i = 0; i < 1000 && downloads !== 1; i++) await new Promise(r => setImmediate(r))
      assert.equal(downloads, 1)
      // 30 s with no byte arriving aborts, and that is the only clock: there is no wall-clock
      // deadline (a slow-but-moving download must never be killed), so a stall of any length ends here.
      t.mock.timers.tick(15 * 60_000)
      for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r))
      try {
        assert.equal(signal?.aborted, true, 'download request is bounded')
        await checking
        assert.equal(updater.readState().phase, 'idle')
        assert.match(updater.readState().error!, /not fully available yet/)
        assert.equal(updater.readState().failed_signature ?? null, null)
        if (stall === 'body') assert.equal(cancelled, true, 'aborted pipeline cancels the body')
        await updater.checkNow()
        assert.equal(downloads, 2, 'a later check retries instead of joining the old promise')
      } finally {
        rejectHeaders?.(new Error('fixture release'))
        t.mock.timers.reset()
      }
    })
  }

  test('a failed install is retried after about two checks; a re-publish (new signature) at once', async () => {
    const bytes = Buffer.from('not a zip')
    const release = signed({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    let downloads = 0
    const fetch = (async () => { downloads++; return new Response(bytes) }) as any
    updater._configureForTesting(options(fakeQueue(), { fetch }))
    settings.trusted_publisher_key = PUB
    await assert.rejects(updater.handleOffer({ release, publisher: { public_key_base64: PUB } }))
    let state = updater.readState()
    assert.equal(state.phase, 'failed')
    assert.equal(state.failed_signature, release.signature)
    await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
    assert.equal(downloads, 1, 'the next check (30 minutes later) leaves the same release alone')
    updater.writeState({ ...state, failed_at: Date.now() - updater.FAILED_RETRY_AFTER_MS - 1 })
    await assert.rejects(updater.handleOffer({ release, publisher: { public_key_base64: PUB } }))
    assert.equal(downloads, 2, 'tried again automatically after about two checks')
    const republished = signed({ bytes: bytes.length, sha256: release.sha256, published_at: 2 })
    assert.notEqual(republished.signature, release.signature)
    await assert.rejects(updater.handleOffer({ release: republished, publisher: { public_key_base64: PUB } }))
    assert.equal(downloads, 3, 'a re-publish is tried at once')
    state = updater.readState()
    assert.equal(state.failed_signature, republished.signature)
  })

  test('checks run every 30 minutes', () => {
    assert.equal(updater.CHECK_INTERVAL_MS, 30 * 60_000)
    assert.equal(updater.FAILED_RETRY_AFTER_MS, 2 * updater.CHECK_INTERVAL_MS)
  })

  function ready(extra: Partial<updater.UpdateState> = {}) {
    const staged = makeApp(fs.mkdtempSync(path.join(tmp.dir, 'staged-')), '1.4.258')
    updater.writeState({ phase: 'ready', release: signed(), staged_app: staged, ...extra })
  }

  test('an owner Resume during the drain wins: the update waits for Install Now', async () => {
    ready({ install_requested: true })
    const queue = fakeQueue(1)
    updater._configureForTesting(options(queue))
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'draining')
    queue.paused = false // the owner pressed Resume
    await waitFor(() => updater.readState().phase === 'ready', { label: 'the drain to give way' })
    const state = updater.readState()
    assert.equal(state.phase, 'ready')
    assert.equal(state.held, true)
    assert.equal(state.we_paused, false)
    await updater.maybeInstall() // the next check does not fight him
    assert.equal(updater.readState().phase, 'ready')
  })

  test('a queue the owner had already paused is drained but never resumed by the updater', async () => {
    ready({ install_requested: true })
    const queue = fakeQueue(1, true)
    updater._configureForTesting(options(queue))
    await updater.maybeInstall()
    assert.equal(updater.readState().we_paused, false)
    assert.deepEqual(queue.calls, [])
  })

  test('auto-install off waits for Install Now, even with an empty queue', async () => {
    ready()
    settings.auto_install = false
    updater._configureForTesting(options(fakeQueue()))
    await updater.maybeInstall()
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready')
  })
})

describe('install promptly (owner, 2026-10-09)', () => {
  function ready() {
    const target = makeApp(path.join(tmp.dir, 'Applications'), '1.4.257')
    const staged = makeApp(fs.mkdtempSync(path.join(tmp.dir, 'staged-')), '1.4.258')
    updater.writeState({ phase: 'ready', release: signed(), staged_app: staged })
    return target
  }
  const clock = { t: 0 }
  /**
   * The real helper, against a temp target, with a stand-in pid and a relaunch that reports
   * healthy. `clock.t` is what the updater reads; the wait looks every 20 ms. A caller that holds
   * the hand-off passes the stand-in it owns, so the helper waits for that pid instead of for a
   * sleeper nobody keeps track of.
   */
  function wired(queue: any, extra: Partial<updater.UpdaterOptions> = {}, standIn?: { pid: number }) {
    const quitter = standIn ? null : spawn('/bin/sleep', ['1'])
    const pid = standIn ? standIn.pid : quitter!.pid
    const state = path.join(updater.updateDir(), 'state.json')
    clock.t = 1_000_000
    updater._configureForTesting(options(queue, {
      idlePollMs: 3_600_000, drainPollMs: 20, now: () => clock.t,
      relaunchCommand: `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(state)}`,
      helperEnv: { SU_PID: String(pid), SU_HEALTH_SECONDS: '5' },
      ...extra,
    }))
  }
  /**
   * The relaunch the helper starts in the background. It writes the marker as its last act, named
   * after the helper that started it, so each helper's own relaunch is accounted for and not just
   * the first one.
   *
   * The name is the helper's PROCESS GROUP id, not `$PPID`. A helper that relaunches and then exits
   * at once (the two "could not move the app" paths, and the rollback that ends the script) is gone
   * before the relaunch starts, so the orphan is reparented to PID 1 and `$PPID` reads 1: the
   * relaunch then writes its marker as `1` and the helper's own marker never appears. The helper is
   * spawned detached, so it leads its own session and process group: its group id is its own pid,
   * and that does not change when it exits.
   */
  function relaunchCommand(markers: string): string {
    const state = path.join(updater.updateDir(), 'state.json')
    const helperPid = 'name=$(ps -o pgid= -p $$ 2>/dev/null | tr -d \'[:space:]\'); [ -n "$name" ] || { echo "no helper identity for the relaunch" >&2; exit 1; }'
    return `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(state)}; ${helperPid}; printf relaunched > ${JSON.stringify(markers)}/$name`
  }
  /**
   * A hand-off the test can hold: the helper waits for a stand-in the test owns, so it cannot write
   * into the fixture while the body asserts. The finally ends that stand-in explicitly and waits for
   * the helper's own exit and for the relaunch it left running; a settlement error never replaces
   * the body's own failure.
   */
  async function heldHandoff<T>(
    t: TestContext,
    queue: any,
    extra: Partial<updater.UpdaterOptions>,
    body: () => Promise<T>,
  ): Promise<T> {
    const markers = path.join(os.tmpdir(), `story-app-update-relaunch-${process.pid}-${randomUUID()}`)
    fs.mkdirSync(markers)
    const capture = captureHelperSpawns(t, path.join(updater.updateDir(), 'swap-app.sh'))
    const standIn = spawn('/bin/sleep', ['3600'])
    const standInGone = new Promise<void>(resolve => {
      standIn.once('exit', () => resolve())
      standIn.once('error', () => resolve())
    })
    if (!standIn.pid) throw new Error('the stand-in the helper waits for has no pid')
    let failed = false
    let thrown: unknown
    try {
      wired(queue, { relaunchCommand: relaunchCommand(markers), ...extra }, { pid: standIn.pid })
      return await body()
    } catch (error) {
      failed = true
      thrown = error
    } finally {
      capture.restore()
      if (!standIn.killed) standIn.kill('SIGTERM')
      // The helper polls the stand-in's pid: it must be gone, not a zombie, before the helper moves on.
      await standInGone
      standIn.unref()
      try {
        await settleHelpers(capture.processes, markers)
      } catch (error) {
        if (!failed) throw error
      }
    }
    throw thrown
  }
  /** The helper's own exit, then the relaunch that helper left running. */
  async function settleHelpers(processes: HelperProcess[], markers: string): Promise<void> {
    for (const helper of processes) {
      helper.child.ref()
      const { code, signal } = await withBound(helper.exited, 60_000, 'the swap helper never finished')
      const error = helper.error()
      if (error) throw error
      if (signal) throw new Error('the swap helper was killed before it finished')
      if (code === 2) continue // it refused to start, so it never relaunched
      await waitForMarker(path.join(markers, String(helper.child.pid)))
    }
  }
  /** A wait that ends, so a helper that never finishes fails the test instead of hanging the run. */
  function withBound<T>(wait: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = realSetTimeout(() => reject(new Error(what)), ms)
      wait.then(
        value => { clearRealTimeout(timer); resolve(value) },
        error => { clearRealTimeout(timer); reject(error) },
      )
    })
  }
  /** Bounded wait for one helper's relaunch marker. The bound is a real timer, not the global one
   * a test may have mocked, and the watch is always closed via fs.unwatchFile (StatWatcher.close
   * does not reliably detach the poll on macOS and leaves the event loop held). */
  async function waitForMarker(file: string): Promise<void> {
    if (fs.existsSync(file)) return
    await new Promise<void>((resolve, reject) => {
      let done = false
      fs.watchFile(file, { interval: 50 }, () => {
        if (fs.existsSync(file)) finish()
      })
      const timer = realSetTimeout(() => finish(new Error(`the relaunch never wrote ${file}`)), 30_000)
      function finish(error?: Error) {
        if (done) return
        done = true
        clearRealTimeout(timer)
        fs.unwatchFile(file)
        if (error) reject(error)
        else resolve()
      }
    })
  }
  /** The helper's own verdict, read once it has exited: it wrote the file before it went. */
  function helperOutcome(): string {
    const result = path.join(updater.updateDir(), 'helper-result.json')
    return JSON.parse(fs.readFileSync(result, 'utf8')).outcome
  }
  /** The updater has looked at the queue twice more since now (each look asks `wouldNotResume`). */
  const lookedAgain = async (queue: { looks: number }) => {
    const seen = queue.looks
    await waitFor(() => queue.looks >= seen + 2, { label: 'two more looks at the queue' })
  }
  async function installed(): Promise<void> {
    await waitFor(() => updater.readState().phase === 'installing', { label: 'the install', timeoutMs: 15_000 })
    const result = path.join(updater.updateDir(), 'helper-result.json')
    await waitFor(() => fs.existsSync(result), { label: 'the helper result' })
    assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).outcome, 'installed')
  }
  /**
   * How many helpers were really spawned: the helper's first act is one "waiting for pid" log line,
   * so the count is the hand-off count as the helper itself saw it.
   */
  function handoffs(): number {
    const log = path.join(updater.updateDir(), 'helper.log')
    return fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('waiting for pid')).length
      : 0
  }
  /**
   * `install()` writes swap-app.sh from scratch every time, so a marker appended after one hand-off
   * survives exactly one hand-off: a second one rewrites the file and drops it. The marker is a
   * comment, so a helper that reads the script after the append still runs it normally.
   */
  const HANDOFF_MARKER = '# one-hand-off'
  function markedOnce(script: string): boolean {
    fs.appendFileSync(script, `\n${HANDOFF_MARKER}\n`)
    return true
  }
  function stillMarked(script: string): boolean {
    return fs.existsSync(script) && fs.readFileSync(script, 'utf8').includes(HANDOFF_MARKER)
  }
  /**
   * Use this live process as the stand-in app: an unowned sleeper would keep the test worker alive.
   * The two tests that use it never hand off, so no helper ever waits on that pid; a hand-off that
   * has to be waited for owns its stand-in instead (see `heldHandoff`).
   */
  const keepAppAlive = { helperEnv: { SU_PID: String(process.pid), SU_HEALTH_SECONDS: '5', SU_QUIT_WAIT: '300' } }
  /** What a real tracked cleanup's work returns; this file never inspects it. */
  const CLEAN = { items: [], item_count: 0, bytes_freed: 0, deleted_count: 0, skipped_count: 0, failed_count: 0 }

  test('running work that resumes is not waited for: intake pauses, in-flight submits settle, it installs', async () => {
    const target = ready()
    const queue = promptQueue(3) // e.g. a Video Assembly mid-render, a scene render, a narration
    queue.queued = 5
    queue.submits = 1
    wired(queue)
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'draining')
    assert.deepEqual(queue.calls, [true], 'new intake is paused (a queue-origin pause)')
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'a submission already sent is answered first')
    assert.deepEqual((await updater.status()).waiting_for, { submits: 1, jobs: [], finalChecks: 0, maintenance: null })
    queue.submits = 0
    await installed()
    assert.equal(plistVersion(target), '1.4.258')
  })

  test('the wait for submissions is bounded: after 2 minutes it installs anyway', async () => {
    ready()
    const queue = promptQueue(1)
    queue.submits = 2
    wired(queue)
    await updater.maybeInstall()
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining')
    clock.t += updater.SUBMIT_SETTLE_MS - 1_000
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'still inside the bound')
    clock.t += 2_000
    await installed()
  })

  test('a running job that would not resume is waited for, with no time limit, and named', async () => {
    ready()
    const queue = promptQueue(2)
    queue.notResuming = ['music_video']
    wired(queue)
    await updater.maybeInstall()
    clock.t += 10 * 60 * 60_000
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'never interrupted automatically')
    assert.deepEqual((await updater.status()).waiting_for, { submits: 0, jobs: ['music_video'], finalChecks: 0, maintenance: null })
    queue.notResuming = []
    await installed()
  })

  test('a final check still measuring a finished video is waited for: a restart would lose the verdict', async () => {
    ready()
    // A real parked check, read through the same registry `routes/app-update.ts` wires in. The
    // on-demand check runs in the background and writes its verdict at the end, so a restart in the
    // middle throws the whole measurement away (Night Atlas Mythology EP0008, 2026-10-19).
    const videoPath = path.join(tmp.dir, 'EP0001_final_video.mp4')
    let release!: () => void
    const parked = new Promise<void>(resolve => { release = resolve })
    __setFinalCheckRunnerForTests(async (file, expected) => {
      await parked
      return {
        checked_at: new Date().toISOString(),
        file: { size: 0, mtime_ms: 0 },
        expected,
        actual: {
          duration_sec: 0, video_sec: null, audio_sec: null, width: 0, height: 0,
          tail_lufs: null, black: [], silence: [],
        },
        passed: true,
        issues: [],
      }
    })
    startFinalCheck(videoPath, {
      planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
      width: 0, height: 0, subtitles_path: null,
    })
    assert.equal(runningFinalChecks(), 1, 'the check is measuring')

    const queue = promptQueue()
    queue.runningFinalChecks = runningFinalChecks
    wired(queue)
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'draining')
    clock.t += 10 * 60 * 60_000
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'never interrupted automatically')
    const status = await updater.status()
    assert.deepEqual(status.waiting_for, { submits: 0, jobs: [], finalChecks: 1, maintenance: null })
    assert.equal(status.final_checks_running, 1, 'the status says what is holding the install')
    assert.equal(status.jobs_left, 0, 'a check is not a queue job: one number must not mean two things')

    // The check finishes and writes its verdict; only then does the install go ahead.
    release()
    await waitFor(() => runningFinalChecks() === 0, { label: 'the parked final check to finish' })
    await installed()
  })

  test('a running maintenance operation does not pause the queue: the release stays staged, and the status names the wait', async () => {
    const target = ready()
    const queue = promptQueue(3)
    queue.maintenanceOp = { id: 'op-1', kind: 'run', status: 'running' }
    wired(queue)

    // The production shape of 2026-10-19/20: a staged release and an all-channel Free Up Space run
    // of ~9 hours. Pausing the queue for it stopped every job on the Mac for the whole run, for an
    // install that could do nothing but wait. So the release stays staged and the queue runs.
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready', 'the drain is not claimed while the operation runs')
    assert.deepEqual(queue.calls, [], 'the queue is not paused on the operation\'s behalf')
    const staged = await updater.status()
    assert.equal(staged.queue_paused, false, 'the queue is running normally')
    assert.equal(staged.jobs_left, 3, 'and its jobs are still there, not parked behind the install')
    assert.deepEqual(staged.maintenance_running, { id: 'op-1', kind: 'run', status: 'running' },
      'the status says plainly what the install is waiting for')

    // It finishes, fails or is stopped: only now is the drain claimed, and the install goes ahead.
    queue.maintenanceOp = null
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'draining', 'claimed once nothing is holding the Mac')
    assert.deepEqual(queue.calls, [true], 'and now new intake pauses')
    await installed()
    assert.equal(plistVersion(target), '1.4.258')
  })

  test('the real gate refuses a new operation from the moment the drain is claimed, and not before', async () => {
    // Both halves of the production coupling: `routes/app-update.ts` wires the drain's maintenance
    // term to `episode-media-cleanup`'s registry, and that registry refuses a new operation on
    // `isUpdateHoldingForRestart()` — the phase the drain writes. So the claim is what arms the
    // gate, and it is armed only once the running operation is gone. A claim taken any earlier
    // would hold the Mac for the operation's whole run (2026-10-19/20: ~9 hours).
    const cleanup = await import('../services/episode-media-cleanup.js')
    const { projectsRoot } = await import('../services/project-manager.js')
    cleanup._resetMediaCleanupStateForTests()
    const projectDir = path.join(projectsRoot(), 'drain-gate')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({ slug: 'drain-gate', name: 'Drain Gate' }))
    const work = async () => CLEAN

    let finish!: () => void
    const parked = new Promise<void>(resolve => { finish = resolve })
    const { operation_id } = await cleanup.startTrackedCleanup('drain-gate', 'verifying', async () => {
      await parked
      return CLEAN
    })
    await waitFor(() => cleanup.activeMaintenanceOperation()?.status === 'running', { label: 'the operation to start running' })

    ready()
    const queue = promptQueue()
    queue.maintenance = cleanup.activeMaintenanceOperation
    wired(queue)
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready', 'staged while the operation runs')
    assert.equal(queue.paused, false, 'so the queue runs through it')
    assert.deepEqual((await updater.status()).maintenance_running, { id: operation_id, kind: 'run', status: 'running' },
      'and the status names what it waits for')

    finish()
    await waitFor(() => cleanup.activeMaintenanceOperation() === null, { label: 'the operation to end' })
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'draining', 'the claim is taken now')
    await assert.rejects(cleanup.startTrackedCleanup('drain-gate', 'verifying', work),
      /installing an update and will restart in a moment/, 'and from now a new operation is refused')
    await installed()
    cleanup._resetMediaCleanupStateForTests()
  })

  test('an operation that begins while the pause is being taken does not get a paused queue: the claim is let go', async () => {
    const target = ready()
    const queue = promptQueue()
    wired(queue)
    const acquire = queue.acquirePause
    let once = true
    queue.acquirePause = async (token: string) => {
      const owned = await acquire(token)
      // It begins in the one window the staged look cannot see: after the look, before the write
      // that claims the drain. Claiming now would pause the queue for its whole run, so the claim
      // is let go and the release goes back to waiting staged.
      if (once) { once = false; queue.maintenanceOp = { id: 'op-race', kind: 'run', status: 'running' } }
      return owned
    }

    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready', 'no drain is claimed for an operation that began in the window')
    assert.equal(queue.paused, false, 'and the pause taken a moment before it is let go')
    assert.equal(updater.readState().we_paused, false)
    assert.equal(updater.readState().pause_owner_token, null, 'with nothing left that could authorize a release')

    queue.maintenanceOp = null
    await updater.maybeInstall()
    await installed()
    assert.equal(plistVersion(target), '1.4.258')
  })

  test('the 30-minute override never reaches a maintenance operation, and never pauses the queue for one', async () => {
    ready()
    const queue = promptQueue()
    queue.maintenanceOp = { id: 'op-1', kind: 'run', status: 'running' }
    wired(queue)
    await updater.installNow()
    assert.equal(updater.readState().phase, 'ready', 'Install Now waits staged too, with the queue running')
    assert.deepEqual(queue.calls, [])
    // The ceiling covers jobs the boot scan picks up again; a restart kills a cleanup mid-file, so
    // only "Install now (don't wait)" may cut it short. Time alone must never do it.
    clock.t += updater.DRAIN_TIMEOUT_MS + 60_000
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready', 'the override must not reach a cleanup')
    assert.deepEqual(queue.calls, [], 'and it must not pause the queue for one either')
    queue.maintenanceOp = null
    await updater.maybeInstall()
    await installed()
  })

  test('Install Now goes ahead after 30 minutes even if a job that cannot resume still runs', async () => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['broll_assemble']
    wired(queue)
    await updater.installNow()
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining')
    clock.t += updater.DRAIN_TIMEOUT_MS + 1_000
    await installed()
  })

  test('Install now (don\'t wait) installs at once from draining, with jobs that cannot resume still running', async () => {
    const target = ready()
    const queue = promptQueue(2)
    queue.notResuming = ['music_video']
    wired(queue)
    await updater.installNow()
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'plain Install Now keeps waiting')
    await updater.installNow(true)
    assert.equal(updater.readState().phase, 'installing', 'no wait for the running jobs')
    assert.equal(updater.readState().immediate, true)
    assert.equal(queue.runningCount, 2)
    assert.deepEqual(queue.calls, [true], 'intake stays paused; the updater releases it after the restart')
    assert.equal(updater.readState().we_paused, false, 'older rollback code cannot use its boolean-only release')
    assert.equal(updater.readState().pause_owner_token, queue.owner, 'new boot retains the authoritative claim')
    await installed()
    assert.equal(plistVersion(target), '1.4.258')
  })

  test('Install now (don\'t wait) from ready pauses intake and installs without a drain', async () => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['broll_assemble']
    wired(queue)
    await updater.installNow(true)
    assert.equal(updater.readState().phase, 'installing')
    assert.deepEqual(queue.calls, [true])
    await installed()
  })

  test('Install now (don\'t wait) while nothing is staged installs as soon as staging finishes', async () => {
    updater.writeState({ phase: 'downloading' })
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    wired(queue, { fetch: (async () => new Response('', { status: 404 })) as any })
    await updater.installNow(true)
    assert.equal(updater.readState().immediate, true, 'the request is recorded')
    assert.notEqual(updater.readState().phase, 'installing', 'nothing to install yet')
    const staged = makeApp(fs.mkdtempSync(path.join(tmp.dir, 'staged-')), '1.4.258')
    updater.writeState({ ...updater.readState(), phase: 'ready', release: signed(), staged_app: staged })
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'installing', 'no drain once staged')
  })

  test('two "Install now (don\'t wait)" presses make ONE hand-off: one helper, no draining write over installing', async t => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    await heldHandoff(t, queue, {}, async () => {
      // Both presses read the same `ready` state: hold each one inside `setPaused`, then release them
      // one at a time so the second continuation runs after the first has committed `installing`.
      const acquire = queue.acquirePause
      const releases: Array<() => void> = []
      queue.acquirePause = async (token: string) => {
        await new Promise<void>(resolve => { releases.push(resolve) })
        return acquire(token)
      }
      const presses = Promise.all([updater.installNow(true), updater.installNow(true)])
      await waitFor(() => releases.length === 2, { label: 'both presses waiting on the queue' })
      releases[0]!()
      await waitFor(() => updater.readState().phase === 'installing', { label: 'the first press committing' })
      const script = path.join(updater.updateDir(), 'swap-app.sh')
      markedOnce(script)
      releases[1]!()
      await presses
      assert.equal(updater.readState().phase, 'installing', 'the second press did not write draining over installing')
      assert.equal(stillMarked(script), true, 'no second hand-off: a second install() would have rewritten swap-app.sh')
      await waitFor(() => handoffs() >= 1, { label: 'the helper to start' })
      assert.equal(handoffs(), 1, 'the helper itself saw one hand-off')
    })
  })

  test('a drain suspended in the queue check cannot start a second helper once "Install now (don\'t wait)" has committed', async t => {
    ready()
    const queue = promptQueue(1)
    let checks = 0
    let enterGate!: () => void
    const entered = new Promise<void>(resolve => { enterGate = resolve })
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    let gated = false
    queue.wouldNotResume = async () => { checks += 1; gated = true; enterGate(); await gate; return [] }
    await heldHandoff(t, queue, {}, async () => {
      await updater.installNow()
      await waitFor(() => gated, { label: 'the drain tick asking the queue' })
      await updater.installNow(true)
      assert.equal(updater.readState().phase, 'installing', 'the immediate press commits at once')
      const script = path.join(updater.updateDir(), 'swap-app.sh')
      markedOnce(script)
      releaseGate()
      // One macrotask hop: the resumed tick's continuation is a microtask, so it has run by then.
      await sleep(0)
      // The resumed tick sees `installing`: it neither installs again nor writes `draining` back.
      assert.equal(updater.readState().phase, 'installing', 'the resumed tick did not write draining over installing')
      assert.equal(stillMarked(script), true, 'the resumed tick did not start a second helper')
      assert.equal(checks, 1, 'the suspended drain looked at the queue once, before the immediate press committed')
      await waitFor(() => handoffs() >= 1, { label: 'the helper to start' })
      assert.equal(handoffs(), 1, 'the helper itself saw one hand-off')
    })
  })

  test('a quit that never happens frees the claim, so a later install hands off again', async t => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    // `quit` never quits: the hand-off is called off by its own deadline (shortened for the test).
    await heldHandoff(t, queue, { quit: () => {} }, async () => {
      updater._setQuitDeadlineForTesting(50)
      await updater.installNow(true)
      assert.equal(updater.readState().phase, 'installing')
      await waitFor(() => updater.readState().phase === 'failed', { label: 'the did-not-quit failure' })
      // The second hand-off must not be called off while this test watches it.
      updater._setQuitDeadlineForTesting(60 * 60_000)
      const script = path.join(updater.updateDir(), 'swap-app.sh')
      markedOnce(script)
      updater.writeState({ ...updater.readState(), phase: 'ready', immediate: true, install_requested: true, error: null })
      await updater.maybeInstall()
      assert.equal(updater.readState().phase, 'installing', 'the claim was freed with the failure')
      assert.equal(stillMarked(script), false, 'the later install handed off again and rewrote swap-app.sh')
      await waitFor(() => handoffs() >= 2, { label: 'a second helper' })
    })
  })

  test('a caller that paused the queue and then lost the race records the pause it took', async t => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    // The automatic caller pauses intake, then hangs inside `setPaused` (after the queue is paused).
    const acquire = queue.acquirePause
    let pauses = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    queue.acquirePause = async (token: string) => { const owned = await acquire(token); pauses += 1; await held; return owned }
    await heldHandoff(t, queue, {}, async () => {
      const automatic = updater.maybeInstall()
      await waitFor(() => pauses === 1, { label: 'the automatic caller pausing intake' })
      // The owner's press finds the queue already paused, so it never pauses it itself.
      await updater.installNow(true)
      assert.equal(updater.readState().phase, 'installing', 'the press committed')
      assert.deepEqual(queue.calls, [true], 'the press did not pause a queue that was already paused')
      release()
      await automatic
      assert.equal(updater.readState().pause_owner_token, queue.owner, 'the winning handoff retains the shared ownership token')
      assert.equal(updater.readState().we_paused, false, 'a late caller cannot restore the unsafe legacy release flag')
    })
    // The helper is gone and its own verdict is on disk: the swap happened and the app came up.
    assert.equal(helperOutcome(), 'installed', 'the helper swapped and the relaunch came up healthy')
  })

  test('an immediate press on a queue the owner paused himself never claims the pause', async t => {
    ready()
    const queue = promptQueue(1)
    queue.paused = true
    await heldHandoff(t, queue, {}, async () => {
      await updater.installNow(true)
      assert.equal(updater.readState().phase, 'installing')
      assert.equal(updater.readState().we_paused, false, 'his pause is not the updater\'s to lift')
      assert.deepEqual(queue.calls, [], 'his pause was left alone')
    })
    // The helper is gone and its own verdict is on disk: the swap happened and the app came up.
    assert.equal(helperOutcome(), 'installed', 'the helper swapped and the relaunch came up healthy')
  })

  test('quit failure preserves the owner Resume then Pause that superseded the updater', async t => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    t.mock.timers.enable({ apis: ['setTimeout'] })
    updater._setQuitDeadlineForTesting(6 * 60_000)
    await heldHandoff(t, queue, {}, async () => {
      await updater.installNow(true)
      assert.equal(updater.readState().phase, 'installing')
      await queue.setPaused(false)
      await queue.setPaused(true)
      t.mock.timers.tick(6 * 60_000)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(updater.readState().phase, 'failed')
      assert.equal(queue.paused, true, 'quit failure cannot release the owner\'s later pause')
      assert.deepEqual(queue.calls, [true, false, true], 'no updater Resume follows the owner Pause')
    })
  })

  test('owner Resume then Pause during acquisition prevents an immediate handoff', async () => {
    ready()
    const queue = promptQueue(1)
    const acquire = queue.acquirePause
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    queue.acquirePause = async token => { const owned = await acquire(token); entered(); await gate; return owned }
    wired(queue, keepAppAlive)
    const press = updater.installNow(true)
    await started
    await queue.setPaused(false)
    await queue.setPaused(true)
    release()
    await press
    assert.equal(updater.readState().phase, 'ready')
    assert.equal(updater.readState().held, true)
    assert.equal(queue.paused, true)
    assert.equal(handoffs(), 0)
  })

  test('owner Pause while a drain check is suspended prevents automatic handoff', async () => {
    ready()
    const queue = promptQueue(1)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    queue.wouldNotResume = async () => { entered(); await gate; return [] }
    wired(queue, keepAppAlive)
    await updater.maybeInstall()
    await started
    await queue.setPaused(true)
    release()
    await waitFor(() => updater.readState().phase === 'ready', { label: 'owner pause superseding drain' })
    assert.equal(updater.readState().held, true)
    assert.equal(queue.paused, true)
    assert.equal(handoffs(), 0)
  })

  test('the owner\'s own pause wins: a queue he paused holds the update, untouched', async () => {
    ready()
    const queue = promptQueue(1)
    queue.paused = true
    wired(queue)
    await updater.maybeInstall()
    clock.t += 24 * 60 * 60_000
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready')
    assert.deepEqual(queue.calls, [])
    assert.equal((await updater.status()).queue_paused, true)
  })

  test('a pause the updater made before a restart is its own, not the owner\'s: the install continues', async () => {
    ready()
    updater.writeState({ ...updater.readState(), we_paused: true, pause_owner_token: 'restart-owned' })
    const queue = promptQueue(1)
    queue.paused = true
    queue.owner = 'restart-owned'
    wired(queue)
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'draining')
    await installed()
  })

  test('the startup race: nothing is judged before the boot scan has loaded saved jobs', async () => {
    ready()
    let loaded = false
    const queue = Object.assign(promptQueue(), { loaded: () => loaded })
    wired(queue)
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready', 'saved jobs may still be on disk')
    assert.deepEqual(queue.calls, [])
    loaded = true
    await updater.maybeInstall()
    await installed()
  })

  test('housekeeping never counts: it is not a queue job, and finished history is not work', async () => {
    const { JOB_TYPES } = await import('../models/types.js')
    // The YouTube status sync, digests, the recovery recheck and quota rechecks run on timers. If a
    // job type for one of them is ever added, jobsLeft() must learn to leave it out.
    assert.deepEqual(JOB_TYPES.filter(t => /sync|digest|recover|recheck|housekeep|schedul|status/.test(t)), [])
    assert.equal(updater.jobsLeft({ ...fakeQueue(), summary: () => ({ running: 0, queued: 0, paused: 0 }) }), 0)
    assert.equal(updater.jobsLeft({ ...fakeQueue(), summary: () => ({ running: 1, queued: 2, paused: 3 }) }), 6)
  })
})

describe('Gateway update request receipts', () => {
  test('receipt stays absent before an attempt, begins atomically with downloading, and survives retry state and restart', async () => {
    const release = signed()
    const requestId = 'b'.repeat(32)
    let started: any
    let allowSettings!: () => void
    const settingsGate = new Promise<void>(resolve => { allowSettings = resolve })
    const o = options(fakeQueue(), {
      getSettings: async () => { await settingsGate; return settings },
      fetch: (async () => {
        started = updater.readState()
        return new Response('not yet', { status: 404 })
      }) as any,
    })
    settings.trusted_publisher_key = PUB
    updater._configureForTesting(o)
    updater.writeState({ ...updater.readState(), phase: 'rolled_back', release, skip_signature: release.signature })
    const offer: any = { release, publisher: { public_key_base64: PUB }, update_now: true, update_request_id: requestId }
    const handling = updater.handleOffer(offer)
    const beforeAttempt = await updater.report() as any
    allowSettings()
    await handling
    assert.equal(beforeAttempt.update.request_id, null, 'an old failure is not a receipt')
    assert.equal(started.phase, 'downloading')
    assert.equal(started.gateway_update_request_id, requestId, 'receipt and attempt phase persisted together')
    assert.equal(updater.readState().phase, 'idle')
    assert.equal((await updater.report() as any).update.request_id, requestId)
    updater._resetForTesting()
    updater._configureForTesting(options(fakeQueue()))
    assert.equal((await updater.report() as any).update.request_id, requestId, 'lost response/restart keeps the real attempt receipt')
    updater.writeState({ ...updater.readState(), phase: 'rolled_back' })
    assert.equal((await updater.report() as any).update.request_id, requestId, 'terminal outcome belongs to that attempt')
  })

  test('a newer Gateway command cannot rebind an already-installing attempt receipt', async () => {
    const release = signed()
    const oldId = 'a'.repeat(32), newId = 'b'.repeat(32)
    settings.trusted_publisher_key = PUB
    updater._configureForTesting(options(fakeQueue()))
    updater.writeState({ phase: 'installing', release, gateway_update_request_id: oldId, install_requested: true })
    await updater.handleOffer({ release, update_now: true, update_request_id: newId })
    assert.equal((await updater.report() as any).update.request_id, oldId, 'installing still reports the command that started that attempt')
    updater.writeState({ ...updater.readState(), phase: 'rolled_back', skip_signature: release.signature })
    updater._configureForTesting(options(fakeQueue(), { fetch: (async () => new Response('missing', { status: 404 })) as any }))
    await updater.handleOffer({ release, update_now: true, update_request_id: newId })
    assert.equal((await updater.report() as any).update.request_id, newId, 'the next actual attempt owns the newer command')
  })

  test('invalid offers never acknowledge; a verified already-staged attempt may acknowledge a new request', async () => {
    const release = signed()
    const requestId = 'c'.repeat(32)
    settings.trusted_publisher_key = PUB
    updater._configureForTesting(options(fakeQueue(1), { getSettings: async () => ({ ...settings, auto_install: false }) }))
    const offer: any = { release: { ...release, signature: 'invalid' }, update_now: true, update_request_id: requestId }
    await assert.rejects(updater.handleOffer(offer))
    assert.equal((await updater.report() as any).update.request_id, null)
    updater.writeState({ ...updater.readState(), phase: 'ready', release, staged_app: '/fixture/already-staged' })
    await updater.handleOffer({ ...offer, release })
    assert.equal((await updater.report() as any).update.request_id, requestId)
    assert.equal(updater.readState().phase, 'draining', 'manual Update Now retains its existing install behavior')
  })
})

describe('check-in schedule (a failed or timed-out check-in must never stop the next one)', () => {
  /** setImmediate is not mocked, so this lets the fake transport and the state writes run. */
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)) }
  const pending = (): Promise<never> => new Promise<never>(() => {})
  const noRelease = () => Response.json({ release: null })

  for (const honoursSignal of [true, false]) {
    test(`a check-in the Gateway never answers is bounded${honoursSignal ? '' : ' even if the transport ignores the abort'}, and the next one is not blocked`, async (t) => {
      let requests = 0
      const fetch = (async (_url: string, init: RequestInit) => {
        requests++
        if (requests > 1) return noRelease()
        return new Promise<never>((_, reject) => {
          if (honoursSignal) init.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true })
        })
      }) as any
      updater._configureForTesting(options(fakeQueue(), { fetch }))
      t.mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const first = updater.checkNow()
        await settle()
        assert.equal(requests, 1)
        t.mock.timers.tick(updater.CHECKIN_TIMEOUT_MS)
        await first
        const state = updater.readState()
        assert.match(String(state.last_check_error), /did not answer the update check within 20 s/)
        assert.ok(state.last_attempt_at, 'the attempt is recorded even though nothing answered')
        assert.equal(state.last_check_at ?? null, null, 'no answer, so last_check_at did not move')
        await updater.checkNow()
        assert.equal(requests, 2, 'the single flight was released: a later check runs instead of joining the old promise')
        assert.equal(updater.readState().last_check_error, null)
      } finally {
        t.mock.timers.reset()
      }
    })
  }

  test('a channel count that never finishes does not time out the check-in: the report says null and goes out', async (t) => {
    let requests = 0, reported: any = null
    const fetch = (async (_url: string, init: RequestInit) => {
      requests++
      reported = JSON.parse(String(init.body))
      return noRelease()
    }) as any
    updater._configureForTesting(options(fakeQueue(), { fetch, channels: pending }))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const check = updater.checkNow()
      await settle()
      assert.equal(requests, 0, 'still waiting on the channel count')
      t.mock.timers.tick(updater.CHANNELS_TIMEOUT_MS)
      await check
      assert.equal(requests, 1)
      assert.equal(reported.channels, null)
      assert.equal(updater.readState().last_check_error, null, 'the check-in itself did not time out')
    } finally {
      t.mock.timers.reset()
    }
  })

  test('the schedule keeps firing: a timed-out check-in is retried after 5 minutes, then every 30', async (t) => {
    let clock = 1_000_000_000_000
    let requests = 0
    const fetch = (async () => {
      requests++
      if (requests === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      return noRelease()
    }) as any
    updater._configureForTesting(options(fakeQueue(), { fetch, now: () => clock }))
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    try {
      updater._armCheckScheduleForTesting()
      t.mock.timers.tick(15_000)
      await settle()
      assert.equal(requests, 1, 'the startup check-in ran and failed')
      assert.match(String(updater.readState().last_check_error), /timeout/)
      assert.equal(updater.readState().last_check_at ?? null, null)

      clock += updater.CHECK_POLL_MS
      t.mock.timers.tick(updater.CHECK_POLL_MS)
      await settle()
      assert.equal(requests, 1, 'not due yet: the retry waits 5 minutes, not a poll')

      clock += updater.CHECK_RETRY_MS
      t.mock.timers.tick(updater.CHECK_POLL_MS)
      await settle()
      assert.equal(requests, 2, 'the failed check-in was retried after CHECK_RETRY_MS')
      assert.equal(updater.readState().last_check_error, null)
      assert.equal(updater.readState().last_check_at, clock)

      clock += updater.CHECK_INTERVAL_MS - updater.CHECK_POLL_MS
      t.mock.timers.tick(updater.CHECK_POLL_MS)
      await settle()
      assert.equal(requests, 2, 'an answered check-in waits the full 30 minutes')

      clock += updater.CHECK_POLL_MS
      t.mock.timers.tick(updater.CHECK_POLL_MS)
      await settle()
      assert.equal(requests, 3, 'and then runs again')
    } finally {
      t.mock.timers.reset()
    }
  })

  test('a check-in that hangs forever does not wedge the schedule: the deadline frees it and the next poll retries', async (t) => {
    let clock = 1_000_000_000_000
    let requests = 0
    const fetch = (async () => { requests++; return requests === 1 ? pending() : noRelease() }) as any
    updater._configureForTesting(options(fakeQueue(), { fetch, now: () => clock }))
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    try {
      updater._armCheckScheduleForTesting()
      t.mock.timers.tick(15_000)
      await settle()
      assert.equal(requests, 1)
      t.mock.timers.tick(updater.CHECKIN_TIMEOUT_MS)
      await settle()
      assert.match(String(updater.readState().last_check_error), /did not answer/)
      clock += updater.CHECK_RETRY_MS
      t.mock.timers.tick(updater.CHECK_POLL_MS)
      await settle()
      assert.equal(requests, 2)
      assert.equal(updater.readState().last_check_error, null)
    } finally {
      t.mock.timers.reset()
    }
  })

  test('a download aborted part way ("not fully available yet") leaves the schedule alive: the next scheduled check downloads again', async (t) => {
    let clock = 1_000_000_000_000
    const release = signed()
    settings.trusted_publisher_key = PUB
    let downloads = 0, cancelled = false
    const fetch = (async (url: string) => {
      if (String(url).endsWith('/checkin')) return Response.json({ release, publisher: { public_key_base64: PUB } })
      downloads++
      if (downloads > 1) return new Response('missing', { status: 404 })
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } }))
    }) as any
    updater._configureForTesting(options(fakeQueue(), { fetch, now: () => clock }))
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    try {
      updater._armCheckScheduleForTesting()
      t.mock.timers.tick(15_000)
      await settle()
      assert.equal(downloads, 1)
      t.mock.timers.tick(30_000) // 30 s without a byte: the inactivity abort
      await settle()
      assert.match(String(updater.readState().error), /not fully available yet/)
      assert.equal(cancelled, true)
      clock += updater.CHECK_INTERVAL_MS
      t.mock.timers.tick(updater.CHECK_POLL_MS)
      await settle()
      assert.equal(downloads, 2, 'the scheduled check ran again instead of joining a stuck promise')
    } finally {
      t.mock.timers.reset()
    }
  })
})

describe('boot settle', () => {
  test('the new version healthy: installed, and the queue pause the updater made is released', async () => {
    updater.writeState({ phase: 'installing', release: signed(), we_paused: false, pause_owner_token: 'healthy-owned', installing_at: Date.now() })
    const queue = fakeQueue(0, true)
    queue.owner = 'healthy-owned'
    const fetch = (async () => new Response(JSON.stringify({ status: 'ok', version: '1.4.258', boot_complete: true }))) as any
    const state = await updater.onBoot(options(queue, { currentVersion: '1.4.258', fetch }))
    assert.equal(state.phase, 'installed')
    assert.deepEqual(queue.calls, [false])
    assert.equal(updater.readState().we_paused, false)
  })

  test('a failed updater release retains its claim and reports recovery, then retries on boot', async () => {
    updater.writeState({ phase: 'installing', release: signed(), pause_owner_token: 'retry-release', installing_at: Date.now() })
    const queue = fakeQueue(0, true)
    queue.owner = 'retry-release'
    const release = queue.releasePause
    queue.releasePause = async () => { throw new Error('fixture release write failed') }
    const fetch = (async () => Response.json({ status: 'ok', version: '1.4.258', boot_complete: true })) as any
    const bootOptions = options(queue, { currentVersion: '1.4.258', fetch })
    await updater.onBoot(bootOptions)
    assert.equal(updater.readState().pause_owner_token, 'retry-release')
    assert.equal(queue.paused, true)
    assert.match(String((await updater.status()).pause_recovery_note), /Resume/i)
    queue.releasePause = release
    await updater.onBoot(bootOptions)
    assert.equal(queue.paused, false)
    assert.equal(updater.readState().pause_owner_token, null)
    assert.equal((await updater.status()).pause_recovery_note, null)
  })

  test('a legacy boolean hold stays paused with visible recovery guidance until Resume', async () => {
    updater.writeState({ phase: 'installing', release: signed(), we_paused: true, installing_at: Date.now() })
    const queue = fakeQueue(0, true)
    const fetch = (async () => Response.json({ status: 'ok', version: '1.4.258', boot_complete: true })) as any
    await updater.onBoot(options(queue, { currentVersion: '1.4.258', fetch }))
    assert.equal(queue.paused, true, 'the old boolean cannot prove who owns this pause')
    assert.deepEqual(queue.calls, [])
    assert.match(String((await updater.status()).pause_recovery_note), /Resume/i)
    await queue.setPaused(false)
    assert.equal((await updater.status()).pause_recovery_note ?? null, null, 'guidance clears after Resume')
  })

  test('download leftovers move into Story\'s Trash (Library _story-studio/app-update); what is already in _trash stays', async () => {
    const staging = path.join(updater.updateDir(), 'staging', '1.4.258')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'Story Studio KH 1.4.258.zip'), 'x')
    const old = path.join(updater.trashDir(), 'app-update', 'staging-1.4.257-1')
    fs.mkdirSync(old, { recursive: true })
    updater.writeState({ phase: 'installing', release: signed(), installing_at: Date.now() })
    const fetch = (async () => new Response(JSON.stringify({ status: 'ok', version: '1.4.258', boot_complete: true }))) as any
    await updater.onBoot(options(fakeQueue(), { currentVersion: '1.4.258', fetch }))
    assert.equal(fs.existsSync(staging), false)
    assert.equal(fs.readFileSync(path.join(await libraryAppTrash(), 'app-update', '1.4.258', 'Story Studio KH 1.4.258.zip'), 'utf8'), 'x')
    assert.equal(fs.existsSync(updater.trashFolder()), false, 'the retired Trash Folder is not used')
    assert.deepEqual(fs.readdirSync(path.join(updater.trashDir(), 'app-update')), ['staging-1.4.257-1'], '_trash is left alone')
  })

  test('the old version came back: rolled back, the version is skipped, the queue resumed', async () => {
    updater.writeState({ phase: 'installing', release: signed(), we_paused: false, pause_owner_token: 'rollback-owned', installing_at: Date.now() - 5000 })
    fs.writeFileSync(path.join(updater.updateDir(), 'helper-result.json'),
      JSON.stringify({ outcome: 'rolled_back', detail: '1.4.258 did not start', at: Math.floor(Date.now() / 1000) }))
    const queue = fakeQueue(0, true)
    queue.owner = 'rollback-owned'
    const state = await updater.onBoot(options(queue))
    assert.equal(state.phase, 'rolled_back')
    assert.equal(state.skip_signature, signed().signature)
    assert.equal(state.error, '1.4.258 did not start')
    assert.deepEqual(queue.calls, [false])
  })

  // A hand install (the owner installing the DMG himself) never moves the phase
  // through `installing`, so the old boot settle left `install_requested` and the
  // last download error standing for good. `install_requested` makes EVERY later
  // offer count as "asked" and so bypasses the skip_signature/failed_signature
  // guards permanently; the stale error was shown as if it described the build
  // that is actually running.
  test('a hand install clears a stale request and its error, whatever the phase', async () => {
    const release = signed()
    updater.writeState({
      phase: 'ready', release, install_requested: true, immediate: true,
      error: `${release.version} is not fully available yet (the Gateway answered 404 to the download); trying again at the next check.`,
    })
    const state = await updater.onBoot(options(fakeQueue(), { currentVersion: '1.4.258' }))
    assert.equal(state.install_requested, false, 'the install already happened, by hand')
    assert.equal(state.immediate, false)
    assert.equal(state.error, null, 'the old download error described a build that is no longer running')
  })

  test('a version NEWER than the recorded release clears them too', async () => {
    updater.writeState({ phase: 'ready', release: signed(), install_requested: true, error: 'download failed' })
    const state = await updater.onBoot(options(fakeQueue(), { currentVersion: '1.4.259' }))
    assert.equal(state.install_requested, false)
    assert.equal(state.error, null)
  })

  test('an install that has not happened yet keeps its request and its error', async () => {
    updater.writeState({ phase: 'ready', release: signed(), install_requested: true, error: 'download failed' })
    const state = await updater.onBoot(options(fakeQueue(), { currentVersion: '1.4.257' }))
    assert.equal(state.install_requested, true, 'nothing has installed this release yet')
    assert.equal(state.error, 'download failed')
  })

  test('a cleared request no longer defeats the skipped-signature guard', async () => {
    // The sequence that produced the stale flag: 1.4.258 installed by hand, this
    // Mac having skipped 1.4.259's signature earlier. Before the boot settle
    // cleared the flag, `asked` stayed true and 1.4.259 was downloaded again.
    const handInstalled = signed()
    const skipped = signed({ version: '1.4.259', build: '1.4.259', filename: 'Story Studio KH 1.4.259.zip' })
    updater.writeState({
      phase: 'ready', release: handInstalled, install_requested: true,
      skip_signature: skipped.signature,
    })
    await updater.onBoot(options(fakeQueue(), { currentVersion: '1.4.258' }))

    let downloads = 0
    const fetch = (async () => { downloads++; return new Response('missing', { status: 404 }) }) as any
    settings.trusted_publisher_key = PUB
    updater._configureForTesting(options(fakeQueue(), { currentVersion: '1.4.258', fetch }))
    await updater.handleOffer({ release: skipped, publisher: { public_key_base64: PUB } })
    assert.equal(downloads, 0, 'a signature this Mac already skipped is not tried again because a request was left behind')
  })

  test('a download that fails releases the error body instead of stranding its socket', async () => {
    const release = signed()
    settings.trusted_publisher_key = PUB
    let released = false
    const fetch = (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"detail":"the artifact is still uploading"}')) },
      cancel() { released = true },
    }), { status: 404 })) as any
    updater._configureForTesting(options(fakeQueue(), { fetch }))
    await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
    assert.equal(released, true, 'the 404 body was never released')
    assert.match(String(updater.readState().error), /not fully available yet/)
  })

  test('a rolled-back release is never retried automatically, but its re-publish is', async () => {
    const release = signed()
    updater.writeState({ phase: 'rolled_back', release, skip_signature: release.signature })
    let downloads = 0
    const fetch = (async () => { downloads++; return new Response('missing', { status: 404 }) }) as any
    updater._configureForTesting(options(fakeQueue(), { fetch }))
    settings.trusted_publisher_key = PUB
    await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
    updater.writeState({ ...updater.readState(), failed_at: 0 })
    await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
    assert.equal(downloads, 0, 'the same signature stays skipped, however long ago')
    await updater.handleOffer({ release: signed({ published_at: 2 }), publisher: { public_key_base64: PUB } })
    assert.equal(downloads, 1, 'a re-publish carries a new signature and is tried')
  })
})

describe('swap helper (temp dir)', () => {
  function runHelper(env: Record<string, string>): Promise<void> {
    const script = path.join(tmp.dir, 'swap-app.sh')
    fs.writeFileSync(script, updater.helperScript(), { mode: 0o755 })
    return new Promise((resolve) => {
      const child = spawn('/bin/bash', [script], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: tmp.dir, ...env } })
      child.on('exit', () => resolve())
    })
  }

  function layout() {
    const target = makeApp(path.join(tmp.dir, 'Applications'), '1.4.257')
    const staged = makeApp(fs.mkdtempSync(path.join(tmp.dir, 'staged-')), '1.4.258')
    const state = path.join(tmp.dir, 'state.json')
    fs.writeFileSync(state, JSON.stringify({ phase: 'installing', release: { version: '1.4.258' } }))
    const quitter = spawn('/bin/sleep', ['1'])
    return {
      target, staged, state,
      env: {
        SU_PID: String(quitter.pid), SU_TARGET: target, SU_STAGED: staged, SU_KEEP: updater.previousAppsDir(),
        SU_STATE: state, SU_RESULT: path.join(tmp.dir, 'result.json'), SU_LOG: path.join(tmp.dir, 'helper.log'),
        SU_VERSION: '1.4.258', SU_OLD_VERSION: '1.4.257', SU_LABEL: 'test.never.loaded', SU_HEALTH_SECONDS: '3',
      },
    }
  }

  test('waits for the app to quit, keeps the old app in previous-apps, swaps, relaunches, sees it healthy', async () => {
    const l = layout()
    // The "relaunched app" reports healthy the way the real one does: by writing its state file.
    const relaunch = `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(l.state)}`
    await runHelper({ ...l.env, SU_RELAUNCH: relaunch })
    assert.equal(plistVersion(l.target), '1.4.258')
    assert.equal(plistVersion(path.join(updater.previousAppsDir(), 'Story Studio KH.app-1.4.257')), '1.4.257')
    assert.equal(fs.existsSync(updater.trashDir()), false, 'the owner\'s _trash is not used')
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'installed')
    assert.equal(fs.existsSync(l.staged), false)
  })

  test('a new version that never reports healthy is put aside and the old one is back', async () => {
    const l = layout()
    await runHelper({ ...l.env, SU_RELAUNCH: `echo relaunch "$1" >> ${JSON.stringify(path.join(tmp.dir, 'relaunches'))}` })
    assert.equal(plistVersion(l.target), '1.4.257')
    const kept = fs.readdirSync(updater.previousAppsDir())
    assert.ok(kept.some(n => n.startsWith('Story Studio KH.app-1.4.258-failed-')), kept.join(','))
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'rolled_back')
    // The relaunch command runs in the background; give the second one a moment to land.
    const relaunches = () => fs.readFileSync(path.join(tmp.dir, 'relaunches'), 'utf8').trim().split('\n').length
    await waitFor(() => relaunches() >= 2, { label: 'the second relaunch' })
    assert.equal(relaunches(), 2)
  })

  test('previous-apps on another volume is never copied into, and nothing is deleted: the old app stays beside the target', async () => {
    // A small disk image stands in for a data folder on another drive than /Applications.
    const image = path.join(tmp.dir, 'other.dmg')
    const mount = path.join(tmp.dir, 'other-volume')
    fs.mkdirSync(mount)
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '4m', '-fs', 'HFS+', '-volname', 'other', image])
    const attachArgs = ['attach', '-quiet', '-nobrowse', '-noautoopen', '-mountpoint', mount, image]
    await diagnosticPhase('native-cross-volume-attach', () => execFileSync('/usr/bin/hdiutil', attachArgs), { file: '/usr/bin/hdiutil', args: attachArgs })
    try {
      const keep = path.join(mount, 'previous-apps')
      const apps = path.join(tmp.dir, 'Applications')
      // Healthy: the previous app waited beside the target and STAYS there; nothing crossed over.
      let l = layout()
      const healthy = `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(l.state)}`
      await runHelper({ ...l.env, SU_KEEP: keep, SU_RELAUNCH: healthy })
      assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'installed')
      assert.equal(plistVersion(l.target), '1.4.258')
      assert.deepEqual(fs.readdirSync(apps).sort(), ['.Story Studio KH.app-1.4.257-previous', 'Story Studio KH.app'])
      assert.equal(plistVersion(path.join(apps, '.Story Studio KH.app-1.4.257-previous')), '1.4.257')
      assert.deepEqual(fs.readdirSync(keep), [])
      // Never healthy: rollback finds the previous app beside the target; the failed one stays beside it too.
      fs.renameSync(l.target, path.join(tmp.dir, 'spent.app'))
      l = layout()
      await runHelper({ ...l.env, SU_KEEP: keep, SU_RELAUNCH: 'true' })
      assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'rolled_back')
      assert.equal(plistVersion(l.target), '1.4.257')
      const names = fs.readdirSync(apps).sort()
      assert.equal(names.length, 3, names.join(','))
      assert.equal(names[0], '.Story Studio KH.app-1.4.257-previous', 'the first run\'s copy is still there')
      assert.match(names[1]!, /^\.Story Studio KH\.app-1\.4\.258-failed-/)
      assert.deepEqual(fs.readdirSync(keep), [])
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', '-quiet', '-force', mount])
    }
  })

  test('install() hands the helper previous-apps, and the old app lands there', async () => {
    const target = makeApp(path.join(tmp.dir, 'Applications'), '1.4.257')
    const staged = makeApp(fs.mkdtempSync(path.join(tmp.dir, 'staged-')), '1.4.258')
    updater.writeState({ phase: 'ready', release: signed(), staged_app: staged })
    const quitter = spawn('/bin/sleep', ['1'])
    const state = path.join(updater.updateDir(), 'state.json')
    updater._configureForTesting(options(fakeQueue(), {
      relaunchCommand: `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(state)}`,
      helperEnv: { SU_PID: String(quitter.pid), SU_HEALTH_SECONDS: '5' },
    }))
    await updater.install()
    const result = path.join(updater.updateDir(), 'helper-result.json')
    await waitFor(() => fs.existsSync(result), { label: 'the helper result' })
    assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).outcome, 'installed')
    assert.equal(plistVersion(target), '1.4.258')
    assert.equal(updater.previousAppsDir(), path.join(updater.dataDir(), 'previous-apps'))
    assert.equal(plistVersion(path.join(updater.previousAppsDir(), 'Story Studio KH.app-1.4.257')), '1.4.257')
    assert.equal(fs.existsSync(path.join(updater.trashDir(), 'app')), false)
  })

  test('an app that does not quit is never replaced', async () => {
    const l = layout()
    const stubborn = spawn('/bin/sleep', ['30'])
    try {
      await runHelper({ ...l.env, SU_PID: String(stubborn.pid), SU_QUIT_WAIT: '1' })
    } finally { stubborn.kill() }
    assert.equal(plistVersion(l.target), '1.4.257')
    assert.equal(fs.existsSync(l.staged), true)
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'failed')
  })
})

describe('previous app versions (owner 2026-10-16: keep the last 2, move older ones to Story\'s Trash)', () => {
  const put = (...p: string[]) => { fs.mkdirSync(path.join(...p), { recursive: true }); fs.writeFileSync(path.join(...p, 'f'), p.at(-1)!) }

  test('exactly 2 previous versions stay; the 3rd (and a failed one) move into the Library _trash, recorded for Restore', async () => {
    const keep = updater.previousAppsDir()
    for (const name of ['Story Studio KH.app-1.4.300', 'Story Studio KH.app-1.4.305', 'Story Studio KH.app-1.4.299', 'Story Studio KH.app-1.4.306-failed-20261016120000']) put(keep, name)
    const moved = await updater.keepPreviousApps(path.join(tmp.dir, 'Applications', 'Story Studio KH.app'))
    assert.equal(moved.length, 2)
    assert.deepEqual(fs.readdirSync(keep).sort(), ['Story Studio KH.app-1.4.300', 'Story Studio KH.app-1.4.305'])
    const appTrash = path.join(await libraryAppTrash(), 'app')
    assert.deepEqual(fs.readdirSync(appTrash).sort(), ['Story Studio KH.app-1.4.299', 'Story Studio KH.app-1.4.306-failed-20261016120000'])
    assert.equal(fs.readFileSync(path.join(appTrash, 'Story Studio KH.app-1.4.299', 'f'), 'utf8'), 'Story Studio KH.app-1.4.299')
    const index = fs.readFileSync(path.join(path.dirname(path.dirname(appTrash)), '.trash-index.jsonl'), 'utf8')
    assert.match(index, /Story Studio KH\.app-1\.4\.299/)
    // A copy left beside the app (previous-apps on another volume) counts as one of the versions.
    put(tmp.dir, 'Applications', '.Story Studio KH.app-1.4.306-previous')
    await updater.keepPreviousApps(path.join(tmp.dir, 'Applications', 'Story Studio KH.app'))
    assert.deepEqual(fs.readdirSync(keep), ['Story Studio KH.app-1.4.305'])
    assert.ok(fs.readdirSync(appTrash).includes('Story Studio KH.app-1.4.300'))
    assert.equal(fs.readdirSync(path.join(tmp.dir, 'Applications')).length, 1)
  })

  test('the old Trash Folder is migrated into the Library _trash once: idempotent, collision-safe, nothing deleted; its app copy goes to previous-apps', async () => {
    const tf = updater.trashFolder()
    put(tf, '2026-10-01', 'app', 'Story Studio KH.app-1.4.280')
    put(tf, '2026-10-01', 'app-update', '1.4.279')
    put(tf, '2026-10-02', 'app-update', '1.4.281')
    const target = path.join(await libraryAppTrash(), 'trash-folder')
    put(target, '2026-10-01') // something already there by that name is never replaced
    assert.deepEqual((await updater.migrateTrashFolder()).sort(), ['2026-10-01', '2026-10-02'])
    assert.equal(fs.existsSync(tf), false, 'the emptied folder is gone; it was empty')
    const names = fs.readdirSync(target).sort()
    assert.equal(names.length, 3, names.join(','))
    assert.equal(fs.readFileSync(path.join(target, '2026-10-01', 'f'), 'utf8'), '2026-10-01', 'the earlier one is untouched')
    const migrated = names.find(n => /^2026-10-01\.\d+/.test(n))!
    assert.ok(migrated, names.join(','))
    assert.equal(fs.existsSync(path.join(target, migrated, 'app')), false, 'the app copy is not in the Trash')
    assert.equal(fs.readFileSync(path.join(target, migrated, 'app-update', '1.4.279', 'f'), 'utf8'), '1.4.279')
    assert.equal(fs.readFileSync(path.join(updater.previousAppsDir(), 'Story Studio KH.app-1.4.280', 'f'), 'utf8'), 'Story Studio KH.app-1.4.280')
    assert.equal(fs.readFileSync(path.join(target, '2026-10-02', 'app-update', '1.4.281', 'f'), 'utf8'), '1.4.281')
    const snapshot = JSON.stringify(names)
    assert.deepEqual(await updater.migrateTrashFolder(), [])
    assert.equal(JSON.stringify(fs.readdirSync(target).sort()), snapshot, 'a second run moves nothing')
  })

  test('the old helper\'s rollback copies become previous versions, not deletable Trash: the last 2 stay in previous-apps', async () => {
    const tf = updater.trashFolder()
    put(tf, '2026-10-01', 'app', 'Story Studio KH.app-1.4.300')
    put(tf, '2026-10-03', 'app', 'Story Studio KH.app-1.4.305')
    put(tf, '2026-10-03', 'app-update', '1.4.306')
    put(tf, '2026-10-05', 'app', 'Story Studio KH.app-1.4.306')
    put(updater.previousAppsDir(), 'Story Studio KH.app-1.4.306') // the same name already there: never replaced
    assert.deepEqual(await updater.migrateTrashFolder(), ['2026-10-03'], 'only what is not an app copy goes to the Trash')
    assert.equal(fs.existsSync(tf), false)
    const parked = fs.readdirSync(updater.previousAppsDir()).sort()
    assert.equal(parked.length, 4, parked.join(','))
    assert.ok(parked.some(n => /^Story Studio KH\.app-1\.4\.306-\d+$/.test(n)), parked.join(','))
    const trashFolderCopy = path.join(await libraryAppTrash(), 'trash-folder')
    assert.deepEqual(fs.readdirSync(trashFolderCopy), ['2026-10-03'])
    assert.deepEqual(fs.readdirSync(path.join(trashFolderCopy, '2026-10-03')), ['app-update'])
    await updater.keepPreviousApps(path.join(tmp.dir, 'Applications', 'Story Studio KH.app'))
    assert.equal(fs.readdirSync(updater.previousAppsDir()).length, 2, 'the last 2 stay')
    assert.ok(fs.readdirSync(path.join(await libraryAppTrash(), 'app')).includes('Story Studio KH.app-1.4.300'))
  })

  test('the running app is never moved, even an old copy launched from previous-apps', async () => {
    const keep = updater.previousAppsDir()
    for (const v of ['1.4.290', '1.4.300', '1.4.305']) put(keep, `Story Studio KH.app-${v}`)
    const running = path.join(keep, 'Story Studio KH.app-1.4.290')
    assert.deepEqual(await updater.keepPreviousApps(running), [], 'appBundle is the old copy')
    const execPath = process.execPath
    try {
      process.execPath = path.join(running, 'Contents', 'MacOS', 'Story Studio KH')
      assert.deepEqual(await updater.keepPreviousApps(path.join(tmp.dir, 'Applications', 'Story Studio KH.app')), [], 'the process runs from it')
    } finally { process.execPath = execPath }
    assert.equal(fs.readdirSync(keep).length, 3)
    assert.deepEqual(await updater.keepPreviousApps(path.join(tmp.dir, 'Applications', 'Story Studio KH.app')), [running], 'once it no longer runs, it moves')
  })

  test('app-update.ts deletes nothing: no rm, rmSync, unlink or shell rm anywhere in it (the helper script included)', () => {
    // rmdir/rmdirSync stay allowed: they only remove an EMPTY folder (the mount point, the emptied Trash Folder).
    const source = fs.readFileSync(new URL('../services/app-update.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bfsp?\.(rm|rmSync|unlink|unlinkSync)\(|\brm -|\bTRASH_FOLDER_DAYS\b|purgeTrashFolder/)
  })
})

describe('extraction', () => {
  test('a .dmg is read through a read-only mount; quarantine is stripped; the version is checked', async () => {
    const src = fs.mkdtempSync(path.join(tmp.dir, 'dmgsrc-'))
    makeApp(src, '1.4.258')
    const dmg = path.join(tmp.dir, 'r.dmg')
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', src, '-format', 'UDZO', dmg])
    const app = await diagnosticPhase('native-readonly-extract', () => updater.extractApp(dmg, path.join(tmp.dir, 'out')), { file: '/usr/bin/hdiutil' })
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Test;', app])
    await updater.checkBundle(app, '1.4.258')
    assert.throws(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app], { stdio: 'pipe' }))
    await assert.rejects(updater.checkBundle(app, '1.4.259'), /reports 1\.4\.258, not the signed 1\.4\.259/)
    fs.appendFileSync(path.join(app, 'Contents', 'Info.plist'), '\n')
    await assert.rejects(updater.checkBundle(app, '1.4.258'), /code signature does not verify/)
  })
})

describe('extraction cleanup (a failed or killed attach leaves nothing behind)', () => {
  /** Stands in for hdiutil/ditto: `attach` fails the way a SIGKILLed one does, after optionally writing into the mountpoint. */
  function stubTools(opts: { leave?: string; failPlainDetach?: boolean; failForceDetach?: boolean }) {
    const calls: string[][] = []
    const seen = { mount: '' }
    updater._setToolRunnerForTesting(async (file, args) => {
      calls.push([path.basename(file), ...args])
      if (args[0] === 'attach') {
        seen.mount = args[args.indexOf('-mountpoint') + 1]
        if (opts.leave) fs.writeFileSync(path.join(seen.mount, opts.leave), 'x')
        throw Object.assign(new Error('Command failed: hdiutil attach (killed)'), { killed: true })
      }
      if (args[0] === 'detach' && !args.includes('-force') && opts.failPlainDetach) throw new Error('busy')
      if (args[0] === 'detach' && args.includes('-force') && opts.failForceDetach) throw new Error('not mounted')
      return { stdout: '', stderr: '' }
    })
    return { calls, seen }
  }
  const dmg = () => { const f = path.join(tmp.dir, 'r.dmg'); fs.writeFileSync(f, 'x'); return f }

  test('a killed attach still detaches (plain, then -force) and removes the empty mountpoint', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const { calls, seen } = stubTools({ failPlainDetach: true })
    await assert.rejects(updater.extractApp(dmg(), path.join(tmp.dir, 'out')), /attach/)
    assert.deepEqual(calls.filter(c => c[1] === 'detach').map(c => c.includes('-force')), [false, true])
    assert.equal(fs.existsSync(seen.mount), false, 'the mkdtemp mountpoint was removed')
    assert.equal(warn.mock.callCount(), 0)
  })

  test('a detach that fails twice is logged, and the (unmounted) empty directory is still removed', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const { seen } = stubTools({ failPlainDetach: true, failForceDetach: true })
    await assert.rejects(updater.extractApp(dmg(), path.join(tmp.dir, 'out')), /attach/)
    assert.ok(warn.mock.calls.some(c => /could not detach/.test(String(c.arguments[0]))), 'the swallowed failure is logged')
    assert.equal(fs.existsSync(seen.mount), false)
  })

  test('a non-empty mountpoint goes to Story\'s Trash, never deleted', async () => {
    const { seen } = stubTools({ leave: 'leftover.txt' })
    await assert.rejects(updater.extractApp(dmg(), path.join(tmp.dir, 'out')), /attach/)
    assert.equal(fs.existsSync(seen.mount), false)
    const found: string[] = []
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name)); else found.push(e.name) } }
    walk(await libraryAppTrash())
    assert.ok(found.includes('leftover.txt'), 'the leftover contents were moved, not removed')
  })
})

describe('unsealed builds (electron-builder identity: null, as Story ships today)', () => {
  test('a bundle with only a linker-signed executable is accepted; an unsigned one is refused', async () => {
    const app = path.join(tmp.dir, 'Story Studio KH.app')
    const exe = path.join(app, 'Contents', 'MacOS', 'Story Studio KH')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Story Studio KH</string>
<key>CFBundleShortVersionString</key><string>1.4.258</string></dict></plist>`)
    execFileSync('/usr/bin/clang', ['-x', 'c', '-o', exe, '-'], { input: 'int main(void){return 0;}' })
    await updater.verifyCodeSignature(app)
    execFileSync('/usr/bin/codesign', ['--remove-signature', exe])
    await assert.rejects(updater.verifyCodeSignature(app), /unsigned|does not verify/)
  })
})

describe('Open at Login', () => {
  test('the agent relaunches after a crash only, and turning it off moves the file to Story\'s Trash', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
    const exe = '/Applications/Story Studio KH.app/Contents/MacOS/Story Studio KH'
    await updater.setOpenAtLogin(true, exe, home)
    const plist = updater.agentPlistPath(home)
    execFileSync('/usr/bin/plutil', ['-lint', plist])
    const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]).toString())
    assert.deepEqual(json.KeepAlive, { Crashed: true })
    assert.deepEqual(json.ProgramArguments, [exe])
    assert.equal(json.RunAtLoad, true)
    assert.equal(updater.openAtLogin(home), true)
    await updater.setOpenAtLogin(false, exe, home)
    assert.equal(updater.openAtLogin(home), false)
    const { projectsRoot } = await import('../services/project-manager.js')
    assert.equal(fs.readdirSync(path.join(projectsRoot(), '_trash', '_story-studio', 'launch-agent')).length, 1)
    await assert.rejects(updater.setOpenAtLogin(true, '/usr/local/bin/node', home), /installed app/)
  })
})
