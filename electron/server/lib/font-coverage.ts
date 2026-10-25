/**
 * Glyph coverage — does the chosen font actually have the characters in the headline?
 *
 * The renderer must never letter a headline in a face nobody chose. Family-name matching silently
 * substitutes (measured: six different family names, one identical output), so "it rendered" is not
 * evidence that the chosen font drew it. This reads the font file's own `cmap` and answers for each
 * character.
 *
 * Control characters and break opportunities are not letters and are never reported as missing —
 * `\n` forces a line break, U+200B is where a Khmer headline may wrap.
 */

import fs from 'fs/promises'

export interface GlyphCoverage {
  /** Characters the font has no glyph for, in the order they appear, de-duplicated. */
  missing: string[]
  /** True when every character that needs a glyph has one. */
  complete: boolean
}

/** Characters that shape no glyph of their own and must never count as missing. */
const NOT_DRAWABLE = /[\u0000-\u001F\u007F​‌‍﻿]/

interface ParsedCmap {
  /** Unicode codepoint → glyph id. */
  map: Map<number, number>
  /** The subtable format the mapping came from (diagnostics). */
  format: number
}

const cache = new Map<string, ParsedCmap>()

/**
 * Parse the best Unicode `cmap` subtable out of a TrueType/OpenType file.
 *
 * Preference order matches what Pango itself reads: a UCS-4 (3/10) table over a BMP (3/1) one, over
 * a Unicode-platform table. Format 12 (segmented coverage) and format 4 (the BMP classic) are the
 * two shapes every real font here uses.
 */
export function parseFontCmap(bytes: Buffer): ParsedCmap {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tableCount = view.getUint16(4)

  let cmapOffset = 0
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16
    const tag = String.fromCharCode(bytes[record]!, bytes[record + 1]!, bytes[record + 2]!, bytes[record + 3]!)
    if (tag === 'cmap') cmapOffset = view.getUint32(record + 8)
  }
  if (!cmapOffset) throw new Error('This font file has no cmap table, so its characters cannot be checked.')

  const subtableCount = view.getUint16(cmapOffset + 2)
  const subtables: Array<{ platform: number, encoding: number, offset: number }> = []
  for (let i = 0; i < subtableCount; i++) {
    const record = cmapOffset + 4 + i * 8
    subtables.push({
      platform: view.getUint16(record),
      encoding: view.getUint16(record + 2),
      offset: cmapOffset + view.getUint32(record + 4),
    })
  }

  const chosen = subtables.find(s => s.platform === 3 && s.encoding === 10)
    ?? subtables.find(s => s.platform === 3 && s.encoding === 1)
    ?? subtables.find(s => s.platform === 0)
    ?? subtables[0]
  if (!chosen) throw new Error('This font file lists no readable character map.')

  const format = view.getUint16(chosen.offset)
  const map = new Map<number, number>()

  if (format === 4) {
    const segCountX2 = view.getUint16(chosen.offset + 6)
    const segments = segCountX2 / 2
    const endBase = chosen.offset + 14
    const startBase = endBase + segCountX2 + 2
    const deltaBase = startBase + segCountX2
    const rangeBase = deltaBase + segCountX2
    for (let s = 0; s < segments; s++) {
      const end = view.getUint16(endBase + s * 2)
      const start = view.getUint16(startBase + s * 2)
      if (start === 0xFFFF) continue
      const delta = view.getInt16(deltaBase + s * 2)
      const rangeOffset = view.getUint16(rangeBase + s * 2)
      for (let code = start; code <= end; code++) {
        let glyph: number
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xFFFF
        } else {
          // idRangeOffset is relative to its own slot in the array.
          const slot = rangeBase + s * 2 + rangeOffset + (code - start) * 2
          if (slot + 1 >= bytes.length) continue
          const raw = view.getUint16(slot)
          glyph = raw ? (raw + delta) & 0xFFFF : 0
        }
        if (glyph) map.set(code, glyph)
      }
    }
  } else if (format === 12) {
    const groupCount = view.getUint32(chosen.offset + 12)
    for (let i = 0; i < groupCount; i++) {
      const group = chosen.offset + 16 + i * 12
      const start = view.getUint32(group)
      const end = view.getUint32(group + 4)
      const startGlyph = view.getUint32(group + 8)
      for (let code = start; code <= end; code++) map.set(code, startGlyph + (code - start))
    }
  } else {
    throw new Error(`This font file's character map is format ${format}, which Story Studio cannot check.`)
  }

  return { map, format }
}

/** Parse a font file once per process. */
async function cmapFor(file: string): Promise<ParsedCmap> {
  const hit = cache.get(file)
  if (hit) return hit
  const parsed = parseFontCmap(await fs.readFile(file))
  cache.set(file, parsed)
  return parsed
}

export function clearCmapCache(): void {
  cache.clear()
}

/**
 * Which characters of `text` the font file at `file` cannot draw.
 *
 * Characters outside the Basic Multilingual Plane (an emoji, say) are checked by codepoint, which
 * is what a format 12 table indexes.
 */
export async function missingCharacters(file: string, text: string): Promise<string[]> {
  const { map } = await cmapFor(file)
  const missing: string[] = []
  const seen = new Set<string>()
  for (const character of text) {
    if (NOT_DRAWABLE.test(character)) continue
    if (seen.has(character)) continue
    seen.add(character)
    const codepoint = character.codePointAt(0)!
    if (!map.has(codepoint)) missing.push(character)
  }
  return missing
}

/** The coverage verdict for a headline in a font. */
export async function glyphCoverage(file: string, text: string): Promise<GlyphCoverage> {
  const missing = await missingCharacters(file, text)
  return { missing, complete: missing.length === 0 }
}

/** The ISO 15924 scripts this font can plausibly draw, from the scripts of its own codepoints. */
export async function coveredScripts(file: string): Promise<string[]> {
  const { map } = await cmapFor(file)
  const scripts = new Set<string>()
  for (const code of map.keys()) {
    if (code >= 0x1780 && code <= 0x17FF) scripts.add('khmr')
    else if (code >= 0x19E0 && code <= 0x19FF) scripts.add('khmr')
    else if (code >= 0x0E00 && code <= 0x0E7F) scripts.add('thai')
    else if (code >= 0x0E80 && code <= 0x0EFF) scripts.add('lao')
    else if (code >= 0x1000 && code <= 0x109F) scripts.add('mymr')
    else if (code >= 0x4E00 && code <= 0x9FFF) scripts.add('hani')
    else if (code >= 0x3040 && code <= 0x30FF) scripts.add('jpan')
    else if (code >= 0xAC00 && code <= 0xD7AF) scripts.add('kore')
    else if (code >= 0x0600 && code <= 0x06FF) scripts.add('arab')
    else if (code >= 0x0900 && code <= 0x097F) scripts.add('deva')
    else if (code >= 0x0400 && code <= 0x04FF) scripts.add('cyrl')
    else if (code >= 0x0370 && code <= 0x03FF) scripts.add('grek')
    else if (code >= 0x0590 && code <= 0x05FF) scripts.add('hebr')
    else if (code >= 0x0E00 && code <= 0x0E7F) scripts.add('thai')
    else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) || (code >= 0xC0 && code <= 0x24F)) scripts.add('latn')
  }
  return [...scripts].sort()
}
