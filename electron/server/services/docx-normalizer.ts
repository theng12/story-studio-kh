/**
 * Legacy narration docx → canonical Story Studio format normaliser.
 *
 * The user has pre-Story-Studio episodes whose narration docx files
 * don't follow the format the audio reconciler / video assembly expect:
 *   - missing the `# Introduction` / `## Chapter NN: Title` heading
 *     scaffolding that parseNarrationDocx() looks for
 *   - chapter boundaries inferred only from in-line text like
 *     "Chapter 1:" / "1." / scene markers / blank-line groups
 *
 * Rather than make every downstream consumer tolerate every possible
 * legacy shape, we restructure the source ONCE via an LLM pass and
 * write per-chapter files via the existing writeChapterFiles +
 * assembleUnifiedNarration machinery. The output is bit-identical to
 * what the script generator produces for fresh episodes.
 *
 * Idempotency: if the source already parses into a non-empty chapters
 * array (i.e. it's already canonical), we skip the LLM call entirely.
 *
 * Safety: the original source is backed up before any write lands, so
 * a botched normalisation is recoverable.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { splitNarrationIntoChapters, writeChapterFiles, assembleUnifiedNarration } from '../lib/narration-assembly.js'
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { resolveEpisodePaths } from './utils.js'
import * as im from './idea-manager.js'

export interface NormalizeOptions {
  model: string
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  /**
   * Test-only escape hatch: when supplied, the normaliser calls this
   * function instead of the real callAi. Mock LLM responses without
   * monkey-patching ESM module bindings (which are immutable). Production
   * callers leave this undefined.
   */
  _callAiOverride?: (model: string, system: string, user: string, apiKeys: any) => Promise<string>
}

export interface NormalizeResult {
  skipped: boolean                          // true when source was already canonical
  reason?: string                           // populated when skipped
  chapters_written: number                  // 0 when skipped
  introduction_written: boolean
  backup_at?: string                        // absolute path to the pre-write backup
  unified_narration_at?: string             // absolute path to the assembled output
}

const SYSTEM_PROMPT = `You are a precise text-restructuring assistant. The user will give you a chunk of narration text — a story formatted as flat paragraphs without machine-readable chapter structure. Your job is to add Markdown headings so it matches Story Studio's canonical narration format. You MUST preserve every paragraph verbatim — do not paraphrase, summarise, or reorder content. Only add the heading scaffolding around the existing text.`

const USER_INSTRUCTIONS_PREFIX = `Restructure the narration below into Story Studio's canonical Markdown format:

  # Introduction
  <introduction paragraphs, if any>

  # {EPISODE_TITLE} — Narration
  ## Chapter 01: {chapter title}
  <chapter 01 paragraphs>
  ## Chapter 02: {chapter title}
  <chapter 02 paragraphs>
  ...

Rules (strict):
1. Preserve every paragraph of the source verbatim. Do NOT paraphrase, summarise, condense, or reorder.
2. If the source has chapter markers (e.g. "Chapter 1:", "Part 1", numbered breaks), use them to determine chapter boundaries.
3. If the source has no chapter markers, infer logical chapter breaks based on scene transitions, time jumps, or narrative beats. Create ~6-12 chapters of roughly equal length.
4. Generate a short, evocative chapter title for each chapter based on its content (3-7 words).
5. If the source has an introduction or prologue (clearly distinct from the main narrative — sets up tone, themes, or invitation to listen), put it under \`# Introduction\`. If unclear, omit it.
6. The first non-introduction line MUST be \`# {EPISODE_TITLE} — Narration\`.
7. Each chapter heading MUST use \`## Chapter NN: Title\` format (zero-padded to 2 digits).
8. Output ONLY the restructured Markdown. No commentary, no surrounding code fences, no explanation.

Episode title: {EPISODE_TITLE}

Source narration:
---
`

/**
 * Read a docx and extract its plain text content (paragraphs joined with
 * blank lines). Used to feed the LLM the raw text without any structural
 * assumptions — mammoth's HTML output is over-engineered for our needs.
 */
async function extractRawText(docxPath: string): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: docxPath })
  return (result.value || '').trim()
}

/**
 * True when the source docx already produces a sensible chapter array via
 * parseNarrationDocx. Used as the idempotency check — re-running the
 * normaliser on an already-canonical docx is a no-op.
 *
 * Threshold: ≥1 chapter section that's NOT just the catch-all "Narration"
 * fallback bucket. parseNarrationDocx returns a single { slug:'Narration' }
 * section for fully-unstructured input, which is exactly the legacy case
 * we want to normalise — so that doesn't count as canonical.
 */
async function isAlreadyCanonical(docxPath: string): Promise<boolean> {
  try {
    const sections = await parseNarrationDocx(docxPath)
    if (!sections.length) return false
    const hasChapter = sections.some(s => s.slug.startsWith('Chapter_'))
    return hasChapter
  } catch {
    return false
  }
}

/**
 * Backup the source file with a timestamp suffix. Format:
 *   {basename}.original.{ISO8601-no-colons}.{ext}
 * Returns the absolute backup path.
 */
async function backupOriginal(docxPath: string): Promise<string> {
  const dir = path.dirname(docxPath)
  const ext = path.extname(docxPath)
  const stem = path.basename(docxPath, ext)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(dir, `${stem}.original.${ts}${ext}`)
  await fs.copyFile(docxPath, backupPath)
  return backupPath
}

/**
 * Main entry point.
 */
export async function normalizeNarrationDocx(
  slug: string,
  episodeCode: string,
  sourceDocxPath: string,
  opts: NormalizeOptions,
): Promise<NormalizeResult> {
  const code = episodeCode.toUpperCase()

  if (!existsSync(sourceDocxPath)) {
    throw new Error(`Source docx not found: ${sourceDocxPath}`)
  }

  // 1. Idempotency check — already canonical → no-op.
  if (await isAlreadyCanonical(sourceDocxPath)) {
    return {
      skipped: true,
      reason: 'Source already has canonical chapter structure',
      chapters_written: 0,
      introduction_written: false,
    }
  }

  // 2. Resolve episode paths (need title for the markdown template + script_dir).
  const ideas = await im.getIdeas(slug, 'accepted')
  const idea = ideas.find(i => (i.episode_code || '').toUpperCase() === code)
  if (!idea) throw new Error(`Episode ${code} not found in accepted ideas`)
  const paths = await resolveEpisodePaths(slug, code, idea.title || '')
  const episodeTitle = idea.title || code

  // 3. Read raw text + LLM-restructure.
  const rawText = await extractRawText(sourceDocxPath)
  if (rawText.length < 200) {
    throw new Error(`Source narration is too short to normalise (${rawText.length} chars)`)
  }
  const userPrompt = USER_INSTRUCTIONS_PREFIX.replace(/\{EPISODE_TITLE\}/g, episodeTitle) + rawText

  let restructured: string
  try {
    if (opts._callAiOverride) {
      restructured = await opts._callAiOverride(opts.model, SYSTEM_PROMPT, userPrompt, opts.apiKeys)
    } else {
      // Maximum: this returns the ENTIRE narration restructured. Anything
      // short of the product ceiling silently loses the tail of the script.
      restructured = await callAiWithRetry(opts.model, SYSTEM_PROMPT, userPrompt, opts.apiKeys, false, {
        slug, outputBudget: 'maximum',
      })
    }
  } catch (e: any) {
    throw new Error(`LLM normalisation failed: ${e?.message || 'unknown error'}`)
  }

  // 4. Parse the restructured output into intro + chapters.
  const parts = splitNarrationIntoChapters(restructured)
  if (!parts.chapters.length) {
    throw new Error(`LLM output produced zero chapters — model may have ignored the format instructions. First 200 chars: ${restructured.slice(0, 200)}`)
  }

  // 5. Backup original BEFORE any chapter write — so a partial failure
  //    leaves the user with a recoverable starting point.
  const backupPath = await backupOriginal(sourceDocxPath)

  // 6. Write per-chapter docx files via the existing helper.
  await writeChapterFiles(paths.script_dir, code, episodeTitle, parts)

  // 7. Assemble the unified narration docx (audio reconciler etc. all
  //    read from this file). This OVERWRITES the original source path
  //    if it lives at the canonical narration_docx location.
  const assembled = await assembleUnifiedNarration(paths.script_dir, code, episodeTitle)

  return {
    skipped: false,
    chapters_written: assembled.chapter_numbers.length,
    introduction_written: assembled.introduction_present,
    backup_at: backupPath,
    unified_narration_at: paths.narration_docx,
  }
}
