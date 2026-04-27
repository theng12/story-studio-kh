/**
 * Story Idea Generator + persistence endpoints.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { trackGeneration } from '../services/session-tracker.js'
import { callAi } from '../lib/ai-client.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { SUPPORTED_MODELS, type Format, type Pattern } from '../models/types.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { loadPattern } from '../services/pattern-loader.js'
import type { GenerateIdeasRequest, StoryIdea } from '../models/types.js'
import { filterGenerated, type SimilarityCandidate } from '../services/idea-similarity.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

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
  const lines = items.slice(0, 30).map(i => {
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

function buildPrompt(
  req: GenerateIdeasRequest,
  format: Format,
  standards: string | null | undefined,
  avoid: AvoidItem[],
  extraAvoidNote?: string,
  pattern?: Pattern | null,
): string {
  const keywords = req.keywords?.length ? req.keywords.join(', ') : 'none specified'
  const standardsSection = standards
    ? `\nProduction standards (style reference, not a formula to copy):\n\n${standards.slice(0, 2000)}\n`
    : ''

  const seed = Math.random().toString(36).slice(2, 10)
  const levers = pickLevers(2)
  const leverLines = levers
    .map((l, i) => `  ${i + 1}. ${l}`)
    .join('\n')

  const avoidSection = buildAvoidSection(avoid)
  const extraAvoid = extraAvoidNote
    ? `\nAlso avoid the concepts listed here (these came back too close to existing on the last attempt): ${extraAvoidNote}\n`
    : ''

  // Format guidance — appears as a "FORMAT GUIDANCE" block so the LLM
  // anchors the genre/audience/tone before it picks settings + protagonists.
  // The format's role line ("You are helping generate new story ideas for a
  // sleep-story narration channel.") flows in here too so the LLM gets the
  // channel context even though this prompt has no system message.
  const audience = req.audience || format.idea.audienceDefault
  const formatGuidance = `${format.idea.systemPromptRole}

${format.idea.guidanceText}`

  // Pattern guidance — when the user picked a Pattern preset on the Ideas
  // page, we instruct the LLM to follow the pattern's titleTemplate +
  // tone hints. The {X} placeholder gets filled per-idea with concrete
  // values (the LLM picks them — `pattern_subject` is just a hint for
  // what KIND of value to pick).
  const patternBlock = pattern
    ? `\n⟂ TITLE STYLE (PATTERN PRESET) ⟂
Each generated idea's title MUST follow this template literally, with {X} substituted by a concrete value:

  Template: "${pattern.titleTemplate}"
  {X} represents: ${pattern.subjectLabel}${req.pattern_subject ? ` (e.g. "${req.pattern_subject}", but pick a different concrete value per idea)` : ' (pick a different concrete value per idea — never write the literal word "X")'}

Generation rules under this pattern:
- Replace {X} with a SPECIFIC concrete noun every time (a place / era / craft / object / person / system, depending on the subjectLabel).
- The {X} value should vary across the batch — don't repeat the same subject for two ideas.
- Opening hook style: ${pattern.openingDevice}
${pattern.metadataKeywordAdditions?.length
  ? `- Themes/keywords this pattern cares about: ${pattern.metadataKeywordAdditions.join(', ')} (incorporate naturally — don't keyword-stuff)`
  : ''}
`
    : ''

  return `Generate exactly ${req.count} story episode ideas for a narrative audio production.

${formatGuidance}
${patternBlock}
PARAMETERS:
- Genre: ${req.genre}
- Theme: ${req.theme || 'open / surprise me'}
- Target audience: ${audience}
- Mood/tone: ${req.mood}
- Keywords to incorporate: ${keywords}
- Creativity seed: ${seed} (ignore semantics; use only to diverge from prior output)
${standardsSection}${avoidSection}${extraAvoid}
Diversity levers — apply these two across the batch (some ideas should lean into lever 1, others into lever 2):
${leverLines}

For EACH idea, provide:
1. title — evocative, 5–10 words, no generic adjective stacking (avoid "magical/enchanted/mystical/whispering" unless essential)
2. logline — 1–2 sentences with a concrete image or specific detail; avoid describing the premise abstractly
3. themes — 2–4 thematic keywords, fresh combinations preferred
4. suggested_chapters — typically 8–12
5. suggested_length — "45 min" or "60 min"
6. mood — emotional arc in 2–4 words

RULES:
- Every idea must have a different setting, protagonist archetype, and emotional arc from the others
- Avoid recycling common tropes (clocktower keepers, lantern keepers, dream forests, ancient libraries) unless you subvert them
- No two titles may share the same noun+preposition structure (e.g. "The X of the Y" twice)
- Loglines must use specific concrete nouns, not generic ones ("a weaver of tides" > "a mysterious figure")
- Do not produce anything that overlaps the AVOID list above — treat it as a hard negative constraint

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

router.post('/projects/:slug/generate/ideas', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const body: GenerateIdeasRequest = req.body
  const provider = SUPPORTED_MODELS[body.model]

  if (provider === 'anthropic' && !config.anthropic_api_key) {
    return res.status(400).json({ detail: 'No Anthropic API key configured.' })
  }
  if (provider === 'openai' && !config.openai_api_key) {
    return res.status(400).json({ detail: 'No OpenAI API key configured.' })
  }
  if (provider === 'kie' && !config.kie_api_key) {
    return res.status(400).json({ detail: 'No kie.ai API key configured.' })
  }

  const standards = await pm.getStandards(slug)
  const format = await getEffectiveFormat(slug)

  // Optional pattern preset — when the Ideas-page picker selected one,
  // we load it here so the prompt assembler can inject the title-style
  // block. Failure to load (deleted pattern, malformed file, etc.)
  // degrades gracefully to "no pattern" rather than failing the whole
  // generation request.
  let pattern: Pattern | null = null
  if (typeof body.pattern_id === 'string' && body.pattern_id) {
    try {
      pattern = await loadPattern(body.pattern_id)
    } catch (e: any) {
      console.warn(`[ideas-gen] failed to load pattern ${body.pattern_id}: ${e?.message || e}`)
    }
  }

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

  function normalizeIdeas(raw: any[]): StoryIdea[] {
    return raw.map((item: any) => ({
      title: item.title || 'Untitled',
      logline: item.logline || '',
      themes: item.themes || [],
      suggested_chapters: item.suggested_chapters || 10,
      suggested_length: item.suggested_length || '45 min',
      mood: item.mood || '',
    }))
  }

  try {
    // Overshoot slightly so a trim after similarity filtering usually still
    // leaves us at body.count without a retry.
    const wantedCount = body.count
    const overshoot = { ...body, count: wantedCount + 3 }
    const firstPrompt = buildPrompt(overshoot, format, standards, avoid, undefined, pattern)
    const firstRaw = await callAi(body.model, '', firstPrompt, apiKeys, false, { slug })
    const firstBatch = normalizeIdeas(parseIdeas(firstRaw))

    // Filter against the project's history + within-batch dupes.
    const priorCandidates: SimilarityCandidate[] = prior.map(i => ({
      title: i.title, logline: i.logline, themes: i.themes, mood: i.mood,
    }))
    const firstPass = filterGenerated<StoryIdea>(firstBatch, priorCandidates)

    let kept = firstPass.kept.slice(0, wantedCount)

    // If filtering cost us too many, reprompt once for the shortfall with
    // the rejected titles added to the avoid list.
    if (kept.length < wantedCount) {
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
      const retryPrompt = buildPrompt(retryReq, format, standards, retryAvoid, rejectedTitles, pattern)
      try {
        const retryRaw = await callAi(body.model, '', retryPrompt, apiKeys, false, { slug })
        const retryBatch = normalizeIdeas(parseIdeas(retryRaw))
        const retryPass = filterGenerated<StoryIdea>(
          retryBatch,
          [...priorCandidates, ...kept.map(k => ({ title: k.title, logline: k.logline, themes: k.themes, mood: k.mood }))],
        )
        // Take up to shortfall from the retry's kept pool. If retry also
        // came back thin, fall back to its raw output — we never block the
        // user's click over a similarity miss.
        const retryKept = retryPass.kept.length >= shortfall
          ? retryPass.kept.slice(0, shortfall)
          : [...retryPass.kept, ...retryBatch.slice(retryPass.kept.length)].slice(0, shortfall)
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

    res.json(stored)
  } catch (e: any) {
    res.status(500).json({ detail: `AI generation failed: ${e.message}` })
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
  pattern?: Pattern | null,
  patternSubject?: string,
): string {
  const exampleJson = format.idea.exampleIdeas?.length
    ? JSON.stringify(format.idea.exampleIdeas, null, 2)
    : '[\n  // (no examples in this format — match the shape above)\n]'

  // Pattern guidance — same shape as the in-app generate flow uses
  // (see buildIdeasPrompt above) so a paste-into-ChatGPT run produces
  // ideas with the same title/opening style as a generate-in-app run.
  // Only emitted when a pattern is actually selected.
  const patternBlock = pattern
    ? `\n⟂ TITLE STYLE (PATTERN PRESET) ⟂
Each generated idea's title MUST follow this template literally, with {X} substituted by a concrete value:

  Template: "${pattern.titleTemplate}"
  {X} represents: ${pattern.subjectLabel}${patternSubject ? ` (e.g. "${patternSubject}", but pick a different concrete value per idea)` : ' (pick a different concrete value per idea — never write the literal word "X")'}

Pattern rules:
- Replace {X} with a SPECIFIC concrete noun every time (a place / era / craft / object / person / system, depending on the subjectLabel).
- The {X} value should vary across the batch — don't repeat the same subject for two ideas.
- Opening hook style for the logline: ${pattern.openingDevice}
${pattern.metadataKeywordAdditions?.length
    ? `- Themes/keywords this pattern cares about: ${pattern.metadataKeywordAdditions.join(', ')} (incorporate naturally — don't keyword-stuff)\n`
    : ''}`
    : ''

  return `${format.idea.systemPromptRole}
Return a JSON array of idea objects ONLY — no prose before or after. If your
client insists on markdown fences, use \`\`\`json ... \`\`\` — the importer strips them.

Each idea MUST match this shape, with these exact keys:

  {
    "title":              "string — 5 to 10 words, evocative, no generic 'magical/enchanted/mystical'",
    "logline":            "string — 1 to 2 sentences, 20 to 60 words, one concrete image",
    "themes":             ["array of 2 to 4 short thematic keywords"],
    "suggested_chapters": 10,
    "suggested_length":   "45 min",
    "mood":               "string — 2 to 6 words describing the emotional arc, commas allowed"
  }

Rules:
- ${format.idea.guidanceText}
- Each idea should have a distinct setting, protagonist archetype, and emotional arc.
- suggested_chapters is an integer, usually 8–12.
- suggested_length is one of: "30 min", "45 min", "60 min", "90 min".
- Don't invent extra keys — the importer only reads the six above.
- If you're unsure about a field, leave the idea out rather than guessing.
${patternBlock}
Produce N ideas. (Replace N with however many you want, e.g. 10.)

Example of a valid response:

${exampleJson}
`
}

router.get('/projects/:slug/ideas/paste-prompt', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  const format = await getEffectiveFormat(req.params.slug)
  // Optional ?pattern_id=... &pattern_subject=... to fold a Pattern preset
  // into the copied prompt, matching the in-app generate flow. When the
  // pattern can't be loaded (deleted / typo), we fall through to the plain
  // format-only prompt — better than 500-ing because the user picked a
  // pattern that no longer exists.
  const patternId = typeof req.query.pattern_id === 'string' ? req.query.pattern_id.trim() : ''
  const patternSubject = typeof req.query.pattern_subject === 'string' ? req.query.pattern_subject.trim() : ''
  let pattern: Pattern | null = null
  if (patternId) {
    try { pattern = await loadPattern(patternId) }
    catch { pattern = null }
  }
  res.type('text/plain').send(buildPastePrompt(format, pattern, patternSubject))
})

/**
 * Validate a single raw row from the pasted JSON array. Returns `null` when
 * the row is valid + normalised; returns a string reason when rejected.
 * Narrow rules: hard-fail on missing title/logline or wrong types; soft-fail
 * with defaults is explicitly NOT used — the preview table exists so the
 * user notices quality issues before they're written to disk.
 */
function validatePastedIdea(raw: any, idx: number): { ok: true; value: {
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

  // suggested_length: accept any string but fall back to "45 min" if empty —
  // this field is primarily a UI hint and not safety-critical.
  const lenRaw = typeof raw.suggested_length === 'string' ? raw.suggested_length.trim() : ''
  const suggested_length = lenRaw || '45 min'

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

  const valid: Array<{ title: string; logline: string; themes: string[];
                       suggested_chapters: number; suggested_length: string; mood: string }> = []
  const rejected: Array<{ index: number; reason: string; raw: any }> = []
  for (let i = 0; i < parsed.length; i++) {
    const check = validatePastedIdea(parsed[i], i)
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
    const updated = await im.updateIdea(slug, ideaId, req.body || {})
    if (!updated) return res.status(404).json({ detail: 'Idea not found' })
    res.json(updated)
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

router.get('/projects/:slug/episodes', async (req, res) => {
  const { slug } = req.params
  const ideas = await im.getIdeas(slug, 'accepted')
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
  // Re-bind to a `string` local so TS narrowing survives the async closures
  // below (buildRow captures this via the outer scope).
  const root: string = outputRoot

  const fsP = await import('fs/promises')
  const path = await import('path')
  const { episodeStatusCache } = await import('../services/episode-status-cache.js')

  // Optional `?refresh=1` clears this project's cache before computing.
  // Used by manual "refresh" actions in the UI when you want to force a
  // re-stat of every watched folder (mtime check normally catches changes,
  // so this is belt-and-suspenders only).
  if (req.query.refresh === '1') {
    episodeStatusCache.invalidateProject(slug)
  }

  // Source-doc checks (script / prompts / metadata) stay as cheap file-ext
  // scans — they're "is the input artifact present?" questions where a file
  // either exists or doesn't. Asset-completion checks (audio/images/video/
  // merged) go through the authoritative helpers so partial generations are
  // correctly reported as NOT done. That fixes the bidirectional filter bug
  // (done episodes showing as pending and vice-versa).
  async function findDir(dir: string, code: string): Promise<string | null> {
    try {
      const entries = await fsP.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fp = path.join(dir, entry.name)
          if (entry.name.startsWith(`${code} - `)) return fp
          const nested = await findDir(fp, code)
          if (nested) return nested
        }
      }
    } catch {}
    return null
  }

  async function buildRow(idea: any): Promise<any | null> {
    if (!idea.episode_code) return null
    const code = idea.episode_code

    // Resolve the episode directory purely for the response's episode_dir
    // field — the status computation now lives in services/asset-status.ts
    // so buildRow and run-batch agree on every boolean.
    const dir = await findDir(root, code)
    const episodeDir = dir || ''

    // Pass `ideas` so the underlying compute skips its internal ideas.json
    // load — at 150+ episodes this used to do 2 reloads/parses per call,
    // which the route's per-episode loop multiplied across the batch.
    // One read, one parse, total — for the whole list response. The cache
    // layer further short-circuits the whole compute when watched-folder
    // mtimes are unchanged (the common case during navigation).
    const status = await episodeStatusCache.get(slug, code, ideas)
    const {
      script: scriptDone,
      introduction: introductionDone,
      scene_prompts: scenePromptsDone,
      thumb_prompts: thumbPromptsDone,
      metadata: metadataDone,
      images: imagesDone,
      thumbnails: thumbsDone,
      audio: audioDone,
      merged_audio: mergedAudioDone,
      video: videoDone,
      video_assembly: videoAssemblyDone,
    } = status

    return {
      episode_code: code,
      title: idea.title,
      logline: idea.logline,
      suggested_chapters: idea.suggested_chapters,
      suggested_length: idea.suggested_length,
      mood: idea.mood,
      themes: idea.themes,
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
      //   video          — every video clip present.
      //   video_ready    — derivable: images && merged_audio && !video.
      //   publishable    — derivable: images && thumbnails && merged_audio && video.
      //   metadata       — at least one metadata file (.txt/.json/.md) in the metadata folder.
      //   all_done       — every primary asset present.
      status: {
        script: scriptDone,
        introduction: introductionDone,
        prompts: scenePromptsDone,           // backward compat
        scene_prompts: scenePromptsDone,
        thumb_prompts: thumbPromptsDone,
        images: imagesDone,
        thumbnails: thumbsDone,
        audio: audioDone,
        merged_audio: mergedAudioDone,
        video: videoDone,
        // Added 2026-04-24: was silently dropped by buildRow's destructure so
        // pipeline.vue saw `undefined` and always reported video_assembly as
        // missing, even after the broader disk detection landed.
        video_assembly: videoAssemblyDone,
        video_ready: imagesDone && mergedAudioDone && !videoDone,
        publishable: imagesDone && thumbsDone && mergedAudioDone && videoDone,
        metadata: metadataDone,
        all_done: scriptDone && scenePromptsDone && thumbPromptsDone
          && imagesDone && thumbsDone && audioDone && metadataDone
          && mergedAudioDone && videoDone,
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

  res.json(results.filter(Boolean))
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

  // Recursively find all episode folders
  async function findEpisodeDirs(dir: string): Promise<string[]> {
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
          dirs.push(...await findEpisodeDirs(fp))
        }
      }
    } catch {}
    return dirs
  }

  const episodeDirs = await findEpisodeDirs(outputRoot)

  for (const epDir of episodeDirs) {
    const dirName = pathMod.basename(epDir)
    const codeMatch = dirName.match(/^([A-Z]{2}\d{3,})/)
    if (!codeMatch) continue
    const code = codeMatch[1]
    const actions: string[] = []

    const subs = await fsP.readdir(epDir)
    const cleanSubs = subs.map(s => ({ original: s, clean: s }))

    // Resolve configured subfolder names for this episode
    const names = await resolveSubfolderNames(slug, code)

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
    const hasVideoFolder = cleanSubs.some(s => s.clean.toLowerCase().includes('video'))
    if (!hasVideoFolder) {
      await fsP.mkdir(pathMod.join(epDir, names.video), { recursive: true })
      actions.push('Created Video folder')
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

  // 1. Find all episode folders
  async function findEpisodeDirs(dir: string): Promise<string[]> {
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
          dirs.push(...await findEpisodeDirs(fp))
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
  res.json({ ok: true })
})
