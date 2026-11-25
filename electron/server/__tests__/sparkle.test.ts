import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSparkle } from '../sparkle.js'

type LogLine = { level: 'info' | 'warn', message: string }

function capture() {
  const lines: LogLine[] = []
  return {
    lines,
    log: (level: 'info' | 'warn', message: string) => lines.push({ level, message }),
  }
}

describe('in-app Sparkle start', () => {
  test('a dev run loads no addon and changes nothing', () => {
    const { lines, log } = capture()
    let loaded = false
    const ok = startSparkle({
      packaged: false,
      load: () => { loaded = true; throw new Error('must not load') },
      log,
    })
    assert.equal(ok, false)
    assert.equal(loaded, false)
    assert.deepEqual(lines, [])
  })

  test('a started updater names the hold-then-update order', () => {
    const { lines, log } = capture()
    let requested = null
    const ok = startSparkle({
      packaged: true,
      resourcesPath: '/bundle/Resources',
      load: (addon) => {
        requested = addon
        return { start: () => 0, lastError: () => '', state: () => 0 }
      },
      log,
      setTimer: () => {},
      fetchImpl: async () => ({ ok: true, status: 200 }),
    })
    assert.equal(ok, true)
    assert.equal(requested, '/bundle/Resources/app.asar.unpacked/electron/dist/khsparkle.node')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].level, 'info')
    assert.match(lines[0].message, /holds work before fetching the signed feed/)
  })

  test('a background check that finds nothing releases the hold exactly once', async () => {
    const { lines, log } = capture()
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kh-sparkle-')), 'hold-token')
    fs.writeFileSync(tokenFile, 'a'.repeat(64))
    const calls: { url: string, method: string, auth: string }[] = []
    let graceMs = 0
    let fire: (() => void) | undefined
    startSparkle({
      packaged: true,
      load: () => ({ start: () => 0, lastError: () => '', state: () => 0 }),
      log,
      hold: { url: 'http://127.0.0.1:8647/api/maintenance/hold', tokenFile },
      setTimer: (fn, ms) => { fire = fn; graceMs = ms },
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, auth: init.headers.Authorization })
        return { ok: true, status: 200 }
      },
    })
    assert.equal(graceMs, 10_000, 'the grace is the production window, not a test value')
    assert.deepEqual(calls, [], 'nothing is released before the grace elapses')
    fire?.()
    await Promise.resolve()
    assert.deepEqual(calls, [{
      url: 'http://127.0.0.1:8647/api/maintenance/hold',
      method: 'DELETE',
      auth: `Bearer ${'a'.repeat(64)}`,
    }], 'exactly one DELETE, addressed to the shim hold Story took')
    assert.match(lines.at(-1)?.message ?? '', /no update available; released the update hold/)
  })

  test('an update that IS available still holds after the grace window', async () => {
    const { lines, log } = capture()
    const calls: string[] = []
    let fire: (() => void) | undefined
    startSparkle({
      packaged: true,
      load: () => ({ start: () => 0, lastError: () => '', state: () => 1 }),
      log,
      setTimer: (fn) => { fire = fn },
      fetchImpl: async (url, init) => { calls.push(`${init.method} ${url}`); return { ok: true, status: 200 } },
    })
    fire?.()
    await Promise.resolve()
    assert.deepEqual(calls, [], 'no DELETE: the hold is still held while an update installs')
    assert.match(lines.at(-1)?.message ?? '', /a newer version is available; the hold stays/)
  })

  test('a refusal says why and says no update was fetched', () => {
    const { lines, log } = capture()
    const ok = startSparkle({
      packaged: true,
      load: () => ({ start: () => 2, lastError: () => 'Info.plist is missing SUFeedURL', state: () => 0 }),
      log,
    })
    assert.equal(ok, false)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].level, 'warn')
    assert.match(lines[0].message, /updates unavailable: Sparkle refused to start \(2\): Info\.plist is missing SUFeedURL/)
    assert.match(lines[0].message, /Story keeps working; no update was fetched/)
  })

  test('a missing framework or addon is named, not swallowed', () => {
    const { lines, log } = capture()
    const ok = startSparkle({
      packaged: true,
      resourcesPath: '/bundle/Resources',
      load: () => { throw new Error('Sparkle.framework not loaded') },
      log,
    })
    assert.equal(ok, false)
    assert.match(lines[0].message, /the updater at \/bundle\/Resources\/app\.asar\.unpacked\/electron\/dist\/khsparkle\.node could not be loaded: Sparkle\.framework not loaded/)
    assert.match(lines[0].message, /no update was fetched/)
  })
})
