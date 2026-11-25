/**
 * The single in-app update entry point. The shim takes the app's 0600 hold token,
 * POSTs the fixed hold endpoint, refuses unless the answer is 200 {"safe":true}
 * (work settles for the route's 20 s window, queued jobs stay queued), then
 * fetches the signed feed, installs, relaunches and releases the hold. Story
 * starts it once, after the hold endpoint exists; a refusal is a plain log line.
 *
 * One gap is Story's to close: Sparkle 2 does not call the user driver for a
 * background check that finds nothing, so on that path the shim never sends its
 * own DELETE and the route's 120 s pause would keep dispatch closed after every
 * launch. Once the check has had a moment and the shim still reports no update
 * (state 0), Story releases the same hold itself. When an update IS found (state
 * 1), the hold stays until Sparkle replaces the app.
 *
 * shortcut: a feed check slower than the release window with an update waiting
 * would resume dispatch mid-download; upgrade when the shim releases its own
 * hold on a finished background cycle (issue 20261125-46).
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Shim = { start(): number; lastError(): string; state(): number }

type FetchLike = (url: string, init: { method: string, headers: Record<string, string> }) => Promise<{ ok: boolean, status: number }>

export type SparkleStartOptions = {
  packaged?: boolean
  resourcesPath?: string
  load?: (addon: string) => Shim
  log?: (level: 'info' | 'warn', message: string) => void
  /** Overrides read from the bundle's Info.plist; tests pass these. */
  hold?: { url: string, tokenFile: string }
  plistPath?: string
  homedir?: string
  fetchImpl?: FetchLike
  /** Injectable grace timer: tests fire it instead of sleeping (no fixed-ms sleep in tests). */
  setTimer?: (fn: () => void, ms: number) => unknown
}

/** How long the check gets before a still-idle shim means "nothing to install". */
const RELEASE_GRACE_MS = 10_000

// The two keys are adjacent strings in our own generated Info.plist; a plist library
// for two values would be a dependency nobody asked for.
function plistString(xml: string, key: string): string | undefined {
  return xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]
}

function holdConfig(options: SparkleStartOptions): { url: string, token: string } | undefined {
  try {
    let url = options.hold?.url
    let tokenFile = options.hold?.tokenFile
    if (!url || !tokenFile) {
      const plist = options.plistPath
        ?? path.join(path.dirname(process.execPath), '..', 'Info.plist')
      const xml = fs.readFileSync(plist, 'utf8')
      url ||= plistString(xml, 'KHHoldURL')
      tokenFile ||= plistString(xml, 'KHHoldTokenFile')
    }
    if (!url || !tokenFile) return undefined
    const home = options.homedir ?? os.homedir()
    const file = tokenFile.startsWith('~/') ? path.join(home, tokenFile.slice(2)) : tokenFile
    const token = fs.readFileSync(file, 'utf8').trim()
    return token ? { url, token } : undefined
  } catch {
    return undefined
  }
}

function releaseWhenNothingFound(shim: Shim, options: SparkleStartOptions, log: NonNullable<SparkleStartOptions['log']>) {
  const graceMs = RELEASE_GRACE_MS
  const schedule = options.setTimer ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  })
  schedule(() => {
    void (async () => {
      try {
        if (shim.state() !== 0) {
          log('info', 'updates: a newer version is available; the hold stays until Story is replaced')
          return
        }
        const hold = holdConfig(options)
        if (!hold) {
          log('warn', 'updates: no update available, but the hold token is unreadable; the hold expires on its own')
          return
        }
        const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike)
        const res = await fetchImpl(hold.url, { method: 'DELETE', headers: { Authorization: `Bearer ${hold.token}` } })
        if (res.ok) {
          log('info', `updates: no update available; released the update hold after ${Math.round(graceMs / 1000)} s`)
        } else {
          log('warn', `updates: no update available, but releasing the hold answered ${res.status}; it expires on its own`)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log('warn', `updates: no update available, but releasing the hold failed (${reason}); it expires on its own`)
      }
    })()
  }, graceMs)
}

export function startSparkle(options: SparkleStartOptions = {}): boolean {
  if (!options.packaged) return false
  const log = options.log || ((_level, message) => process.stdout.write(`${message}\n`))
  const addon = path.join(
    options.resourcesPath || '', 'app.asar.unpacked', 'electron', 'dist', 'khsparkle.node',
  )
  try {
    const load = options.load || ((file: string) => createRequire(import.meta.url)(file) as Shim)
    const shim = load(addon)
    const rc = shim.start()
    if (rc === 0) {
      log('info', 'updates: Sparkle started; it holds work before fetching the signed feed, then relaunches')
      releaseWhenNothingFound(shim, options, log)
      return true
    }
    log('warn', `updates unavailable: Sparkle refused to start (${rc}): ${shim.lastError()}. Story keeps working; no update was fetched.`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log('warn', `updates unavailable: the updater at ${addon} could not be loaded: ${reason}. Story keeps working; no update was fetched.`)
  }
  return false
}
