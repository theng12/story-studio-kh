#!/usr/bin/env node
/**
 * verify-macos-signing.mjs — prove a locally signed Story Studio app, then
 * start the packaged app in an isolated launchd job.
 *
 * Usage:
 *   node scripts/release/verify-macos-signing.mjs <app.app> --receipt <receipt.json>
 *   ... --previous-receipt <older.json>   require unchanged designated requirements
 *   ... --skip-launch                     signature checks only
 *
 * The two-version comparison is the identity proof: versions and executable
 * bytes differ, while the certificate-based designated requirements of the app
 * and every persistent helper stay identical. The launchd job gets its own
 * label, port, app-settings file and data folder, answers /api/health, and
 * survives a startup window before only that owned job is booted out. Nothing
 * of the owner's is read, no SIGKILL is ever sent, and no trust or key setting
 * is touched.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { persistentHelperBundles } from './local-signing.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'release', 'desktop-release-contract.json'), 'utf8'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Exactly one certificate-based `designated =>` requirement, never a cdhash. */
export function designatedRequirement(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('designated =>'))
  if (lines.length !== 1 || /\bcdhash\b/.test(lines[0]) || !/\b(certificate|anchor)\b/.test(lines[0])) {
    throw new Error('A certificate-based designated requirement is required')
  }
  return lines[0]
}

/** Two differing builds, identical requirements, changed bytes. */
export function compareBuilds(previous, current) {
  if (previous.version === current.version) {
    throw new Error('Compare two differing versions')
  }
  if (JSON.stringify(previous.requirements) !== JSON.stringify(current.requirements)) {
    throw new Error('Designated requirements changed across builds')
  }
  if (JSON.stringify(previous.hashes) === JSON.stringify(current.hashes)) {
    throw new Error('The comparison must include changed bytes')
  }
}

function capture(command, args, timeout = 60_000, exec = spawnSync) {
  const result = exec(command, args, { encoding: 'utf8', timeout })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${output}`)
  return output
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Signature + designated-requirement receipt for the app and its helpers. */
export function buildReceipt({ appPath, identity }) {
  const plist = path.join(appPath, 'Contents', 'Info.plist')
  const bundleId = capture('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]).trim()
  if (bundleId !== contract.appId) throw new Error(`Unexpected packaged application identifier: ${bundleId}`)
  const version = capture('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]).trim()

  capture('codesign', ['--verify', '--deep', '--strict', appPath], 300_000)

  const executable = path.join('Contents', 'MacOS', contract.executableName)
  const helpers = persistentHelperBundles(appPath)
  if (!helpers.length) throw new Error('No persistent helper bundles found under Contents/Frameworks')
  const code = ['.', executable, ...helpers.map((helper) => path.relative(appPath, helper))]

  const requirements = {}
  for (const relative of code) {
    const target = relative === '.' ? appPath : path.join(appPath, relative)
    const output = capture('codesign', ['-d', '-vvv', '-r-', target])
    if (!output.split('\n').some((line) => line.trim() === `Authority=${identity}`)) {
      throw new Error(`Not signed by the configured identity: ${relative}`)
    }
    requirements[relative] = designatedRequirement(output)
  }

  const hashes = {}
  for (const relative of [executable, path.join('Contents', 'Resources', 'app.asar')]) {
    hashes[relative] = sha256File(path.join(appPath, relative))
  }
  return { bundleId, version, requirements, hashes }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Isolated launchd start: unique job, port, config and data folders. */
export async function launchdStart({
  appPath,
  expectedVersion,
  work,
  labelPrefix = 'com.storystudio.kh.signing-test',
  fetchImpl = fetch,
  wait = sleep,
  exec = spawnSync,
}) {
  const userData = path.join(work, 'userData')
  const dataDir = path.join(work, 'data')
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const port = await freePort()
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    server_mode: { enabled: true, port, bind: '127.0.0.1' },
  }))

  const label = `${labelPrefix}.${randomUUID()}`
  const domain = `gui/${process.getuid()}`
  const service = `${domain}/${label}`
  const job = path.join(work, 'app.plist')
  const executable = path.join(appPath, 'Contents', 'MacOS', contract.executableName)
  fs.writeFileSync(job, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>${xml(`--user-data-dir=${userData}`)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>STORY_STUDIO_SERVER_MODE</key><string>1</string>
<key>STORY_STUDIO_DATA_DIR</key><string>${xml(dataDir)}</string>
</dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(work, 'app.stdout'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(work, 'app.stderr'))}</string>
</dict></plist>
`)

  const ping = async () => {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) })
    return response.ok ? response.json() : null
  }
  const jobState = () => exec('launchctl', ['print', service], { encoding: 'utf8', timeout: 10_000 })

  try {
    capture('launchctl', ['bootstrap', domain, job], 60_000, exec)
    const deadline = Date.now() + 90_000
    let health = null
    while (!health) {
      try {
        const body = await ping()
        if (body?.status === 'ok' && body.boot_complete === true) health = body
      } catch {
        /* not listening yet */
      }
      if (!health) {
        if (Date.now() > deadline) throw new Error('Packaged app did not answer /api/health; see the retained test logs')
        await wait(500)
      }
    }
    if (health.version !== expectedVersion) {
      throw new Error(`Packaged app version ${health.version} does not match ${expectedVersion}`)
    }

    const first = jobState()
    const pid = /\bpid = (\d+)\b/.exec(first.stdout || '')
    if (first.status !== 0 || !pid) throw new Error('launchd job has no running process')
    await wait(3_000) // startup survival window; the same process must still answer
    const second = jobState()
    if (!new RegExp(`\\bpid = ${pid[1]}\\b`).test(second.stdout || '') || JSON.stringify(await ping()) !== JSON.stringify(health)) {
      throw new Error('Packaged app did not survive launchd startup')
    }
    return {
      started: true,
      health: true,
      version: health.version,
      survivedStartup: true,
      launchJobPID: Number(pid[1]),
      port,
      bootedOut: true,
    }
  } finally {
    if (jobState().status === 0) capture('launchctl', ['bootout', service], 60_000, exec)
    // Only this test's processes carry its private user-data folder on the command line.
    const cleanupDeadline = Date.now() + 30_000
    while (true) {
      const processes = exec('pgrep', ['-f', userData], { encoding: 'utf8', timeout: 10_000 })
      if (processes.error || ![0, 1].includes(processes.status)) throw new Error('Could not verify test app process cleanup')
      if (processes.status === 1) break
      if (Date.now() > cleanupDeadline) throw new Error(`Test app processes outlived bootout: ${userData}`)
      await wait(500)
    }
    const remainingJob = jobState()
    if (remainingJob.error || remainingJob.status === null || remainingJob.status === 0) {
      throw new Error('Could not verify owned launchd job cleanup')
    }
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

async function main() {
  const appPath = path.resolve(argValue('--app') || process.argv[2] || '')
  const receipt = argValue('--receipt')
  if (!appPath || !receipt) throw new Error('Usage: verify-macos-signing.mjs <app.app> --receipt <receipt.json> [--previous-receipt <older.json>] [--skip-launch]')
  const identity = argValue('--identity') || 'KH Studio Local Signing'
  const work = fs.mkdtempSync(path.join(path.dirname(path.resolve(receipt)), 'signing-test-'))

  const result = buildReceipt({ appPath, identity })
  const previous = argValue('--previous-receipt')
  if (previous) {
    compareBuilds(JSON.parse(fs.readFileSync(previous, 'utf8')), result)
    result.requirementsUnchangedAcrossBuilds = true
  }
  if (!process.argv.includes('--skip-launch')) {
    result.launchd = await launchdStart({ appPath, expectedVersion: result.version, work })
  }
  result.testWork = work
  fs.writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`Packager signature, certificate-based requirements${previous ? ' (unchanged across builds)' : ''}${result.launchd ? ' and isolated launchd start' : ''}: PASS`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
