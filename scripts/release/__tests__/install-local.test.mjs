/**
 * Installing Story Studio keeps the bundle it replaces.
 *
 * Every installer invocation runs from a private temporary project with its own source, target,
 * and trash. The real script is copied into that fixture so its ROOT can never resolve to this
 * checkout and a failing test cannot read, move, or remove the owner's `_trash/app` archive.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
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

function fakeApp(app, version, marker) {
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), infoPlist(version))
  fs.writeFileSync(path.join(app, 'Contents', 'marker'), marker)
}

function fixture(t, installedVersion) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'story-install-test-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))

  const script = path.join(project, 'scripts', 'release', 'install-local.sh')
  const source = path.join(project, 'source', 'Story Studio KH.app')
  const target = path.join(project, 'installed', 'Story Studio KH.app')
  const trash = path.join(project, 'private-trash', 'app')
  const defaultTrash = path.join(path.resolve(path.dirname(script), '..', '..'), '_trash', 'app')
  assert.equal(defaultTrash, path.join(project, '_trash', 'app'))
  assert.notEqual(defaultTrash, path.join(ROOT, '_trash', 'app'),
    'the copied installer resolved its default trash to the owner checkout')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(SCRIPT, script)
  fakeApp(source, '10.0.0', 'built-10.0.0')
  if (installedVersion) fakeApp(target, installedVersion, `installed-${installedVersion}`)
  return { defaultTrash, project, script, source, target, trash }
}

function install({ script, source, target, trash }) {
  const env = { ...process.env, STORY_STUDIO_INSTALL_TARGET: target }
  if (trash) env.STORY_STUDIO_INSTALL_TRASH = trash
  else delete env.STORY_STUDIO_INSTALL_TRASH
  const result = spawnSync('bash', [script, source], {
    env,
    encoding: 'utf8',
  })
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') }
}

test('the built bundle this script installs exists', () => {
  assert.ok(fs.existsSync(path.join(BUILT, 'Contents', 'Info.plist')),
    'dist/mac-arm64/Story Studio KH.app is missing — build one with `npm run dist:smoke`')
})

test('a replaced bundle is kept in the caller-supplied private trash', (t) => {
  const paths = fixture(t, '9.9.9')

  const { status, output } = install(paths)

  const kept = path.join(paths.trash, 'Story Studio KH.app-9.9.9')
  assert.equal(status, 0, output)
  assert.ok(fs.existsSync(kept), `the replaced bundle was not kept at ${kept}`)
  assert.equal(fs.readFileSync(path.join(kept, 'Contents', 'marker'), 'utf8'), 'installed-9.9.9',
    'the kept bundle carries the new version, so the old one was overwritten rather than moved')
})

test('a missing caller-supplied trash directory is created', (t) => {
  const paths = fixture(t, '9.9.7')
  assert.equal(fs.existsSync(paths.trash), false)

  const { status, output } = install(paths)

  assert.equal(status, 0, output)
  assert.ok(fs.existsSync(path.join(paths.trash, 'Story Studio KH.app-9.9.7')),
    'the private trash directory was not created for the previous bundle')
})

test('the default trash remains under the installer project root', (t) => {
  const paths = fixture(t, '9.9.8')

  const { status, output } = install({ ...paths, trash: undefined })

  assert.equal(status, 0, output)
  assert.ok(fs.existsSync(path.join(paths.defaultTrash, 'Story Studio KH.app-9.9.8')),
    'the default trash no longer belongs to the installer project')
})

test('a first install onto a bare machine needs no trash folder', (t) => {
  const paths = fixture(t)

  const { status, output } = install(paths)

  assert.equal(status, 0, output)
  assert.ok(fs.existsSync(path.join(paths.target, 'Contents', 'Info.plist')),
    'the target has no Info.plist after a first install')
  assert.equal(fs.existsSync(paths.trash), false,
    'a first install created a trash directory even though there was no bundle to keep')
})

/** A stand-in for the running app's queue API: running jobs reach a safe stop two polls after Pause. */
async function fakeQueueApi(t, { running, paused }) {
  const calls = []
  let polls = 0
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.url === '/api/system/queue/pause') paused = true
    if (req.url === '/api/system/queue/resume') paused = false
    if (req.url === '/api/system/queue/status' && paused && ++polls > 2) running = 0
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ paused, stats: { running, queued: 0, paused: 0, done: 0, error: 0, total: running } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { calls, url: `http://127.0.0.1:${server.address().port}` }
}

function installAsync({ script, source, target, trash }, extraEnv) {
  return new Promise(resolve => {
    const child = spawn('bash', [script, source], {
      env: { ...process.env, STORY_STUDIO_INSTALL_TARGET: target, STORY_STUDIO_INSTALL_TRASH: trash, ...extraEnv },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', status => resolve({ status, output }))
  })
}

test('running jobs: pause, wait for a safe stop, install, then resume the queue', async (t) => {
  const paths = fixture(t, '9.9.6')
  const app = await fakeQueueApi(t, { running: 2, paused: false })

  const { status, output } = await installAsync(paths, { STORY_STUDIO_API: app.url, STORY_STUDIO_INSTALL_POLL_SECONDS: '0.1' })

  assert.equal(status, 0, output)
  const pause = app.calls.indexOf('POST /api/system/queue/pause')
  const resume = app.calls.indexOf('POST /api/system/queue/resume')
  assert.ok(pause >= 0 && resume > pause, `pause then resume: ${app.calls.join(', ')}`)
  assert.match(output, /waiting: 2 job\(s\) still running/)
  assert.ok(output.indexOf('copying 10.0.0') > output.indexOf('waiting:'), 'installed only after the wait')
  assert.match(output, /resumed the queue \(jobs you paused by hand stay paused\)/)
})

test('a queue the owner paused stays paused, and a timeout still installs with a message', async (t) => {
  const paths = fixture(t, '9.9.5')
  const app = await fakeQueueApi(t, { running: 1, paused: true })

  const { status, output } = await installAsync(paths, {
    STORY_STUDIO_API: app.url, STORY_STUDIO_INSTALL_WAIT_SECONDS: '0', STORY_STUDIO_INSTALL_POLL_SECONDS: '0.1',
  })

  assert.equal(status, 0, output)
  assert.ok(!app.calls.some(call => call.startsWith('POST')), `no pause or resume: ${app.calls.join(', ')}`)
  assert.match(output, /already paused \(yours, left as it is\)/)
  assert.match(output, /still running after 0s; installing anyway/)
})

test('nothing running: no pause and no resume', async (t) => {
  const paths = fixture(t, '9.9.4')
  const app = await fakeQueueApi(t, { running: 0, paused: false })

  const { status, output } = await installAsync(paths, { STORY_STUDIO_API: app.url })

  assert.equal(status, 0, output)
  assert.deepEqual(app.calls, ['GET /api/system/queue/status'])
})
