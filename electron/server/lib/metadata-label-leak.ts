/**
 * Section names are instructions to the model. They are not headings (v1.4.75).
 *
 * *"why it did say Hook: that's suppose to just be the context."*
 *
 * A Sleep Story description went out beginning `HOOK: In tonight's story, we
 * dive into a gentle journey…`. `HOOK` is what the PROMPT calls that
 * instruction — `metadata-sections.ts` writes the bullet `- HOOK: Write a hook
 * paragraph of approximately 220 characters…` — and the model, handed a
 * numbered list of capitalised names, published the name along with the
 * paragraph. The same failure as the app's own name reaching YouTube through
 * the narration file: scaffolding read as content.
 *
 * ── Two layers, because neither is enough alone ──
 *
 * 1. TELL THE MODEL (`internalSectionNamesDirective`, spliced into the
 *    description prompt). This is the layer that matters: a name that is never
 *    generated cannot be published, and it costs nothing per episode.
 *
 * 2. CLEAN THE TEXT (`stripInternalSectionLabels`, applied where a saved
 *    description is READ). Models ignore instructions, and — more to the point
 *    — twenty-five packages sampled across ten channels already hold the leak
 *    in five of them. Those files are on disk and their descriptions are the
 *    operator's own edited copy; regenerating them would respend credits and
 *    throw away his edits. So they self-clean on the way out instead.
 *
 * Saved files are never rewritten. Prevent new, tolerate old.
 *
 * ── What must NOT be stripped ──
 *
 * Some sections deliberately ask for a heading, and three of them ask for a
 * heading spelled exactly like their own internal name: `🎵 MUSIC`,
 * `📋 PLAYLISTS:`, `🤖 AI DISCLOSURE:`. The emoji does not tell them apart,
 * because `applyEmojiPolicy` removes it from generated text by default — the
 * reader sees the bare word either way. Those, and the headings the finalizer
 * manages itself, are listed in `PROTECTED_HEADINGS` and pass through
 * untouched.
 *
 * The two rules are deliberately asymmetric about how much they trust a name:
 *
 *   - A line that is NOTHING BUT a short capitalised name carries no content,
 *     so dropping it can cost at most a heading. That rule accepts any
 *     label-shaped line, including ones from custom sections the operator
 *     named himself (`ABOUT ME:`, `DISCLAIMER:` — both found in the wild,
 *     both sitting above copy that appears unlabelled in the same channel's
 *     other episodes).
 *   - A line where a name is followed by real prose is only ever touched when
 *     the name is one this app is KNOWN to put in a prompt. Anything looser
 *     would eat `Narrator: <name>` and `CHANNEL: <name>`, which the legacy
 *     metadata section asks for as content.
 */

import { METADATA_SECTION_LIST } from './metadata-sections.js'

/**
 * The finalizer's managed blocks — `<!-- youtube:chapters:start -->` and
 * friends. Matched by shape rather than imported by name on purpose: this
 * module runs on the publish path, and importing
 * `youtube-metadata-finalizer.js` for four string constants would pull its
 * whole service tree (audio readiness, subtitle completion, research) in
 * behind them.
 */
const MANAGED_BLOCK_START = /<!--\s*youtube:[a-z-]+:start\s*-->/i
const MANAGED_BLOCK_END = /<!--\s*youtube:[a-z-]+:end\s*-->/i

/**
 * Every name this app puts in front of a description instruction, except the
 * ones whose instruction also asks for a heading of the same name.
 *
 * Derived from the registry so a new section type is covered the day it is
 * added, rather than the day somebody remembers this file exists.
 */
export const INTERNAL_SECTION_LABELS: string[] = METADATA_SECTION_LIST
  .filter(def => def.promptLabel && !def.literalHeader)
  .map(def => def.promptLabel as string)

/**
 * Headings the description is SUPPOSED to contain. Two sources: the sections
 * whose instruction quotes a literal heading, and the blocks the YouTube
 * finalizer renders itself.
 */
const PROTECTED_HEADINGS = new Set<string>([
  ...METADATA_SECTION_LIST.filter(def => def.literalHeader).map(def => (def.promptLabel as string).toUpperCase()),
  'MORE VIDEOS',          // videos → "🎬 MORE VIDEOS:"
  'SUPPORT THE CHANNEL',  // support → "💛 SUPPORT THE CHANNEL"
  'CHAPTERS',             // renderChapters()
  'SOURCES',              // the 📚 Sources section
  'SOURCES & FURTHER READING', // renderSources()
  'LYRICS',               // renderLyrics() (songs with lyrics)
  'NARRATOR',             // legacy metadata section asks for "NARRATOR: <name>"
  'CHANNEL',              // legacy metadata section asks for "CHANNEL: <name>"
])

/** Uppercased known labels, longest first so `SUBSCRIBE / LIKE CTA` wins over any prefix. */
const KNOWN_LABELS_UPPER = INTERNAL_SECTION_LABELS
  .map(label => label.toUpperCase())
  .sort((a, b) => b.length - a.length)

/**
 * A short capitalised phrase — the shape of a section name. Letters, digits,
 * spaces and the punctuation the app's own names use (`/`, `&`, `-`, `'`).
 * No sentence punctuation, so an actual sentence never matches.
 */
const LABEL_SHAPE = /^[A-Z0-9][A-Z0-9 &/'-]*$/
const MAX_LABEL_WORDS = 4
const MAX_LABEL_CHARS = 40

/** Strip markdown decoration a model wraps a heading in, leaving the bare text. */
function undecorate(line: string): string {
  let text = line.trim()
  text = text.replace(/^#{1,6}\s+/, '')      // `## HOOK` — requires the space, so `#Hashtag` is untouched
  text = text.replace(/^[-*+]\s+/, '')       // `- HOOK`
  text = text.replace(/^(\*\*|__|\*|_)/, '') // `**HOOK:**`
  text = text.replace(/(\*\*|__|\*|_)$/, '')
  return text.trim()
}

function isProtected(name: string): boolean {
  return PROTECTED_HEADINGS.has(name.replace(/:$/, '').trim().toUpperCase())
}

/** True when `text` is a bare section name and nothing else. */
function isLabelOnly(text: string): boolean {
  const core = text.replace(/:$/, '').trim()
  if (core.length < 2 || core.length > MAX_LABEL_CHARS) return false
  if (isProtected(core)) return false
  const upper = core.toUpperCase()
  if (KNOWN_LABELS_UPPER.includes(upper)) return true
  // An unknown name — a custom section the operator titled himself. Accepted
  // only when it is written as a name: capitalised, few words, no prose
  // punctuation. Dropping it removes a heading, never a sentence.
  if (core !== upper) return false
  if (!LABEL_SHAPE.test(core)) return false
  if (!/[A-Z]/.test(core)) return false
  return core.split(/\s+/).length <= MAX_LABEL_WORDS
}

/** `SUBSCRIBE / LIKE CTA` → `SUBSCRIBELIKECTA`, for comparing against a hashtag. */
const asTagWord = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
const KNOWN_LABEL_TAG_WORDS = new Set(KNOWN_LABELS_UPPER.map(asTagWord))

/**
 * Drop a hashtag that is just a section name — `#HASHTAGS`, published on seven
 * of the hundred and eighteen descriptions sampled. The model was asked for
 * hashtags under the name HASHTAGS and made one out of the name.
 *
 * Only whole tokens are considered, and only ones matching a name this app is
 * known to use, so `#SleepStory` and every other real tag survive.
 */
function stripLabelHashtags(line: string): string {
  if (!line.includes('#')) return line
  // The optional emphasis is part of the match, so `**#Hashtags**` leaves
  // nothing behind rather than the `****` that removing only the tag would.
  // Emphasis elsewhere on the line is never touched: the pattern requires the
  // `#` immediately after it.
  return line.replace(/(\*\*|__|\*|_)?(#[A-Za-z][A-Za-z0-9]*)\1?/g,
    (match, _emphasis, tag: string) => (KNOWN_LABEL_TAG_WORDS.has(asTagWord(tag)) ? '' : match))
}

/**
 * When the line opens with a KNOWN section name followed by a colon and then
 * real text, return that text. Otherwise null.
 */
function stripKnownPrefix(text: string): string | null {
  const upper = text.toUpperCase()
  for (const label of KNOWN_LABELS_UPPER) {
    if (!upper.startsWith(`${label}:`)) continue
    const rest = text.slice(label.length + 1).replace(/^(\*\*|__|\*|_)/, '').trim()
    if (rest) return rest
  }
  return null
}

/**
 * Remove internal section names from a description that already contains them.
 *
 * Read-side only — nothing on disk changes. Content between the finalizer's
 * managed markers is left exactly as the finalizer rendered it.
 */
export function stripInternalSectionLabels(description: string): string {
  if (typeof description !== 'string' || !description.trim()) return description

  const lines = description.split('\n')
  const out: string[] = []
  let managed = false

  for (const line of lines) {
    if (MANAGED_BLOCK_START.test(line)) managed = true
    if (managed) {
      out.push(line)
      if (MANAGED_BLOCK_END.test(line)) managed = false
      continue
    }

    const text = undecorate(line)
    if (!text) { out.push(line); continue }

    if (isLabelOnly(text)) continue  // drop the whole line — it was only a name

    const withoutPrefix = stripKnownPrefix(text)
    if (withoutPrefix !== null) { out.push(stripLabelHashtags(withoutPrefix)); continue }

    const detagged = stripLabelHashtags(line)
    if (detagged === line) { out.push(line); continue }
    // A line that held nothing but `#HASHTAGS` goes with it; one that lost a
    // tag from a list closes the gap the tag left.
    if (!detagged.trim()) continue
    out.push(detagged.replace(/[ \t]{2,}/g, ' ').trim())
  }

  // Dropping heading lines leaves the gaps that surrounded them. Collapse runs
  // of blank lines to one so the description does not gain airy holes where a
  // name used to be.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The prompt-side half. Names the sections this particular prompt is about to
 * use and says plainly that they are not headings.
 *
 * Built from the labels actually in play — a generic "don't echo instructions"
 * line is easy for a model to read past, but its own `HOOK` quoted back at it
 * is not.
 */
export function internalSectionNamesDirective(labels: string[]): string {
  const named = Array.from(new Set(labels.filter(Boolean)))
  if (!named.length) return ''
  return '\n\nThe capitalised names above'
    + ` (${named.join(', ')})`
    + ' are internal instruction names, not headings. Never print them, and never'
    + ' echo the instruction wording. Write only the finished copy a viewer reads.'
    + ' Where an instruction asks for a heading in quotes, use that quoted heading exactly.'
}
