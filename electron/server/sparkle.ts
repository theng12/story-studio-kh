/**
 * The single in-app update entry point. The shim owns the whole sequence: it
 * takes the app's 0600 hold token, POSTs the fixed hold endpoint, refuses
 * unless the answer is 200 {"safe":true} (work settles for the route's 20 s
 * window, queued jobs stay queued), then fetches the signed feed, installs,
 * relaunches, and releases the hold. Story only starts it once, after the
 * hold endpoint exists; a refusal is a plain log line, never a silent no-op.
 */
import { createRequire } from 'node:module'
import path from 'node:path'

type Shim = { start(): number; lastError(): string }

export type SparkleStartOptions = {
  packaged?: boolean
  resourcesPath?: string
  load?: (addon: string) => Shim
  log?: (level: 'info' | 'warn', message: string) => void
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
      return true
    }
    log('warn', `updates unavailable: Sparkle refused to start (${rc}): ${shim.lastError()}. Story keeps working; no update was fetched.`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log('warn', `updates unavailable: the updater at ${addon} could not be loaded: ${reason}. Story keeps working; no update was fetched.`)
  }
  return false
}
