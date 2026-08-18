/**
 * Three frames of the video you are about to render, with the real captions
 * burned into them (v1.4.0).
 *
 * The owner's report: *"give 3 screenshot in different parts of the video as
 * rendered with the video so we can judge the subtitle is correct before we
 * render the video"*. He had just found EP0048's captions burned across a
 * finished EP0047 — and he found it by watching the finished render, which is
 * the most expensive place to find it. Three frames of the wrong episode's words
 * are unmistakable in about two seconds.
 *
 * ── Why this shares the burn's renderer rather than approximating it ──
 *
 * A preview built from a second code path can agree with itself perfectly and
 * still be a lie about the video. So the ASS document these frames are drawn
 * from is produced by `buildSubtitleAssDocument` — the same function, with the
 * same style document and the same PlayRes (the render's own width and height) —
 * and from the same cue list, AFTER the same `hide_during_intro` trim the burn
 * applies. `subtitle-engine.test.ts` already asserts that the style preview and
 * the burn describe one caption; the frame path is now inside that guarantee
 * rather than beside it.
 *
 * Captions carry NO timeline shift here, for the same reason the burn applies
 * none: the merged narration plays from the composed video's t=0, so a cue at
 * its stitched-SRT timestamp is already in sync by construction. The intro
 * offset is already baked into the cue timestamps by the stitcher. Reproducing
 * that here as a second offset would double-count it.
 *
 * ── What is faithful, and what is only representative ──
 *
 * Faithful: which words appear, when they appear, and how they are styled,
 * positioned, wrapped and sized — everything the frames exist to let a person
 * judge.
 *
 * Representative: the picture behind them. The scene image visible at that
 * moment is drawn at the render's resolution with the same crop-fill, but Ken
 * Burns motion, transitions, grading, overlays and the logo are not reproduced —
 * this is a preflight check that must cost seconds, not a second render. The UI
 * says so, because a preview that quietly differs from the render is the defect
 * this module exists to catch.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { escapeFilterPath, runFfmpeg, stillDecoderArgs } from './ffmpeg-utils.js'
import { buildSubtitleAssDocument, type SrtCue } from './subtitle-builder.js'
import type { SubtitleStyleDocument } from '../contracts/subtitle-style.js'

/** Where through the video each frame is taken from. */
export const PREFLIGHT_PERCENTS = [0.15, 0.5, 0.85] as const

export interface PreflightSample {
  /** 1-based, matching the `_subtitle_preflight_N.png` suffix. */
  index: number
  /** The position through the video this frame was aiming for. */
  percent: number
  /** The timestamp actually sampled — inside a caption's own window. */
  time_sec: number
  /** Which cue is on screen at `time_sec`. */
  cue_index: number
  cue_text: string
}

/**
 * Choose three timestamps that each land on a caption.
 *
 * 15% / 50% / 85% of the video is where the frames are aimed, but the aim is
 * only a starting point: a frame taken at exactly 50% of a video may fall in a
 * pause between sentences, and a blank frame proves nothing at all. Proving the
 * captions are right is the entire purpose, so each sample is pulled onto the
 * nearest caption and placed inside that caption's own window.
 *
 * Pure, so the choice can be tested without ffmpeg or a disk.
 */
export function choosePreflightTimestamps(
  cues: SrtCue[],
  durationSec: number,
): PreflightSample[] {
  const usable = (cues || [])
    .filter(c => Number.isFinite(c.start_sec) && Number.isFinite(c.end_sec) && c.end_sec > c.start_sec)
    .sort((a, b) => a.start_sec - b.start_sec)
  if (!usable.length) return []

  // A duration we cannot trust would put all three samples in the same place.
  // The captions' own span is the honest fallback: it is what there is to judge.
  const span = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : usable[usable.length - 1]!.end_sec

  const taken = new Set<number>()
  const samples: PreflightSample[] = []
  for (const percent of PREFLIGHT_PERCENTS) {
    const target = span * percent
    // Distance from the target to the cue's window — zero when the target is
    // already inside it. Ties go to the earlier cue, so this is deterministic.
    const ranked = usable
      .map((cue, i) => ({ cue, i, d: cue.start_sec > target ? cue.start_sec - target : target > cue.end_sec ? target - cue.end_sec : 0 }))
      .sort((a, b) => (a.d - b.d) || (a.i - b.i))
    // Three frames of the same caption would be one piece of evidence printed
    // three times, so a cue already used is skipped in favour of the next best.
    const chosen = ranked.find(r => !taken.has(r.i)) || ranked[0]!
    taken.add(chosen.i)

    const { cue } = chosen
    const len = cue.end_sec - cue.start_sec
    // Sit inside the caption rather than on its edge: a frame taken on the exact
    // boundary can catch a fade and read as a rendering fault that is not there.
    const margin = Math.min(0.15, len / 4)
    const time = Math.min(Math.max(target, cue.start_sec + margin), cue.end_sec - margin)
    samples.push({
      index: 0,
      percent,
      time_sec: Math.round(time * 1000) / 1000,
      cue_index: cue.index,
      cue_text: cue.text,
    })
  }
  return samples
    .sort((a, b) => a.time_sec - b.time_sec)
    .map((s, i) => ({ ...s, index: i + 1 }))
}

export interface PreflightSceneRef {
  image_path: string
  duration: number
}

/**
 * Which scene image is on screen at a given moment of the finished video.
 * `openingOffsetSec` is the branded opening the scenes start after.
 * Returns null while the opening is still playing — there is no scene yet.
 */
export function sceneImageAt(
  scenes: PreflightSceneRef[],
  timeSec: number,
  openingOffsetSec: number,
): { image_path: string; scene_number: number } | null {
  let remaining = timeSec - (openingOffsetSec || 0)
  if (remaining < 0) return null
  for (const [i, scene] of (scenes || []).entries()) {
    const d = Number(scene.duration) || 0
    if (remaining < d) return { image_path: scene.image_path, scene_number: i + 1 }
    remaining -= d
  }
  const last = (scenes || [])[scenes.length - 1]
  return last ? { image_path: last.image_path, scene_number: scenes.length } : null
}

export interface PreflightFrame extends PreflightSample {
  /** Absolute path to the written PNG. */
  path: string
  filename: string
  /** Null when the frame lands during the branded opening. */
  scene_number: number | null
}

export interface PreflightFramesResult {
  frames: PreflightFrame[]
  /** Basename of the subtitle file these frames were drawn from. */
  subtitle_filename: string
  /** How long producing them took, so the cost is a measured number. */
  elapsed_ms: number
  /** Cues considered, after any intro trim. */
  cue_count: number
}

export interface RenderPreflightFramesOptions {
  episodeCode: string
  /** Where the frames are written — beside the final video. */
  outDir: string
  /** The cues the burn will use, already trimmed exactly as the burn trims them. */
  cues: SrtCue[]
  /** Basename shown in the UI, for the record. */
  subtitleFilename: string
  style: SubtitleStyleDocument
  width: number
  height: number
  scenes: PreflightSceneRef[]
  openingOffsetSec: number
  durationSec: number
}

/**
 * Draw the three frames and write them beside the final video, named
 * `{CODE}_subtitle_preflight_{1,2,3}.png` — he asked for them "as rendered with
 * the video", so they live with it rather than in a cache he would never find.
 */
export async function renderSubtitlePreflightFrames(
  opts: RenderPreflightFramesOptions,
): Promise<PreflightFramesResult> {
  const started = Date.now()
  const code = opts.episodeCode.toUpperCase()
  const samples = choosePreflightTimestamps(opts.cues, opts.durationSec)
  if (!samples.length) {
    return { frames: [], subtitle_filename: opts.subtitleFilename, elapsed_ms: Date.now() - started, cue_count: 0 }
  }

  // ONE ASS document, built exactly as the burn builds it, shared by all three
  // frames. Building it per frame would open the door to three previews that
  // disagree with each other as well as with the render.
  const rendered = buildSubtitleAssDocument(opts.cues, opts.style, { width: opts.width, height: opts.height })
  if (!rendered.events) {
    throw new Error(
      `Caption preflight could not be produced for ${code}: the subtitle document contained no caption events. `
      + 'The transcript may be empty or unparseable — open the Subtitles workspace and check it.',
    )
  }
  const assPath = path.join(os.tmpdir(), `ssk-preflight-${code}-${Date.now()}.ass`)
  await fs.writeFile(assPath, rendered.ass, 'utf-8')

  await fs.mkdir(opts.outDir, { recursive: true })
  const frames: PreflightFrame[] = []
  try {
    for (const sample of samples) {
      const filename = `${code}_subtitle_preflight_${sample.index}.png`
      const outPath = path.join(opts.outDir, filename)
      const scene = sceneImageAt(opts.scenes, sample.time_sec, opts.openingOffsetSec)

      // `setpts` places this single frame at its real position on the video's
      // timeline, which is what makes libass draw the caption that is genuinely
      // on screen then. Without it every frame would be t=0 and show nothing.
      const place = `setsar=1,setpts=PTS-STARTPTS+${sample.time_sec}/TB,ass=filename=${escapeFilterPath(assPath)}`
      const args = scene
        ? [
            ...(await stillDecoderArgs(scene.image_path).catch(() => [] as string[])),
            '-loop', '1', '-t', '1', '-i', scene.image_path,
            // Same crop-fill the renderer normalises a scene to the canvas with.
            '-filter_complex',
            `[0:v]scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,`
            + `crop=${opts.width}:${opts.height},${place}[v]`,
            '-map', '[v]', '-frames:v', '1', '-y', outPath,
          ]
        : [
            // Inside the branded opening there is no scene image. Black is the
            // honest backdrop — inventing one would misrepresent the render.
            '-f', 'lavfi', '-t', '1', '-i', `color=c=black:s=${opts.width}x${opts.height}`,
            '-filter_complex', `[0:v]${place}[v]`,
            '-map', '[v]', '-frames:v', '1', '-y', outPath,
          ]
      await runFfmpeg(args, { timeoutMs: 60_000 })
      frames.push({ ...sample, path: outPath, filename, scene_number: scene?.scene_number ?? null })
    }
  } finally {
    await fs.rm(assPath, { force: true }).catch(() => {})
  }

  return {
    frames,
    subtitle_filename: opts.subtitleFilename,
    elapsed_ms: Date.now() - started,
    cue_count: opts.cues.length,
  }
}
