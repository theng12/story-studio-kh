/**
 * Remote updates (services/app-update.ts): signature verify, drain and resume, the boot settle,
 * the swap helper and its rollback, extraction, and the login agent. Everything runs in temp
 * dirs: a fake installed app, a fake staged app, a fake state file. No real bundle is touched.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { sleep, waitFor } from './_timing.js'
import * as updater from '../services/app-update.js'

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

/** The real wiring's three extra answers (routes/app-update.ts): submissions in flight, jobs that
 * would not resume, and the one non-queue maintenance operation holding the Mac. */
function promptQueue(running = 0) {
  const q = Object.assign(fakeQueue(running), {
    submits: 0, notResuming: [] as string[], looks: 0,
    maintenanceOp: null as { id: string; kind: string; status: string } | null,
  })
  return Object.assign(q, {
    inFlightSubmits: () => q.submits,
    wouldNotResume: async () => { q.looks++; return q.notResuming },
    maintenance: () => q.maintenanceOp,
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

beforeEach(async () => {
  tmp = await useTempDataDir()
  settings = updater.defaultSettings(null)
  updater._resetForTesting()
})
afterEach(async () => {
  updater._resetForTesting()
  await tmp.cleanup()
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
      // A total deadline covers headers and body, even when a response never finishes.
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
  /**
   * The real helper, against a temp target, with a stand-in pid and a relaunch that reports
   * healthy. `clock.t` is what the updater reads; the wait looks every 20 ms.
   */
  const clock = { t: 0 }
  function wired(queue: any, extra: Partial<updater.UpdaterOptions> = {}) {
    const quitter = spawn('/bin/sleep', ['1'])
    const state = path.join(updater.updateDir(), 'state.json')
    clock.t = 1_000_000
    updater._configureForTesting(options(queue, {
      idlePollMs: 3_600_000, drainPollMs: 20, now: () => clock.t,
      relaunchCommand: `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(state)}`,
      helperEnv: { SU_PID: String(quitter.pid), SU_HEALTH_SECONDS: '5' },
      ...extra,
    }))
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
  /** A stand-in app that stays alive for the whole test, so only a second hand-off can move things. */
  const keepAppAlive = { helperEnv: { SU_PID: String(spawn('/bin/sleep', ['300']).pid), SU_HEALTH_SECONDS: '5', SU_QUIT_WAIT: '300' } }

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
    assert.deepEqual((await updater.status()).waiting_for, { submits: 1, jobs: [], maintenance: null })
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
    assert.deepEqual((await updater.status()).waiting_for, { submits: 0, jobs: ['music_video'], maintenance: null })
    queue.notResuming = []
    await installed()
  })

  test('the one non-queue maintenance operation is waited for too: a restart would kill it mid-file', async () => {
    ready()
    const queue = promptQueue()
    queue.maintenanceOp = { id: 'op-1', kind: 'run', status: 'running' }
    wired(queue)
    await updater.maybeInstall()
    clock.t += 10 * 60 * 60_000
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'never interrupted automatically, with no time limit')
    assert.deepEqual((await updater.status()).waiting_for, {
      submits: 0, jobs: [], maintenance: { id: 'op-1', kind: 'run', status: 'running' },
    })
    // It finishes, fails or is stopped: the registry reports nothing active and the install goes ahead.
    queue.maintenanceOp = null
    await installed()
  })

  test('the 30-minute override never interrupts a maintenance operation, not even on Install Now', async () => {
    ready()
    const queue = promptQueue()
    queue.maintenanceOp = { id: 'op-1', kind: 'run', status: 'running' }
    wired(queue)
    await updater.installNow()
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining')
    // The ceiling covers jobs the boot scan picks up again; a restart kills a cleanup mid-file, so
    // only "Install now (don't wait)" may cut it short. Time alone must never do it.
    clock.t += updater.DRAIN_TIMEOUT_MS + 60_000
    await lookedAgain(queue)
    assert.equal(updater.readState().phase, 'draining', 'the override must not reach a cleanup')
    queue.maintenanceOp = null
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

  test('two "Install now (don\'t wait)" presses make ONE hand-off: one helper, no draining write over installing', async () => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    wired(queue, keepAppAlive)
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

  test('a drain suspended in the queue check cannot start a second helper once "Install now (don\'t wait)" has committed', async () => {
    ready()
    const queue = promptQueue(1)
    let checks = 0
    let enterGate!: () => void
    const entered = new Promise<void>(resolve => { enterGate = resolve })
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    let gated = false
    queue.wouldNotResume = async () => { checks += 1; gated = true; enterGate(); await gate; return [] }
    wired(queue, keepAppAlive)
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

  test('a quit that never happens frees the claim, so a later install hands off again', async () => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    // `quit` never quits: the hand-off is called off by its own deadline (shortened for the test).
    wired(queue, { ...keepAppAlive, quit: () => {} })
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

  test('a caller that paused the queue and then lost the race records the pause it took', async () => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    // The automatic caller pauses intake, then hangs inside `setPaused` (after the queue is paused).
    const acquire = queue.acquirePause
    let pauses = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    queue.acquirePause = async (token: string) => { const owned = await acquire(token); pauses += 1; await held; return owned }
    wired(queue, keepAppAlive)
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

  test('an immediate press on a queue the owner paused himself never claims the pause', async () => {
    ready()
    const queue = promptQueue(1)
    queue.paused = true
    wired(queue, keepAppAlive)
    await updater.installNow(true)
    assert.equal(updater.readState().phase, 'installing')
    assert.equal(updater.readState().we_paused, false, 'his pause is not the updater\'s to lift')
    assert.deepEqual(queue.calls, [], 'his pause was left alone')
  })

  test('quit failure preserves the owner Resume then Pause that superseded the updater', async t => {
    ready()
    const queue = promptQueue(1)
    queue.notResuming = ['music_video']
    wired(queue, keepAppAlive)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    updater._setQuitDeadlineForTesting(6 * 60_000)
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
    execFileSync('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-noautoopen', '-mountpoint', mount, image])
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
    const app = await updater.extractApp(dmg, path.join(tmp.dir, 'out'))
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Test;', app])
    await updater.checkBundle(app, '1.4.258')
    assert.throws(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app], { stdio: 'pipe' }))
    await assert.rejects(updater.checkBundle(app, '1.4.259'), /reports 1\.4\.258, not the signed 1\.4\.259/)
    fs.appendFileSync(path.join(app, 'Contents', 'Info.plist'), '\n')
    await assert.rejects(updater.checkBundle(app, '1.4.258'), /code signature does not verify/)
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
