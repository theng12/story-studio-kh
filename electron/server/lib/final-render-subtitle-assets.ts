import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { normalizeSubtitleStyle } from '../contracts/subtitle-style.js'
import { glyphCoverage } from './font-coverage.js'
import { buildSubtitleAssDocument, parseSrt } from './subtitle-builder.js'
import { fontFilePath, readFontManifest, type FontManifestEntry } from './thumbnail-fonts.js'

/**
 * Prepares one composition's subtitles for the frozen remote stage
 * (`studio.render.subtitle.v1`, contract in
 * `_orchestra/remote-render-parity-20261104/subtitle-v1-contract.md`).
 *
 * The ASS document is the SAME one the local burn writes in `video.ts` §6b —
 * same SRT, same `normalizeSubtitleStyle`, same `buildSubtitleAssDocument`,
 * same canvas — so the bytes that cross the wire are the bytes this Mac would
 * burn. The font closure is the verified bundled subset that document needs:
 * the style's family, every `\fn` override the builder tagged, plus the first
 * manifest face (in manifest order) that covers any glyph neither of those can
 * draw. A family with no bundled bytes (Helvetica, any system face) is
 * `subtitles_font_unresolved`, never a silent substitution; a bundled file
 * whose bytes disagree with its manifest hash is `subtitles_font_integrity`.
 * Nothing here downloads a font or reads a system face.
 *
 * Failures return a reason instead of throwing: the caller keeps the render
 * local with that exact reason and the detail (the family) in the job log.
 */

export interface PreparedSubtitleFont {
  /** Generated wire id `subtitle_font_<4-digit>` — sorted by source bundled-manifest id. */
  id: string
  family: string
  /** Scratch/bundled file staging copies; never a node path on the wire. */
  path: string
  sha256: string
  size_bytes: number
}

export interface PreparedSubtitleAssets {
  ass: { path: string; sha256: string; size_bytes: number }
  /** Nonempty, ordered by source bundled-manifest id. */
  fonts: PreparedSubtitleFont[]
}

export type SubtitleLocalReason =
  | 'subtitles_ass_unavailable'
  | 'subtitles_payload_unsupported'
  | 'subtitles_font_unresolved'
  | 'subtitles_font_integrity'

export type SubtitlePreparation =
  | { ok: true; prepared: PreparedSubtitleAssets }
  | { ok: false; reason: SubtitleLocalReason; detail: string }

export interface PrepareSubtitleInput {
  srt_path: string
  /** Legacy flat style or a v2 document — `normalizeSubtitleStyle` is the boundary that validates either. */
  style: unknown
  frame_w: number
  frame_h: number
  target_duration_sec: number
  /** The run's existing scratch root (the merged master's directory). */
  dir: string
}

/** The only sections Story's builder emits; anything else is refused. */
const ALLOWED_SECTIONS = new Set(['[Script Info]', '[V4+ Styles]', '[Events]'])
/** Lines that would reach outside the packet for a font, a file or an include. */
const EXTERNAL_REFERENCE = /^(Import|Video File|Embedded Fonts)\s*:/i

function fail(reason: SubtitleLocalReason, detail: string): SubtitlePreparation {
  return { ok: false, reason, detail }
}

function assTimeToSeconds(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100
}

/**
 * The contract's payload refusals: a section Story never emits (which is where
 * an embedded-font or include-like payload would live), an external reference,
 * a canvas that is not this composition's, no events, or a dialogue window
 * outside the render. Returns the refusal detail, or null when the document is
 * exactly the closed shape.
 */
function validateAssPayload(ass: string, width: number, height: number, duration: number): string | null {
  let playResX: number | null = null
  let playResY: number | null = null
  let dialogues = 0
  for (const rawLine of ass.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('[')) {
      if (!ALLOWED_SECTIONS.has(line)) return `unexpected ASS section ${line}`
      continue
    }
    if (EXTERNAL_REFERENCE.test(line)) return `ASS carries an external reference (${line.split(':')[0]})`
    if (line.startsWith('PlayResX:')) playResX = Number(line.slice('PlayResX:'.length).trim())
    else if (line.startsWith('PlayResY:')) playResY = Number(line.slice('PlayResY:'.length).trim())
    else if (line.startsWith('Dialogue:')) {
      const fields = line.split(',')
      const start = assTimeToSeconds(fields[1] ?? '')
      const end = assTimeToSeconds(fields[2] ?? '')
      if (start === null || end === null || !(start >= 0) || !(end > start)) {
        return `dialogue event ${fields[1] ?? '?'}-${fields[2] ?? '?'} is malformed`
      }
      // assTime rounds to the centisecond, so allow exactly that much slack.
      if (end > duration + 0.01) return `dialogue event ends at ${end.toFixed(2)}s, past the ${duration}s render`
      dialogues += 1
    }
  }
  if (playResX !== width || playResY !== height) {
    return `ASS PlayRes is ${playResX ?? 'missing'}x${playResY ?? 'missing'} but the canvas is ${width}x${height}`
  }
  if (dialogues < 1) return 'ASS contains no dialogue events'
  return null
}

/** Dialogue text with override blocks and `\N`-style escapes removed — the glyphs libass must draw. */
function dialogueGlyphText(ass: string): string {
  const parts: string[] = []
  for (const rawLine of ass.split(/\r?\n/)) {
    if (!rawLine.startsWith('Dialogue:')) continue
    const fields = rawLine.split(',')
    const text = fields.slice(9).join(',')
    parts.push(text.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ''))
  }
  return parts.join('')
}

/** Characters still uncovered by the current closure, in first-appearance order. */
async function uncoveredCharacters(closure: readonly FontManifestEntry[], text: string): Promise<string[]> {
  let remaining = [...new Set([...text])]
    .filter(character => !/[\u0000-\u001F\u007F​‌‍﻿]/.test(character))
  for (const entry of closure) {
    if (!remaining.length) break
    const { missing } = await glyphCoverage(fontFilePath(entry), remaining.join(''))
    const missingSet = new Set(missing)
    remaining = remaining.filter(character => missingSet.has(character))
  }
  return remaining
}

function describeCharacters(characters: readonly string[]): string {
  return characters.slice(0, 8)
    .map(character => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(', ') + (characters.length > 8 ? `, +${characters.length - 8} more` : '')
}

/**
 * The complete bundled closure for one document: style family plus every
 * `\fn` override, then the first manifest face that covers each remaining
 * glyph — deterministic (manifest order, rescan after each addition), and
 * honest when no bundled face can tie a glyph to transferable bytes.
 */
async function resolveFontClosure(ass: string): Promise<SubtitlePreparation | { ok: true; fonts: PreparedSubtitleFont[] }> {
  const manifest = await readFontManifest()
  const byFamily = new Map<string, FontManifestEntry>()
  for (const entry of manifest.fonts) if (!byFamily.has(entry.family)) byFamily.set(entry.family, entry)

  const families = new Set<string>()
  const styleMatch = /^Style:\s*[^,]+,\s*([^,]+),/m.exec(ass)
  if (styleMatch?.[1]?.trim()) families.add(styleMatch[1].trim())
  for (const match of ass.matchAll(/\\fn([^}\\]*)/g)) {
    const family = match[1].trim()
    if (family) families.add(family)
  }
  if (families.size < 1) return fail('subtitles_font_unresolved', 'the ASS document names no font family')

  const closure = new Map<string, FontManifestEntry>()
  for (const family of families) {
    const entry = byFamily.get(family)
    // A system face (Helvetica the default) has no transferable bundled bytes.
    if (!entry) return fail('subtitles_font_unresolved', family)
    closure.set(entry.id, entry)
  }

  const glyphText = dialogueGlyphText(ass)
  let remaining = await uncoveredCharacters([...closure.values()], glyphText)
  while (remaining.length) {
    let added = false
    for (const entry of manifest.fonts) {
      if (closure.has(entry.id)) continue
      const { missing } = await glyphCoverage(fontFilePath(entry), remaining.join(''))
      const missingSet = new Set(missing)
      if (remaining.some(character => !missingSet.has(character))) {
        closure.set(entry.id, entry)
        remaining = await uncoveredCharacters([...closure.values()], glyphText)
        added = true
        break
      }
    }
    if (!added) {
      const primary = [...families][0]
      return fail('subtitles_font_unresolved', `${primary}: no bundled face covers ${describeCharacters(remaining)}`)
    }
  }

  const ordered = [...closure.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const fonts: PreparedSubtitleFont[] = []
  for (const [index, entry] of ordered.entries()) {
    if (!/\.(ttf|otf)$/i.test(entry.file)) return fail('subtitles_font_unresolved', entry.family)
    let bytes: Buffer
    try {
      bytes = await fs.readFile(fontFilePath(entry))
    } catch {
      return fail('subtitles_font_unresolved', entry.family)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== entry.sha256) return fail('subtitles_font_integrity', entry.family)
    fonts.push({
      id: `subtitle_font_${String(index).padStart(4, '0')}`,
      family: entry.family,
      path: fontFilePath(entry),
      sha256,
      size_bytes: bytes.length,
    })
  }
  return { ok: true, fonts }
}

export async function prepareFinalRenderSubtitleAssets(input: PrepareSubtitleInput): Promise<SubtitlePreparation> {
  let raw: string
  try {
    raw = await fs.readFile(input.srt_path, 'utf-8')
  } catch {
    return fail('subtitles_ass_unavailable', `the caption file at ${path.basename(input.srt_path)} could not be read`)
  }
  const cues = parseSrt(raw)
  if (!cues.length) return fail('subtitles_ass_unavailable', 'the caption file has no cues')

  let rendered: { ass: string; events: number }
  try {
    const style = normalizeSubtitleStyle(input.style)
    const result = buildSubtitleAssDocument(cues, style, { width: input.frame_w, height: input.frame_h })
    if (!result.events || !result.ass) throw new Error('subtitle document contained no events')
    rendered = result
  } catch (error) {
    return fail('subtitles_ass_unavailable', error instanceof Error ? error.message : String(error))
  }

  const payloadProblem = validateAssPayload(rendered.ass, input.frame_w, input.frame_h, input.target_duration_sec)
  if (payloadProblem) return fail('subtitles_payload_unsupported', payloadProblem)

  let closure: Awaited<ReturnType<typeof resolveFontClosure>>
  try {
    closure = await resolveFontClosure(rendered.ass)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return fail(code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
      ? 'subtitles_font_unresolved' : 'subtitles_font_integrity',
    error instanceof Error ? error.message : String(error))
  }
  if (!('fonts' in closure)) return closure

  // The SAME fixed name and bytes the local burn writes, so a local fallback
  // after a remote refusal rewrites identical content over it.
  const assPath = path.join(input.dir, 'subtitles-burn.ass')
  const bytes = Buffer.from(rendered.ass, 'utf-8')
  try {
    await fs.mkdir(input.dir, { recursive: true })
    await fs.writeFile(assPath, bytes)
  } catch (error) {
    return fail('subtitles_ass_unavailable', error instanceof Error ? error.message : String(error))
  }
  return {
    ok: true,
    prepared: {
      ass: {
        path: assPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size_bytes: bytes.length,
      },
      fonts: closure.fonts,
    },
  }
}
