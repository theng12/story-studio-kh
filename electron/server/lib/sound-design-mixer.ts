import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { getAudioDuration, runFfmpeg } from './ffmpeg-utils.js'

export interface SoundDesignMixCue {
  kind: 'bed' | 'spot'
  path: string
  gain_db: number
  start_sec: number
  end_sec?: number
}

/** A group of spot cues already mixed down, and the episode time that stem belongs at. */
export interface SoundDesignMixStem {
  path: string
  start_sec: number
}

export type DuckingProfile = 'gentle' | 'standard' | 'strong'

// Bound spot inputs per stem; float PCM and normalize=0 preserve summed levels.
export const SPOT_MIX_GROUP_SIZE = 24

function milliseconds(seconds: number): number { return Math.max(0, Math.round(seconds * 1000)) }
function ducking(profile: DuckingProfile): string {
  if (profile === 'strong') return 'threshold=0.025:ratio=8:attack=20:release=350'
  if (profile === 'standard') return 'threshold=0.045:ratio=5:attack=30:release=450'
  return 'threshold=0.075:ratio=3:attack=45:release=650'
}

/** Preserve absolute delay through resampling, then trim the group's leading silence. */
export function buildSpotGroupArgs(opts: {
  cues: SoundDesignMixCue[]
  startSec: number
  outPath: string
  sampleRate: number
  channelLayout: string
}): string[] {
  const { cues, startSec, outPath, sampleRate, channelLayout } = opts
  const args = ['-y', '-nostdin']
  for (const cue of cues) args.push('-i', cue.path)
  const parts: string[] = []
  cues.forEach((cue, index) => {
    parts.push(`[${index}:a]volume=${cue.gain_db}dB,adelay=${milliseconds(cue.start_sec)}:all=1,aresample=${sampleRate},aformat=channel_layouts=${channelLayout}[cue${index}]`)
  })
  const labels = cues.map((_, index) => `[cue${index}]`).join('')
  parts.push(`${labels}amix=inputs=${cues.length}:duration=longest:normalize=0,atrim=start_sample=${Math.floor(milliseconds(startSec) * sampleRate / 1000)},asetpts=PTS-STARTPTS[group]`)
  args.push('-filter_complex', parts.join(';'), '-map', '[group]', '-c:a', 'pcm_f32le', outPath)
  return args
}

/**
 * Build one bounded final mix. Beds are dynamically ducked beneath narration;
 * spot groups arrive as stems and are placed at their own episode times.
 */
export function buildSoundDesignMixArgs(opts: {
  basePath: string
  beds: SoundDesignMixCue[]
  stems: SoundDesignMixStem[]
  outPath: string
  ducking_profile: DuckingProfile
}): string[] {
  const { basePath, beds, stems, outPath, ducking_profile } = opts
  const args = ['-y', '-nostdin', '-i', basePath]
  for (const bed of beds) args.push('-i', bed.path)
  for (const stem of stems) args.push('-i', stem.path)
  const voiceLabels = Array.from({ length: beds.length }, (_, index) => `[voice${index}]`)
  const parts: string[] = []
  if (beds.length) parts.push(`[0:a]asplit=${beds.length + 1}[base]${voiceLabels.join('')}`)
  const labels: string[] = []
  beds.forEach((cue, index) => {
    const span = Math.max(0.05, (cue.end_sec ?? cue.start_sec) - cue.start_sec)
    parts.push(`[${index + 1}:a]aloop=loop=-1:size=2147483647,atrim=duration=${span.toFixed(3)},volume=${cue.gain_db}dB,adelay=${milliseconds(cue.start_sec)}:all=1[raw${index}]`)
    parts.push(`[raw${index}]${voiceLabels[index]!}sidechaincompress=${ducking(ducking_profile)}[bed${index}]`)
    labels.push(`[bed${index}]`)
  })
  stems.forEach((stem, index) => {
    const label = `[stem${index}]`
    parts.push(`[${beds.length + index + 1}:a]adelay=${milliseconds(stem.start_sec)}:all=1${label}`)
    labels.push(label)
  })
  parts.push(`${beds.length ? '[base]' : '[0:a]'}${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:normalize=0[mix]`)
  args.push('-filter_complex', parts.join(';'), '-map', '[mix]', '-c:a', 'libmp3lame', '-b:a', '192k', outPath)
  return args
}

export async function mixSoundDesignIntoAudio(opts: {
  basePath: string
  cues: SoundDesignMixCue[]
  outPath: string
  ducking_profile: DuckingProfile
  timeoutMs?: number
}): Promise<string> {
  if (!existsSync(opts.basePath)) throw new Error('Sound Design mix: merged audio is missing.')
  const live = opts.cues.filter(cue => cue.path && existsSync(cue.path))
  if (live.length !== opts.cues.length) throw new Error('Sound Design mix: an approved local sound asset is unavailable. Re-open Sound Design and replace or exclude it.')
  const duration = await getAudioDuration(opts.basePath)
  const usable = duration ? live.filter(cue => cue.kind === 'bed' || cue.start_sec < duration) : live
  if (!usable.length) throw new Error('Sound Design mix: no approved cues are inside the narration duration.')
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const beds = usable.filter(cue => cue.kind === 'bed')
  const spots = usable.filter(cue => cue.kind === 'spot').sort((a, b) => a.start_sec - b.start_sec)
  let sampleRate = 0, channelLayout = ''
  if (spots.length) {
    const { stdout } = await promisify(execFile)(await getFFprobePath(), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channel_layout,channels', '-of', 'json', opts.basePath], { timeout: 30_000 })
    const stream = JSON.parse(stdout).streams?.[0]
    sampleRate = Number(stream?.sample_rate)
    channelLayout = stream?.channel_layout || (stream?.channels === 1 ? 'mono' : stream?.channels === 2 ? 'stereo' : '')
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !/^[a-zA-Z0-9_.+()|]+$/.test(channelLayout)) throw new Error('Sound Design mix: could not determine narration audio format.')
  }
  // Cues are never thinned or dropped here: the owner wants a sound on every
  // cut, so the only thing that changes is how many FFmpeg opens at once.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-sound-design-mix-'))
  try {
    const stems: SoundDesignMixStem[] = []
    for (let at = 0; at < spots.length; at += SPOT_MIX_GROUP_SIZE) {
      const group = spots.slice(at, at + SPOT_MIX_GROUP_SIZE)
      const startSec = group[0]!.start_sec
      const stemPath = path.join(workDir, `spot-group-${stems.length}.wav`)
      await runFfmpeg(buildSpotGroupArgs({ cues: group, startSec, outPath: stemPath, sampleRate, channelLayout }), { timeoutMs })
      stems.push({ path: stemPath, start_sec: startSec })
    }
    await runFfmpeg(buildSoundDesignMixArgs({
      basePath: opts.basePath,
      beds,
      stems,
      outPath: opts.outPath,
      ducking_profile: opts.ducking_profile,
    }), { timeoutMs })
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
  return opts.outPath
}
