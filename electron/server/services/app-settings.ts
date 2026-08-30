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
  return readJsonOr<AppSettings>(target, {})
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const target = appSettingsPath()
  // Under the node test runner, writing outside the claimed data dir is a hard
  // error rather than a silent write to the developer's real app-settings.json.
  // See lib/test-isolation.ts for why this compares the resolved target.
  assertWriteIsolatedInTests(target, 'app-settings')
  await writeJsonAtomic(target, settings, { mode: APP_SETTINGS_MODE })
}

export async function getAppSetting(key: string): Promise<any> {
  const settings = await readSettings()
  return settings[key]
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

export async function setAppSetting(key: string, value: any): Promise<void> {
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettings()
    settings[key] = value
    await writeSettings(settings)
  })
  announceWrite(key)
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
 * DEFAULT 3, NOT 1 AND NOT 30. One leaves the fleet idle, which is what he just
 * hit. Thirty is the 2026-08-22 transcription flood, where 122 of 353 items were
 * refused. Three episodes at roughly 25 concurrent requests each is about 75
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

/**
 * Returns true when neither key exists yet — the boot migration uses
 * this to decide whether to run the per-project merge. We require BOTH
 * to be unset so a partial migration (e.g. presets set, favourites not)
 * doesn't trigger a re-merge that would reintroduce already-removed
 * entries.
 */
export async function voiceCurationGlobalIsUnset(): Promise<boolean> {
  const settings = await readSettings()
  return settings[VOICE_PRESETS_KEY] === undefined
    && settings[VOICE_FAVOURITES_KEY] === undefined
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
import { hashPassword } from '../lib/auth-session.js'
import { isServerMode } from '../lib/server-mode.js'

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
}

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
  }
}

/**
 * Patch the networking part of server-mode settings (enabled / port / bind).
 * Doesn't touch the auth block — credentials are managed separately so a
 * mistyped port can't accidentally clobber the password.
 */
export async function setServerModeNetworking(patch: ServerModeNetworkingPatch): Promise<ServerModeSafeView> {
  await withLock(appSettingsPath(), async () => {
    const settings = await readSettings()
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
    const settings = await readSettings()
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
    const settings = await readSettings()
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
    const settings = await readSettings()
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
    const settings = await readSettings()
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
export const DEFAULT_GENSTUDIO_URL = 'http://127.0.0.1:8000'

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
  const cleaned = normalizeServiceBaseUrl(typeof url === 'string' ? url : '', 'GenStudio')
  await setAppSetting(GENSTUDIO_URL_KEY, cleaned)
}

// ── Disabled endpoints (v1.0.311) ───────────────────────────────────────────
//
// Which local-modal endpoints the user has manually switched OFF in Settings.
// A disabled endpoint is never probed or dispatched to (see endpoint-pool.ts
// parseEnabledEndpoints). Stored SEPARATELY from the URL list (which stays a
// plain comma-joined string).
//   app-settings.json
//     "endpoint_disabled": { "<providerId>": ["http://host:port"], ... }
// Keyed by provider id → array of cleaned (trailing-slash-stripped) URLs.
//
// The per-provider getter/setter pair that used to back the (now-retired)
// Image Studio / Voice Studio direct-connection settings panes is gone. What
// remains is the boot-time reader: getAllDisabledEndpoints() still primes the
// in-memory endpoint-pool registry at startup (boot/migrations.ts) for
// whatever provider entries are already on disk.

export const ENDPOINT_DISABLED_KEY = 'endpoint_disabled'
type EndpointDisabledStore = Record<string, string[]>

/** Every provider's disabled set — used to prime the in-memory registry at boot. */
export async function getAllDisabledEndpoints(): Promise<EndpointDisabledStore> {
  const all = (await getAppSetting(ENDPOINT_DISABLED_KEY)) as EndpointDisabledStore | undefined
  return all && typeof all === 'object' ? all : {}
}

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
