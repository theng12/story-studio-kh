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
 *    check its signed size and sha256 before anything else touches it. A ~240 MB file does not
 *    fit in one check over a slow link, so a partial download is RESUMED with `Range`/`If-Range`
 *    across checks (see `download`) — but only the transfer resumes: the digest is always checked
 *    over the whole file, and a partial or unverified file is never installed.
 * 3. **Stage** it: extract the .app (DMG via a read-only mount, or a .zip), strip
 *    `com.apple.quarantine` defensively (a file Story writes itself is not quarantined: only apps
 *    with `LSFileQuarantineEnabled`, such as browsers, add it), check the bundle reports the signed
 *    version and passes `codesign --verify`.
 * 4. **Install promptly** (owner, 2026-10-09: "please force all future updates so we don't have to
 *    wait"; this replaced 1.4.261's wait for an empty queue). Work resumes after a restart: Video
 *    Assembly from its saved segments (1.4.265), the other resumable jobs through the boot scan.
 *    So once the release is staged and the boot scan has loaded the saved jobs (`loaded`), the
 *    updater pauses new intake (a queue-origin pause; jobs the owner paused stay paused) and waits
 *    only for (a) Gateway submissions already sent to be answered, so each has the task id it is
 *    recovered by (`inFlightSubmits`, at most SUBMIT_SETTLE_MS), (b) running jobs a restart
 *    would NOT continue (`wouldNotResume`, the boot scan's own rule), which are never interrupted,
 *    (c) final checks still measuring a finished video (`runningFinalChecks`) — local ffmpeg work a
 *    restart kills mid-decode, so the verdict would never be written — and (d) the one non-queue
 *    maintenance operation holding the Mac (Free up space, Clear Uploaded Videos), which a restart
 *    also kills mid-file and cannot resume. Then it installs.
 *    (d) is waited for WITHOUT the drain, though: it can run for hours (an all-channel Free up space
 *    of 162,058 images took ~9 h on 2026-10-19/20), and pausing the queue for its whole length stops
 *    every job on the Mac for an install that can do nothing but wait. So while one is running the
 *    release stays staged (`ready`), the queue keeps running, and `status()` reports the wait in
 *    plain words (`maintenance_running`); the drain — the pause, and the refusal of new operations —
 *    is claimed only once no operation is running. While the
 *    drain is claimed no NEW maintenance operation may start, so the check above cannot be overtaken
 *    by work begun a moment before the quit. A queue the owner paused himself is his: the update
 *    waits for him to resume
 *    it or press Install Now. If he presses Resume during the wait, his choice wins: the update
 *    waits for Install Now. **Install Now** takes the same path but goes ahead after 30 minutes
 *    even if a job that cannot resume is still running — never for (d): that ceiling is for work the
 *    boot scan picks up, and only **Install now (don't wait)** below may cut a cleanup short.
 *    **Install now (don't wait)** (`immediate`) pauses intake and installs at once, interrupting
 *    running jobs: the boot scan resumes what it can, retries free work, and leaves paid work that
 *    cannot resume for Retry.
 * 5. **Swap** with a detached helper (`helperScript`) after this app quits normally: the installed
 *    bundle goes to `<data>/previous-apps/`; the new one moves into place, and the app is relaunched
 *    (through the login agent when it is installed, so it stays supervised). Story keeps the last
 *    two previous versions there and MOVES older ones into Story's Trash
 *    (`<Library>/_trash/_story-studio/app/`, `keepPreviousApps`); download leftovers go to
 *    `_story-studio/app-update/`. Owner, 2026-10-16: nothing here deletes anything; the owner frees
 *    the space from Story → Trash. (This replaced 1.4.261's self-emptying 15-day Trash Folder,
 *    whose contents `migrateTrashFolder` moves into Story's Trash once.)
 * 6. **Health**: the new version reports `installed` here once it has booted and answered its own
 *    `/api/health`; the helper waits for that and otherwise puts the old app back.
 *
 * Every step writes `state.json`, which the Settings card, the banner and the check-in all read.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { promisify } from 'node:util'

import { machineName, STORY_CALLER } from '../lib/machine-name.js'
import { isServerMode, resolveAppSettingsPath } from '../lib/server-mode.js'
import { APP_TRASH, libraryTrashDir, moveToTrashSync } from '../lib/trash-move.js'

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
  /** True only when THIS updater paused the queue; display only — the release is authorized by `pause_owner_token`, never by this flag. */
  we_paused?: boolean
  /**
   * The durable token (services/job-queue.ts) that holds the queue pause this updater took. This —
   * not `we_paused` — authorizes `releaseOurPause`: the token is checked against the pause actually
   * in force, so a stale flag (an owner Resume then his own re-pause) can never lift the owner's
   * hold. Null once released, or never set by a build from before the owner existed.
   */
  pause_owner_token?: string | null
  drain_started_at?: number | null
  install_requested?: boolean
  /**
   * The owner pressed "Install now (don't wait)": install as soon as staged, without draining.
   * Standing intent like `install_requested`: a request recorded while one release downloads
   * installs the next offered release immediately, without a second confirmation.
   */
  immediate?: boolean
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
/** How often a staged update looks again while the owner's own queue pause holds it. */
export const IDLE_POLL_MS = 30_000
// ponytail: one fixed bound; a submission answers in seconds, and boot recovery reconciles a later one by its key.
export const SUBMIT_SETTLE_MS = 2 * 60_000
const HEALTH_SECONDS = 300
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

// ── Paths ──────────────────────────────────────────────────────────────────

export function dataDir(): string { return path.dirname(resolveAppSettingsPath()) }
export function updateDir(): string { return path.join(dataDir(), 'app-update') }
export function trashDir(): string { return path.join(dataDir(), '_trash') }
/** 1.4.261's self-emptying Trash Folder: retired; read only by `migrateTrashFolder`. */
export function trashFolder(): string { return path.join(dataDir(), 'Trash Folder') }
/** Where the swap helper keeps the replaced app (and a failed new one): same volume as the data folder. */
export function previousAppsDir(): string { return path.join(dataDir(), 'previous-apps') }
export const PREVIOUS_APPS_KEPT = 2

/**
 * Keep the last PREVIOUS_APPS_KEPT previous app versions; MOVE every older copy, and every failed
 * new one, into Story's Trash. Copies the helper left beside the app (`.Story Studio KH.app-…`,
 * when `previous-apps` is on another volume than the app) count too. The running app (`appBundle`,
 * or the copy `process.execPath` is inside) is never moved. Never deletes.
 */
export async function keepPreviousApps(appBundle?: string): Promise<string[]> {
  const copies: Array<{ path: string; version: string; failed: boolean }> = []
  const scan = (dir: string, pattern: RegExp) => {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const match = pattern.exec(name)
      if (match) copies.push({ path: path.join(dir, name), version: match[1]!, failed: name.includes('-failed-') })
    }
  }
  scan(previousAppsDir(), /^Story Studio KH\.app-(\d+(?:\.\d+)*)/)
  if (appBundle) scan(path.dirname(appBundle), /^\.Story Studio KH\.app-(\d+(?:\.\d+)*)-(?:previous|failed-)/)
  const kept = copies.filter(copy => !copy.failed)
    .sort((a, b) => compareVersions(b.version, a.version) || b.path.localeCompare(a.path))
    .slice(0, PREVIOUS_APPS_KEPT)
  const running = (p: string) => (!!appBundle && path.resolve(p) === path.resolve(appBundle))
    || path.resolve(process.execPath).startsWith(path.resolve(p) + path.sep)
  const moved: string[] = []
  for (const copy of copies) {
    if (kept.includes(copy) || running(copy.path)) continue
    try { await toTrash(copy.path, 'app'); moved.push(copy.path) } catch (error: any) {
      console.warn(`[app-update] left ${copy.path} in place: ${error?.message || error}`)
    }
  }
  return moved
}

/**
 * Retire the old `<data>/Trash Folder`: move each thing in it into Story's Trash
 * (`_story-studio/trash-folder/`), once. The old helper's rollback copies
 * (`<date>/app/Story Studio KH.app-*`) are previous versions, not Trash: they go to `previous-apps`
 * first (same volume), where `keepPreviousApps` keeps the last two; a day whose copy could not go
 * there stays put. Renames only, collision-safe names, nothing deleted; emptied folders are removed
 * only when empty, so a second run finds nothing.
 */
export async function migrateTrashFolder(): Promise<string[]> {
  const moved: string[] = []
  const root = trashFolder()
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (name === '.DS_Store') continue
    const day = path.join(root, name)
    const apps = path.join(day, 'app')
    let parked = true
    for (const app of fs.statSync(apps, { throwIfNoEntry: false })?.isDirectory() ? fs.readdirSync(apps) : []) {
      if (!app.startsWith('Story Studio KH.app-')) continue
      try {
        fs.mkdirSync(previousAppsDir(), { recursive: true })
        let to = path.join(previousAppsDir(), app)
        if (fs.existsSync(to)) to += `-${Date.now()}`
        fs.renameSync(path.join(apps, app), to)
      } catch (error: any) {
        parked = false
        console.warn(`[app-update] left ${path.join(apps, app)} in the old Trash Folder: ${error?.message || error}`)
      }
    }
    if (!parked) continue
    for (const dir of [apps, day]) { try { fs.rmdirSync(dir) } catch { /* not empty, or not there */ } }
    if (!fs.existsSync(day)) continue
    try { await toTrash(path.join(root, name), 'trash-folder'); moved.push(name) } catch (error: any) {
      console.warn(`[app-update] left ${path.join(root, name)} in the old Trash Folder: ${error?.message || error}`)
    }
  }
  try { fs.rmdirSync(root) } catch { /* not there, or something stayed */ }
  return moved
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
 * into the script. The replaced app and a failed new one go to `SU_KEEP` (`previous-apps`) by a
 * same-volume rename only, or wait beside the app when that folder is on another volume. The
 * helper never deletes anything; `keepPreviousApps` moves the surplus into Story's Trash.
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
[ -d "$SU_STAGED" ] && [ -n "$SU_KEEP" ] && [ -n "$SU_VERSION" ] || exit 2
log "update $SU_OLD_VERSION -> $SU_VERSION: waiting for pid $SU_PID to quit"
for _ in $(seq 1 "\${SU_QUIT_WAIT:-300}"); do kill -0 "$SU_PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$SU_PID" 2>/dev/null; then result failed "Story Studio did not quit, so nothing was replaced."; exit 1; fi

if ! mkdir -p "$SU_KEEP"; then result failed "Could not create $SU_KEEP; nothing was replaced."; relaunch; exit 1; fi
KEEP="$SU_KEEP/Story Studio KH.app-$SU_OLD_VERSION"
FAILED="$SU_KEEP/Story Studio KH.app-$SU_VERSION-failed-$(date +%Y%m%d%H%M%S)"
# A previous-apps folder on another volume than the app would make every mv here a multi-GB copy.
# Then the old app (and a failed new one) waits beside the target instead, hidden; it is never
# deleted here. Story moves it into its Trash once it is no longer one of the last two versions.
if [ "$(stat -f %d "$(dirname "$SU_TARGET")")" != "$(stat -f %d "$SU_KEEP")" ]; then
  KEEP="$(dirname "$SU_TARGET")/.Story Studio KH.app-$SU_OLD_VERSION-previous"
  FAILED="$(dirname "$SU_TARGET")/.Story Studio KH.app-$SU_VERSION-failed-$(date +%Y%m%d%H%M%S)"
  log "previous-apps is on another volume; the previous app stays at $KEEP"
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
    result installed "$SU_VERSION is running."; exit 0
  fi
  sleep 1
done

log "$SU_VERSION never reported healthy; putting $SU_OLD_VERSION back"
pkill -TERM -f "$SU_TARGET/Contents/MacOS/" 2>/dev/null
for _ in $(seq 1 60); do pgrep -f "$SU_TARGET/Contents/MacOS/" >/dev/null || break; sleep 1; done
pkill -KILL -f "$SU_TARGET/Contents/MacOS/" 2>/dev/null
if mv "$SU_TARGET" "$FAILED" && mv "$KEEP" "$SU_TARGET"; then
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

/**
 * Move something aside, never delete it: Story's one Trash (`<Library>/_trash/_story-studio/<bucket>`);
 * the app's own `_trash` only when the Library is on another drive (a rename never crosses drives).
 * Both record the move for Restore and never replace what is already there.
 */
async function toTrash(target: string, bucket: string): Promise<void> {
  if (!fs.existsSync(target)) return
  const { projectsRoot } = await import('./project-manager.js')
  try {
    moveToTrashSync(target, path.join(libraryTrashDir(projectsRoot()), APP_TRASH, bucket, path.basename(target)), bucket)
    return
  } catch (error: any) { if (error?.code !== 'EXDEV') throw error }
  moveToTrashSync(target, path.join(trashDir(), bucket, path.basename(target)), bucket)
}

// ── Runtime wiring ─────────────────────────────────────────────────────────

export interface QueueControl {
  isPaused(): boolean
  /** The token that holds the current pause, or null for the owner's own (unowned) pause. */
  pauseOwner(): string | null
  /** Take or confirm this updater's own hold; false when the pause is the owner's own. */
  acquirePause(token: string): Promise<boolean>
  /** Release this updater's own hold; false when the token no longer holds the pause. */
  releasePause(token: string): Promise<boolean>
  running(): number
  summary(): { running: number; queued: number; paused: number }
  /** False until the boot scan has loaded every channel's saved jobs; nothing is judged before that. */
  loaded?(): boolean
  /** Gateway submissions sent and not yet answered (lib/inflight-submits.ts). */
  inFlightSubmits?(): number
  /** Types of the running jobs a restart would not continue (job-queue `runningJobsThatWouldNotResume`). */
  wouldNotResume?(): Promise<string[]>
  /**
   * The one non-queue maintenance operation holding this Mac (episode-media-cleanup's registry:
   * Free up space, Clear Uploaded Videos), or null. A restart kills it mid-file and it cannot resume,
   * so an install waits for it exactly as it waits for a job that would not resume.
   */
  maintenance?(): { id: string; kind: string; status: string } | null
  /**
   * Final checks being measured right now (lib/final-video-check.ts's registry). Also not a queue
   * job — the on-demand check runs in the background — and a restart kills the ffmpeg decode mid-file
   * and loses the verdict it was about to write, so an install waits for it too.
   */
  runningFinalChecks?(): number
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
  /** Test hooks: the recheck while the owner's pause holds the update, the wait's poll, and the clock. */
  idlePollMs?: number
  drainPollMs?: number
  now?: () => number
  /** Test hook: the helper's relaunch command (`$1` is the app path). */
  relaunchCommand?: string
  helperEnv?: Record<string, string>
}

let opts: UpdaterOptions | null = null
let checking: Promise<UpdateState> | null = null
let drainTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
let quittingForUpdate = false
/** How long the quit is given before the hand-off is called off (`_setQuitDeadlineForTesting`). */
let quitDeadlineMs = 6 * 60_000
/**
 * The one in-flight install hand-off, set synchronously by `install()` before its first await.
 * Two callers race here — a drain tick suspended in `wouldNotResume`/`inFlightSubmits` and an
 * "Install now (don't wait)" press (or two presses) — and only the winner may spawn the helper or
 * patch the state, so the loser can neither start a second helper nor write `draining` over the
 * `installing` the winner committed.
 */
let installing: Promise<boolean> | null = null

/**
 * Live progress of the download in flight, for the Settings card — a ~240 MB file on a slow link
 * takes many checks, and without this the card can only say "downloading". In memory only: a
 * restart resumes the file and the count starts from the bytes on disk again.
 */
let progress: { downloaded: number; total: number } | null = null

/**
 * This process's queue-pause owner token. Minted once and persisted before the acquire is awaited,
 * so concurrent callers of one install attempt share the SAME token — the winner never lacks the
 * loser's claim, and a bare boolean never authorizes a release. Reset on release and on a fresh
 * process (a restart reads it back from `pause_owner_token`).
 */
let ourPauseToken: string | null = null

function ensurePauseToken(): string {
  if (!ourPauseToken) {
    const existing = readState().pause_owner_token
    const token = existing || randomUUID()
    if (!existing) patchState({ pause_owner_token: token })
    ourPauseToken = token
  }
  return ourPauseToken
}

function forgetPauseToken(): void {
  ourPauseToken = null
  if (readState().pause_owner_token) patchState({ pause_owner_token: null })
}

/** main.ts's quit path asks this so a "jobs are running, quit?" question never blocks an update. */
export function isQuittingForUpdate(): boolean { return quittingForUpdate }

/**
 * True while an install owns the Mac and will restart it: the drain has been claimed, or the swap
 * helper is already waiting for this process to quit. Non-queue work a restart would kill mid-file
 * asks this before starting, so it cannot begin in the window between the updater's "nothing is
 * running" check and its quit. The phase always moves on — `onBoot` settles a stale `draining` or
 * `installing` on the next launch — so this cannot wedge the Mac.
 */
export function isUpdateHoldingForRestart(): boolean {
  const phase = readState().phase
  return phase === 'draining' || phase === 'installing'
}

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
  let state = readState()
  // A hand install — or a later release landing first — leaves this state
  // describing an install that no longer has anything to do. Clear the request
  // flags and the stale error whatever the phase is, not only while `installing`:
  // `install_requested` makes EVERY later offer count as "asked" and so bypasses
  // the skip_signature/failed_signature guards for good, and the old error is
  // otherwise shown as if it described the running build.
  if (state.release && compareVersions(options.currentVersion, state.release.version) >= 0
    && (state.install_requested || state.immediate || state.error)) {
    state = patchState({ install_requested: false, immediate: false, error: null })
  }
  if (state.phase === 'downloading') return patchState({ phase: 'idle' })
  if (state.phase === 'draining') return patchState({ phase: 'ready', drain_started_at: null })
  if (state.phase !== 'installing' || !state.release) {
    if (state.pause_owner_token && ['installed', 'failed', 'rolled_back'].includes(state.phase)) await releaseOurPause()
    return readState()
  }
  const target = state.release.version
  if (options.currentVersion === target && await selfHealthy(options.port, target)) {
    const next = patchState({ phase: 'installed', installed_at: Date.now(), error: null, staged_app: null,
      install_requested: false, immediate: false, held: false })
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
    skip_signature: state.release.signature, install_requested: false, immediate: false, staged_app: null })
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

/**
 * Release the queue pause THIS updater took — and only that one. Authority is the durable owner
 * token (services/job-queue.ts), checked against the pause actually in force under the queue's own
 * lock; the bare `we_paused` flag is display only and never authorizes a release. So an owner
 * Resume followed by his own re-pause (which clears our token) can never be lifted here. A legacy
 * `we_paused` with no token proves nothing, so that hold is left standing (fail-safe) and reported
 * by `status()` rather than silently dropped.
 */
async function releaseOurPause(): Promise<void> {
  if (!opts) return
  const token = readState().pause_owner_token
  if (!token) return
  try { await opts.queue.releasePause(token) } catch (error: any) {
    patchState({ error: `The queue could not resume after the update: ${error?.message || error}. Press Resume to continue.` })
    return // Keep the claim: a failed settings write is not a released or superseded pause.
  }
  if (readState().pause_owner_token !== token) return
  ourPauseToken = null
  const error = readState().error
  patchState({ pause_owner_token: null, we_paused: false,
    ...(error?.startsWith('The queue could not resume after the update:') ? { error: null } : {}) })
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
      request_id: state.gateway_update_request_id ?? null,
      // The Gateway's fleet watchdog reads this to tell a download that is moving from one that has
      // stopped, and reports the difference to the owner. Absent while nothing is downloading, so
      // "no figure" stays distinguishable from "zero bytes".
      ...(progress ? { downloaded_bytes: progress.downloaded, total_bytes: progress.total } : {}) },
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
 * Download the whole file, RESUMING what a previous attempt left behind, and check its signed size
 * and sha256. The owner's link is a Tailscale relay at ~115 KB/s, so ~240 MB cannot finish inside
 * one check; without a resume every attempt restarted at byte zero and died at the same place.
 *
 * A `.part` shorter than the signed size is a prefix: it is hashed and the rest asked for with
 * `Range: bytes=<n>-` plus `If-Range: <sha256>`. The Gateway answers 206 for a prefix of THIS
 * artifact, 200 (the whole file) when the validator no longer matches a re-published artifact or it
 * has no ranges, and 416 when the part is at or past the end. A 200 replaces the part rather than
 * appending to it — two artifacts are never mixed — a 416 sends it to Trash, and an over-long or
 * complete-but-wrong part is started over the same way. Only the bytes are resumed: the signed size
 * and sha256 are still checked over the WHOLE file before it is renamed into place.
 *
 * The only clock here is inactivity: 30 s with no byte arriving aborts. There is deliberately no
 * wall-clock deadline, so a download that keeps moving is never killed for being slow. Every
 * failure means the file is not fully available yet (404, a short or still-uploading file, a
 * dropped connection): nothing is recorded as a failed install, and the next check tries again.
 */
async function download(release: ReleaseDescriptor, file: string): Promise<boolean> {
  const part = `${file}.part`
  const controller = new AbortController()
  let inactivity: ReturnType<typeof setTimeout> | undefined
  const progressing = () => {
    clearTimeout(inactivity)
    inactivity = setTimeout(() => controller.abort(), 30_000)
  }
  progressing()
  try {
    const { url, key } = await opts!.gateway()
    const f = opts!.fetch ?? fetch
    // Only a strict prefix of the signed size is worth resuming; anything else is replaced below.
    const before = fs.statSync(part, { throwIfNoEntry: false })?.size ?? 0
    const resumeAt = before > 0 && before < release.bytes ? before : 0
    const response = await f(`${url.replace(/\/+$/, '')}/v1/apps/story/release/file`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Caller': STORY_CALLER,
        ...(resumeAt ? { Range: `bytes=${resumeAt}-`, 'If-Range': release.sha256 } : {}) },
      signal: controller.signal,
    })
    if (response.status === 416) {
      // No body is read on this path: cancel it so its socket is released now
      // rather than held open with nothing draining it.
      await response.body?.cancel().catch(() => {})
      // The part is at or past the end of what the Gateway holds, so it cannot be a prefix of this
      // artifact: it goes to Story's Trash and the next check starts the file over from zero.
      await toTrash(part, 'app-update')
      throw new Error('the Gateway holds no bytes past the part already downloaded')
    }
    if (!response.ok || !response.body) {
      // Same: an error body is never read, and it must not keep a socket open.
      await response.body?.cancel().catch(() => {})
      throw new Error(`the Gateway answered ${response.status} to the download`)
    }
    const resuming = response.status === 206 && resumeAt > 0
    const hash = createHash('sha256')
    let size = 0
    if (resuming) {
      // Re-hash the prefix this part already holds: the digest below must cover the whole file.
      await pipeline(fs.createReadStream(part), new Transform({
        transform(chunk, _enc, done) { hash.update(chunk); size += chunk.length; done() },
      }))
    }
    if (progress) progress.downloaded = size
    await pipeline(Readable.fromWeb(response.body as any), new Transform({
      transform(chunk, _enc, done) {
        progressing(); hash.update(chunk); size += chunk.length
        if (progress) progress.downloaded = size
        done(null, chunk)
      },
    }), fs.createWriteStream(part, { flags: size ? 'a' : 'w' }), { signal: controller.signal })
    if (size !== release.bytes || hash.digest('hex') !== release.sha256) {
      throw new Error('the downloaded file does not match the signed release yet')
    }
    await fsp.rename(part, file)
    return true
  } catch (e: any) {
    patchState({ phase: 'idle', staged_app: null,
      error: `${release.version} is not fully available yet (${String(e?.message || e)}); trying again at the next check.` })
    return false
  } finally {
    clearTimeout(inactivity)
    progress = null
  }
}

async function stage(release: ReleaseDescriptor, requestId: string | null = null): Promise<void> {
  const dir = path.join(updateDir(), 'staging', release.version)
  // ~240 MB may take many checks on a slow link, so the staging dir — and the `.part` inside it —
  // is KEPT while it belongs to this same release (same signed sha256) and trashed only when a
  // different release replaces it. What is kept here is a partial download, never an install:
  // nothing is extracted, verified or renamed into place until the whole file's sha256 matches.
  if (readState().release?.sha256 !== release.sha256) await toTrash(dir, 'app-update')
  await fsp.mkdir(dir, { recursive: true })
  patchState({ phase: 'downloading', release, error: null, staged_app: null, held: false,
    gateway_update_request_id: requestId })
  const file = path.join(dir, release.filename)
  progress = { downloaded: 0, total: release.bytes }
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
 * What a prompt install is still waiting for: submissions in flight, running jobs that would not
 * resume, final checks still measuring a finished video, and the one non-queue maintenance operation
 * a restart would kill mid-file. The maintenance entry is passed through as it is — the words for it
 * belong with the other words, in the UI.
 */
async function waitingFor(queue: QueueControl): Promise<{
  submits: number
  jobs: string[]
  finalChecks: number
  maintenance: { id: string; kind: string; status: string } | null
}> {
  return {
    submits: queue.inFlightSubmits?.() ?? 0,
    // A queue without the boot rule (tests, older wiring) waits for every running job, as Install Now did.
    jobs: queue.wouldNotResume ? await queue.wouldNotResume() : Array<string>(queue.running()).fill('job'),
    finalChecks: queue.runningFinalChecks?.() ?? 0,
    maintenance: queue.maintenance?.() ?? null,
  }
}

/**
 * A staged release installs promptly (see 4. at the top): automatically once the saved jobs are
 * loaded and the owner has not paused the queue himself; at once on Install Now. Both pause new
 * intake and wait in `watchDrain`.
 */
export async function maybeInstall(): Promise<void> {
  const o = opts!
  const state = readState()
  if (state.phase !== 'ready' && state.phase !== 'draining') return
  const before = readState()
  let claimed = before.phase === 'draining'
  if (before.phase === 'ready') {
    if (!before.install_requested) {
      const settings = await o.getSettings()
      if (!settings.auto_install || before.held) return
      if (o.queue.loaded?.() === false) return watchIdle()
    }
    // A maintenance operation holding this Mac (Free up space, Clear Uploaded Videos) is waited for
    // WITHOUT the drain: pausing the queue on its behalf stops every job on the Mac for the whole
    // run — ~9 hours on 2026-10-19/20, for an install that could do nothing but wait. So the release
    // stays staged (`ready`) and the queue keeps running; the drain below is claimed — the pause
    // taken, new operations refused — only once nothing is holding the Mac. `status()` reports the
    // wait meanwhile, so it is never unexplained. "Install now (don't wait)" skips this: it
    // interrupts the operation deliberately.
    if (!before.immediate && o.queue.maintenance?.()) return watchIdle()
    // Take or confirm the updater's own hold on the queue, under the queue's own lock. Ownership
    // is proven by a durable token, never by a bare boolean: the token is minted and persisted
    // before the await so a concurrent caller shares it, and a foreign hold — the owner's own
    // pause — refuses the acquire (no write).
    let wePaused: boolean
    if (o.queue.isPaused()) {
      // Already held: ours only if the queue's own record still names our token. The owner's own
      // pause, or a token an owner Resume invalidated, is his — not ours to release.
      const token = before.pause_owner_token
      wePaused = !!token && o.queue.pauseOwner?.() === token
    } else {
      wePaused = await o.queue.acquirePause(ensurePauseToken())
      if (!wePaused) forgetPauseToken()
    }
    if (!wePaused && !before.install_requested) {
      // The owner's own pause holds an automatic install until he Resumes or presses Install Now.
      return watchIdle()
    }
    // Anything the awaits above suspended through may have moved this release on (a second press, a
    // drain tick, an install): only the caller that still sees the same state may claim the drain.
    // A caller sent home here already recorded its token above, so `releaseOurPause` still knows the
    // pause was ours — no separate boolean needs writing.
    const now = readState()
    if (now.phase !== 'ready' || now.drain_started_at !== before.drain_started_at) return
    if (wePaused && (!o.queue.isPaused() || o.queue.pauseOwner?.() !== now.pause_owner_token)) {
      holdAfterOwnerChange()
      return
    }
    if (now.held) return
    // The look above and this write are not one step: `acquirePause` suspends, and an operation
    // begun in that window would be waited for by a drain that has already paused the queue — the
    // very thing the look prevents. `beginOperation` (episode-media-cleanup) refuses on the phase,
    // so an operation is either visible to the look below or refused after the write; the two run
    // in one turn with no await between them, which is what makes that true.
    if (!before.immediate && o.queue.maintenance?.()) {
      await releaseOurPause()
      patchState({ phase: 'ready', drain_started_at: null })
      return watchIdle()
    }
    patchState({ phase: 'draining', drain_started_at: o.now?.() ?? Date.now(), we_paused: wePaused })
    claimed = true
  }
  // Install now (don't wait): intake is paused above, running jobs are left to the boot scan. The
  // promise is claimed before this function yields again, so an overlapping press, or the drain
  // tick below, cannot start a second helper or write `draining` over the `installing` it commits.
  if (readState().immediate && !installing) {
    installing = install().catch(e => { installing = null; markFailed(e); return false })
  }
  if (installing) return
  if (claimed) watchDrain()
}

function watchIdle(): void {
  if (idleTimer) return
  idleTimer = setTimeout(() => { idleTimer = null; void maybeInstall().catch(() => {}) }, opts?.idlePollMs ?? IDLE_POLL_MS)
  idleTimer.unref?.()
}

function holdAfterOwnerChange(): void {
  ourPauseToken = null
  patchState({ phase: 'ready', held: true, we_paused: false, pause_owner_token: null,
    install_requested: false, immediate: false, drain_started_at: null })
}

function watchDrain(): void {
  if (drainTimer) return
  const tick = async () => {
    drainTimer = null
    const o = opts!
    const state = readState()
    if (state.phase !== 'draining') return
    if ((state.pause_owner_token || state.we_paused)
      && (!o.queue.isPaused() || o.queue.pauseOwner?.() !== state.pause_owner_token)) {
      holdAfterOwnerChange()
      return
    }
    const waited = (o.now?.() ?? Date.now()) - (state.drain_started_at || 0)
    const left = await waitingFor(o.queue)
    const submitsSettled = left.submits === 0 || waited > SUBMIT_SETTLE_MS
    const ownerOverride = !!state.install_requested && waited > DRAIN_TIMEOUT_MS
    // Work a restart would throw away: jobs that cannot pick up where they stopped, and final checks
    // still decoding a finished video (their verdict is written at the end). Both are bounded by the
    // ffmpeg watchdogs, so this is not a forever-wait, and both take the same 30-minute override
    // below on an explicit Install Now.
    const workSettled = left.jobs.length === 0 && left.finalChecks === 0
    // The maintenance term is deliberately OUTSIDE the override's OR: the 30-minute ceiling exists
    // for work the boot scan picks up again, and a cleanup is killed mid-file by a restart. So a
    // normal install — including the Gateway's remote "Update now" and the owner's own Install Now —
    // never interrupts one, however long it runs. Only "Install now (don't wait)", which bypasses
    // this drain entirely, may cut it short.
    if (!left.maintenance && ((submitsSettled && workSettled) || ownerOverride)) {
      // Re-read after the awaits above: an "Install now (don't wait)" press (or another tick) may
      // have moved this release to `installing` or `failed` while this tick was asking the queue,
      // and a hand-off from here would be a second helper and a `draining` write over it.
      if (readState().phase !== 'draining') return
      if ((state.pause_owner_token || state.we_paused)
        && (!o.queue.isPaused() || o.queue.pauseOwner?.() !== state.pause_owner_token)) {
        holdAfterOwnerChange()
        return
      }
      await install().catch(e => markFailed(e))
      return
    }
    drainTimer = setTimeout(() => { void tick() }, o.drainPollMs ?? DRAIN_POLL_MS)
    drainTimer.unref?.()
  }
  drainTimer = setTimeout(() => { void tick() }, 0)
  drainTimer.unref?.()
}

/**
 * Owner's "Install Now": drain (whatever the window) and install. `immediately` skips the drain and
 * installs at once, or as soon as the release is staged.
 */
export async function installNow(immediately = false): Promise<UpdateState> {
  patchState({ install_requested: true, held: false, immediate: immediately })
  const state = readState()
  if (state.phase === 'ready' || state.phase === 'draining') await maybeInstall()
  else await checkNow(true)
  return readState()
}

/** Hand over to the swap helper and quit. */
export async function install(): Promise<boolean> {
  const o = opts!
  const state = readState()
  if (!state.release || !state.staged_app || !fs.existsSync(state.staged_app)) {
    throw new Error('The staged update is missing; it is downloaded again on the next check.')
  }
  const script = path.join(updateDir(), 'swap-app.sh')
  fs.writeFileSync(script, helperScript(), { mode: 0o755 })
  // The hand-off clears the display flag but KEEPS the owner token: a new build releases via the
  // token, while a build from before the token existed reads `we_paused` false and so cannot lift a
  // pause the owner set himself (bounded rollback mitigation). A genuinely updater-paused queue
  // then stays paused for the owner to Resume — the safe direction, documented in the handoff.
  writeState({ ...state, phase: 'installing', from_version: o.currentVersion, error: null, installing_at: Date.now(), we_paused: false })
  const child = spawn('/bin/bash', [script], {
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: os.homedir(),
      SU_PID: String(process.pid),
      SU_TARGET: o.appBundle,
      SU_STAGED: state.staged_app,
      SU_KEEP: previousAppsDir(),
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
    // Nothing was replaced and this process is still here (a `will-prevent-unload` veto aborts the
    // quit), so the claim is free again: a later press, or the next automatic attempt, may hand off.
    installing = null
    markFailed('Story Studio did not quit for the update; nothing was replaced.')
    void releaseOurPause()
  }, quitDeadlineMs).unref()
  return true
}

let timer: NodeJS.Timeout | null = null
/** Boot settle, a check-in shortly after startup, then every 30 minutes (and on Check Now). */
export async function startAppUpdater(options: UpdaterOptions): Promise<void> {
  const booted = await onBoot(options)
  // Once per launch (after an install too): moves only, never on a timer. Not after a failed boot: the
  // previous build's helper may still roll back from its KEEP copy in the Trash Folder.
  if (booted.phase !== 'failed') await migrateTrashFolder().catch(error => console.warn('[app-update] Trash Folder migration:', error))
  await keepPreviousApps(options.appBundle).catch(error => console.warn('[app-update] previous apps:', error))
  const tick = () => { void checkNow() }
  setTimeout(tick, 15_000).unref()
  timer = setInterval(tick, CHECK_INTERVAL_MS)
  timer.unref()
}

/** Settings card: state, settings and the pinned key's fingerprint. */
export async function status(): Promise<Record<string, unknown>> {
  const settings = opts ? await opts.getSettings() : defaultSettings(null)
  const state = readState()
  const { trusted_publisher_key, ...rest } = settings
  const queuePaused = opts ? opts.queue.isPaused() : false
  const ownedByUs = !!state.pause_owner_token && opts?.queue.pauseOwner?.() === state.pause_owner_token
  return {
    enabled: !!opts,
    current_version: opts?.currentVersion ?? null,
    machine: machineName(),
    ...(progress ? { downloaded_bytes: progress.downloaded, total_bytes: progress.total } : {}),
    ...state,
    settings: rest,
    jobs_left: opts ? jobsLeft(opts.queue) : 0,
    // Not a queue job (the on-demand final check runs in the background), so it is never folded into
    // `jobs_left`: one number must not mean two things. It still holds an install, and this says how
    // many are doing it.
    final_checks_running: opts ? (opts.queue.runningFinalChecks?.() ?? 0) : 0,
    // The one non-queue operation holding this Mac (Free up space, Clear Uploaded Videos). While it
    // runs the release stays STAGED and the queue keeps running — the drain is claimed only once it
    // is gone (see `maybeInstall`) — so the wait is reported here and not only inside `waiting_for`,
    // which is the drain's own list.
    maintenance_running: opts ? (opts.queue.maintenance?.() ?? null) : null,
    queue_paused: queuePaused,
    // The queue is still paused and this update is not holding it (a legacy `we_paused`, or a token
    // an owner Resume invalidated): computed live, so it never lingers once the owner Resumes.
    pause_recovery_note: queuePaused && ((state.error?.startsWith('The queue could not resume after the update:'))
      || (!ownedByUs && (state.we_paused === true || !!state.pause_owner_token)))
      ? 'The queue is still paused; press Resume to continue.'
      : null,
    waiting_for: opts && state.phase === 'draining' ? await waitingFor(opts.queue) : null,
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
  if (timer) clearInterval(timer)
  timer = null
  quittingForUpdate = false
  installing = null
  ourPauseToken = null
  progress = null
  quitDeadlineMs = 6 * 60_000
}
export function _configureForTesting(options: UpdaterOptions): void { opts = options }
/** Test seam for the quit deadline (the 6-minute timer that calls the hand-off off). */
export function _setQuitDeadlineForTesting(ms: number): void { quitDeadlineMs = ms }

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
