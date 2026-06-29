/**
 * SFX mixer — overlays ambient beds + spot one-shots onto an existing audio
 * track and writes a NEW file. The video renderer consumes that file via its
 * existing `merged_audio_path` override, so the (huge) final-composition graph
 * in generators/video.ts is never touched.
 *
 * Design (see docs/sfx-sound-layer-spec.md):
 *   - Beds loop to cover their [start,end) span, gain-reduced, delayed to start.
 *   - Spots are gain-set and delayed to their trigger offset.
 *   - Everything is amix'd over the base with `normalize=0` (no auto-attenuation)
 *     and `duration=first` so the output length == the base (narration) length.
 *   - v1 uses fixed conservative gains (bed low, spot moderate); dynamic
 *     sidechain ducking is a documented follow-up, not v1.
 *
 * Safety: with zero resolvable cues `mixSfxIntoAudio` returns the base path
 * unchanged — it never produces a degenerate file, and the caller (render
 * wiring) only invokes it when planAffectsRender() is true.
 */
import { runFfmpeg, getAudioDuration } from './ffmpeg-utils.js'
import { existsSync } from 'fs'

export interface MixCue {
  kind: 'bed' | 'spot'
  /** Absolute path to the resolved SFX clip. */
  path: string
  gain_db: number
  start_sec: number
  /** Beds only — span end. Ignored for spots. */
  end_sec?: number
}

function ms(sec: number): number {
  return Math.max(0, Math.round(sec * 1000))
}

/**
 * Pure: build the ffmpeg argv that mixes `cues` onto `basePath` → `outPath`.
 * Deterministic ordering (beds/spots as given) so it can be snapshot-tested.
 * Caller guarantees `cues` is non-empty and every `path` exists.
 */
export function buildSfxMixArgs(opts: { basePath: string; cues: MixCue[]; outPath: string }): string[] {
  const { basePath, cues, outPath } = opts
  const args: string[] = ['-y', '-i', basePath]
  for (const c of cues) args.push('-i', c.path)

  const parts: string[] = []
  const labels: string[] = []
  cues.forEach((c, i) => {
    const inIdx = i + 1 // input 0 is the base
    const out = `[c${i}]`
    if (c.kind === 'bed') {
      const span = Math.max(0.05, (c.end_sec ?? c.start_sec) - c.start_sec)
      parts.push(
        `[${inIdx}:a]aloop=loop=-1:size=2147483647,atrim=duration=${span.toFixed(3)},` +
          `volume=${c.gain_db}dB,adelay=${ms(c.start_sec)}:all=1${out}`,
      )
    } else {
      parts.push(`[${inIdx}:a]volume=${c.gain_db}dB,adelay=${ms(c.start_sec)}:all=1${out}`)
    }
    labels.push(out)
  })
  parts.push(`[0:a]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:normalize=0[mix]`)

  args.push('-filter_complex', parts.join(';'))
  args.push('-map', '[mix]', '-c:a', 'libmp3lame', '-b:a', '192k', outPath)
  return args
}

/**
 * Resolve each live cue to an absolute clip path, mix onto `basePath`, and write
 * `outPath`. Returns the path the render should use:
 *   - `outPath` when at least one cue resolved + mixed,
 *   - `basePath` (unchanged) when nothing resolved — a safe no-op.
 */
export async function mixSfxIntoAudio(opts: {
  basePath: string
  cues: MixCue[]
  outPath: string
  timeoutMs?: number
}): Promise<string> {
  const { basePath, outPath } = opts
  if (!existsSync(basePath)) throw new Error(`SFX mix: base audio not found: ${basePath}`)

  // Keep only cues whose clip file actually exists on this machine (SSD may be
  // unplugged; an unresolved cue must degrade gracefully, never fail the render).
  const live = opts.cues.filter(c => c.path && existsSync(c.path))
  if (live.length === 0) return basePath

  const baseDur = await getAudioDuration(basePath)
  // Drop spots that start past the end of the narration — duration=first would
  // cut them anyway; dropping keeps the filtergraph lean.
  const usable = baseDur
    ? live.filter(c => c.kind === 'bed' || c.start_sec < baseDur)
    : live
  if (usable.length === 0) return basePath

  const args = buildSfxMixArgs({ basePath, cues: usable, outPath })
  await runFfmpeg(args, { timeoutMs: opts.timeoutMs })
  return outPath
}
