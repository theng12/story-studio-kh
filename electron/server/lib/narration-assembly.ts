/**
 * Per-chapter narration source files + unified assembly artifact.
 *
 * Storage model (decided in the per-chapter refactor plan):
 *   {code}_Chapter_01.docx        ← source, overwritten on regen
 *   {code}_Chapter_02.docx          (one file per chapter)
 *   {code}_Introduction.docx      ← source, optional
 *   {code}_Script_Narration.docx  ← ASSEMBLED build artifact
 *
 * Every downstream reader (audio reconciler, subtitles, video assembly,
 * image-prompts/metadata story-context, AI-video) targets the unified
 * narration_docx. Treating it as derived (re-assembled on every change)
 * keeps the blast radius of this refactor at zero for those consumers.
 *
 * The chapter parser/writer here mirrors the markdown shape that
 * `narrationPrompt` already instructs the LLM to produce — `# Introduction`,
 * `# {title} — Narration`, `## Chapter N: Title` — so existing prompt
 * output maps 1:1 into per-chapter files without an extra parse pass.
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { buildNarrationDocx } from './docx-builder.js'
import { narrationDocxToMarkdown } from './docx-parser.js'
import { matchChapterFile, resolveArtifact, resolveReadPath } from './episode-artifacts.js'
import { normalizeSpokenNumbers } from './tts-text.js'

export interface NarrationParts {
  intro?: { text: string }
  chapters: Array<{
    number: number
    title: string
    text: string
  }>
}

export interface WriteChapterFilesOptions {
  /** False only for byte-preserving legacy materialisation. New saves default true. */
  normalizeSpokenProse?: boolean
}

// ── Bulk LLM output → per-chapter parts ────────────────────────────────────

/**
 * Parse a bulk-generated narration markdown source into intro + chapters.
 * Accepts the exact format `narrationPrompt` instructs the LLM to emit:
 *
 *   # Introduction (~350 words)        ← optional
 *   <intro paragraphs>
 *   # {title} — Narration              ← separator (skipped)
 *   ## Chapter 01: The Mist-Kissed Shore
 *   <chapter paragraphs>
 *   ## Chapter 02: …
 *
 * Robust to the small variations the model emits in practice:
 *   - "# Introduction" / "# Intro" / "# Introduction (~350 words)"
 *   - chapter titles separated by colon, dash, en-dash or em-dash
 *   - extra blank lines inside any block
 *
 * Pure function (no I/O) so it's fixture-friendly and unit-testable
 * without writing docx files.
 */
export function splitNarrationIntoChapters(narrationText: string): NarrationParts {
  const lines = narrationText.split('\n')
  let mode: 'preamble' | 'intro' | 'between' | 'chapter' = 'preamble'
  let introBuf: string[] = []
  let currentChapter: { number: number; title: string; lines: string[] } | null = null
  const chapters: Array<{ number: number; title: string; text: string }> = []

  function flushChapter() {
    if (!currentChapter) return
    const text = currentChapter.lines.join('\n').trim()
    if (text) chapters.push({ number: currentChapter.number, title: currentChapter.title, text })
    currentChapter = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '')
    const trimmed = line.trim()

    // Level-1 headings: Introduction marker, Narration separator, or other.
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      const headingText = trimmed.slice(2).trim().toLowerCase()
      if (/^intro(duction)?\b/.test(headingText)) {
        flushChapter()
        introBuf = []
        mode = 'intro'
        continue
      }
      // Anything else at level 1 (e.g. "{title} — Narration") is a
      // separator between intro and chapters. Don't capture it as text.
      flushChapter()
      mode = 'between'
      continue
    }

    // Level-2 section heading. Accepts any of the known format-aware
    // section terms (Chapter for sleep-story / narrative, Reason for
    // bound-explainer, Topic for listicle, Section/Part/Lesson/Bit for
    // future / user-custom formats). The actual term doesn't matter
    // structurally — we capture (term, number, title) and downstream
    // slug derivation reuses the term verbatim, so audio MP3 filenames
    // and the audio_chapters.json slugs naturally reflect what the
    // format calls itself ("Reason_01.mp3", not "Chapter_01.mp3").
    const chapterMatch = trimmed.match(/^##\s+(Chapter|Reason|Topic|Section|Part|Lesson|Bit|Beat)\s+(\d+)\s*[:\-–—]\s*(.+)$/i)
    if (chapterMatch) {
      flushChapter()
      currentChapter = {
        number: parseInt(chapterMatch[2]!, 10),
        title: chapterMatch[3]!.trim(),
        lines: [],
      }
      mode = 'chapter'
      continue
    }

    // Body paragraph
    if (mode === 'intro') {
      introBuf.push(line)
    } else if (mode === 'chapter' && currentChapter) {
      currentChapter.lines.push(line)
    }
    // 'preamble' / 'between' lines are dropped — they're title cards, blank
    // lines before the first heading, or the "Narration" separator block.
  }
  flushChapter()

  const intro = introBuf.join('\n').trim()
  const out: NarrationParts = { chapters }
  if (intro) out.intro = { text: intro }
  return out
}

// ── Per-chapter docx writers ───────────────────────────────────────────────

/**
 * File-name conventions used everywhere downstream. Centralised so a
 * future rename only touches this module.
 */
export function chapterFilename(code: string, chapterNumber: number): string {
  return `${code}_Chapter_${chapterNumber.toString().padStart(2, '0')}.md`
}

export function introductionFilename(code: string): string {
  return `${code}_Introduction.md`
}

export function chapterFilePath(scriptDir: string, code: string, chapterNumber: number): string {
  return path.join(scriptDir, chapterFilename(code, chapterNumber))
}

export function introductionFilePath(scriptDir: string, code: string): string {
  return path.join(scriptDir, introductionFilename(code))
}

/**
 * Write all chapter files (and intro file, if present) from a parsed
 * NarrationParts. Each chapter file is a one-section narration docx —
 * heading `## Chapter NN: Title`, then body paragraphs — so re-reading
 * with `parseNarrationDocx` yields a single section with the right slug.
 */
export async function writeChapterFiles(
  scriptDir: string,
  code: string,
  episodeTitle: string,
  parts: NarrationParts,
  options: WriteChapterFilesOptions = {},
): Promise<void> {
  await fs.mkdir(scriptDir, { recursive: true })

  // Per-chapter / intro source files SKIP the title-block branding so
  // assembleUnifiedNarration can concatenate the round-tripped markdown
  // without N copies of the episode title interleaving with the content.
  // The unified narration docx still gets the full title block (see
  // assembleUnifiedNarration's buildNarrationDocx call below).
  for (const ch of parts.chapters) {
    const spokenText = options.normalizeSpokenProse === false
      ? ch.text
      : normalizeSpokenNumbers(ch.text).text
    const md = `## Chapter ${ch.number.toString().padStart(2, '0')}: ${ch.title}\n\n${spokenText}\n`
    await buildNarrationDocx(
      md, code, episodeTitle, chapterFilePath(scriptDir, code, ch.number),
      { includeTitleBlock: false },
    )
  }

  if (parts.intro) {
    const spokenText = options.normalizeSpokenProse === false
      ? parts.intro.text
      : normalizeSpokenNumbers(parts.intro.text).text
    const md = `# Introduction\n\n${spokenText}\n`
    await buildNarrationDocx(
      md, code, episodeTitle, introductionFilePath(scriptDir, code),
      { includeTitleBlock: false },
    )
  }
}

// ── Unified assembly ───────────────────────────────────────────────────────

/**
 * Read every per-chapter source file (and intro file, if present) from
 * `scriptDir`, concatenate in deterministic order (intro → chapters by
 * ascending number), and write the unified `{code}_Script_Narration.docx`.
 *
 * Re-readable by `parseNarrationDocx` exactly as before — `Introduction`
 * is the first section, then `Chapter_01`, `Chapter_02`, … — so audio,
 * subtitles, video assembly, and the story-context readers don't need
 * to change at all.
 *
 * Returns the list of chapter numbers found, for logging / response
 * shapes. An empty array is allowed and produces a unified file with
 * just the intro (or, if neither exists, the unified file is NOT
 * written and we return [] without erroring — caller decides whether
 * that's a problem).
 */
export async function assembleUnifiedNarration(
  scriptDir: string,
  code: string,
  episodeTitle: string,
): Promise<{ chapter_numbers: number[]; introduction_present: boolean }> {
  // resolveReadPath so a legacy `_Introduction.docx` is still found.
  const introPath = resolveReadPath(introductionFilePath(scriptDir, code))
  const introductionPresent = existsSync(introPath)

  // Discover chapter files: scan the directory for files matching the
  // exact pattern. Avoids assuming a chapter count from the form.
  let entries: string[] = []
  try { entries = await fs.readdir(scriptDir) } catch { /* dir missing → empty */ }
  // Match .md (new) AND legacy .docx so a partially-regenerated legacy
  // episode (mixed extensions) still assembles every chapter.
  const chapterNumbers: number[] = []
  for (const name of entries) {
    const n = matchChapterFile(name, code)
    if (n !== null) chapterNumbers.push(n)
  }
  chapterNumbers.sort((a, b) => a - b)

  if (!introductionPresent && chapterNumbers.length === 0) {
    return { chapter_numbers: [], introduction_present: false }
  }

  const sections: string[] = []
  if (introductionPresent) {
    const md = await narrationDocxToMarkdown(introPath)
    // The intro file is written with `# Introduction` at the top, so the
    // round-trip already includes the heading — pass through as-is.
    sections.push(md.trim())
  }
  if (chapterNumbers.length) {
    // The unified narration historically has `# {title} — Narration` as a
    // separator between intro and the chapter block; parseNarrationDocx
    // recognises it as a level-1 reset that flushes the current section
    // (see docx-parser.ts:128). We emit it whenever there ARE chapters
    // so the layout matches the legacy format byte-for-byte.
    sections.push(`# ${episodeTitle} — Narration`)
    for (const num of chapterNumbers) {
      // resolveReadPath: a legacy episode may still have a .docx chapter
      // sitting next to freshly-regenerated .md siblings.
      const md = await narrationDocxToMarkdown(resolveReadPath(chapterFilePath(scriptDir, code, num)))
      sections.push(md.trim())
    }
  }

  const unified = sections.join('\n\n')
  const unifiedPath = path.join(scriptDir, `${code}_Script_Narration.md`)
  await buildNarrationDocx(unified, code, episodeTitle, unifiedPath)

  return { chapter_numbers: chapterNumbers, introduction_present: introductionPresent }
}

// ── Eager migration for legacy episodes ────────────────────────────────────

/**
 * Materialise per-chapter files from a legacy unified-only narration, if
 * none exist yet. Called from `/chapter-list` and `chapter-only` so any
 * read or regenerate against an old episode self-heals on first touch.
 *
 * Idempotent: if any `_Chapter_NN.docx` already exists OR the unified file
 * is missing, this is a no-op.
 *
 * Returns true if migration ran (chapter files were materialised), false
 * if nothing to do.
 */
export async function ensureChapterFilesMigrated(
  scriptDir: string,
  code: string,
  episodeTitle: string,
): Promise<boolean> {
  let entries: string[] = []
  try { entries = await fs.readdir(scriptDir) } catch { return false }
  const hasAnyChapterFile = entries.some(n => matchChapterFile(n, code) !== null)
  if (hasAnyChapterFile) return false

  // Source unified narration may be legacy .docx or new .md.
  const unifiedPath = resolveArtifact(scriptDir, `${code}_Script_Narration`)
  if (!unifiedPath) return false

  // Capture the original unified narration's mtime BEFORE we overwrite
  // it via re-assembly. Used to preserve mtimes on every materialised
  // file so audio_stale stays honest for episodes whose audio was
  // generated against the legacy unified file.
  let originalUnifiedStat: { atime: Date; mtime: Date } | null = null
  try { originalUnifiedStat = await fs.stat(unifiedPath) } catch { /* no source */ }

  // Round-trip via narrationDocxToMarkdown rather than parseNarrationDocx:
  // the markdown extractor preserves chapter heading text as-is (the
  // section parser drops descriptive titles, keeping only "Chapter NN"),
  // and it doesn't fire the parser's phantom-Introduction detection on
  // documents whose first h1 is the episode title rather than an
  // explicit `# Introduction` marker.
  const markdown = await narrationDocxToMarkdown(unifiedPath)
  const parts = splitNarrationIntoChapters(markdown)

  // Older-refactor episodes (pre-merge era): intro lived in a SEPARATE
  // `*_Script_Narration_Introduction.docx` file, the unified narration
  // had chapters only. If we didn't extract an intro from the unified
  // (which is common for these episodes — `# Introduction` was never
  // there), pull the intro text from the legacy separate file.
  if (!parts.intro) {
    const legacyIntroPath = path.join(scriptDir, `${code}_Script_Narration_Introduction.docx`)
    if (existsSync(legacyIntroPath)) {
      try {
        const mammoth = await import('mammoth')
        const r = await mammoth.default.extractRawText({ path: legacyIntroPath })
        // The legacy file was written with buildNarrationDocx's title
        // block — strip the leading title line + "Story Studio • Episode"
        // subtitle so the migrated intro is clean body text.
        const lines = r.value.split('\n').map(l => l.trim()).filter(Boolean)
        const dropPrefix = lines.findIndex(l => /^Story Studio\s+[\u2022•]/i.test(l))
        const body = (dropPrefix >= 0 ? lines.slice(dropPrefix + 1) : lines).join('\n').trim()
        if (body) parts.intro = { text: body }
      } catch { /* unreadable → no intro migrated */ }
    }
  }

  if (!parts.chapters.length && !parts.intro) return false

  await writeChapterFiles(scriptDir, code, episodeTitle, parts, { normalizeSpokenProse: false })

  // Always re-assemble: the unified narration on disk may have legacy
  // headings (e.g. `# {title} — Narration (5000+ words)`) or be missing
  // the Introduction section we just recovered from a legacy separate
  // file. Re-assembly produces a clean, consistent unified file every
  // consumer can rely on. Mtime is preserved below so audio_stale stays
  // honest for episodes whose audio was generated against the original.
  await assembleUnifiedNarration(scriptDir, code, episodeTitle)

  // Preserve the unified narration's original mtime on every materialised
  // source file (and on the freshly re-assembled unified). Without this,
  // eager-migration marks audio as stale on every legacy episode — the
  // chapter files would be "newer" than audio chunks generated before
  // the migration, even though the narrative content is unchanged.
  if (originalUnifiedStat) {
    const { atime, mtime } = originalUnifiedStat
    for (const ch of parts.chapters) {
      await fs.utimes(chapterFilePath(scriptDir, code, ch.number), atime, mtime).catch(() => {})
    }
    if (parts.intro) {
      await fs.utimes(introductionFilePath(scriptDir, code), atime, mtime).catch(() => {})
    }
    await fs.utimes(unifiedPath, atime, mtime).catch(() => {})
  }

  return true
}
