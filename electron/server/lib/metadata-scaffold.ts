/**
 * The document is not the video (v1.4.84).
 *
 * Three scheduled uploads went to YouTube titled:
 *
 *     # SEO-Optimized Video Titles — EP0056
 *     # 5 SEO-Optimized Video Titles — EP0061
 *     # SEO-Optimized Video Titles — EP0062
 *
 * That is the model's own heading for the list it was asked to write. The
 * title prompt says "Generate 5 SEO-optimized video title options … One per
 * line. No numbering, quotes, or commentary." Usually the model complies.
 * Three times out of eighty on one channel it wrote a markdown heading first
 * and the five titles under it — and the parser in `generators/metadata.ts`
 * split on newlines, stripped `-`, digits, `.`, `)` and quotes from each line,
 * and never considered `#`. So the heading survived as line one, `titles[0]`
 * was auto-picked as the episode title, and `.slice(0, title_count)` then
 * pushed the fifth real title off the end.
 *
 * Descriptions leaked the same way: `**AI DISCLOSURE:**`, `# <episode title>`,
 * `🎬 EPISODE EP0057 — <title>`. YouTube renders none of that — it prints the
 * asterisks and the hash to the viewer exactly as written.
 *
 * ── Three layers ──
 *
 * 1. DON'T MAKE IT — `generators/metadata.ts` drops document furniture from the
 *    title list before choosing, and before the slice, so a heading no longer
 *    costs a real title.
 * 2. CLEAN IT — `stripMarkdownScaffold`, applied wherever a saved description
 *    or title is READ for publishing. Files on disk are never rewritten; the
 *    same rule as `metadata-label-leak.ts`. Markers are removed, words are
 *    kept: `**SUBSCRIBE**` becomes `SUBSCRIBE`, never nothing.
 * 3. REFUSE IT — `assertPublishableMetadata`, called inside `uploadVideo` and
 *    `updateVideoMetadata`, the two functions that are the last thing before
 *    the YouTube Data API. Every upload path in the app runs through one of
 *    them, so the gate cannot be forgotten by a new caller.
 *
 * ── Calibrated, not guessed ──
 *
 * Every rule below was measured against all 857 metadata packages across ten
 * real channels before it was trusted. The measurements are in
 * `__tests__/metadata-junk-gate.test.ts`. One rule was rejected outright by
 * that pass: "the title must not contain an episode code" would have refused
 * four perfectly good titles that end in one, on purpose —
 * `A Prayer for the Sermon I Heard Today | EP0339`. The scaffold rule is
 * anchored to the START of the title for that reason.
 */

/** The finalizer's own blocks. Their contents are rendered, not generated. */
const MANAGED_BLOCK_START = /<!--\s*youtube:[a-z-]+:start\s*-->/i
const MANAGED_BLOCK_END = /<!--\s*youtube:[a-z-]+:end\s*-->/i

/** `## HOOK` — the space is required, so `#Hashtag` is never touched. */
const HEADING_MARKER = /^(\s{0,3})#{1,6}[ \t]+/

/**
 * `🎬 EPISODE EP0057 — ` at the head of a line. The leading run allows the
 * emoji the description prompt asks for; it is kept, only the scaffold goes.
 * The code shape is deliberately loose (`EP0057`, `TN0128`, `DK0061`) because
 * every channel names its episodes differently.
 */
const EPISODE_SCAFFOLD = /^([^A-Za-z0-9\n]{0,8})EPISODE[ \t]+[A-Z]{0,4}\d{2,5}[ \t]*[-—–:|][ \t]*/i

/**
 * Same shape, anchored at the very start of a title.
 *
 * A bare number is only accepted after the literal word EPISODE. Without that
 * guard the rule reads `1917 — The Year Everything Changed` as a code and a
 * dash and refuses a perfectly good title; a code on its own therefore has to
 * carry letters, which every channel's does (`EP0061`, `TN0128`, `DK0061`).
 */
const TITLE_EPISODE_SCAFFOLD = /^[^A-Za-z0-9\n]{0,8}(?:EPISODE[ \t]+[A-Z]{0,4}\d{2,5}|[A-Z]{2,4}\d{2,5})[ \t]*[-—–:|][ \t]*\S/i

/** The instruction wording the model echoes when it writes a document heading. */
const INSTRUCTION_ECHO = /seo[\s-]?optimi[sz]ed|title options|video titles|^\s*here (are|is)\b/i

/** A leftover list marker: `1. `, `3) `, `- `, `* `. */
const LIST_MARKER = /^\s{0,3}(?:\d{1,2}[.)]|[-*+•])\s+/

const CODE_FENCE = /^\s{0,3}(?:```|~~~)/

/**
 * Remove markdown decoration from one line, keeping every word.
 *
 * Bold and italic are unwrapped rather than deleted because the words inside
 * them are usually a heading the description is supposed to have —
 * `**🤖 AI DISCLOSURE:**` is forty of the eighty-nine bold runs in the corpus,
 * and the operator wants the label, just not the asterisks.
 */
function undecorateLine(line: string): string {
  let text = line

  // Heading marker: keep the indent, drop the hashes.
  text = text.replace(HEADING_MARKER, '$1')

  // Paired emphasis, longest marker first so `***x***` collapses cleanly.
  text = text.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '$1')
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1')
  text = text.replace(/__([^_\n]+?)__/g, '$1')
  // Single-asterisk italics, only when both markers hug their text — this is
  // what keeps `2 * 3` and a line that merely starts with `* ` out of it.
  text = text.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1')
  // Inline code. YouTube has no monospace; the backticks would just show.
  text = text.replace(/`([^`\n]+?)`/g, '$1')

  // Anything unpaired that survived, e.g. a `**` the model never closed.
  text = text.replace(/\*\*+/g, '')

  // Trailing hashes of a closed ATX heading: `## HOOK ##`.
  text = text.replace(/[ \t]+#{1,6}\s*$/, '')

  return text
}

/**
 * Clean a description for publishing. Read-side only — nothing on disk
 * changes. Content between the finalizer's managed markers is left exactly as
 * the finalizer rendered it.
 *
 * No line is ever dropped for its content. Dropping lines is
 * `stripInternalSectionLabels`' job and it is careful about it; this function
 * only takes away characters YouTube would print literally.
 */
export function stripMarkdownScaffold(description: string): string {
  if (typeof description !== 'string' || !description.trim()) return description

  const out: string[] = []
  let managed = false

  for (const line of description.split('\n')) {
    if (MANAGED_BLOCK_START.test(line)) managed = true
    if (managed) {
      out.push(line)
      if (MANAGED_BLOCK_END.test(line)) managed = false
      continue
    }

    // A fence line carries no words of its own.
    if (CODE_FENCE.test(line)) continue

    let text = undecorateLine(line)
    text = text.replace(EPISODE_SCAFFOLD, '$1')

    // Undecorating can empty a line that held only decoration. Keep it blank
    // rather than deleting it, so paragraph spacing survives; the collapse
    // below tidies any run that results.
    out.push(text.trimEnd())
  }

  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Clean a title. One line, same rules, plus whitespace collapse. */
export function stripTitleScaffold(title: string): string {
  if (typeof title !== 'string') return ''
  const single = title.replace(/[\r\n]+/g, ' ')
  return undecorateLine(single).replace(/\s{2,}/g, ' ').trim()
}

/**
 * True when a line is document furniture rather than a candidate title.
 *
 * Used by the title parser to decide what never becomes a title, and by the
 * resolver to decide when a saved title has to be recovered from the
 * alternatives beside it.
 */
export function isScaffoldTitleLine(line: string): boolean {
  if (typeof line !== 'string') return true
  const raw = line.trim()
  if (!raw) return true

  // A markdown heading. This alone accounts for all three published failures.
  if (HEADING_MARKER.test(raw) || /^#{1,6}\S/.test(raw)) return true

  // The instruction, echoed back at us.
  if (INSTRUCTION_ECHO.test(raw)) return true

  // `EPISODE EP0061 — …` as the OPENING of the title. Titles that END with a
  // code are legitimate and common, so this is anchored and nothing else.
  if (TITLE_EPISODE_SCAFFOLD.test(raw)) return true

  // Nothing but a list marker and a code: `1. EP0061`.
  const unmarked = raw.replace(LIST_MARKER, '').trim()
  if (!unmarked) return true

  return false
}

export interface JunkFinding {
  field: 'title' | 'description'
  /** Plain-words explanation, naming the offending text. */
  problem: string
}

/**
 * The gate. Returns one finding per problem, each naming the text at fault, or
 * an empty array when the metadata is fit to publish.
 *
 * Deliberately checks the FINAL strings — whatever is about to be handed to
 * YouTube — not the file they came from. If the cleaning above did its job
 * this finds nothing; anything it does find is a real defect that would
 * otherwise have been published.
 */
export function findMetadataJunk(input: { title?: string; description?: string }): JunkFinding[] {
  const findings: JunkFinding[] = []
  const title = typeof input.title === 'string' ? input.title : ''
  const description = typeof input.description === 'string' ? input.description : ''

  if (!title.trim()) {
    findings.push({ field: 'title', problem: 'the title is empty' })
  } else {
    const trimmed = title.trim()
    if (trimmed.startsWith('#')) {
      findings.push({ field: 'title', problem: `the title starts with "#", which means it is a heading out of the metadata document, not a title: "${trimmed}"` })
    } else if (INSTRUCTION_ECHO.test(trimmed)) {
      findings.push({ field: 'title', problem: `the title repeats the instruction we gave the model instead of naming the episode: "${trimmed}"` })
    } else if (TITLE_EPISODE_SCAFFOLD.test(trimmed)) {
      findings.push({ field: 'title', problem: `the title begins with an episode code and a dash, which is the document's own label rather than a title: "${trimmed}"` })
    }
    const marker = trimmed.match(/\*\*|__|```|~~~/)
    if (marker) {
      findings.push({ field: 'title', problem: `the title contains the formatting marks "${marker[0]}", which YouTube prints exactly as written: "${trimmed}"` })
    }
  }

  if (description.trim()) {
    // Only the lines a viewer reads as prose. What the finalizer renders
    // between its own markers is its business, not this function's.
    const lines = visibleLines(description)

    const heading = lines.find(line => HEADING_MARKER.test(line))
    if (heading !== undefined) {
      findings.push({ field: 'description', problem: `a line of the description is still a markdown heading, so YouTube would show the "#": "${heading.trim().slice(0, 90)}"` })
    }

    const marked = lines.find(line => /\*\*|```|~~~/.test(line))
    if (marked !== undefined) {
      const mark = marked.match(/\*\*|```|~~~/)![0]
      findings.push({ field: 'description', problem: `the description contains the formatting marks "${mark}", which YouTube prints exactly as written: "${marked.trim().slice(0, 90)}"` })
    }

    const scaffold = lines.find(line => EPISODE_SCAFFOLD.test(line))
    if (scaffold !== undefined) {
      findings.push({ field: 'description', problem: `a line of the description opens with the document's episode label rather than the sentence a viewer should read: "${scaffold.trim().slice(0, 90)}"` })
    }
  }

  return findings
}

/** Every line except the ones inside the finalizer's managed blocks. */
function visibleLines(description: string): string[] {
  const lines: string[] = []
  let managed = false
  for (const line of description.split('\n')) {
    if (MANAGED_BLOCK_START.test(line)) managed = true
    if (!managed) lines.push(line)
    if (MANAGED_BLOCK_END.test(line)) managed = false
  }
  return lines
}

/**
 * Refuse to publish junk. Called from `uploadVideo` and `updateVideoMetadata`
 * so that no route, job or bulk action can route around it.
 *
 * The message says what is wrong, quotes the offending text, and says what to
 * do — never a code, never a stack.
 */
export function assertPublishableMetadata(
  snippet: { title?: string; description?: string },
  context?: { episode_code?: string },
): void {
  const findings = findMetadataJunk(snippet)
  if (!findings.length) return

  const who = context?.episode_code ? ` for ${context.episode_code}` : ''
  const problems = findings.map(f => `  • ${f.problem}`).join('\n')
  throw new Error(
    `Story Studio stopped this upload${who} because the video details are not fit to publish:\n${problems}\n\n` +
    'This text came out of the metadata document rather than out of the episode. ' +
    'Open the episode\'s Metadata page, choose one of the other titles it generated ' +
    '(or write one), tidy the description, and upload again.',
  )
}
