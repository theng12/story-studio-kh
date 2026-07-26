import { existsSync } from 'fs'
import { getAudioDuration, runFfmpeg } from './ffmpeg-utils.js'

export interface SoundDesignMixCue {
  kind: 'bed' | 'spot'
  path: string
  gain_db: number
  start_sec: number
  end_sec?: number
}

export type DuckingProfile = 'gentle' | 'standard' | 'strong'

function milliseconds(seconds: number): number { return Math.max(0, Math.round(seconds * 1000)) }
function ducking(profile: DuckingProfile): string {
  if (profile === 'strong') return 'threshold=0.025:ratio=8:attack=20:release=350'
  if (profile === 'standard') return 'threshold=0.045:ratio=5:attack=30:release=450'
  return 'threshold=0.075:ratio=3:attack=45:release=650'
}

/** Build one bounded final mix. Beds are dynamically ducked beneath narration; spots remain punctual. */
export function buildSoundDesignMixArgs(opts: {
  basePath: string
  cues: SoundDesignMixCue[]
  outPath: string
  ducking_profile: DuckingProfile
}): string[] {
  const { basePath, cues, outPath, ducking_profile } = opts
  const args = ['-y', '-i', basePath]
  for (const cue of cues) args.push('-i', cue.path)
  const bedCount = cues.filter(cue => cue.kind === 'bed').length
  const voiceLabels = Array.from({ length: bedCount }, (_, index) => `[voice${index}]`)
  const parts: string[] = []
  if (bedCount) parts.push(`[0:a]asplit=${bedCount + 1}[base]${voiceLabels.join('')}`)
  const labels: string[] = []
  let bedIndex = 0
  cues.forEach((cue, index) => {
    const input = index + 1
    const label = `[cue${index}]`
    if (cue.kind === 'bed') {
      const span = Math.max(0.05, (cue.end_sec ?? cue.start_sec) - cue.start_sec)
      parts.push(`[${input}:a]aloop=loop=-1:size=2147483647,atrim=duration=${span.toFixed(3)},volume=${cue.gain_db}dB,adelay=${milliseconds(cue.start_sec)}:all=1[raw${index}]`)
      parts.push(`[raw${index}]${voiceLabels[bedIndex++]!}sidechaincompress=${ducking(ducking_profile)}${label}`)
    } else {
      parts.push(`[${input}:a]volume=${cue.gain_db}dB,adelay=${milliseconds(cue.start_sec)}:all=1${label}`)
    }
    labels.push(label)
  })
  parts.push(`${bedCount ? '[base]' : '[0:a]'}${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:normalize=0[mix]`)
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
  await runFfmpeg(buildSoundDesignMixArgs({ ...opts, cues: usable }), { timeoutMs: opts.timeoutMs ?? 10 * 60_000 })
  return opts.outPath
}
