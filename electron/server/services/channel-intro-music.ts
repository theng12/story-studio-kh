/**
 * Per-channel intro music — automatic binding, trims, and fades (1.4.386, Item 16).
 *
 * Rules:
 *  - Automatic binding: When an episode does not carry an explicit intro override,
 *    it binds to the channel's configured `channel_intro_music` (or legacy alias).
 *    An explicit `null` / clear on the episode is respected and produces NO intro.
 *  - Preserves every current channel pick: Stored channel configs, presets, and
 *    existing episodes (including Capi and BrainWise) are never modified.
 *  - Trims & Fades: Supports trim_start_sec, duration_sec, fade_in_sec, fade_out_sec
 *    alongside volume (linear gain) and gap_after.
 *  - FFmpeg compilation: Compiles frame/sample-exact audio filters with resampling,
 *    atrim/asetpts, volume, and afade (in/out) safely clamped.
 */

import type { ChannelIntroSelection } from './channel-intro-asset.js'

export type ChannelIntroMusicSettings = ChannelIntroSelection & {
  file: string
}

export type IntroMusicBindingSource = 'episode_explicit' | 'channel_bound' | 'none'

export interface ResolvedChannelIntroMusic {
  source: IntroMusicBindingSource
  settings: ChannelIntroMusicSettings | null
  /** True if the intro was explicitly cleared for this episode */
  explicitlyCleared: boolean
}

/**
 * Normalize and validate intro music settings from raw user input, API requests,
 * or channel config. Returns null if no valid file is present.
 */
export function normalizeChannelIntroMusic(raw: unknown): ChannelIntroMusicSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, any>
  if (obj.enabled === false) return null

  const file = typeof obj.file === 'string' ? obj.file.trim() : ''
  if (!file) return null

  const vol = Number(obj.volume)
  const volume = Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1.0

  const gap = Number(obj.gap_after)
  const gap_after = Number.isFinite(gap) ? Math.max(0, gap) : 0

  const trimStart = Number(obj.trim_start_sec)
  const trim_start_sec = Number.isFinite(trimStart) ? Math.max(0, trimStart) : 0

  const dur = obj.duration_sec != null ? Number(obj.duration_sec) : null
  const duration_sec = dur !== null && Number.isFinite(dur) && dur > 0 ? dur : null

  const fadeIn = Number(obj.fade_in_sec)
  const fade_in_sec = Number.isFinite(fadeIn) ? Math.max(0, fadeIn) : 0

  const fadeOut = Number(obj.fade_out_sec)
  const fade_out_sec = Number.isFinite(fadeOut) ? Math.max(0, fadeOut) : 0

  const out: ChannelIntroMusicSettings = {
    file,
    volume,
    gap_after,
    trim_start_sec,
    duration_sec,
    fade_in_sec,
    fade_out_sec,
    enabled: true,
  }

  if (typeof obj.sha256 === 'string' && obj.sha256.trim()) out.sha256 = obj.sha256.trim()
  if (typeof obj.source === 'string' && obj.source.trim()) out.source = obj.source.trim()
  if (typeof obj.name === 'string' && obj.name.trim()) out.name = obj.name.trim()

  return out
}

/**
 * Deep equality for two normalized intro music settings.
 */
export function sameChannelIntroMusic(
  a: ChannelIntroMusicSettings | null | undefined,
  b: ChannelIntroMusicSettings | null | undefined,
): boolean {
  if (!a || !b) return a === b
  return (
    a.file === b.file &&
    a.volume === b.volume &&
    a.gap_after === b.gap_after &&
    (a.trim_start_sec ?? 0) === (b.trim_start_sec ?? 0) &&
    (a.duration_sec ?? null) === (b.duration_sec ?? null) &&
    (a.fade_in_sec ?? 0) === (b.fade_in_sec ?? 0) &&
    (a.fade_out_sec ?? 0) === (b.fade_out_sec ?? 0)
  )
}

/**
 * Deterministic identity key for caching and audio rebuild comparison.
 */
export function channelIntroMusicKey(settings: ChannelIntroMusicSettings | null | undefined): string {
  const n = normalizeChannelIntroMusic(settings)
  if (!n) return 'null'
  return [
    n.file,
    n.volume ?? 1,
    n.gap_after ?? 0,
    n.trim_start_sec ?? 0,
    n.duration_sec ?? 'full',
    n.fade_in_sec ?? 0,
    n.fade_out_sec ?? 0,
  ].join('\u0000')
}

export interface ResolveIntroMusicOptions {
  projectSlug?: string
  episodeId?: string
  /** Explicit selection passed on request, e.g. req.body.channel_intro */
  requestSelection?: unknown
  /** Has an explicit clear been sent? (e.g. req.body.channel_intro === null or req.body.clear_channel_intro === true) */
  explicitClear?: boolean
  /** Saved video_assembly_last_used config or episode settings */
  episodeLastUsedSettings?: Record<string, any> | null
  /** Channel config object from config.json */
  channelConfig?: Record<string, any> | null
}

/**
 * Resolve the authoritative intro music for an episode:
 *  1. If explicitly cleared on request or in episode settings, returns null (explicitly cleared).
 *  2. If explicit selection is provided on request, returns that episode choice.
 *  3. If saved episode-specific settings exist in video_assembly_last_used, returns that choice.
 *  4. Otherwise, automatically binds to the channel-level `channel_intro_music` (or aliases).
 *  5. If channel has no bound intro, returns null (none).
 */
export function resolveChannelIntroMusic(opts: ResolveIntroMusicOptions): ResolvedChannelIntroMusic {
  // 1. Explicit clear on request
  if (opts.explicitClear || opts.requestSelection === null) {
    return { source: 'episode_explicit', settings: null, explicitlyCleared: true }
  }

  // 2. Explicit selection on request
  if (opts.requestSelection !== undefined) {
    const fromReq = normalizeChannelIntroMusic(opts.requestSelection)
    if (fromReq) {
      return { source: 'episode_explicit', settings: fromReq, explicitlyCleared: false }
    }
  }

  // 3. Saved episode-specific choice in video_assembly_last_used
  if (opts.episodeLastUsedSettings) {
    const rawEpisodeIntro =
      opts.episodeLastUsedSettings.channel_intro !== undefined
        ? opts.episodeLastUsedSettings.channel_intro
        : opts.episodeLastUsedSettings.intro?.channel_intro
    if (rawEpisodeIntro === null) {
      // Episode explicitly saved with no channel intro
      return { source: 'episode_explicit', settings: null, explicitlyCleared: true }
    }
    const fromSaved = normalizeChannelIntroMusic(rawEpisodeIntro)
    if (fromSaved) {
      return { source: 'episode_explicit', settings: fromSaved, explicitlyCleared: false }
    }
  }

  // 4. Automatic binding from channel config (channel_intro_music or intro_music or channel_intro)
  if (opts.channelConfig) {
    const channelBound =
      opts.channelConfig.channel_intro_music ??
      opts.channelConfig.intro_music ??
      opts.channelConfig.channel_intro
    const fromChannel = normalizeChannelIntroMusic(channelBound)
    if (fromChannel) {
      return { source: 'channel_bound', settings: fromChannel, explicitlyCleared: false }
    }
  }

  // 5. No intro configured
  return { source: 'none', settings: null, explicitlyCleared: false }
}

export interface CompileIntroAudioFilterOptions {
  settings: ChannelIntroMusicSettings
  /** Total measured duration of the raw audio file in seconds, if known */
  measuredDurationSec?: number | null
}

export interface CompiledIntroAudioFilter {
  /** The value for FFmpeg -af */
  filterGraph: string
  /** Expected duration of the staged output in seconds, or null if unmeasured full track */
  effectiveDurationSec: number | null
  /** Trim start in seconds applied */
  trimStartSec: number
  /** Trim end in seconds applied, if bounded */
  trimEndSec: number | null
  /** Fade in seconds applied */
  fadeInSec: number
  /** Fade out seconds applied */
  fadeOutSec: number
}

/**
 * Compile FFmpeg audio filter clauses for trims, volume, and fades.
 * Output is always resampled to 44.1 kHz for standard concatenation.
 */
export function compileIntroAudioFilter(opts: CompileIntroAudioFilterOptions): CompiledIntroAudioFilter {
  const s = opts.settings
  const filters: string[] = ['aresample=44100']

  const trimStart = s.trim_start_sec ?? 0
  let duration = s.duration_sec ?? null

  // If duration is specified, end time is trimStart + duration
  let trimEnd: number | null = null
  if (duration !== null && duration > 0) {
    trimEnd = trimStart + duration
  } else if (opts.measuredDurationSec != null && opts.measuredDurationSec > 0) {
    duration = Math.max(0, opts.measuredDurationSec - trimStart)
  }

  // Trimming: atrim operates on source timestamps, then asetpts resets PTS
  if (trimStart > 0 || trimEnd !== null) {
    let trimStr = `atrim=start=${trimStart.toFixed(3)}`
    if (trimEnd !== null) {
      trimStr += `:end=${trimEnd.toFixed(3)}`
    }
    trimStr += ',asetpts=PTS-STARTPTS'
    filters.push(trimStr)
  }

  // Volume (linear gain)
  const vol = s.volume ?? 1.0
  if (Math.abs(vol - 1.0) > 0.001) {
    filters.push(`volume=${vol.toFixed(2)}`)
  }

  // Fades
  let fadeIn = s.fade_in_sec ?? 0
  let fadeOut = s.fade_out_sec ?? 0

  // Guard against fades exceeding effective duration
  if (duration !== null && duration > 0 && fadeIn + fadeOut > duration) {
    const scale = duration / (fadeIn + fadeOut)
    fadeIn = Math.max(0, fadeIn * scale)
    fadeOut = Math.max(0, fadeOut * scale)
  }

  if (fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`)
  }

  if (fadeOut > 0 && duration !== null && duration > 0) {
    const fadeOutStart = Math.max(0, duration - fadeOut)
    filters.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`)
  }

  return {
    filterGraph: filters.join(','),
    effectiveDurationSec: duration,
    trimStartSec: trimStart,
    trimEndSec: trimEnd,
    fadeInSec: fadeIn,
    fadeOutSec: fadeOut,
  }
}

/**
 * Build the exact FFmpeg command-line arguments to stage an intro track.
 */
export function buildIntroAudioFfmpegArgs(opts: {
  inputPath: string
  outputPath: string
  settings: ChannelIntroMusicSettings
  measuredDurationSec?: number | null
}): string[] {
  const compiled = compileIntroAudioFilter({
    settings: opts.settings,
    measuredDurationSec: opts.measuredDurationSec,
  })
  return [
    '-y',
    '-i',
    opts.inputPath,
    '-af',
    compiled.filterGraph,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    opts.outputPath,
  ]
}
