/**
 * Shared freeform Ideas operation. Both the immediate Ideas route and
 * formula-only campaign jobs use this prompt, provider contract, and parser.
 * Topic Pack campaigns intentionally keep their structured planner path.
 */
import { callAiWithModelPolicy, callAiWithRetry, type CallAiContext } from '../lib/ai-client.js'
import type { AssignedPipelineModelPolicy, PipelinePolicyCheckpointStore } from '../lib/pipeline-model-policy.js'
import { type Format, type GenerateIdeasRequest } from '../models/types.js'
import { ideaOutputTokenBudget } from './idea-output-budget.js'
import { ideaBatchOutputContract } from '../lib/story-output-contracts.js'
import { truncateChars } from '../lib/well-formed-text.js'

// Expanded lever pool covering four diversity axes. Two are picked at random
// per batch so the model has cross-cutting constraints, not a single soft hint.
const CREATIVITY_LEVERS = [
  // Setting
  'an unexpected setting (not forest, castle, beach, or library)',
  'a confined or single-location story (one house, one ship, one room)',
  'a nature or weather extreme (desert, tundra, deep sea, thunderstorm)',
  'an indoor/domestic space that becomes strange (kitchen, attic, workshop)',
  // Protagonist
  'a non-human viewpoint (animal, place, object, or weather itself)',
  'an ensemble or chorus narration (multiple voices sharing one story)',
  'a very young or very old protagonist with limited agency',
  'a specialist occupation rarely seen in fiction (clockmaker, cartographer, piano tuner, lamp‑lighter)',
  // Structure
  'a story told in reverse, or framed as a memory',
  'a story spanning a single hour — real-time pacing',
  'a story delivered as letters, recordings, or a journal',
  // Emotional
  'grief transformed into something specific and concrete',
  'a quiet rebellion against a small, personal tradition',
  'an inherited obligation the protagonist must decide whether to keep',
]

export interface AvoidItem { title: string; mood?: string; themes?: string[] }

export function buildAvoidSection(items: AvoidItem[]): string {
  if (!items.length) return ''
  // The local post-generation gate checks the complete history. Supplying
  // the latest 200 records here helps the model avoid wasting candidates
  // before that gate without allowing a very old project to consume an
  // unbounded prompt.
  const lines = items.slice(0, 200).map(i => {
    const themes = (i.themes || []).filter(Boolean).slice(0, 4).join(', ')
    const parts = [`"${i.title}"`]
    if (i.mood) parts.push(`mood: ${i.mood}`)
    if (themes) parts.push(`themes: ${themes}`)
    return `- ${parts.join('; ')}`
  })
  return `\nAVOID — these ideas already exist for this project. Produce something genuinely different from every one of them (different setting, different protagonist, different emotional arc, different central image). Do NOT produce variations, sequels, or rephrasings:\n${lines.join('\n')}\n`
}

function pickLevers(count: number): string[] {
  const pool = [...CREATIVITY_LEVERS]
  const out: string[] = []
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    out.push(pool.splice(idx, 1)[0]!)
  }
  return out
}

/**
 * Match the leading count number in a title string.
 *
 * Recognises forms like:
 *   "10 mysteries explained"          → 10
 *   "7 plane crashes"                 → 7
 *   "Top 12 paradoxes"                → 12
 *   "The 5 longest rivers"            → 5
 *   "Five plane crashes" / "Twelve …" → null (numeric only — words are
 *                                       intentionally ignored to keep
 *                                       the rewrite logic literal and
 *                                       reversible)
 *
 * Used to enforce items_per_listicle consistency between the title and
 * suggested_chapters, and to prefill the Scripts page chapter field.
 * Exported for the test suite.
 */
export function parseLeadingCount(title: string): { value: number; start: number; end: number } | null {
  if (!title) return null
  // Skip optional leading articles / qualifiers ("The", "Top") so the
  // count isn't missed when wrapped. Capture the digit run.
  const m = title.match(/^(?:(?:the|top)\s+)?(\d+)\b/i)
  if (!m) return null
  const value = parseInt(m[1]!, 10)
  if (!Number.isFinite(value) || value <= 0) return null
  const start = m.index! + m[0].length - m[1]!.length
  return { value, start, end: start + m[1]!.length }
}

/**
 * Rewrite the leading count number in a title to `target` if one
 * exists, otherwise return the title unchanged. Used post-LLM as a
 * safety net when items_per_listicle is pinned — even if the model
 * ignored the prompt instruction, the output ends up consistent.
 */
export function rewriteLeadingCount(title: string, target: number): string {
  const m = parseLeadingCount(title)
  if (!m || m.value === target) return title
  return title.slice(0, m.start) + String(target) + title.slice(m.end)
}

/**
 * Build the user-controlled portion of the idea prompt. Empty refinement
 * fields deliberately stay open rather than inheriting old fantasy/sleep
 * defaults. The channel format may still provide its audience context.
 */
export function buildCreativeParameters(
  req: GenerateIdeasRequest,
  formatAudience = '',
): string {
  const clean = (value: unknown, fallback: string) => {
    const text = typeof value === 'string' ? value.trim() : ''
    return text || fallback
  }
  const keywords = Array.isArray(req.keywords)
    ? req.keywords.map(value => clean(value, '')).filter(Boolean).slice(0, 12)
    : []
  const lenses = Array.isArray(req.creative_lenses)
    ? [...new Set(req.creative_lenses
      .map(value => truncateChars(clean(value, ''), 120))
      .filter(Boolean))].slice(0, 8)
    : []

  const lines = [
    `- Genre: ${clean(req.genre, 'model chooses freely')}`,
    `- Theme: ${clean(req.theme, 'model chooses freely')}`,
    `- Target audience: ${clean(req.audience, clean(formatAudience, 'model chooses freely'))}`,
    `- Mood/tone: ${clean(req.mood, 'model chooses freely')}`,
    `- Keywords to incorporate: ${keywords.length ? keywords.join(', ') : 'none required'}`,
  ]
  if (lenses.length) {
    lines.push(`- Creative lenses (use as inspiration, not a formula): ${lenses.join('; ')}`)
  }
  return lines.join('\n')
}

export function buildFreeformIdeaPrompt(
  req: GenerateIdeasRequest,
  format: Format,
  standards: string | null | undefined,
  avoid: AvoidItem[],
  extraAvoidNote?: string,
  titleTemplate?: string,
  topPerformersBlock: string = '',
): string {
  const standardsSection = standards
    ? `\nOptional project instructions (use only when consistent with the active Series Formula):\n\n${truncateChars(standards, 2000)}\n`
    : ''

  const seed = Math.random().toString(36).slice(2, 10)
  const creativeMode = req.creative_mode || 'guided'
  const avoidRepeatedIdeas = req.avoid_repeated_ideas !== false
  const levers = pickLevers(creativeMode === 'strict' ? 2 : creativeMode === 'guided' ? 1 : 0)
  const leverLines = levers
    .map((l, i) => `  ${i + 1}. ${l}`)
    .join('\n')

  const avoidSection = avoidRepeatedIdeas ? buildAvoidSection(avoid) : ''
  const extraAvoid = extraAvoidNote
    ? `\nAlso avoid the concepts listed here (these came back too close to existing on the last attempt): ${extraAvoidNote}\n`
    : ''

  // Format guidance — appears as a "FORMAT GUIDANCE" block so the LLM
  // anchors the genre/audience/tone before it picks settings + protagonists.
  // The format's role line ("You are helping generate new story ideas for a
  // sleep-story narration channel.") flows in here too so the LLM gets the
  // channel context even though this prompt has no system message.
  const formatGuidance = `${format.idea.systemPromptRole}

${format.idea.guidanceText}`

  // v1.0.165+ — Title template (optional). When the user set a template
  // on the Ideas page (e.g. "Fall asleep to {X}"), instruct the LLM to
  // shape EVERY generated title to it, filling the literal {X} with a
  // concrete subject the LLM picks fresh per idea. Replaced the old
  // Pattern preset system, which carried this same {X} mechanic plus
  // opening/closing-device directives the user never used.
  const titleTemplateBlock = (titleTemplate && titleTemplate.trim())
    ? `\n⟂ TITLE TEMPLATE ⟂
Each generated idea's title MUST follow this template literally, with {X} substituted by a concrete value:

  Template: "${titleTemplate.trim()}"

Rules:
- Replace {X} with a SPECIFIC concrete noun (a place / era / craft / object / person / topic — whatever fits the channel and the idea).
- Pick a DIFFERENT {X} value for every idea in the batch — never repeat a subject, and never write the literal word "X".
- Keep the rest of the template wording exactly as written; only {X} changes.
`
    : ''

  // Format-derived constraints (v1.0.65). These used to be hardcoded
  // with sleep-story-specific values ("8-12 chapters", "45/60 min"
  // length, "avoid clocktower keepers / lantern keepers" anti-tropes)
  // which silently overrode the format's intent — picking the
  // Listicle format still produced fantasy ideas because the rules
  // block at the END of the prompt was the LAST thing the LLM read.
  // Now everything format-variable comes from the format itself.
  // Range widening — see buildPastePrompt below for rationale. Per-
  // project format_overrides can push the default outside the format's
  // declared range (compilation-mode: 100 chapters / 120 min vs listicle's
  // [3,20] / [10,90]). Auto-extend so the LLM doesn't see a
  // contradictory "between 3 and 20 (default 100)" instruction.
  const [chMinFmt, chMaxFmt] = format.script.chapterCountRange
  const [lenMinFmt, lenMaxFmt] = format.script.lengthMinutesRange
  const chMin = Math.min(chMinFmt, format.script.defaultChapterCount)
  const chMax = Math.max(chMaxFmt, format.script.defaultChapterCount)
  const lenMin = Math.min(lenMinFmt, format.script.defaultLengthMinutes)
  const lenMax = Math.max(lenMaxFmt, format.script.defaultLengthMinutes)

  // Pinned chapter count (v1.0.70). When the user pins items_per_listicle
  // on the Ideas page, EVERY generated idea must have suggested_chapters
  // == this value AND any number that appears in the title must equal
  // this value. Replaces the soft "within range, default N" instruction
  // with a hard equality so a "10 mysteries" pinned count never returns
  // a "7 paradoxes" idea (or vice versa). Unset = legacy soft range.
  const pinned = (typeof req.items_per_listicle === 'number' && Number.isFinite(req.items_per_listicle) && req.items_per_listicle > 0)
    ? Math.round(req.items_per_listicle)
    : null
  const chapterRule = pinned !== null
    ? `MUST equal exactly ${pinned} (pinned for this batch — every idea has the same chapter count)`
    : `within ${chMin}–${chMax} (format default ${format.script.defaultChapterCount})`
  const lengthExamples = lenMin === lenMax
    ? `"${lenMin} min"`
    : `"${lenMin} min" through "${lenMax} min"`
  // Example ideas baked into the format render as a "see this bar"
  // signal — the LLM matches output style to in-prompt examples far
  // more reliably than to abstract guidance.
  const exampleBlock = creativeMode !== 'open' && format.idea.exampleIdeas?.length
    ? `\nEXAMPLES — match this bar (do not copy):\n${format.idea.exampleIdeas
        .map((ex, i) =>
          `  ${i + 1}. ${ex.title}\n     ${ex.logline}\n     themes: ${ex.themes.join(', ')} · ${ex.suggested_chapters} chapters · ${ex.suggested_length} · mood: ${ex.mood}`)
        .join('\n')}\n`
    : ''
  // Mood vocabulary from the format provides on-tone adjectives the
  // LLM can sample from. Replaces the implicit sleep-story-flavoured
  // adjective expectations that used to live in the hardcoded rules.
  const moodVocab = format.idea.moodVocabulary?.length
    ? `Tone-appropriate mood words for this format: ${format.idea.moodVocabulary.slice(0, 12).join(', ')}.`
    : ''

  // ── v1.0.95+ Data-driven idea-prompt assembly ─────────────────────────
  //
  // Every voice/shape rule reads from format.idea.* (which may have
  // been niche-merged via applyNicheToFormat). When a field is unset,
  // the prompt falls back to a MINIMAL LENIENT instruction that points
  // the LLM at the example ideas as the bar — the example bar does
  // the heavy lifting for niches that don't need strict rules.
  //
  // The prior version had hardcoded English assumptions baked in
  // ("evocative, 5-10 words; pick adjectives", "no two titles share
  // noun+preposition structure", "1-2 sentences with a concrete
  // image") that were written for sleep-story and silently coerced
  // every other niche toward that voice. Now those strings live in
  // JSON; the builder is a thin reader.

  // Title instruction — driven by titleShapeRules + titleLengthRange.
  const titleRules = format.idea.titleShapeRules
  const titleLen = format.idea.titleLengthRange
  const titleLengthHint = titleLen ? `${titleLen[0]}–${titleLen[1]} words` : ''
  const titleInstruction = titleRules?.length
    ? `1. title — Follow the TITLE RULES below VERBATIM${titleLengthHint ? ` (length: ${titleLengthHint})` : ''}.
   TITLE RULES (format-/niche-specific, MUST follow):
${titleRules.map(r => `     · ${r}`).join('\n')}`
    // Lenient fallback when no format/niche supplies title rules. The
    // example ideas above carry the bar; we just nudge the LLM at
    // length and remind it to match the examples.
    : `1. title — Match the shape and voice of the EXAMPLES above${titleLengthHint ? `. Target length: ${titleLengthHint}` : ''}.`

  // Logline instruction.
  const loglineRules = format.idea.loglineShapeRules
  const loglineSent = format.idea.loglineSentenceRange
  const loglineLengthHint = loglineSent
    ? `${loglineSent[0]}–${loglineSent[1]} sentence${loglineSent[1] === 1 ? '' : 's'}`
    : ''
  const loglineInstruction = loglineRules?.length
    ? `2. logline — Follow the LOGLINE RULES below${loglineLengthHint ? ` (${loglineLengthHint})` : ''}.
   LOGLINE RULES:
${loglineRules.map(r => `     · ${r}`).join('\n')}`
    : `2. logline — ${loglineLengthHint || '1–2 sentences'} that match the example loglines' voice.`

  // Themes instruction.
  const themeRules = format.idea.themeShapeRules
  const themeCount = format.idea.themeCountRange || [2, 4]
  const themeInstruction = themeRules?.length
    ? `3. themes — Array of ${themeCount[0]}–${themeCount[1]} keywords. Follow the THEME RULES below.
   THEME RULES:
${themeRules.map(r => `     · ${r}`).join('\n')}`
    : `3. themes — ${themeCount[0]}–${themeCount[1]} thematic keywords matching the examples' voice.`

  // Structural-variety rule — enum-driven. Sleep-story / listicle want
  // every title to look different. Prayer wants every title to look
  // the SAME (channel signature). Other formats are 'free'.
  const variety = format.idea.structuralVariety || 'free'
  const varietyRule =
    variety === 'vary-all'          ? '- No two titles may share the same noun+preposition structure (e.g. "The X of the Y" twice).' :
    variety === 'vary-subject-only' ? '- Structure REPETITION is correct here: the title rules above tell you the shape. Vary only the SUBJECT across the batch, never the structure.' :
    /* 'free' */                      '- Aim for a varied batch; the LLM picks structure freely as long as it matches the examples above.'

  const creativityBlock = creativeMode === 'strict'
    ? `CREATIVE MODE: GUARDRAILS\nApply both diversity levers as firm batch constraints:\n${leverLines}`
    : creativeMode === 'guided'
      ? `CREATIVE MODE: BALANCED\nTreat this as optional inspiration, not a requirement: ${levers[0] || 'find a fresh angle appropriate to the format'}.`
      : `CREATIVE MODE: OPEN\nThe model chooses subjects, structures, imagery, and emotional angles freely. Format guidance is context, not a formula. Do not imitate examples or add stock genre tropes.`
  const userDirection = req.creative_direction?.trim()
    ? `\nUSER CREATIVE DIRECTION — prioritize this over optional style guidance:\n${req.creative_direction.trim()}\n`
    : ''
  const creativeParameters = buildCreativeParameters(req, format.idea.audienceDefault)

  return `Generate exactly ${req.count} episode ideas for the channel format described below.

${formatGuidance}
${titleTemplateBlock}${topPerformersBlock}${exampleBlock}
PARAMETERS:
${creativeParameters}
- Creativity seed: ${seed} (ignore semantics; use only to diverge from prior output)
${standardsSection}${avoidSection}${extraAvoid}
${creativityBlock}${userDirection}

For EACH idea, provide:
${titleInstruction}
${loglineInstruction}
${themeInstruction}
4. suggested_chapters — ${chapterRule}
5. suggested_length — minutes-string within ${lengthExamples} (format default ${format.script.defaultLengthMinutes} min)
6. mood — emotional arc in 2–4 words

RULES:
- Every idea must have a different angle / subject / emotional arc from the others in this batch.
${varietyRule}
- ${avoidRepeatedIdeas ? 'Do not repeat, rephrase, sequel, or lightly remix anything in the AVOID list. New structure is not enough; the central subject and payoff must also be new.' : 'Originality history is intentionally disabled for this batch; within-batch ideas must still be distinct.'}
- Honour the format guidance above — that's the channel's voice. Don't bring in tropes from other genres.
- TITLE-NUMBER CONSISTENCY: if your title contains a leading count number (e.g. "10 mysteries", "7 plane crashes", "12 paradoxes"), the suggested_chapters value MUST equal that number. Mismatch is the most common bug we see — pick a count first, then write the title to match.${pinned !== null ? `\n- Pinned for this batch: every title that uses a leading count number MUST use ${pinned}, and suggested_chapters MUST be ${pinned}.` : ''}
- ${moodVocab}

Return ONLY a JSON object of the form {"ideas": [ ... ]}, where every array item is one idea object with the exact keys above. No markdown, no commentary.`
}

export function parseFreeformIdeas(raw: string): any[] {
  let text = raw.trim()
  if (text.startsWith('```')) {
    const lines = text.split('\n').filter(l => !l.trim().startsWith('```'))
    text = lines.join('\n')
  }
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1) throw new Error('No JSON array found in AI response')
  return JSON.parse(text.slice(start, end + 1))
}


export interface GenerateFreeformIdeaBatchInput {
  request: GenerateIdeasRequest
  format: Format
  standards: string | null | undefined
  avoid: AvoidItem[]
  apiKeys: { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }
  slug: string
  jobId?: string
  signal?: AbortSignal
  titleTemplate?: string
  topPerformersBlock?: string
  extraAvoidNote?: string
  onPrompt?: (prompt: string) => void
  /** Explicit shared-lineup policy for queued campaign batches. */
  pipelineModelPolicy?: AssignedPipelineModelPolicy
  pipelinePolicyCheckpoint?: PipelinePolicyCheckpointStore
  pipelinePolicyCheckpointKey?: string
  pipelinePolicyInputFingerprint?: string
  requestIdentity?: string
  /** Reuse a prompt persisted before a lineup availability wait. */
  preparePrompt?: () => string
}

/**
 * Submit exactly one existing freeform Ideas batch. Callers own persistence,
 * similarity filtering, and any durable campaign provenance.
 */
export async function generateFreeformIdeaBatch(input: GenerateFreeformIdeaBatchInput): Promise<any[]> {
  const prompt = input.preparePrompt?.() || buildFreeformIdeaPrompt(
      input.request,
      input.format,
      input.standards,
      input.avoid,
      input.extraAvoidNote,
      input.titleTemplate,
      input.topPerformersBlock,
    )
  input.onPrompt?.(prompt)
  const context: CallAiContext = {
    slug: input.slug,
    jobId: input.jobId,
    signal: input.signal,
    outputBudget: { tier: 'long', minimumTokens: ideaOutputTokenBudget(input.request.count) },
    outputContract: ideaBatchOutputContract(),
    requestIdentity: input.requestIdentity,
    pipelinePolicyCheckpoint: input.pipelineModelPolicy ? input.pipelinePolicyCheckpoint : undefined,
    pipelinePolicyCheckpointKey: input.pipelinePolicyCheckpointKey,
    pipelinePolicyInputFingerprint: input.pipelinePolicyInputFingerprint,
  }
  const raw = input.pipelineModelPolicy
    ? await callAiWithModelPolicy(input.pipelineModelPolicy, '', prompt, input.apiKeys, false, context)
    : await callAiWithRetry(input.request.model, '', prompt, input.apiKeys, false, context)
  return parseFreeformIdeas(raw)
}
