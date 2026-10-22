/**
 * Shared LLM-prompt builder for the YouTube description generator.
 *
 * Previously this function was duplicated in `routes/scripts.ts` and
 * `generators/metadata.ts` — they drifted apart in subtle ways and the
 * Apr 2026 section refactor (split metadata → narrator/music/channels,
 * split cta → cta/support) made the duplication unsustainable. Both
 * call sites now import from here.
 *
 * Section schema reference (mirrors metadata.vue defaultSections):
 *   hook         { characters: number; starting_format?: string }
 *   narrator     { name: string }
 *   music        { title: string; link: string; disclaimer: string }
 *   channels     { channels: Array<{ name: string; url: string; kind?: 'own'|'recommended' }> }
 *   videos       { videos: Array<{ name: string; url: string }> }
 *   playlists    { playlists: Array<{ name: string; url: string }> }
 *   cta          { custom_lines?: string[] }
 *   support      { platforms: Array<{ kind: string; url: string; label?: string }> }
 *   affiliate    { text: string }
 *   ai-disclosure{ text: string }
 *   hashtags     { count: number }
 *   custom-*     { instructions: string }
 *
 * Legacy shapes that still arrive from old presets / saved jobs are
 * handled inline below — frontend auto-migrates on load, so the legacy
 * branches are a defence-in-depth fallback for stale POST bodies.
 */

import type { Format } from '../models/types.js'
import { METADATA_SECTIONS } from './metadata-sections.js'
import { internalSectionNamesDirective } from './metadata-label-leak.js'

/**
 * Remove the structural "Chapter NN:" prefix from heading lines, keeping
 * the semantic title as plain text. Prose that merely mentions a chapter
 * number ("Chapter 100 year war") is not touched.
 */
export function stripChapterHeadingsFromContext(text: string): string {
  if (!text) return text
  // Strips only the structural prefix from lines like
  //   ## Chapter 01: The Mud Brick Walls  →  The Mud Brick Walls
  //   ## ជំពូក ១ — Title                 →  Title
  // Requires a separator after the number so "Chapter 100 year war" stays.
  return text.split('\n').map(line =>
    line.replace(
      /^#{1,6}\s+(?:Chapter|ជំពូក)\s+[\d០-៩]+(?:\s*[:\-–—]+\s*|\s*$)/,
      '',
    ),
  ).join('\n')
}

// ── Output repair ─────────────────────────────────────────────────────────
//
// The description the model returns is repaired before the finalizer sees it:
// a chapter list the model wrote itself — a second timeline beside the
// finalizer's authoritative one — and sentences that match the narration the
// model was shown.
//
// Narrow on purpose; a description is the operator's to publish. A chapter
// list goes only when it is recognisable as one: a "Chapters:"-style label
// whose next line is an entry, a line that names a chapter with a separator
// after the number ("Chapter 01: Title"), or a timestamp on a line that names
// a chapter. Prose that mentions a chapter or a time of day stays. A
// sentence goes only when it matches the narration exactly, after case,
// spacing, terminal punctuation and quote style are normalised.
//
// The finalizer's managed block is never touched, and this runs before the
// finalizer, so the authoritative timeline is written after it. The
// operator's own words never reach it: the generator applies this to the
// description it generated.

/** The finalizer's own blocks. Their contents are rendered, not generated. */
const MANAGED_BLOCK_START = /<!--\s*youtube:[a-z-]+:start\s*-->/i
const MANAGED_BLOCK_END = /<!--\s*youtube:[a-z-]+:end\s*-->/i

/**
 * A label that introduces a chapter list. The finalizer writes its own list
 * under the managed markers, so this label in generated text is the MODEL's.
 */
const TIMELINE_LABEL = /^(?:chapters?|chapter\s+list|table\s+of\s+contents|toc|timeline)\s*:?\s*$/i

/** `00:00 Chapter 01: Title`, `0:07 Introduction`, `1:02:03 — Title`, `12:00`. */
const TIMESTAMP_ENTRY = /^\d{1,3}:\d{2}(?::\d{2})?(?:\s*[–—-]|\s|$)/

/**
 * A line that names a chapter and is shaped like a heading: the number, then
 * a separator, then a title — `Chapter 01: Title`, `ជំពូក ១ — ការចាប់ផ្តើម`.
 * "Chapter 3 is where the story turns" is a sentence, not a heading, and is
 * left in place.
 */
const CHAPTER_HEADING = /^(?:chapter|ជំពូក)\s+[\d០-៩]+\s*[:\-–—]\s*\S/i

/**
 * `00:00 Chapter 01: Title` — a timestamp followed by the word "chapter" is a
 * chapter entry, so it is removed on its own rather than waiting for a label
 * to confirm it.
 */
const TIMESTAMP_CHAPTER_ENTRY = /^\d{1,3}:\d{2}(?::\d{2})?\s+(?:chapter\b|ជំពូក)/i

/**
 * The floor a shared sentence must reach before it is removed. The match
 * itself is exact (see normalizeSentence); this floor only decides how much
 * shared text counts as a sentence rather than a phrase two texts about the
 * same subject share by accident. It is a heuristic: a genuine copy shorter
 * than this is missed, and a long sentence that happens to be identical in
 * both texts is removed.
 */
const MIN_COPIED_CHARS = 60

/** The decoration a heading or list item carries, with its words left. */
function bareLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+•]\s+/, '')
    .replace(/^[*_~]+/, '')
    .replace(/[*_~]+$/, '')
    .trim()
}

/**
 * True when the line looks like a chapter heading rather than a sentence or
 * a paragraph about one: the chapter number, a separator, and a title.
 *
 * Heuristic, and stated as one: a chapter line that runs past twenty words is
 * left in place, and a short sentence that opens with "Chapter 3:" can be
 * taken for a heading.
 */
function isChapterHeading(bare: string): boolean {
  if (!CHAPTER_HEADING.test(bare)) return false
  // A paragraph, not a heading.
  if (bare.split(/\s+/).length > 20) return false
  return true
}

/**
 * One more entry of a chapter list the model wrote. A timestamp counts as an
 * entry only once a label has confirmed the list — on its own, "3:00 the guard
 * changed shift" is prose.
 */
function isChapterListEntry(bare: string): boolean {
  return TIMESTAMP_ENTRY.test(bare) || CHAPTER_HEADING.test(bare)
}

/**
 * Whether a label opens a chapter list: only when the line under it is an
 * entry. A "Timeline:" heading over the model's own prose is not a chapter
 * list, and nothing under it is taken away.
 */
function hasChapterEntryBelow(lines: string[], flags: boolean[], index: number): boolean {
  for (let next = index + 1; next < lines.length; next++) {
    if (flags[next]) return false
    const bare = bareLine(lines[next]!)
    if (!bare) continue
    return isChapterListEntry(bare)
  }
  return false
}

/** Which lines sit inside the finalizer's managed blocks. */
function managedLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = []
  let managed = false
  for (const line of lines) {
    if (MANAGED_BLOCK_START.test(line)) managed = true
    flags.push(managed)
    if (MANAGED_BLOCK_END.test(line)) managed = false
  }
  return flags
}

/** Split a line into sentences, keeping their terminators. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…។៕])\s+/)
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * The text two copies must share to be counted as the same sentence: the same
 * words, spacing, case and terminal punctuation, with straight and curly
 * quotes treated as the same character. Nothing looser than that.
 */
function normalizeSentence(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^[\s"'*_`>\-–—•]+/, '')
    .replace(/[\s"'*_`]+$/, '')
    .replace(/[.!?…។៕]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Every piece of the narration the model was shown, as comparable text: whole
 * lines (a paragraph copied whole) and single sentences (a paragraph copied
 * inside a longer one).
 */
function copiedNarrationUnits(narration: string): Set<string> {
  const units = new Set<string>()
  for (const line of narration.split('\n')) {
    for (const part of [line, ...splitSentences(line)]) {
      const text = normalizeSentence(part)
      if (text.length >= MIN_COPIED_CHARS) units.add(text)
    }
  }
  return units
}

/** Remove the sentences that are the narration word for word. */
function removeCopiedNarration(text: string, units: Set<string>): { text: string; removed: number } {
  const out: string[] = []
  let removed = 0
  for (const line of text.split('\n')) {
    const whole = normalizeSentence(line)
    if (whole.length >= MIN_COPIED_CHARS && units.has(whole)) {
      removed += Math.max(1, splitSentences(line).length)
      continue
    }
    const kept: string[] = []
    for (const sentence of splitSentences(line)) {
      const key = normalizeSentence(sentence)
      if (key.length >= MIN_COPIED_CHARS && units.has(key)) { removed++; continue }
      kept.push(sentence)
    }
    const joined = kept.join(' ').trim()
    if (!joined) {
      // A blank line stays; a line that was entirely copied narration goes.
      if (!line.trim()) out.push(line)
      continue
    }
    out.push(joined)
  }
  return { text: out.join('\n'), removed }
}

export interface DescriptionRepairResult {
  /** The description with the model's own chapter list and matched narration removed. */
  description: string
  /** True when a chapter list or chapter heading the model wrote was removed. */
  removed_chapter_list: boolean
  /** How many sentences that matched the narration exactly were removed. */
  removed_copied_sentences: number
}

/**
 * Take a model-written chapter list, and the sentences that match the
 * narration exactly, out of a description it generated.
 *
 * `narrationContext` is the text the model was shown (the story context). A
 * music episode has none — its tracklist is the finalizer's business — so only
 * the chapter list is removed there.
 *
 * Runs BEFORE the finalizer, so the authoritative timeline is written after
 * it. Nothing here rewrites what is on disk: the operator's own edited copy
 * never reaches it.
 */
export function repairGeneratedDescription(
  description: string,
  options: { narrationContext?: string } = {},
): DescriptionRepairResult {
  if (typeof description !== 'string' || !description.trim()) {
    return {
      description: typeof description === 'string' ? description : '',
      removed_chapter_list: false,
      removed_copied_sentences: 0,
    }
  }

  const lines = description.split('\n')
  const flags = managedLineFlags(lines)

  // ── 1. The model's own chapter list ──
  //
  // `keep` says, per line, whether it survives; the managed block is kept
  // whatever it says, so the second pass leaves it alone too.
  const keep: boolean[] = []
  let removedChapterList = false
  let inChapterList = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (flags[index]) { keep.push(true); continue }
    const bare = bareLine(line)
    if (inChapterList) {
      if (!bare) { keep.push(false); continue }               // a blank line inside the removed list
      if (isChapterListEntry(bare)) { keep.push(false); continue } // one more entry of the list
      inChapterList = false                                    // prose again — this line is kept
    }
    if (TIMELINE_LABEL.test(bare)) {
      // The label opens a chapter list only when the line under it is an
      // entry. A label over the model's own prose is not a chapter list, so
      // neither the label nor what follows it is taken away.
      if (hasChapterEntryBelow(lines, flags, index)) {
        inChapterList = true
        removedChapterList = true
        keep.push(false)
        continue
      }
      keep.push(true)
      continue
    }
    // A chapter heading ("Chapter 01: Title"), or a timestamp on a line that
    // names a chapter ("00:00 Chapter 01: Title"), is a chapter entry on its
    // own — no label or second line needed to confirm it.
    if (isChapterHeading(bare) || TIMESTAMP_CHAPTER_ENTRY.test(bare)) {
      removedChapterList = true
      keep.push(false)
      continue
    }
    keep.push(true)
  }

  // ── 2. Narration copied word for word ──
  const narration = options.narrationContext || ''
  const units = narration.trim() ? copiedNarrationUnits(narration) : new Set<string>()
  let removedCopiedSentences = 0
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!keep[index]) continue
    const line = lines[index]!
    // The finalizer's own block is rendered, not generated: it is left
    // exactly as it is, whatever it says.
    if (flags[index] || !units.size) { out.push(line); continue }
    const copied = removeCopiedNarration(line, units)
    removedCopiedSentences += copied.removed
    if (!copied.text.trim()) {
      if (!line.trim()) out.push(line)
      continue
    }
    out.push(copied.text)
  }
  const text = out.join('\n')

  return {
    description: text.replace(/\n{3,}/g, '\n\n').trim(),
    removed_chapter_list: removedChapterList,
    removed_copied_sentences: removedCopiedSentences,
  }
}

interface Section {
  id: string
  label: string
  type?: string
  enabled: boolean
  config?: Record<string, any>
}

/**
 * Build the LLM description prompt.
 *
 * `format` (v1.0.69+, optional) supplies format-aware hashtags and
 * description structure when the hashtags / music / support sections
 * don't ship explicit values. Older callers (route shims, tests) can
 * omit it and the function falls back to the legacy sleep-story
 * defaults so existing behaviour stays identical.
 */
export function buildDescriptionPrompt(
  episode_id: string,
  title: string,
  storyContext: string,
  sections: Section[],
  /** YouTube's description limit in BYTES (lib/youtube-description-limit.ts). */
  maxChars: number,
  format?: Format | null,
  /** Audience-language directive; empty keeps legacy prompts byte-identical. */
  languageDirectiveText = '',
): string {
  let sectionInstructions = ''
  // Every capitalised name this prompt is about to use to address an
  // instruction, collected as the sections are built so the directive below can
  // quote them back. v1.4.75 — see lib/metadata-label-leak.ts for why.
  const internalNames: string[] = []
  for (const section of sections || []) {
    if (!section.enabled) continue
    const cfg = section.config || {}
    const def = METADATA_SECTIONS[section.id]
    if (def) {
      // v1.0.199 — registry-driven: each section type's prompt fragment lives
      // in metadata-sections.ts, so adding a section type is one entry there.
      const instruction = def.buildInstruction(cfg, { format }, section as any)
      sectionInstructions += instruction
      // A section that contributed nothing named nothing. And a section whose
      // instruction quotes the heading it wants (`"🎵 MUSIC"`) is naming the
      // reader's heading, not an internal label — telling the model never to
      // print MUSIC would delete the section it just asked for.
      if (instruction && def.promptLabel && !def.literalHeader) internalNames.push(def.promptLabel)
    } else if (section.type === 'custom' && cfg.instructions) {
      // The operator's own name for a block he added. It gets shouted into the
      // prompt exactly like a built-in one, and it leaked exactly like one —
      // `ABOUT ME:` appeared above a host bio that the same channel publishes
      // unlabelled in its other episodes.
      const customName = section.label.toUpperCase()
      sectionInstructions += `\n- ${customName}: ${cfg.instructions}`
      internalNames.push(customName)
    }
  }

  // v1.0.103+ — niche-level description-shape guidance. When the niche
  // (typically merged into format.metadata.descriptionShape via
  // applyNicheToFormat) supplies a voice / rule-list / CTA tone /
  // closing benediction, surface them at the TOP of the prompt so the
  // LLM anchors on the channel voice before reading the section
  // instructions. Without these the prompt is generic and prayer
  // channels get "Hey guys! Welcome back to the channel" hype copy.
  const descShape = format?.metadata?.descriptionShape
  let nicheVoiceBlock = ''
  if (descShape) {
    const parts: string[] = []
    if (descShape.voiceGuidance) {
      parts.push(`CHANNEL VOICE — read this first, write in this voice:\n${descShape.voiceGuidance}`)
    }
    if (descShape.descriptionShapeRules?.length) {
      parts.push(`DESCRIPTION SHAPE RULES (MUST follow):\n${descShape.descriptionShapeRules.map(r => `- ${r}`).join('\n')}`)
    }
    if (descShape.ctaShape) {
      parts.push(`CTA TONE (when a like-share-subscribe paragraph appears):\n${descShape.ctaShape}`)
    }
    if (descShape.closingBenediction) {
      parts.push(`CLOSING LINE (the FINAL non-hashtag line of the description, verbatim or near-verbatim):\n${JSON.stringify(descShape.closingBenediction)}`)
    }
    if (parts.length > 0) nicheVoiceBlock = `\n\n${parts.join('\n\n')}\n`
  }

  // A description shape may state what goes between sections. Only when it
  // says nothing does the long-standing rule below apply, so a shape asking for
  // no dividers is no longer contradicted by the very next line of its prompt.
  const separatorLine = descShape?.separatorRule
    || 'Use separator lines (──────) between major sections.'

  return `Generate a YouTube description for a story episode.

Episode: ${episode_id} — ${title}

Story context:
${storyContext}${nicheVoiceBlock}

SUMMARY DIRECTIVE:
Summarize or rephrase the episode's themes, setting, and arc in your own words — do not copy narrated passages verbatim. Do not include chapter headings, chapter numbers, timestamps, or a chapter list; the finalizer owns the only chapter timeline and no second timeline may appear in the prose.

Include these sections IN THIS ORDER:
${sectionInstructions}${internalSectionNamesDirective(internalNames)}

${separatorLine}
${languageDirectiveText ? `${languageDirectiveText}\n\n` : ''}Total length must stay under ${maxChars.toLocaleString('en-US')} bytes of UTF-8 — about ${maxChars.toLocaleString('en-US')} characters of English, or about ${Math.floor(maxChars / 3).toLocaleString('en-US')} characters of Khmer or another non-Latin script. Shorten the prose to fit; the real chapter timeline is added separately.
Output ONLY the description text, ready to copy-paste. No meta-commentary.`
}
