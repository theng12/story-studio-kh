/**
 * macOS built-in TTS client — shells out to the system `say` command.
 *
 * Free, local, offline — no API key, no rate limits, no per-character cost.
 * The app is macOS-primary, so `say` is always present in production. Renders
 * to AIFF (say's native output) then transcodes to MP3 via the bundled ffmpeg,
 * matching the rest of Story Studio's real-MP3 pipeline contract (the section
 * merge concatenates with `-c copy`, which can't mix codecs).
 *
 * Intended use: zero-cost PREVIEW renders (hear a script's pacing before
 * spending ElevenLabs credits) and a free fallback. Quality is below
 * ElevenLabs / a Voice Studio clone, so it's a normal provider in the picker,
 * not a default.
 *
 * What we DON'T expose: the Siri voices. They're licensed to the Siri
 * assistant only — `say` silently falls back to the default voice when asked
 * for them, so they never appear in `say -v '?'` as addressable entries (and
 * using them in published content would be a licensing violation regardless).
 * Everything `say -v '?'` lists IS renderable; we just drop the classic
 * novelty voices (Bells, Boing, Zarvox, …) that are useless for narration.
 */

import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import { runFfmpeg } from './ffmpeg-utils.js'

const execFileP = promisify(execFile)

/** macOS-only. Guards every entry point so a non-darwin host fails clearly
 *  rather than spawning a missing binary. */
export function isMacosTtsAvailable(): boolean {
  return process.platform === 'darwin'
}

/**
 * Map the audio generator's `speed` multiplier to `say`'s words-per-minute.
 * `say`'s own default is ~175-200 wpm (too fast for narration — the user's
 * verdict). We anchor 1.0× at a calm 150 wpm so the existing Speed slider
 * lands in the sleep-story sweet spot, and scale linearly from there. Clamped
 * to say's sane range.
 */
const BASE_WPM = 150
export function speedToWpm(speed?: number): number {
  const s = typeof speed === 'number' && speed > 0 ? speed : 1
  return Math.round(Math.max(90, Math.min(300, BASE_WPM * s)))
}

export interface MacosVoice {
  /** Passed to `say -v` AND stored in form.voice (plain name, no prefix). */
  id: string
  name: string
  language: string
  /** 'premium' | 'enhanced' | 'base' — surfaced so the picker can float the
   *  good neural voices to the top. */
  tier: 'premium' | 'enhanced' | 'base'
}

/** Classic Apple "novelty"/effect voices — real + renderable, but useless for
 *  narration. Dropped from the list so the picker isn't cluttered. Matched
 *  case-insensitively against the BASE name (before any "(Enhanced)" suffix). */
const NOVELTY_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
  'good news', 'jester', 'organ', 'pipe organ', 'superstar', 'trinoids',
  'whisper', 'wobble', 'zarvox', 'junior', 'ralph', 'fred', 'kathy',
  'princess', 'deranged', 'hysterical',
].map(s => s.toLowerCase()))

/**
 * List the renderable English macOS voices, best (Premium/Enhanced) first.
 * Returns [] on any non-macOS host or parse failure — the picker treats an
 * empty list as "none available" rather than an error.
 */
export async function listMacosVoices(): Promise<MacosVoice[]> {
  if (!isMacosTtsAvailable()) return []
  let stdout = ''
  try {
    ({ stdout } = await execFileP('say', ['-v', '?'], { maxBuffer: 8 * 1024 * 1024 }))
  } catch {
    return []
  }
  const voices: MacosVoice[] = []
  // Each line: "<name (variable width, may contain spaces/parens)> <lang>    # sample"
  // e.g. "Evan (Enhanced)      en_US    # Hello! My name is Evan."
  const re = /^(.+?)\s+([a-z]{2}[-_][A-Z]{2})\s+#/
  for (const rawLine of stdout.split('\n')) {
    const m = rawLine.match(re)
    if (!m) continue
    const name = m[1]!.trim()
    const language = m[2]!.replace('_', '-')
    if (!language.toLowerCase().startsWith('en')) continue  // English only for now
    // Strip the quality suffix to get the base name for novelty matching.
    const baseName = name.replace(/\s*\((?:Enhanced|Premium)\)\s*$/i, '').trim().toLowerCase()
    if (NOVELTY_VOICES.has(baseName)) continue
    const tier: MacosVoice['tier'] = /\(Premium\)/i.test(name) ? 'premium'
      : /\(Enhanced\)/i.test(name) ? 'enhanced' : 'base'
    voices.push({ id: name, name, language, tier })
  }
  // De-dupe by id (say can list the same display name twice across regions;
  // first wins) and sort: premium → enhanced → base, then alphabetical.
  const seen = new Set<string>()
  const deduped = voices.filter(v => (seen.has(v.id) ? false : (seen.add(v.id), true)))
  const rank = { premium: 0, enhanced: 1, base: 2 }
  return deduped.sort((a, b) => rank[a.tier] - rank[b.tier] || a.name.localeCompare(b.name))
}

/**
 * Render `text` to `outPath` (MP3) using the macOS `say` voice. Writes the
 * text to a temp file (`-f`) to avoid arg-length / shell-escaping issues on
 * long chapters, renders AIFF, then transcodes to MP3 (192k libmp3lame —
 * transparent for speech). Honours an AbortSignal for user-cancel.
 */
export async function generateTtsToFile(
  outPath: string,
  req: { text: string; voiceId?: string; speed?: number },
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!isMacosTtsAvailable()) {
    throw new Error('macOS built-in voices (say) are only available on macOS.')
  }
  const wpm = speedToWpm(req.speed)
  const tmpAiff = path.join(os.tmpdir(), `macos-say-${randomUUID()}.aiff`)
  const tmpTxt = path.join(os.tmpdir(), `macos-say-${randomUUID()}.txt`)
  try {
    await fs.writeFile(tmpTxt, req.text, 'utf-8')
    const args: string[] = []
    if (req.voiceId) args.push('-v', req.voiceId)
    args.push('-r', String(wpm), '-f', tmpTxt, '-o', tmpAiff)
    await execFileP('say', args, { signal: opts.signal, maxBuffer: 1024 * 1024 })
    await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {})
    await runFfmpeg(['-y', '-i', tmpAiff, '-c:a', 'libmp3lame', '-b:a', '192k', outPath])
  } finally {
    await fs.rm(tmpAiff, { force: true }).catch(() => {})
    await fs.rm(tmpTxt, { force: true }).catch(() => {})
  }
}

/** Convenience for the provider/preview path — render to a temp MP3 and
 *  return its file:// URL. Caller owns cleanup. */
export async function generateTtsToTempFile(
  req: { text: string; voiceId?: string; speed?: number },
): Promise<{ filePath: string; fileUrl: string }> {
  const tmp = path.join(os.tmpdir(), `macos-say-${randomUUID()}.mp3`)
  await generateTtsToFile(tmp, req)
  return { filePath: tmp, fileUrl: pathToFileURL(tmp).href }
}
