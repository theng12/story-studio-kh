/**
 * A channel's per-episode starting length, and the random draw that fixes it.
 *
 * A Quote Shorts Formula asks for a Short, not a one-minute episode: its
 * length belongs to the individual Short, and the owner asked for it to VARY
 * from episode to episode inside a range (10–60 s, 2026-10-29). This module is
 * the one place that answers three questions:
 *
 *   1. What range and fixed value does this channel have? A channel copies its
 *      Formula's values into `config.json` at creation
 *      (services/formula-starting-defaults.ts) and can change them afterwards.
 *      A channel with no copy — every channel created before 1.4.369 — reads
 *      the Formula LIVE, so an existing Quote Shorts channel starts its next
 *      new episode inside 10–60 s without anything on disk being rewritten.
 *   2. What length does one new episode get? `drawEpisodeLengthSeconds` draws
 *      an integer number of seconds uniformly inside the range. The caller
 *      stores it on the episode; nothing redraws it on reload or retry.
 *   3. How does a length in seconds become the words the script needs? Through
 *      `scriptLengthMinutes` into the existing `lib/script-sizing.ts` path
 *      (`round(minutes × wpm ÷ chapters)`), never a fixed words-per-second
 *      ratio of its own.
 *
 * This is a STARTING value, never a limit (AGENTS.md §5): the episode's own
 * words-per-chapter controls its real length, and nothing here refuses a
 * length the customer types.
 */

import type { EpisodeLengthSetting, ScriptFormat } from '../models/types.js'

type LengthScript = Pick<
  Partial<ScriptFormat>,
  'defaultLengthMinutes' | 'defaultLengthSeconds' | 'lengthMinutesRange' | 'lengthSecondsRange' | 'randomizeLength'
> | null | undefined

const MIN_SECONDS = 1
const MAX_SECONDS = 3600

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function inRange(value: number | null): value is number {
  return value !== null && value >= MIN_SECONDS && value <= MAX_SECONDS
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const min = seconds(value[0])
  const max = seconds(value[1])
  if (!inRange(min) || !inRange(max) || max < min) return null
  return [min, max]
}

/**
 * The stored channel setting, or `null` when it is absent or unusable.
 *
 * Unusable means the same thing as absent on purpose: a hand-edited or
 * half-written value must not become a length nobody chose. The number of
 * seconds is rounded to a whole second — a Short is not timed to a fraction.
 */
export function normalizeEpisodeLengthSetting(value: unknown): EpisodeLengthSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.mode !== 'random' && raw.mode !== 'fixed') return null
  const min = seconds(raw.min_sec)
  const max = seconds(raw.max_sec)
  const fixed = seconds(raw.fixed_sec)
  if (!inRange(min) || !inRange(max) || max < min) return null
  if (!inRange(fixed)) return null
  return { mode: raw.mode, min_sec: min, max_sec: max, fixed_sec: fixed }
}

/**
 * What a Formula declares as its starting length.
 *
 * A random starting length needs BOTH a range and the fixed value used when
 * the draw is switched off. Declaring only a range would leave "off" meaning
 * nothing, so it is reported as no starting length rather than a value
 * invented here (§6).
 */
export function episodeLengthSettingFromScript(script: LengthScript): EpisodeLengthSetting | null {
  if (!script) return null
  const fixed = seconds(script.defaultLengthSeconds)
  const range = pair(script.lengthSecondsRange)
  if (script.randomizeLength === true && range && inRange(fixed)) {
    return { mode: 'random', min_sec: range[0], max_sec: range[1], fixed_sec: fixed }
  }
  if (inRange(fixed)) {
    return { mode: 'fixed', min_sec: fixed, max_sec: fixed, fixed_sec: fixed }
  }
  return null
}

/**
 * The setting this channel actually uses for a NEW episode.
 *
 * The channel's own saved value wins, even when it disagrees with its Formula:
 * the customer changed it deliberately. With no saved value the Formula is
 * read live (see the module comment), and a Formula with no seconds-precision
 * length — every long-form one — resolves to `null`, which means "behave
 * exactly as before".
 */
export function resolveEpisodeLengthSetting(
  channelValue: unknown,
  script: LengthScript,
): EpisodeLengthSetting | null {
  return normalizeEpisodeLengthSetting(channelValue) ?? episodeLengthSettingFromScript(script)
}

/**
 * One episode's starting length, in whole seconds.
 *
 * Uniform over the inclusive whole-second range: `rng()` is clamped to
 * [0, 1) so a stub returning exactly 1 still lands inside the range. The RNG
 * is a parameter so the draw can be pinned in tests; production passes
 * `Math.random`.
 */
export function drawEpisodeLengthSeconds(
  setting: EpisodeLengthSetting,
  rng: () => number = Math.random,
): number {
  if (setting.mode === 'fixed') return Math.round(setting.fixed_sec)
  const min = Math.ceil(setting.min_sec)
  const max = Math.floor(setting.max_sec)
  if (max <= min) return min
  const roll = Number(rng())
  const unit = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1 - Number.EPSILON) : 0
  return min + Math.floor(unit * (max - min + 1))
}

/** How an episode's stored length reads everywhere: `"37 s"`. */
export function formatLengthSuggestion(secondsValue: number): string {
  return `${Math.round(secondsValue)} s`
}

/** Read a stored `"37 s"` / `"45 min"` suggestion back as seconds, or null. */
export function parseLengthSuggestionSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)]
  if (parts.length) {
    let total = 0
    for (const part of parts) {
      const amount = Number(part[1])
      const unit = part[2]!.toLowerCase()
      if (unit.startsWith('h')) total += amount * 3600
      else if (unit.startsWith('m')) total += amount * 60
      else total += amount
    }
    return total > 0 ? total : null
  }
  const plain = text.match(/(\d+(?:\.\d+)?)/)
  if (!plain) return null
  const minutes = Number(plain[1])
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null
}

/**
 * The Formula's own default length as minutes, seconds-precision first.
 *
 * `null` means the Formula publishes no usable length — the caller keeps its
 * existing fallback rather than receiving an invented number (§6).
 */
export function scriptLengthMinutes(script: LengthScript): number | null {
  if (!script) return null
  const secs = seconds(script.defaultLengthSeconds)
  if (inRange(secs)) return secs / 60
  const minutes = script.defaultLengthMinutes
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return minutes
  return null
}

/**
 * The length sentence an idea prompt should carry. Seconds when the Formula
 * declares them, its whole-minute range otherwise — one shape, so the paste
 * prompt, the freeform generator and the campaign generator cannot drift.
 */
export function formulaLengthPrompt(script: LengthScript): { example: string; oneOf: string } {
  if (!script) return { example: '45 min', oneOf: '"45 min"' }
  const range = pair(script.lengthSecondsRange)
  if (range) {
    const fixed = seconds(script.defaultLengthSeconds)
    const example = `${inRange(fixed) ? fixed : range[0]} s`
    const oneOf = range[0] === range[1]
      ? `"${range[0]} s"`
      : `any duration between "${range[0]} s" and "${range[1]} s" (written like "${example}")`
    return { example, oneOf }
  }
  const minutes = script.defaultLengthMinutes
  const example = `${typeof minutes === 'number' && minutes > 0 ? minutes : 45} min`
  return { example, oneOf: `"${example}"` }
}
