/**
 * The app updater against a REAL local release server (a `node:http` server on 127.0.0.1).
 *
 * WHY THIS EXISTS. The owner's link is a Tailscale relay at ~115 KB/s, so a ~240 MB DMG cannot
 * finish inside one 30-minute check. `stage()` trashed the staging dir on every attempt while
 * `download()` sent no `Range` behind a 15-minute absolute deadline, so every attempt died at
 * about 41% and the next one began again from byte zero: a livelock that never installed anything.
 *
 * These tests hold the updater to the Gateway's range contract
 * (`gateway-kh gateway/api.py`, `/v1/apps/story/release/file`): `Range: bytes=N-` with a matching
 * `If-Range: <sha256>` answers 206, a stale validator answers the full 200, and a start at or past
 * the end answers 416. Everything runs in temp dirs, so the Trash these exercises is the temp data
 * dir's own `_trash` — never the checkout's.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import * as updater from '../services/app-update.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64')

function signed(fields: Partial<updater.ReleaseDescriptor> = {}): updater.ReleaseDescriptor {
  const d: any = {
    schema: updater.RELEASE_SCHEMA, schema_version: 1, app: 'story', version: '1.4.258', build: '1.4.258',
    filename: 'Story Studio KH 1.4.258.zip', bytes: 10, sha256: 'a'.repeat(64), published_at: 1,
    publisher_id: 'gatewaykh', publisher_key_id: updater.fingerprint(PUB), ...fields,
  }
  d.signature = sign(null, updater.canonicalBytes(d), privateKey).toString('base64')
  return d
}

/** A tiny real .app (ad-hoc signed, so `checkBundle` accepts it) zipped the way a release is. */
function releaseBytes(into: string): Buffer {
  const app = path.join(into, 'Story Studio KH.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Story Studio KH'))
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Story Studio KH</string>
<key>CFBundleIdentifier</key><string>test.story.update</string>
<key>CFBundleShortVersionString</key><string>1.4.258</string>
</dict></plist>`)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' })
  const zip = path.join(into, 'Story Studio KH 1.4.258.zip')
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip])
  return fs.readFileSync(zip)
}

interface FakeRelease {
  body: Buffer
  /** What the server publishes now: an `If-Range` naming anything else is stale. */
  sha: string
  /** Bytes to write before killing the socket, one entry per request (`undefined` = serve it all). */
  drops?: Array<number | undefined>
  /** Answer every request with the full body, as a Gateway with no range support would. */
  ignoreRange?: boolean
}

interface FakeServer {
  url: string
  requests: Array<{ range?: string; ifRange?: string; status: number }>
  close(): Promise<void>
}

/** `/v1/apps/story/release/file`, as the Gateway implements it. */
async function fakeReleaseServer(release: FakeRelease): Promise<FakeServer> {
  const requests: FakeServer['requests'] = []
  const server = createServer((req, res) => {
    const range = req.headers.range as string | undefined
    const ifRange = req.headers['if-range'] as string | undefined
    const total = release.body.length
    const asked = /^bytes=(\d+)-$/.exec(range ?? '')
    const usable = asked && !release.ignoreRange && ifRange === release.sha
    const start = usable ? Number(asked[1]) : 0
    const status = usable ? 206 : 200
    if (status === 206 && start >= total) {
      requests.push({ range, ifRange, status: 416 })
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
      return
    }
    const body = release.body.subarray(start)
    requests.push({ range, ifRange, status })
    res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${total - 1}/${total}` } : {}) })
    const drop = release.drops?.shift()
    if (drop === undefined) { res.end(body); return }
    res.write(body.subarray(0, drop))
    // A dropped connection part way through the file, as the relay does.
    setTimeout(() => res.destroy(), 5)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

function fakeQueue() {
  const q = { paused: false, running: 0, queued: 0, pausedJobs: 0 }
  return {
    isPaused: () => q.paused, pauseOwner: () => null, acquirePause: async () => true,
    releasePause: async () => true, running: () => q.running,
    summary: () => ({ running: q.running, queued: q.queued, paused: q.pausedJobs }),
  }
}

let tmp: { dir: string; cleanup: () => Promise<void> }
let settings: updater.UpdateSettings

/** An automatic install is off, so a staged release stays `ready` and nothing hands off to the helper. */
function options(url: string, extra: Partial<updater.UpdaterOptions> = {}): updater.UpdaterOptions {
  return {
    currentVersion: '1.4.257', appBundle: path.join(tmp.dir, 'Applications', 'Story Studio KH.app'), port: 1,
    quit: () => {}, queue: fakeQueue() as any,
    getSettings: async () => settings,
    saveSettings: async (p) => { settings = { ...settings, ...p } },
    gateway: async () => ({ url, key: 'k' }),
    channels: async () => 4,
    ...extra,
  }
}

function stagedFile(release: updater.ReleaseDescriptor): string {
  return path.join(updater.updateDir(), 'staging', release.version, release.filename)
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

beforeEach(async () => {
  tmp = await useTempDataDir()
  settings = { ...updater.defaultSettings(null), auto_install: false }
  updater._resetForTesting()
})
afterEach(async () => {
  updater._resetForTesting()
  await tmp.cleanup()
})

describe('a slow download resumes across checks', () => {
  test('a dropped connection keeps its part; the next check resumes it with Range/If-Range and the whole file still hashes', async () => {
    const bytes = releaseBytes(fs.mkdtempSync(path.join(tmp.dir, 'src-')))
    const release = signed({ bytes: bytes.length, sha256: sha256(bytes) })
    settings.trusted_publisher_key = PUB
    const server = await fakeReleaseServer({ body: bytes, sha: release.sha256, drops: [Math.floor(bytes.length / 2)] })
    try {
      updater._configureForTesting(options(server.url))

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      const state = updater.readState()
      assert.equal(state.phase, 'idle', 'a dropped connection is "not fully available yet", never a failed install')
      assert.match(state.error!, /not fully available yet/)
      assert.equal(server.requests.length, 1)

      // The defect: `stage()` trashed the staging dir, so this file was gone and the next attempt
      // began at byte zero. It must survive while it belongs to this same release.
      const part = `${stagedFile(release)}.part`
      const kept = fs.statSync(part).size
      assert.ok(kept > 0 && kept < bytes.length, `the partial download survived the attempt (${kept} bytes)`)

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      assert.equal(updater.readState().phase, 'ready')
      assert.equal(server.requests.length, 2, 'the second check resumed instead of downloading again')
      assert.equal(server.requests[1]!.range, `bytes=${kept}-`, 'it asked for exactly the bytes it was missing')
      assert.equal(server.requests[1]!.ifRange, release.sha256, 'the part is validated against the signed digest')
      assert.equal(server.requests[1]!.status, 206)

      // The transfer resumed; the file was still checked whole before it was renamed into place.
      assert.equal(sha256(fs.readFileSync(stagedFile(release))), release.sha256)
      assert.equal(fs.existsSync(part), false, 'the .part is gone once the finished file is in place')
    } finally { await server.close() }
  })

  test('a full 200 body (a re-published artifact, or a Gateway without ranges) replaces the part, never appends to it', async () => {
    const bytes = releaseBytes(fs.mkdtempSync(path.join(tmp.dir, 'src-')))
    const release = signed({ bytes: bytes.length, sha256: sha256(bytes) })
    settings.trusted_publisher_key = PUB
    const server = await fakeReleaseServer({ body: bytes, sha: release.sha256,
      drops: [Math.floor(bytes.length / 3)], ignoreRange: true })
    try {
      updater._configureForTesting(options(server.url))

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      const part = `${stagedFile(release)}.part`
      const kept = fs.statSync(part).size
      assert.ok(kept > 0 && kept < bytes.length)

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      assert.equal(server.requests[1]!.range, `bytes=${kept}-`, 'the client still asked to resume')
      assert.equal(server.requests[1]!.status, 200)
      assert.equal(updater.readState().phase, 'ready')
      const file = stagedFile(release)
      assert.equal(fs.statSync(file).size, bytes.length, 'the part was replaced, not appended to')
      assert.equal(sha256(fs.readFileSync(file)), release.sha256)
    } finally { await server.close() }
  })

  test('a 416 (a part at or past the end) discards the part instead of wedging on it', async () => {
    const whole = releaseBytes(fs.mkdtempSync(path.join(tmp.dir, 'src-')))
    // The artifact is still uploading: the Gateway offers the descriptor, but holds only a prefix.
    const release = signed({ bytes: whole.length, sha256: sha256(whole) })
    settings.trusted_publisher_key = PUB
    const server = await fakeReleaseServer({ body: whole.subarray(0, Math.floor(whole.length / 2)), sha: release.sha256 })
    try {
      updater._configureForTesting(options(server.url))

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      const part = `${stagedFile(release)}.part`
      assert.ok(fs.statSync(part).size > 0)

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      assert.equal(server.requests[1]!.status, 416)
      assert.match(updater.readState().error!, /no bytes past the part already downloaded/)
      assert.equal(fs.existsSync(part), false, 'the part is gone, so the next check starts the file over')

      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
      assert.equal(server.requests[2]!.range, undefined, 'and it really does start over, with no Range')
    } finally { await server.close() }
  })

  test('a download that keeps moving is never killed for being slow: the only clock armed is the 30 s inactivity window', async () => {
    const bytes = releaseBytes(fs.mkdtempSync(path.join(tmp.dir, 'src-')))
    const release = signed({ bytes: bytes.length, sha256: sha256(bytes) })
    settings.trusted_publisher_key = PUB
    const chunk = Math.ceil(bytes.length / 8)
    let at = 0
    // A paced but never-stalling transfer, over a plain (non-socket) body so the only timers seen
    // below are this updater's own.
    const body = new ReadableStream({
      async pull(controller) {
        if (at >= bytes.length) { controller.close(); return }
        // 50 ms between chunks: slow, and nowhere near the 30 s no-progress window.
        await new Promise(r => setTimeout(r, 50))
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + chunk)))
        at += chunk
      },
    })
    const armed: number[] = []
    const real = globalThis.setTimeout
    ;(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
      if (typeof ms === 'number' && ms > 0) armed.push(ms)
      return (real as any)(fn, ms, ...rest)
    }
    try {
      updater._configureForTesting(options('http://gateway.test', { fetch: (async () => new Response(body)) as any }))
      await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })
    } finally { globalThis.setTimeout = real }

    assert.equal(updater.readState().phase, 'ready')
    assert.equal(sha256(fs.readFileSync(stagedFile(release))), release.sha256)
    // WHAT THIS CANNOT CATCH: it never waits out a wall-clock cap, so it says nothing about how a
    // real abort tears down a socket — the stalled-download test in app-update.test.ts does that.
    // What it pins is that the ~240 MB transfer is bounded by PROGRESS and by nothing else: the old
    // `setTimeout(() => controller.abort(), 15 * 60_000)` made every attempt die at about 41%.
    assert.ok(armed.length > 0, 'the inactivity window is armed')
    assert.ok(armed.every(ms => ms <= 30_000), `nothing longer than the 30 s inactivity window: ${armed.join(', ')}`)
  })
})

describe('the check-in reports how far a download has got', () => {
  /**
   * The Gateway's fleet watchdog reads `update.downloaded_bytes` to tell a transfer that is moving
   * from one that has stopped, and says so to the owner — the fault that ran all night on the mini
   * was a check-in that said "downloading" and nothing else. It must be the live figure while bytes
   * are arriving, and ABSENT the rest of the time, so "no figure" never reads as "zero bytes".
   */
  test('the byte count is live during a transfer and gone once it ends', async () => {
    const bytes = releaseBytes(fs.mkdtempSync(path.join(tmp.dir, 'src-')))
    const release = signed({ bytes: bytes.length, sha256: sha256(bytes) })
    settings.trusted_publisher_key = PUB
    updater._configureForTesting(options('http://gateway.test'))
    assert.equal('downloaded_bytes' in ((await updater.report() as any).update), false,
      'nothing is downloading: no figure at all, not a zero')

    const seen: Array<{ downloaded_bytes?: number; total_bytes?: number }> = []
    const chunk = Math.max(1, Math.ceil(bytes.length / 4))
    let at = 0
    const body = new ReadableStream({
      async pull(controller) {
        if (at >= bytes.length) { controller.close(); return }
        // A stream pulls once on construction, before the updater has started reading it.
        await waitFor(async () => 'total_bytes' in ((await updater.report() as any).update), { label: 'transfer started' })
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + chunk)))
        at += chunk
        seen.push((await updater.report() as any).update)
      },
    })
    updater._configureForTesting(options('http://gateway.test', { fetch: (async () => new Response(body)) as any }))
    await updater.handleOffer({ release, publisher: { public_key_base64: PUB } })

    assert.equal(updater.readState().phase, 'ready')
    assert.ok(seen.length > 0, 'the check-in was taken while the transfer was running')
    assert.equal(seen[0]!.total_bytes, bytes.length, 'the signed size, not a guess')
    assert.ok(seen[0]!.downloaded_bytes! > 0, 'the live count, not a placeholder zero')
    assert.ok(seen[seen.length - 1]!.downloaded_bytes! > seen[0]!.downloaded_bytes!,
      'it grows as the file arrives')
    assert.equal('downloaded_bytes' in ((await updater.report() as any).update), false,
      'the transfer is over, so the figure is gone again')
  })
})
