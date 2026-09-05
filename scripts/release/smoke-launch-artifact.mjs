#!/usr/bin/env node
/**
 * smoke-launch-artifact.mjs — actually start the packaged app and prove it
 * serves before calling a build good.
 *
 * Why this exists (v1.4.69):
 *   `verify:artifact` checked signature, Info.plist, asar structure and DMG
 *   mounting. All four passed on v1.4.68, which could not start at all — its
 *   runtime dependencies had never been packaged, so the main process died on
 *   `import express`. A structural check is not a launch.
 *
 *   The real signal is not "a window appeared". The Express backend runs
 *   inside the Electron main process (electron/main.ts), so if the main
 *   process is healthy enough to answer HTTP on its own port, the imports
 *   resolved, the boot migrations ran, and the app is alive. That is what
 *   this asserts: `GET /api/health` returning `boot_complete: true`, then
 *   creates a throwaway project and reads its Upload Center overview through
 *   the production route bootstrap.
 *
 * Isolation:
 *   Launched with its own `--user-data-dir` and `STORY_STUDIO_DATA_DIR`, both
 *   temporary and removed afterwards. That keeps the developer's real
 *   projects untouched and side-steps the single-instance lock, so a running
 *   copy of the app does not make the smoke test silently exit 0.
 *
 * Usage:
 *   node scripts/release/smoke-launch-artifact.mjs [--app <path.app>] [--timeout <ms>]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))

function argValue(name) {
  const exact = process.argv.indexOf(name)
  if (exact >= 0) return process.argv[exact + 1]
  const prefix = `${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @returns {Promise<{ ok: boolean, errors: string[], port?: number, health?: object, uploadCenter?: object, ms?: number }>}
 */
export async function smokeLaunch(appPath, { timeoutMs = 120_000, log = () => {} } = {}) {
  const errors = []
  const executable = path.join(appPath, 'Contents', 'MacOS', contract.executableName)
  if (!fs.existsSync(executable)) return { ok: false, errors: [`app executable is missing: ${executable}`] }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-smoke-'))
  const userDataDir = path.join(sandbox, 'user-data')
  const dataDir = path.join(sandbox, 'data')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  const started = Date.now()
  let output = ''
  let exited = null

  const child = spawn(executable, [`--user-data-dir=${userDataDir}`], {
    env: {
      ...process.env,
      STORY_STUDIO_DATA_DIR: dataDir,
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const collect = (chunk) => {
    output += chunk.toString()
    if (output.length > 400_000) output = output.slice(-200_000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('exit', (code, signal) => { exited = { code, signal } })

  const shutdown = async () => {
    if (exited || child.killed) return
    child.kill('SIGTERM')
    for (let i = 0; i < 50 && !exited; i += 1) await sleep(100)
    if (!exited) child.kill('SIGKILL')
    for (let i = 0; i < 20 && !exited; i += 1) await sleep(100)
  }

  // A build whose imports never resolve can hang alive without printing
  // anything at all — that is exactly how v1.4.68 behaved — so say so rather
  // than reporting an empty tail and leaving the reader guessing.
  const tail = () => {
    const text = output.trim()
    if (text) return text.split('\n').slice(-25).join('\n')
    return exited
      ? '(the app produced no output before exiting)'
      : '(the app produced no output and was still running — it never got far enough to serve)'
  }

  try {
    // 1. Wait for the backend to announce the port it bound (packaged builds
    //    use port 0, so the printed line is the only place it appears).
    let port = null
    while (!port) {
      const match = /Backend running on https?:\/\/[^\s:]+:(\d+)/.exec(output)
      if (match) { port = Number(match[1]); break }
      if (exited) {
        errors.push(
          `the app exited before its backend started (code ${exited.code}, signal ${exited.signal}). Output:\n${tail()}`,
        )
        return { ok: false, errors }
      }
      if (Date.now() - started > timeoutMs) {
        errors.push(`the app never reported a listening backend within ${timeoutMs}ms. Output:\n${tail()}`)
        return { ok: false, errors }
      }
      await sleep(250)
    }
    log(`  backend port: ${port}`)

    // 2. The real proof: the packaged app answers HTTP on that port, which it
    //    cannot do unless express and the rest of the runtime tree loaded.
    let health = null
    while (!health) {
      if (exited) {
        errors.push(`the app exited while booting (code ${exited.code}, signal ${exited.signal}). Output:\n${tail()}`)
        return { ok: false, errors }
      }
      if (Date.now() - started > timeoutMs) {
        errors.push(`GET /api/health never reported boot_complete within ${timeoutMs}ms. Output:\n${tail()}`)
        return { ok: false, errors }
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (response.ok) {
          const body = await response.json()
          if (body?.boot_complete) health = body
        }
      } catch {
        /* not listening yet */
      }
      if (!health) await sleep(500)
    }

    // 3. Exercise a feature route through the packaged app's real route
    //    bootstrap. Direct router tests cannot catch a router that exists but
    //    was never mounted in production.
    let createdResponse
    try {
      createdResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Packaged route smoke' }),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - started))),
      })
    } catch (error) {
      errors.push(`POST /api/projects did not complete during the packaged route smoke: ${error}`)
      return { ok: false, errors }
    }
    if (!createdResponse.ok) {
      errors.push(`POST /api/projects failed during the packaged route smoke (${createdResponse.status})`)
      return { ok: false, errors }
    }
    const created = await createdResponse.json()
    let overviewResponse
    try {
      overviewResponse = await fetch(
        `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(created.slug)}/youtube/overview`,
        { signal: AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - started))) },
      )
    } catch (error) {
      errors.push(`GET /api/projects/:slug/youtube/overview did not complete during the packaged route smoke: ${error}`)
      return { ok: false, errors }
    }
    if (!overviewResponse.ok) {
      errors.push(`GET /api/projects/:slug/youtube/overview failed during the packaged route smoke (${overviewResponse.status})`)
      return { ok: false, errors }
    }
    const uploadCenter = await overviewResponse.json()
    if (uploadCenter?.assigned_channel !== null || uploadCenter?.unavailable_reason !== 'no_oauth_application') {
      errors.push('GET /api/projects/:slug/youtube/overview returned an invalid unconfigured-project response')
      return { ok: false, errors }
    }

    // 4. A module that failed to resolve is reported on stderr even though
    //    main.ts refuses to exit on it. Treat that as a failed launch.
    const moduleError = /(ERR_MODULE_NOT_FOUND|Cannot find (?:package|module) '[^']+')/.exec(output)
    if (moduleError) {
      errors.push(`the app logged a module resolution failure while running: ${moduleError[0]}\n${tail()}`)
      return { ok: false, errors }
    }

    return { ok: true, errors, port, health, uploadCenter, ms: Date.now() - started }
  } finally {
    await shutdown()
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

async function run() {
  const appPath = path.resolve(
    root,
    argValue('--app') || path.join('dist', `mac-${contract.architectures[0]}`, `${contract.productName}.app`),
  )
  const timeoutMs = Number(argValue('--timeout') || 120_000)

  console.log(`Launch smoke test: ${appPath}`)
  const result = await smokeLaunch(appPath, { timeoutMs, log: (line) => console.log(line) })

  if (!result.ok) {
    console.error('Launch smoke test failed — the packaged app does not run:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }

  console.log(`  GET /api/health -> ${JSON.stringify(result.health)}`)
  console.log(`  GET /api/projects/:slug/youtube/overview -> ${JSON.stringify(result.uploadCenter)}`)
  console.log(`  the packaged app booted and served in ${result.ms}ms, then quit cleanly`)
}

if (import.meta.url === `file://${process.argv[1]}`) await run()
