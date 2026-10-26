/**
 * The unit of every level that reaches an audio generator — in ONE place.
 *
 * A generator speaks LINEAR GAIN: `1` leaves the source as it is, `0.08` is 8%
 * of it, `2` is twice as loud. That is the unit FFmpeg's `volume=` filter takes
 * and the unit every mix in this app is written in (see the `AudioMergeRequest`
 * / `VideoMusicConfig` / `AudioMergeIntro` / `VideoBackgroundNoise` /
 * `AmbientTrack` fields, each documented as linear gain).
 *
 * The UI speaks PERCENT: a slider says "8%", the form holds `8`, and a saved
 * preset stores that `8` unchanged. So a percent value must be converted here,
 * exactly ONCE, when a preset is merged into a generator request — never at the
 * generator boundary, and never by guessing from a value's size.
 *
 * The guess is the defect this file exists to prevent: `1` is 1% from a preset
 * and unity from a caller that already speaks gain, so `value > 1 ? /100 : keep`
 * is wrong in both directions. DM0018/PR0039 were mixed with an 8% bed that
 * reached the generator as `8` — eight times louder than the voice (owner,
 * 2026-10-26/27).
 */
export type LinearGain = number
export type PercentGain = number

/**
 * A preset's percent level as the generator's linear gain: `8 → 0.08`,
 * `100 → 1`, `1 → 0.01`.
 *
 * A numeric string is still a percent (`'8' → 0.08`) — a hand-edited or
 * imported preset is not an excuse to forward the raw value into a gain field.
 * Anything that states no level (absent, `null`, `''`, junk) returns
 * `undefined`, so the caller omits the field and the generator's own default
 * applies; it is never passed through unconverted.
 */
export function percentGainToLinear(value: unknown): LinearGain | undefined {
  const percent = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(percent)) return undefined
  // A negative level is not a choice any slider offers; 0 is (silence).
  return Math.max(0, percent) / 100
}

/** The same conversion clamped to the 0–1 range FFmpeg treats as attenuation. */
export function percentGainToUnitLinear(value: unknown): LinearGain | undefined {
  const gain = percentGainToLinear(value)
  return gain === undefined ? undefined : Math.min(1, gain)
}
