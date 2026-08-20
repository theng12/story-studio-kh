import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_ROOT = path.join(ROOT, 'electron')
const PROBE_PATH = path.join(ROOT, 'scripts', 'release', 'fixtures', 'hermetic-backend-probe.test.mjs')
// Preloaded into every backend test process so supertest binds the IPv4
// loopback address it then connects to. Without it a throwaway test server
// can be shadowed by any local daemon holding that port on 127.0.0.1, and
// the request is answered by the neighbour instead of the app under test.
// See scripts/testing/loopback-supertest.mjs for the full story.
const LOOPBACK_PRELOAD = path.join(ROOT, 'scripts', 'testing', 'loopback-supertest.mjs')

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`)
}

async function snapshotTree(root) {
  const entries = []
  async function visit(dir, relative = '') {
    const children = await fs.readdir(dir, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const absolute = path.join(dir, child.name)
      const name = path.join(relative, child.name)
      if (child.isDirectory()) {
        entries.push(`directory ${name}`)
        await visit(absolute, name)
      } else if (child.isFile()) {
        const bytes = await fs.readFile(absolute)
        entries.push(`file ${name} ${bytes.byteLength} ${createHash('sha256').update(bytes).digest('hex')}`)
      } else {
        entries.push(`special ${name}`)
      }
    }
  }
  await visit(root)
  return entries.join('\n')
}

async function backendTestFiles() {
  const testsRoot = path.join(ELECTRON_ROOT, 'server', '__tests__')
  return (await fs.readdir(testsRoot))
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => path.join(testsRoot, name))
}

function trustedTempDir() {
  const keys = ['TMPDIR', 'TMP', 'TEMP']
  if (process.platform === 'win32') keys.push('USERPROFILE')
  const saved = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  try {
    return os.tmpdir()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function run() {
  let sandbox
  try {
    sandbox = await fs.mkdtemp(path.join(trustedTempDir(), 'story-studio-backend-tests-'))
    const fakeHome = path.join(sandbox, 'home')
    const fakeProfile = path.join(sandbox, 'profile')
    const fakeAppData = path.join(sandbox, 'appdata')
    const fakeXdgConfig = path.join(sandbox, 'xdg-config')
    const configuredProjectsRoot = path.join(sandbox, 'configured-projects')
    const sentinelProject = path.join(configuredProjectsRoot, 'owner-sentinel')
    const settings = { projects_root_override: configuredProjectsRoot }

    await fs.mkdir(sentinelProject, { recursive: true })
    await fs.writeFile(path.join(sentinelProject, 'jobs.json'), '{"jobs":[{"job_id":"owner-record","status":"done"}]}\n')
    await fs.writeFile(path.join(sentinelProject, 'owner-marker.txt'), 'must remain byte-identical\n')
    await Promise.all([
      writeJson(path.join(fakeHome, 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json'), settings),
      writeJson(path.join(fakeAppData, 'Story Studio KH', 'app-settings.json'), settings),
      writeJson(path.join(fakeXdgConfig, 'Story Studio KH', 'app-settings.json'), settings),
    ])
    if (process.argv.includes('--fail-after-setup')) {
      console.log(`[test-harness] sandbox: ${sandbox}`)
      throw new Error('intentional backend test harness setup failure')
    }
    const before = await snapshotTree(configuredProjectsRoot)

    const require = createRequire(import.meta.url)
    const tsxCli = require.resolve('tsx/cli')
    const tests = process.argv.includes('--probe') ? [PROBE_PATH] : await backendTestFiles()
    const childEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeProfile,
      APPDATA: fakeAppData,
      XDG_CONFIG_HOME: fakeXdgConfig,
      TMPDIR: sandbox,
      TMP: sandbox,
      TEMP: sandbox,
      STORY_STUDIO_TEST_HARNESS_ROOT: sandbox,
      STORY_STUDIO_DISABLE_LISTEN: '1',
      // `--import` rather than an argv flag: tsx re-spawns node for `--test`,
      // and NODE_OPTIONS is what survives that hop.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${pathToFileURL(LOOPBACK_PRELOAD).href}`]
        .filter(Boolean).join(' '),
    }
    delete childEnv.STORY_STUDIO_DATA_DIR
    delete childEnv.NODE_TEST_CONTEXT

    const child = spawn(process.execPath, [
      tsxCli,
      '--test',
      '--test-concurrency=1',
      '--test-force-exit',
      ...tests,
    ], {
      cwd: ELECTRON_ROOT,
      env: childEnv,
      stdio: 'inherit',
    })
    let exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })

    const after = await snapshotTree(configuredProjectsRoot)
    const unchanged = before === after
    console.log(`[test-harness] configured projects root byte-identical: ${unchanged}`)
    if (!unchanged) {
      console.error('[test-harness] backend tests changed the isolated configured projects-root sentinel')
      exitCode = 1
    }
    process.exitCode = exitCode
  } finally {
    if (sandbox) await fs.rm(sandbox, { recursive: true, force: true })
  }
}

await run()
