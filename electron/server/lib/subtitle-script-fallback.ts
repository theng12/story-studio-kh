/**
 * The face a caption line falls back to when the CHOSEN face cannot draw it.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
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
 * The `{\fn…}` override a caption line needs, or `''` when it needs none.
 *
 * `line` must already be brace-escaped (`escapeAssText`), which is what the
 * builder hands over; the tag it returns is the engine's own syntax.
 */
export function scriptFallbackTag(line: string, fontFamily: string): string {
  if (!line || !fontFamily) return ''
  for (const range of SCRIPT_RANGES) {
    if (!range.test.test(line)) continue
    if (familyCovers(fontFamily, range.script) !== false) continue
    const family = bundledFallbackFamily(range.script)
    if (family) return `{\\fn${family}}`
  }
  return ''
}
