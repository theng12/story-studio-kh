/**
 * A steady background-music bed (owner, 2026-10-09: music must never startle a sleeping listener).
 *
 * Night Atlas History's 10 approved tracks measured -14.8 to -28.9 LUFS (14 dB apart), with swells of
 * up to 19 LU inside a track. Every track is now levelled once (cached by content): a slow
 * dynaudnorm (7.5 s smoothing window, too slow to pump) evens out the swells, then one measured gain
 * puts the track at MUSIC_REFERENCE_LUFS. Tracks join with equal-power crossfades, and the joined bed
 * is made loopable by crossfading its end into its start, so a loop never hard-cuts either.
 */
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { getAudioDuration, runFfmpeg } from './ffmpeg-utils.js'
import { MIX_LIMITER } from './final-loudness.js'
import { measureLoudness } from '../generators/music-episode-build.js'
import { getUserDataDir } from '../services/project-manager.js'

/** Every music track is brought to this loudness before its volume setting applies. */
export const MUSIC_REFERENCE_LUFS = -20
/**
 * Swell taming: 500 ms frames with a 15-frame Gaussian window (7.5 s), too slow to pump on a beat;
 * up to 26 dB of lift for the quiet passages, none for near-silence (below -60 dBFS) so tails and
 * gaps are not pulled up into hiss. ±12 dB swells: LRA 23 → 5.
 */
export const MUSIC_TAME_FILTER = 'dynaudnorm=f=500:g=15:p=0.5:m=20:t=0.001'
export const MUSIC_CROSSFADE_SEC = 3
/** Bumped when the levelling changes, so stale cached tracks are never reused. */
const LEVEL_VERSION = 1

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export function levelledMusicDir(): string {
  return path.join(getUserDataDir(), 'music-levelled')
}

/** One track, swells tamed and set to MUSIC_REFERENCE_LUFS; cached as FLAC by content hash. */
export async function levelMusicTrack(file: string): Promise<{ path: string; cached: boolean }> {
  const dir = levelledMusicDir()
  const out = path.join(dir, `${await sha256OfFile(file)}-v${LEVEL_VERSION}.flac`)
  if (existsSync(out)) return { path: out, cached: true }
  await fs.mkdir(dir, { recursive: true })
  const tamed = `${out}.${process.pid}.tamed.wav`
  const part = `${out}.${process.pid}.part`
  try {
    await runFfmpeg(['-y', '-i', file, '-vn', '-af', `aresample=44100,aformat=channel_layouts=stereo,${MUSIC_TAME_FILTER}`, '-c:a', 'pcm_f32le', tamed])
    const m = await measureLoudness(tamed)
    const gain = m.lufs !== null && m.lufs > -69 ? MUSIC_REFERENCE_LUFS - m.lufs : 0
    const hot = m.true_peak_db !== null && m.true_peak_db + gain > -1
    await runFfmpeg(['-y', '-i', tamed, '-af', `volume=${gain.toFixed(2)}dB${hot ? `,${MIX_LIMITER}` : ''}`, '-c:a', 'flac', '-f', 'flac', part])
    await fs.rename(part, out)
  } finally {
    await fs.rm(tamed, { force: true })
    await fs.rm(part, { force: true })
  }
  return { path: out, cached: false }
}

/**
 * The ffmpeg graph that joins N inputs with crossfades into [cyc] and makes it loopable into [bed].
 * `lengths` are the inputs' durations in seconds. Exported for tests.
 */
export function musicBedGraph(lengths: number[], xf: number): string {
  const parts: string[] = []
  let last = '[0:a]'
  for (let i = 1; i < lengths.length; i++) {
    parts.push(`${last}[${i}:a]acrossfade=d=${xf}:c1=qsin:c2=qsin[x${i}]`)
    last = `[x${i}]`
  }
  const cycle = lengths.reduce((sum, len) => sum + len, 0) - (lengths.length - 1) * xf
  // Loop joint: the cycle's last xf seconds crossfade into its first xf, and the body plays between,
  // so looping the result flows end → start with no cut.
  parts.push(`${last}asplit=3[h][b][t]`,
    `[h]atrim=end=${xf},asetpts=PTS-STARTPTS[head]`,
    `[b]atrim=start=${xf}:end=${(cycle - xf).toFixed(3)},asetpts=PTS-STARTPTS[body]`,
    `[t]atrim=start=${(cycle - xf).toFixed(3)},asetpts=PTS-STARTPTS[tail]`,
    `[tail][head]acrossfade=d=${xf}:c1=qsin:c2=qsin[joint]`,
    '[body][joint]concat=n=2:v=0:a=1[bed]')
  return parts.join(';')
}

/** Level every file (cached), join them with crossfades and make the result loop seamlessly. */
export async function buildMusicBed(files: string[], tempDir: string, log: (line: string) => void): Promise<string> {
  const levelled = []
  for (const file of files) levelled.push(await levelMusicTrack(file))
  const lengths = await Promise.all(levelled.map(async t => Number(await getAudioDuration(t.path)) || 0))
  const xf = Math.max(0.5, Math.min(MUSIC_CROSSFADE_SEC, Math.min(...lengths) / 4))
  const out = path.join(tempDir, 'music_bed.flac')
  await runFfmpeg(['-y', ...levelled.flatMap(t => ['-i', t.path]), '-filter_complex', musicBedGraph(lengths, xf),
    '-map', '[bed]', '-c:a', 'flac', out])
  const fromCache = levelled.filter(t => t.cached).length
  log(`  Music: ${files.length} track(s) levelled to ${MUSIC_REFERENCE_LUFS} LUFS with the swells evened out`
    + `${fromCache ? ` (${fromCache} from cache)` : ''}; joins and the loop point crossfade over ${xf} s.`)
  return out
}
