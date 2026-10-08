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
import { waitFor } from './_timing.js'
import * as updater from '../services/app-update.js'

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
    paused, runningCount: running, queued, pausedJobs: 0, calls: [] as boolean[],
    isPaused: () => q.paused,
    setPaused: async (p: boolean) => { q.calls.push(p); q.paused = p },
    running: () => q.runningCount,
    summary: () => ({ running: q.runningCount, queued: q.queued, paused: q.pausedJobs }),
  }
  return q
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
  test('a newer release is downloaded, checked, staged without quarantine, then waits for the queue without pausing it', async () => {
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
    assert.equal(state.phase, 'ready', 'two jobs run: an automatic install waits')
    assert.equal(plistVersion(state.staged_app!), '1.4.258')
    // A file this process wrote carries no quarantine attribute (the reason no `xattr -d` is needed).
    const downloaded = path.join(updater.updateDir(), 'staging', '1.4.258', release.filename)
    assert.throws(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', downloaded], { stdio: 'pipe' }))
    assert.deepEqual(queue.calls, [], 'an automatic install never pauses the queue')
    assert.ok(!state.we_paused)
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
    updater._configureForTesting(options(fakeQueue(), { idleSettleMs: 0 }))
    await updater.maybeInstall()
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready')
  })
})

describe('install when the queue is empty (owner, 2026-10-08)', () => {
  function ready() {
    const target = makeApp(path.join(tmp.dir, 'Applications'), '1.4.257')
    const staged = makeApp(fs.mkdtempSync(path.join(tmp.dir, 'staged-')), '1.4.258')
    updater.writeState({ phase: 'ready', release: signed(), staged_app: staged })
    return target
  }
  /**
   * The real helper, against a temp target, with a stand-in pid and a relaunch that reports
   * healthy. Time is the test's: `clock.t` is what the updater reads, each `maybeInstall()` call
   * stands for one 30-second recheck, and the timer's own recheck is pushed out of the way.
   */
  const clock = { t: 0 }
  function wired(queue: ReturnType<typeof fakeQueue>, extra: Partial<updater.UpdaterOptions> = {}) {
    const quitter = spawn('/bin/sleep', ['1'])
    const state = path.join(updater.updateDir(), 'state.json')
    clock.t = 1_000_000
    updater._configureForTesting(options(queue, {
      idlePollMs: 3_600_000, idleSettleMs: updater.IDLE_SETTLE_MS, now: () => clock.t,
      relaunchCommand: `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(state)}`,
      helperEnv: { SU_PID: String(quitter.pid), SU_HEALTH_SECONDS: '5' },
      ...extra,
    }))
  }
  const recheck = async (advanceMs: number) => { clock.t += advanceMs; await updater.maybeInstall() }

  test('waits, pausing nothing, while a job runs or is queued; installs once the queue stays empty', async () => {
    const target = ready()
    const queue = fakeQueue(1)
    wired(queue)
    await recheck(0)
    await recheck(10 * 60_000)
    assert.equal(updater.readState().phase, 'ready', 'a running job keeps it waiting, with no time limit')
    assert.equal((await updater.status()).jobs_left, 1)
    queue.runningCount = 0; queue.queued = 2
    await recheck(10 * 60_000)
    assert.equal(updater.readState().phase, 'ready', 'queued jobs keep it waiting')
    assert.deepEqual(queue.calls, [], 'nothing was paused')
    queue.queued = 0
    await recheck(30_000) // the first empty look
    assert.equal(updater.readState().phase, 'ready', 'empty for a moment is not yet idle')
    await recheck(updater.IDLE_SETTLE_MS) // still empty a minute later: install
    assert.equal(updater.readState().phase, 'installing')
    const result = path.join(updater.updateDir(), 'helper-result.json')
    await waitFor(() => fs.existsSync(result), { label: 'the helper result' })
    assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).outcome, 'installed')
    assert.equal(plistVersion(target), '1.4.258')
    assert.deepEqual(queue.calls, [], 'still nothing paused')
  })

  test('a job that arrives while the queue settles restarts the wait', async () => {
    ready()
    const queue = fakeQueue()
    wired(queue)
    await recheck(0) // empty
    queue.queued = 1 // the next pipeline step lands in the gap
    await recheck(30_000)
    queue.queued = 0
    await recheck(30_000) // empty again: the minute starts over here
    await recheck(30_000) // 90 s since the first empty look, 30 s since the last busy one
    assert.equal(updater.readState().phase, 'ready')
    await recheck(30_000)
    assert.equal(updater.readState().phase, 'installing')
    const result = path.join(updater.updateDir(), 'helper-result.json')
    await waitFor(() => fs.existsSync(result), { label: 'the helper result' })
  })

  test('the race: a job that sneaks in right before the swap stops it; nothing is spawned', async () => {
    ready()
    const queue = fakeQueue(0, false, 1)
    wired(queue)
    assert.equal(await updater.install('idle'), false)
    const state = updater.readState()
    assert.equal(state.phase, 'ready')
    assert.equal(fs.existsSync(path.join(updater.updateDir(), 'swap-app.sh')), false)
    assert.equal(updater.isQuittingForUpdate(), false)
  })

  test('a queue the owner paused with jobs still in it keeps the update waiting, and says so', async () => {
    ready()
    const queue = fakeQueue(0, true, 2)
    queue.pausedJobs = 1
    wired(queue)
    await recheck(0)
    await recheck(24 * 60 * 60_000)
    assert.equal(updater.readState().phase, 'ready')
    assert.deepEqual(queue.calls, [])
    const status = await updater.status()
    assert.equal(status.jobs_left, 3)
    assert.equal(status.queue_paused, true)
  })

  test('Install Now drains: pause the queue, wait for running jobs, install', async () => {
    ready()
    const queue = fakeQueue(1, false, 4)
    wired(queue)
    await updater.installNow()
    assert.equal(updater.readState().phase, 'draining')
    assert.deepEqual(queue.calls, [true])
    queue.runningCount = 0 // queued jobs stay queued (held) and resume after the restart
    await waitFor(() => updater.readState().phase === 'installing', { label: 'the drained install', timeoutMs: 15_000 })
    const result = path.join(updater.updateDir(), 'helper-result.json')
    await waitFor(() => fs.existsSync(result), { label: 'the helper result' })
  })

  test('the startup race: an empty queue before the boot scan has loaded saved jobs is not idle', async () => {
    ready()
    let loaded = false
    const queue = { ...fakeQueue(), loaded: () => loaded }
    wired(queue as any)
    await recheck(0)
    await recheck(10 * 60_000)
    assert.equal(updater.readState().phase, 'ready', 'saved jobs may still be on disk')
    assert.equal(await updater.install('idle'), false, 'the last look before the swap checks it too')
    loaded = true // the scan found nothing: now it is really empty
    await recheck(30_000)
    assert.equal(updater.readState().phase, 'ready', 'the settle minute starts only once loaded')
    await recheck(updater.IDLE_SETTLE_MS)
    assert.equal(updater.readState().phase, 'installing')
    const result = path.join(updater.updateDir(), 'helper-result.json')
    await waitFor(() => fs.existsSync(result), { label: 'the helper result' })
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
    updater.writeState({ phase: 'installing', release: signed(), we_paused: true, installing_at: Date.now() })
    const queue = fakeQueue(0, true)
    const fetch = (async () => new Response(JSON.stringify({ status: 'ok', version: '1.4.258', boot_complete: true }))) as any
    const state = await updater.onBoot(options(queue, { currentVersion: '1.4.258', fetch }))
    assert.equal(state.phase, 'installed')
    assert.deepEqual(queue.calls, [false])
    assert.equal(updater.readState().we_paused, false)
  })

  test('download leftovers go to the self-emptying Trash Folder; what is already in _trash stays', async () => {
    const staging = path.join(updater.updateDir(), 'staging', '1.4.258')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'Story Studio KH 1.4.258.zip'), 'x')
    const old = path.join(updater.trashDir(), 'app-update', 'staging-1.4.257-1')
    fs.mkdirSync(old, { recursive: true })
    updater.writeState({ phase: 'installing', release: signed(), installing_at: Date.now() })
    const fetch = (async () => new Response(JSON.stringify({ status: 'ok', version: '1.4.258', boot_complete: true }))) as any
    await updater.onBoot(options(fakeQueue(), { currentVersion: '1.4.258', fetch }))
    assert.equal(fs.existsSync(staging), false)
    const today = path.join(updater.trashFolder(), new Date().toISOString().slice(0, 10), 'app-update')
    assert.equal(fs.readdirSync(today).filter(name => name.startsWith('1.4.258-')).length, 1)
    assert.deepEqual(fs.readdirSync(path.join(updater.trashDir(), 'app-update')), ['staging-1.4.257-1'], '_trash is left alone')
  })

  test('the old version came back: rolled back, the version is skipped, the queue resumed', async () => {
    updater.writeState({ phase: 'installing', release: signed(), we_paused: true, installing_at: Date.now() - 5000 })
    fs.writeFileSync(path.join(updater.updateDir(), 'helper-result.json'),
      JSON.stringify({ outcome: 'rolled_back', detail: '1.4.258 did not start', at: Math.floor(Date.now() / 1000) }))
    const queue = fakeQueue(0, true)
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
        SU_PID: String(quitter.pid), SU_TARGET: target, SU_STAGED: staged, SU_TRASH: updater.appTrashDir(),
        SU_STATE: state, SU_RESULT: path.join(tmp.dir, 'result.json'), SU_LOG: path.join(tmp.dir, 'helper.log'),
        SU_VERSION: '1.4.258', SU_OLD_VERSION: '1.4.257', SU_LABEL: 'test.never.loaded', SU_HEALTH_SECONDS: '3',
      },
    }
  }

  test('waits for the app to quit, keeps the old app in the Trash Folder, swaps, relaunches, sees it healthy', async () => {
    const l = layout()
    // The "relaunched app" reports healthy the way the real one does: by writing its state file.
    const relaunch = `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(l.state)}`
    await runHelper({ ...l.env, SU_RELAUNCH: relaunch })
    assert.equal(plistVersion(l.target), '1.4.258')
    assert.equal(plistVersion(path.join(updater.appTrashDir(), 'Story Studio KH.app-1.4.257')), '1.4.257')
    assert.equal(fs.existsSync(updater.trashDir()), false, 'the owner\'s _trash is not used')
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'installed')
    assert.equal(fs.existsSync(l.staged), false)
  })

  test('a new version that never reports healthy is put aside and the old one is back', async () => {
    const l = layout()
    await runHelper({ ...l.env, SU_RELAUNCH: `echo relaunch "$1" >> ${JSON.stringify(path.join(tmp.dir, 'relaunches'))}` })
    assert.equal(plistVersion(l.target), '1.4.257')
    const trash = fs.readdirSync(updater.appTrashDir())
    assert.ok(trash.some(n => n.startsWith('Story Studio KH.app-1.4.258-failed-')), trash.join(','))
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'rolled_back')
    // The relaunch command runs in the background; give the second one a moment to land.
    const relaunches = () => fs.readFileSync(path.join(tmp.dir, 'relaunches'), 'utf8').trim().split('\n').length
    await waitFor(() => relaunches() >= 2, { label: 'the second relaunch' })
    assert.equal(relaunches(), 2)
  })

  test('a Trash Folder on another volume is never copied into: the old app waits beside the target', async () => {
    // A small disk image stands in for a data folder on another drive than /Applications.
    const image = path.join(tmp.dir, 'other.dmg')
    const mount = path.join(tmp.dir, 'other-volume')
    fs.mkdirSync(mount)
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '4m', '-fs', 'HFS+', '-volname', 'other', image])
    execFileSync('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-noautoopen', '-mountpoint', mount, image])
    try {
      const trash = path.join(mount, 'Trash Folder', '2026-10-08', 'app')
      const apps = path.join(tmp.dir, 'Applications')
      // Healthy: the previous app waited beside the target and is then removed; nothing crossed over.
      let l = layout()
      const healthy = `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(l.state)}`
      await runHelper({ ...l.env, SU_TRASH: trash, SU_RELAUNCH: healthy })
      assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'installed')
      assert.equal(plistVersion(l.target), '1.4.258')
      assert.deepEqual(fs.readdirSync(apps), ['Story Studio KH.app'])
      assert.deepEqual(fs.readdirSync(trash), [])
      // Never healthy: rollback still finds the previous app beside the target.
      fs.renameSync(l.target, path.join(tmp.dir, 'spent.app'))
      l = layout()
      await runHelper({ ...l.env, SU_TRASH: trash, SU_RELAUNCH: 'true' })
      assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'rolled_back')
      assert.equal(plistVersion(l.target), '1.4.257')
      assert.deepEqual(fs.readdirSync(apps), ['Story Studio KH.app'])
      assert.deepEqual(fs.readdirSync(trash), [])
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', '-quiet', '-force', mount])
    }
  })

  test('install() hands the helper today\'s Trash Folder, and the old app lands there', async () => {
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
    assert.match(updater.appTrashDir(), /Trash Folder\/\d{4}-\d{2}-\d{2}\/app$/)
    assert.equal(plistVersion(path.join(updater.appTrashDir(), 'Story Studio KH.app-1.4.257')), '1.4.257')
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

describe('the self-emptying Trash Folder', () => {
  test('only dated folders inside it older than 15 days are deleted; _trash and everything else stay', async () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    const put = (...p: string[]) => { fs.mkdirSync(path.join(...p), { recursive: true }); fs.writeFileSync(path.join(...p, 'f'), 'x') }
    const tf = updater.trashFolder()
    for (const day of ['2026-09-01', '2026-09-22', '2026-09-23', '2026-10-08']) put(tf, day, 'app', 'Story Studio KH.app-1')
    put(tf, 'notes')                                      // not a date: not ours to judge
    put(updater.trashDir(), 'app', 'Story Studio KH.app-1.4.250') // the owner's _trash
    put(updater.trashDir(), '2026-01-01')                 // a dated name in _trash is still his
    const outside = path.join(tmp.dir, 'outside'); put(outside)
    fs.symlinkSync(outside, path.join(tf, '2026-01-02')) // a dated symlink is never followed
    fs.writeFileSync(path.join(tf, '2026-01-03'), 'a file, not a folder')

    assert.deepEqual(await updater.purgeTrashFolder(now), ['2026-09-01', '2026-09-22'])
    assert.deepEqual(fs.readdirSync(tf).sort(), ['2026-01-02', '2026-01-03', '2026-09-23', '2026-10-08', 'notes'])
    assert.ok(fs.existsSync(path.join(updater.trashDir(), 'app', 'Story Studio KH.app-1.4.250', 'f')))
    assert.ok(fs.existsSync(path.join(updater.trashDir(), '2026-01-01', 'f')))
    assert.ok(fs.existsSync(path.join(outside, 'f')))
    assert.equal(updater.appTrashDir(now), path.join(tf, '2026-10-08', 'app'))
    assert.equal(path.dirname(tf), updater.dataDir())
  })

  test('no Trash Folder yet is nothing to do', async () => {
    assert.deepEqual(await updater.purgeTrashFolder(), [])
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
  test('the agent relaunches after a crash only, and turning it off moves the file to _trash', async () => {
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
    assert.equal(fs.readdirSync(path.join(updater.trashDir(), 'launch-agent')).length, 1)
    await assert.rejects(updater.setOpenAtLogin(true, '/usr/local/bin/node', home), /installed app/)
  })
})
