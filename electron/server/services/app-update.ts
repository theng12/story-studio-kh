/**
 * Remote updates for Story Studio, the way the Gateway updates Studio Hub.
 *
 * The owner's pain (2026-10-07): every update was a walk to the Mac mini, a DMG, and
 * `xattr -d com.apple.quarantine` by hand. Now:
 *
 * 1. **Check in** every 30 minutes (at startup, and on "Check Now") with the Gateway this app already uses,
 *    on the same key: `POST /v1/apps/story/checkin` reports this Mac's version, channels, queue
 *    and update phase, and answers with the signed release plus any "Update now" the admin pressed.
 * 2. **Verify** the release's Ed25519 signature against the publisher key this Mac pinned the
 *    first time it saw one (and that pin never changes silently), then download the file and
 *    check its signed size and sha256 before anything else touches it.
 * 3. **Stage** it: extract the .app (DMG via a read-only mount, or a .zip), strip
 *    `com.apple.quarantine` defensively (a file Story writes itself is not quarantined: only apps
 *    with `LSFileQuarantineEnabled`, such as browsers, add it), check the bundle reports the signed
 *    version and passes `codesign --verify`.
 * 4. **Wait for an empty queue** (owner, 2026-10-08): an automatic install pauses nothing. It waits,
 *    with no time limit, until no job is running, queued or paused (`jobsLeft`), rechecking every
 *    30 seconds, and installs once the queue has stayed empty for a minute (a pipeline's next step
 *    lands in that gap), checking once more right before the swap. A queue the owner paused while
 *    it still holds jobs keeps it waiting. **Install Now** drains instead, the same policy as
 *    `scripts/release/install-local.sh`: pause the queue (a queue-origin pause; jobs the owner
 *    paused stay paused, and a queue he had already paused is left as his), let running work finish
 *    or reach its safe point, up to 30 minutes, then install. If he presses Resume during the drain,
 *    his choice wins: the update waits for Install Now.
 * 5. **Swap** with a detached helper (`helperScript`) after this app quits normally: the installed
 *    bundle goes to the self-emptying Trash Folder, `<data>/Trash Folder/<UTC date>/app/`, which
 *    Story deletes 15 days later (`purgeTrashFolder`, as Studio Hub does); the new one moves into
 *    place, and the app is relaunched (through the login agent when it is installed, so it stays
 *    supervised). `<data>/_trash` stays the owner's: nothing there is ever deleted.
 * 6. **Health**: the new version reports `installed` here once it has booted and answered its own
 *    `/api/health`; the helper waits for that and otherwise puts the old app back.
 *
 * Every step writes `state.json`, which the Settings card, the banner and the check-in all read.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { promisify } from 'node:util'

import { machineName, STORY_CALLER } from '../lib/machine-name.js'
import { isServerMode, resolveAppSettingsPath } from '../lib/server-mode.js'

const run = promisify(execFile)

export type UpdatePhase =
  'idle' | 'downloading' | 'ready' | 'draining' | 'installing' | 'installed' | 'rolled_back' | 'failed'

export interface ReleaseDescriptor {
  schema: string
  schema_version: number
  app: string
  version: string
  build: string
  filename: string
  bytes: number
  sha256: string
  published_at: number
  publisher_id: string
  publisher_key_id: string
  signature: string
}

export interface UpdateSettings {
  auto_install: boolean
  /** The publisher key pinned on first sight (base64 of the raw 32 bytes). */
  trusted_publisher_key?: string
}

export interface UpdateState {
  phase: UpdatePhase
  release?: ReleaseDescriptor | null
  staged_app?: string | null
  error?: string | null
  /** True only when THIS updater paused the queue; only then does it resume it. */
  we_paused?: boolean
  drain_started_at?: number | null
  install_requested?: boolean
  /** Gateway manual command acknowledged only once its verified attempt actually starts. */
  gateway_update_request_id?: string | null
  /** The owner pressed Resume during a drain: no automatic install of this release. */
  held?: boolean
  from_version?: string | null
  /**
   * The signature of a release that started here and then failed its health check (rolled back):
   * never installed again automatically. A re-publish carries a new signature and is tried.
   */
  skip_signature?: string | null
  /**
   * The signature of a release whose install failed for another reason (extraction, bundle check,
   * the swap). Keyed by signature, not build, so a re-publish heals it at once; the same release
   * is tried again automatically after FAILED_RETRY_AFTER_MS (the Hub's by-build memory never
   * retried until relaunch and stalled a fleet group).
   */
  failed_signature?: string | null
  failed_at?: number | null
  last_check_at?: number | null
  last_check_error?: string | null
  installed_at?: number | null
  installing_at?: number | null
}

export const RELEASE_SCHEMA = 'storystudio.app-release.v1'
export const AGENT_LABEL = 'local.storystudio.kh'
const SETTINGS_KEY = 'app_update'
export const CHECK_INTERVAL_MS = 30 * 60_000
/** An install that failed (not a rollback) is tried again automatically after about two checks. */
export const FAILED_RETRY_AFTER_MS = 2 * CHECK_INTERVAL_MS
// ponytail: one fixed drain ceiling (install-local.sh's default); make it a setting if 30 min is wrong.
export const DRAIN_TIMEOUT_MS = 30 * 60_000
const DRAIN_POLL_MS = 5_000
export const IDLE_POLL_MS = 30_000
/** The queue must stay empty this long, so the gap between two pipeline steps is not "idle". */
export const IDLE_SETTLE_MS = 60_000
const HEALTH_SECONDS = 300
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

// ── Paths ──────────────────────────────────────────────────────────────────

export function dataDir(): string { return path.dirname(resolveAppSettingsPath()) }
export function updateDir(): string { return path.join(dataDir(), 'app-update') }
export function trashDir(): string { return path.join(dataDir(), '_trash') }
/** The self-emptying Trash Folder (Studio Hub's pattern): dated `<UTC date>/` folders, deleted after 15 days. */
export function trashFolder(): string { return path.join(dataDir(), 'Trash Folder') }
export const TRASH_FOLDER_DAYS = 15
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** Where the swap helper keeps the replaced app (and a failed new one) today. */
export function appTrashDir(now = Date.now()): string { return path.join(trashFolder(), utcDate(now), 'app') }

/**
 * The one hard delete in Story Studio: dated Trash Folder subfolders older than 15 days (a folder
 * named for exactly 15 days ago is kept, as in the Hub). Only `YYYY-MM-DD` directories directly
 * inside the Trash Folder; anything else there, `_trash`, and everything outside are never touched.
 */
export async function purgeTrashFolder(now = Date.now()): Promise<string[]> {
  const oldestKept = utcDate(now - TRASH_FOLDER_DAYS * 86_400_000)
  const names = await fsp.readdir(trashFolder()).catch(() => [] as string[])
  const purged: string[] = []
  for (const name of names.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= oldestKept) continue
    const day = path.join(trashFolder(), name)
    if (!(await fsp.lstat(day).catch(() => null))?.isDirectory()) continue // never follows a symlink
    await fsp.rm(day, { recursive: true, force: true }).then(() => purged.push(name), () => {})
  }
  return purged
}
function statePath(): string { return path.join(updateDir(), 'state.json') }
function resultPath(): string { return path.join(updateDir(), 'helper-result.json') }

// ── Pure pieces (unit-tested) ──────────────────────────────────────────────

/** The bytes the Gateway signed: the flat descriptor without `signature`, keys sorted, no spaces. */
export function canonicalBytes(descriptor: Record<string, unknown>): Buffer {
  const body = Object.fromEntries(Object.keys(descriptor).filter(k => k !== 'signature').sort()
    .map(k => [k, descriptor[k]]))
  return Buffer.from(JSON.stringify(body), 'utf8')
}

export function fingerprint(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')
}

/** Throws a sentence naming what is wrong; returns the descriptor typed when it verifies. */
export function verifyRelease(value: unknown, publicKeyBase64: string): ReleaseDescriptor {
  const d = value as ReleaseDescriptor
  if (!d || typeof d !== 'object') throw new Error('The Gateway offered no release descriptor.')
  if (d.schema !== RELEASE_SCHEMA || d.app !== 'story') throw new Error('The release is not a Story Studio release.')
  if (!/^\d+(\.\d+)*$/.test(String(d.version))) throw new Error('The release has no usable version.')
  if (!/^[0-9a-f]{64}$/.test(String(d.sha256)) || !(Number(d.bytes) > 0)) throw new Error('The release has no usable digest.')
  if (typeof d.filename !== 'string' || !/^[A-Za-z0-9._ -]+\.(dmg|zip)$/i.test(d.filename)) {
    throw new Error('The release file name is not a .dmg or .zip.')
  }
  const raw = Buffer.from(publicKeyBase64 || '', 'base64')
  if (raw.byteLength !== 32) throw new Error('No trusted App Update Key.')
  if (d.publisher_key_id !== fingerprint(publicKeyBase64)) {
    throw new Error('The release was signed with a key this Mac does not trust.')
  }
  const signature = Buffer.from(String(d.signature || ''), 'base64')
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
  if (signature.byteLength !== 64 || !verify(null, canonicalBytes(d as unknown as Record<string, unknown>), key, signature)) {
    throw new Error('The release signature does not verify.')
  }
  return d
}

export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return Math.sign(diff)
  }
  return 0
}

/**
 * The detached swap helper. Inputs arrive as `SU_*` environment variables, so nothing is quoted
 * into the script. The replaced app and a failed new one go to `SU_TRASH` (today's Trash Folder),
 * by a same-volume rename only; see the one exception below for a Trash Folder on another volume.
 */
export function helperScript(): string {
  return `#!/bin/bash
# Story Studio update helper, written by app-update.ts. Swaps the .app once Story Studio has quit,
# relaunches it, and puts the old app back if the new one never reports healthy.
set -u
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$SU_LOG"; }
result() {
  printf '{"outcome":"%s","detail":"%s","at":%s}\\n' "$1" "$2" "$(date +%s)" > "$SU_RESULT.tmp" && mv "$SU_RESULT.tmp" "$SU_RESULT"
  log "$1: $2"
}
relaunch() {
  if [ -n "\${SU_RELAUNCH:-}" ]; then
    /bin/bash -c "$SU_RELAUNCH" _ "$SU_TARGET" >> "$SU_LOG" 2>&1 &
    return
  fi
  local plist="$HOME/Library/LaunchAgents/$SU_LABEL.plist"
  if [ -f "$plist" ]; then
    launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1
    launchctl kickstart "gui/$(id -u)/$SU_LABEL" >/dev/null 2>&1 && { log "relaunched by the login agent"; return; }
  fi
  env -u ELECTRON_RUN_AS_NODE open "$SU_TARGET" && log "relaunched with open"
}
healthy() {
  [ "$(plutil -extract phase raw -o - "$SU_STATE" 2>/dev/null)" = installed ] \\
    && [ "$(plutil -extract release.version raw -o - "$SU_STATE" 2>/dev/null)" = "$SU_VERSION" ]
}

case "$SU_TARGET" in *.app) ;; *) exit 2 ;; esac
[ -d "$SU_STAGED" ] && [ -n "$SU_TRASH" ] && [ -n "$SU_VERSION" ] || exit 2
log "update $SU_OLD_VERSION -> $SU_VERSION: waiting for pid $SU_PID to quit"
for _ in $(seq 1 "\${SU_QUIT_WAIT:-300}"); do kill -0 "$SU_PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$SU_PID" 2>/dev/null; then result failed "Story Studio did not quit, so nothing was replaced."; exit 1; fi

if ! mkdir -p "$SU_TRASH"; then result failed "Could not create $SU_TRASH; nothing was replaced."; relaunch; exit 1; fi
KEEP="$SU_TRASH/Story Studio KH.app-$SU_OLD_VERSION"
FAILED="$SU_TRASH/Story Studio KH.app-$SU_VERSION-failed-$(date +%Y%m%d%H%M%S)"
APART=
# ponytail: a Trash Folder on another volume than the app would make every mv here a multi-GB copy.
# Then, as the Hub installer does, the old app waits beside the target (same volume, still the rollback
# copy) and is deleted only once the new one reported healthy; a failed new one is deleted too.
# The single case where Story deletes an app without the 15 days; same-volume is the normal one.
if [ "$(stat -f %d "$(dirname "$SU_TARGET")")" != "$(stat -f %d "$SU_TRASH")" ]; then
  APART=1
  KEEP="$(dirname "$SU_TARGET")/.Story Studio KH.app-$SU_OLD_VERSION-previous"
  FAILED="$(dirname "$SU_TARGET")/.Story Studio KH.app-$SU_VERSION-failed-$(date +%Y%m%d%H%M%S)"
  log "the Trash Folder is on another volume; the previous app waits at $KEEP until $SU_VERSION is healthy"
fi
[ -e "$KEEP" ] && KEEP="$KEEP-$(date +%Y%m%d%H%M%S)"
if ! mv "$SU_TARGET" "$KEEP"; then
  result failed "Could not move the installed app aside (macOS may need App Management allowed for Story Studio KH); nothing was replaced."
  relaunch; exit 1
fi
if ! mv "$SU_STAGED" "$SU_TARGET"; then
  mv "$KEEP" "$SU_TARGET"
  result failed "Could not move the new app into place; the previous app is back."
  relaunch; exit 1
fi
log "swapped; the previous app is kept at $KEEP"
relaunch
for _ in $(seq 1 "\${SU_HEALTH_SECONDS:-${HEALTH_SECONDS}}"); do
  if healthy; then
    [ -n "$APART" ] && rm -rf "$KEEP" && log "removed the previous app at $KEEP (another volume than the Trash Folder)"
    result installed "$SU_VERSION is running."; exit 0
  fi
  sleep 1
done

log "$SU_VERSION never reported healthy; putting $SU_OLD_VERSION back"
pkill -TERM -f "$SU_TARGET/Contents/MacOS/" 2>/dev/null
for _ in $(seq 1 60); do pgrep -f "$SU_TARGET/Contents/MacOS/" >/dev/null || break; sleep 1; done
pkill -KILL -f "$SU_TARGET/Contents/MacOS/" 2>/dev/null
if mv "$SU_TARGET" "$FAILED" && mv "$KEEP" "$SU_TARGET"; then
  [ -n "$APART" ] && rm -rf "$FAILED"
  result rolled_back "$SU_VERSION did not start within \${SU_HEALTH_SECONDS:-${HEALTH_SECONDS}} seconds; $SU_OLD_VERSION is back."
else
  result failed "$SU_VERSION did not start and the previous app could not be put back; it is at $KEEP."
fi
relaunch
`
}

// ── State ──────────────────────────────────────────────────────────────────

export function readState(): UpdateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.phase === 'string') return parsed
  } catch { /* none yet */ }
  return { phase: 'idle' }
}

/** Atomic: the helper reads this file with `plutil` while the app may be writing it. */
export function writeState(next: UpdateState): UpdateState {
  fs.mkdirSync(updateDir(), { recursive: true })
  const tmp = `${statePath()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, statePath())
  return next
}

function patchState(patch: Partial<UpdateState>): UpdateState {
  return writeState({ ...readState(), ...patch })
}

/** Move something aside into `_trash/<bucket>/`, never delete it. */
async function toTrash(target: string, bucket: string): Promise<void> {
  if (!fs.existsSync(target)) return
  const dir = path.join(trashDir(), bucket)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.rename(target, path.join(dir, `${path.basename(target)}-${Date.now()}`))
}

// ── Runtime wiring ─────────────────────────────────────────────────────────

export interface QueueControl {
  isPaused(): boolean
  setPaused(paused: boolean): Promise<void>
  running(): number
  summary(): { running: number; queued: number; paused: number }
}

export interface UpdaterOptions {
  currentVersion: string
  /** `/Applications/Story Studio KH.app` — derived from the executable in main.ts. */
  appBundle: string
  /** This app's own HTTP port, for the post-install health check. */
  port: number
  quit(): void
  queue: QueueControl
  getSettings(): Promise<UpdateSettings>
  saveSettings(patch: Partial<UpdateSettings>): Promise<void>
  gateway(): Promise<{ url: string; key: string }>
  channels(): Promise<number | null>
  fetch?: typeof fetch
  /** Test hooks: the empty-queue recheck and settle times, and the clock they read. */
  idlePollMs?: number
  idleSettleMs?: number
  now?: () => number
  /** Test hook: the helper's relaunch command (`$1` is the app path). */
  relaunchCommand?: string
  helperEnv?: Record<string, string>
}

let opts: UpdaterOptions | null = null
let checking: Promise<UpdateState> | null = null
let drainTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
let idleSince: number | null = null
let quittingForUpdate = false

/** main.ts's quit path asks this so a "jobs are running, quit?" question never blocks an update. */
export function isQuittingForUpdate(): boolean { return quittingForUpdate }

export function defaultSettings(raw: unknown): UpdateSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<UpdateSettings>
  return {
    auto_install: v.auto_install !== false,
    ...(typeof v.trusted_publisher_key === 'string' ? { trusted_publisher_key: v.trusted_publisher_key } : {}),
  }
}

export async function loadSettingsFrom(get: (k: string) => Promise<unknown>): Promise<UpdateSettings> {
  return defaultSettings(await get(SETTINGS_KEY))
}
export const APP_UPDATE_SETTINGS_KEY = SETTINGS_KEY

/** Called once after the server listens: settle an install the previous run started. */
export async function onBoot(options: UpdaterOptions): Promise<UpdateState> {
  opts = options
  const state = readState()
  if (state.phase === 'downloading') return patchState({ phase: 'idle' })
  if (state.phase === 'draining') return patchState({ phase: 'ready', drain_started_at: null })
  if (state.phase !== 'installing' || !state.release) return state
  const target = state.release.version
  if (options.currentVersion === target && await selfHealthy(options.port, target)) {
    const next = patchState({ phase: 'installed', installed_at: Date.now(), error: null, staged_app: null,
      install_requested: false, held: false })
    await releaseOurPause()
    await toTrash(path.join(updateDir(), 'staging', target), 'app-update').catch(() => {})
    return next
  }
  let detail = `${target} did not start; ${options.currentVersion} is running.`
  try {
    // Only the helper's answer for THIS install (an older result file is left where it is).
    const result = JSON.parse(fs.readFileSync(resultPath(), 'utf8'))
    if (Number(result.at) * 1000 >= (state.installing_at || 0) - 1000 && result.detail) detail = result.detail
  } catch { /* no result */ }
  // It was installed and did not come up healthy: never this signature again automatically.
  const next = patchState({ phase: options.currentVersion === target ? 'failed' : 'rolled_back', error: detail,
    skip_signature: state.release.signature, install_requested: false, staged_app: null })
  await releaseOurPause()
  return next
}

async function selfHealthy(port: number, version: string): Promise<boolean> {
  const f = opts?.fetch ?? fetch
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const body = await (await f(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) })).json() as any
      if (body?.status === 'ok' && body.version === version && body.boot_complete) return true
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1_000))
  }
  return false
}

async function releaseOurPause(): Promise<void> {
  if (!opts || !readState().we_paused) return
  // Only a queue this updater paused is resumed; Resume releases only queue-origin pauses.
  if (opts.queue.isPaused()) await opts.queue.setPaused(false)
  patchState({ we_paused: false })
}

export async function report(): Promise<Record<string, unknown>> {
  const o = opts!
  const state = readState()
  return {
    instance_id: machineName(),
    machine: machineName(),
    version: o.currentVersion,
    channels: await o.channels().catch(() => null),
    queue: { ...o.queue.summary(), held: o.queue.isPaused() },
    update: { phase: state.phase, version: state.release?.version ?? null, error: state.error ?? null,
      request_id: state.gateway_update_request_id ?? null },
    server_mode: isServerMode(),
  }
}

/** One check-in: report, verify any newer release, stage it, maybe install. Never throws. */
export function checkNow(force = false): Promise<UpdateState> {
  if (!checking) {
    checking = checkInOnce(force).catch((e) => patchState({ last_check_error: String(e?.message || e) }))
      .finally(() => { checking = null })
  }
  return checking
}

async function checkInOnce(force: boolean): Promise<UpdateState> {
  const o = opts
  if (!o) return readState()
  const { url, key } = await o.gateway()
  if (!key) return patchState({ last_check_at: Date.now(), last_check_error: 'No Gateway API Key is set, so updates are not checked.' })
  const f = o.fetch ?? fetch
  const response = await f(`${url.replace(/\/+$/, '')}/v1/apps/story/checkin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'X-Caller': STORY_CALLER, 'Content-Type': 'application/json' },
    body: JSON.stringify(await report()),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) {
    return patchState({ last_check_at: Date.now(), last_check_error: 'This Gateway does not offer Story Studio updates yet.' })
  }
  if (!response.ok) throw new Error(`The Gateway answered ${response.status} to the update check.`)
  const offer = await response.json() as { release?: unknown; publisher?: { public_key_base64?: string }; update_now?: boolean; update_request_id?: string }
  patchState({ last_check_at: Date.now(), last_check_error: null })
  await handleOffer(offer, force)
  return readState()
}

export async function handleOffer(
  offer: { release?: unknown; publisher?: { public_key_base64?: string }; update_now?: boolean; update_request_id?: string },
  force = false,
): Promise<void> {
  const o = opts!
  const release = offer.release as ReleaseDescriptor | null | undefined
  if (!release || compareVersions(String(release.version), o.currentVersion) <= 0) return
  const before = readState()
  const asked = force || !!offer.update_now || !!before.install_requested
  // A release that rolled back here waits for the owner (or a re-publish: a new signature). A failed
  // install of this same signature is tried again after about two checks. A download that was not
  // ready records nothing, so the next check simply tries again.
  if (!asked && release.signature === before.skip_signature) return
  if (!asked && release.signature === before.failed_signature
    && Date.now() - (before.failed_at || 0) < FAILED_RETRY_AFTER_MS) return
  const settings = await o.getSettings()
  let trusted = settings.trusted_publisher_key
  const offered = offer.publisher?.public_key_base64 || ''
  if (!trusted) {
    // Pinned on first sight, over the Gateway connection this Mac already authenticates to. From
    // then on a different key is refused until the owner presses "Trust the new key".
    if (fingerprint(offered) !== release.publisher_key_id) throw new Error('The offered App Update Key does not match the release.')
    trusted = offered
    await o.saveSettings({ trusted_publisher_key: offered })
  }
  try {
    verifyRelease(release, trusted)
  } catch (e: any) {
    patchState({ error: e.message })
    throw e
  }
  if (offer.update_now) patchState({ install_requested: true, held: false })
  const state = readState()
  const requestId = offer.update_now && typeof offer.update_request_id === 'string'
    && /^[0-9a-f]{32}$/.test(offer.update_request_id) ? offer.update_request_id : null
  const sameRelease = state.release?.sha256 === release.sha256
  if (!sameRelease || !['ready', 'draining', 'installing'].includes(state.phase)) {
    if (state.phase === 'draining' || state.phase === 'installing') return
    await stage(release, requestId)
    if (readState().phase !== 'ready') return
  } else if (requestId && state.phase !== 'installing') {
    // An installing attempt keeps its own receipt; a later command belongs to the next attempt.
    patchState({ gateway_update_request_id: requestId })
  }
  await maybeInstall()
}

/** Record an install failure against the release's signature (see `failed_signature`). */
function markFailed(error: unknown): UpdateState {
  return patchState({ phase: 'failed', error: String((error as any)?.message || error),
    failed_signature: readState().release?.signature ?? null, failed_at: Date.now() })
}

/**
 * Download the whole file (the Gateway serves it without Range; any interruption starts again from
 * zero next time) and check its signed size and sha256. Every failure here means the file is not
 * fully available yet (404, a short or still-uploading file, a dropped connection): nothing is
 * recorded as a failed install, and the next check tries again.
 */
async function download(release: ReleaseDescriptor, file: string): Promise<boolean> {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 15 * 60_000)
  let inactivity: ReturnType<typeof setTimeout> | undefined
  const progressing = () => {
    clearTimeout(inactivity)
    inactivity = setTimeout(() => controller.abort(), 30_000)
  }
  progressing()
  try {
    const { url, key } = await opts!.gateway()
    const f = opts!.fetch ?? fetch
    const response = await f(`${url.replace(/\/+$/, '')}/v1/apps/story/release/file`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Caller': STORY_CALLER },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`the Gateway answered ${response.status} to the download`)
    const hash = createHash('sha256')
    let size = 0
    await pipeline(Readable.fromWeb(response.body as any), new Transform({
      transform(chunk, _enc, done) { progressing(); hash.update(chunk); size += chunk.length; done(null, chunk) },
    }), fs.createWriteStream(`${file}.part`), { signal: controller.signal })
    if (size !== release.bytes || hash.digest('hex') !== release.sha256) {
      throw new Error('the downloaded file does not match the signed release yet')
    }
    await fsp.rename(`${file}.part`, file)
    return true
  } catch (e: any) {
    patchState({ phase: 'idle', staged_app: null,
      error: `${release.version} is not fully available yet (${String(e?.message || e)}); trying again at the next check.` })
    return false
  } finally {
    clearTimeout(deadline)
    clearTimeout(inactivity)
  }
}

async function stage(release: ReleaseDescriptor, requestId: string | null = null): Promise<void> {
  const dir = path.join(updateDir(), 'staging', release.version)
  await toTrash(dir, 'app-update')
  await fsp.mkdir(dir, { recursive: true })
  patchState({ phase: 'downloading', release, error: null, staged_app: null, held: false,
    gateway_update_request_id: requestId })
  const file = path.join(dir, release.filename)
  if (!await download(release, file)) return
  try {
    const app = await extractApp(file, path.join(dir, 'app'))
    await checkBundle(app, release.version)
    patchState({ phase: 'ready', staged_app: app, failed_signature: null, failed_at: null })
  } catch (e) {
    markFailed(e)
    throw e
  }
}

/** The one .app inside a .dmg (read-only mount) or a .zip, copied out with `ditto`. */
export async function extractApp(file: string, into: string): Promise<string> {
  await fsp.mkdir(into, { recursive: true })
  if (/\.zip$/i.test(file)) {
    await run('/usr/bin/ditto', ['-x', '-k', file, into])
  } else {
    const mount = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-update-'))
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mount, file])
    try {
      const apps = (await fsp.readdir(mount)).filter(n => n.endsWith('.app'))
      if (apps.length !== 1) throw new Error('The disk image does not hold exactly one app.')
      await run('/usr/bin/ditto', [path.join(mount, apps[0]), path.join(into, apps[0])])
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {})
      await fsp.rmdir(mount).catch(() => {})
    }
  }
  const apps = (await fsp.readdir(into)).filter(n => n.endsWith('.app'))
  if (apps.length !== 1) throw new Error('The release does not hold exactly one app.')
  return path.join(into, apps[0])
}

/** No quarantine, the signed version, and a valid (ad-hoc) code signature — or refuse. */
export async function checkBundle(app: string, version: string): Promise<void> {
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {})
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
    path.join(app, 'Contents', 'Info.plist')])
  if (stdout.trim() !== version) throw new Error(`The downloaded app reports ${stdout.trim()}, not the signed ${version}.`)
  await verifyCodeSignature(app)
}

/**
 * `codesign --verify --deep --strict`, with one accepted outcome: a bundle that was never sealed.
 * Story's DMGs are built with `identity: null` (scripts/release/build-unsigned-dmg.mjs), so the
 * bundle has no signature of its own and its binaries carry only the linker's ad-hoc signature;
 * codesign reports exactly "code has no resources but signature indicates they must be present"
 * for that (measured on 1.4.257). Then the main executable must still be ad-hoc signed. Any other
 * failure — a sealed bundle whose files changed, a broken signature — refuses the update. The
 * byte-for-byte check is the signed sha256 of the download; this guards the bundle's own state.
 */
export async function verifyCodeSignature(app: string): Promise<void> {
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    return
  } catch (e: any) {
    const detail = String(e?.stderr || e?.message || e).trim()
    if (!/code has no resources but signature indicates they must be present/.test(detail)) {
      throw new Error(`The downloaded app's code signature does not verify: ${detail.slice(0, 300)}`)
    }
  }
  const { stdout: name } = await run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-',
    path.join(app, 'Contents', 'Info.plist')])
  const shown = await run('/usr/bin/codesign', ['-dv', path.join(app, 'Contents', 'MacOS', name.trim())])
    .then(r => r.stderr, (e: any) => String(e?.stderr || ''))
  if (!/Signature=adhoc/.test(shown)) {
    throw new Error('The downloaded app is unsigned: its main program carries no ad-hoc signature.')
  }
}

/**
 * Jobs still in the queue: running, queued (a quota wait included), or paused by the owner or the
 * queue. Housekeeping is never counted because none of it is a queue job: the YouTube status sync,
 * the digest scheduler, the episode-recovery recheck, quota rechecks and this updater's own check
 * all run on their own timers. (Retries that recovery queues are real work and do count.)
 */
export function jobsLeft(queue: QueueControl): number {
  const s = queue.summary()
  return s.running + s.queued + s.paused
}

/**
 * Automatic: install once the queue has been empty for IDLE_SETTLE_MS, pausing nothing; recheck
 * every IDLE_POLL_MS meanwhile. Install Now (`install_requested`): start or continue the drain.
 */
export async function maybeInstall(): Promise<void> {
  const o = opts!
  const state = readState()
  if (state.phase !== 'ready' && state.phase !== 'draining') return
  if (!state.install_requested && state.phase === 'ready') {
    const settings = await o.getSettings()
    if (!settings.auto_install || state.held) return
    const now = o.now?.() ?? Date.now()
    if (jobsLeft(o.queue) > 0) idleSince = null
    else idleSince ??= now
    if (idleSince === null || now - idleSince < (o.idleSettleMs ?? IDLE_SETTLE_MS)) return watchIdle()
    idleSince = null
    if (!await install('idle').catch(e => { markFailed(e); return true })) watchIdle()
    return
  }
  if (state.phase === 'ready') {
    let wePaused = !!state.we_paused
    if (!o.queue.isPaused()) {
      await o.queue.setPaused(true)
      wePaused = true
    }
    patchState({ phase: 'draining', drain_started_at: Date.now(), we_paused: wePaused })
  }
  watchDrain()
}

function watchIdle(): void {
  if (idleTimer) return
  idleTimer = setTimeout(() => { idleTimer = null; void maybeInstall().catch(() => {}) }, opts?.idlePollMs ?? IDLE_POLL_MS)
  idleTimer.unref?.()
}

function watchDrain(): void {
  if (drainTimer) return
  const tick = async () => {
    drainTimer = null
    const o = opts!
    const state = readState()
    if (state.phase !== 'draining') return
    if (state.we_paused && !o.queue.isPaused()) {
      // The owner pressed Resume: his choice wins until Install Now.
      patchState({ phase: 'ready', held: true, we_paused: false, install_requested: false, drain_started_at: null })
      return
    }
    const timedOut = Date.now() - (state.drain_started_at || 0) > DRAIN_TIMEOUT_MS
    if (o.queue.running() === 0 || timedOut) {
      await install().catch(e => markFailed(e))
      return
    }
    drainTimer = setTimeout(() => { void tick() }, DRAIN_POLL_MS)
    drainTimer.unref?.()
  }
  drainTimer = setTimeout(() => { void tick() }, 0)
  drainTimer.unref?.()
}

/** Owner's "Install Now": drain (whatever the window) and install. */
export async function installNow(): Promise<UpdateState> {
  patchState({ install_requested: true, held: false })
  const state = readState()
  if (state.phase === 'ready' || state.phase === 'draining') await maybeInstall()
  else await checkNow(true)
  return readState()
}

/** Hand over to the swap helper and quit. `idle`: false, and nothing happens, if a job sneaked in. */
export async function install(mode: 'idle' | 'drain' = 'drain'): Promise<boolean> {
  const o = opts!
  const state = readState()
  if (!state.release || !state.staged_app || !fs.existsSync(state.staged_app)) {
    throw new Error('The staged update is missing; it is downloaded again on the next check.')
  }
  // The last look before the swap; from here to the spawn nothing else runs.
  if (mode === 'idle' && jobsLeft(o.queue) > 0) return false
  const script = path.join(updateDir(), 'swap-app.sh')
  fs.writeFileSync(script, helperScript(), { mode: 0o755 })
  writeState({ ...state, phase: 'installing', from_version: o.currentVersion, error: null, installing_at: Date.now() })
  const child = spawn('/bin/bash', [script], {
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: os.homedir(),
      SU_PID: String(process.pid),
      SU_TARGET: o.appBundle,
      SU_STAGED: state.staged_app,
      SU_TRASH: appTrashDir(),
      SU_STATE: statePath(),
      SU_RESULT: resultPath(),
      SU_LOG: path.join(updateDir(), 'helper.log'),
      SU_VERSION: state.release.version,
      SU_OLD_VERSION: o.currentVersion,
      SU_LABEL: AGENT_LABEL,
      ...(o.relaunchCommand ? { SU_RELAUNCH: o.relaunchCommand } : {}),
      ...(o.helperEnv || {}),
    },
  })
  child.unref()
  quittingForUpdate = true
  setTimeout(() => o.quit(), 500)
  // If the quit never happens the helper gives up after 5 minutes; say so here too.
  setTimeout(() => {
    quittingForUpdate = false
    markFailed('Story Studio did not quit for the update; nothing was replaced.')
    void releaseOurPause()
  }, 6 * 60_000).unref()
  return true
}

let timer: NodeJS.Timeout | null = null
/** Boot settle, a check-in shortly after startup, then every 30 minutes (and on Check Now). */
export async function startAppUpdater(options: UpdaterOptions): Promise<void> {
  await onBoot(options)
  // The Trash Folder empties itself shortly after startup and on every check (it never throws).
  const tick = () => { void purgeTrashFolder(); void checkNow() }
  setTimeout(tick, 15_000).unref()
  timer = setInterval(tick, CHECK_INTERVAL_MS)
  timer.unref()
}

/** Settings card: state, settings and the pinned key's fingerprint. */
export async function status(): Promise<Record<string, unknown>> {
  const settings = opts ? await opts.getSettings() : defaultSettings(null)
  const state = readState()
  const { trusted_publisher_key, ...rest } = settings
  return {
    enabled: !!opts,
    current_version: opts?.currentVersion ?? null,
    machine: machineName(),
    ...state,
    settings: rest,
    jobs_left: opts ? jobsLeft(opts.queue) : 0,
    queue_paused: opts ? opts.queue.isPaused() : false,
    trusted_fingerprint: trusted_publisher_key ? fingerprint(trusted_publisher_key) : null,
    open_at_login: openAtLogin(),
  }
}

/** For tests: drop the module's wiring. */
export function _resetForTesting(): void {
  opts = null
  checking = null
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  idleSince = null
  if (timer) clearInterval(timer)
  timer = null
  quittingForUpdate = false
}
export function _configureForTesting(options: UpdaterOptions): void { opts = options }

// ── Open at Login (and come back after a crash) ────────────────────────────
//
// One per-user launchd agent does both, as Studio Hub's does: `RunAtLoad` starts Story Studio at
// login, and `KeepAlive { Crashed: true }` relaunches it only after a crash signal (SIGSEGV,
// SIGABRT, SIGTRAP — a V8 heap abort is one). A deliberate Quit exits 0 and a Force Quit or a
// macOS memory kill is SIGKILL; neither is a crash, so neither brings it back. Electron's
// `setLoginItemSettings` was the first idea, but a login item does nothing after a crash, which is
// why the Hub moved off `SMAppService` to this agent.

export function agentPlistPath(home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
}

export function agentPlist(executable: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(executable)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key><dict><key>STORY_STUDIO_LAUNCH_AGENT</key><string>1</string></dict>
</dict>
</plist>
`
}

export function openAtLogin(home = os.homedir()): boolean {
  return fs.existsSync(agentPlistPath(home))
}

/**
 * Turn it on: write the agent (never load it now — `RunAtLoad` would start a second copy; the next
 * login or an update relaunch loads it). Turn it off: move the file to `_trash`.
 */
export async function setOpenAtLogin(enabled: boolean, executable: string, home = os.homedir()): Promise<void> {
  const plist = agentPlistPath(home)
  if (enabled) {
    if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executable)) {
      throw new Error('Open at Login needs the installed app (this looks like a development run).')
    }
    await fsp.mkdir(path.dirname(plist), { recursive: true })
    await fsp.writeFile(plist, agentPlist(executable), { mode: 0o644 })
    return
  }
  // Not booted out: if this very process runs under the agent, bootout would stop it. The loaded
  // job lapses at logout; without the file nothing starts Story Studio at the next login.
  await toTrash(plist, 'launch-agent')
}
