/**
 * Segmented final render (1.4.265). The final composition of Video Assembly is ~93% of a TerraNash
 * render, and it used to restart from zero after any interruption (an update, a crash, Quit, a
 * power cut). It now writes fixed-length segment files from ONE FFmpeg process (the segment muxer,
 * with a keyframe forced at every cut), records each finished segment in the job's checkpoint, and
 * joins them losslessly at the end (concat demuxer, `-c copy`) while muxing the one premixed audio
 * track. A resume renders only from the first missing segment.
 *
 * An uninterrupted segmented render is the one-shot render frame for frame (measured lossless on
 * TerraNash's effects: 0 of 11,999 frames differ, audio bit-identical): one FFmpeg process, the same
 * graph, only cut into files.
 *
 * A resume does not change or time-shift the graph either. Every input is read from its start as
 * before; only the main picture is trimmed to begin shortly before the cut (`resumeFilterGraph`), so
 * every effect sees the same timestamps it saw in the one-shot render. Two FFmpeg filters keep a
 * random sequence that advances with every frame they process, and that sequence restarts at a
 * resumed cut: temporal film grain (`noise` with `allf=t`) and the vignette's dither (less than one
 * level of brightness). Both are random either way; the owner's call (2026-10-09) is that grain need
 * not be bit-identical, and the vignette's dither is the same kind of noise, far smaller.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { escapeFilterPath } from './ffmpeg-utils.js'

// ponytail: fixed 3-minute segments; an interrupted render loses at most this much. A setting if 3 min is wrong.
export const FINAL_SEGMENT_SEC = 180
// ponytail: a still tail renders 30 s once and repeats it; any grain then repeats every 30 s, which a still hides.
export const STILL_TAIL_LOOP_SEC = 30
/**
 * A cut is given to FFmpeg 10 µs before the first frame of the next segment. The segment muxer and
 * `select` compare exactly, `-force_key_frames` rounds to the nearest tick: all three then land on
 * that frame, whatever the output frame rate and time base.
 */
const CUT_EPSILON_SEC = 0.00001
/** A resumed render starts the main picture this much before the cut, so a filter that pairs frames has its input. */
const RESUME_LEAD_SEC = 2
/** The still tail loop starts this long after the still begins, clear of the cut into it. */
const STILL_TAIL_MARGIN_SEC = 2

export interface FinalSegmentPlan {
  /** The output's frame duration (measured: a still frame board makes it 25 fps, not the project's rate). */
  frame_sec: number
  /** Ascending output frame numbers where a segment starts. Segment i spans [cut_frames[i-1] ?? 0, cut_frames[i] ?? the end). */
  cut_frames: number[]
  /** Where the FFmpeg render stops; shorter than the video when a still tail is looped. */
  render_end_sec: number
  /** Segment indexes in play order; the still tail's unit repeats. */
  order: number[]
  tail_loop?: { unit: number; repeats: number; from_sec: number }
}

export function planFinalSegments(
  durationSec: number,
  frameSec: number,
  opts: { segmentSec?: number; stillTailFromSec?: number | null; loopSec?: number } = {},
): FinalSegmentPlan {
  const seg = opts.segmentSec ?? FINAL_SEGMENT_SEC
  const frameAt = (sec: number) => Math.ceil(sec / frameSec - 1e-6)
  const regularCuts = (endSec: number) => {
    const cuts: number[] = []
    for (let k = 1; frameAt(k * seg) * frameSec < endSec - 0.5; k++) cuts.push(frameAt(k * seg))
    return cuts
  }
  const order = (count: number) => Array.from({ length: count }, (_, i) => i)
  const fromFrame = opts.stillTailFromSec == null ? null : frameAt(Math.ceil(opts.stillTailFromSec) + STILL_TAIL_MARGIN_SEC)
  const loopFrames = Math.round((opts.loopSec ?? STILL_TAIL_LOOP_SEC) / frameSec)
  const loopSec = loopFrames * frameSec
  // Repeats that still leave the last (partial) piece at least a second.
  const repeats = fromFrame == null ? 0 : Math.floor((durationSec - (fromFrame + loopFrames) * frameSec - 1) / loopSec)
  if (fromFrame == null || repeats < 1) {
    const cuts = regularCuts(durationSec)
    return { frame_sec: frameSec, cut_frames: cuts, render_end_sec: durationSec, order: order(cuts.length + 1) }
  }
  const cuts = [...regularCuts(fromFrame * frameSec).filter(frame => frame < fromFrame), fromFrame, fromFrame + loopFrames]
  const unit = cuts.length - 1
  return {
    frame_sec: frameSec,
    cut_frames: cuts,
    render_end_sec: durationSec - repeats * loopSec,
    order: [...order(unit + 1), ...Array<number>(repeats).fill(unit), unit + 1],
    tail_loop: { unit, repeats, from_sec: fromFrame * frameSec },
  }
}

export function segmentCount(plan: FinalSegmentPlan): number { return plan.cut_frames.length + 1 }

export function segmentRange(plan: FinalSegmentPlan, index: number): { start_sec: number; end_sec: number } {
  const at = (frame: number | undefined) => (frame === undefined ? undefined : frame * plan.frame_sec)
  return { start_sec: at(plan.cut_frames[index - 1]) ?? 0, end_sec: at(plan.cut_frames[index]) ?? plan.render_end_sec }
}

export function segmentFileName(index: number): string {
  return `final_seg_${String(index).padStart(4, '0')}.mp4`
}

/** The output frame duration from a 2-frame `-f framemd5` run of the graph (`#tb 0: 1/25`, duration column). */
export function frameSecFromFramemd5(text: string): number | null {
  const tb = /^#tb 0: (\d+)\/(\d+)$/m.exec(text)
  const row = text.split('\n').find(line => /^0,/.test(line))
  const duration = row ? Number(row.split(',')[3]) : NaN
  const sec = tb ? duration * Number(tb[1]) / Number(tb[2]) : NaN
  return Number.isFinite(sec) && sec > 0 && sec < 1 ? sec : null
}

/** Filters whose output depends on how many frames came before, not on the timestamp. A graph with one renders in one piece. */
const FRAME_COUNTING = /\b(zoompan|tblend|tmix|lagfun|deflicker|minterpolate|framestep|select|tpad|reverse|random)\b/

/** True when the graph can start at a cut: one main picture `[0:v]` read once, ending in `null[vout]`, nothing counting frames. */
export function canResumeGraph(graph: string): boolean {
  return graph.startsWith('[0:v]setpts=PTS-STARTPTS')
    && graph.split('[0:v]').length === 2
    && graph.split('null[vout]').length === 2
    && graph.trimEnd().endsWith('null[vout]')
    && !FRAME_COUNTING.test(graph)
}

const seconds = (value: number) => value.toFixed(6)

/**
 * The same graph, starting at output time `fromSec` (a frame's own time): the main picture is
 * trimmed to begin RESUME_LEAD_SEC early (its timestamps unchanged), and the output keeps frames
 * from the cut on, restarted at 0 for the segment muxer. Every other input is read from its start,
 * as in the one-shot render, so every effect sees the same timestamps.
 */
export function resumeFilterGraph(graph: string, fromSec: number): string {
  if (!canResumeGraph(graph)) throw new Error('This filter graph cannot start at a cut.')
  if (fromSec <= 0) return graph
  const head = '[0:v]setpts=PTS-STARTPTS'
  const lead = Math.max(0, fromSec - RESUME_LEAD_SEC)
  return `${head},trim=start=${seconds(lead)}${graph.slice(head.length)}`
    .replace(/null\[vout\]\s*$/, `select='gte(t,${seconds(fromSec - CUT_EPSILON_SEC)})',setpts=PTS-STARTPTS[vout]`)
}

export interface OneShotArgv {
  /** Everything before the first `-map`, with the graph taken out (`graph_index` marks where it sat). */
  pre: string[]
  graph_index: number
  graph: string
  video_args: string[]
  audio_args: string[]
  mux_args: string[]
  audio_input: string
  duration_sec: number
  output: string
}

/**
 * Take apart the final composition's one-shot argv (`-y …inputs -filter_complex G -map [vout]
 * -map N:a …encoder -t T out`). Null for any other shape — that render stays in one piece.
 */
export function splitOneShotArgv(argv: readonly string[]): OneShotArgv | null {
  const output = argv.at(-1)
  const graphAt = argv.indexOf('-filter_complex')
  const mapAt = argv.indexOf('-map')
  if (!output || argv.at(-3) !== '-t' || graphAt < 0 || mapAt < graphAt) return null
  const durationSec = Number(argv.at(-2))
  if (argv[mapAt + 1] !== '[vout]' || argv[mapAt + 2] !== '-map') return null
  const audioMap = /^(\d+):a$/.exec(argv[mapAt + 3] || '')
  if (!Number.isFinite(durationSec) || !audioMap) return null
  const inputs = argv.slice(0, mapAt).flatMap((value, i, all) => (all[i - 1] === '-i' ? [value] : []))
  const audioInput = inputs[Number(audioMap[1])]
  if (!audioInput) return null
  const pre = [...argv.slice(0, mapAt)]
  const graph = pre.splice(graphAt, 2)[1]!
  const video: string[] = []
  const audio: string[] = []
  const mux: string[] = []
  const enc = argv.slice(mapAt + 4, -3)
  for (let i = 0; i < enc.length; i += 2) {
    const pair = enc.slice(i, i + 2)
    if (pair[0] === '-c:a' || pair[0] === '-b:a') audio.push(...pair)
    else if (pair[0] === '-movflags') mux.push(...pair)
    else video.push(...pair)
  }
  if (enc.length % 2 || !audio.length) return null
  return { pre, graph_index: graphAt, graph, video_args: video, audio_args: audio, mux_args: mux,
    audio_input: audioInput, duration_sec: durationSec, output }
}

/**
 * A resumed render also skips the looped still images (a frame board, an image overlay) and the
 * plain colour boards up to the lead, which otherwise draw every skipped frame (measured: 46 s of
 * a 51 s resume of the last 20 s of an 8-minute TerraNash render). A looped still gives the same
 * picture at every timestamp, and its first frame is at 0, so seeking it with `-itsoffset` keeps
 * its timestamps and its `setpts=PTS-STARTPTS` is just `setpts=PTS`.
 */
function resumeInputs(pre: string[], graph: string, fromSec: number): { pre: string[]; graph: string } {
  if (fromSec <= 0) return { pre, graph }
  const lead = seconds(Math.max(0, fromSec - RESUME_LEAD_SEC))
  const out: string[] = []
  let input = 0
  let optionsFrom = 0
  for (let i = 0; i < pre.length; i++) {
    if (pre[i] === '-i') {
      const options = pre.slice(optionsFrom, i)
      // Not one limited by `-t`: it may end before the lead, and its last frame is held.
      const looped = options.some((arg, k) => arg === '-loop' && options[k + 1] === '1') && !options.includes('-t')
      if (looped && input > 0) {
        out.push('-ss', lead, '-itsoffset', lead)
        graph = graph.split(`[${input}:v]setpts=PTS-STARTPTS`).join(`[${input}:v]setpts=PTS`)
      }
      out.push(pre[i]!, pre[i + 1]!)
      i++
      input++
      optionsFrom = i + 1
      continue
    }
    out.push(pre[i]!)
  }
  // A colour board generated in the graph (`color=…[board]`, not the one-frame mask source).
  graph = graph.replace(/(^|;\s*)(color=[^;[]*?)(\[[^\]]+\])/g, (all, head: string, chain: string, label: string) => (
    chain.includes('trim=') || /(^|[:=,])(d|duration)=/.test(chain) ? all : `${head}${chain},trim=start=${lead}${label}`))
  return { pre: out, graph }
}

/** One FFmpeg run that writes segments `fromIndex…` into `pattern` (`…/final_seg_%04d.mp4`), video only. */
export function segmentRenderArgs(
  split: OneShotArgv,
  plan: FinalSegmentPlan,
  fromIndex: number,
  pattern: string,
  listPath: string,
): string[] {
  const fromSec = segmentRange(plan, fromIndex).start_sec
  const resumed = resumeInputs(split.pre.slice(0, split.graph_index), resumeFilterGraph(split.graph, fromSec), fromSec)
  const pre = [...resumed.pre, '-filter_complex', resumed.graph, ...split.pre.slice(split.graph_index)]
  const later = plan.cut_frames.slice(fromIndex).map(frame => seconds(frame * plan.frame_sec - fromSec - CUT_EPSILON_SEC))
  const lengthSec = plan.render_end_sec - fromSec
  return [
    ...pre,
    '-map', '[vout]',
    ...split.video_args,
    ...(later.length ? ['-force_key_frames', later.join(',')] : []),
    '-t', seconds(lengthSec),
    '-f', 'segment',
    // A time past the end keeps the muxer from its 2-second default when no cut is left.
    '-segment_times', [...later, seconds(lengthSec + 3600)].join(','),
    '-segment_start_number', String(fromIndex),
    '-reset_timestamps', '1',
    '-segment_format', 'mp4',
    '-segment_list', listPath,
    '-segment_list_type', 'csv',
    pattern,
  ]
}

/** Join the segments (`concatList`, in play order) without re-encoding and mux the single audio track. */
export function concatMuxArgs(split: OneShotArgv, concatList: string): string[] {
  const tag = split.video_args.indexOf('-tag:v')
  return [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-i', split.audio_input,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', ...(tag >= 0 ? split.video_args.slice(tag, tag + 2) : []),
    ...split.audio_args,
    ...split.mux_args,
    '-t', seconds(split.duration_sec),
    split.output,
  ]
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * What in the job's work folder the render reads, made comparable across a restart: the argv with
 * the work folder and the timestamped output name replaced by placeholders, plus the sha256 of
 * every work-folder file it names (the intermediate video, the burned subtitles, a shaped logo).
 * The audio is left out on purpose: segments are video only and the audio is muxed at the end.
 */
export async function workFolderIdentity(
  argv: readonly string[],
  workDir: string,
  output: string,
  skip: readonly string[] = [],
): Promise<{ argv: string[]; files: Record<string, string> }> {
  const outputName = path.basename(output)
  const files: Record<string, string> = {}
  for (const name of (await fs.readdir(workDir).catch(() => [] as string[])).sort()) {
    if (name === outputName || name.startsWith('final_') || skip.includes(name)) continue
    if (!argv.some(arg => arg.includes(name))) continue
    const file = path.join(workDir, name)
    if ((await fs.stat(file).catch(() => null))?.isFile()) files[name] = await sha256File(file)
  }
  const escaped = escapeFilterPath(workDir)
  return {
    argv: argv.map(arg => arg.split(escaped).join('<work>').split(workDir).join('<work>').split(outputName).join('<output>')),
    files,
  }
}
