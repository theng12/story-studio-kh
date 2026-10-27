/**
 * The duplicate-screening switch — app-level, per Mac, OFF by default.
 *
 * Owner, 2026-10-27: the model runs INSIDE Story Studio on the Mac running
 * Story, and it is **optional extra screening, never required**. So the switch
 * lives in `app-settings.json` beside every other "This Mac" knob, it starts
 * `false`, and nothing else in the app reads it as a requirement. Uploading
 * without it works exactly as it always has.
 *
 * Two separate facts, deliberately not folded into one boolean (§6):
 *
 * - `enabled` — the owner turned it on.
 * - `installed` — the weights and runtime are on this disk, verified.
 *
 * "On but not downloaded" and "downloaded but off" are different states with
 * different next steps, and a single flag would have to lie about one of them.
 */
import { getAppSetting, setAppSetting } from './app-settings.js'

/** The key in `app-settings.json`. */
export const LOCAL_SCREENING_SETTING_KEY = 'local_duplicate_screening'

export interface LocalScreeningSettings {
  /** The owner's switch. OFF unless they turned it on. */
  enabled: boolean
  /**
   * Compare this episode's scenes against the channel's recent episodes as
   * well as against each other. ON by default *once the feature is on* — it is
   * the more useful half of the check — and it never changes what `enabled`
   * means.
   */
  compare_recent_episodes: boolean
}

export const LOCAL_SCREENING_DEFAULTS: LocalScreeningSettings = {
  enabled: false,
  compare_recent_episodes: true,
}

/**
 * The stored settings, defaulted. Read fresh on every call and never cached
 * past it: the switch decides whether a worker is started at all, so a stale
 * copy would keep screening after the owner turned it off.
 */
export async function localScreeningSettings(): Promise<LocalScreeningSettings> {
  const raw = await getAppSetting(LOCAL_SCREENING_SETTING_KEY).catch(() => undefined)
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    enabled: value.enabled === true,
    compare_recent_episodes: value.compare_recent_episodes === undefined
      ? LOCAL_SCREENING_DEFAULTS.compare_recent_episodes
      : value.compare_recent_episodes === true,
  }
}

export async function setLocalScreeningSettings(patch: Partial<LocalScreeningSettings>): Promise<LocalScreeningSettings> {
  const current = await localScreeningSettings()
  const next: LocalScreeningSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    compare_recent_episodes: typeof patch.compare_recent_episodes === 'boolean'
      ? patch.compare_recent_episodes
      : current.compare_recent_episodes,
  }
  await setAppSetting(LOCAL_SCREENING_SETTING_KEY, next)
  return next
}
