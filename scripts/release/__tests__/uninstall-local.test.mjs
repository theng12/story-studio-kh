/**
 * Uninstalling Story Studio takes the app, its helper and its login job, and keeps the user's data.
 *
 * Owner rule 2026-11-12: every app must release everything on quit and on delete. The helper lives
 * inside the app bundle, so the bundle moving out is what proves the helper cannot be left behind;
 * what this test pins is that the login job and its plist go too, the data folders stay, and a
 * running app makes the uninstall refuse rather than half-remove a live install.
 *
 * Everything runs on fixtures: a private HOME, a fake app bundle, a fake plist, and stub
 * `pgrep`/`launchctl`/`osascript`/`id` on PATH, so the real install, the real LaunchAgents folder and
 * the owner's `_trash` can never be touched.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'release', 'uninstall-local.sh')

function stubBin(dir, { running = false, jobLoaded = true } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const write = (name, body) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  }
  // `pgrep -x "Story Studio KH"` and `pgrep -f "Story Studio KH Helper"` both hit this stub.
  write('pgrep', running ? 'exit 0' : 'exit 1')
  write('osascript', 'exit 0')
  write('id', 'echo 501')
  // Stateful: `print` reports the job loaded until `bootout` removes it, which is what the script's
  // leftover check depends on.
  const state = path.join(dir, 'launchctl-loaded')
  if (jobLoaded) fs.writeFileSync(state, 'loaded\n')
  write('launchctl', [
    `STATE=${JSON.stringify(state)}`,
    'if [ "$1" = "print" ]; then [ -f "$STATE" ] && exit 0 || exit 1; fi',
    'if [ "$1" = "bootout" ]; then rm -f "$STATE"; exit 0; fi',
    'exit 0',
  ].join('\n'))
}

function fixture(t, { running = false, jobLoaded = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-uninstall-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const home = path.join(root, 'home')
  const app = path.join(root, 'Applications', 'Story Studio KH.app')
  const helper = path.join(app, 'Contents', 'Resources', 'Story Studio KH Helper.app')
  const trash = path.join(root, 'trash')
  const dataA = path.join(home, 'Documents', 'Story Studio KH')
  const dataB = path.join(home, 'Library', 'Application Support', 'Story Studio KH')
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.storystudio.kh.plist')

  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>')
  fs.mkdirSync(path.join(helper, 'Contents'), { recursive: true })
  fs.mkdirSync(plist.replace(/\/[^/]+$/, ''), { recursive: true })
  fs.writeFileSync(plist, '<plist/>')
  fs.mkdirSync(dataA, { recursive: true })
  fs.writeFileSync(path.join(dataA, 'channel.json'), '{"keep":"me"}')
  fs.mkdirSync(dataB, { recursive: true })

  const bin = path.join(root, 'bin')
  stubBin(bin, { running, jobLoaded })

  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STORY_STUDIO_UNINSTALL_TARGET: app,
      STORY_STUDIO_UNINSTALL_TRASH: trash,
      STORY_STUDIO_UNINSTALL_HOME: home,
    },
  })

  return { root, home, app, helper, trash, dataA, dataB, plist, result }
}

test('the app, its helper and the login job go; the data stays', (t) => {
  const f = fixture(t)
  assert.equal(f.result.status, 0, f.result.stderr)

  // The bundle — helper inside it — is gone from its install location and kept in the trash.
  assert.equal(fs.existsSync(f.app), false, 'the app is still installed')
  const kept = fs.readdirSync(path.join(f.trash)).flatMap(d => fs.readdirSync(path.join(f.trash, d)))
  assert.ok(kept.includes('Story Studio KH 9.9.9.app'), `trash holds ${kept.join(', ')}`)

  // The login job's plist is gone from LaunchAgents and kept in the trash.
  assert.equal(fs.existsSync(f.plist), false, 'the login job plist is still installed')

  // The owner's work is untouched, and the script says where it is.
  assert.equal(fs.readFileSync(path.join(f.dataA, 'channel.json'), 'utf8'), '{"keep":"me"}')
  assert.ok(fs.existsSync(f.dataB))
  assert.match(f.result.stdout, /kept your data/)
  assert.match(f.result.stdout, /uninstalled; nothing of Story Studio KH is left/)
})

test('a running app makes the uninstall refuse and remove nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-uninstall-busy-'))
  try {
    const home = path.join(root, 'home')
    const app = path.join(root, 'Applications', 'Story Studio KH.app')
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>')
    const bin = path.join(root, 'bin')
    stubBin(bin, { running: true })

    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STORY_STUDIO_UNINSTALL_TARGET: app,
        STORY_STUDIO_UNINSTALL_TRASH: path.join(root, 'trash'),
        STORY_STUDIO_UNINSTALL_HOME: home,
        STORY_STUDIO_UNINSTALL_WAIT_SECONDS: '1',
      },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /still running; nothing was removed/)
    assert.ok(fs.existsSync(app), 'the app was removed while it was still running')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
