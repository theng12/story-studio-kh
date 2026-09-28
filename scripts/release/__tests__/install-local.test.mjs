/**
 * v1.4.238 — installing Story Studio keeps the bundle it replaces, even if `_trash/app` is gone.
 *
 * **The defect, twice.** The install step moved the installed bundle into `_trash/app/` — a folder
 * that exists only because a previous install made it — and carried on when the move failed, so
 * `ditto` wrote over the old bundle in place. Recorded after 1.4.232 (*"the `mv` … failed because
 * that folder did not exist; `ditto` overwrote the 1.4.231 bundle in place"*), and then it happened
 * again on 1.4.237 and **1.4.236 was overwritten**. The folder was gone because `_trash/` is the
 * owner's to empty and he had emptied it.
 *
 * That is the whole point: **a procedure that breaks when the owner tidies his own trash is the
 * wrong procedure.** `scripts/release/install-local.sh` creates the folder, names the kept bundle
 * with the version it was, and treats a failed move as a failure rather than something to continue
 * past. These tests drive the real script with `STORY_STUDIO_INSTALL_TARGET` pointed at a temp
 * directory, so they never touch `/Applications` and never quit the app someone is using.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'release', 'install-local.sh')
const BUILT = path.join(ROOT, 'dist', 'mac-arm64', 'Story Studio KH.app')

function infoPlist(version) {
  return '<?xml version="1.0"?><plist><dict>'
    + '<key>CFBundleShortVersionString</key>'
    + `<string>${version}</string>`
    + '</dict></plist>'
}

/** A miniature "installed app" at `target`, marked so we can prove it was moved and not rewritten. */
function fakeInstalled(target, version) {
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), infoPlist(version))
  fs.writeFileSync(path.join(target, 'Contents', 'marker'), `installed-${version}`)
}

function install(target) {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, STORY_STUDIO_INSTALL_TARGET: target },
    encoding: 'utf8',
  })
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'story-install-'))
}

test('the built bundle this script installs exists', () => {
  // Without it every test below would pass vacuously by failing at the first guard.
  assert.ok(fs.existsSync(path.join(BUILT, 'Contents', 'Info.plist')),
    'dist/mac-arm64/Story Studio KH.app is missing — build one with `npm run dist:smoke`')
})

test('a bundle already installed is KEPT, named with the version it was — and is the real one', () => {
  // Both halves matter. `ditto` overwriting in place leaves the TARGET at the new version and the
  // old bundle gone, so a test that only looks for a folder would pass on the failure; the marker
  // is what proves the old bundle was moved rather than rewritten.
  const root = tempDir()
  const target = path.join(root, 'Story.app')
  fakeInstalled(target, '9.9.9')

  const { status, output } = install(target)

  const kept = path.join(ROOT, '_trash', 'app', 'Story Studio KH.app-9.9.9')
  const present = fs.existsSync(kept)
  const marker = present ? fs.readFileSync(path.join(kept, 'Contents', 'marker'), 'utf8') : ''
  // Read first, tidy after: this suite leaves the repository's `_trash/app` as it found it.
  fs.rmSync(kept, { recursive: true, force: true })

  assert.equal(status, 0, output)
  assert.ok(present, `the replaced bundle was not kept at ${kept}`)
  assert.equal(marker, 'installed-9.9.9',
    'the kept bundle carries the new version, so the old one was overwritten rather than moved')
})

test('a missing _trash/app is created rather than skipped', () => {
  // The exact precondition that lost 1.4.236. `_trash/` is the owner's to empty, so the folder
  // being absent is a normal state, not an error — the script must not depend on it existing.
  const root = tempDir()
  const target = path.join(root, 'Story.app')
  fakeInstalled(target, '9.9.7')

  const trash = path.join(ROOT, '_trash', 'app')
  fs.rmSync(trash, { recursive: true, force: true })   // the state after the owner empties his trash

  const { status, output } = install(target)

  const kept = path.join(trash, 'Story Studio KH.app-9.9.7')
  const present = fs.existsSync(kept)
  fs.rmSync(trash, { recursive: true, force: true })

  assert.equal(status, 0, output)
  assert.ok(present, 'the folder was not created, so the previous bundle had nowhere to go')
})

test('a first install onto a bare machine needs no trash folder at all', () => {
  const root = tempDir()
  const target = path.join(root, 'Story.app')
  const { status, output } = install(target)
  assert.equal(status, 0, output)
  assert.ok(fs.existsSync(path.join(target, 'Contents', 'Info.plist')),
    'the target has no Info.plist after a first install')
})
