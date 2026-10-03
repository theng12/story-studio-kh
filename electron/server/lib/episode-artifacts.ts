/**
 * Episode text-artifact path resolution (v1.0.228+).
 *
 * Pipeline text artifacts (chapter scripts, the unified narration, scene /
 * thumbnail / video prompts) are written as Markdown (`.md`). Older projects
 * still have the legacy Word (`.docx`) files on disk. This module centralizes
 * the "prefer .md, fall back to .docx" resolution so every reader / existence
 * check behaves consistently and no legacy episode is mis-reported as
 * "not generated". New writes are always `.md`; `.docx` is read-only legacy.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'

/** Resolution order — prefer `.md`, then legacy `.docx`. */
export const ARTIFACT_EXTS = ['.md', '.docx'] as const

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Given a directory + stem (filename without extension), return the existing
 * artifact path, preferring `.md` over legacy `.docx`. Null if neither exists.
 */
export function resolveArtifact(dir: string, stem: string): string | null {
  for (const ext of ARTIFACT_EXTS) {
    const p = path.join(dir, stem + ext)
    if (existsSync(p)) return p
  }
  return null
}

/** True if either `{stem}.md` or `{stem}.docx` exists in `dir`. */
export function artifactExists(dir: string, stem: string): boolean {
  return resolveArtifact(dir, stem) !== null
}

/** Force a path's extension to `.md` (used to derive a write target from a
 *  legacy `*.docx` path constant). Leaves non-docx paths untouched except for
 *  swapping a trailing `.docx`. */
export function toMdPath(p: string): string {
  return p.replace(/\.docx$/i, '.md')
}

/**
 * Given a path constant that may still carry a legacy `.docx` extension (e.g.
 * `paths.narration_docx`, now valued `.md`), return the path that actually
 * exists on disk: the `.md` sibling if present, else the `.docx`, else the
 * `.md` path (so a missing-file error reports the modern name).
 */
export function resolveReadPath(pathConstant: string): string {
  const md = toMdPath(pathConstant)
  if (existsSync(md)) return md
  const docx = md.replace(/\.md$/i, '.docx')
  if (existsSync(docx)) return docx
  return md
}

/** Derive the `.intro.json` marker path from a narration path constant,
 *  tolerating either a `.md` or legacy `.docx` extension. */
export function introMarkerPath(narrationPathConstant: string): string {
  return narrationPathConstant.replace(/\.(?:md|docx)$/i, '.intro.json')
}

/**
 * Match a chapter source filename for `code`, accepting BOTH `.md` and legacy
 * `.docx`. Returns the 1-based chapter number, or null if it's not a chapter
 * file. Used by every chapter-scan regex so mixed-extension dirs (a partially
 * regenerated legacy project) enumerate correctly.
 */
export function matchChapterFile(name: string, code: string): number | null {
  const re = new RegExp(`^${escapeRegex(code)}_Chapter_(\\d+)\\.(?:md|docx)$`, 'i')
  const m = name.match(re)
  return m ? parseInt(m[1]!, 10) : null
}


/**
 * A line that stamps THE APPLICATION'S OWN NAME onto a customer artifact.
 *
 * Up to v1.4.66 `buildNarrationDocx`/`buildImagePromptsDocx` wrote
 * `Story Studio \u2022 Episode {code}` as the second line of every unified
 * narration and image-prompts file. Those files are read back VERBATIM as the
 * "Story context" block of the YouTube description / tag / thumbnail / scene
 * prompts, so the model was handed the tool's name as if it were the series
 * name — and wrote it into published copy: "In this episode of Story Studio",
 * "#StoryStudio". A prompt carries the CHANNEL's identity; it must never carry
 * the software's.
 *
 * The writer no longer emits the line, but every file already on disk still
 * has it, so it is also removed on the way IN to a prompt. Matching is on the
 * whole stamp line (optionally italicised, optionally " KH"), never on a bare
 * occurrence of the words, so narration prose is never altered.
 */
const TOOL_IDENTITY_STAMP =
  /^[ \t]*\*?[ \t]*Story[ \t\-_]*Studio(?:[ \t]+KH)?[ \t]*[\u2022\u00b7|\u2013\u2014-][^\n]*$/i

/** Drop every application-identity stamp line from artifact text. */
export function stripToolIdentityStamp(text: string): string {
  return text.split('\n').filter(line => !TOOL_IDENTITY_STAMP.test(line)).join('\n')
}

/**
 * Read an artifact as raw plain text, dual-read: a `.md`/`.txt` file is read
 * directly; a legacy `.docx` goes through mammoth's text extractor. Replaces
 * the direct `mammoth.extractRawText({ path: paths.narration_docx })` calls so
 * those readers transparently handle both formats.
 *
 * Every caller of this feeds the result into an LLM prompt as story context,
 * so the application-identity stamp legacy files carry is removed here rather
 * than at each of those call sites.
 */
export async function readArtifactRawText(pathConstant: string): Promise<string> {
  const p = resolveReadPath(pathConstant)
  if (/\.docx$/i.test(p)) {
    const mammoth = await import('mammoth')
    return stripToolIdentityStamp((await mammoth.default.extractRawText({ path: p })).value)
  }
  return stripToolIdentityStamp(await fs.readFile(p, 'utf8'))
}
