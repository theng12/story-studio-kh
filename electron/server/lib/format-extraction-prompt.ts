/**
 * Meta-prompt for the Format-from-Sample wizard (Phase 4).
 *
 * Given one or more sample scripts of a target genre, ask the LLM to extract
 * a Format profile that captures the genre's conventions. The output is a
 * single JSON object matching the Format interface in models/types.ts.
 *
 * The prompt is tight + structured because the failure mode is "LLM emits
 * almost-valid JSON" — a strict shape with explicit field constraints lets
 * us validate + auto-retry rather than having the user repair output by
 * hand. Examples (sleep-story.json shape) are embedded so the model sees
 * exactly what a good output looks like.
 */

const FORMAT_SHAPE_EXAMPLE = `{
  "id": "kebab-case-slug",
  "name": "Human Readable Name",
  "description": "1-2 sentence summary of the genre's vibe and what it suits.",
  "builtin": false,
  "schemaVersion": 1,

  "idea": {
    "systemPromptRole": "You are helping generate new episode ideas for a <genre> narration channel.",
    "audienceDefault": "the typical listener for this genre",
    "moodVocabulary": ["mood1", "mood2", "mood3"],
    "themeVocabulary": ["theme1", "theme2", "theme3"],
    "guidanceText": "One paragraph of rules constraining what's idea-appropriate (e.g. 'No graphic violence', 'No real victims').",
    "exampleIdeas": [
      {
        "title": "Concrete example title",
        "logline": "1-2 sentence concrete logline.",
        "themes": ["theme1", "theme2"],
        "suggested_chapters": 8,
        "suggested_length": "30 min",
        "mood": "2-4 word mood phrase"
      }
    ]
  },

  "script": {
    "systemPromptRole": "You are a world-class <genre> narrator with the <reference style description>.",
    "additionalRules": [
      "Rule 1 specific to the genre's prose conventions.",
      "Rule 2.",
      "Rule 3."
    ],
    "pacingArc": [
      "Chapters 1-2: <opening beat>",
      "Chapters 3-{lastButOne}: <middle beat with chapter-number placeholder>",
      "Chapter {last}: <closing beat>"
    ],
    "closingHint": "One sentence describing the emotional landing.",
    "defaultChapterCount": 8,
    "chapterCountRange": [5, 12],
    "defaultLengthMinutes": 30,
    "lengthMinutesRange": [15, 75],
    "narratorStyles": [
      { "id": "A", "label": "Short label", "description": "1-2 sentence description of this narrator persona." },
      { "id": "B", "label": "Short label", "description": "..." }
    ],
    "defaultNarratorStyleId": "A"
  },

  "imagePrompts": {
    "purposeNote": "for a <genre> episode",
    "visualStyleHint": "1-line description of the visual vibe (e.g. 'cinematic naturalism, golden-hour palette').",
    "defaultScenesTotalRange": [16, 24],
    "defaultThumbnails": 5,
    "defaultStyleTag": "Concrete style tag appended to every image prompt — describes the rendering style, palette, mood. Should be 1-2 sentences.",
    "characterReferenceMode": "inline",
    "recommendedAspect": "16:9"
  },

  "metadata": {
    "purposeNote": "for a <genre> narration video",
    "titleStyleHint": "1-line description of the title voice.",
    "titleHookRules": [
      "Rule 1 about how titles should hook.",
      "Rule 2."
    ],
    "tagsContext": "for this <genre> narration video",
    "tagsHookRules": [
      "Rule 1 about tag selection.",
      "Rule 2."
    ],
    "broadKeywords": ["broad-kw-1", "broad-kw-2", "broad-kw-3"],
    "youtubeDescriptionStructure": {
      "musicLabel": "MUSIC",
      "booksSectionLabel": "📚 SECTION HEADER:",
      "supportSection": "💛 SUPPORT:\\nSubscribe for more <genre> stories.",
      "aiDisclosure": "🤖 AI DISCLOSURE:\\nThis story was written with the assistance of AI tools and reviewed by a human.",
      "defaultHashtags": ["#GenreHashtag1", "#GenreHashtag2"],
      "totalHashtagCount": 15
    }
  }
}`

export interface ExtractFormatOptions {
  /** One or more sample scripts (full text, plain prose). 2–3 samples gives the LLM more signal than 1. */
  samples: string[]
  /** Optional name the user wants the format to have. Empty = let the LLM infer. */
  desiredName?: string
  /** Optional 1-line note about the channel's intent (helps the LLM commit to the right vibe). */
  channelIntent?: string
}

export function buildFormatExtractionPrompt(opts: ExtractFormatOptions): string {
  const samples = opts.samples
    .map((s, i) => `=== SAMPLE ${i + 1} ===\n${s.slice(0, 12000)}\n`)
    .join('\n')

  const intentLine = opts.channelIntent
    ? `\nChannel intent (extra context): ${opts.channelIntent}\n`
    : ''
  const nameLine = opts.desiredName
    ? `\nUse this exact name for the format: "${opts.desiredName}" (and derive the id as a kebab-case slug from it).\n`
    : `\nInfer a short, concrete name for the format from the sample's genre conventions (e.g. "Coastal Folk Tales", "Workplace Comedy", "Survival Memoirs"). Derive a kebab-case id from the name.\n`

  return `You are extracting a Format profile from sample narration scripts. A Format is a structured JSON config that captures the conventions of a narration channel — the system prompt's role line, the additional writing rules the genre demands, the chapter pacing arc, the narrator personas the genre supports, the visual style for images, the metadata keyword pool. Once extracted, this Format is saved and used to generate every future episode in the same channel.

You will receive 1–3 sample scripts. Extract the GENERIC conventions — not the specific episode's plot. The Format must work for ANY episode the user generates next, in the same genre.

YOUR OUTPUT MUST BE A SINGLE VALID JSON OBJECT matching the Format schema below. No prose before or after. No markdown fences. Just JSON.

═══════════════════════════════════════════════════════════════════
SAMPLES TO ANALYSE:
═══════════════════════════════════════════════════════════════════

${samples}

═══════════════════════════════════════════════════════════════════
FORMAT SCHEMA — your output must match this exact shape:
═══════════════════════════════════════════════════════════════════

${FORMAT_SHAPE_EXAMPLE}

═══════════════════════════════════════════════════════════════════
RULES:
═══════════════════════════════════════════════════════════════════
${nameLine}${intentLine}
1. id: kebab-case slug, lowercase, hyphens not underscores. Avoid trailing/leading hyphens.
2. builtin: ALWAYS false (the user is creating this; built-ins ship with the app).
3. schemaVersion: ALWAYS 1.
4. script.pacingArc: 3-6 entries. Use {lastButOne} and {last} as chapter-number placeholders where the prose says "Chapters X to {lastButOne}" or "Chapter {last}".
5. script.narratorStyles: 3-7 personas, each with a stable id (single uppercase letter is fine: A, B, C…), a short label, and a 1-2 sentence description.
6. script.defaultNarratorStyleId: must match one of the narratorStyles ids.
7. imagePrompts.characterReferenceMode: use "inline" (the user hasn't enabled reference-image mode yet).
8. imagePrompts.recommendedAspect: pick "16:9" unless the genre is clearly mobile-first (use "9:16") or square-format.
9. metadata.broadKeywords: 5-10 keywords appropriate to the genre's YouTube/podcast search patterns.
10. metadata.youtubeDescriptionStructure.totalHashtagCount: usually 15 (one full hashtag block in the description).
11. idea.exampleIdeas: provide 1-2 NEW example ideas in this format's genre — not pulled from the samples. Show the LLM what good ideas look like for the channel.

CRITICAL: do not copy specifics from the sample (character names, plot beats, exact title). The Format is a TEMPLATE for future episodes; the samples are stylistic references only. Capture the conventions, leave the specifics behind.

Return ONLY the JSON object. No prose.`
}

/**
 * Strip common LLM artifacts (markdown fences, leading commentary) and parse.
 * Throws with the underlying parse error on failure so the caller can show
 * the raw response in the wizard for manual repair.
 */
export function parseExtractedFormatJson(raw: string): unknown {
  let text = raw.trim()
  // Strip ```json … ``` or ``` … ``` fences.
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
  }
  // Trim anything before the first { or after the last }.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in LLM response')
  }
  return JSON.parse(text.slice(start, end + 1))
}
