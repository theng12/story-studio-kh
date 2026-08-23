/**
 * Turn a chosen tracklist into one long video (v1.4.37).
 *
 * TWO FFMPEG STEPS, both cheap on purpose:
 *
 * 1. **Stitch** the tracks into one audio file with the concat demuxer. Tracks
 *    are BUTT-JOINED by default — the owner's ruling, twice, unprompted: "i
 *    personally don't like crossfades at all". A crossfade is available and
 *    ships off.
 * 2. **Loop** one short background clip to the audio's length. This is the
 *    reason a two-hour video costs almost nothing to produce: `-stream_loop`
 *    repeats a few seconds of footage and `-c:v copy` never re-encodes it, so
 *    the work is closer to a file copy than to rendering two hours of video.
 *
 * NOTHING HERE SPENDS A CREDIT. Assembly is free by design; the library is
 * topped up deliberately, in its own job. Keeping the render free of any
 * provider client is what makes that structural rather than a promise.
 */

import path from 'path'
import { formatConcatFileLine, getAudioDuration } from '../lib/ffmpeg-utils.js'

/**
 * Concat-demuxer list for the stitch.
 *
 * The demuxer joins streams without re-encoding, which is both faster and
 * lossless — but it requires every input to share a codec and sample rate.
 * Everything from one GenStudio music route does; a file the owner dropped in
 * through Finder might not, which is why `buildStitchArgs` re-encodes rather
 * than copying. Correctness over speed on a step that takes seconds either way.
 */
export function buildConcatList(absolutePaths: readonly string[]): string {
  return absolutePaths.map(formatConcatFileLine).join('\n') + '\n'
}

/**
 * Join the tracks into one audio file.
 *
 * @param crossfadeSec 0 = butt-join, the default and the owner's preference.
 *   A positive value crossfades each junction by that many seconds.
 */
export function buildStitchArgs(
  concatListPath: string,
  outPath: string,
  crossfadeSec = 0,
): string[] {
  const base = [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
  ]
  if (crossfadeSec > 0) {
    // acrossfade works pairwise, so a true N-way crossfade needs a filter chain
    // built per junction. `-af acrossfade` on a concat input cannot express
    // that, and pretending otherwise would silently produce butt-joins while
    // the UI claimed a crossfade. Refuse instead — the honest failure.
    throw new Error(
      'Crossfading a concat-demuxed mix is not supported. '
      + 'Build the crossfade chain per junction, or leave crossfades off.',
    )
  }
  return [...base, '-c:a', 'libmp3lame', '-b:a', '192k', outPath]
}

/**
 * Repeat a short clip under the finished audio.
 *
 * `-stream_loop -1` repeats the video for ever, `-shortest` stops at the audio,
 * and `-c:v copy` means the pixels are never touched. That combination is why a
 * two-hour music video is minutes of work rather than hours: FFmpeg is copying
 * the same few seconds of frames repeatedly, not encoding new ones.
 *
 * The audio is copied too — it was just encoded by the stitch, and re-encoding
 * it a second time would lose quality for nothing.
 */
export function buildLoopArgs(
  loopVideoPath: string,
  audioPath: string,
  outPath: string,
): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-stream_loop', '-1', '-i', loopVideoPath,
    '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ]
}

/**
 * Measure one audio file, in seconds.
 *
 * Returns `undefined` rather than throwing when a file cannot be probed, so one
 * unreadable track cannot fail a whole library scan. The mix builder already
 * treats a track with no measured duration as unusable and SAYS so, which is
 * the right outcome: unusable and visible beats a guessed length that makes a
 * two-hour video come out at one hour fifty.
 */
export async function measureTrackSeconds(filePath: string): Promise<number | undefined> {
  const seconds = await getAudioDuration(filePath)
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 100) / 100
    : undefined
}

/** Where a rendered mix and its working files live inside an episode folder. */
export function musicRenderPaths(episodeDir: string, episodeCode: string): {
  concatList: string
  stitchedAudio: string
  video: string
} {
  return {
    concatList: path.join(episodeDir, `${episodeCode}-music-concat.txt`),
    stitchedAudio: path.join(episodeDir, `${episodeCode}-music-mix.mp3`),
    video: path.join(episodeDir, `${episodeCode}-music.mp4`),
  }
}

/**
 * The description body: the tracklist, then whatever the channel appends.
 *
 * Timestamps come from the stitch, so they cannot drift from the audio — the
 * boundaries ARE the start times. This is the whole reason these channels earn
 * watch-time, and it costs nothing to produce.
 */
export function buildMusicDescription(tracklist: string, footer = ''): string {
  const parts = ['Tracklist', '', tracklist]
  if (footer.trim()) parts.push('', footer.trim())
  return parts.join('\n')
}
