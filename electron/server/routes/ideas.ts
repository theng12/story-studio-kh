/**
 * Story Idea Generator + persistence endpoints.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { trackGeneration } from '../services/session-tracker.js'
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { type Format } from '../models/types.js'
import { getEffectiveFormat } from '../services/format-loader.js'
// v1.0.165 — loadPattern + the Pattern type are no longer used here;
// the Pattern system's {X} title shape is a plain title_template string
// now. The full pattern-loader removal lands in the 1.0.166 backend pass.
import type { GenerateIdeasRequest, StoryIdea } from '../models/types.js'
import { filterGenerated, type SimilarityCandidate } from '../services/idea-similarity.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { invalidateProjectUploadCaches } from '../services/upload-caches.js'
import { previewCompact, compactAcceptedEpisodes } from '../services/upload-compact.js'
import { isLocalTextModel } from '../services/job-retry-policy.js'
import { loadNiche } from '../services/niche-loader.js'
import { isCompatible, loadTopicPack } from '../services/topic-pack-loader.js'
import { ideaOutputTokenBudget } from '../services/idea-output-budget.js'
import {
  previewReseason, applyReseason, revertReseason,
  readReseasonUndo, deleteReseasonUndo, isReseasonUndoExpired,
} from '../services/upload-reseason.js'

export const router = Router()

// ── Generate ideas (and persist them) ───────────────────────────────────────

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

interface AvoidItem { title: string; mood?: string; themes?: string[] }

function buildAvoidSection(items: AvoidItem[]): string {
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
      .map(value => clean(value, '').slice(0, 120))
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

function buildPrompt(
  req: GenerateIdeasRequest,
  format: Format,
  standards: string | null | undefined,
  avoid: AvoidItem[],
  extraAvoidNote?: string,
  titleTemplate?: string,
  topPerformersBlock: string = '',
): string {
  const standardsSection = standards
    ? `\nOptional project instructions (use only when consistent with the active Series Formula):\n\n${standards.slice(0, 2000)}\n`
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
  // declared range (BrainWise: 100 chapters / 120 min vs listicle's
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

Return ONLY a JSON array of objects with the exact keys above. No markdown, no commentary.`
}

function parseIdeas(raw: string): any[] {
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

/**
 * Queue a durable, navigation-safe Idea Campaign.
 *
 * The campaign id is generated once here and persisted in the job params.
 * Retrying the job therefore reuses the same id, audits the ideas already
 * saved for that campaign, and fills only the missing coverage slots.
 */
router.post('/projects/:slug/generate/ideas/campaign', async (req, res) => {
  try {
    const { slug } = req.params
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })

    const count = Math.round(Number(req.body?.count))
    if (!Number.isFinite(count) || count < 1 || count > 100) {
      return res.status(400).json({ detail: 'Idea Campaign count must be between 1 and 100.' })
    }
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
    if (!model) return res.status(400).json({ detail: 'Choose an AI model before queuing the campaign.' })

    const rawFormula = req.body?.niche_id
    let seriesFormulaId: string | undefined
    if (typeof rawFormula === 'string') {
      const value = rawFormula.trim()
      seriesFormulaId = value && value !== '__none__' ? value : undefined
    } else {
      seriesFormulaId = project.niche_id
    }

    const topicPackIds: string[] | undefined = Array.isArray(req.body?.topic_pack_ids)
      ? [...new Set<string>(req.body.topic_pack_ids
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value: string) => value.trim())
        .filter(Boolean))]
      : project.topic_pack_ids

    if (seriesFormulaId) {
      const formula = await loadNiche(seriesFormulaId)
      if (!formula) return res.status(404).json({ detail: `Series Formula '${seriesFormulaId}' not found.` })
      for (const packId of topicPackIds || []) {
        const pack = await loadTopicPack(packId)
        if (!pack) return res.status(404).json({ detail: `Topic Pack '${packId}' not found.` })
        if (!isCompatible(pack, seriesFormulaId)) {
          return res.status(400).json({
            detail: `Topic Pack '${packId}' is not compatible with Series Formula '${seriesFormulaId}'.`,
          })
        }
      }
    } else if (topicPackIds?.length) {
      return res.status(400).json({ detail: 'Choose a Series Formula before adding Topic Packs.' })
    }

    const campaignId = `idea-campaign-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const params = {
      ...req.body,
      count,
      model,
      campaign_id: campaignId,
      series_formula_id: seriesFormulaId,
      topic_pack_ids: topicPackIds,
    }
    delete (params as any).niche_id

    const job = jq.enqueue({
      project_slug: slug,
      type: 'idea_campaign',
      episode_id: 'ideas',
      title: `Idea Campaign — ${count} ideas`,
      params,
    })
    return res.status(201).json(job)
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) {
      return res.status(409).json({
        detail: 'An Idea Campaign is already queued or running for this project. Track it in Jobs, or wait for it to finish.',
      })
    }
    return res.status(400).json(humanizeBackendError(e, 'Failed to queue Idea Campaign'))
  }
})

router.post('/projects/:slug/generate/ideas', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const body: GenerateIdeasRequest = req.body
  const standards = await pm.getStandards(slug)

  // v1.0.92+ — per-call niche override. The Ideas Generator surfaces a
  // NichePicker that defaults to the project's saved niche_id but lets
  // the user dial it up/down per generation. Passing the special string
  // `'__none__'` forces "no niche" even when the project has one saved;
  // omitting the field falls through to project.niche_id (no override).
  const rawNiche = (req.body as any)?.niche_id
  let nicheIdOverride: string | null | undefined
  if (typeof rawNiche === 'string') {
    const trimmed = rawNiche.trim()
    if (trimmed === '__none__' || trimmed === '') nicheIdOverride = null
    else nicheIdOverride = trimmed
  } else {
    nicheIdOverride = undefined
  }
  const format = await getEffectiveFormat(
    slug,
    nicheIdOverride === undefined ? undefined : { nicheIdOverride },
  )

  // Optional pattern preset — when the Ideas-page picker selected one,
  // we load it here so the prompt assembler can inject the title-style
  // block. Failure to load (deleted pattern, malformed file, etc.)
  // v1.0.165+ — optional title template. A plain string the user typed
  // on the Ideas page (e.g. "Fall asleep to {X}"). Can't "fail to load"
  // like the old Pattern presets did, so there's no warning path —
  // the X-Pattern-Warning header + loadPattern call were removed.
  const titleTemplate = typeof (body as any).title_template === 'string'
    ? (body as any).title_template.trim()
    : ''

  // Build the AVOID list from everything we already know about this project.
  // Sort newest-first so the 30-item cap keeps the freshest signals.
  const prior = await im.getIdeas(slug)
  const avoid: AvoidItem[] = [...prior]
    .sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''))
    .map(i => ({ title: i.title, mood: i.mood, themes: i.themes }))

  const apiKeys = {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }

  // Pin enforcement (v1.0.70): when the user passed items_per_listicle,
  // every idea's suggested_chapters MUST equal that pin even if the LLM
  // ignored the instruction. We also rewrite leading title numbers so
  // "7 sleep mysteries" → "10 sleep mysteries" when the pin is 10. The
  // prompt asks the LLM to do this; the post-process is the safety net.
  const pinnedChapters = (typeof body.items_per_listicle === 'number'
    && Number.isFinite(body.items_per_listicle)
    && body.items_per_listicle > 0)
    ? Math.round(body.items_per_listicle)
    : null

  // v1.0.93+ — channel-level title prefix/suffix. Mirrors the
  // titleConfig.prefix/suffix on metadata.vue (same project-config keys:
  // broll_channel_title_prefix / broll_channel_title_suffix), but applied
  // at idea-generation time so the brainstorm list and the final YouTube
  // title share the same channel framing ("Morning Prayer: ...").
  //
  // Override semantics: if the request body carries explicit
  // title_prefix / title_suffix strings, they win — even when empty
  // (empty string = "no wrapping for this batch even if the project has
  // one saved"). Undefined falls back to the project config so existing
  // callers (Pipeline, scheduled jobs) don't accidentally drop the
  // channel framing.
  const rawBodyPrefix = (req.body as any)?.title_prefix
  const rawBodySuffix = (req.body as any)?.title_suffix
  let titlePrefix = ''
  let titleSuffix = ''
  if (typeof rawBodyPrefix === 'string') {
    titlePrefix = rawBodyPrefix
  } else if (typeof (config as any)?.broll_channel_title_prefix === 'string') {
    titlePrefix = (config as any).broll_channel_title_prefix
  }
  if (typeof rawBodySuffix === 'string') {
    titleSuffix = rawBodySuffix
  } else if (typeof (config as any)?.broll_channel_title_suffix === 'string') {
    titleSuffix = (config as any).broll_channel_title_suffix
  }
  function wrapTitle(s: string): string {
    if (!titlePrefix && !titleSuffix) return s
    return `${titlePrefix}${s}${titleSuffix}`
  }

  function normalizeIdeas(raw: any[]): StoryIdea[] {
    return raw.map((item: any) => {
      const rawTitle: string = (item.title || 'Untitled').toString()
      const rawChapters: number = Number(item.suggested_chapters) || 10
      const chapters = pinnedChapters !== null ? pinnedChapters : rawChapters
      const countAdjustedTitle = pinnedChapters !== null
        ? rewriteLeadingCount(rawTitle, pinnedChapters)
        : rawTitle
      // Wrap AFTER the leading-count rewrite so "Morning Prayer: 10 Mysteries…"
      // stays correctly wrapped when the user pinned 10 items. Wrapping
      // before the rewrite would put the count inside the prefix and the
      // regex would miss it.
      const title = wrapTitle(countAdjustedTitle)
      return {
        title,
        logline: item.logline || '',
        themes: item.themes || [],
        suggested_chapters: chapters,
        suggested_length: item.suggested_length || '45 min',
        mood: item.mood || '',
      }
    })
  }

  try {
    // Overshoot slightly so a trim after similarity filtering usually still
    // leaves us at body.count without a retry.
    const wantedCount = body.count
    const overshoot = { ...body, count: wantedCount + 3 }
    // Pull the channel's top performers as inspiration. Best-effort —
    // returns '' when no account / no scope / API down. The block joins
    // the existing format + pattern guidance so the LLM picks up the
    // channel vibe from titles that already worked.
    const { getTopPerformersForSlug } = await import('../lib/youtube-analytics.js')
    const { formatTopPerformersBlock } = await import('../lib/top-performers.js')
    const topPerformers = await getTopPerformersForSlug(slug, 5)
    const topBlock = formatTopPerformersBlock(topPerformers)
    const firstPrompt = buildPrompt(overshoot, format, standards, avoid, undefined, titleTemplate, topBlock)
    // v1.0.93+ — one-line effective-state log so future "why are my prayer
    // ideas about mountains?" regressions are debuggable from a glance at
    // server output. Captures the four signals that determine title voice.
    const effectiveNicheId = nicheIdOverride !== undefined ? (nicheIdOverride || '(forced none)') : (project.niche_id || '(none)')
    const tRules = format.idea.titleShapeRules?.length || 0
    const lRules = format.idea.loglineShapeRules?.length || 0
    const thRules = format.idea.themeShapeRules?.length || 0
    const tLen = format.idea.titleLengthRange ? `${format.idea.titleLengthRange[0]}-${format.idea.titleLengthRange[1]}w` : '-'
    const variety = format.idea.structuralVariety || 'free'
    console.log(`[ideas-gen] effective: format=${project.format_id || '(fallback:sleep-story)'} niche=${effectiveNicheId} examples=${format.idea.exampleIdeas?.length || 0} title{rules=${tRules},len=${tLen}} logline{rules=${lRules}} themes{rules=${thRules}} variety=${variety} prefix=${JSON.stringify(titlePrefix || '')} suffix=${JSON.stringify(titleSuffix || '')}`)
    const firstRaw = await callAiWithRetry(body.model, '', firstPrompt, apiKeys, false, {
      slug,
      maxTokens: ideaOutputTokenBudget(overshoot.count),
    })
    const firstBatch = normalizeIdeas(parseIdeas(firstRaw))
    const avoidRepeatedIdeas = body.avoid_repeated_ideas !== false

    // Filter against the project's history + within-batch dupes.
    const priorCandidates: SimilarityCandidate[] = prior.map(i => ({
      title: i.title, logline: i.logline, themes: i.themes, mood: i.mood,
    }))
    const firstPass = avoidRepeatedIdeas
      ? filterGenerated<StoryIdea>(firstBatch, priorCandidates)
      : { kept: firstBatch, rejected: [] }

    let kept = firstPass.kept.slice(0, wantedCount)

    // If filtering cost us too many, reprompt once for the shortfall with
    // the rejected titles added to the avoid list.
    if (avoidRepeatedIdeas && kept.length < wantedCount && isLocalTextModel(body.model)) {
      const shortfall = wantedCount - kept.length
      const rejectedTitles = firstPass.rejected
        .map(r => r.candidate.title)
        .filter(Boolean)
        .join(', ')
      const retryReq = { ...body, count: shortfall }
      // Bake everything we've seen so far into the avoid list for the retry.
      const retryAvoid: AvoidItem[] = [
        ...avoid,
        ...kept.map(k => ({ title: k.title, mood: k.mood, themes: k.themes })),
      ]
      const retryPrompt = buildPrompt(retryReq, format, standards, retryAvoid, rejectedTitles, titleTemplate, topBlock)
      try {
        const retryRaw = await callAiWithRetry(body.model, '', retryPrompt, apiKeys, false, {
          slug,
          maxTokens: ideaOutputTokenBudget(retryReq.count),
        })
        const retryBatch = normalizeIdeas(parseIdeas(retryRaw))
        const retryPass = filterGenerated<StoryIdea>(
          retryBatch,
          [...priorCandidates, ...kept.map(k => ({ title: k.title, logline: k.logline, themes: k.themes, mood: k.mood }))],
        )
        // Never reinsert rejected candidates merely to fill the requested
        // count. A shorter genuinely-new batch is safer than silently
        // recycling an existing episode.
        const retryKept = retryPass.kept.slice(0, shortfall)
        kept = [...kept, ...retryKept]
      } catch (e: any) {
        console.warn('[ideas] retry generation failed:', e?.message || e)
        // If the retry itself fails, surface what we have from the first pass.
        // Users still get a non-empty batch.
      }
    }

    const ideas = kept.slice(0, wantedCount)

    // Persist all kept ideas
    const stored = await im.addIdeas(slug, ideas, body.model)

    // Track for session stats
    await trackGeneration(slug, 'ideas', ideas.length)

    // Surface a pattern-load failure (when one happened) via response
    // header so the Ideas page can show a non-blocking toast. Header
    // shape (vs body) keeps the existing array response unchanged for
    // clients that don't care.
    res.json(stored)
  } catch (e: any) {
    // Honour explicit statusCode (provider 4xx, schema 400, …) so the
    // frontend can distinguish "bad input" from "provider down" and
    // route through humanizeBackendError to surface actionable hints.
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'AI generation failed'))
  }
})

// ── Bulk paste-import from an external LLM ──────────────────────────────────
// Second-class citizen to the `/generate/ideas` route above: instead of
// calling the LLM server-side with the user's API key, we hand the user a
// preset prompt they paste into their own ChatGPT / Claude session, and they
// paste the JSON array back here. Useful when the project's configured keys
// are exhausted, when the user wants to curate ideas by hand in an external
// tool, or when they just prefer the UX of their own LLM client.
//
// Validation mirrors what `normalizeIdeas` (line 168) tolerates from the
// model's raw output, but stricter — we REJECT a row rather than defaulting,
// because the user sees the preview table and can go fix the LLM output if
// a field is missing. Defaulting would hide quality problems.

/**
 * Build the paste-prompt the user copies into their own LLM client. Per-format
 * because a sleep-story channel asks for different rules and example ideas
 * than an adventure channel. Examples come from the format's idea.exampleIdeas
 * array (the loader rejects formats with malformed examples, so they're safe
 * to embed).
 */
function buildPastePrompt(
  format: Format,
  titleTemplate?: string,
): string {
  const exampleJson = format.idea.exampleIdeas?.length
    ? JSON.stringify(format.idea.exampleIdeas, null, 2)
    : '[\n  // (no examples in this format — match the shape above)\n]'

  // v1.0.165+ — title template (optional). Same shape as the in-app
  // generate flow so a paste-into-ChatGPT run produces ideas with the
  // same title shape as a generate-in-app run. Only emitted when set.
  const titleTemplateBlock = (titleTemplate && titleTemplate.trim())
    ? `\n⟂ TITLE TEMPLATE ⟂
Each generated idea's title MUST follow this template literally, with {X} substituted by a concrete value:

  Template: "${titleTemplate.trim()}"

Rules:
- Replace {X} with a SPECIFIC concrete noun (a place / era / craft / object / person / topic — whatever fits the channel and the idea).
- Pick a DIFFERENT {X} value for every idea — never repeat a subject, and never write the literal word "X".
- Keep the rest of the template wording exactly as written; only {X} changes.
`
    : ''

  // Format-derived shape (v1.0.65). Sleep-story-specific values like
  // "8-12 chapters" / "45 min" / 'avoid magical/enchanted' used to be
  // hardcoded here, which made the paste prompt produce sleep-story-
  // shaped ideas regardless of the project's selected format. Now we
  // pull from format.script.* so the listicle / educational / true-
  // crime / etc formats get their own ranges.
  //
  // Per-project format overrides can push `defaultChapterCount` /
  // `defaultLengthMinutes`
  // outside the format's declared range — e.g. BrainWise running 100
  // chapters in a 2-hour video against listicle's [3,20] / [10,90]
  // defaults. When that happens we widen the prompt's stated range to
  // include the default so the LLM doesn't get a contradictory
  // "between 3 and 20 (default 100)" instruction.
  const [chMinFmt, chMaxFmt] = format.script.chapterCountRange
  const [lenMinFmt, lenMaxFmt] = format.script.lengthMinutesRange
  const exampleChapters = format.script.defaultChapterCount
  const exampleLengthMin = format.script.defaultLengthMinutes
  const chMin = Math.min(chMinFmt, exampleChapters)
  const chMax = Math.max(chMaxFmt, exampleChapters)
  const lenMin = Math.min(lenMinFmt, exampleLengthMin)
  const lenMax = Math.max(lenMaxFmt, exampleLengthMin)
  const exampleLength = `${exampleLengthMin} min`
  const lengthOneOf = lenMin === lenMax
    ? `"${lenMin} min"`
    : `any minutes-string between "${lenMin} min" and "${lenMax} min"`

  return `${format.idea.systemPromptRole}
Return a JSON array of idea objects ONLY — no prose before or after. If your
client insists on markdown fences, use \`\`\`json ... \`\`\` — the importer strips them.

Each idea MUST match this shape, with these exact keys:

  {
    "title":              "string — 5 to 10 words, evocative, on-tone for the format above",
    "logline":            "string — 1 to 2 sentences, 20 to 60 words, one concrete image",
    "themes":             ["array of 2 to 4 short thematic keywords"],
    "suggested_chapters": ${exampleChapters},
    "suggested_length":   "${exampleLength}",
    "mood":               "string — 2 to 6 words describing the emotional arc, commas allowed"
  }

Rules:
- ${format.idea.guidanceText}
- Each idea should have a distinct angle / subject / emotional arc within this format's voice.
- suggested_chapters is an integer between ${chMin} and ${chMax} (format default ${exampleChapters}).
- suggested_length is ${lengthOneOf} (format default "${exampleLength}").
- Don't invent extra keys — the importer only reads the six above.
- If you're unsure about a field, leave the idea out rather than guessing.
- Honour the format's voice above. Don't bring in tropes from other genres.
${titleTemplateBlock}
Produce N ideas. (Replace N with however many you want, e.g. 10.)

Example of a valid response:

${exampleJson}
`
}

router.get('/projects/:slug/ideas/paste-prompt', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  const format = await getEffectiveFormat(req.params.slug)
  // v1.0.165+ — optional ?title_template=... to fold the title shape
  // into the copied prompt, matching the in-app generate flow.
  const titleTemplate = typeof req.query.title_template === 'string'
    ? req.query.title_template.trim()
    : ''
  res.type('text/plain').send(buildPastePrompt(format, titleTemplate))
})

/**
 * Validate a single raw row from the pasted JSON array. Returns `null` when
 * the row is valid + normalised; returns a string reason when rejected.
 * Narrow rules: hard-fail on missing title/logline or wrong types; soft-fail
 * with defaults is explicitly NOT used — the preview table exists so the
 * user notices quality issues before they're written to disk.
 */
function validatePastedIdea(raw: any, idx: number, defaultLengthMin: number = 45): { ok: true; value: {
  title: string; logline: string; themes: string[];
  suggested_chapters: number; suggested_length: string; mood: string;
} } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'row is not an object' }
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return { ok: false, reason: 'missing or empty "title"' }
  const logline = typeof raw.logline === 'string' ? raw.logline.trim() : ''
  if (!logline) return { ok: false, reason: 'missing or empty "logline"' }

  // Themes: array of 1–6 non-empty strings. Anything else is a sign the LLM
  // freestyled (e.g. nested object, comma string) — force the user to fix it
  // rather than silently accepting and hoping for the best.
  const rawThemes = raw.themes
  if (!Array.isArray(rawThemes) || rawThemes.length < 1 || rawThemes.length > 6) {
    return { ok: false, reason: '"themes" must be an array of 1–6 keywords' }
  }
  const themes = rawThemes.map((t: any) => typeof t === 'string' ? t.trim() : '').filter(Boolean)
  if (themes.length < 1) return { ok: false, reason: '"themes" array must contain at least one non-empty string' }

  // suggested_chapters: accept integer-ish values in 1..20. Anything outside
  // that window is almost certainly an LLM typo ("105" instead of "10").
  const rawChap = raw.suggested_chapters
  const chap = typeof rawChap === 'number' ? rawChap : parseFloat(rawChap)
  if (!Number.isFinite(chap) || !Number.isInteger(chap) || chap < 1 || chap > 20) {
    return { ok: false, reason: '"suggested_chapters" must be an integer between 1 and 20' }
  }

  // suggested_length: accept any string but fall back to the format's
  // defaultLengthMinutes (passed by caller) if empty — this field is
  // primarily a UI hint and not safety-critical. v1.0.102+: was hardcoded
  // '45 min'; now reads format.script.defaultLengthMinutes via the caller.
  const lenRaw = typeof raw.suggested_length === 'string' ? raw.suggested_length.trim() : ''
  const suggested_length = lenRaw || `${defaultLengthMin} min`

  const mood = typeof raw.mood === 'string' ? raw.mood.trim() : ''
  if (!mood) return { ok: false, reason: 'missing or empty "mood"' }

  void idx // reserved for future positional diagnostics
  return {
    ok: true,
    value: { title, logline, themes, suggested_chapters: chap, suggested_length, mood },
  }
}

router.post('/projects/:slug/ideas/import-paste', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const json = typeof req.body?.json === 'string' ? req.body.json : ''
  const dryRun = req.body?.dry_run === true || req.query?.dry_run === '1'
  if (!json.trim()) return res.status(400).json({ detail: 'Empty paste — paste the LLM output into the box first.' })

  let parsed: any[]
  try {
    parsed = parseIdeas(json)
  } catch (e: any) {
    // Let the frontend render this verbatim — the whole paste failed, not a
    // specific row, so we can't populate rejected[] here.
    return res.status(400).json({ detail: `Could not parse pasted text: ${e.message}` })
  }
  if (!Array.isArray(parsed)) {
    return res.status(400).json({ detail: 'Pasted JSON must be an array of idea objects' })
  }

  // v1.0.102+ — pull the format's default length to use as the
  // fallback for any pasted idea that's missing `suggested_length`.
  // Previously hardcoded '45 min' (sleep-story). For a broll-narration
  // / prayer project this would now be `10 min`.
  const effectiveFormat = await getEffectiveFormat(slug)
  const formatDefaultLengthMin =
    effectiveFormat?.script?.defaultLengthMinutes && effectiveFormat.script.defaultLengthMinutes > 0
      ? effectiveFormat.script.defaultLengthMinutes
      : 45

  const valid: Array<{ title: string; logline: string; themes: string[];
                       suggested_chapters: number; suggested_length: string; mood: string }> = []
  const rejected: Array<{ index: number; reason: string; raw: any }> = []
  for (let i = 0; i < parsed.length; i++) {
    const check = validatePastedIdea(parsed[i], i, formatDefaultLengthMin)
    if (check.ok) valid.push(check.value)
    else rejected.push({ index: i, reason: check.reason, raw: parsed[i] })
  }

  if (dryRun) {
    // Preview mode — the UI shows the split so the user can decide. NO writes
    // to ideas.json; nothing persists until they submit without dry_run.
    return res.json({ valid, rejected, imported: 0 })
  }

  if (valid.length === 0) {
    return res.status(400).json({
      detail: 'No valid ideas to import — every row was rejected.',
      rejected,
    })
  }

  // Re-use the same addIdeas() that the AI generator uses, so the batch_id
  // / model_used / status fields line up with what the rest of the UI expects.
  const stored = await im.addIdeas(slug, valid, 'paste-import')
  await trackGeneration(slug, 'ideas', stored.length)
  res.json({ valid: stored, rejected, imported: stored.length })
})

// ── Get all ideas (with optional filter) ────────────────────────────────────

router.get('/projects/:slug/ideas', async (req, res) => {
  const filter = req.query.status as im.IdeaStatus | undefined
  const ideas = await im.getIdeas(req.params.slug, filter)
  const nextNum = await im.getNextEpisodeNumber(req.params.slug)
  const meta = await pm.getProject(req.params.slug)
  res.json({
    ideas,
    next_episode_number: nextNum,
    episode_prefix: meta?.episode_prefix || 'EP',
  })
})

// ── Add a single idea manually ──────────────────────────────────────────────

router.post('/projects/:slug/ideas', async (req, res) => {
  const { slug } = req.params
  const body = req.body || {}
  if (!body.title || typeof body.title !== 'string') {
    return res.status(400).json({ detail: 'title is required' })
  }
  try {
    const [stored] = await im.addIdeas(slug, [{
      title: String(body.title).trim(),
      logline: typeof body.logline === 'string' ? body.logline : '',
      themes: Array.isArray(body.themes) ? body.themes : [],
      suggested_chapters: Number(body.suggested_chapters) || 10,
      suggested_length: typeof body.suggested_length === 'string' ? body.suggested_length : '45 min',
      mood: typeof body.mood === 'string' ? body.mood : '',
    }], 'manual')
    res.json(stored)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to add idea'))
  }
})

// ── Inspect + Import an episode folder ──────────────────────────────────────

router.post('/projects/:slug/episodes/inspect', async (req, res) => {
  const { slug } = req.params
  const src = typeof req.body?.source_path === 'string' ? req.body.source_path : ''
  if (!src) return res.status(400).json({ detail: 'source_path required' })
  const ei = await import('../services/episode-import.js')
  const result = await ei.inspectEpisodeFolder(slug, src)
  res.json(result)
})

router.post('/projects/:slug/episodes/import', async (req, res) => {
  const { slug } = req.params
  const src = typeof req.body?.source_path === 'string' ? req.body.source_path : ''
  if (!src) return res.status(400).json({ detail: 'source_path required' })
  try {
    const ei = await import('../services/episode-import.js')
    const result = await ei.importEpisodeFolder(slug, {
      source_path: src,
      copy_into_project: req.body?.copy_into_project !== false, // default true (copy)
      // Optional: user picked between "keep original code" and "use next
      // available". Validation lives in importEpisodeFolder so the route
      // stays thin — it'll throw a clear error on an invalid choice.
      override_code: typeof req.body?.override_code === 'string' && req.body.override_code
        ? req.body.override_code
        : undefined,
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Import failed'))
  }
})

// ── Edit an idea ────────────────────────────────────────────────────────────

router.patch('/projects/:slug/ideas/:ideaId', async (req, res) => {
  const { slug, ideaId } = req.params
  try {
    // Capture the OLD title before mutating so we can sync the folder
    // afterwards. Only the accepted-idea (episode_code present) case
    // needs disk work — unaccepted ideas have no folder yet.
    const before = (await im.getIdeas(slug)).find(i => i.id === ideaId) || null
    const oldTitle = before?.title || ''
    const episodeCode = before?.episode_code || null

    const updated = await im.updateIdea(slug, ideaId, req.body || {})
    if (!updated) return res.status(404).json({ detail: 'Idea not found' })

    // Title-driven folder sync. Runs ONLY when:
    //   - the idea is accepted (has an episode_code)
    //   - the title actually changed
    // Failures collected in `warnings` and reported alongside the
    // updated record so the UI can surface them, but the PATCH itself
    // succeeds because the JSON record is the source of truth.
    let folder_sync: { renamed: boolean; warnings: string[] } | null = null
    if (episodeCode && oldTitle !== updated.title) {
      try {
        const { renameEpisodeFolderForTitleChange } = await import('../services/episode-folder-title-sync.js')
        const result = await renameEpisodeFolderForTitleChange(slug, episodeCode, oldTitle, updated.title)
        folder_sync = { renamed: result.renamed, warnings: result.warnings }
      } catch (e: any) {
        folder_sync = { renamed: false, warnings: [`Folder sync errored: ${e?.message || String(e)}`] }
      }
    }

    res.json({ ...updated, folder_sync })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update idea'))
  }
})

// ── Mark-done + status overrides (Part 4 of mark-done plan) ──────────────
//
// These endpoints flip the new optional fields on a StoredIdea and
// invalidate the episode-status cache so the next pipeline read reflects
// the change without waiting for an mtime bump on disk. Single-episode
// routes are PATCH (idempotent partial mutation); bulk routes are POST
// (multi-record action).

router.patch('/projects/:slug/episodes/:code/mark-done', async (req, res) => {
  const { slug, code } = req.params
  const done = req.body?.done
  if (typeof done !== 'boolean') {
    return res.status(400).json({ detail: 'body.done must be a boolean' })
  }
  try {
    const updated = await im.markEpisodeDone(slug, code, done)
    if (!updated) return res.status(404).json({ detail: `No accepted idea matches episode '${code}'` })
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, code)
    res.json({ ok: true, episode_code: code, marked_done: updated.marked_done, marked_done_at: updated.marked_done_at })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to mark episode'))
  }
})

router.patch('/projects/:slug/episodes/:code/status-overrides', async (req, res) => {
  const { slug, code } = req.params
  // Accept `{ overrides: null }` to clear, or `{ overrides: { audio: true, ... } }`
  // to replace. Anything else is a 400.
  const overrides = req.body?.overrides
  if (overrides !== null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
    return res.status(400).json({ detail: 'body.overrides must be an object or null' })
  }
  try {
    const updated = await im.setEpisodeStatusOverrides(slug, code, overrides as Record<string, boolean> | null)
    if (!updated) return res.status(404).json({ detail: `No accepted idea matches episode '${code}'` })
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, code)
    res.json({ ok: true, episode_code: code, status_overrides: updated.status_overrides ?? null })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update status overrides'))
  }
})

router.post('/projects/:slug/episodes/bulk-mark-done', async (req, res) => {
  const { slug } = req.params
  const { episode_codes, done } = req.body || {}
  if (!Array.isArray(episode_codes) || !episode_codes.every(c => typeof c === 'string' && c)) {
    return res.status(400).json({ detail: 'body.episode_codes must be a non-empty string array' })
  }
  if (typeof done !== 'boolean') {
    return res.status(400).json({ detail: 'body.done must be a boolean' })
  }
  try {
    const result = await im.bulkMarkDone(slug, episode_codes, done)
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    // Bulk hits enough entries that targeted invalidation is overkill — wipe
    // the project's cache entries in one call.
    episodeStatusCache.invalidateProject(slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Bulk mark-done failed'))
  }
})

router.post('/projects/:slug/episodes/bulk-mark-done-by-source', async (req, res) => {
  const { slug } = req.params
  const { source, done } = req.body || {}
  if (source !== 'imported') {
    return res.status(400).json({ detail: "body.source must be 'imported' (only supported value)" })
  }
  if (typeof done !== 'boolean') {
    return res.status(400).json({ detail: 'body.done must be a boolean' })
  }
  try {
    const result = await im.bulkMarkDoneBySource(slug, source, done)
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidateProject(slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Bulk mark-done-by-source failed'))
  }
})

// ── Get accepted episodes with folder status (for Scripts/Image Prompts dropdowns) ──

// v1.0.337 — in-flight coalescing for the plain (no-param) list request.
// Several generator pages mount at once and each fires GET /episodes; on a
// 200–300 episode project every uncoalesced call repeats the full status
// sweep. Identical concurrent plain requests now share ONE computation.
// Requests carrying refresh/rescan/invalidate params are deliberate cache
// actions and always run on their own.
const inflightEpisodeLists = new Map<string, Promise<any[] | null>>()

router.get('/projects/:slug/episodes', async (req, res) => {
  const { slug } = req.params

  const { episodeStatusCache } = await import('../services/episode-status-cache.js')

  // Optional `?refresh=1` clears this project's cache before computing.
  // Used by manual "refresh" actions in the UI when you want to force a
  // re-stat of every watched folder (mtime check normally catches changes,
  // so this is belt-and-suspenders only).
  if (req.query.refresh === '1') {
    episodeStatusCache.invalidateProject(slug)
  }
  // `?rescan=1` is the "Rescan from disk" escape hatch — wipes the
  // on-disk cache file too, so the next pass cannot serve a stale
  // hydrated entry. Useful after an iCloud sync arrives if the watcher
  // missed it for any reason.
  if (req.query.rescan === '1') {
    await episodeStatusCache.wipeProject(slug)
  }
  // `?invalidate=CODE` is the surgical version of refresh — drops just
  // ONE episode's cache entry so the page that's actively reading that
  // episode's status gets a fresh recompute, without paying the recompute
  // cost for every other episode in the project. Used by useEpisodeStatus
  // on every page mount so generator pages always reflect current disk
  // state for the selected episode (catches iCloud-flaky mtime cases).
  const invalidateCode = typeof req.query.invalidate === 'string' ? req.query.invalidate.trim() : ''
  if (invalidateCode) {
    episodeStatusCache.invalidate(slug, invalidateCode)
  }

  const isPlain = req.query.refresh !== '1' && req.query.rescan !== '1' && !invalidateCode
  if (isPlain) {
    const existing = inflightEpisodeLists.get(slug)
    if (existing) {
      const rows = await existing
      if (rows === null) return res.status(404).json({ detail: 'Project not found' })
      return res.json(rows)
    }
    const p = computeEpisodeRows(slug)
    inflightEpisodeLists.set(slug, p)
    try {
      const rows = await p
      if (rows === null) return res.status(404).json({ detail: 'Project not found' })
      return res.json(rows)
    } finally {
      inflightEpisodeLists.delete(slug)
    }
  }

  const rows = await computeEpisodeRows(slug)
  if (rows === null) return res.status(404).json({ detail: 'Project not found' })
  res.json(rows)
})

/** Returns the episode rows, or null when the project doesn't exist. */
async function computeEpisodeRows(slug: string): Promise<any[] | null> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return null
  // Re-bind to a `string` local so TS narrowing survives the async closures
  // below (buildRow captures this via the outer scope).
  const root: string = outputRoot

  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  const { getEffectiveFormat } = await import('../services/format-loader.js')
  const effectiveFormat = await getEffectiveFormat(slug)
  const visualSource = effectiveFormat.visualSource || 'narrated-scenes'
  const needsScenePlan = visualSource !== 'broll' && visualSource !== 'image-pool'
  const needsBrollPick = visualSource === 'broll'

  // v1.0.337 — ONE tree walk builds a code→dir index shared by every row
  // (vs. the old per-episode recursive findDir that re-walked the whole
  // project per episode). v1.0.338 — moved to the shared folder-resolver.
  const { buildEpisodeDirIndex } = await import('../lib/folder-resolver.js')
  const codes = new Set<string>(ideas.map((i: any) => i.episode_code).filter(Boolean))
  const dirIndex = await buildEpisodeDirIndex(root, codes)

  // Source-doc checks (script / prompts / metadata) stay as cheap file-ext
  // scans — they're "is the input artifact present?" questions where a file
  // either exists or doesn't. Asset-completion checks (audio/images/video/
  // merged) go through the authoritative helpers so partial generations are
  // correctly reported as NOT done. That fixes the bidirectional filter bug
  // (done episodes showing as pending and vice-versa).
  async function buildRow(idea: any): Promise<any | null> {
    if (!idea.episode_code) return null
    const code = idea.episode_code

    // Resolve the episode directory purely for the response's episode_dir
    // field — the status computation now lives in services/asset-status.ts
    // so buildRow and run-batch agree on every boolean.
    const episodeDir = dirIndex.get(code) || ''

    // Pass `ideas` so the underlying compute skips its internal ideas.json
    // load — at 150+ episodes this used to do 2 reloads/parses per call,
    // which the route's per-episode loop multiplied across the batch.
    // One read, one parse, total — for the whole list response. The cache
    // layer further short-circuits the whole compute when watched-folder
    // mtimes are unchanged (the common case during navigation).
    const status = await episodeStatusCache.get(slug, code, ideas)
    const {
      research: researchDone,
      scene_plan: scenePlanDone,
      scene_review: sceneReviewDone,
      motion_review: motionReviewDone,
      character_sheet: characterSheetDone,
      broll_picked: brollPickedDone,
      script: scriptDone,
      introduction: introductionDone,
      scene_prompts: scenePromptsDone,
      thumb_prompts: thumbPromptsDone,
      metadata: metadataDone,
      images: imagesDone,
      thumbnails: thumbsDone,
      audio: audioDone,
      merged_audio: mergedAudioDone,
      subtitles: subtitlesDone,
      video: videoDone,
      video_assembly: videoAssemblyDone,
    } = status
    // v1.0.760 — the per-project Research gate, as resolved by asset-status for
    // THIS episode. Read off the status rather than re-reading project.json per
    // row: one authoritative resolution, no chance of the row and the board
    // disagreeing.
    const researchRequired = status.research_required === true
    // Publish every current and future EpisodeStatus field by default. This
    // prevents a newly-added workflow step from being computed correctly in
    // asset-status but silently disappearing when this route rebuilds status.
    const { _unreliable: _internalStatusFlag, ...publicStatus } = status

    return {
      // v1.0.70: idea.id surfaced so the Scripts page can PATCH back
      // (e.g. the "Sync title to N chapters" action). Older clients
      // ignore unknown fields so this is back-compat-safe.
      idea_id: idea.id,
      episode_code: code,
      title: idea.title,
      logline: idea.logline,
      suggested_chapters: idea.suggested_chapters,
      suggested_length: idea.suggested_length,
      mood: idea.mood,
      themes: idea.themes,
      series_formula_id: idea.series_formula_id,
      topic_pack_ids: idea.topic_pack_ids,
      idea_dimensions: idea.idea_dimensions,
      episode_profile: idea.idea_dimensions?.['episode-profile'],
      // Provenance + per-episode override surface — needed by the
      // Pipeline + Ideas UI to render the "manual" pill, drive the
      // Source filter, and target the bulk-mark-done banner. Defaults
      // are intentionally omitted (undefined) so existing consumers see
      // exactly today's shape unless they opt in.
      batch_id: idea.batch_id,
      marked_done: idea.marked_done === true,
      marked_done_at: idea.marked_done_at || null,
      status_overrides: idea.status_overrides || null,
      // ── Asset-readiness contract (single source of truth for UI gating) ──
      // Every consumer reads from these fields; nothing else should infer
      // "is X generated?" from preview signals or local refs. Each field's
      // semantics:
      //   script         — chapters docx exists in the script folder (excludes the *_Introduction.docx file).
      //   introduction   — *_Introduction.docx exists in the script folder.
      //   scene_prompts  — at least one .docx/.json in the Scene Prompts folder.
      //   thumb_prompts  — at least one .docx/.json in the Thumbnail Prompts folder.
      //   prompts        — DEPRECATED ALIAS of scene_prompts (kept for old consumers).
      //   images         — every expected scene image present on disk (≥1 variant per scene).
      //   thumbnails     — every expected thumbnail present (≥1 variant per number).
      //   audio          — every required audio chunk on disk (per audio-reconciler).
      //   merged_audio   — at least one merged_audio.mp3 with content.
      //   video          — every per-scene AI clip present (input to assembly).
      //   video_assembly — final assembled video on disk anywhere (project
      //                    tree OR external_final_video_root).
      //   video_ready    — derivable: images && merged_audio && !video.
      //   publishable    — derivable: images && thumbnails && merged_audio &&
      //                    final video on disk. NOTE: uses video_assembly
      //                    (the OUTPUT of the pipeline) not video (per-scene
      //                    clips, an OPTIONAL input). Sleep-story episodes
      //                    are assembled directly from still images and
      //                    never have per-scene AI clips, so keying off
      //                    `video` would falsely mark them not publishable
      //                    even with a finished render on disk.
      //   metadata       — at least one metadata file (.txt/.json/.md) in the metadata folder.
      //   all_done       — every primary asset present (output, not inputs).
      status: {
        ...publicStatus,
        // v1.0.246 — research was computed upstream (asset-status) but dropped
        // by this destructure/re-assembly, so the Research page's "Pending
        // only" filter (filter-field="research") read undefined and never
        // excluded finished episodes. Surfaced now.
        research: researchDone,
        // v1.0.279 — scene_plan / scene_review were computed upstream but
        // dropped by this re-assembly (same class as the v1.0.246 research bug),
        // so the Scene Plan / Scene Review "Pending only" filters read undefined
        // and never excluded finished episodes. Surfaced now.
        scene_plan: scenePlanDone,
        scene_review: sceneReviewDone,
        // Optional image-to-video review. Surfaced even when false so manual
        // overrides, Pipeline chips and Production Board share one contract.
        motion_review: motionReviewDone,
        // v1.0.361 — surfaced so the Character Sheet page filters its pending
        // list by "continuity config saved" instead of borrowing `script`.
        character_sheet: characterSheetDone,
        // v1.0.362 — B-Roll page filters by "selection picked" instead of `video`.
        broll_picked: brollPickedDone,
        script: scriptDone,
        introduction: introductionDone,
        prompts: scenePromptsDone,           // backward compat
        scene_prompts: scenePromptsDone,
        thumb_prompts: thumbPromptsDone,
        images: imagesDone,
        thumbnails: thumbsDone,
        audio: audioDone,
        merged_audio: mergedAudioDone,
        // v1.0.352 — surfaced so the Subtitles page's "Pending only" filter can
        // key off real subtitle presence instead of borrowing `audio` (which
        // hid audio-ready episodes that still needed subtitles).
        subtitles: subtitlesDone,
        video: videoDone,
        // Added 2026-04-24: was silently dropped by buildRow's destructure so
        // pipeline.vue saw `undefined` and always reported video_assembly as
        // missing, even after the broader disk detection landed.
        video_assembly: videoAssemblyDone,
        video_ready: (needsScenePlan ? sceneReviewDone : (needsBrollPick ? brollPickedDone : true))
          && mergedAudioDone && !videoAssemblyDone,
        publishable: thumbsDone && mergedAudioDone && videoAssemblyDone,
        metadata: metadataDone,
        // v1.0.760 — research participates in all_done ONLY when this project
        // requires it (project.json `research_required`, resolved explicitly in
        // lib/research-verification.ts). Gate OFF → the term is inert and
        // completion is byte-for-byte what it was before the gate shipped.
        // Gate ON → `researchDone` is already the "evidence AND verified" rule
        // from asset-status, so generated-but-unverified research blocks here
        // exactly as it does in the Research pending filter.
        all_done: scriptDone && thumbPromptsDone && thumbsDone
          && audioDone && metadataDone && mergedAudioDone && subtitlesDone
          && (!researchRequired || researchDone)
          && (!needsScenePlan || (scenePlanDone && sceneReviewDone))
          && (!needsBrollPick || brollPickedDone)
          && videoAssemblyDone,
      },
      episode_dir: episodeDir,
    }
  }

  // Bounded per-episode concurrency — each row does 4 helper calls that
  // each parse a docx + scan a folder. 8 in flight keeps the endpoint
  // snappy without swamping disk I/O on large projects.
  const CONCURRENCY = 8
  const results: any[] = new Array(ideas.length)
  let cursor = 0
  async function worker() {
    while (cursor < ideas.length) {
      const i = cursor++
      results[i] = await buildRow(ideas[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ideas.length) }, worker))

  return results.filter(Boolean)
}

// ── Single-episode status (v1.0.299) ────────────────────────────────────────
// The generator-page gates (useEpisodeStatus) only ever need ONE episode's
// status, but were fetching the WHOLE /episodes list above — which recomputes
// status for every accepted idea. On a 384-episode project that's tens of
// seconds cache-warm (each row does a recursive folder walk) and minutes cold,
// so the gate sat stuck on "Checking script status…" indefinitely and the
// Generate buttons never unlocked. This computes JUST the requested episode
// (~600ms cold, far less warm). `?invalidate=1` drops that one episode's cache
// entry first — the same surgical refresh the list route's `?invalidate=CODE`
// did, scoped to a single episode.
router.get('/projects/:slug/episodes/:code/status', async (req, res) => {
  const { slug, code } = req.params
  try {
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    if (req.query.invalidate === '1' || req.query.invalidate === 'true') {
      episodeStatusCache.invalidate(slug, code)
    }
    // Load accepted ideas once (cheap — ~100ms) so we can (a) return the
    // canonical title the gate displays and (b) hand the array to the cache
    // so it skips its own internal ideas.json read.
    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '').toUpperCase() === code.toUpperCase())
    const status = await episodeStatusCache.get(slug, code, ideas)
    res.json({
      episode_code: code,
      title: idea?.title || '',
      idea_id: idea?.id,
      // Raw EpisodeStatus (script/scene_prompts/thumb_prompts/metadata/…) plus
      // the `prompts` back-compat alias the list route exposes, so consumers
      // reading either name keep working.
      status: { ...status, prompts: (status as any).scene_prompts },
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, `Could not load status for ${code}`))
  }
})

// ── Accept idea (create folders) ────────────────────────────────────────────

router.post('/projects/:slug/ideas/:ideaId/accept', async (req, res) => {
  try {
    // override_code is optional. When supplied, acceptIdea validates
    // prefix + uniqueness and returns a clear error string the route
    // surfaces as 400 rather than the generic 500.
    const override = typeof req.body?.override_code === 'string' && req.body.override_code
      ? String(req.body.override_code).trim()
      : undefined
    const result = await im.acceptIdea(
      req.params.slug,
      req.params.ideaId,
      false,
      override ? { override_code: override } : undefined,
    )

    // If auto_generate_script is true, queue script generation
    if (req.body?.auto_generate_script && req.body?.model) {
      const config = await pm.getConfig(req.params.slug)
      if (config?.anthropic_api_key || config?.openai_api_key || config?.kie_api_key) {
        jq.enqueue({
          project_slug: req.params.slug,
          // M1: legacy 'script' job type was removed. Auto-script-on-accept
          // now enqueues 'script-only' (chapters). Intro is opt-in per the
          // architecture rule and isn't auto-queued from the ideas accept
          // flow — users add it via the script page or the pipeline batch.
          type: 'script-only',
          episode_id: result.episode_code,
          title: result.idea.title,
          params: {
            episode_id: result.episode_code,
            title: result.idea.title,
            length: result.idea.suggested_length === '60 min' ? 60 : 45,
            model: req.body.model,
            style: 'auto',
            chapters: result.idea.suggested_chapters,
            generate_image_prompts: true,
            generate_youtube_desc: true,
          },
        })
      }
    }

    invalidateProjectUploadCaches(req.params.slug)
    res.json(result)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Failed to accept idea'))
  }
})

// ── Renumber an already-accepted episode ───────────────────────────────────
//
// Single-episode equivalent of the bulk orphan renumber. Use case: user
// imported episodes out of order and wants to renumber TN0005 → TN0099
// to match their channel's sequence. Cascades: folder rename + per-asset
// file rename + episode_info.json update + ideas.json patch + cache
// invalidation. Errors during the cascade are reported as `warnings`
// rather than failing the request, so a half-rename still returns a
// useful state for the UI to show.
router.post('/projects/:slug/episodes/:code/renumber', async (req, res) => {
  try {
    const { slug, code } = req.params
    const newCode = typeof req.body?.new_code === 'string' ? req.body.new_code.trim() : ''
    if (!newCode) {
      return res.status(400).json({ detail: 'new_code is required' })
    }
    const { renameAcceptedEpisode } = await import('../services/episode-renumber.js')
    const result = await renameAcceptedEpisode(slug, code, newCode)
    res.json(result)
  } catch (e: any) {
    // Service throws with statusCode=409 on collision; default to 400
    // for shape errors and 500 for unexpected fs failures.
    const status = e?.statusCode === 409 ? 409
      : /not found|must start with prefix|positive integer|same as old_code|already exists/i.test(e?.message || '')
        ? 400
        : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to renumber episode'))
  }
})

// ── Batch accept ────────────────────────────────────────────────────────────

router.post('/projects/:slug/ideas/batch-accept', async (req, res) => {
  const { idea_ids } = req.body
  if (!Array.isArray(idea_ids) || !idea_ids.length) {
    return res.status(400).json({ detail: 'idea_ids array required' })
  }
  try {
    const results = await im.acceptMultipleIdeas(req.params.slug, idea_ids)
    invalidateProjectUploadCaches(req.params.slug)
    res.json(results)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Batch accept failed'))
  }
})

// ── Dismiss idea ────────────────────────────────────────────────────────────

router.post('/projects/:slug/ideas/:ideaId/dismiss', async (req, res) => {
  if (!await im.dismissIdea(req.params.slug, req.params.ideaId)) {
    return res.status(404).json({ detail: 'Idea not found' })
  }
  // Bust the missing-video + queue caches so the next read reflects the
  // dismissal immediately. Without this, ↻ Refresh on the Missing Video
  // tab would keep returning the cached pre-dismiss list for up to 5
  // minutes — which surfaces as "the dismissed episode is still there
  // and Refresh isn't doing anything" (reported 2026-05-04).
  invalidateProjectUploadCaches(req.params.slug)
  res.json({ ok: true })
})

// ── Reset accepted idea (delete folder, recycle number) ─────────────────────

router.get('/projects/:slug/ideas/:ideaId/reset-preview', async (req, res) => {
  try {
    const preview = await im.previewIdeaReset(req.params.slug, req.params.ideaId)
    res.json(preview)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Reset preview failed'))
  }
})

router.post('/projects/:slug/ideas/:ideaId/reset', async (req, res) => {
  try {
    const result = await im.resetIdea(req.params.slug, req.params.ideaId)
    invalidateProjectUploadCaches(req.params.slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Reset failed'))
  }
})

// ── Delete episode folder by code (from Jobs page) ─────────────────────────

router.delete('/projects/:slug/episodes/:episodeCode', async (req, res) => {
  try {
    const result = await im.deleteEpisodeFolder(req.params.slug, req.params.episodeCode)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Delete failed'))
  }
})

// ── Manually tag/check an episode folder ────────────────────────────────────

router.post('/projects/:slug/episodes/:episodeCode/check-status', async (req, res) => {
  const { slug, episodeCode } = req.params

  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return res.status(404).json({ detail: 'Project not found' })

  res.json({ detail: 'Status check completed (tagging removed)' })
})

// ── Migrate old episodes to new folder structure ────────────────────────────

router.post('/projects/:slug/episodes/migrate', async (req, res) => {
  const { slug } = req.params
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })

  const fsP = await import('fs/promises')
  const { existsSync, cpSync } = await import('fs')
  const pathMod = await import('path')

  const results: Array<{ episode: string; actions: string[] }> = []

  // Recursively find all episode folders. Capped depth so a malformed
  // / accidentally-symlinked tree can't hang the request indefinitely —
  // matches the safety pattern dashboard-stats uses.
  const FIND_EPISODES_DEPTH_LIMIT = 8
  async function findEpisodeDirs(dir: string, depth = 0): Promise<string[]> {
    if (depth > FIND_EPISODES_DEPTH_LIMIT) return []
    const dirs: string[] = []
    try {
      const entries = await fsP.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const fp = pathMod.join(dir, entry.name)
        const clean = entry.name
        // Episode folders match "CODE - Title" pattern
        if (/^[A-Z]{2,}\d{2,} - /.test(clean)) {
          dirs.push(fp)
        } else {
          // Search inside any subfolder (Season, Batch, Volume, episodes, etc.)
          dirs.push(...await findEpisodeDirs(fp, depth + 1))
        }
      }
    } catch {}
    return dirs
  }

  const episodeDirs = await findEpisodeDirs(outputRoot)

  // Pre-batch the per-episode config-derived subfolder names so the loop
  // below doesn't re-read project config N times. resolveSubfolderNames
  // is pure config lookup; running them in parallel collapses the chain.
  const subfolderNamesByCode = new Map<string, Awaited<ReturnType<typeof resolveSubfolderNames>>>()
  await Promise.all(episodeDirs.map(async (epDir) => {
    const dirName = pathMod.basename(epDir)
    const m = dirName.match(/^([A-Z]{2}\d{3,})/)
    if (!m) return
    const code = m[1]
    if (subfolderNamesByCode.has(code)) return
    subfolderNamesByCode.set(code, await resolveSubfolderNames(slug, code))
  }))

  for (const epDir of episodeDirs) {
    const dirName = pathMod.basename(epDir)
    const codeMatch = dirName.match(/^([A-Z]{2}\d{3,})/)
    if (!codeMatch) continue
    const code = codeMatch[1]
    const actions: string[] = []

    const subs = await fsP.readdir(epDir)
    const cleanSubs = subs.map(s => ({ original: s, clean: s }))

    // Resolve configured subfolder names for this episode (pre-batched above)
    const names = subfolderNamesByCode.get(code) || await resolveSubfolderNames(slug, code)

    // 1. Create separate prompt folders if missing (migrate from combined Image Prompts)
    const hasScenePromptsFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('scene prompt'))
    const hasThumbPromptsFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('thumbnail prompt'))
    const oldPromptsFolder = cleanSubs.find(s => s.clean.toLowerCase().includes('image prompt'))

    if (!hasScenePromptsFolder) {
      const sceneDir = pathMod.join(epDir, names.scene_prompts)
      await fsP.mkdir(sceneDir, { recursive: true })
      actions.push('Created Scene Prompts folder')

      // Copy scene prompts from old Image Prompts or Script folder
      if (oldPromptsFolder) {
        try {
          const files = await fsP.readdir(pathMod.join(epDir, oldPromptsFolder.original))
          const sceneFile = files.find(f => f.toLowerCase().includes('scene') && f.endsWith('.docx'))
            || files.find(f => f.toLowerCase().includes('image_prompts') && f.endsWith('.docx'))
          if (sceneFile) {
            await fsP.copyFile(pathMod.join(epDir, oldPromptsFolder.original, sceneFile), pathMod.join(sceneDir, `${code}_Scene_Prompts.docx`))
            actions.push(`Copied scene prompts to Scene Prompts folder`)
          }
        } catch {}
      }
    }

    if (!hasThumbPromptsFolder) {
      const thumbDir = pathMod.join(epDir, names.thumb_prompts)
      await fsP.mkdir(thumbDir, { recursive: true })
      actions.push('Created Thumbnail Prompts folder')

      // Copy thumb prompts from old Image Prompts folder
      if (oldPromptsFolder) {
        try {
          const files = await fsP.readdir(pathMod.join(epDir, oldPromptsFolder.original))
          const thumbFile = files.find(f => f.toLowerCase().includes('thumb') && f.endsWith('.docx'))
            || files.find(f => f.toLowerCase().includes('image_prompts') && f.endsWith('.docx'))
          if (thumbFile) {
            await fsP.copyFile(pathMod.join(epDir, oldPromptsFolder.original, thumbFile), pathMod.join(thumbDir, `${code}_Thumbnail_Prompts.docx`))
            actions.push(`Copied thumbnail prompts to Thumbnail Prompts folder`)
          }
        } catch {}
      }
    }

    // 2. Create Metadata folder if missing
    const hasMetadataFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('metadata'))
    if (!hasMetadataFolder) {
      const metaDir = pathMod.join(epDir, names.metadata)
      await fsP.mkdir(metaDir, { recursive: true })
      actions.push('Created Metadata folder')

      // Move legacy YouTube description txt if it sits in the Script folder
      const scriptFolder = cleanSubs.find(s => s.clean.toLowerCase().includes('script') && !s.clean.toLowerCase().includes('prompt'))
      if (scriptFolder) {
        const scriptPath = pathMod.join(epDir, scriptFolder.original)
        try {
          const scriptFiles = await fsP.readdir(scriptPath)
          const descFile = scriptFiles.find(f => f.toLowerCase().includes('youtube') && f.endsWith('.txt'))
          if (descFile) {
            await fsP.copyFile(pathMod.join(scriptPath, descFile), pathMod.join(metaDir, descFile))
            actions.push(`Copied ${descFile} to Metadata folder`)
          }
        } catch {}
      }
    }

    // 3. Create Video folder if missing
    // v1.0.469 — exclude "Video Assets" (folder 11) from this loose match, else
    // an episode that only has the assets folder would skip creating "10 Video
    // Assembly Output".
    const hasVideoFolder = cleanSubs.some(s => {
      const n = s.clean.toLowerCase()
      return n.includes('video') && !n.includes('video assets')
    })
    if (!hasVideoFolder) {
      await fsP.mkdir(pathMod.join(epDir, names.video), { recursive: true })
      actions.push('Created Video folder')
    }

    // 4. Create Audio Merge (08) + Subtitles (09) folders if missing — these
    //    used to be created lazily only when those steps ran; scaffold them so
    //    every stage's folder is visible up-front like the rest.
    const hasMergedAudioFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('audio merge'))
    if (!hasMergedAudioFolder) {
      await fsP.mkdir(pathMod.join(epDir, names.merged_audio), { recursive: true })
      actions.push('Created Audio Merge Output folder')
    }
    const hasSubtitlesFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('subtitle'))
    if (!hasSubtitlesFolder) {
      await fsP.mkdir(pathMod.join(epDir, names.subtitles), { recursive: true })
      actions.push('Created Subtitles Output folder')
    }
    // v1.0.469 — Video Assets (11): per-scene image-to-video clips (Phase 2 of
    //    the motion-prompt feature). Scaffolded up-front like the rest.
    const hasVideoAssetsFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('video assets'))
    if (!hasVideoAssetsFolder) {
      await fsP.mkdir(pathMod.join(epDir, names.video_assets), { recursive: true })
      actions.push('Created Video Assets folder')
    }

    if (actions.length > 0) {
      results.push({ episode: code, actions })
    }
  }

  res.json({
    migrated: results.length,
    episodes: results,
  })
})

// ── Sync folders: fix all folder issues at once ─────────────────────────────

router.post('/projects/:slug/sync-folders', async (req, res) => {
  const { slug } = req.params
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })

  const meta = await pm.getProject(slug)
  if (!meta) return res.status(404).json({ detail: 'Project not found' })

  const fsP = await import('fs/promises')
  const { existsSync } = await import('fs')
  const pathMod = await import('path')
  const actions: string[] = []

  // 1. Find all episode folders. Capped depth so a malformed /
  // accidentally-symlinked tree can't hang the request indefinitely.
  const FIND_EPISODES_DEPTH_LIMIT = 8
  async function findEpisodeDirs(dir: string, depth = 0): Promise<string[]> {
    if (depth > FIND_EPISODES_DEPTH_LIMIT) return []
    const dirs: string[] = []
    try {
      const entries = await fsP.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const fp = pathMod.join(dir, entry.name)
        const clean = entry.name
        if (/^[A-Z]{2,}\d{2,} - /.test(clean)) {
          dirs.push(fp)
        } else {
          dirs.push(...await findEpisodeDirs(fp, depth + 1))
        }
      }
    } catch {}
    return dirs
  }

  const episodeDirs = await findEpisodeDirs(outputRoot)
  actions.push(`Found ${episodeDirs.length} episode folders`)

  // 2. For each episode: create missing folders, copy files, tag
  let foldersCreated = 0
  let foldersRenamed = 0
  let filesCopied = 0

  // Helper: move all files from one directory to another, then remove old dir
  async function mergeAndRemove(srcDir: string, destDir: string): Promise<number> {
    let moved = 0
    try {
      await fsP.mkdir(destDir, { recursive: true })
      const files = await fsP.readdir(srcDir, { withFileTypes: true })
      for (const f of files) {
        const srcPath = pathMod.join(srcDir, f.name)
        const destPath = pathMod.join(destDir, f.name)
        if (!existsSync(destPath)) {
          await fsP.rename(srcPath, destPath)
          moved++
        }
      }
      // Remove old dir if now empty
      const remaining = await fsP.readdir(srcDir)
      if (remaining.length === 0) await fsP.rmdir(srcDir)
    } catch (e: any) {
      console.warn(`[sync] mergeAndRemove failed: ${e.message}`)
    }
    return moved
  }

  // Helper: classify a subfolder name into a role by keyword
  function classifyFolder(folderName: string, code: string): string | null {
    const clean = folderName.toLowerCase()
    if (!clean.startsWith(code.toLowerCase())) return null

    // Order matters: more specific checks first
    if (clean.includes('scene prompt') || clean.includes('scene_prompt')) return 'scene_prompts'
    if (clean.includes('thumbnail prompt') || clean.includes('thumb prompt')) return 'thumb_prompts'
    if (clean.includes('image prompt')) return 'image_prompts_legacy' // old combined format
    if (clean.includes('scene image') || clean.includes('background image')) return 'images'
    if (clean.includes('thumbnail image') || (clean.includes('thumbnail') && !clean.includes('prompt'))) return 'thumbnails'
    if (clean.includes('metadata') || clean.includes('description')) return 'metadata'
    if (clean.includes('audio')) return 'audio'
    if (clean.includes('video')) return 'video'
    if (clean.includes('script')) return 'script' // check LAST — "script" is substring of others
    return null
  }

  for (const epDir of episodeDirs) {
    const dirName = pathMod.basename(epDir)
    const codeMatch = dirName.match(/^([A-Z]{2,}\d{2,})/)
    if (!codeMatch) continue
    const code = codeMatch[1]

    // Get configured folder names for this episode
    const names = await resolveSubfolderNames(slug, code)
    const targetMap: Record<string, string> = {
      script: names.script,
      metadata: names.metadata,
      scene_prompts: names.scene_prompts,
      thumb_prompts: names.thumb_prompts,
      images: names.images,
      thumbnails: names.thumbnails,
      audio: names.audio,
      video: names.video,
    }

    // Phase 1: Classify all existing subfolders by role
    const subs = await fsP.readdir(epDir)
    const roleToExisting: Record<string, string[]> = {} // role → list of folder names

    for (const sub of subs) {
      const role = classifyFolder(sub, code)
      if (!role) continue
      if (!roleToExisting[role]) roleToExisting[role] = []
      roleToExisting[role].push(sub)
    }

    // Phase 2: For each role, ensure the target folder exists with correct name
    for (const [role, targetName] of Object.entries(targetMap)) {
      const existingFolders = roleToExisting[role] || []

      // Check if target name already exists
      const targetExists = subs.some(s => s === targetName)

      if (targetExists) {
        // Target folder already has the right name — merge any OTHER old-role folders into it
        const targetEntry = subs.find(s => s === targetName)!
        const targetPath = pathMod.join(epDir, targetEntry)
        for (const old of existingFolders) {
          if (old !== targetName) {
            const moved = await mergeAndRemove(pathMod.join(epDir, old), targetPath)
            if (moved > 0) filesCopied += moved
            foldersRenamed++
          }
        }
      } else if (existingFolders.length > 0) {
        // Rename the first matching folder to the target name
        const primary = existingFolders[0]
        const newName = targetName
        const oldPath = pathMod.join(epDir, primary)
        const newPath = pathMod.join(epDir, newName)

        try {
          await fsP.rename(oldPath, newPath)
          foldersRenamed++
        } catch (e: any) {
          console.warn(`[sync] rename failed ${primary} → ${newName}: ${e.message}`)
        }

        // Merge remaining old folders into the renamed one
        for (let i = 1; i < existingFolders.length; i++) {
          const moved = await mergeAndRemove(pathMod.join(epDir, existingFolders[i]), newPath)
          if (moved > 0) filesCopied += moved
        }
      } else {
        // No existing folder for this role — create it
        await fsP.mkdir(pathMod.join(epDir, targetName), { recursive: true })
        foldersCreated++
      }
    }

    // Phase 3: Migrate files from legacy "Image Prompts" combined folder
    const legacyPromptsFolders = roleToExisting['image_prompts_legacy'] || []
    if (legacyPromptsFolders.length > 0) {
      // Re-read to get current names after renames
      const currentSubs = await fsP.readdir(epDir)

      for (const legacyFolder of legacyPromptsFolders) {
        // Skip if it was already merged/removed
        if (!existsSync(pathMod.join(epDir, legacyFolder))) continue

        try {
          const files = await fsP.readdir(pathMod.join(epDir, legacyFolder))

          // Copy scene prompts (look for scene-specific or generic image_prompts file)
          const sceneFile = files.find(f => f.toLowerCase().includes('scene') && f.endsWith('.docx'))
            || files.find(f => f.toLowerCase().includes('image_prompts') && f.endsWith('.docx'))
          if (sceneFile) {
            const sceneSub = currentSubs.find(s => s.toLowerCase().includes('scene prompt'))
            if (sceneSub) {
              const dest = pathMod.join(epDir, sceneSub, `${code}_Scene_Prompts.docx`)
              if (!existsSync(dest)) {
                await fsP.copyFile(pathMod.join(epDir, legacyFolder, sceneFile), dest)
                filesCopied++
              }
            }
          }

          // Copy thumbnail prompts
          const thumbFile = files.find(f => f.toLowerCase().includes('thumb') && f.endsWith('.docx'))
            || files.find(f => f.toLowerCase().includes('image_prompts') && f.endsWith('.docx'))
          if (thumbFile) {
            const thumbSub = currentSubs.find(s => s.toLowerCase().includes('thumbnail prompt'))
            if (thumbSub) {
              const dest = pathMod.join(epDir, thumbSub, `${code}_Thumbnail_Prompts.docx`)
              if (!existsSync(dest)) {
                await fsP.copyFile(pathMod.join(epDir, legacyFolder, thumbFile), dest)
                filesCopied++
              }
            }
          }
        } catch (e: any) {
          console.warn(`[sync] legacy prompts migration failed: ${e.message}`)
        }
      }
    }

    // Phase 4: Migrate legacy YouTube description from Script folder to Metadata folder
    const currentSubs2 = await fsP.readdir(epDir)
    const scriptSub = currentSubs2.find(s => {
      const clean = s.toLowerCase()
      return clean.includes('script') && !clean.includes('prompt') && !clean.includes('image') && clean.startsWith(code.toLowerCase())
    })
    const metaSub = currentSubs2.find(s => {
      const clean = s.toLowerCase()
      return (clean.includes('metadata') || clean.includes('description')) && clean.startsWith(code.toLowerCase())
    })

    if (scriptSub && metaSub) {
      try {
        const scriptFiles = await fsP.readdir(pathMod.join(epDir, scriptSub))
        const descFile = scriptFiles.find(f => f.toLowerCase().includes('youtube') && f.endsWith('.txt'))
        if (descFile) {
          const dest = pathMod.join(epDir, metaSub, descFile)
          if (!existsSync(dest)) {
            await fsP.copyFile(pathMod.join(epDir, scriptSub, descFile), dest)
            filesCopied++
          }
        }
      } catch (e: any) {
        console.warn(`[sync] metadata migration failed: ${e.message}`)
      }
    }

  }

  // 3. Heal recycled numbers
  const store = await im.getIdeas(slug)
  // Loading ideas triggers auto-heal

  actions.push(`Created ${foldersCreated} missing folders`)
  actions.push(`Renamed ${foldersRenamed} folders to new format`)
  actions.push(`Copied ${filesCopied} files to new locations`)
  actions.push('Episode number gaps auto-healed')

  res.json({ ok: true, actions })
})

// ── Remove idea from list ───────────────────────────────────────────────────

router.delete('/projects/:slug/ideas/:ideaId', async (req, res) => {
  if (!await im.removeIdea(req.params.slug, req.params.ideaId)) {
    return res.status(404).json({ detail: 'Idea not found' })
  }
  invalidateProjectUploadCaches(req.params.slug)
  res.json({ ok: true })
})

// ── Compact / Fill gaps (item M, v1.0.40) ───────────────────────────────────
//
// Bulk renumber-down: shift every accepted episode backward to fill the
// gaps left by removed leading ideas (TN0008+ → TN0001+). Reuses the
// v1.0.38 .renumber-undo.json infrastructure so the Revert banner on
// the Unlinked Uploads tab works unchanged.
//
// Two endpoints:
//   GET  /api/projects/:slug/episodes/compact-preview   — dry run, no writes
//   POST /api/projects/:slug/episodes/compact           — execute the plan

router.get('/projects/:slug/episodes/compact-preview', async (req, res) => {
  try {
    const preview = await previewCompact(req.params.slug)
    res.json(preview)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Compact preview failed'))
  }
})

router.post('/projects/:slug/episodes/compact', async (req, res) => {
  try {
    const result = await compactAcceptedEpisodes(req.params.slug)
    invalidateProjectUploadCaches(req.params.slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Compact failed'))
  }
})

// ── Reseason (v1.0.45) ──────────────────────────────────────────────────────
//
// Bulk-rebalance episode folders when season_size changes. Naively
// editing the value silently breaks every season-aware path
// resolution; this flow moves folders to match. Same shape as
// Compact: preview → apply → revert (with .reseason-undo.json safety
// net), banner on the Unlinked Uploads tab while undo is alive.

router.get('/projects/:slug/episodes/reseason-preview', async (req, res) => {
  try {
    const newSize = parseInt(String(req.query.new_size || ''), 10)
    if (!Number.isInteger(newSize) || newSize < 1 || newSize > 1000) {
      return res.status(400).json({ detail: 'new_size must be a positive integer ≤ 1000' })
    }
    const preview = await previewReseason(req.params.slug, newSize)
    res.json(preview)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Reseason preview failed'))
  }
})

router.post('/projects/:slug/episodes/reseason', async (req, res) => {
  try {
    const newSize = parseInt(String(req.body?.new_size || ''), 10)
    if (!Number.isInteger(newSize) || newSize < 1 || newSize > 1000) {
      return res.status(400).json({ detail: 'new_size must be a positive integer ≤ 1000' })
    }
    const result = await applyReseason(req.params.slug, newSize)
    invalidateProjectUploadCaches(req.params.slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Reseason failed'))
  }
})

router.get('/projects/:slug/episodes/reseason-undo', async (req, res) => {
  try {
    const plan = await readReseasonUndo(req.params.slug)
    if (!plan) return res.json({ available: false })
    res.json({
      available: true,
      plan,
      moves_count: plan.moves.length,
      expired: isReseasonUndoExpired(plan),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read reseason-undo sidecar'))
  }
})

router.post('/projects/:slug/episodes/reseason-undo/revert', async (req, res) => {
  try {
    const result = await revertReseason(req.params.slug)
    invalidateProjectUploadCaches(req.params.slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to revert reseason'))
  }
})

router.delete('/projects/:slug/episodes/reseason-undo', async (req, res) => {
  try {
    const deleted = await deleteReseasonUndo(req.params.slug)
    res.json({ ok: true, deleted })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to dismiss reseason-undo sidecar'))
  }
})
