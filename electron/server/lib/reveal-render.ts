/**
 * Render one reveal clip.
 *
 * This is the only part of the reveal engine that touches FFmpeg; everything it
 * decides was decided by `reveal-pacing.ts` and `reveal-selector`, and every
 * filter string comes from `reveal-compiler.ts`. Keeping the split means the
 * interesting half — what a scene's reveal *is* — is testable without a binary,
 * and this file stays small enough to read in one sitting.
 *
 * **Renders locally, on this Mac.** A reveal is compositing, not inference: no
 * model, no weights, no memory tier, so it also runs on the 8 GB machines that
 * cannot touch FLUX or video. The design promotes it to a Hub lane only if
 * episode-scale rendering ever hurts.
 */

import path from 'node:path'
import { runFfmpeg, stillDecoderArgs } from './ffmpeg-utils.js'
import { compileSceneReveal, type CompiledReveal } from './reveal-compiler.js'
import { planSceneHold, type RevealHoldPlan, type RevealPace, type RevealSnapCandidates } from './reveal-pacing.js'
import { normalizeSceneReveal, type SceneRevealDocument } from '../contracts/scene-reveal.js'

export interface RenderRevealInput {
  imagePath: string
  outPath: string
  /** The preset's document; nothing here mutates it. */
  document: SceneRevealDocument
  pace: RevealPace
  /** The scene's window on the timeline, seconds. */
  windowSeconds: number
  narrationSeconds?: number
  snap?: RevealSnapCandidates
  width: number
  height: number
  fps: number
  crf?: number
  timeoutMs?: number
  /** Test seam: production always runs the real FFmpeg. */
  run?: (args: string[], options: { timeoutMs?: number }) => Promise<unknown>
}

export interface RenderedReveal {
  path: string
  plan: RevealHoldPlan
  compiled: CompiledReveal
  /** The exact argument list, so a receipt can name what ran. */
  args: string[]
}

/**
 * The encoder arguments every clip in this app's assembly already uses.
 *
 * Copied deliberately from `prepareSceneClips` rather than invented: a reveal
 * clip has to be interchangeable with the still clip it replaces — same codec,
 * same CRF, same fps mode, same colour tags — or the concat and the xfade chain
 * downstream will refuse it. The colour tags in particular are load-bearing
 * (libx265 rejects a mid-file tag switch).
 */
export function revealEncoderArgs(opts: { fps: number; crf: number }): string[] {
  return [
    '-c:v', 'libx264', '-crf', String(opts.crf), '-preset', 'ultrafast',
    '-r', String(opts.fps), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
  ]
}

export async function renderRevealClip(input: RenderRevealInput): Promise<RenderedReveal> {
  const doc = normalizeSceneReveal(input.document)
  const plan = planSceneHold({
    pace: input.pace,
    window_seconds: input.windowSeconds,
    narration_seconds: input.narrationSeconds,
    doc,
    snap: input.snap,
  })
  const compiled = compileSceneReveal(doc, {
    w: input.width,
    h: input.height,
    fps: input.fps,
    timing: {
      reveal_seconds: plan.reveal_seconds,
      hold_seconds: plan.hold_seconds,
      total_seconds: plan.total_seconds,
      micro_event_offsets: plan.micro_event_offsets,
      source: 'preset',
    },
  })

  // One frame in, no `-loop`: the picture stream is built by `zoompan` (which
  // generates its own frames from a single image) and the field by `tpad`
  // cloning that same frame. Looping the input would make zoompan multiply the
  // clip by the number of times the image arrived — the "stuck at 1/160" shape
  // of defect this app already fixed once in `prepareSceneClips`.
  const decoder = await stillDecoderArgs(input.imagePath)
  const args = [
    '-y',
    ...decoder,
    '-i', input.imagePath,
    '-filter_complex', compiled.filters.join(';'),
    '-map', `[${compiled.output}]`,
    '-t', String(compiled.duration),
    ...revealEncoderArgs({ fps: input.fps, crf: input.crf ?? 20 }),
    input.outPath,
  ]

  const runner = input.run ?? runFfmpeg
  await runner(args, { timeoutMs: input.timeoutMs ?? 10 * 60_000 })
  return { path: input.outPath, plan, compiled, args }
}

/** Where a reveal clip lives inside a job's temp directory. */
export function revealClipPath(tempDir: string, sceneIndex: number): string {
  return path.join(tempDir, `reveal_${String(sceneIndex).padStart(4, '0')}.mp4`)
}
