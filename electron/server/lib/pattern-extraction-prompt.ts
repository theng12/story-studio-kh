/**
 * Meta-prompt for the Pattern-from-Sample wizard.
 *
 * Given one or more sample scripts that share a TITLING + STRUCTURAL
 * convention (e.g. all "Fall Asleep to {X}" pieces, all "History of {X}
 * Explained" docs), the LLM extracts a Pattern profile that captures:
 *   - the title template (with {X} for the variable subject)
 *   - the opening hook style
 *   - the body chapter pacing
 *   - the closing wind-down
 *   - the POV
 *   - the suggested length range
 *   - the formats this pattern pairs with
 *
 * Mirrors the format-extraction-prompt approach: tight schema, embedded
 * example, strict JSON-only output. Output is parsed via the same
 * artifact-stripping helper.
 */

const PATTERN_SHAPE_EXAMPLE = `{
  "id": "kebab-case-slug",
  "name": "Human readable name with the {X} placeholder ('Fall asleep to {X}')",
  "description": "1-2 sentence summary: what this pattern is, what subjects fit, what tone it produces.",
  "builtin": false,
  "schemaVersion": 1,

  "titleTemplate": "Fall asleep to {X}",
  "subjectLabel": "Topic",
  "pov": "second",

  "openingDevice": "1-3 sentences describing how chapter 1 should open the listener into the world (the hook style + tone-setting move). Don't write a chapter — write the RULE for opening one.",

  "bodyStructure": [
    "Chapters 1-2: <opening beat — what these chapters do for the listener>",
    "Chapters 3-{lastButOne}: <middle beat using {lastButOne} as a placeholder>",
    "Chapter {last}: <closing beat using {last} as a placeholder>"
  ],

  "closingDevice": "1-3 sentences describing the wind-down rule for the final chapter. Style + intent, not the actual prose.",

  "suggestedLengthMinutes": [30, 90],
  "preferredFormats": ["sleep-story", "documentary"],
  "metadataKeywordAdditions": ["fall asleep to", "topical sleep", "ambient narration"]
}`

export interface ExtractPatternOptions {
  /** 1-3 sample scripts that share the same titling + structural convention. */
  samples: string[]
  /** Optional name (with {X}) the user wants the pattern to have. Empty = let the LLM infer. */
  desiredName?: string
  /** Optional 1-line note about what the user is going for (helps the LLM commit). */
  intent?: string
  /**
   * Optional list of valid format ids the pattern can declare in
   * `preferredFormats`. When provided, the LLM is told to pick from
   * this list rather than invent. The /extract route passes the
   * project's known formats here so we don't get bogus ids back.
   */
  knownFormatIds?: string[]
}

export function buildPatternExtractionPrompt(opts: ExtractPatternOptions): string {
  const samples = opts.samples
    .map((s, i) => `=== SAMPLE ${i + 1} ===\n${s.slice(0, 12000)}\n`)
    .join('\n')

  const intentLine = opts.intent
    ? `\nUser intent (extra context): ${opts.intent}\n`
    : ''
  const nameLine = opts.desiredName
    ? `\nUse this exact name for the pattern (preserve the {X} placeholder): "${opts.desiredName}". Derive a kebab-case id from the name (replace {X} with "x" in the slug).\n`
    : `\nInfer a short, concrete name that includes the {X} placeholder (e.g. "Fall asleep to {X}", "History of {X} explained", "Day in the life of a {X}"). Derive a kebab-case id from the name (replace {X} with "x" in the slug).\n`
  const formatLine = opts.knownFormatIds && opts.knownFormatIds.length
    ? `\npreferredFormats: pick 1-3 ids from this list of available formats — do not invent new ids: ${opts.knownFormatIds.join(', ')}.\n`
    : '\npreferredFormats: pick 1-3 ids that match the genre conventions (e.g. "sleep-story", "documentary", "educational", "comedy", "true-crime").\n'

  return `You are extracting a Pattern profile from sample narration scripts. A Pattern is a structured JSON config that captures a TITLING + STRUCTURAL convention — the title template ("Fall asleep to {X}", "History of {X} explained"), the opening hook style, the body pacing arc, the closing wind-down, the POV. Once extracted, this Pattern is saved and used to shape every future episode the user generates with that title style.

You will receive 1–3 sample scripts that share the same convention. Extract the GENERIC convention — not the specific episode's plot. The Pattern must work for ANY subject the user picks next ({X} is the subject placeholder).

YOUR OUTPUT MUST BE A SINGLE VALID JSON OBJECT matching the Pattern schema below. No prose before or after. No markdown fences. Just JSON.

═══════════════════════════════════════════════════════════════════
SAMPLES TO ANALYSE:
═══════════════════════════════════════════════════════════════════

${samples}

═══════════════════════════════════════════════════════════════════
PATTERN SCHEMA — your output must match this exact shape:
═══════════════════════════════════════════════════════════════════

${PATTERN_SHAPE_EXAMPLE}

═══════════════════════════════════════════════════════════════════
RULES:
═══════════════════════════════════════════════════════════════════
${nameLine}${intentLine}${formatLine}
1. id: kebab-case slug, lowercase, hyphens not underscores. The id is the unique key (e.g. "fall-asleep-to-x", "history-of-x-explained"). Replace {X} with "x" in the slug.
2. builtin: ALWAYS false (the user is creating this; built-ins ship with the app).
3. schemaVersion: ALWAYS 1.
4. titleTemplate: MUST contain the literal "{X}" placeholder. Examples: "Fall asleep to {X}", "History of {X} explained", "Day in the life of a {X}".
5. subjectLabel: 1-2 word noun describing what {X} is (e.g. "Topic", "Era", "Profession", "City", "Object").
6. pov: one of "first", "second", "third", "mixed". Pick the dominant POV used across the samples.
7. openingDevice + closingDevice: describe the RULE / STYLE, not actual prose. The script generator will use these as instructions, not as text to paste.
8. bodyStructure: 3-5 entries describing chapter ranges. Use {lastButOne} and {last} as chapter-number placeholders where the prose says "Chapters X to {lastButOne}" or "Chapter {last}". May be omitted if the pattern is purely a titling convention without a structural opinion (then the body follows the format's pacingArc).
9. suggestedLengthMinutes: [min, max] range typical for this pattern. Look at the samples' length to estimate.
10. metadataKeywordAdditions: 3-7 short keywords that consistently appear in this pattern's metadata (search-engine-friendly tags, audience cues).

CRITICAL: do not copy the sample's specific subject into titleTemplate or bodyStructure. The Pattern is a TEMPLATE for future subjects; the sample is a stylistic reference only. If a sample is "Fall asleep to a Roman bathhouse", the titleTemplate is "Fall asleep to {X}" — NOT "Fall asleep to a Roman bathhouse".

Return ONLY the JSON object. No prose.`
}

/**
 * Strip common LLM artifacts (markdown fences, leading commentary) and
 * parse. Same shape + behaviour as parseExtractedFormatJson — duplicated
 * here so the pattern-extract path doesn't depend on the format module.
 */
export function parseExtractedPatternJson(raw: string): unknown {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in LLM response')
  }
  return JSON.parse(text.slice(start, end + 1))
}
