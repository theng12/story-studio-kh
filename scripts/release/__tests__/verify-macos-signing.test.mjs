import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareBuilds, designatedRequirement, launchdStart } from '../verify-macos-signing.mjs'

// Pure receipt logic only: no signing, no launchd job, no app, no network.

const requirement = 'designated => identifier "com.storystudio.kh" and certificate leaf = H"aabbccdd"'

describe('designated requirement', () => {
  test('accepts exactly one certificate-based requirement', () => {
    assert.equal(designatedRequirement(`Executable=/tmp/Story.app\n${requirement}\n`), requirement)
  })

  test('rejects an ad-hoc cdhash requirement', () => {
    assert.throws(() => designatedRequirement('designated => cdhash H"aabbccdd"'), /certificate-based/)
  })

  test('rejects missing or duplicated requirements', () => {
    assert.throws(() => designatedRequirement('Authority=KH Studio Local Signing'), /certificate-based/)
    assert.throws(() => designatedRequirement(`${requirement}\n${requirement}`), /certificate-based/)
  })
})

describe('two-version receipt comparison', () => {
  const previous = {
    version: '1.4.388',
    requirements: { '.': requirement, 'Contents/MacOS/Story Studio KH': requirement },
    hashes: { 'Contents/MacOS/Story Studio KH': 'aa', 'Contents/Resources/app.asar': 'bb' },
  }
  const current = {
    version: '1.4.389',
    requirements: { '.': requirement, 'Contents/MacOS/Story Studio KH': requirement },
    hashes: { 'Contents/MacOS/Story Studio KH': 'cc', 'Contents/Resources/app.asar': 'dd' },
  }

  test('accepts differing versions and bytes with identical requirements', () => {
    assert.doesNotThrow(() => compareBuilds(previous, current))
  })

  test('refuses the same version even when its bytes change', () => {
    assert.throws(() => compareBuilds(previous, previous), /Compare two differing versions/)
    assert.throws(() => compareBuilds(previous, { ...current, version: previous.version }), /Compare two differing versions/)
  })

  test('refuses changed designated requirements', () => {
    const changed = { ...current, requirements: { ...current.requirements, '.': 'designated => cdhash H"aabbccdd"' } }
    assert.throws(() => compareBuilds(previous, changed), /requirements changed/)
  })

  test('refuses a comparison with unchanged bytes', () => {
    assert.throws(() => compareBuilds(previous, { ...current, hashes: previous.hashes }), /changed bytes/)
  })
})

describe('launchd cleanup contract', () => {
  for (const cleanupStatus of [1, 2]) {
    test(`process cleanup status ${cleanupStatus} ${cleanupStatus === 1 ? 'passes' : 'fails loudly'}`, async (t) => {
      const root = fileURLToPath(new URL('../../../.test-work/', import.meta.url))
      fs.mkdirSync(root, { recursive: true })
      const work = fs.mkdtempSync(path.join(root, 'signing-launchd-'))
      t.after(() => {
        const retired = fileURLToPath(new URL('../../../_trash/test-fixtures/', import.meta.url))
        fs.mkdirSync(retired, { recursive: true })
        fs.renameSync(work, path.join(retired, path.basename(work)))
      })
      const calls = []
      let bootedOut = false
      const exec = (command, args) => {
        calls.push([command, ...args])
        if (command === 'pgrep') return { status: cleanupStatus }
        if (args[0] === 'bootout') bootedOut = true
        if (args[0] === 'print') return { status: bootedOut ? 113 : 0, stdout: bootedOut ? '' : 'pid = 42' }
        return { status: 0, stdout: '' }
      }
      const run = launchdStart({
        appPath: '/synthetic/Story.app', expectedVersion: '1.4.389', work, exec,
        wait: async () => {},
        fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '1.4.389', boot_complete: true }) }),
      })
      if (cleanupStatus === 1) assert.equal((await run).bootedOut, true)
      else await assert.rejects(run, /Could not verify test app process cleanup/)
      const bootouts = calls.filter((call) => call[1] === 'bootout')
      assert.equal(bootouts.length, 1)
      assert.match(bootouts[0][2], /^gui\/\d+\/com\.storystudio\.kh\.signing-test\./)
      assert.ok(calls.filter((call) => call[1] === 'print').every((call) => call[2] === bootouts[0][2]))
    })
  }

  test('boots out only its own job and never sends SIGKILL', () => {
    const source = fs.readFileSync(new URL('../verify-macos-signing.mjs', import.meta.url), 'utf8')
    assert.match(source, /launchctl', \['bootout', service\]/)
    assert.doesNotMatch(source, /['"]SIGKILL['"]/)
    assert.doesNotMatch(source, /\.kill\(/)
  })
})
