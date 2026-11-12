/**
 * Publishing must reach the updater host's feed, never this Mac's mirror.
 *
 * `~/Library/KHUpdater/feed` looks like the feed and accepts writes; on 2026-11-12 a publish there
 * reported success while the host kept serving the old version. This pins the refusal, so the trap
 * cannot come back through a manual command or a script that defaults to the mirror.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'release', 'publish-story.sh')
const VERSION = '9.9.9'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-publish-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const dmg = path.join(root, `Story Studio KH ${VERSION}-arm64.dmg`)
  fs.writeFileSync(dmg, 'not a real dmg')

  const calls = path.join(root, 'khu-calls.txt')
  const khu = path.join(root, 'khu')
  fs.writeFileSync(khu, `#!/bin/bash\necho "$@" >> ${JSON.stringify(calls)}\nexit 0\n`, { mode: 0o755 })

  const run = (...args) => spawnSync('bash', [SCRIPT, VERSION, dmg, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, KHU_BIN: khu, KHU_KEY: path.join(root, 'key') },
  })

  return { root, home, dmg, calls, run }
}

test('a feed path inside $HOME is refused — that is the mirror', (t) => {
  const f = fixture(t)
  const result = f.run('--host-feed', path.join(f.home, 'Library', 'KHUpdater', 'feed'))
  assert.equal(result.status, 2)
  assert.match(result.stderr, /mirror, not the updater host's feed/)
  assert.equal(fs.existsSync(f.calls), false, 'khu was invoked for a mirror path')
})

test('no --host-feed is refused rather than defaulting to the mirror', (t) => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--host-feed is required/)
  assert.equal(fs.existsSync(f.calls), false)
})

test('a host feed publishes through khu with the artifact and version', (t) => {
  const f = fixture(t)
  const hostFeed = path.join(f.root, 'host-feed')
  fs.mkdirSync(hostFeed)
  const result = f.run('--host-feed', hostFeed, '--changelog', '.')
  assert.equal(result.status, 0, result.stderr)
  const calls = fs.readFileSync(f.calls, 'utf8')
  assert.match(calls, /publish --feed .*host-feed/)
  assert.match(calls, new RegExp(`--version ${VERSION}`))
  assert.match(calls, /--app story/)
})
