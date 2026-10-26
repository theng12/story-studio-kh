/**
 * Narration plausibility — is the audio about as long as this text should take?
 *
 * WHY THIS EXISTS. DM0018's Khmer narration came out as gibberish (owner,
 * 2026-10-26) and nothing noticed: the transcript-based audio-quality check needs
 * a usable transcript, and there is no speech recognition for Khmer by design
 * (owner, 2026-10-25 — Khmer is subtitled with script timing). A take that reads
 * half the expected words per second is a fact you can measure without hearing a
 * single word: the script's own length against the audio's own length, compared
 * with how fast the voice read everything it was given before.
 *
 * WHAT DECIDES. The band is LEARNED from real accepted takes — never a constant
 * presented as the model's own (AGENTS.md §1). Median characters per second over
 * earlier sections of the same voice and language; the tolerance is three median
 * absolute deviations, floored at ±25% and capped at ±50%. On the owner's real
 * data (2026-10-26) a channel's accepted takes sat within ±8.5% of their median,
 * no accepted section fell outside the floored ±25% band (0 of 92 for
 * domnak-kmouch, 0 of 20–40 for three English channels, leave-one-out), and all
 * 20 sections of DM0018 — 4.62–5.13 characters per second against the channel's
 * 9.94 — sat far outside it.
 *
 * WHEN IT CANNOT DECIDE it says so. Too few earlier takes is
 * `insufficient_history`, an unreadable script or audio length is `unmeasurable`
 * — never `pass` (AGENTS.md §6). A section under MIN_CHARS is unmeasurable
 * because pauses dominate the rate at that length, not because it is fine.
 *
 * Character count, not syllables or grapheme clusters: measured on the same real
 * data, plain characters separate exactly as well (they are proportional within a
 * language), and they are the count the app already computes and the generator
 * already logs and splits by (`narrationTextStats`). A Khmer-specific unit would
 * add a second definition of "how much text is this" for no extra separation.
 *
 * Units are characters per second of the ACTIVE take's own files — the chapter as
 * Audio Assembly uses it, pauses included, so every take of a voice is measured
 * the same way.
 */
import fs from 'fs/promises'
import path from 'path'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import type {
  NarrationPlausibilityBand,
  NarrationPlausibilityBasis,
  NarrationPlausibilityEvidence,
} from '../contracts/narration-plausibility.js'
import { narrationTextStats } from './audio-reconciler.js'
import { activeAudioChapters, readCurrentChapterScript } from './audio-quality.js'
import { readAudioTtsModelRecord } from './audio-tts-model-record.js'
import { resolveEpisodePathsByCodeWithSidecar } from './utils.js'
import { dominantScript } from './tts-language-guard.js'

/**
 * Policy, not a model figure. `robust_z` × MAD sets the band from the take's own
 * history; the floor keeps three unusually even takes from making every later
 * one look wrong; the cap stops a noisy history from widening the band into
 * uselessness. `history_episodes` bounds a filesystem walk on a 200-episode
 * channel.
 */
export const RATE_POLICY = {
  min_samples: 6,
  robust_z: 3,
  min_tolerance: 0.25,
  max_tolerance: 0.5,
  /** Below this, pauses dominate the rate and the number says nothing. */
  min_chars: 600,
  /** Bound the walk and the work behind one status request (a 200-episode channel). */
  history_episodes: 4,
  max_sections_per_episode: 12,
  max_samples: 60,
} as const

const POOL_TTL_MS = 5 * 60_000

export interface NarrationPlausibilityInput {
  projectSlug: string
  projectDir: string
  episodeCode: string
  episodeDir: string
  audioDir: string
  scriptDir: string
  /** Duration reader; tests supply their own so no ffmpeg is needed. */
  probe?: (filePath: string) => Promise<number | undefined>
}

interface PooledTake {
  episode: string
  model: string | null
  language: string
  chars_per_second: number
}

interface Pool {
  at: number
  takes: PooledTake[]
}

const pools = new Map<string, Pool>()

/** Test seam: forget learned bands. */
export function _clearNarrationPlausibilityPool(): void {
  pools.clear()
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The band an accepted history implies, or an honest "not enough history". */
export function rateBand(samples: number[]): NarrationPlausibilityBand {
  const usable = samples.filter(value => Number.isFinite(value) && value > 0)
  if (usable.length < RATE_POLICY.min_samples) return { state: 'insufficient_history', samples: usable.length }
  const center = median(usable)
  const mad = median(usable.map(value => Math.abs(value - center)))
  const tolerance = Math.min(RATE_POLICY.max_tolerance,
    Math.max(RATE_POLICY.min_tolerance, RATE_POLICY.robust_z * mad / center))
  return {
    state: 'measured',
    samples: usable.length,
    median_chars_per_second: round(center),
    tolerance_percent: Math.round(tolerance * 100),
    low_chars_per_second: round(center * (1 - tolerance)),
    high_chars_per_second: round(center * (1 + tolerance)),
  }
}

function subjectFor(basis: NarrationPlausibilityBasis | undefined): string {
  return basis === 'channel_history' ? "this channel's narration" : 'this voice'
}

/** Judge one take against its band. Pure: the numbers in, the sentence out. */
export function judgeNarrationRate(input: {
  chars: number | null
  durationSec: number | null
  band: NarrationPlausibilityBand
}): NarrationPlausibilityEvidence {
  const { band } = input
  const chars = input.chars
  const duration = input.durationSec
  const evidence = (state: NarrationPlausibilityEvidence['state'], detail: string,
    charsPerSecond: number | null): NarrationPlausibilityEvidence => ({
    state, chars, duration_sec: duration === null ? null : round(duration, 1),
    chars_per_second: charsPerSecond, band, detail,
  })

  if (!chars) return evidence('unmeasurable', 'This section has no script text to compare with.', null)
  if (chars < RATE_POLICY.min_chars) {
    return evidence('unmeasurable',
      `${chars.toLocaleString()} characters is too little text to judge a reading rate — pauses decide the length at this size.`, null)
  }
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return evidence('unmeasurable', "This take's length could not be measured, so its reading rate is unknown.", null)
  }
  const rate = chars / duration
  if (band.state !== 'measured' || band.low_chars_per_second === undefined || band.high_chars_per_second === undefined) {
    return evidence('insufficient_history',
      `${chars.toLocaleString()} characters were read in ${Math.round(duration)} s (${round(rate)} characters per second). `
      + 'Not enough earlier accepted takes exist yet to say whether that is unusual.',
      round(rate))
  }
  const subject = subjectFor(band.basis)
  const low = band.low_chars_per_second
  const high = band.high_chars_per_second
  const center = band.median_chars_per_second ?? rate
  if (rate >= low && rate <= high) {
    return evidence('pass',
      `${chars.toLocaleString()} characters in ${Math.round(duration)} s (${round(rate)} characters per second) is within `
      + `the ${low}–${high} usual range for ${subject} (${center} across ${band.samples} earlier takes).`,
      round(rate))
  }
  const expected = Math.round(chars / center)
  const factor = round(rate < center ? center / rate : rate / center, 1)
  return evidence('flagged',
    `This take reads ${factor}× ${rate < center ? 'slower' : 'faster'} than ${subject} usually reads: `
    + `${chars.toLocaleString()} characters in ${Math.round(duration)} s is ${round(rate)} characters per second, `
    + `against the usual ${low}–${high} (${center} across ${band.samples} earlier takes). `
    + `At that usual rate this script should run about ${expected} s. Listen to this take before Audio Assembly.`,
    round(rate))
}

/** The newest episode folders that carry narration, current episode excluded. */
async function recentEpisodeCodes(projectDir: string, episodeCode: string): Promise<string[]> {
  const root = path.join(projectDir, 'episodes')
  const found: Array<{ code: string; at: number }> = []
  for (const season of await fs.readdir(root).catch(() => [] as string[])) {
    for (const folder of await fs.readdir(path.join(root, season)).catch(() => [] as string[])) {
      const code = folder.split(' - ')[0]
      if (!code || code.toUpperCase() === episodeCode.toUpperCase()) continue
      const stat = await fs.stat(path.join(root, season, folder, 'audio_chapters.json')).catch(() => null)
      if (!stat?.isFile()) continue
      found.push({ code: code.toUpperCase(), at: stat.mtimeMs })
    }
  }
  // One sample set per episode: a renamed sibling folder shares its code.
  const newest = new Map<string, number>()
  for (const entry of found) newest.set(entry.code, Math.max(newest.get(entry.code) ?? 0, entry.at))
  return [...newest.entries()].sort((left, right) => right[1] - left[1])
    .slice(0, RATE_POLICY.history_episodes)
    .map(([code]) => code)
}

async function takeMeasure(input: {
  scriptDir: string
  audioDir: string
  code: string
  slug: string
  files: string[]
  probe: (filePath: string) => Promise<number | undefined>
}): Promise<{ chars: number | null; durationSec: number | null; language: string }> {
  const text = await readCurrentChapterScript(input.scriptDir, input.code, input.slug)
  const chars = text ? narrationTextStats(text).characterCount : null
  const language = text ? dominantScript(text)?.name ?? 'latin' : 'unknown'
  let durationSec = 0
  for (const file of input.files) {
    const measured = await input.probe(path.join(input.audioDir, file)).catch(() => undefined)
    if (!measured || measured <= 0) return { chars, durationSec: null, language }
    durationSec += measured
  }
  return { chars, durationSec: durationSec || null, language }
}

/** Learn this project's accepted rate from recent episodes (cached, bounded). */
async function acceptedTakes(input: NarrationPlausibilityInput,
  probe: (filePath: string) => Promise<number | undefined>): Promise<PooledTake[]> {
  const key = `${input.projectSlug}\u0000${input.episodeCode.toUpperCase()}`
  const cached = pools.get(key)
  if (cached && Date.now() - cached.at < POOL_TTL_MS) return cached.takes

  const takes: PooledTake[] = []
  for (const code of await recentEpisodeCodes(input.projectDir, input.episodeCode)) {
    if (takes.length >= RATE_POLICY.max_samples) break
    let paths
    try { paths = await resolveEpisodePathsByCodeWithSidecar(input.projectSlug, code, 'audio_chapters.json') }
    catch { continue }
    const model = (await readAudioTtsModelRecord(paths.episode_dir).catch(() => null))?.model_id || null
    const chapters = (await activeAudioChapters(paths.episode_dir)).slice(0, RATE_POLICY.max_sections_per_episode)
    for (const chapter of chapters) {
      const measured = await takeMeasure({
        scriptDir: paths.script_dir, audioDir: paths.audio_dir, code, slug: chapter.slug,
        files: chapter.source_files, probe,
      })
      if (!measured.chars || !measured.durationSec || measured.chars < RATE_POLICY.min_chars) continue
      takes.push({
        episode: code, model, language: measured.language,
        chars_per_second: measured.chars / measured.durationSec,
      })
    }
  }
  pools.set(key, { at: Date.now(), takes })
  return takes
}

/**
 * The sections this episode has audio for: the active selection's rows, or — for
 * an episode Audio Assembly has not run on yet — the base files in the audio
 * folder, which are implicitly active.
 */
async function currentAudioSections(audioDir: string, code: string, episodeDir: string): Promise<Array<{ slug: string, files: string[] }>> {
  const rows = await activeAudioChapters(episodeDir)
  if (rows.length) return rows.map(row => ({ slug: row.slug, files: row.source_files }))
  const entries = await fs.readdir(audioDir).catch(() => [] as string[])
  const pattern = new RegExp(`^${code}_(.+?)(?:_part\\d+)?(?:_v\\d+)?\\.mp3$`, 'i')
  const groups = new Map<string, string[]>()
  for (const entry of entries.sort()) {
    const match = pattern.exec(entry)
    if (!match) continue
    if (/_v\d+\.mp3$/i.test(entry)) continue
    const slug = match[1]!
    groups.set(slug, [...(groups.get(slug) || []), entry])
  }
  return [...groups].map(([slug, files]) => ({ slug, files }))
}

/**
 * Per-section evidence for one episode, keyed by section slug. Never throws for
 * missing evidence: an unreadable script or length is a state, not an error.
 */
export async function inspectNarrationPlausibility(
  input: NarrationPlausibilityInput,
): Promise<Record<string, NarrationPlausibilityEvidence>> {
  const probe = input.probe || getAudioDuration
  const code = input.episodeCode.toUpperCase()
  const sections = await currentAudioSections(input.audioDir, code, input.episodeDir)
  if (!sections.length) return {}
  const takes = await acceptedTakes(input, probe)
  const model = (await readAudioTtsModelRecord(input.episodeDir).catch(() => null))?.model_id || null

  const result: Record<string, NarrationPlausibilityEvidence> = {}
  for (const section of sections) {
    const measured = await takeMeasure({
      scriptDir: input.scriptDir, audioDir: input.audioDir, code, slug: section.slug,
      files: section.files, probe,
    })
    const sameLanguage = takes.filter(take => take.language === measured.language)
    const voiceSamples = sameLanguage.filter(take => model !== null && take.model === model)
    const voiceBand = rateBand(voiceSamples.map(take => take.chars_per_second))
    let band = voiceBand
    let basis: NarrationPlausibilityBasis = 'voice_history'
    if (voiceBand.state !== 'measured') {
      band = rateBand(sameLanguage.map(take => take.chars_per_second))
      basis = 'channel_history'
    }
    if (band.state === 'measured') band = { ...band, basis }
    result[section.slug] = judgeNarrationRate({ chars: measured.chars, durationSec: measured.durationSec, band })
  }
  return result
}
