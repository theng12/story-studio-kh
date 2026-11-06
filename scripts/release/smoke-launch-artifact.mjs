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
 *   isolated and retained under the project's `_trash/` afterwards. That
 *   keeps the developer's real projects untouched and side-steps the
 *   single-instance lock, so a running
 *   copy of the app does not make the smoke test silently exit 0.
 *
 * Stop contract (TERM-only):
 *   This script sends the packaged app exactly one signal, a bounded SIGTERM,
 *   and never escalates to SIGKILL. An app that will not exit is a failed
 *   launch: it is reported loudly (`ok: false`), left running, and its
 *   sandbox is left in place so the process and its files can be inspected —
 *   a sandbox that is still in use is never moved or deleted.
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

// The only stop this script may send is a bounded SIGTERM; there is no SIGKILL
// anywhere in it. Both bounds are constants so the settle is finite and legible:
// 5 s / 100 ms is 50 polls of grace.
export const TERM_GRACE_MS = 5_000
export const TERM_POLL_MS = 100

function argValue(name) {
  const exact = process.argv.indexOf(name)
  if (exact >= 0) return process.argv[exact + 1]
  const prefix = `${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Bounded TERM-only stop. Returns `true` only when the caller's own `exited`
 * evidence says the process is gone.
 *
 * `child.killed` is deliberately NOT used: Node sets it the moment a signal is
 * *sent*, so it is evidence that we asked, not that the process died. The
 * caller passes `exited` (its own 'exit' event) instead.
 *
 * @param {{ kill: (signal: string) => unknown }} child
 * @param {{ exited: () => boolean, graceMs?: number, pollMs?: number, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<boolean>}
 */
export async function stopChild(child, { exited, graceMs = TERM_GRACE_MS, pollMs = TERM_POLL_MS, sleep: wait = sleep } = {}) {
  if (exited()) return true
  child.kill('SIGTERM')
  // Counted bound, not a wall-clock deadline: at most graceMs/pollMs polls — 50 at the
  // production 5 s / 100 ms — so an injected sleep cannot spin the loop. Each poll still
  // awaits its own timer, so a delayed event loop can make those 50 polls take longer than
  // graceMs in wall time; the settle is bounded by the poll count, not by the clock.
  for (let waited = 0; waited < graceMs && !exited(); waited += pollMs) await wait(pollMs)
  return exited()
}

/**
 * The app's own `[shutdown]` stage lines from captured stdout — the bounded
 * evidence a TERM failure may print. Never the raw tail: it carries URLs and
 * unrelated logs.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function shutdownMarkerLines(output) {
  return String(output).split('\n').map((line) => line.trim()).filter((line) => line.startsWith('[shutdown]')).slice(-20)
}

/**
 * Retain the isolated sandbox under the project's disposable `_trash/`, but only
 * once the app has actually exited. An unsettled sandbox is left exactly where
 * it is and named in the warning — nothing is moved or deleted while a process
 * may still be using it.
 *
 * @param {string} sandbox
 * @param {{ settled: boolean, projectRoot?: string, warn?: (message: string) => void }} options
 * @returns {{ moved: boolean, path?: string, retained?: string }}
 */
export function finalizeLaunchSandbox(sandbox, { settled, projectRoot = root, warn = console.warn } = {}) {
  if (!settled) {
    warn(`Launch smoke sandbox retained at ${sandbox}: the packaged app did not exit after SIGTERM within ${TERM_GRACE_MS}ms (no SIGKILL was sent)`)
    return { moved: false, retained: sandbox }
  }
  try {
    const trashRoot = path.join(projectRoot, '_trash')
    fs.mkdirSync(trashRoot, { recursive: true })
    const trashDir = fs.mkdtempSync(path.join(trashRoot, 'release-'))
    const destination = path.join(trashDir, path.basename(sandbox))
    fs.renameSync(sandbox, destination)
    return { moved: true, path: destination }
  } catch (error) {
    warn(`Launch smoke sandbox retained at ${sandbox}: could not move it into project _trash (${error.message})`)
    return { moved: false, retained: sandbox }
  }
}

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

  // A caller (a test harness or shell profile) may export
  // ELECTRON_RUN_AS_NODE=1. Inherited here, it makes the packaged app run as
  // Node and reject `--user-data-dir` with "bad option: --user-data-dir=…",
  // which the verifier then reports as "the app exited before its backend
  // started" — a false artifact failure. The smoke launch always wants the
  // real Electron app, so never forward that switch.
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE

  const child = spawn(executable, [`--user-data-dir=${userDataDir}`], {
    env: {
      ...childEnv,
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

  // The whole launch proof lives in this closure so the settle below runs
  // exactly once, on every path. A `return` written directly in a `try` would
  // leave the `finally` unable to correct the outcome, which is how a force
  // killed app could still be reported as a clean launch.
  const launchAndProve = async () => {
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
  }

  let termStage = 'launch proof did not complete'
  let evidence = null
  let outcome
  try {
    outcome = await launchAndProve()
    termStage = 'launch proof completed'
  } finally {
    const settled = await stopChild(child, { exited: () => exited !== null })
    evidence = {
      stage: `SIGTERM requested after ${termStage}`,
      pid: Number.isInteger(child.pid) ? child.pid : null,
      exitObserved: exited !== null,
    }
    finalizeLaunchSandbox(sandbox, { settled })
    if (!settled) {
      const markers = shutdownMarkerLines(output)
      outcome = {
        ok: false,
        errors: [
          ...(outcome?.errors ?? []),
          `the packaged app did not exit after SIGTERM within ${TERM_GRACE_MS}ms (child pid ${evidence.pid}, stage: ${evidence.stage}, exit observed: ${evidence.exitObserved}; no SIGKILL was sent; sandbox retained at ${sandbox}). Shutdown markers: ${markers.length ? markers.join(' | ') : '(none)'}`,
        ],
      }
    }
  }
  if (evidence) outcome.evidence = evidence
  return outcome
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
