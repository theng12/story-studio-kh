/**
 * Create .docx files with Title/Heading/Normal styles.
 * Port of generate_episode.py docx builder functions.
 */

import {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType,
} from 'docx'
import fs from 'fs/promises'
import path from 'path'

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
  const paragraphs: Paragraph[] = []

  if (includeTitleBlock) {
    // Title
    paragraphs.push(new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
    }))

    // Subtitle
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: `Story Studio \u2022 Episode ${code}`, italics: true, color: '888888' })],
    }))
    paragraphs.push(new Paragraph({ text: '' }))
  }

  // Body
  for (const line of narrationText.trim().split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(2).trim(), heading: HeadingLevel.HEADING_1 }))
    } else if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(3).trim(), heading: HeadingLevel.HEADING_2 }))
    } else if (trimmed === '') {
      paragraphs.push(new Paragraph({ text: '' }))
    } else {
      paragraphs.push(new Paragraph({ text: trimmed }))
    }
  }

  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buffer = await Packer.toBuffer(doc)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, buffer)
}

export async function buildImagePromptsDocx(
  promptsText: string, code: string, title: string, outputPath: string,
): Promise<void> {
  const paragraphs: Paragraph[] = []

  paragraphs.push(new Paragraph({
    text: `${title} \u2014 Image Prompts`,
    heading: HeadingLevel.TITLE,
  }))
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: `Story Studio \u2022 Episode ${code}`, italics: true, color: '888888' })],
  }))
  paragraphs.push(new Paragraph({ text: '' }))

  for (const line of promptsText.trim().split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(2).trim(), heading: HeadingLevel.HEADING_1 }))
    } else if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(3).trim(), heading: HeadingLevel.HEADING_2 }))
    } else if (trimmed === '') {
      paragraphs.push(new Paragraph({ text: '' }))
    } else {
      paragraphs.push(new Paragraph({ text: trimmed }))
    }
  }

  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buffer = await Packer.toBuffer(doc)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, buffer)
}
