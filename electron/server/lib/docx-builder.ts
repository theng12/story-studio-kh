/**
 * Write pipeline text artifacts as Markdown (`.md`).
 *
 * NOTE: despite the legacy `Docx` suffix, these functions now emit Markdown —
 * the names are kept to avoid a wide rename across ~8 call sites. The `.docx`
 * writer (the `docx` npm package) was dropped in v1.0.228; the content these
 * receive is ALREADY Markdown (`# `/`## ` headings), so writing it is just a
 * string write. Legacy `.docx` files are still READ via mammoth (docx-parser).
 */

import fs from 'fs/promises'
import path from 'path'
import { writeAtomic } from './sync-safe.js'

export interface BuildNarrationOpts {
  /**
   * Prepend the episode-title heading + "Story Studio • Episode {code}"
   * subtitle block at the top of the docx. Default true (the unified
   * narration always wants this for visual polish).
   *
   * Set false for per-chapter source files written by
   * narration-assembly: each chapter gets its own .docx, and including a
   * branding block per chapter would bake N copies of the title into the
   * round-trip when assembleUnifiedNarration concatenates them. Skipping
   * the block keeps the per-chapter docx pure body content.
   */
  includeTitleBlock?: boolean
}

export async function buildNarrationDocx(
  narrationText: string, code: string, title: string, outputPath: string,
  opts: BuildNarrationOpts = {},
): Promise<void> {
  const includeTitleBlock = opts.includeTitleBlock !== false
  // The body is already Markdown (`# `/`## ` headings + paragraphs); write it
  // through verbatim. The title block is an `# {title}` heading + an italic
  // attribution line \u2014 both Markdown, so the round-trip parser sees the same
  // structure it did from the old .docx.
  let out = ''
  if (includeTitleBlock) {
    // Plain-text title block (NOT a `#` heading): parseNarrationDocx treats a
    // leading level-1 line as the "Introduction" section marker, so an H1
    // title here would manufacture a phantom Introduction. The old .docx
    // rendered the title in Word's Title style (a non-heading paragraph),
    // which is what this mirrors. The structural `# \u2026 \u2014 Narration` separator
    // inside narrationText remains the first real heading.
    out += `${title}\nStory Studio \u2022 Episode ${code}\n\n`
  }
  out += narrationText.trim() + '\n'
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await writeAtomic(outputPath, out)
}

export async function buildImagePromptsDocx(
  promptsText: string, code: string, title: string, outputPath: string,
): Promise<void> {
  const out = `# ${title} \u2014 Image Prompts\n\n*Story Studio \u2022 Episode ${code}*\n\n${promptsText.trim()}\n`
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await writeAtomic(outputPath, out)
}
