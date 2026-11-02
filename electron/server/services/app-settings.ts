/**
 * App-level settings store — single JSON file alongside the projects/ directory.
 *
 * Scope today: `ffmpeg_path` / `ffprobe_path`. Keep additions to genuinely
 * app-level knobs (per-install, not per-project). Per-project config lives
 * in `{PROJECTS_ROOT}/{slug}/config.json`. Provider API keys live at app
 * level (see `app-secrets-store.ts`); per-project `secrets.json` files
 * still hold YouTube OAuth tokens but no API keys.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { normalizeServiceBaseUrl } from '../lib/security.js'
import {
  normalizeVoicePresets,
  type NormalizedVoicePreset,
} from './voice-presets.js'
import {
  type CostSettings,
  DEFAULT_COST_SETTINGS,
} from '../contracts/episode-cost.js'

// `ffmpeg_path` lives in this file and is fed to `spawn()` by ffmpeg-manager.
// Any process running as the user that can write this file gets
// arbitrary-binary exec on next video render. Lock to owner-only.
const APP_SETTINGS_MODE = 0o600

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')

function resolveAppSettingsPath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'app-settings.json')
  }
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const productName = 'Story Studio KH'
    let userData: string
    if (process.platform === 'darwin') {
      userData = path.join(home, 'Library', 'Application Support', productName)
    } else if (process.platform === 'win32') {
      userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
    } else {
      userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
    }
    return path.join(userData, 'app-settings.json')
  }
  return path.join(ROOT, 'app-settings.json')
}

/**
 * The settings-file path, resolved on EVERY access.
 *
 * Deliberately not captured in a module-scope `const`. `STORY_STUDIO_DATA_DIR`
 * is what redirects this store to an isolated directory, and it is set by the
 * caller — the Electron main process at boot, `useTempDataDir()` in tests.
 * A module-load-time capture froze the path to whatever it happened to be when
 * the FIRST importer anywhere in the graph pulled this module in, which is
 * before a test's `before()` hook can claim its temp dir. Any test file whose
 * *static* import chain reached this module therefore bound the developer's
 * real app-settings.json and read/wrote it for the rest of the process —
 * corrupting live settings and leaking real state (server-mode credentials,
 * GenStudio base URL) into unrelated suites.
 *
 * Resolving per call costs a couple of string joins and removes that entire
 * class of import-order bug: correctness no longer depends on which module got
 * imported first. See `writeSettings` for the guard that keeps it that way.
 */
function appSettingsPath(): string {
  return resolveAppSettingsPath()
}

type AppSettings = Record<string, any>

interface SettingsCacheEntry {
  signature: string
  value: AppSettings
}

const settingsCache = new Map<string, SettingsCacheEntry>()
const settingsReads = new Map<string, { signature: string; promise: Promise<AppSettings> }>()

async function settingsFileSignature(target: string): Promise<string> {
  try {
    const stat = await fs.stat(target)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readStableSettings(target: string): Promise<AppSettings> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await settingsFileSignature(target)
    const value = await readJsonOr<AppSettings>(target, {})
    const after = await settingsFileSignature(target)
    if (before === after) {
      settingsCache.set(target, { signature: after, value })
      return value
    }
  }
  // A continuously changing hand-edited file is returned but not cached.
  return readJsonOr<AppSettings>(target, {})
}

function cloneSettingValue<T>(value: T): T {
  return value && typeof value === 'object' ? structuredClone(value) : value
}

export const RETRY_ATTEMPTS_MIN = 1
export const RETRY_ATTEMPTS_MAX = 10
export const RETRY_ATTEMPTS_DEFAULT = 3

export interface RetryFailedRequestsSetting {
  /** The switch to enable retry for failed requests of this kind. */
  enabled: boolean
  /** Number of retry attempts (1-10). Defaults to 3. */
  retries: number
}

export const RETRY_FAILED_REQUESTS_IMAGE_KEY = 'retry_failed_requests_image'
export const RETRY_FAILED_REQUESTS_SUBTITLE_KEY = 'retry_failed_requests_subtitle'
export const RETRY_FAILED_REQUESTS_AUDIO_KEY = 'retry_failed_requests_audio'
export const RETRY_FAILED_REQUESTS_WRITING_KEY = 'retry_failed_requests_writing'

export interface PaidImageReplacementSetting {
  /** The whole switch. Gateway owns the charge, so there is no budget beside it. */
  enabled: boolean
}

export const PAID_IMAGE_REPLACEMENT_KEY = 'paid_image_replacement'
export const PAID_SUBTITLE_REPLACEMENT_KEY = 'paid_subtitle_replacement'
export const PAID_AUDIO_REPLACEMENT_KEY = 'paid_audio_replacement'
export const PAID_WRITING_REPLACEMENT_KEY = 'paid_writing_replacement'
export const MANUAL_GENERATION_REDO_KEY = 'manual_generation_redo'
export const PRIVATE_FINAL_RENDER_KEY = 'private_final_render'
export const DEFAULT_MODELS_KEY = 'default_models'

export interface ManualGenerationRedoSetting {
  enabled: boolean
}

export interface PrivateFinalRenderSetting {
  enabled: boolean
}

function parseManualGenerationRedoSetting(
  value: unknown,
  invalid: 'default' | 'throw',
): ManualGenerationRedoSetting {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!record || Object.keys(record).length !== 1 || typeof record.enabled !== 'boolean') {
    if (invalid === 'throw') {
      throw Object.assign(
        new Error('Manual generation redo requires exactly enabled as a boolean.'),
        { statusCode: 400, expose: true },
      )
    }
    return { enabled: false }
  }
  return { enabled: record.enabled }
}

function parsePrivateFinalRenderSetting(
  value: unknown,
  invalid: 'default' | 'throw',
): PrivateFinalRenderSetting {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!record || Object.keys(record).length !== 1 || typeof record.enabled !== 'boolean') {
    if (invalid === 'throw') {
      throw Object.assign(
        new Error('Private final render requires exactly enabled as a boolean.'),
        { statusCode: 400, expose: true },
      )
    }
    return { enabled: false }
  }
  return { enabled: record.enabled }
}

const PAID_REPLACEMENT_DEFAULT: PaidImageReplacementSetting = {
  enabled: false,
}

function invalidPaidReplacementSetting(kind: 'image' | 'subtitle' | 'audio' | 'writing'): never {
  throw Object.assign(
    new Error(`Paid ${kind} replacement requires exactly enabled as a boolean.`),
    { statusCode: 400, expose: true },
  )
}

function parsePaidReplacementSetting(
  value: unknown,
  invalid: 'default' | 'throw',
  kind: 'image' | 'subtitle' | 'audio' | 'writing',
): PaidImageReplacementSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (invalid === 'throw') return invalidPaidReplacementSetting(kind)
    return { ...PAID_REPLACEMENT_DEFAULT }
  }
  const record = value as Record<string, unknown>
  // A legacy record may still carry `additional_credit_ceiling`. It is ignored:
  // the switch alone decides, and `enabled: true` stays on.
  if (!('enabled' in record) || typeof record.enabled !== 'boolean') {
    if (invalid === 'throw') return invalidPaidReplacementSetting(kind)
    return { ...PAID_REPLACEMENT_DEFAULT }
  }
  return { enabled: record.enabled }
}

export function parseRetryFailedRequestsSetting(
  value: unknown,
  invalid: 'default' | 'throw',
  kind: 'image' | 'subtitle' | 'audio' | 'writing',
): RetryFailedRequestsSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (invalid === 'throw') {
      throw Object.assign(
        new Error(`Retry failed requests for ${kind} requires enabled as a boolean.`),
        { statusCode: 400, expose: true },
      )
    }
    return { enabled: false, retries: RETRY_ATTEMPTS_DEFAULT }
  }
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') {
    if (invalid === 'throw') {
      throw Object.assign(
        new Error(`Retry failed requests for ${kind} requires enabled as a boolean.`),
        { statusCode: 400, expose: true },
      )
    }
    return { enabled: false, retries: RETRY_ATTEMPTS_DEFAULT }
  }
  let retries = RETRY_ATTEMPTS_DEFAULT
  if ('retries' in record && record.retries !== undefined) {
    if (typeof record.retries !== 'number' || !Number.isInteger(record.retries) || record.retries < RETRY_ATTEMPTS_MIN || record.retries > RETRY_ATTEMPTS_MAX) {
      if (invalid === 'throw') {
        throw Object.assign(
          new Error(`Retries for ${kind} must be an integer between ${RETRY_ATTEMPTS_MIN} and ${RETRY_ATTEMPTS_MAX}.`),
          { statusCode: 400, expose: true },
        )
      }
      retries = RETRY_ATTEMPTS_DEFAULT
    } else {
      retries = record.retries
    }
  }
  return { enabled: record.enabled, retries }
}

// Legacy installs wrote this file with default 0644. On the first read after
// upgrade, tighten perms to 0600 so the ffmpeg_path value isn't world-
// readable. Best-effort: no-op on Windows, ignored on failure — the next
// atomic write will still land a 0600 replacement either way.
// Tracked per resolved path, not by a single boolean: the path is no longer
// fixed for the life of the process, so a bare flag would skip the tighten
// on every file after the first.
const modeTightened = new Set<string>()
async function tightenModeOnce(target: string): Promise<void> {
  if (modeTightened.has(target)) return
  modeTightened.add(target)
  if (process.platform === 'win32') return
  if (!existsSync(target)) return
  await fs.chmod(target, APP_SETTINGS_MODE).catch(() => {})
}

async function readSettings(): Promise<AppSettings> {
  const target = appSettingsPath()
  await tightenModeOnce(target)
  const signature = await settingsFileSignature(target)
  const cached = settingsCache.get(target)
  if (cached?.signature === signature) return cached.value

  const pending = settingsReads.get(target)
  if (pending?.signature === signature) return pending.promise
  const read = readStableSettings(target)
  const inFlight = { signature, promise: read }
  settingsReads.set(target, inFlight)
  try {
    return await read
  } finally {
    if (settingsReads.get(target) === inFlight) settingsReads.delete(target)
  }
}

async function readSettingsForWrite(): Promise<AppSettings> {
  return structuredClone(await readSettings())
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const target = appSettingsPath()
  // Under the node test runner, writing outside the claimed data dir is a hard
  // error rather than a silent write to the developer's real app-settings.json.
  // See lib/test-isolation.ts for why this compares the resolved target.
  assertWriteIsolatedInTests(target, 'app-settings')
  await writeJsonAtomic(target, settings, { mode: APP_SETTINGS_MODE })
  settingsCache.delete(target)
}

export async function getAppSetting(key: string): Promise<any> {
  const settings = await readSettings()
  return cloneSettingValue(settings[key])
}

/** A copy of every setting. For Backup, which writes them out with secrets stripped. */
export async function getAllAppSettings(): Promise<AppSettings> {
  return structuredClone(await readSettings())
}

/**
 * Fired after any successful write to app-settings.json.
 *
 * Exists so a reader that CACHES a setting can drop its cache the moment the
 * value changes, instead of re-reading the file on every access to stay honest.
 * `projectsRoot()` is the reason: it read and parsed this file synchronously on
 * every single call — dozens of hot paths, including the per-project loop behind
 * the home page — purely to guarantee it never returned a stale Library path.
 * The guarantee is worth keeping; paying for it with a blocking disk read per
 * call was not. Subscribing here buys the same freshness for the price of one
 * read per actual change.
 *
 * Listeners must not throw and must not be slow — a write is not the place to do
 * work. Invalidate a variable; do not go and read anything.
 */
type AppSettingsWriteListener = (key: string) => void
const writeListeners = new Set<AppSettingsWriteListener>()

export function onAppSettingWritten(listener: AppSettingsWriteListener): () => void {
  writeListeners.add(listener)
  return () => { writeListeners.delete(listener) }
}

function announceWrite(key: string): void {
  for (const listener of writeListeners) {
    try { listener(key) } catch { /* a broken listener must never fail a write */ }
  }
}

/**
 * Write several settings in ONE atomic read-modify-write, so a reader never sees half a change.
 * `job-queue.ts` uses this to move the queue pause flag and its owner token together: a crash can
 * never leave a paused queue attributed to a token that no longer holds it, or the reverse.
 */
export async function setAppSettings(patch: Record<string, any>): Promise<void> {
  const keys = Object.keys(patch)
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    for (const key of keys) settings[key] = patch[key]
    await writeSettings(settings)
  })
  for (const key of keys) announceWrite(key)
}

export async function setAppSetting(key: string, value: any): Promise<void> {
  await setAppSettings({ [key]: value })
}

/** Machine-local visibility preference. Missing or corrupt storage fails closed. */
export async function getManualGenerationRedoSetting(): Promise<ManualGenerationRedoSetting> {
  return parseManualGenerationRedoSetting(await getAppSetting(MANUAL_GENERATION_REDO_KEY), 'default')
}

export async function setManualGenerationRedoSetting(value: unknown): Promise<ManualGenerationRedoSetting> {
  const setting = parseManualGenerationRedoSetting(value, 'throw')
  await setAppSetting(MANUAL_GENERATION_REDO_KEY, setting)
  return setting
}

/** Private fleet final rendering is machine-local and defaults off. */
export async function getPrivateFinalRenderSetting(): Promise<PrivateFinalRenderSetting> {
  return parsePrivateFinalRenderSetting(await getAppSetting(PRIVATE_FINAL_RENDER_KEY), 'default')
}

/** Validate the complete setting before replacing the last admitted value. */
export async function setPrivateFinalRenderSetting(value: unknown): Promise<PrivateFinalRenderSetting> {
  const setting = parsePrivateFinalRenderSetting(value, 'throw')
  await setAppSetting(PRIVATE_FINAL_RENDER_KEY, setting)
  return setting
}

/**
 * Retry failed requests setting for images.
 * Defaults to enabled: false, retries: 3.
 */
export async function getImageRetrySetting(): Promise<RetryFailedRequestsSetting> {
  const settings = await readSettings()
  return parseRetryFailedRequestsSetting(
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings[RETRY_FAILED_REQUESTS_IMAGE_KEY]
      : undefined,
    'default', 'image',
  )
}

export async function setImageRetrySetting(value: unknown): Promise<RetryFailedRequestsSetting> {
  const setting = parseRetryFailedRequestsSetting(value, 'throw', 'image')
  await setAppSetting(RETRY_FAILED_REQUESTS_IMAGE_KEY, setting)
  return setting
}

export async function getRetryFailedRequestsSetting(
  kind: 'image' | 'subtitle' | 'audio' | 'writing',
): Promise<RetryFailedRequestsSetting> {
  const key = kind === 'image' ? RETRY_FAILED_REQUESTS_IMAGE_KEY
    : kind === 'subtitle' ? RETRY_FAILED_REQUESTS_SUBTITLE_KEY
    : kind === 'audio' ? RETRY_FAILED_REQUESTS_AUDIO_KEY
    : RETRY_FAILED_REQUESTS_WRITING_KEY
  const settings = await readSettings()
  return parseRetryFailedRequestsSetting(
    settings && typeof settings === 'object' && !Array.isArray(settings) ? settings[key] : undefined,
    'default', kind,
  )
}

export async function setRetryFailedRequestsSetting(
  kind: 'image' | 'subtitle' | 'audio' | 'writing',
  value: unknown,
): Promise<RetryFailedRequestsSetting> {
  const setting = parseRetryFailedRequestsSetting(value, 'throw', kind)
  const key = kind === 'image' ? RETRY_FAILED_REQUESTS_IMAGE_KEY
    : kind === 'subtitle' ? RETRY_FAILED_REQUESTS_SUBTITLE_KEY
    : kind === 'audio' ? RETRY_FAILED_REQUESTS_AUDIO_KEY
    : RETRY_FAILED_REQUESTS_WRITING_KEY
  await setAppSetting(key, setting)
  return setting
}

/**
 * The optional paid image recovery authorisation belongs to this install, not
 * to a channel or preset. Corrupt hand-edited storage fails closed.
 */
export async function getPaidImageReplacementSetting(): Promise<PaidImageReplacementSetting> {
  const settings = await readSettings()
  return parsePaidReplacementSetting(
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings[PAID_IMAGE_REPLACEMENT_KEY]
      : undefined,
    'default', 'image',
  )
}

/** Validate before writing so rejected requests cannot replace the last valid setting. */
export async function setPaidImageReplacementSetting(value: unknown): Promise<PaidImageReplacementSetting> {
  const setting = parsePaidReplacementSetting(value, 'throw', 'image')
  // Queue due-timers share this gate so an Off write cannot race a timer that
  // already passed its non-paying validation and requeue paid work afterward.
  const queue = await import('./job-queue.js')
  await queue.withPaidImageWaitSettingMutation(async () => {
    await setAppSetting(PAID_IMAGE_REPLACEMENT_KEY, setting)
  })
  return setting
}

/**
 * Separate machine-local authority for subtitle replacement. Image policy is
 * intentionally irrelevant: enabling one paid recovery surface never enables
 * another after an upgrade.
 */
export async function getPaidSubtitleReplacementSetting(): Promise<PaidImageReplacementSetting> {
  const settings = await readSettings()
  return parsePaidReplacementSetting(
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings[PAID_SUBTITLE_REPLACEMENT_KEY]
      : undefined,
    'default', 'subtitle',
  )
}

export async function setPaidSubtitleReplacementSetting(value: unknown): Promise<PaidImageReplacementSetting> {
  const setting = parsePaidReplacementSetting(value, 'throw', 'subtitle')
  await withPaidSubtitleConfirmation(() => setAppSetting(PAID_SUBTITLE_REPLACEMENT_KEY, setting))
  return setting
}

/** Off and the final authorization + physical confirm have one linearization gate. */
export function withPaidSubtitleConfirmation<T>(work: () => Promise<T>): Promise<T> {
  return withLock(`${appSettingsPath()}:paid-subtitle-confirm`, work)
}

/** Audio recovery has independent local consent and a shared Off/confirm gate. */
export async function getPaidAudioReplacementSetting(): Promise<PaidImageReplacementSetting> {
  const settings = await readSettings()
  return parsePaidReplacementSetting(
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings[PAID_AUDIO_REPLACEMENT_KEY]
      : undefined,
    'default', 'audio',
  )
}

export async function setPaidAudioReplacementSetting(value: unknown): Promise<PaidImageReplacementSetting> {
  const setting = parsePaidReplacementSetting(value, 'throw', 'audio')
  await withPaidAudioConfirmation(() => setAppSetting(PAID_AUDIO_REPLACEMENT_KEY, setting))
  return setting
}

export function withPaidAudioConfirmation<T>(work: () => Promise<T>): Promise<T> {
  return withLock(`${appSettingsPath()}:paid-audio-confirm`, work)
}

/** Writing recovery has independent local consent and a shared Off/confirm gate. */
export async function getPaidWritingReplacementSetting(): Promise<PaidImageReplacementSetting> {
  const settings = await readSettings()
  return parsePaidReplacementSetting(
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings[PAID_WRITING_REPLACEMENT_KEY]
      : undefined,
    'default', 'writing',
  )
}

export async function setPaidWritingReplacementSetting(value: unknown): Promise<PaidImageReplacementSetting> {
  const setting = parsePaidReplacementSetting(value, 'throw', 'writing')
  await withPaidWritingConfirmation(() => setAppSetting(PAID_WRITING_REPLACEMENT_KEY, setting))
  return setting
}

export function withPaidWritingConfirmation<T>(work: () => Promise<T>): Promise<T> {
  return withLock(`${appSettingsPath()}:paid-writing-confirm`, work)
}

/**
 * 1.4.281 — all four paid-replacement switches in one read, so an agent can check the owner's rule
 * (the only paid use is LLM API calls) from one route. Each is off unless this install saved it on.
 */
export async function getPaidReplacementSettings(): Promise<Record<'image' | 'subtitle' | 'audio' | 'writing', PaidImageReplacementSetting>> {
  return {
    image: await getPaidImageReplacementSetting(),
    subtitle: await getPaidSubtitleReplacementSetting(),
    audio: await getPaidAudioReplacementSetting(),
    writing: await getPaidWritingReplacementSetting(),
  }
}

/** `{ paid_fallbacks_enabled: ['audio', …] }` when any paid replacement is on, else `{}` (run-batch and preflight responses). */
export async function paidFallbacksWarning(): Promise<{ paid_fallbacks_enabled?: string[] }> {
  const on = Object.entries(await getPaidReplacementSettings()).filter(([, setting]) => setting.enabled).map(([kind]) => kind)
  return on.length ? { paid_fallbacks_enabled: on } : {}
}

// ── Default models (owner, 2026-10-27) ─────────────────────────────────────
//
// One model per generation family, for this Mac. This is the LAST of three
// places a model can come from, and it is read at USE time only:
//
//   the preset's saved model → the page's remembered last choice → this default
//
// Nothing writes it into a preset, a channel config or a remembered form. A
// default that has left the catalogue is reported and leaves the field empty —
// never replaced by another product (2026-10-03: Story Studio never picks a
// writing model for the owner). GenStudio publishes the families, so the key
// list here is a shape, not a catalogue: every value is a model id checked
// against the live catalogue on every read.
export const DEFAULT_MODEL_FAMILIES = ['writing', 'image', 'video', 'audio', 'transcription', 'music'] as const
export type DefaultModelFamily = typeof DEFAULT_MODEL_FAMILIES[number]
export type DefaultModels = Record<DefaultModelFamily, string | null>

const DEFAULT_MODELS_EMPTY: DefaultModels = {
  writing: null, image: null, video: null, audio: null, transcription: null, music: null,
}

function invalidDefaultModels(): never {
  throw Object.assign(
    new Error('Default models requires only the families ' + DEFAULT_MODEL_FAMILIES.join(', ')
      + ', each a model id or null.'),
    { statusCode: 400, expose: true },
  )
}

function parseDefaultModels(value: unknown, invalid: 'default' | 'throw'): DefaultModels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (invalid === 'throw') return invalidDefaultModels()
    return { ...DEFAULT_MODELS_EMPTY }
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(DEFAULT_MODEL_FAMILIES as readonly string[]).includes(key)) {
      if (invalid === 'throw') return invalidDefaultModels()
      return { ...DEFAULT_MODELS_EMPTY }
    }
    const entry = record[key]
    if (entry !== null && (typeof entry !== 'string' || !entry.trim())) {
      if (invalid === 'throw') return invalidDefaultModels()
      return { ...DEFAULT_MODELS_EMPTY }
    }
  }
  const parsed = { ...DEFAULT_MODELS_EMPTY }
  for (const family of DEFAULT_MODEL_FAMILIES) {
    const entry = record[family]
    parsed[family] = typeof entry === 'string' ? entry.trim() : null
  }
  return parsed
}

/** The default model per family, or every family unset. Hand-edited storage fails closed. */
export async function getDefaultModels(): Promise<DefaultModels> {
  return parseDefaultModels(await getAppSetting(DEFAULT_MODELS_KEY), 'default')
}

/** Validate the whole setting before replacing the last admitted value. */
export async function setDefaultModels(value: unknown): Promise<DefaultModels> {
  const setting = parseDefaultModels(value, 'throw')
  await setAppSetting(DEFAULT_MODELS_KEY, setting)
  return setting
}

// ── Voice presets + favourites (global, not per-project) ──────────────────
//
// Voices the user curates (named presets, ★ favourites) are personal-taste
// signals — they don't change between channels. Storing them per-project
// duplicates work (re-favourite the same voice in 5 projects). The
// This lifts the user's CURATION to the same per-machine scope.
//
// Schema:
//   app-settings.json
//     "voice_presets":    [{ "name": "Vincent", "voice_id": "...",
//                             "providers": ["elevenlabs", "fal"] }, ...]
//     "voice_favourites": ["voice_id_1", "voice_id_2", ...]
//
// Migration: boot/migrations.ts merges each project's legacy
// `voice_presets`/`voice_favourites` into these keys on first run after
// upgrade. Per-project fields stay readable for older app builds.

/**
 * How many EPISODES may transcribe at the same time.
 *
 * WHY THIS EXISTS (v1.4.23). The owner fired thirty episodes of transcription
 * in one go and watched a third of it fail. Measured on GenStudio afterwards:
 * 231 transcriptions succeeded, 122 failed with SITE_PLACEMENT_EXHAUSTED, and
 * peak concurrency hit 103. All thirty jobs were created in the same second
 * and the failures clustered into three minutes as the fleet filled.
 *
 * His reading was right about the fix and inverted about the cause: the
 * CHAPTERS inside an episode were already concurrent — `transcribePerChapter`
 * runs a bounded pool ten wide, which is what makes a single episode fast and
 * is exactly what he asked for. What was unbounded was EPISODES. The job
 * queue's `subtitle_transcribe` group admitted fifty at once, so thirty
 * episodes times roughly eleven chapters arrived as one wave of ~350 requests.
 *
 * DEFAULT 2, not 50. Two episodes at ten chapters each is about twenty
 * requests in flight — comfortably inside what the fleet absorbed — while each
 * episode still transcribes all its chapters simultaneously, which is the part
 * that determines how long any ONE episode takes. Queueing episodes costs
 * nothing a customer can perceive; flooding the fleet costs a third of them.
 *
 * It is a setting rather than a constant because the right number is a
 * property of the owner's fleet on the day, not of this code. `job-queue.ts`
 * has carried `setSubtitleTranscribeConcurrency` since it was written and
 * nothing outside a test has ever called it — the knob existed, unreachable,
 * pinned at 50.
 */
/**
 * How many writing jobs may run at once — ideas, research, outlines, chapters,
 * metadata, image prompts and scene plans all share this one lane.
 *
 * WHY IT IS 8 (v1.4.27). The owner: *"LLM is fast and slow depending on what
 * they are so we can't let it burst. it must be queue behind one another but we
 * can let 5-10 run at the same time."* Three independent numbers agree with
 * him and pick 8 out of that range:
 *
 *   MEASURED — chat execution has peaked at exactly 8 concurrent in this
 *     platform's history, and worked. Nothing suggests the fleet minds 8.
 *   THE FAR END — GenStudio runs chat 12 wide (`jobs.chat_concurrency`).
 *     Story Studio pushing past that does not make anything faster; it just
 *     moves the queue somewhere the owner cannot see it.
 *   THE FAILURE — chat submitted in bursts of 21+ in one minute waited a
 *     MEDIAN of 15.6 minutes, 95th percentile 20 minutes. That is what the old
 *     limit of 50 actually bought.
 *
 * THE KNOWN TRADE, stated because it is the owner's own concern applied one
 * level down: these seven job types share ONE lane, so with 8 slots a burst of
 * slow scene plans can delay fast metadata. At 50 that never bit. If it starts
 * to, the fix is a limit per type rather than a bigger shared number — raising
 * this back toward 50 would only restore the 20-minute queue.
 *
 * Like `subtitle_episode_concurrency`, this exists because `setLlmConcurrency`
 * has been in `job-queue.ts` since it was written and NOTHING outside a test
 * has ever called it. The dial was there, unreachable, pinned at 50.
 */
export const LLM_CONCURRENCY_KEY = 'llm_concurrency'
export const LLM_CONCURRENCY_DEFAULT = 8

export async function getLlmConcurrency(): Promise<number> {
  const raw = await getAppSetting(LLM_CONCURRENCY_KEY)
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return LLM_CONCURRENCY_DEFAULT
  return Math.min(50, n)
}

export async function setLlmConcurrencySetting(value: unknown): Promise<number> {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    throw Object.assign(
      new Error('Writing jobs running at once must be a whole number between 1 and 50.'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(LLM_CONCURRENCY_KEY, n)
  return n
}

export const SUBTITLE_EPISODE_CONCURRENCY_KEY = 'subtitle_episode_concurrency'
export const SUBTITLE_EPISODE_CONCURRENCY_DEFAULT = 2

export async function getSubtitleEpisodeConcurrency(): Promise<number> {
  const raw = await getAppSetting(SUBTITLE_EPISODE_CONCURRENCY_KEY)
  const n = Math.floor(Number(raw))
  // An absent or unusable value is the default, never 50: the whole point is
  // that nobody inherits the flood by accident.
  if (!Number.isFinite(n) || n < 1) return SUBTITLE_EPISODE_CONCURRENCY_DEFAULT
  return Math.min(50, n)
}

export async function setSubtitleEpisodeConcurrency(value: unknown): Promise<number> {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    throw Object.assign(
      new Error('Episodes transcribing at once must be a whole number between 1 and 50.'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(SUBTITLE_EPISODE_CONCURRENCY_KEY, n)
  return n
}

/**
 * v1.4.36 — how many chapters BEYOND the target an outline may come back with.
 *
 * THE OWNER'S RULING, 2026-08-23, on finding an outline binned for returning 11
 * chapters when 10 were asked for:
 *
 *   "i don't want to throw it away at all. in fact i embrace this extra
 *    chapters. we must never have hardcoded maximum, it can be extra just now
 *    below our threshold. because longer videos means more screen time more ads
 *    slot. so i always want a longer video. this to me is an opportunity, i
 *    never know why there was a hardcoded 10 requirement at all."
 *
 * He is right about the economics and right about the constant. The outline
 * contract demanded EXACTLY the requested count — `minItems` and `maxItems`
 * both set to it — so a model that wrote an extra chapter had its whole answer
 * rejected AFTER GenStudio had completed and charged for it, and the retry is
 * manual. He paid for a complete outline and got nothing, because it was too
 * GOOD.
 *
 * The floor stays and is not negotiable: a SHORT outline is silently padded
 * with empty chapters that expand into unanchored filler and then pass every
 * downstream audit, so under-delivery must still be rejected loudly while it is
 * cheap. See `outlineOutputContract` for that argument in full. Nothing in it
 * applies to an outline that is too long — everything asked for is present,
 * plus more.
 *
 * This exists at all only to stop a runaway: a malformed answer with 500
 * chapters would become 500 paid expansion calls. It is a headroom multiple
 * rather than a count, so it scales with whatever a formula asks for, and it is
 * a setting he owns rather than a number in the source — which is the whole
 * point of the ruling.
 */
/**
 * v1.4.39 — how many EPISODES may generate images at the same time.
 *
 * MEASURED 2026-08-23, on the owner's own batch: he queued 50 Scene Review jobs
 * and 51 of his 74 online fleet workers were idle. A location connected that
 * morning had one busy worker out of twenty. Neither the fleet nor GenStudio
 * was the limit — his account bursts to 128 concurrent paid jobs and 25 were
 * running. Story Studio was running the episodes ONE AT A TIME, because every
 * queue lane outside the LLM and subtitle groups gets a single boolean slot.
 *
 * DEFAULT 2, NOT 1 AND NOT 30. One leaves the fleet idle, which is what he just
 * hit. Thirty is the 2026-08-22 transcription flood, where 122 of 353 items were
 * refused. Two episodes at roughly 25 concurrent requests each is about 50
 * against a 128 ceiling — busy, with headroom, and every image generator now
 * waits politely when the fleet is full rather than dropping work.
 *
 * His fleet grows most weeks, so this is a setting rather than a constant. When
 * it doubles again, the number he wants is a number he can change.
 */
/**
 * v1.4.41 — how many requests ONE episode may have in flight, as the owner's
 * number rather than the code's.
 *
 * `'auto'` — the default — follows what GenStudio publishes for the account
 * (`burst_concurrency_ceiling`, 128 at the time of writing), so a growing fleet
 * raises it with nothing to remember. That is the honest default: the account
 * already knows the answer and Story should not hold a second opinion.
 *
 * An explicit number overrides it in EITHER direction. Lower to leave headroom
 * for something else; higher to stage more than GenStudio will start, which is
 * safe because GenStudio queues the surplus rather than refusing it.
 *
 * It exists because the owner's standing rule is that a number he might want
 * different is his to change — and because the constant this replaces sat at
 * 50 for long enough to leave two thirds of his paid capacity idle without
 * anything reporting it.
 */
export const IMAGE_FANOUT_KEY = 'image_fanout_per_episode'
/** 'auto' = follow the account's published ceiling. */
export type ImageFanoutSetting = 'auto' | number

export async function getImageFanout(): Promise<ImageFanoutSetting> {
  const raw = await getAppSetting(IMAGE_FANOUT_KEY)
  if (raw === 'auto' || raw == null || raw === '') return 'auto'
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? Math.min(500, n) : 'auto'
}

export async function setImageFanout(value: unknown): Promise<ImageFanoutSetting> {
  if (value === 'auto' || value == null || value === '' || value === 0) {
    await setAppSetting(IMAGE_FANOUT_KEY, 'auto')
    return 'auto'
  }
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    throw Object.assign(
      new Error('Cloud requests per episode at once must be "auto", or a whole number between 1 and 500.'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(IMAGE_FANOUT_KEY, n)
  return n
}

export const IMAGE_EPISODE_CONCURRENCY_KEY = 'image_episode_concurrency'
export const IMAGE_EPISODE_CONCURRENCY_DEFAULT = 2

export async function getImageEpisodeConcurrency(): Promise<number> {
  const raw = await getAppSetting(IMAGE_EPISODE_CONCURRENCY_KEY)
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return IMAGE_EPISODE_CONCURRENCY_DEFAULT
  return Math.min(50, n)
}

export async function setImageEpisodeConcurrency(value: unknown): Promise<number> {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    throw Object.assign(
      new Error('Episodes generating images at once must be a whole number between 1 and 50.'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(IMAGE_EPISODE_CONCURRENCY_KEY, n)
  return n
}

export const AUDIO_EPISODE_CONCURRENCY_KEY = 'audio_episode_concurrency'

/**
 * Narration used to ride on the scene-image number. It now has its own, and an
 * unset value is seeded ONCE from the current scene-image number, so nobody's
 * narration limit changes on upgrade (and later scene-image edits do not move it).
 */
export async function getAudioEpisodeConcurrency(): Promise<number> {
  const n = Math.floor(Number(await getAppSetting(AUDIO_EPISODE_CONCURRENCY_KEY)))
  if (Number.isFinite(n) && n >= 1) return Math.min(50, n)
  const seeded = await getImageEpisodeConcurrency()
  await setAppSetting(AUDIO_EPISODE_CONCURRENCY_KEY, seeded)
  return seeded
}

export async function setAudioEpisodeConcurrency(value: unknown): Promise<number> {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    throw Object.assign(
      new Error('Episodes making narration at once must be a whole number between 1 and 50.'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(AUDIO_EPISODE_CONCURRENCY_KEY, n)
  return n
}

export const THUMBNAIL_EPISODE_CONCURRENCY_KEY = 'thumbnail_episode_concurrency'
/**
 * Thumbnails usually buy from a cloud API, not the local fleet, so this is a
 * separate number from the image lane: three thumbnail episodes must not
 * consume the budget that Scene Review needs. Three is the same starting point
 * as images — busy, with headroom — and it is his to change.
 */
export const THUMBNAIL_EPISODE_CONCURRENCY_DEFAULT = 3

export async function getThumbnailEpisodeConcurrency(): Promise<number> {
  const raw = await getAppSetting(THUMBNAIL_EPISODE_CONCURRENCY_KEY)
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return THUMBNAIL_EPISODE_CONCURRENCY_DEFAULT
  return Math.min(50, n)
}

export async function setThumbnailEpisodeConcurrency(value: unknown): Promise<number> {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    throw Object.assign(
      new Error('Episodes making thumbnails at once must be a whole number between 1 and 50.'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(THUMBNAIL_EPISODE_CONCURRENCY_KEY, n)
  return n
}

export const OUTLINE_HEADROOM_KEY = 'outline_chapter_headroom'
/** 2× the target. An 11-for-10 sails through; so does 20-for-10. */
export const OUTLINE_HEADROOM_DEFAULT = 2

export async function getOutlineHeadroom(): Promise<number> {
  const raw = await getAppSetting(OUTLINE_HEADROOM_KEY)
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return OUTLINE_HEADROOM_DEFAULT
  return Math.min(10, n)
}

export async function setOutlineHeadroom(value: unknown): Promise<number> {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    throw Object.assign(
      new Error('Extra chapters allowed must be a multiple between 1 and 10 (1 = exactly the target, 2 = up to double).'),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(OUTLINE_HEADROOM_KEY, n)
  return n
}

/**
 * How long ONE language (LLM) request may hold its socket open, in MINUTES.
 *
 * WHY IT IS A SETTING. It was `GENSTUDIO_LANGUAGE_SUBMIT_TIMEOUT_MS`, a
 * hardcoded 20 minutes in `lib/genstudio-client.ts`. The right number is a
 * property of the model and provider chosen on the day, not of this code: a
 * 250-scene batch on a slow provider needs longer than the same batch on a
 * fast one, and the owner is the person who knows which he is buying. His
 * ruling (2026-08-29) raised the default to 30 minutes and made it a dial.
 *
 * WHY IT IS APP-LEVEL, NOT PER-PROJECT. The value is consumed inside
 * `submitLanguageJson`, the transport layer, which has no project and no slug
 * — every language call in the app goes through it, including ones with no
 * project at all (catalogue reads, content-pack work). Its siblings here —
 * `llm_concurrency`, `outline_chapter_headroom` — are the same shape: numbers
 * about how this install talks to GenStudio. Per-project config exists for
 * numbers that are a property of the CHANNEL (`scene_prompt_*`), which this
 * is not.
 *
 * THE BOUNDS, and where they come from.
 *   5 minutes floor — a typo must not make every language call fail
 *     instantly. Measured 40-scene packs take 33-86 seconds, so five minutes
 *     is already several times the slowest routine request; anything smaller
 *     is a mistake rather than a choice.
 *   240 minutes ceiling — NOT a judgement about what is sensible, just the
 *     point past which the number stops meaning anything: every attempt is
 *     already clamped to whatever remains of the caller's own deadline,
 *     `GENSTUDIO_LONG_JOB_TIMEOUT_MS`, which is 4 hours. A larger value here
 *     would be silently ineffective, and a setting that does nothing is worse
 *     than one that refuses.
 *
 * Raising it is close to free: the cost of too small is losing paid-for work
 * (see the note this replaced in genstudio-client.ts — nine packs, 333
 * scenes, 131 credits, generated and unreachable), while the cost of too
 * large is bounded by that same outer deadline, and cancellation still aborts
 * instantly.
 */
export const LANGUAGE_TIMEOUT_MINUTES_KEY = 'genstudio_language_timeout_minutes'
export const LANGUAGE_TIMEOUT_MINUTES_DEFAULT = 30
export const LANGUAGE_TIMEOUT_MINUTES_MIN = 5
export const LANGUAGE_TIMEOUT_MINUTES_MAX = 240

export async function getLanguageTimeoutMinutes(): Promise<number> {
  const raw = await getAppSetting(LANGUAGE_TIMEOUT_MINUTES_KEY)
  const n = Number(raw)
  // An absent or unusable value is the DEFAULT, never a clamp of the garbage:
  // a file someone hand-edited to `"thirty"` must behave like an unset one.
  if (!Number.isFinite(n) || n < LANGUAGE_TIMEOUT_MINUTES_MIN) return LANGUAGE_TIMEOUT_MINUTES_DEFAULT
  return Math.min(LANGUAGE_TIMEOUT_MINUTES_MAX, n)
}

/** The same number in milliseconds, which is what the client actually wants. */
export async function getLanguageTimeoutMs(): Promise<number> {
  return Math.round(await getLanguageTimeoutMinutes() * 60_000)
}

export async function setLanguageTimeoutMinutes(value: unknown): Promise<number> {
  const n = Number(value)
  if (!Number.isFinite(n) || n < LANGUAGE_TIMEOUT_MINUTES_MIN || n > LANGUAGE_TIMEOUT_MINUTES_MAX) {
    throw Object.assign(
      new Error(
        `How long one writing request may run must be between ${LANGUAGE_TIMEOUT_MINUTES_MIN} and `
        + `${LANGUAGE_TIMEOUT_MINUTES_MAX} minutes. Below ${LANGUAGE_TIMEOUT_MINUTES_MIN} every request `
        + `would fail before a model could answer; above ${LANGUAGE_TIMEOUT_MINUTES_MAX} the job's own `
        + `4-hour deadline stops it anyway, so the extra would do nothing.`,
      ),
      { statusCode: 400, expose: true },
    )
  }
  await setAppSetting(LANGUAGE_TIMEOUT_MINUTES_KEY, n)
  return n
}

/**
 * Provider generation speed, in output tokens per second: the HARD FLOOR a
 * provider may run at and still be eligible at all, and the speed we PREFER.
 *
 * TWO NUMBERS, NOT ONE, and the distinction is the owner's. On 2026-08-29 he
 * first said "keep the floor at 50 tps" and then corrected it the same day:
 * *"our floor is 25 tps, we prefer 50 tps+"*. 25 is the gate; 50 is a
 * preference. A worst-case warning has to be computed against the gate — a
 * provider running at 25 is eligible, so a batch that cannot finish at 25 is a
 * batch that can genuinely be lost.
 *
 * BOTH ARE SETTINGS BECAUSE HE REVISED ONE OF THEM WITHIN A DAY OF SETTING
 * IT. A number he changes is data he owns, not a constant, and the version of
 * this file that shipped them as `const` would have needed a rebuild to carry
 * that correction.
 *
 * STORY STUDIO DOES NOT OWN THE REAL FLOOR. GenStudio picks the provider,
 * holds the routing rules, and is the only place that could enforce a speed
 * gate. Nothing it publishes today carries the figure — its catalogue fields,
 * account overview and fleet config were searched and there is no
 * tokens-per-second anywhere — so these live here purely so the Scene Plan
 * panel can answer "can this batch finish in time?" instead of staying silent.
 * They are used for ONE thing: a non-blocking sentence. Nothing refuses,
 * clamps, retries or routes on them, so being wrong costs an inaccurate
 * warning, never work. If GenStudio ever publishes a real floor, read that.
 *
 * Real speeds are recorded per successful pack (`completionTokens` in
 * generators/scene-plan.ts), so these stop being estimates as soon as somebody
 * reads that log.
 *
 * The 1-10,000 range is not a judgement about plausible hardware, only the
 * span outside which the number stops describing a provider at all: 0 or
 * negative would divide the warning by zero, and 10,000 tok/s is faster than
 * any published model by more than an order of magnitude.
 */
export const LANGUAGE_FLOOR_TPS_KEY = 'language_floor_tokens_per_second'
export const LANGUAGE_FLOOR_TPS_DEFAULT = 25
export const LANGUAGE_PREFERRED_TPS_KEY = 'language_preferred_tokens_per_second'
export const LANGUAGE_PREFERRED_TPS_DEFAULT = 50
export const LANGUAGE_TPS_MIN = 1
export const LANGUAGE_TPS_MAX = 10_000

function readTps(raw: unknown, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < LANGUAGE_TPS_MIN || n > LANGUAGE_TPS_MAX) return fallback
  return n
}

export async function getLanguageFloorTps(): Promise<number> {
  return readTps(await getAppSetting(LANGUAGE_FLOOR_TPS_KEY), LANGUAGE_FLOOR_TPS_DEFAULT)
}

export async function getLanguagePreferredTps(): Promise<number> {
  return readTps(await getAppSetting(LANGUAGE_PREFERRED_TPS_KEY), LANGUAGE_PREFERRED_TPS_DEFAULT)
}

function assertTps(value: unknown, what: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < LANGUAGE_TPS_MIN || n > LANGUAGE_TPS_MAX) {
    throw Object.assign(
      new Error(
        `${what} must be between ${LANGUAGE_TPS_MIN} and ${LANGUAGE_TPS_MAX} tokens a second. `
        + `It is only used to warn you when a batch looks too big to finish in time — nothing `
        + `refuses or reroutes work because of it.`,
      ),
      { statusCode: 400, expose: true },
    )
  }
  return n
}

export async function setLanguageFloorTps(value: unknown): Promise<number> {
  const n = assertTps(value, 'The slowest provider speed you will accept')
  await setAppSetting(LANGUAGE_FLOOR_TPS_KEY, n)
  return n
}

export async function setLanguagePreferredTps(value: unknown): Promise<number> {
  const n = assertTps(value, 'The provider speed you prefer')
  await setAppSetting(LANGUAGE_PREFERRED_TPS_KEY, n)
  return n
}

export const VOICE_PRESETS_KEY = 'voice_presets'
export const VOICE_FAVOURITES_KEY = 'voice_favourites'

export type GlobalVoicePreset = NormalizedVoicePreset

export async function getVoicePresetsGlobal(): Promise<GlobalVoicePreset[]> {
  const v = await getAppSetting(VOICE_PRESETS_KEY)
  return normalizeVoicePresets(v)
}

export async function setVoicePresetsGlobal(value: unknown): Promise<void> {
  await setAppSetting(VOICE_PRESETS_KEY, normalizeVoicePresets(value))
}

export async function getVoiceFavouritesGlobal(): Promise<string[]> {
  const v = await getAppSetting(VOICE_FAVOURITES_KEY)
  if (!Array.isArray(v)) return []
  return v.filter((e): e is string => typeof e === 'string' && e.length > 0)
}

export async function setVoiceFavouritesGlobal(value: string[]): Promise<void> {
  await setAppSetting(VOICE_FAVOURITES_KEY, value)
}

// ── Server mode (headless web UI) ──────────────────────────────────────────
//
// Schema:
//   server_mode: {
//     enabled: boolean
//     port: number
//     bind: string
//     auth?: {
//       username: string
//       password_hash: string       // scrypt salt:hash hex
//       session_secret: string      // 32-byte hex; used to sign session cookies
//       session_ttl_hours: number
//     }
//   }
//
// Reads return a "safe" view (password_hash redacted, surfaced as
// has_credentials: boolean). Setters use withLock to avoid lost updates
// when two settings panels are saved nearly simultaneously.

import crypto from 'crypto'
import { hashPassword, generateAutomationKey, hashAutomationKey } from '../lib/auth-session.js'
import { isServerMode, normalizeAutomationKeys, type AutomationKeyRecord } from '../lib/server-mode.js'

export const SERVER_MODE_KEY = 'server_mode'

export interface ServerModeSafeView {
  /** Persisted JSON value — what the user toggled, controls next launch. */
  enabled: boolean
  /**
   * Resolved state — what `isServerMode()` returns RIGHT NOW. May differ
   * from `enabled` when launchd is forcing it via env var (resolved=true
   * even though JSON enabled=false would mean false). Use this for the
   * "currently in server mode" badge in the UI.
   */
  is_currently_active: boolean
  port: number
  bind: string
  has_credentials: boolean
  username: string | null
  session_ttl_hours: number
  /** v1.0.107+ — per-IP login rate-limit cap. Default 30/min. */
  login_max_attempts_per_minute: number
  /** Automation keys without their hashes. */
  automation_keys: AutomationKeyView[]
}

export type AutomationKeyView = Omit<AutomationKeyRecord, 'hash'>

export interface ServerModeNetworkingPatch {
  enabled?: boolean
  port?: number
  bind?: string
}

const SERVER_MODE_DEFAULTS = {
  enabled: false,
  port: 8765,
  bind: '0.0.0.0',
  session_ttl_hours: 168,
  login_max_attempts_per_minute: 30,
}

/**
 * Read the server-mode settings as a safe view (no password hash).
 * Defaults are filled in for every field so the Settings UI never has to
 * deal with `undefined`. `has_credentials` lets the UI know whether the
 * "Set password" button or the "Change password" button should be shown.
 */
export async function getServerModeSettingsSafe(): Promise<ServerModeSafeView> {
  const settings = await readSettings()
  const sm = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
  const auth = (sm.auth || {}) as Record<string, any>
  return {
    enabled: sm.enabled === true,
    is_currently_active: isServerMode(),
    port: typeof sm.port === 'number' && sm.port > 0 ? sm.port : SERVER_MODE_DEFAULTS.port,
    bind: typeof sm.bind === 'string' && sm.bind ? sm.bind : SERVER_MODE_DEFAULTS.bind,
    has_credentials: !!auth.password_hash && !!auth.session_secret,
    username: typeof auth.username === 'string' && auth.username ? auth.username : null,
    session_ttl_hours: typeof auth.session_ttl_hours === 'number' && auth.session_ttl_hours > 0
      ? auth.session_ttl_hours
      : SERVER_MODE_DEFAULTS.session_ttl_hours,
    login_max_attempts_per_minute:
      typeof auth.login_max_attempts_per_minute === 'number' && auth.login_max_attempts_per_minute > 0
        ? auth.login_max_attempts_per_minute
        : SERVER_MODE_DEFAULTS.login_max_attempts_per_minute,
    automation_keys: normalizeAutomationKeys(sm.automation_keys).map(({ hash: _hash, ...view }) => view),
  }
}

/**
 * Patch the networking part of server-mode settings (enabled / port / bind).
 * Doesn't touch the auth block — credentials are managed separately so a
 * mistyped port can't accidentally clobber the password.
 */
export async function setServerModeNetworking(patch: ServerModeNetworkingPatch): Promise<ServerModeSafeView> {
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    if (patch.enabled !== undefined) cur.enabled = !!patch.enabled
    if (patch.port !== undefined) {
      if (typeof patch.port !== 'number' || patch.port < 1 || patch.port > 65535) {
        throw new Error('port must be an integer between 1 and 65535')
      }
      cur.port = Math.floor(patch.port)
    }
    if (patch.bind !== undefined) {
      if (typeof patch.bind !== 'string' || !patch.bind.trim()) {
        throw new Error('bind must be a non-empty string')
      }
      cur.bind = patch.bind.trim()
    }
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

/**
 * Set or replace the server-mode credentials. Always generates a fresh
 * session_secret on every credential change — implicit "rotate sessions
 * on password change" so a stolen cookie can't outlive the password it
 * was minted under.
 */
export async function setServerModeCredentials(opts: {
  username: string
  password: string
  session_ttl_hours?: number
  login_max_attempts_per_minute?: number
}): Promise<ServerModeSafeView> {
  if (!opts.username || typeof opts.username !== 'string' || !opts.username.trim()) {
    throw new Error('username is required')
  }
  if (!opts.password || typeof opts.password !== 'string' || opts.password.length < 8) {
    throw new Error('password must be at least 8 characters')
  }
  const ttl = typeof opts.session_ttl_hours === 'number' && opts.session_ttl_hours > 0
    ? Math.floor(opts.session_ttl_hours)
    : SERVER_MODE_DEFAULTS.session_ttl_hours
  // Preserve the existing rate-limit knob when the caller doesn't pass
  // one — the credentials form doesn't surface it on every change, so
  // a "Change Password" save shouldn't reset the cap back to the default.
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    const prevAuth = (cur.auth || {}) as Record<string, any>
    const maxAttempts = typeof opts.login_max_attempts_per_minute === 'number'
      && opts.login_max_attempts_per_minute > 0
      ? Math.floor(opts.login_max_attempts_per_minute)
      : (typeof prevAuth.login_max_attempts_per_minute === 'number'
        && prevAuth.login_max_attempts_per_minute > 0
        ? prevAuth.login_max_attempts_per_minute
        : SERVER_MODE_DEFAULTS.login_max_attempts_per_minute)
    const password_hash = hashPassword(opts.password)
    const session_secret = crypto.randomBytes(32).toString('hex')
    cur.auth = {
      username: opts.username.trim(),
      password_hash,
      session_secret,
      session_ttl_hours: ttl,
      login_max_attempts_per_minute: maxAttempts,
    }
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

/**
 * v1.0.107+ — update the rate-limit cap without touching the password.
 * Surfaced as a standalone field in the Server Mode panel so the user
 * can bump it after running into a 429 without re-entering credentials.
 */
export async function setServerModeRateLimit(maxAttemptsPerMinute: number): Promise<ServerModeSafeView> {
  if (typeof maxAttemptsPerMinute !== 'number' || maxAttemptsPerMinute < 1 || maxAttemptsPerMinute > 1000) {
    throw new Error('login_max_attempts_per_minute must be between 1 and 1000')
  }
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    if (!cur.auth || !cur.auth.password_hash) {
      throw new Error('Credentials must be set before adjusting the rate-limit cap')
    }
    cur.auth.login_max_attempts_per_minute = Math.floor(maxAttemptsPerMinute)
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

/**
 * Rotate the session_secret without changing the password. Invalidates
 * every existing signed cookie immediately. Used by the "Sign out
 * everywhere" button in the Settings UI.
 */
export async function rotateServerModeSessionSecret(): Promise<ServerModeSafeView> {
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    if (!cur.auth || !cur.auth.password_hash) {
      throw new Error('No credentials configured — nothing to rotate')
    }
    cur.auth.session_secret = crypto.randomBytes(32).toString('hex')
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  return getServerModeSettingsSafe()
}

// ── Automation keys (server mode) ──────────────────────────────────────────
//
// `server_mode.automation_keys`: see AutomationKeyRecord in lib/server-mode.ts.
// The audit trail is `server-mode-key-audit.jsonl` beside app-settings.json:
// one line per create/revoke, and per key in use at most one line every
// KEY_USE_FLUSH_MS carrying the number of calls since the previous line.

export const MAX_AUTOMATION_KEYS = 5
const AUTOMATION_KEY_LABEL_MAX = 60
const KEY_USE_FLUSH_MS = 10 * 60_000

function automationKeyAuditPath(): string {
  return path.join(path.dirname(appSettingsPath()), 'server-mode-key-audit.jsonl')
}

async function appendAutomationKeyAudit(entry: Record<string, unknown>): Promise<void> {
  const target = automationKeyAuditPath()
  assertWriteIsolatedInTests(target, 'automation-key-audit')
  await fs.appendFile(target, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
}

/** Create a key. The plaintext is returned here once and never stored. */
export async function createServerModeAutomationKey(label: unknown): Promise<{ key: string; view: ServerModeSafeView }> {
  const name = typeof label === 'string' ? label.trim() : ''
  if (!name || name.length > AUTOMATION_KEY_LABEL_MAX) {
    throw new Error(`Give the key a label of 1–${AUTOMATION_KEY_LABEL_MAX} characters, e.g. "Claude on Mac Studio".`)
  }
  const key = generateAutomationKey()
  const record: AutomationKeyRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    label: name,
    hash: hashAutomationKey(key),
    last4: key.slice(-4),
    created_at: new Date().toISOString(),
    last_used_at: null,
  }
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    const keys = normalizeAutomationKeys(cur.automation_keys)
    if (keys.length >= MAX_AUTOMATION_KEYS) {
      throw new Error(`At most ${MAX_AUTOMATION_KEYS} automation keys. Revoke one you no longer use first.`)
    }
    cur.automation_keys = [...keys, record]
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  await appendAutomationKeyAudit({ event: 'created', key_id: record.id, label: record.label, last4: record.last4 })
  return { key, view: await getServerModeSettingsSafe() }
}

/** Revoke a key. The gate re-reads the file per request, so this is immediate. */
export async function revokeServerModeAutomationKey(id: string): Promise<ServerModeSafeView> {
  let removed: AutomationKeyRecord | undefined
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    const cur = (settings[SERVER_MODE_KEY] || {}) as Record<string, any>
    const keys = normalizeAutomationKeys(cur.automation_keys)
    removed = keys.find((k) => k.id === id)
    if (!removed) throw Object.assign(new Error('No automation key with that id.'), { status: 404 })
    cur.automation_keys = keys.filter((k) => k.id !== id)
    settings[SERVER_MODE_KEY] = cur
    await writeSettings(settings)
  })
  await appendAutomationKeyAudit({ event: 'revoked', key_id: id, label: removed!.label, last4: removed!.last4 })
  return getServerModeSettingsSafe()
}

const automationKeyUse = new Map<string, { uses: number; flushedAt: number }>()

/**
 * Count a successful key use. Called synchronously from the auth gate; the
 * first use per process and then at most one per KEY_USE_FLUSH_MS persists
 * last_used_at and appends an audit line, so a busy agent never turns into a
 * settings write per request.
 */
export function recordAutomationKeyUse(key: AutomationKeyRecord, peer: string): void {
  const now = Date.now()
  const use = automationKeyUse.get(key.id) || { uses: 0, flushedAt: 0 }
  use.uses++
  automationKeyUse.set(key.id, use)
  if (now - use.flushedAt < KEY_USE_FLUSH_MS) return
  const uses = use.uses
  use.uses = 0
  use.flushedAt = now
  const at = new Date(now).toISOString()
  void (async () => {
    await withLock(appSettingsPath(), async () => {
      const settings = await readSettingsForWrite()
      const keys = settings[SERVER_MODE_KEY]?.automation_keys
      const stored = Array.isArray(keys) ? keys.find((k: any) => k?.id === key.id) : null
      if (!stored) return // revoked in the meantime
      stored.last_used_at = at
      await writeSettings(settings)
    })
    await appendAutomationKeyAudit({ event: 'used', key_id: key.id, label: key.label, last4: key.last4, peer, uses })
  })().catch(() => { /* bookkeeping only — never fail the request */ })
}

// ── YouTube upload defaults (app-level) ────────────────────────────────────
//
// Two app-level defaults that new uploads inherit when the per-project value
// is not explicitly set:
//   - default_mark_as_ai_generated: bool. Default true (Story Studio's primary
//     use is AI narration / images / video; YouTube requires the disclosure).
//   - default_yt_category_id: number. Default 24 (Entertainment) — best fit
//     for narrative AI / story content.
//
// Per-project values in `config.json` override these. The Settings UI exposes
// both and the backfill action under Settings → YouTube applies the resolved
// values to every previously uploaded video.

export const DEFAULT_MARK_AS_AI_GENERATED_KEY = 'default_mark_as_ai_generated'
export const DEFAULT_YT_CATEGORY_KEY = 'default_yt_category_id'

export interface YoutubeDefaultsView {
  default_mark_as_ai_generated: boolean
  default_yt_category_id: number
}

export async function getYoutubeDefaults(): Promise<YoutubeDefaultsView> {
  const settings = await readSettings()
  const ai = settings[DEFAULT_MARK_AS_AI_GENERATED_KEY]
  const cat = settings[DEFAULT_YT_CATEGORY_KEY]
  return {
    default_mark_as_ai_generated: typeof ai === 'boolean' ? ai : true,
    default_yt_category_id: typeof cat === 'number' && cat > 0 ? cat : 24,
  }
}

export async function setYoutubeDefaults(patch: Partial<YoutubeDefaultsView>): Promise<YoutubeDefaultsView> {
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettingsForWrite()
    if (typeof patch.default_mark_as_ai_generated === 'boolean') {
      settings[DEFAULT_MARK_AS_AI_GENERATED_KEY] = patch.default_mark_as_ai_generated
    }
    if (typeof patch.default_yt_category_id === 'number'
      && Number.isFinite(patch.default_yt_category_id)
      && patch.default_yt_category_id > 0) {
      settings[DEFAULT_YT_CATEGORY_KEY] = Math.floor(patch.default_yt_category_id)
    }
    await writeSettings(settings)
  })
  return getYoutubeDefaults()
}

// ── "What's New" version tracking (per-machine) ────────────────────────────
//
// Stores the last app version the user dismissed the "What's New" modal for.
// Boot detection compares this to package.json's version; on mismatch, the
// modal pops automatically (showing the changelog since last_seen_version).
// Per-machine — different installs (iMac + Mac mini) each track their own
// dismiss state.

export const LAST_SEEN_VERSION_KEY = 'last_seen_version'

export async function getLastSeenVersion(): Promise<string | null> {
  const v = await getAppSetting(LAST_SEEN_VERSION_KEY)
  return typeof v === 'string' && v ? v : null
}

export async function setLastSeenVersion(version: string): Promise<void> {
  if (!version || typeof version !== 'string') return
  await setAppSetting(LAST_SEEN_VERSION_KEY, version)
}

export const GENSTUDIO_URL_KEY = 'genstudio_url'
/**
 * The built-in fallback endpoint — **gateway-kh on `:8787`**, correct as of
 * 2026-09-21.
 *
 * This constant has moved before, because the gateway has moved before: it has
 * answered on `:8000` (old GenStudio, then gateway-kh), been documented at
 * `:8010` for part of 2026-09-18, and on 2026-09-21 the owner moved it to
 * `:8787` to avoid colliding with other local apps. The installed
 * `/Applications/gateway-kh.app` was verified bound to `0.0.0.0:8787` and
 * answering `401` without a key on both loopback and the Tailscale address.
 * A reader who finds a different port in old notes is looking at history.
 *
 * The default is still only a fallback. The owner's saved `genstudio_url` is
 * what every call actually uses (`getGenStudioUrl` below); this value decides
 * only where a fresh, unconfigured install looks first.
 *
 * See `docs/genstudio-handoff/gateway-kh-story-studio-wiring.md` §1.
 */
export const DEFAULT_GENSTUDIO_URL = 'http://127.0.0.1:8787'

/**
 * GenStudio is intentionally configured separately from the local Hub. During
 * the parallel migration the loopback development API is the default; a later
 * production rollout can set the public HTTPS endpoint without changing any
 * Story Studio generation code.
 */
export async function getGenStudioUrl(): Promise<string> {
  const v = await getAppSetting(GENSTUDIO_URL_KEY)
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_GENSTUDIO_URL
}

export async function setGenStudioUrl(url: string): Promise<void> {
  const cleaned = normalizeServiceBaseUrl(typeof url === 'string' ? url : '', 'Gateway')
  await setAppSetting(GENSTUDIO_URL_KEY, cleaned)
}

// ── Disabled endpoints — RETIRED v1.4.176 ───────────────────────────────────
//
// `endpoint_disabled` and `endpoint_labels` are read by nothing. They were part
// of the retired direct-connection feature: naming and switching off individual
// local Image Studio / Voice Studio / Chat Studio Macs, which only the (now
// deleted) `lib/endpoint-pool.ts` understood.
//
// The keys are deliberately LEFT ON DISK. Nothing reads them, nothing writes
// them, and no migration removes them: they are the owner's record of which
// machines used to serve which provider, and rewriting a customer's settings
// file to tidy up our own dead code is not a trade this app makes. Same for
// `hub_url`. A future reader who finds them should treat them as history, not
// as configuration — the live inventory and dispatch path is `genstudio_url`
// alone, and it must stay that way (see `DEFAULT_GENSTUDIO_URL`).

/**
 * Bootstrap helper: if server mode is enabled but no credentials exist,
 * AND `STORY_STUDIO_INITIAL_USERNAME` + `STORY_STUDIO_INITIAL_PASSWORD`
 * env vars are present, persist them. Called once at app boot from
 * electron/main.ts so a fresh launchd-managed install can land
 * pre-configured. After the first successful boot, the env vars are
 * logged-and-ignored — they're a one-shot escape hatch, not a config
 * surface.
 */
export async function bootstrapServerModeFromEnv(): Promise<{ bootstrapped: boolean; reason?: string }> {
  const u = process.env.STORY_STUDIO_INITIAL_USERNAME
  const p = process.env.STORY_STUDIO_INITIAL_PASSWORD
  if (!u || !p) return { bootstrapped: false, reason: 'env vars not set' }
  const safe = await getServerModeSettingsSafe()
  if (safe.has_credentials) return { bootstrapped: false, reason: 'credentials already present' }
  try {
    await setServerModeCredentials({ username: u, password: p })
    return { bootstrapped: true }
  } catch (e: any) {
    return { bootstrapped: false, reason: e?.message || String(e) }
  }
}

export const COST_SETTINGS_KEY = 'cost_settings'

export async function getCostSettings(): Promise<CostSettings> {
  const settings = await readSettings()
  const raw = settings[COST_SETTINGS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_COST_SETTINGS, mac_power_watts: { ...DEFAULT_COST_SETTINGS.mac_power_watts } }
  }
  const khrPerKwh = typeof raw.electricity_khr_per_kwh === 'number' && Number.isFinite(raw.electricity_khr_per_kwh) && raw.electricity_khr_per_kwh >= 0
    ? raw.electricity_khr_per_kwh
    : DEFAULT_COST_SETTINGS.electricity_khr_per_kwh
  const khrPerUsd = typeof raw.khr_per_usd === 'number' && Number.isFinite(raw.khr_per_usd) && raw.khr_per_usd > 0
    ? raw.khr_per_usd
    : DEFAULT_COST_SETTINGS.khr_per_usd
  const macPowerWatts: Record<string, number> = { ...DEFAULT_COST_SETTINGS.mac_power_watts }
  if (raw.mac_power_watts && typeof raw.mac_power_watts === 'object' && !Array.isArray(raw.mac_power_watts)) {
    for (const [k, v] of Object.entries(raw.mac_power_watts)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        macPowerWatts[k.toLowerCase()] = v
      }
    }
  }
  return {
    electricity_khr_per_kwh: khrPerKwh,
    khr_per_usd: khrPerUsd,
    mac_power_watts: macPowerWatts,
  }
}

export async function setCostSettings(patch: unknown): Promise<CostSettings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Cost settings payload must be an object')
  }
  const current = await getCostSettings()
  const p = patch as Record<string, unknown>
  if (p.electricity_khr_per_kwh !== undefined) {
    if (typeof p.electricity_khr_per_kwh !== 'number' || !Number.isFinite(p.electricity_khr_per_kwh) || p.electricity_khr_per_kwh < 0) {
      throw new Error('electricity_khr_per_kwh must be a non-negative number')
    }
    current.electricity_khr_per_kwh = p.electricity_khr_per_kwh
  }
  if (p.khr_per_usd !== undefined) {
    if (typeof p.khr_per_usd !== 'number' || !Number.isFinite(p.khr_per_usd) || p.khr_per_usd <= 0) {
      throw new Error('khr_per_usd must be a positive number')
    }
    current.khr_per_usd = p.khr_per_usd
  }
  if (p.mac_power_watts !== undefined) {
    if (!p.mac_power_watts || typeof p.mac_power_watts !== 'object' || Array.isArray(p.mac_power_watts)) {
      throw new Error('mac_power_watts must be an object')
    }
    for (const [k, v] of Object.entries(p.mac_power_watts as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`mac_power_watts.${k} must be a non-negative number`)
      }
      current.mac_power_watts[k.toLowerCase()] = v
    }
  }
  await setAppSetting(COST_SETTINGS_KEY, current)
  return current
}
