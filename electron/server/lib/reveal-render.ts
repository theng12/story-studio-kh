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
import { compileSceneReveal, planRevealStages, revealDriftMotion, type CompiledReveal } from './reveal-compiler.js'
import { renderNativeSceneClip } from './native-scene-clip.js'
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
  /**
   * Seconds of the last frame held after the window. Plan-strict crossfades time every dissolve as
   * if each clip ran window + transition (video.ts `renderDuration`); a reveal clip without that
   * tail ends exactly where the next dissolve starts, and FFmpeg then ends the whole chunk there.
   */
  tailSeconds?: number
  timeoutMs?: number
  /** Test seam: production always runs the real FFmpeg. */
  run?: (args: string[], options: { timeoutMs?: number }) => Promise<unknown>
  /**
   * Render the picture's drift with the native helper (the one expensive stage) and let FFmpeg do
   * the rest. Any native problem, or a failure of the hybrid graph, re-renders the clip with the
   * all-FFmpeg graph, so this can only make a clip faster, never absent.
   */
  native?: {
    /** Where the intermediate drift clip is written. */
    driftPath: string
    /** Reports why the native drift was not used. */
    onFallback?: (detail: string) => void
    /** Test seam for the helper. */
    render?: typeof renderNativeSceneClip
  }
}

export interface RenderedReveal {
  path: string
  plan: RevealHoldPlan
  compiled: CompiledReveal
  /** The exact argument list, so a receipt can name what ran. */
  args: string[]
  /** `native-drift` when the picture came from the helper, `ffmpeg` otherwise. */
  renderer: 'native-drift' | 'ffmpeg'
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
  const timing = {
    reveal_seconds: plan.reveal_seconds,
    hold_seconds: plan.hold_seconds,
    total_seconds: plan.total_seconds,
    micro_event_offsets: plan.micro_event_offsets,
    source: 'preset' as const,
  }
  const runner = input.run ?? runFfmpeg
  const timeoutMs = input.timeoutMs ?? 10 * 60_000
  const encoder = revealEncoderArgs({ fps: input.fps, crf: input.crf ?? 20 })
  const decoder = await stillDecoderArgs(input.imagePath)
  const tail = Math.max(0, input.tailSeconds ?? 0)
  const withTail = (c: CompiledReveal) => tail > 0
    ? {
        filters: [...c.filters, `[${c.output}]tpad=stop_mode=clone:stop_duration=${tail.toFixed(3)}[reveal_tail]`],
        output: 'reveal_tail',
        duration: c.duration + tail,
      }
    : { filters: c.filters, output: c.output, duration: c.duration }

  // ── Hybrid: native drift, FFmpeg wipes ──────────────────────────────────────
  if (input.native) {
    const fallback = (detail: string) => input.native?.onFallback?.(detail)
    const picture = planRevealStages(doc, timing).find(stage => stage.kind === 'picture')!
    const render = input.native.render ?? renderNativeSceneClip
    const drift = await render({
      imagePath: input.imagePath,
      outPath: input.native.driftPath,
      document: revealDriftMotion(doc),
      w: input.width, h: input.height, fps: input.fps,
      duration: picture.segment,
      // This clip is decoded and re-encoded below at the reveal's own CRF, so it only has to be clean.
      quality: 0.8,
    })
    if (drift.rendered) {
      const compiled = compileSceneReveal(doc, { w: input.width, h: input.height, fps: input.fps, timing, prerenderedPicture: true })
      const graph = withTail(compiled)
      const imageField = doc.field.mode === 'image'
      const args = [
        '-y',
        '-i', input.native.driftPath,
        ...(imageField ? [...decoder, '-i', input.imagePath] : []),
        '-filter_complex', graph.filters.join(';'),
        '-map', `[${graph.output}]`,
        '-t', String(graph.duration),
        ...encoder,
        input.outPath,
      ]
      try {
        await runner(args, { timeoutMs })
        return { path: input.outPath, plan, compiled, args, renderer: 'native-drift' }
      } catch (error: any) {
        fallback(`hybrid graph failed: ${String(error?.message || error).split('\n')[0]}`)
      }
    } else {
      fallback(`${drift.reason}: ${drift.detail}`)
    }
  }

  // ── All FFmpeg ──────────────────────────────────────────────────────────────
  const compiled = compileSceneReveal(doc, { w: input.width, h: input.height, fps: input.fps, timing })

  // One frame in, no `-loop`: the picture stream is built by `zoompan` (which
  // generates its own frames from a single image) and the field by `tpad`
  // cloning that same frame. Looping the input would make zoompan multiply the
  // clip by the number of times the image arrived — the "stuck at 1/160" shape
  // of defect this app already fixed once in `prepareSceneClips`.
  const graph = withTail(compiled)
  const args = [
    '-y',
    ...decoder,
    '-i', input.imagePath,
    '-filter_complex', graph.filters.join(';'),
    '-map', `[${graph.output}]`,
    '-t', String(graph.duration),
    ...encoder,
    input.outPath,
  ]

  await runner(args, { timeoutMs })
  return { path: input.outPath, plan, compiled, args, renderer: 'ffmpeg' }
}

/** Where a reveal clip lives inside a job's temp directory. */
export function revealClipPath(tempDir: string, sceneIndex: number): string {
  return path.join(tempDir, `reveal_${String(sceneIndex).padStart(4, '0')}.mp4`)
}
