/**
 * What a caption line needs when its SCRIPT and its STYLE disagree.
 *
 * Three things live here, each measured, each per line: the face that can draw
 * the script (below), the size that script can fit (see `scriptLineOverride`),
 * and suppressing letter spacing on a line whose marks must stay attached.
 *
 * ── Why the face half exists ───────────────────────────────────────────────
 *
 * The owner's hand-lettered Shorts look (2026-10-29) is set in bundled Patrick
 * Hand, which carries Latin only. A Khmer channel caption in that style had no
 * glyphs to draw with, and on this build libass resolves through CoreText —
 * measured in `lib/subtitle-font-dir.ts` — so whatever the system cascade
 * offered was drawn instead, or boxes where it offered nothing. Silently. That
 * is the "renders something nobody chose" shape, in the renderer.
 *
 * The burn therefore asks the SHIPPED manifest which bundled face covers the
 * script and tags that line with an `\fn` override. Data, not a constant:
 * `bundled/fonts/fonts.json` already names every face's `scripts` (the
 * thumbnail text layer reads the same field), so a future hand-lettered Khmer
 * face is a manifest entry plus its files — no code change here.
 *
 * ── Deliberately narrow ────────────────────────────────────────────────────
 *
 *   - Only a BUNDLED face can gain a fallback. A system family (Helvetica,
 *     Georgia, …) is not in the manifest and is left exactly as it was, so no
 *     episode delivered before this existed can render differently.
 *   - Only a line that really contains a fallback script is tagged, so a
 *     Latin-only caption is byte-identical to what the engine emitted before.
 *   - The WHOLE line takes the fallback family, not just the run of foreign
 *     text. Every bundled Khmer face also carries Latin, so the line keeps one
 *     hand and one weight instead of changing face mid-sentence. (A line
 *     mixing two non-Latin scripts takes the first match; no built-in preset
 *     asks for that, and it is stated here rather than guessed at silently.)
 *   - A missing or unreadable bundle answers "nothing to tag", so a stripped
 *     build burns exactly what it burned before and never fails on this.
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fontsResourceDir } from './thumbnail-fonts.js'

/** One script a caption line may need, and the codepoints that identify it. */
interface ScriptRange {
  /** ISO 15924 code, as `fonts.json` spells it in `scripts[]`. */
  script: string
  test: RegExp
}

/**
 * Unicode data, not a catalogue: these are the writing systems the bundled
 * faces publish coverage for. Latin is in no list because every bundled face
 * carries it and an unknown character is not evidence of a script.
 */
const SCRIPT_RANGES: ScriptRange[] = [
  // Khmer block + Khmer Symbols.
  { script: 'khmr', test: /[\u1780-\u17FF\u19E0-\u19FF]/ },
  // Cyrillic.
  { script: 'cyrl', test: /[\u0400-\u04FF]/ },
  // CJK Unified Ideographs (+ Extension A).
  { script: 'hani', test: /[\u3400-\u4DBF\u4E00-\u9FFF]/ },
]

interface ManifestFace {
  id?: string
  family?: string
  role?: string
  scripts?: string[]
}

let cache: { dir: string; faces: ManifestFace[] } | null = null

/** The bundled manifest, read once per fonts directory. Never throws. */
function bundledFaces(): ManifestFace[] {
  const dir = fontsResourceDir()
  if (cache && cache.dir === dir) return cache.faces
  let faces: ManifestFace[] = []
  try {
    const file = path.join(dir, 'fonts.json')
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { fonts?: unknown }
      if (Array.isArray(parsed?.fonts)) faces = parsed.fonts as ManifestFace[]
    }
  } catch {
    faces = []
  }
  cache = { dir, faces }
  return faces
}

/** Forget the cached manifest (tests). */
export function clearScriptFallbackCache(): void { cache = null }

function declares(face: ManifestFace, script: string): boolean {
  return Array.isArray(face.scripts) && face.scripts.includes(script)
}

/**
 * The bundled family that draws `script`, or null when none is bundled.
 *
 * A `text` face is preferred over a `display` face: a fallback is there to
 * keep the words legible, not to make the line a headline.
 */
export function bundledFallbackFamily(script: string): string | null {
  const candidates = bundledFaces().filter(face => typeof face.family === 'string' && declares(face, script))
  const chosen = candidates.find(face => face.role === 'text') ?? candidates[0]
  return chosen?.family ?? null
}

/**
 * Does the chosen family cover `script`?
 * `null` means "not a bundled face", which is not the same question — a system
 * face is left alone whatever it covers.
 */
function familyCovers(fontFamily: string, script: string): boolean | null {
  const face = bundledFaces().find(entry => entry.family === fontFamily || entry.id === fontFamily)
  if (!face) return null
  return declares(face, script)
}

/**
 * The override block a caption line needs for its script, or `''`.
 *
 * Three separate things, all of them per LINE and all of them measured:
 *
 * ── 1. A face the script needs (§ the module header) ──────────────────────
 * `\fn<family>` when the style's own face is a bundled face that cannot draw
 * the line's script.
 *
 * ── 2. A size that script can actually fit ────────────────────────────────
 * `\fs<cap>` when the style asks for type larger than the script's measured
 * cap. Khmer is written without spaces, so a whole phrase is ONE unbreakable
 * "word" and libass has no shrink-to-fit. Measured 2026-10-29 by burning
 * shaped Khmer and measuring the ink at the 1080 reference: a 36-character
 * phrase spans 379 px at 64 px type and 570 px at 96 px; a 50-character phrase
 * already spans 876 px at 64 px (just inside the 1080 frame) and is clipped at
 * 80 px. So 64 px is the largest size at which a long, unbreakable Khmer cue
 * still fits — a shorter cue simply leaves more air around it.
 *
 * This is the answer to "big Latin, readable Khmer": the STYLE carries the
 * Latin size (a hand-lettered Short wants 100 px of it), and a Khmer line —
 * which is always a line the fallback touched — is brought back down to the
 * cap. It never shrinks a line whose own face already draws the script, so
 * every existing Khmer preset (Kantumruy Pro, Moul, Battambang at 38-42 px)
 * renders exactly as it did.
 *
 * ── 3. No letter spacing on a line with combining marks ───────────────────
 * `\fsp0`. A non-zero ASS `Spacing` makes THIS libass build lose complex-script
 * shaping entirely: every vowel sign and subscript is drawn in its isolated
 * form on a dotted circle (measured 2026-10-29 — the same Khmer line through
 * `shorts-vertical`, which sets no spacing, shapes correctly; add
 * `letter_spacing_px: 1.5` and it breaks; a `\fsp0` override on the line
 * restores it while the style's spacing still applies to every other line).
 *
 * A person who nudges "Letter spacing" on a Khmer caption would otherwise get
 * a line of dotted circles, so the guard is a property of the BURN, not of any
 * one preset. It only fires on a line that really contains a combining mark
 * (Unicode category M) while the style asks for spacing, so a Latin caption
 * keeps its spacing and no shipped look moves.
 *
 * `line` must already be brace-escaped (`escapeAssText`), which is what the
 * builder hands over; the tags it returns are the engine's own syntax.
 */
export interface ScriptLineInput {
  line: string
  /** The style's face, as written in the ASS style line. */
  fontFamily: string
  /** The style's font size at the 1080 reference. */
  fontSizePx: number
  /** The style's letter spacing at the 1080 reference. */
  letterSpacingPx: number
  /** `subtitlePixelScale(w, h)` — frame short edge / 1080. */
  scale: number
}

/**
 * Largest type each script may use, in px at the 1080 reference. Only scripts
 * whose phrases cannot break are capped; a script with ordinary spaces needs
 * nothing here.
 */
const SCRIPT_FONT_SIZE_CAP: Record<string, number> = {
  // Measured 2026-10-29: 50 characters of Khmer at 64 px span 876 of 1080 px;
  // the same phrase at 80 px is clipped by the frame.
  khmr: 64,
}

/** A combining mark the shaping engine must attach to the character before it. */
const COMBINING_MARK = /\p{M}/u

function round2(n: number): number { return Math.round(n * 100) / 100 }

export function scriptLineOverride(input: ScriptLineInput): string {
  const { line, fontFamily, fontSizePx, letterSpacingPx, scale } = input
  if (!line) return ''
  const tags: string[] = []

  for (const range of SCRIPT_RANGES) {
    if (!range.test.test(line)) continue
    if (familyCovers(fontFamily, range.script) !== false) continue
    const family = bundledFallbackFamily(range.script)
    if (!family) continue
    tags.push(`\\fn${family}`)
    const cap = SCRIPT_FONT_SIZE_CAP[range.script]
    if (cap && fontSizePx > cap) tags.push(`\\fs${round2(cap * scale)}`)
    break
  }

  if (letterSpacingPx !== 0 && COMBINING_MARK.test(line)) tags.push('\\fsp0')

  return tags.length ? `{${tags.join('')}}` : ''
}

/** The `{\fn…}` family a line's script needs, or null. Tests and callers that
 *  only want the family answer (not the whole block) use this. */
export function fallbackFamilyForLine(line: string, fontFamily: string): string | null {
  if (!line) return null
  for (const range of SCRIPT_RANGES) {
    if (!range.test.test(line)) continue
    if (familyCovers(fontFamily, range.script) !== false) continue
    return bundledFallbackFamily(range.script)
  }
  return null
}
