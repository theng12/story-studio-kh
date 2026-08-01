/**
 * Dev backend port + Nuxt `/api` proxy resolution.
 *
 * The bug this locks out (v1.0.780): `npm run dev` did not work on a fresh
 * checkout, and said so in the most misleading way possible. Three independent
 * hardcoded `8000`s — Electron's dev bind, standalone `tsx` boot, and Nuxt's
 * `devProxy` target — pointed at a port that on the owner's machine belongs to
 * **GenStudio KH's API gateway**. The frontend loaded, proxied `/api/projects`
 * into GenStudio, got a perfectly correct 404 back, and reported "Couldn't load
 * your projects". Nothing anywhere printed which server had answered.
 *
 * It appeared to work for the owner only because they run server mode, which
 * binds a fixed port from app-settings.json (8766). The proxy's static default
 * could not know that, so the proxy pointed at GenStudio while the backend sat
 * on 8766 — same silent failure from the other end.
 *
 * So the coverage here is about *derivation*, not about a number:
 *   1. The proxy target follows the backend through every branch, in order.
 *   2. Every way of failing to read app-settings.json still yields a usable
 *      target — a dev server that refuses to boot over a stray comma in a
 *      settings file is a worse outcome than the bug.
 *   3. The failure is audible: the target and its provenance are printed, and
 *      an unreadable settings file warns rather than falling back in silence.
 *   4. The three consumers keep sharing one constant instead of re-typing it.
 *
 * Offline, no network, zero spend.
 */

import { test, describe, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  DEV_BACKEND_PORT,
  resolveDevApiProxy,
  formatDevApiProxyLog,
  formatDevApiProxyWarning,
} from '../lib/dev-backend.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..')

const originalDataDir = process.env.STORY_STUDIO_DATA_DIR
const originalServerModeEnv = process.env.STORY_STUDIO_SERVER_MODE
const originalProxyEnv = process.env.STORY_STUDIO_API_PROXY

let dataDir = ''

/** Point the settings resolver at a scratch dir; never the developer's real file. */
before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-devproxy-'))
  process.env.STORY_STUDIO_DATA_DIR = dataDir
  delete process.env.STORY_STUDIO_SERVER_MODE
  delete process.env.STORY_STUDIO_API_PROXY
})

after(async () => {
  if (originalDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
  else process.env.STORY_STUDIO_DATA_DIR = originalDataDir
  if (originalServerModeEnv === undefined) delete process.env.STORY_STUDIO_SERVER_MODE
  else process.env.STORY_STUDIO_SERVER_MODE = originalServerModeEnv
  if (originalProxyEnv === undefined) delete process.env.STORY_STUDIO_API_PROXY
  else process.env.STORY_STUDIO_API_PROXY = originalProxyEnv
  if (dataDir) {
    // A permissions test may have left the file unreadable.
    await fs.chmod(path.join(dataDir, 'app-settings.json'), 0o600).catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

function settingsPath(): string {
  return path.join(dataDir, 'app-settings.json')
}

/** Write raw text so malformed-JSON cases are expressible. */
async function writeSettingsRaw(raw: string): Promise<void> {
  await fs.writeFile(settingsPath(), raw, 'utf-8')
}

async function writeSettings(obj: unknown): Promise<void> {
  await writeSettingsRaw(JSON.stringify(obj, null, 2))
}

async function removeSettings(): Promise<void> {
  await fs.rm(settingsPath(), { force: true })
}

describe('dev backend port', () => {
  test('is not a port another product already owns', () => {
    // 8000 is GenStudio KH's gateway — the whole reason this module exists.
    // The rest are the ports every other dev tool squats on.
    for (const taken of [8000, 3000, 5173, 8080, 8888, 9000]) {
      assert.notEqual(DEV_BACKEND_PORT, taken, `dev backend must not use :${taken}`)
    }
  })

  test('is a real, non-ephemeral TCP port', () => {
    assert.ok(Number.isInteger(DEV_BACKEND_PORT), 'must be an integer')
    assert.ok(DEV_BACKEND_PORT > 1024, 'must not need root')
    // macOS hands out 49152+ as ephemeral ports; anything there can be stolen
    // by an unrelated process between two dev runs.
    assert.ok(DEV_BACKEND_PORT < 49152, 'must sit below the ephemeral range')
  })

  test('is shared by every consumer instead of retyped', async () => {
    const mainTs = await fs.readFile(path.join(REPO_ROOT, 'electron', 'main.ts'), 'utf-8')
    const appTs = await fs.readFile(path.join(SERVER_ROOT, 'app.ts'), 'utf-8')
    const nuxtConfig = await fs.readFile(
      path.join(REPO_ROOT, 'frontend', 'nuxt.config.ts'), 'utf-8')

    assert.match(mainTs, /DEV_BACKEND_PORT/, 'main.ts must import the shared constant')
    assert.match(appTs, /DEV_BACKEND_PORT/, 'app.ts must import the shared constant')

    // No literal 8000 left anywhere in the dev-port plumbing.
    assert.doesNotMatch(mainTs, /isDev\s*\?\s*8000/)
    assert.doesNotMatch(appTs, /process\.env\.PORT\s*\|\|\s*['"]8000['"]/)
    assert.doesNotMatch(nuxtConfig, /localhost:8000/)

    // The proxy target is derived, not written down.
    assert.match(nuxtConfig, /resolveDevApiProxy\(\)/,
      'nuxt.config must resolve the proxy target, not hardcode one')
    assert.doesNotMatch(nuxtConfig, /target:\s*['"]http/,
      'nuxt.config must not pin a literal proxy target')
  })

  test('packaged builds still get a random loopback port', async () => {
    const mainTs = await fs.readFile(path.join(REPO_ROOT, 'electron', 'main.ts'), 'utf-8')
    // `isDev ? DEV_BACKEND_PORT : 0` — production keeps port 0 so two installs
    // can run side by side.
    assert.match(mainTs, /isDev\s*\?\s*DEV_BACKEND_PORT\s*:\s*0/)
    assert.match(mainTs, /bind = '127\.0\.0\.1'/)
  })
})

describe('dev /api proxy resolution order', () => {
  test('1. STORY_STUDIO_API_PROXY wins over everything', async () => {
    await writeSettings({ server_mode: { enabled: true, port: 8766, bind: '0.0.0.0' } })
    const r = resolveDevApiProxy({ STORY_STUDIO_API_PROXY: 'http://example.test:1234/api' } as any)
    assert.equal(r.source, 'env')
    assert.equal(r.target, 'http://example.test:1234/api')
    assert.equal(r.warning, undefined)
  })

  test('1a. the escape hatch is trimmed, and blank means unset', async () => {
    await writeSettings({ server_mode: { enabled: true, port: 8766 } })
    const padded = resolveDevApiProxy({ STORY_STUDIO_API_PROXY: '  http://h:9/api \n' } as any)
    assert.equal(padded.target, 'http://h:9/api')

    // A blank env var must not shadow the settings — an empty string is how a
    // shell exports "I did not set this".
    const blank = resolveDevApiProxy({ STORY_STUDIO_API_PROXY: '   ' } as any)
    assert.equal(blank.source, 'server-mode')
    assert.equal(blank.target, 'http://127.0.0.1:8766/api')
  })

  test('2. server mode\'s configured port — the case that broke silently', async () => {
    // Exactly the owner's real settings: server mode on, port 8766, bound to
    // every interface. The proxy must follow the setting, not a static default.
    await writeSettings({ server_mode: { enabled: true, port: 8766, bind: '0.0.0.0' } })
    const r = resolveDevApiProxy({} as any)
    assert.equal(r.source, 'server-mode')
    assert.equal(r.target, 'http://127.0.0.1:8766/api')
    assert.match(r.detail, /8766/)
    assert.equal(r.warning, undefined)
  })

  test('2a. a 0.0.0.0 bind is proxied to loopback, not to 0.0.0.0', async () => {
    await writeSettings({ server_mode: { enabled: true, port: 8766, bind: '0.0.0.0' } })
    const r = resolveDevApiProxy({} as any)
    assert.doesNotMatch(r.target, /0\.0\.0\.0/,
      '0.0.0.0 is a bind address, never a destination')
  })

  test('2b. STORY_STUDIO_SERVER_MODE=1 enables the branch without a JSON flag', async () => {
    await writeSettings({ server_mode: { port: 8123 } })
    const r = resolveDevApiProxy({ STORY_STUDIO_SERVER_MODE: '1' } as any)
    // resolveDevApiProxy reads the toggle from the real process env (that is
    // where server-mode.ts reads it), so drive it there.
    process.env.STORY_STUDIO_SERVER_MODE = '1'
    try {
      const live = resolveDevApiProxy({} as any)
      assert.equal(live.source, 'server-mode')
      assert.equal(live.target, 'http://127.0.0.1:8123/api')
    } finally {
      delete process.env.STORY_STUDIO_SERVER_MODE
    }
    // Without the process-level env var the same call falls through.
    assert.equal(r.source, 'default')
  })

  test('2c. an explicit enabled:false beats the env var, same as isServerMode()', async () => {
    await writeSettings({ server_mode: { enabled: false, port: 8766 } })
    process.env.STORY_STUDIO_SERVER_MODE = '1'
    try {
      const r = resolveDevApiProxy({} as any)
      assert.equal(r.source, 'default')
      assert.equal(r.target, `http://127.0.0.1:${DEV_BACKEND_PORT}/api`)
    } finally {
      delete process.env.STORY_STUDIO_SERVER_MODE
    }
  })

  test('3. otherwise the dev default', async () => {
    await writeSettings({ server_mode: { enabled: false } })
    const r = resolveDevApiProxy({} as any)
    assert.equal(r.source, 'default')
    assert.equal(r.target, `http://127.0.0.1:${DEV_BACKEND_PORT}/api`)
    assert.equal(r.warning, undefined, 'server mode being off is not a problem worth warning about')
  })
})

describe('dev /api proxy fallbacks (never throw, never take the dev server down)', () => {
  test('no settings file at all — the fresh-checkout case', async () => {
    await removeSettings()
    const r = resolveDevApiProxy({} as any)
    assert.equal(r.source, 'default')
    assert.equal(r.target, `http://127.0.0.1:${DEV_BACKEND_PORT}/api`)
    assert.equal(r.warning, undefined, 'a missing file is normal, not a failure')
  })

  test('malformed JSON warns and names the file', async () => {
    await writeSettingsRaw('{ "server_mode": { "enabled": true, "port": 8766, }')
    const r = resolveDevApiProxy({} as any)
    assert.equal(r.source, 'default')
    assert.equal(r.target, `http://127.0.0.1:${DEV_BACKEND_PORT}/api`)
    assert.ok(r.warning, 'a settings file we cannot parse must not fail silently')
    assert.match(r.warning!, /app-settings\.json/)
  })

  test('an unreadable settings file warns rather than falling back in silence', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return  // root reads anything
    if (process.platform === 'win32') return                                    // chmod is a no-op
    await writeSettings({ server_mode: { enabled: true, port: 8766 } })
    chmodSync(settingsPath(), 0o000)
    try {
      const r = resolveDevApiProxy({} as any)
      assert.equal(r.source, 'default')
      assert.ok(r.warning, 'EACCES must surface')
      assert.match(formatDevApiProxyWarning(r)!, new RegExp(String(DEV_BACKEND_PORT)))
    } finally {
      chmodSync(settingsPath(), 0o600)
    }
  })

  test('settings file that is valid JSON but not an object', async () => {
    for (const raw of ['null', '[]', '"a string"', '42']) {
      await writeSettingsRaw(raw)
      const r = resolveDevApiProxy({} as any)
      assert.equal(r.source, 'default', `raw: ${raw}`)
      assert.equal(r.warning, undefined, `raw: ${raw} parses fine, it just says nothing`)
    }
  })

  test('an empty settings file', async () => {
    await writeSettingsRaw('')
    const r = resolveDevApiProxy({} as any)
    assert.equal(r.source, 'default')
    assert.ok(r.warning, 'an empty file is not parseable JSON')
  })

  test('absent server_mode block', async () => {
    await writeSettings({ projects_root_override: '/somewhere', genstudio_base_url: 'http://x' })
    const r = resolveDevApiProxy({} as any)
    assert.equal(r.source, 'default')
    assert.equal(r.warning, undefined)
  })

  test('server_mode present but not an object', async () => {
    for (const sm of [null, 'yes', 42, ['enabled']]) {
      await writeSettings({ server_mode: sm })
      const r = resolveDevApiProxy({} as any)
      assert.equal(r.source, 'default', `server_mode: ${JSON.stringify(sm)}`)
    }
  })

  test('server mode on with an unusable port falls back to server mode\'s own default', async () => {
    // Not the dev default: the backend would bind 8765 here too, and the proxy
    // must agree with the backend rather than with this module.
    for (const port of [null, 0, -1, '8766', 8766.5, 70000, undefined]) {
      await writeSettings({ server_mode: { enabled: true, port } })
      const r = resolveDevApiProxy({} as any)
      assert.equal(r.source, 'server-mode', `port: ${String(port)}`)
      assert.equal(r.target, 'http://127.0.0.1:8765/api', `port: ${String(port)}`)
    }
  })
})

describe('dev /api proxy is audible', () => {
  test('the startup line names the target and where it came from', async () => {
    await writeSettings({ server_mode: { enabled: true, port: 8766 } })
    const line = formatDevApiProxyLog(resolveDevApiProxy({} as any))
    assert.match(line, /\/api/)
    assert.match(line, /http:\/\/127\.0\.0\.1:8766\/api/)
    assert.match(line, /server-mode/)
    assert.equal(line.split('\n').length, 1, 'one line, not a paragraph')
  })

  test('the default case is announced too, not just the exotic ones', async () => {
    await removeSettings()
    const line = formatDevApiProxyLog(resolveDevApiProxy({} as any))
    assert.match(line, new RegExp(`http://127\\.0\\.0\\.1:${DEV_BACKEND_PORT}/api`))
    assert.match(line, /default/)
  })

  test('the env override is announced as an override', async () => {
    const line = formatDevApiProxyLog(
      resolveDevApiProxy({ STORY_STUDIO_API_PROXY: 'http://h:1/api' } as any))
    assert.match(line, /STORY_STUDIO_API_PROXY/)
  })

  test('no warning line when there is nothing wrong', async () => {
    await writeSettings({ server_mode: { enabled: true, port: 8766 } })
    assert.equal(formatDevApiProxyWarning(resolveDevApiProxy({} as any)), null)
  })

  test('the warning states the fallback port, so the reader can act on it', async () => {
    await writeSettingsRaw('{ not json')
    const warning = formatDevApiProxyWarning(resolveDevApiProxy({} as any))
    assert.ok(warning)
    assert.match(warning!, new RegExp(String(DEV_BACKEND_PORT)))
  })
})
