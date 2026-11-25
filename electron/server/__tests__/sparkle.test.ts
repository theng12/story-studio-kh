import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
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
        return { start: () => 0, lastError: () => '' }
      },
      log,
    })
    assert.equal(ok, true)
    assert.equal(requested, '/bundle/Resources/app.asar.unpacked/electron/dist/khsparkle.node')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].level, 'info')
    assert.match(lines[0].message, /holds work before fetching the signed feed/)
  })

  test('a refusal says why and says no update was fetched', () => {
    const { lines, log } = capture()
    const ok = startSparkle({
      packaged: true,
      load: () => ({ start: () => 2, lastError: () => 'Info.plist is missing SUFeedURL' }),
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
