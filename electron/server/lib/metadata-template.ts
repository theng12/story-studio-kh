/**
 * Channel-locked metadata template engine.
 *
 * When a project has `metadata_template` set, the metadata generator
 * stops asking the LLM to write the whole title / description / tags
 * from scratch. Instead it:
 *
 *   1. Scans the template strings for `{placeholder}` tokens.
 *   2. Runs ONE small LLM call extracting the values of every found
 *      placeholder from the episode's story context (cheap — ~$0.002).
 *   3. Substitutes the extracted values into the template strings.
 *
 * Net effect: every episode's metadata reads like it came from the same
 * editorial voice, with only the variable parts (topic, focus, date)
 * changing per episode. Channel consistency that the LLM can't randomly
 * override on a re-roll.
 *
 * Recognised placeholders (others pass through unchanged):
 *   {topic}         — one-line description of the spoken topic
 *   {topic_tag}     — short tag-friendly version (1-3 words, kebab-ish)
 *   {summary}       — 2-3 sentence summary of the episode
 *   {keywords}      — comma-separated keyword list, suitable for tags
 *   {episode_code}  — literal episode code (EP0001, no LLM needed)
 *   {date}          — today's date (YYYY-MM-DD, no LLM needed)
 *   {date_long}     — today's date (e.g. "May 15, 2026", no LLM needed)
 */
import type { MetadataTemplate } from '../models/types.js'
import { truncateChars } from './well-formed-text.js'

/** Returns every `{token}` found across the template fields, deduped. */
export function extractPlaceholders(tpl: MetadataTemplate): string[] {
  const found = new Set<string>()
  const scan = (s: string | undefined) => {
    if (!s) return
    const re = /\{([a-z_][a-z0-9_]*)\}/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) found.add(m[1]!.toLowerCase())
  }
  scan(tpl.title)
  scan(tpl.description)
  if (Array.isArray(tpl.tags)) for (const t of tpl.tags) scan(t)
  return Array.from(found)
}

/** Pre-fill the placeholders the LLM doesn't need to compute. */
export function deterministicValues(episodeCode: string): Record<string, string> {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
  return {
    episode_code: episodeCode,
    date: `${yyyy}-${mm}-${dd}`,
    date_long: `${monthNames[now.getMonth()]} ${now.getDate()}, ${yyyy}`,
  }
}

/**
 * LLM-fillable placeholders only — the ones that genuinely need to read
 * the story context. Used to build the smallest prompt that covers what
 * the template actually references.
 */
export function llmFillablePlaceholders(allFound: string[]): string[] {
  const deterministic = new Set(['episode_code', 'date', 'date_long'])
  return allFound.filter(p => !deterministic.has(p))
}

/**
 * Build the LLM prompt for extracting placeholder values. Output spec is
 * strict JSON so parsing is robust — no fenced code blocks, no preamble.
 */
export function buildExtractionPrompt(opts: {
  episodeCode: string
  title: string
  storyContext: string
  placeholders: string[]
}): string {
  const fieldDescriptions: Record<string, string> = {
    topic: 'One short phrase (3-8 words) describing what the episode is about. Title-case, no trailing period.',
    topic_tag: 'A 1-3 word version of the topic, lowercase, suitable as a YouTube tag. No punctuation.',
    summary: '2-3 sentences plain-prose summary of the episode for the description body.',
    keywords: 'Comma-separated list of 5-8 episode-specific keyword phrases (1-3 words each). Lowercase.',
  }
  const lines = opts.placeholders.map(p =>
    `  "${p}": "${fieldDescriptions[p] || 'short value appropriate for the template slot'}"`,
  ).join(',\n')

  return `You extract structured metadata values from an episode's story context. Return STRICT JSON only — no preamble, no code fences.

Episode code: ${opts.episodeCode}
Episode title: ${opts.title}

Story context (first 2k chars):
${truncateChars(opts.storyContext, 2000)}

Return a JSON object with exactly these keys. Each value is a short string fitting the slot description:

{
${lines}
}

Output the JSON object only. No other text.`
}

/**
 * Parse the LLM's JSON response. Still tolerant of the harmless presentation
 * defects — stray whitespace, an accidental fenced block, a preamble before
 * the object.
 *
 * It is NOT tolerant of a missing value, and that is the point. Until v1.0.787
 * an unreadable answer returned every placeholder as `''`, and `renderTemplate`
 * substituted those blanks without complaint: the job reported success and the
 * episode went to YouTube with a title reading "" where the topic belonged.
 * A blank published field is worse than a failed job, because only the failed
 * job is visible. So an answer that cannot fill every requested placeholder
 * throws, and the caller stops before anything is written.
 */
export function parseExtractionResponse(raw: string, placeholders: string[]): Record<string, string> {
  const trimmed = raw.trim()
  // Strip fence if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fence ? fence[1]! : trimmed
  // Find the outermost JSON object.
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw extractionFailure(placeholders, 'no JSON object')
  let json: any
  try {
    json = JSON.parse(body.slice(start, end + 1))
  } catch {
    throw extractionFailure(placeholders, 'invalid JSON')
  }
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const p of placeholders) {
    const v = json?.[p]
    const value = typeof v === 'string' ? v.trim() : ''
    if (!value) missing.push(p)
    out[p] = value
  }
  if (missing.length) throw extractionFailure(missing, 'no value')
  return out
}

function extractionFailure(placeholders: string[], reason: string): Error {
  const names = placeholders.map(p => `{${p}}`).join(', ')
  return new Error(
    `The metadata template placeholder${placeholders.length === 1 ? '' : 's'} ${names} came back with ${reason}, `
    + 'and a blank placeholder would be published as an empty title or description. '
    + 'Nothing was saved — run metadata again, or choose a different model.',
  )
}

/**
 * Substitute every `{placeholder}` with its resolved value. Unresolved
 * placeholders (missing from the values map) collapse to the empty
 * string rather than leave literal `{placeholder}` text in the output.
 */
export function applyTemplate(s: string | undefined, values: Record<string, string>): string {
  if (!s) return ''
  return s.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_match, name) => {
    const v = values[String(name).toLowerCase()]
    return typeof v === 'string' ? v : ''
  })
}

/**
 * Convenience: render every field of a template against a values map.
 * `tags` is rendered per-entry and filtered to drop blanks (so a
 * `["{topic_tag}", "morning prayer"]` template with empty topic_tag
 * doesn't ship a blank tag).
 */
export function renderTemplate(
  tpl: MetadataTemplate,
  values: Record<string, string>,
): { title: string; description: string; tags: string[] } {
  return {
    title: applyTemplate(tpl.title, values).trim(),
    description: applyTemplate(tpl.description, values).trim(),
    tags: (tpl.tags || [])
      .map(t => applyTemplate(t, values).trim())
      .filter(Boolean),
  }
}
