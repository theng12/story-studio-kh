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

function fakeQueue(running = 0, paused = false) {
  const q = {
    paused, runningCount: running, calls: [] as boolean[],
    isPaused: () => q.paused,
    setPaused: async (p: boolean) => { q.calls.push(p); q.paused = p },
    running: () => q.runningCount,
    summary: () => ({ running: q.runningCount, queued: 3, paused: 0 }),
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
  test('a newer release is downloaded, checked, staged without quarantine, then drained', async () => {
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
    assert.equal(state.phase, 'draining')
    assert.equal(plistVersion(state.staged_app!), '1.4.258')
    // A file this process wrote carries no quarantine attribute (the reason no `xattr -d` is needed).
    const downloaded = path.join(updater.updateDir(), 'staging', '1.4.258', release.filename)
    assert.throws(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', downloaded], { stdio: 'pipe' }))
    // The queue was paused by the updater, and it is the updater's to resume.
    assert.deepEqual(queue.calls, [true])
    assert.equal(state.we_paused, true)
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
    ready()
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
    ready()
    const queue = fakeQueue(1, true)
    updater._configureForTesting(options(queue))
    await updater.maybeInstall()
    assert.equal(updater.readState().we_paused, false)
    assert.deepEqual(queue.calls, [])
  })

  test('the idle window waits while anything runs; auto-install off waits for Install Now', async () => {
    ready()
    settings.install_window = 'idle'
    updater._configureForTesting(options(fakeQueue(1)))
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready')
    settings.install_window = 'drain'
    settings.auto_install = false
    await updater.maybeInstall()
    assert.equal(updater.readState().phase, 'ready')
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
        SU_PID: String(quitter.pid), SU_TARGET: target, SU_STAGED: staged, SU_TRASH: path.join(tmp.dir, '_trash', 'app'),
        SU_STATE: state, SU_RESULT: path.join(tmp.dir, 'result.json'), SU_LOG: path.join(tmp.dir, 'helper.log'),
        SU_VERSION: '1.4.258', SU_OLD_VERSION: '1.4.257', SU_LABEL: 'test.never.loaded', SU_HEALTH_SECONDS: '3',
      },
    }
  }

  test('waits for the app to quit, keeps the old app in _trash, swaps, relaunches, sees it healthy', async () => {
    const l = layout()
    // The "relaunched app" reports healthy the way the real one does: by writing its state file.
    const relaunch = `printf '{"phase":"installed","release":{"version":"1.4.258"}}' > ${JSON.stringify(l.state)}`
    await runHelper({ ...l.env, SU_RELAUNCH: relaunch })
    assert.equal(plistVersion(l.target), '1.4.258')
    assert.equal(plistVersion(path.join(tmp.dir, '_trash', 'app', 'Story Studio KH.app-1.4.257')), '1.4.257')
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'installed')
    assert.equal(fs.existsSync(l.staged), false)
  })

  test('a new version that never reports healthy is put aside and the old one is back', async () => {
    const l = layout()
    await runHelper({ ...l.env, SU_RELAUNCH: `echo relaunch "$1" >> ${JSON.stringify(path.join(tmp.dir, 'relaunches'))}` })
    assert.equal(plistVersion(l.target), '1.4.257')
    const trash = fs.readdirSync(path.join(tmp.dir, '_trash', 'app'))
    assert.ok(trash.some(n => n.startsWith('Story Studio KH.app-1.4.258-failed-')), trash.join(','))
    assert.equal(JSON.parse(fs.readFileSync(l.env.SU_RESULT, 'utf8')).outcome, 'rolled_back')
    // The relaunch command runs in the background; give the second one a moment to land.
    const relaunches = () => fs.readFileSync(path.join(tmp.dir, 'relaunches'), 'utf8').trim().split('\n').length
    await waitFor(() => relaunches() >= 2, { label: 'the second relaunch' })
    assert.equal(relaunches(), 2)
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
