/**
 * FFmpeg manager — resolves FFmpeg binary path, checks installation,
 * and downloads pre-built binaries if not found on the system.
 *
 * Resolution order:
 *   1. App user data directory ({userData}/ffmpeg/)
 *   2. System PATH (which ffmpeg)
 *   3. Not found → offer download
 */

import { existsSync, accessSync, constants as fsConstants } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { logLine } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const ROOT = path.resolve(__dirname, '..', '..', '..')

// ── Path Resolution ────────────────────────────────────────────────────────

function getUserDataDir(): string {
  // Test override takes precedence
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return process.env.STORY_STUDIO_DATA_DIR
  }
  try {
    const { app } = require('electron')
    return app.getPath('userData')
  } catch {
    // Not in Electron — use project root
    return ROOT
  }
}

function getFFmpegDir(): string {
  return path.join(getUserDataDir(), 'ffmpeg')
}

/** Cached resolved paths */
let _ffmpegPath: string | null = null
let _ffprobePath: string | null = null

// ── Install progress state ────────────────────────────────────────────────
//
// Held in memory so the frontend can poll GET /ffmpeg/install-progress
// while the synchronous POST /ffmpeg/install is still in flight. The
// progress callback inside downloadFFmpeg writes here on every phase
// transition; the polling endpoint reads these fields straight out.
//
// Idle is the default state. After a successful install, we keep the
// 'done' state around so a poll that lands AFTER the POST resolves
// still sees a sensible terminal state (rather than reverting to idle
// and confusing the UI).

export type InstallStatus = 'idle' | 'running' | 'done' | 'error'
export interface InstallProgressState {
  status: InstallStatus
  phase?: 'downloading' | 'extracting' | 'done' | 'error'
  /** 0-100 */
  percent: number
  message: string
  started_at?: number
  finished_at?: number
  error?: string
  result_path?: string
}

let _installState: InstallProgressState = { status: 'idle', percent: 0, message: '' }

export function getInstallProgressState(): InstallProgressState {
  return { ..._installState }
}

export function _resetInstallProgressState(): void {
  _installState = { status: 'idle', percent: 0, message: '' }
}

function setInstallProgress(patch: Partial<InstallProgressState>): void {
  _installState = { ..._installState, ...patch }
}

/** Mark the in-flight install as failed. Called by the route handler
 *  when downloadFFmpeg throws — the download function itself can't
 *  always settle the state cleanly because the throw bubbles up through
 *  the `phase` helper. Idempotent / safe to call multiple times. */
export function _markInstallError(message: string): void {
  setInstallProgress({
    status: 'error',
    phase: 'error',
    message: message || 'FFmpeg install failed',
    error: message || 'FFmpeg install failed',
    finished_at: Date.now(),
  })
}

/**
 * Common install locations on macOS/Linux/Windows.
 * GUI-launched Electron apps don't inherit the user's shell PATH,
 * so we must check these directly.
 */
function getCommonInstallPaths(binary: string): string[] {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const name = binary + suffix

  if (process.platform === 'darwin') {
    return [
      `/opt/homebrew/bin/${name}`,    // Apple Silicon Homebrew
      `/usr/local/bin/${name}`,       // Intel Homebrew / MacPorts
      `/usr/bin/${name}`,             // System (rare)
      `/opt/local/bin/${name}`,       // MacPorts
    ]
  } else if (process.platform === 'win32') {
    return [
      `C:\\Program Files\\ffmpeg\\bin\\${name}`,
      `C:\\ffmpeg\\bin\\${name}`,
      `${process.env.LOCALAPPDATA || ''}\\Programs\\ffmpeg\\bin\\${name}`,
    ].filter(Boolean)
  } else {
    return [
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
      `/opt/ffmpeg/bin/${name}`,
    ]
  }
}

/**
 * Path to a binary bundled inside the .app via electron-builder
 * `extraResources`. In production: `Contents/Resources/ffmpeg/{name}`.
 * In dev: `process.resourcesPath` points at the running Electron's
 * own resources/, NOT our project root, so this returns a path that
 * doesn't exist — the caller falls through to the next lookup step.
 *
 * Returns `null` when `process.resourcesPath` isn't defined (e.g. when
 * running the backend under tsx/node outside Electron — tests).
 */
function getBundledBinaryPath(binary: string): string | null {
  const root = process.resourcesPath
  if (!root || typeof root !== 'string') return null
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return path.join(root, 'ffmpeg', `${binary}${suffix}`)
}

/**
 * Get the path to ffmpeg binary. Checks in order:
 * 1. Cached path (if still valid)
 * 2. Custom path from app settings (user-configured or downloaded)
 * 3. Bundled binary inside the .app's Contents/Resources/ffmpeg/
 *    (universal2 — works on every Mac)
 * 4. App user data directory (auto-downloaded binary, fallback)
 * 5. Common system install locations (direct file checks)
 * 6. System PATH (via `which` — limited in GUI-launched apps)
 */
export async function getFFmpegPath(): Promise<string> {
  if (_ffmpegPath && existsSync(_ffmpegPath)) return _ffmpegPath

  // 1. Saved custom path
  const customPath = await getAppSetting('ffmpeg_path')
  if (customPath && existsSync(customPath)) {
    _ffmpegPath = customPath
    return customPath
  }

  // 2. Bundled binary that ships inside the .app — added to extraResources
  //    by electron-builder. `process.resourcesPath` points to
  //    Contents/Resources/ in production, and to {electron-install}/resources/
  //    in dev (where build/ffmpeg/ doesn't exist, so this no-ops and we
  //    fall through to the app-downloaded path). Bundled wins over the
  //    user-data download because the bundled build is always known-good
  //    universal2; a stale download might be the wrong arch or corrupted.
  const bundledBin = getBundledBinaryPath('ffmpeg')
  if (bundledBin && existsSync(bundledBin)) {
    _ffmpegPath = bundledBin
    return bundledBin
  }

  // 3. App-downloaded binary
  const localBin = path.join(getFFmpegDir(), 'ffmpeg')
  if (existsSync(localBin)) {
    _ffmpegPath = localBin
    return localBin
  }

  // 3. Common install locations (direct file checks — works even without PATH)
  for (const candidate of getCommonInstallPaths('ffmpeg')) {
    if (existsSync(candidate)) {
      _ffmpegPath = candidate
      return candidate
    }
  }

  // 4. System PATH (fallback — may not include /opt/homebrew/bin in GUI apps)
  const systemPath = await findInPath('ffmpeg')
  if (systemPath) {
    _ffmpegPath = systemPath
    return systemPath
  }

  // Not found
  return 'ffmpeg' // Will fail gracefully when spawned
}

export async function getFFprobePath(): Promise<string> {
  if (_ffprobePath && existsSync(_ffprobePath)) return _ffprobePath

  const customPath = await getAppSetting('ffprobe_path')
  if (customPath && existsSync(customPath)) {
    _ffprobePath = customPath
    return customPath
  }

  // Bundled ffprobe — same precedence as ffmpeg above.
  const bundledBin = getBundledBinaryPath('ffprobe')
  if (bundledBin && existsSync(bundledBin)) {
    _ffprobePath = bundledBin
    return bundledBin
  }

  const localBin = path.join(getFFmpegDir(), 'ffprobe')
  if (existsSync(localBin)) {
    _ffprobePath = localBin
    return localBin
  }

  for (const candidate of getCommonInstallPaths('ffprobe')) {
    if (existsSync(candidate)) {
      _ffprobePath = candidate
      return candidate
    }
  }

  const systemPath = await findInPath('ffprobe')
  if (systemPath) {
    _ffprobePath = systemPath
    return systemPath
  }

  return 'ffprobe'
}

// ── Status Check ───────────────────────────────────────────────────────────

export interface FFmpegStatus {
  installed: boolean
  version?: string
  source: 'bundled' | 'system' | 'not-found'
  path?: string
  has_drawtext: boolean
  has_libass: boolean   // needed to burn subtitles via the `subtitles=` filter
  /**
   * Apple Media Engine hardware encoder availability. Used by the Video
   * Assembly export presets to grey out cards that depend on
   * `h264_videotoolbox` / `hevc_videotoolbox` when the underlying ffmpeg
   * build doesn't expose them — happens on Linux/Windows builds, on older
   * Macs without Media Engine silicon, and occasionally on quirky brewed
   * builds that omitted videotoolbox at compile time. Backend silently
   * falls back to CPU encoding when missing; this flag lets the UI tell
   * the user upfront so they don't pick a "Fast (hardware)" preset and
   * wonder why their render is slow.
   */
  hw_encoders: { h264: boolean; h265: boolean }
}

export async function getFFmpegStatus(): Promise<FFmpegStatus> {
  const ffmpegBin = await getFFmpegPath()
  const result: FFmpegStatus = {
    installed: false,
    source: 'not-found',
    has_drawtext: false,
    has_libass: false,
    hw_encoders: { h264: false, h265: false },
  }

  // Inline watchdog (can't import from ffmpeg-utils — that'd be circular).
  // `ffmpeg -version` / `-filters` should finish in ms, but a wedged binary
  // on a broken install would otherwise hang this status call forever —
  // and this runs on every Settings → FFmpeg render.
  const STATUS_TIMEOUT_MS = 30_000
  const version = await new Promise<string | null>((resolve) => {
    const proc = spawn(ffmpegBin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let killed = false
    const t = setTimeout(() => {
      killed = true
      try { proc.kill('SIGTERM') } catch { /* already exited */ }
      const k = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* exited */ } }, 5000)
      proc.once('close', () => clearTimeout(k))
    }, STATUS_TIMEOUT_MS)
    proc.stdout.on('data', (data: Buffer) => { output += data.toString() })
    proc.on('error', () => { clearTimeout(t); resolve(null) })
    proc.on('close', (code) => {
      clearTimeout(t)
      if (killed) return resolve(null)
      if (code === 0) {
        const m = output.match(/ffmpeg version (\S+)/)
        resolve(m?.[1] || 'unknown')
      } else resolve(null)
    })
  })

  if (!version) return result

  result.installed = true
  result.version = version
  result.path = ffmpegBin

  // Determine source. "App-managed" = either the bundled binary that ships
  // in Contents/Resources/ffmpeg/ (via electron-builder extraResources) OR
  // the fallback binary we auto-downloaded into {userData}/ffmpeg/. Anything
  // else — Homebrew, MacPorts, system PATH — is reported as 'system'.
  // Matching only the userData dir (the previous check) mislabelled the
  // real bundled binary as 'system', which confused the install UI.
  const localDir = getFFmpegDir()
  const bundledBinPath = getBundledBinaryPath('ffmpeg')
  const bundledDir = bundledBinPath ? path.dirname(bundledBinPath) : null
  const isAppManaged =
    ffmpegBin.startsWith(localDir) ||
    (bundledDir !== null && ffmpegBin.startsWith(bundledDir))
  result.source = isAppManaged ? 'bundled' : 'system'

  // Spawn helper: shared across the filters + encoders probes below.
  // Returns stdout text on a clean exit, or '' on timeout/error so the
  // caller's regex tests just don't match (graceful degrade).
  async function captureFfmpeg(args: string[]): Promise<string> {
    return await new Promise<string>((resolve) => {
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const t = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* already exited */ }
        const k = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* exited */ } }, 5000)
        proc.once('close', () => clearTimeout(k))
      }, STATUS_TIMEOUT_MS)
      proc.stdout.on('data', (data: Buffer) => { output += data.toString() })
      proc.on('error', () => { clearTimeout(t); resolve('') })
      proc.on('close', () => { clearTimeout(t); resolve(output) })
    })
  }

  // Probe filters + encoders in parallel — both spawn the same ffmpeg
  // binary independently, so there's no reason to wait one out before
  // starting the next.
  const [filters, encoders] = await Promise.all([
    captureFfmpeg(['-filters']),
    captureFfmpeg(['-encoders']),
  ])

  result.has_drawtext = /\bdrawtext\b/.test(filters)
  // libass binds two related filters: `subtitles` (from .srt/.ass files)
  // and `ass` (from ASS files). Both imply libass is present.
  result.has_libass = /\bsubtitles\b/.test(filters) && /\bass\b/.test(filters)

  // `ffmpeg -encoders` lists each encoder on its own line as e.g.
  //   `V..... h264_videotoolbox    VideoToolbox H.264 Encoder`
  // The leading "V" flag column distinguishes encoders from decoders;
  // for our purposes any line containing the encoder name is enough.
  result.hw_encoders.h264 = /\bh264_videotoolbox\b/.test(encoders)
  result.hw_encoders.h265 = /\bhevc_videotoolbox\b/.test(encoders)

  return result
}

// ── Download & Install ─────────────────────────────────────────────────────

/**
 * Download URLs — keyed by platform AND CPU arch because the macOS sources
 * available to us don't ship universal binaries:
 *
 *   - evermeet.cx serves Intel x86_64 builds only. Their `getrelease/zip`
 *     endpoint ignores any arch query and always returns x86_64. Spawning
 *     that binary on Apple Silicon WITHOUT Rosetta 2 fails with
 *     `spawn Unknown system error -86` (EBADARCH).
 *   - osxexperts.net publishes versioned arm64 builds at predictable URLs.
 *     ffmpeg.org's official "static-builds" page recommends them for
 *     Apple Silicon.
 *
 * For users hitting this fallback (i.e. the bundled binary wasn't found
 * or was deleted), we pick the right slice for the host arch up front so
 * the verify step doesn't silently die later. Versions kept in lockstep
 * with the bundled-binary fetch script (`scripts/fetch-ffmpeg.mjs`) so
 * "Re-install / update FFmpeg" produces the same major.minor as the
 * bundled copy unless the user upgrades.
 */
const FALLBACK_FFMPEG_VERSION = '8.1'
const DOWNLOAD_URLS: Record<string, Record<string, { ffmpeg: string; ffprobe: string }>> = {
  darwin: {
    arm64: {
      ffmpeg:  `https://www.osxexperts.net/ffmpeg${FALLBACK_FFMPEG_VERSION.replace('.', '')}arm.zip`,
      ffprobe: `https://www.osxexperts.net/ffprobe${FALLBACK_FFMPEG_VERSION.replace('.', '')}arm.zip`,
    },
    x64: {
      ffmpeg:  `https://evermeet.cx/ffmpeg/ffmpeg-${FALLBACK_FFMPEG_VERSION}.zip`,
      ffprobe: `https://evermeet.cx/ffmpeg/ffprobe-${FALLBACK_FFMPEG_VERSION}.zip`,
    },
  },
}

// Pinned SHA-256 of upstream zips. Must stay in sync with the values in
// scripts/fetch-ffmpeg.mjs (same URLs, same version). A mismatch at runtime
// means upstream served bytes that differ from what we vetted at build time
// — refuse to install rather than lipo / spawn a possibly-trojaned binary.
const DOWNLOAD_SHA256: Record<string, Record<string, { ffmpeg: string; ffprobe: string }>> = {
  darwin: {
    arm64: {
      ffmpeg:  'ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad',
      ffprobe: 'a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1',
    },
    x64: {
      ffmpeg:  'd67db25908eff64b7d0eaa73784f0c55728d9e036a96931095fcf8e8968eefab',
      ffprobe: 'b6e9bf4f4ab2992dace205498d99d9e2ede684e3e8ae89485cadd3b91711ea04',
    },
  },
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  percent: number
  message: string
}

/**
 * Download and install FFmpeg to the app's user data directory.
 * Returns the path to the installed ffmpeg binary.
 *
 * Flow: download ZIP → extract binary → chmod +x → cache path.
 */
export async function downloadFFmpeg(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  const startedAt = Date.now()
  const platform = process.platform
  const arch = process.arch

  // Mirror every progress event into the polling state so the UI can
  // observe progress even though the POST /ffmpeg/install endpoint
  // doesn't stream. The `userOnProgress` parameter is preserved so any
  // future SSE/streaming caller still works without code changes.
  const userOnProgress = onProgress
  setInstallProgress({
    status: 'running',
    phase: 'downloading',
    percent: 0,
    message: 'Starting…',
    started_at: startedAt,
    finished_at: undefined,
    error: undefined,
    result_path: undefined,
  })
  const progressSink: (p: DownloadProgress) => void = (p) => {
    setInstallProgress({
      phase: p.phase,
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      message: p.message,
    })
    userOnProgress?.(p)
  }
  // From here on, prefer `progressSink` over the original `onProgress`.
  onProgress = progressSink
  // Story Studio KH is macOS-only. Two-level lookup: platform (darwin) THEN
  // arch (arm64/x64). Falling through either level produces the
  // unsupported-platform error below and is logged so a failure is
  // debuggable without a follow-up question.
  const urls = DOWNLOAD_URLS[platform]?.[arch]

  // ── Phase wrapper ─────────────────────────────────────────────────────
  // Each step writes a structured log entry (info on success, error on
  // failure) so a remote user hitting an unfamiliar failure can copy the
  // log and ship it back without having to reproduce the bug. The log
  // ends up in {userData}/logs/server-YYYY-MM-DD.log via logger.ts and is
  // exposed to the UI via GET /ffmpeg/install-log.
  async function phase<T>(name: string, fn: () => Promise<T>, meta: Record<string, any> = {}): Promise<T> {
    const phaseStart = Date.now()
    try {
      const result = await fn()
      logLine('info', `ffmpeg-install:${name} ok`, { phase: name, ms: Date.now() - phaseStart, ...meta })
      return result
    } catch (e: any) {
      // Capture the original message + stack but also a `code` field for
      // common Node fs / network errors (ENOENT, EACCES, ETIMEDOUT, etc.)
      // — those codes tell the support story without the full stack.
      logLine('error', `ffmpeg-install:${name} failed`, {
        phase: name,
        ms: Date.now() - phaseStart,
        error: e?.message || String(e),
        code: e?.code,
        stack: e?.stack,
        platform,
        arch: process.arch,
        ...meta,
      })
      throw e
    }
  }

  if (!urls) {
    const err = new Error(
      `Story Studio KH is macOS-only (platform=${platform}, arch=${arch}). ` +
      `On macOS you can also install FFmpeg manually with: brew install ffmpeg`,
    )
    logLine('error', 'ffmpeg-install:unsupported-platform', { platform, arch })
    throw err
  }

  const ffmpegDir = getFFmpegDir()
  const expected = DOWNLOAD_SHA256[platform]?.[arch]
  logLine('info', 'ffmpeg-install:start', { platform, arch, ffmpegDir, ffmpegUrl: urls.ffmpeg, ffprobeUrl: urls.ffprobe })
  await phase('mkdir', () => fs.mkdir(ffmpegDir, { recursive: true }), { dir: ffmpegDir })

  // verifyHash: check downloaded zip matches the pinned SHA-256 BEFORE
  // unzipping or chmod +x. A mismatch means upstream served different bytes
  // than what we vetted at build time — abort rather than land a possibly-
  // trojaned binary in userData/.
  async function verifyHash(label: string, zipPath: string, expectedHash: string | undefined): Promise<void> {
    if (!expectedHash) {
      logLine('warn', 'ffmpeg-install:no-pinned-hash', { label, platform, arch })
      return
    }
    const got = await sha256OfFile(zipPath)
    if (got !== expectedHash) {
      await fs.rm(zipPath, { force: true }).catch(() => {})
      throw new Error(
        `${label}: downloaded zip SHA-256 does not match the pinned value.\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${got}\n` +
        `Upstream may have changed the artifact, or the download was tampered ` +
        `with in transit. Install aborted. If upstream has legitimately rolled ` +
        `a new version, update DOWNLOAD_SHA256 in ffmpeg-manager.ts to match.`,
      )
    }
  }

  // 1. Download ffmpeg.zip
  onProgress?.({ phase: 'downloading', percent: 5, message: 'Downloading FFmpeg...' })
  const ffmpegZip = path.join(ffmpegDir, 'ffmpeg.zip')
  await phase('download-ffmpeg', () => downloadBinary(urls.ffmpeg, ffmpegZip, (pct) => {
    onProgress?.({ phase: 'downloading', percent: 5 + pct * 40, message: `Downloading FFmpeg... ${Math.round(pct * 100)}%` })
  }), { url: urls.ffmpeg, savePath: ffmpegZip })

  await phase('verify-ffmpeg-hash', () => verifyHash('ffmpeg zip', ffmpegZip, expected?.ffmpeg), { url: urls.ffmpeg })

  // 2. Extract ffmpeg binary from zip
  onProgress?.({ phase: 'extracting', percent: 45, message: 'Extracting FFmpeg...' })
  const ffmpegPath = path.join(ffmpegDir, 'ffmpeg')
  await phase('extract-ffmpeg', () => extractZipBinary(ffmpegZip, 'ffmpeg', ffmpegPath), { dest: ffmpegPath })
  await fs.rm(ffmpegZip, { force: true })

  // 3. Download ffprobe.zip
  onProgress?.({ phase: 'downloading', percent: 50, message: 'Downloading FFprobe...' })
  const ffprobeZip = path.join(ffmpegDir, 'ffprobe.zip')
  await phase('download-ffprobe', () => downloadBinary(urls.ffprobe, ffprobeZip, (pct) => {
    onProgress?.({ phase: 'downloading', percent: 50 + pct * 40, message: `Downloading FFprobe... ${Math.round(pct * 100)}%` })
  }), { url: urls.ffprobe, savePath: ffprobeZip })

  await phase('verify-ffprobe-hash', () => verifyHash('ffprobe zip', ffprobeZip, expected?.ffprobe), { url: urls.ffprobe })

  // 4. Extract ffprobe binary from zip
  onProgress?.({ phase: 'extracting', percent: 90, message: 'Extracting FFprobe...' })
  const ffprobePath = path.join(ffmpegDir, 'ffprobe')
  await phase('extract-ffprobe', () => extractZipBinary(ffprobeZip, 'ffprobe', ffprobePath), { dest: ffprobePath })
  await fs.rm(ffprobeZip, { force: true })

  // 5. Make executable
  await phase('chmod', async () => {
    await fs.chmod(ffmpegPath, 0o755)
    await fs.chmod(ffprobePath, 0o755)
  })

  // 5b. Strip macOS quarantine attribute. New downloads inherit
  //     `com.apple.quarantine`, which makes Gatekeeper refuse to spawn
  //     the binary on first run (the spawn at the verify step below
  //     would silently fail with EPERM-ish behavior). Best-effort:
  //     `xattr -d` errors with "No such xattr" on non-quarantined files
  //     and on Linux/Windows entirely — both safe to ignore.
  if (platform === 'darwin') {
    await phase('strip-quarantine', () => stripQuarantine([ffmpegPath, ffprobePath]), { paths: [ffmpegPath, ffprobePath] })
  }

  // 6. Verify binary actually runs
  const verifyResult = await phase('verify', () => verifyBinary(ffmpegPath), { binary: ffmpegPath })
  if (!verifyResult.ok) {
    // Specialise the error message when the failure is the EBADARCH
    // signature (wrong CPU arch / no Rosetta). This is the highest-
    // probability failure mode for our Apple-Silicon-without-Rosetta
    // users hitting the fallback path, so calling it out by name saves
    // them a support round-trip. Generic guidance applies to any other
    // failure (corrupted download, missing libs, Gatekeeper kill, etc).
    if (isBadArchError(verifyResult)) {
      logLine('error', 'ffmpeg-install:badarch', {
        binary: ffmpegPath,
        platform,
        arch,
        errorCode: verifyResult.errorCode,
        errorMessage: verifyResult.errorMessage,
      })
      throw new Error(
        'The downloaded FFmpeg binary is built for a different CPU architecture than this Mac. ' +
        'On Apple Silicon you can either:\n' +
        '  1. Install Rosetta 2 once (terminal command: ' +
        'softwareupdate --install-rosetta --agree-to-license), then click ' +
        'Re-install / update FFmpeg again, or\n' +
        '  2. Run brew install ffmpeg in your terminal — the app will detect it ' +
        'automatically (no Rosetta needed).\n\n' +
        'The bundled FFmpeg that ships inside the .app should normally avoid this ' +
        'fallback path entirely. If you hit this error on a fresh install, please report ' +
        'it via "Copy log to clipboard" below so we can investigate.',
      )
    }
    logLine('error', 'ffmpeg-install:verify-failed', {
      binary: ffmpegPath,
      exitCode: verifyResult.exitCode,
      errorCode: verifyResult.errorCode,
      errorMessage: verifyResult.errorMessage,
    })
    throw new Error(
      'FFmpeg was downloaded but failed to run. The binary may be corrupted, ' +
      'blocked by Gatekeeper, or missing required libraries. ' +
      `Details: ${verifyResult.errorMessage || `exit ${verifyResult.exitCode}`}. ` +
      'Try installing manually: brew install ffmpeg, or check the install log under Settings → FFmpeg.',
    )
  }

  // 7. Cache + save
  _ffmpegPath = ffmpegPath
  _ffprobePath = ffprobePath
  await setAppSetting('ffmpeg_path', ffmpegPath)
  await setAppSetting('ffprobe_path', ffprobePath)

  onProgress?.({ phase: 'done', percent: 100, message: 'FFmpeg installed successfully!' })
  setInstallProgress({
    status: 'done',
    phase: 'done',
    percent: 100,
    message: 'FFmpeg installed successfully!',
    finished_at: Date.now(),
    result_path: ffmpegPath,
  })
  logLine('info', 'ffmpeg-install:complete', { ms: Date.now() - startedAt, ffmpegPath, ffprobePath })

  return ffmpegPath
}

/**
 * Best-effort removal of the macOS quarantine attribute on freshly
 * downloaded binaries. Spawns `xattr -d com.apple.quarantine <path>` for
 * each path; non-zero exit (e.g. attribute not present) is fine and
 * logged as info, not error. This is the difference between "the binary
 * runs on first launch" and "Gatekeeper kills it silently".
 */
function stripQuarantine(paths: string[]): Promise<void> {
  return Promise.all(paths.map(p => new Promise<void>((resolve) => {
    const proc = spawn('xattr', ['-d', 'com.apple.quarantine', p], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', () => resolve()) // xattr not found is fine
    proc.on('close', (code) => {
      if (code !== 0 && stderr && !stderr.includes('No such xattr')) {
        logLine('warn', 'ffmpeg-install:strip-quarantine partial', { path: p, exitCode: code, stderr: stderr.trim() })
      }
      resolve()
    })
  }))).then(() => undefined)
}

/**
 * Extract a specific binary file from a ZIP archive, writing to destPath.
 * evermeet.cx zips contain the binary at the archive root.
 */
async function extractZipBinary(zipPath: string, binaryName: string, destPath: string): Promise<void> {
  // Use JSZip (already a transitive dep via docx package)
  const JSZip = (await import('jszip')).default as any
  const zipData = await fs.readFile(zipPath)
  const zip = await JSZip.loadAsync(zipData)

  // Find the binary file (often at root, sometimes nested)
  let entry: any = null
  for (const [name, file] of Object.entries(zip.files) as Array<[string, any]>) {
    if (file.dir) continue
    const basename = name.split('/').pop() || ''
    if (basename === binaryName || basename === `${binaryName}.exe`) {
      entry = file
      break
    }
  }

  if (!entry) {
    throw new Error(`Binary "${binaryName}" not found in downloaded ZIP archive`)
  }

  const buffer = await entry.async('nodebuffer')
  await fs.writeFile(destPath, buffer)
}

/**
 * Verify the downloaded binary is executable and returns a valid version.
 *
 * Returns a discriminated result instead of a bare boolean so the caller
 * can distinguish between failure modes:
 *   - `ok: true` — spawn succeeded AND output includes the expected version banner
 *   - `ok: false, error: { code: 'EBADARCH' }` — wrong CPU arch (macOS spawn returns
 *     `Unknown system error -86` when no Rosetta translates the binary)
 *   - `ok: false, error: <other>` — exit non-zero, missing version banner, etc.
 *
 * Surfacing the spawn error lets the install path show a Rosetta-specific
 * message instead of the generic "verify failed" that left the user
 * staring at our last screenshot.
 */
interface VerifyResult {
  ok: boolean
  exitCode?: number | null
  errorCode?: string
  errorMessage?: string
}
async function verifyBinary(binaryPath: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', (data: Buffer) => { output += data.toString() })
    proc.on('error', (err: any) => {
      resolve({ ok: false, errorCode: err?.code, errorMessage: err?.message || String(err) })
    })
    proc.on('close', (code) => {
      if (code === 0 && output.includes('ffmpeg version')) {
        resolve({ ok: true, exitCode: code })
      } else {
        resolve({ ok: false, exitCode: code, errorMessage: `exit ${code}, output did not contain version banner` })
      }
    })
  })
}

/**
 * Heuristic for "the spawn failed because the binary is the wrong CPU
 * arch for this Mac". macOS reports this as either an explicit
 * `EBADARCH` errno OR as `spawn Unknown system error -86`. We accept
 * both spellings to insulate against Node version differences.
 */
function isBadArchError(r: VerifyResult): boolean {
  if (r.errorCode === 'EBADARCH') return true
  const msg = r.errorMessage || ''
  return /system error -86\b/.test(msg) || /Bad CPU type/i.test(msg)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a CLI binary in two phases:
 *
 *   1. `which` / `where` — finds it if the binary is on the inherited PATH.
 *      This works in dev (Electron launched from the terminal inherits the
 *      shell's PATH) but FAILS for packaged apps launched from Finder, where
 *      macOS gives Electron a minimal PATH without `/opt/homebrew/bin` or
 *      `/usr/local/bin`. The user installs ffmpeg via brew, sees it in
 *      their terminal, but the app reports "not found" — classic Electron
 *      gotcha (see https://github.com/sindresorhus/fix-path).
 *
 *   2. Hardcoded probe of well-known install dirs. Covers Apple Silicon
 *      Homebrew (`/opt/homebrew/bin`), Intel Homebrew (`/usr/local/bin`),
 *      MacPorts (`/opt/local/bin`), system bin (`/usr/bin`, `/bin`), and
 *      Linux equivalents. First match wins.
 *
 * Skipping the manual probe and just augmenting `process.env.PATH` at
 * startup would also work, but a targeted probe is cheaper and we don't
 * have to worry about leaking env changes into spawned children.
 */
const COMMON_BIN_DIRS_BY_PLATFORM: Record<string, string[]> = {
  darwin: [
    '/opt/homebrew/bin',     // Apple Silicon Homebrew (default)
    '/usr/local/bin',        // Intel Homebrew (default)
    '/opt/local/bin',        // MacPorts
    '/usr/bin',              // system
    '/bin',                  // system
  ],
  linux: [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/bin',
    '/snap/bin',             // snap-installed
  ],
  win32: [],                 // PATH probe via `where` already handles this
}

async function findInPath(binary: string): Promise<string | null> {
  // Phase 1: ask the shell helper.
  const fromWhich = await new Promise<string | null>((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const proc = spawn(cmd, [binary], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', (data: Buffer) => { output += data.toString() })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim().split('\n')[0]!)
      } else {
        resolve(null)
      }
    })
  })
  if (fromWhich) return fromWhich

  // Phase 2: probe common install dirs that Finder-launched Electron apps
  // don't see on PATH. `existsSync` plus `accessSync(X_OK)` confirms the
  // path is both present and executable — important so a leftover symlink
  // to a deleted file doesn't get returned.
  const dirs = COMMON_BIN_DIRS_BY_PLATFORM[process.platform] || []
  const candidates = process.platform === 'win32'
    ? [`${binary}.exe`, binary]
    : [binary]
  for (const dir of dirs) {
    for (const name of candidates) {
      const p = path.join(dir, name)
      try {
        if (!existsSync(p)) continue
        // accessSync throws if not executable; missing X_OK on a regular
        // file means we can't actually spawn it.
        accessSync(p, fsConstants.X_OK)
        return p
      } catch {
        // Not executable or stat failed; try next candidate.
      }
    }
  }
  return null
}

async function downloadBinary(
  url: string, savePath: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  let resp: Response
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(300000), // 5 min timeout
      headers: { 'User-Agent': 'Story-Studio/0.1.0' },
      redirect: 'follow',
    })
  } catch (e: any) {
    // AbortSignal.timeout fires a TimeoutError after 5 min of slow / no
    // progress on the connection. Translate to a user-actionable message
    // — the raw "operation was aborted due to timeout" tells nobody
    // anything about WHY the fallback download is failing OR what to do.
    const isTimeout = e?.name === 'TimeoutError' || /aborted due to timeout/i.test(String(e?.message || ''))
    if (isTimeout) {
      throw new Error(
        `Download timed out after 5 minutes from ${new URL(url).host}. ` +
        `The fallback download host may be slow or unreachable from your network. ` +
        `Two ways to recover: install FFmpeg via Homebrew (\`brew install ffmpeg\` in Terminal — the app will detect it automatically), ` +
        `OR ignore this — the FFmpeg that ships inside the app should already be working ` +
        `(you can confirm on the Settings → FFmpeg tab). ` +
        `If the app says FFmpeg is "Bundled with app" and "ready", you don't need to install anything.`,
      )
    }
    throw e
  }

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status} from ${url}`)
  }

  const totalSize = parseInt(resp.headers.get('content-length') || '0')
  const body = resp.body
  if (!body) throw new Error('No response body')

  const writeStream = createWriteStream(savePath)
  let downloaded = 0

  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      writeStream.write(value)
      downloaded += value.length
      if (totalSize > 0 && onProgress) onProgress(downloaded / totalSize)
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  }
}

/** Clear cached paths (for testing or after download) */
export function clearFFmpegCache(): void {
  _ffmpegPath = null
  _ffprobePath = null
}
