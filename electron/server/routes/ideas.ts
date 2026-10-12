/**
 * Story Idea Generator + persistence endpoints.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import { trackGeneration } from '../services/session-tracker.js'
import { resolveSubfolderNames } from '../services/utils.js'
import type { Format } from '../models/types.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { withLock } from '../lib/atomic-store.js'
import { freshActionMatch, readOptionalOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { previewCompact, compactAcceptedEpisodes } from '../services/upload-compact.js'
import { loadNiche } from '../services/niche-loader.js'
import { isCompatible, loadTopicPack } from '../services/topic-pack-loader.js'
import { readVideoVisualSource } from '../services/video-visual-source.js'
import { readLocalMediaCleanupStatus } from '../services/episode-media-cleanup.js'
import { readYouTubeRetentionStores } from '../services/youtube-remote-video.js'
import { readEpisodeUploadStatus } from '../services/episode-upload-status.js'
import {
  previewReseason, applyReseason, revertReseason,
  readReseasonUndo, deleteReseasonUndo, isReseasonUndoExpired,
} from '../services/upload-reseason.js'

export const router = Router()

// ── Generate ideas (and persist them) ───────────────────────────────────────

// Freeform prompt + provider operation are shared with formula-only campaigns.
export {
  buildCreativeParameters,
  parseLeadingCount,
  rewriteLeadingCount,
  parseFreeformIdeas as parseIdeas,
} from '../services/freeform-idea-generation.js'
import { parseFreeformIdeas as parseIdeas } from '../services/freeform-idea-generation.js'
import { recentCharacterNamesAvoidance } from '../services/recent-character-names.js'
import { collectFormulaHistory, resolveCampaignNiche, watchImportedIdeas } from '../generators/idea-campaign.js'
import { computeAllIdeaSupply, computeIdeaSupply } from '../services/idea-supply.js'
import { getIdeaUpgrades, IDEA_UPGRADE_DEFAULTS, mergeIdeaUpgrades, saveIdeaUpgrades } from '../services/idea-upgrades.js'
import { readCoveredMap, trashCoveredMap, updateCoveredMap } from '../services/covered-topics.js'
import { listEmbeddingModels } from '../lib/embeddings-client.js'
import { readGrownPack, rejectGrownSubject } from '../services/grown-pack.js'
import { GrowError, growRuns, growTopicPack, suggestReferenceCategories } from '../services/topic-pack-grow.js'
import { getReferencePool, readReferencePool } from '../services/reference-pool.js'

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

    let operationId: string | null
    try {
      operationId = readOptionalOperationId(req.body)
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
    }
    const requestParams: Record<string, unknown> = {
      ...req.body,
      count,
      model,
      series_formula_id: seriesFormulaId,
      topic_pack_ids: topicPackIds,
    }
    delete requestParams.niche_id
    delete requestParams.operation_id
    delete requestParams.generation_action
    delete requestParams.generation_action_fingerprint

    const enqueue = async (params: Record<string, unknown>) => {
      const job = await jq.enqueue({
        project_slug: slug,
        type: 'idea_campaign',
        episode_id: 'ideas',
        title: `Idea Campaign — ${count} ideas`,
        params: {
          ...params,
          campaign_id: `idea-campaign-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
      })
      return res.status(201).json(job)
    }

    if (!operationId) return enqueue(requestParams)
    const params = stampFreshGenerationAction(requestParams, operationId)
    return withLock(`fresh-idea-campaign:${slug}:${operationId}`, async () => {
      const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
      if (previous) {
        if (previous.params.generation_action_fingerprint !== params.generation_action_fingerprint) {
          return res.status(409).json({ detail: 'This operation_id already belongs to a different idea campaign.' })
        }
        return res.status(200).json({ ...previous, reused: true })
      }
      return enqueue(params)
    })
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) {
      return res.status(409).json({
        detail: 'An Idea Campaign is already queued or running for this project. Track it in Jobs, or wait for it to finish.',
      })
    }
    return res.status(400).json(humanizeBackendError(e, 'Failed to queue Idea Campaign'))
  }
})

// ── 1.4.285 idea upgrades: supply counter, covered-topics map, per-channel switches ──────────

/** Read-only supply counter for one channel (visible on every channel). */
router.get('/projects/:slug/ideas/supply', async (req, res) => {
  try {
    const supply = await computeIdeaSupply(req.params.slug)
    if (!supply) return res.status(404).json({ detail: 'Project not found' })
    res.json(supply)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not measure the idea supply'))
  }
})

/** The same counter for every channel on this Mac. */
router.get('/ideas/supply', async (_req, res) => {
  try {
    res.json({ channels: await computeAllIdeaSupply() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not measure the idea supply'))
  }
})

router.get('/projects/:slug/ideas/upgrades', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json({ settings: await getIdeaUpgrades(req.params.slug), defaults: IDEA_UPGRADE_DEFAULTS })
})

/** Partial update of `idea_upgrades`; the first switch turned on backs up ideas.json and config.json. */
router.put('/projects/:slug/ideas/upgrades', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const merged = mergeIdeaUpgrades(await getIdeaUpgrades(slug), req.body)
  if (typeof merged === 'string') return res.status(400).json({ detail: merged })
  try {
    const { backup_dir } = await saveIdeaUpgrades(slug, merged)
    res.json({ settings: await getIdeaUpgrades(slug), backup_dir })
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not save the idea settings'))
  }
})

/** Embedding models the Gateway offers (free fleet only), for the settings picker. */
router.get('/ideas/embedding-models', async (_req, res) => {
  try {
    res.json({ models: await listEmbeddingModels() })
  } catch (e: any) {
    res.json({ models: [], detail: `No embeddings models right now (${String(e?.message || e).replace(/\.$/, '')}). The improved word check is used instead.` })
  }
})

router.get('/projects/:slug/ideas/covered-topics', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json({ map: await readCoveredMap(req.params.slug) })
})

/**
 * Build (or bring up to date) the covered-topics map now with the chosen helper model.
 * `{ "fresh": true }` first moves the current map to Story's Trash.
 */
router.post('/projects/:slug/ideas/covered-topics/build', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  const upgrades = await getIdeaUpgrades(slug)
  if (!upgrades.helper_model) return res.status(400).json({ detail: 'Choose an idea helper model first.' })
  try {
    const trashed = req.body?.fresh === true ? await trashCoveredMap(slug) : null
    const { formulaId, niche } = await resolveCampaignNiche(project)
    const history = await collectFormulaHistory(slug, formulaId)
    const result = await updateCoveredMap({
      slug, helperModel: upgrades.helper_model, formulaId,
      channelName: project.name || slug, description: niche?.description, history,
    })
    res.json({ map: result.map, added: result.added, note: result.note || null, trashed })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not build the covered-topics map'))
  }
})

// ── 1.4.293 idea upgrades: grown Topic Pack subjects (#3), Wikipedia reference list (#5) ─────

function growFailure(res: any, e: any, fallback: string) {
  if (e instanceof GrowError) return res.status(e.statusCode).json({ detail: e.message })
  return res.status(500).json(humanizeBackendError(e, fallback))
}

/** The channel's grown pack (null until the first run) and the recent runs. */
router.get('/projects/:slug/ideas/grown', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json({ pack: await readGrownPack(req.params.slug), runs: await growRuns(req.params.slug) })
})

/** "Grow Subjects Now": one run with the channel's helper model. Fails loudly when nothing is added. */
router.post('/projects/:slug/ideas/grown/grow', async (req, res) => {
  try {
    const result = await withLock(`grow-subjects:${req.params.slug}`, () => growTopicPack(req.params.slug, { trigger: 'manual' }))
    res.json({ added: result.added, notes: result.notes, pack: result.pack })
  } catch (e: any) {
    growFailure(res, e, 'Could not grow subjects')
  }
})

/** "Remove": the subject stops being used and is never proposed again (moved to `rejected`, not deleted). */
router.post('/projects/:slug/ideas/grown/remove', async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject : ''
  if (!subject.trim()) return res.status(400).json({ detail: 'Send the subject to remove.' })
  const pack = await rejectGrownSubject(req.params.slug, subject)
  if (!pack) return res.status(404).json({ detail: `"${subject}" is not one of this channel's grown subjects.` })
  res.json({ pack })
})

/** Wikipedia categories proposed by the helper model, for the owner to edit and save (not saved here). */
router.post('/projects/:slug/ideas/reference-categories/suggest', async (req, res) => {
  try {
    res.json({ categories: await suggestReferenceCategories(req.params.slug) })
  } catch (e: any) {
    growFailure(res, e, 'Could not suggest categories')
  }
})

/** The cached Wikipedia list. `POST …/refresh` fetches it again now (politely, free). */
router.get('/projects/:slug/ideas/reference-pool', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json({ pool: await readReferencePool(req.params.slug) })
})

router.post('/projects/:slug/ideas/reference-pool/refresh', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  const { reference_categories } = await getIdeaUpgrades(req.params.slug)
  if (!reference_categories.length) return res.status(400).json({ detail: 'Save at least one Wikipedia category first.' })
  const result = await getReferencePool(req.params.slug, reference_categories, { force: true })
  res.status(result.pool ? 200 : 502).json({ pool: result.pool, note: result.note, fetched: result.fetched, ...(result.pool ? {} : { detail: result.note }) })
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
  namesAvoidance = '',
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
  // outside the format's declared range — e.g. compilation-mode running 100
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
${namesAvoidance ? `- ${namesAvoidance}\n` : ''}${titleTemplateBlock}
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
  // Same "don't reuse recent main character names" line the in-app idea
  // generators carry, so a pasted batch doesn't bring back last week's hero.
  const namesAvoidance = await recentCharacterNamesAvoidance(req.params.slug)
  res.type('text/plain').send(buildPastePrompt(format, titleTemplate, namesAvoidance))
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
  // Watch-only (per-channel idea_upgrades.semantic_dedupe): reports likely repeats, never blocks.
  const duplicate_watch = await watchImportedIdeas(slug, 'paste-import', valid)
  const stored = await im.addIdeas(slug, valid, 'paste-import')
  await trackGeneration(slug, 'ideas', stored.length)
  res.json({ valid: stored, rejected, imported: stored.length, ...(duplicate_watch ? { duplicate_watch } : {}) })
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
    // What a default Accept will really assign (a recycled gap comes first).
    // The page shows this, so "Use next available" never promises one code
    // and then hands out another.
    next_accept_number: await im.getNextAcceptNumber(req.params.slug),
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
    const idea = {
      title: String(body.title).trim(),
      logline: typeof body.logline === 'string' ? body.logline : '',
      themes: Array.isArray(body.themes) ? body.themes : [],
      suggested_chapters: Number(body.suggested_chapters) || 10,
      suggested_length: typeof body.suggested_length === 'string' ? body.suggested_length : '45 min',
      mood: typeof body.mood === 'string' ? body.mood : '',
    }
    const duplicate_watch = await watchImportedIdeas(slug, 'manual', [idea])
    const [stored] = await im.addIdeas(slug, [idea], 'manual')
    res.json(duplicate_watch ? { ...stored, duplicate_watch } : stored)
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
  // Still resolved: a missing output root is how this route answers 404.
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return null

  // v1.4.48 — ONE snapshot of the project's unchanging facts for this whole
  // response. Without it every row re-read and re-parsed ideas.json (227 KB on
  // a 302-episode project) and project.json several times over: hundreds of reads of two files
  // that cannot change while one response is being built. See
  // `ProjectFactsCache`.
  const { createProjectFactsCache } = await import('../services/utils.js')
  const projectFacts = createProjectFactsCache(slug)
  // Publishing is a separate saved receipt, not another required generation stage.
  const uploadStores = await readYouTubeRetentionStores(slug, projectFacts).catch(() => null)
  const uploadJobs = await jq.getJobs(slug, { type: 'youtube_upload' }).then(jobs => jobs
    .sort((a, b) => b.created_at.localeCompare(a.created_at))).catch(() => null)

  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  const effectiveFormat = await getEffectiveFormat(slug)
  const projectVisualSource = String(effectiveFormat.visualSource || 'continuity-chain')

  // v1.4.76 — the code→dir index that used to be built here is gone with the
  // `episode_dir` field it existed to populate. See the response object below.

  // Source-doc checks (script / prompts / metadata) stay as cheap file-ext
  // scans — they're "is the input artifact present?" questions where a file
  // either exists or doesn't. Asset-completion checks (audio/images/video/
  // merged) go through the authoritative helpers so partial generations are
  // correctly reported as NOT done. That fixes the bidirectional filter bug
  // (done episodes showing as pending and vice-versa).
  async function buildRow(idea: any): Promise<any | null> {
    if (!idea.episode_code) return null
    const code = idea.episode_code

    // Pass `ideas` so the underlying compute skips its internal ideas.json
    // load — at 150+ episodes this used to do 2 reloads/parses per call,
    // which the route's per-episode loop multiplied across the batch.
    // One read, one parse, total — for the whole list response. The cache
    // layer further short-circuits the whole compute when watched-folder
    // mtimes are unchanged (the common case during navigation).
    // getForList, not get: on a warm list this serves watcher-vouched entries
    // without re-statting every episode's folders. The single-episode status
    // route below stays on the strict get().
    const status = await episodeStatusCache.getForList(slug, code, ideas, projectFacts)
    // 1.4.257 — kept on the cached row: each read resolved three sidecars
    // (a scan of the season folder apiece) for every episode on every list.
    const rowReads = await episodeStatusCache.listExtras(slug, code, status, async () => ({
      visual_source: (await readVideoVisualSource(slug, code, projectFacts)).source,
      local_media_status: await readLocalMediaCleanupStatus(slug, code, projectFacts),
    }))
    const episodeVisualSource = rowReads.visual_source
    const needsScenePlan = episodeVisualSource === 'scene_plan'
    const needsImagePool = episodeVisualSource === 'image_pool'
    const needsCharacterSheet = needsScenePlan && projectVisualSource !== 'timestamp-driven'
    // Only the fields the DERIVED values below are computed from. Everything
    // else reaches the response through `...publicStatus` — see the status
    // object at the end of this function.
    const {
      scene_plan: scenePlanDone,
      scene_review: sceneReviewDone,
      character_sheet: characterSheetDone,
      broll_picked: brollPickedDone,
      script: scriptDone,
      scene_prompts: scenePromptsDone,
      thumb_prompts: thumbPromptsDone,
      metadata: metadataDone,
      thumbnails: thumbsDone,
      audio: audioDone,
      merged_audio: mergedAudioDone,
      subtitles: subtitlesDone,
      video_assembly: videoAssemblyDone,
    } = status
    // Publish every current and future EpisodeStatus field by default. This
    // prevents a newly-added workflow step from being computed correctly in
    // asset-status but silently disappearing when this route rebuilds status.
    const {
      _unreliable: _internalStatusFlag,
      _scene_images: sceneImages,
      _thumbnail_images: thumbnailImages,
      ...publicStatus
    } = status

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
      local_media_status: rowReads.local_media_status,
      youtube_upload: uploadStores && uploadJobs
        ? await readEpisodeUploadStatus(slug, code, idea.title || '', uploadStores, projectFacts,
          uploadJobs.find(job => job.episode_id === code))
          .catch(() => ({ state: 'unknown', reason: 'The saved upload record could not be read.' }))
        : { state: 'unknown', reason: 'The saved YouTube publishing or queue records could not be read.' },
      visual_source: episodeVisualSource,
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
        // `...publicStatus` IS the contract: every field asset-status computes
        // is published, including ones added after this line was written.
        //
        // v1.4.76 — seventeen explicit re-assignments used to follow this
        // spread (research, scene_plan, scene_review, motion_review,
        // character_sheet, broll_picked, script, introduction, scene_prompts,
        // thumb_prompts, images, thumbnails, audio, merged_audio, subtitles,
        // video, video_assembly). Each destructured a field out of `status` and
        // put back the identical value, so every one was a no-op.
        //
        // They are not deleted lightly — each arrived fixing a REAL bug
        // (v1.0.246 research, v1.0.279 scene_plan/scene_review, v1.0.352
        // subtitles, v1.0.361 character_sheet, v1.0.362 broll_picked, and the
        // 2026-04-24 video_assembly regression). But those bugs all had one
        // cause: this object was assembled field-by-field, so a field nobody
        // remembered to list vanished from the response. The spread fixed the
        // CLASS. Keeping the list as well left two sources of truth and taught
        // the next person that a new workflow step needs a line here — the very
        // habit that caused all six bugs. The spread alone is the guarantee.
        //
        // What genuinely cannot come from the spread stays below: `prompts` is
        // an alias asset-status does not emit, and the last three are DERIVED
        // from several fields plus this project's format.
        ...publicStatus,
        visual_source: episodeVisualSource,
        prompts: scenePromptsDone,           // deprecated alias of scene_prompts
        // 1.4.288 — Scene Review alone is not enough: approved pictures on a plan that stops
        // before the narration ends are not ready, or the short plan is found at Video Assembly.
        video_ready: (needsScenePlan ? scenePlanDone && sceneReviewDone : brollPickedDone)
          && mergedAudioDone && !videoAssemblyDone,
        publishable: thumbsDone && mergedAudioDone && videoAssemblyDone,
        all_done: scriptDone && thumbPromptsDone && thumbsDone
          && audioDone && metadataDone && mergedAudioDone && subtitlesDone
          && (!needsScenePlan || (scenePlanDone && sceneReviewDone))
          && (!needsCharacterSheet || characterSheetDone)
          && (!needsImagePool || brollPickedDone)
          && videoAssemblyDone,
        // A music channel's episode (`music_episode` present) has no narration: its flow is Episode
        // Builder → Video Assembly → Thumbnail → Finalizer, and only those decide.
        ...(status.music_episode !== undefined ? {
          video_ready: status.music_episode && sceneReviewDone && !videoAssemblyDone,
          publishable: thumbsDone && status.music_episode && videoAssemblyDone,
          all_done: status.music_episode && thumbsDone && metadataDone && videoAssemblyDone,
        } : {}),
      },
      scene_images: sceneImages || { total: 0, present: 0, complete: false },
      thumbnail_images: thumbnailImages || { total: 0, present: 0, complete: false },
      // v1.4.76 — `episode_dir` is gone. It was an absolute filesystem path
      // sent for every row (63 KB, 15.2% of this response on a 302-episode
      // project) that no consumer has ever read: the only mention anywhere was
      // an unused optional field on the frontend's EpisodeRow type, removed
      // with it. Building it also cost the route a tree walk of its own.
      // Pages that need an episode's paths ask the routes that own them.
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
    // v1.4.48 — ONE snapshot of the project's unchanging facts for this whole
  // response. Without it every row re-read and re-parsed ideas.json (227 KB on
  // a 302-episode project) and project.json several times over: hundreds of reads of two files
  // that cannot change while one response is being built. See
  // `ProjectFactsCache`.
  const { createProjectFactsCache } = await import('../services/utils.js')
  const projectFacts = createProjectFactsCache(slug)

  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    if (req.query.invalidate === '1' || req.query.invalidate === 'true') {
      episodeStatusCache.invalidate(slug, code)
    }
    // Load accepted ideas once (cheap — ~100ms) so we can (a) return the
    // canonical title the gate displays and (b) hand the array to the cache
    // so it skips its own internal ideas.json read.
    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '').toUpperCase() === code.toUpperCase())
    const status = await episodeStatusCache.get(slug, code, ideas, projectFacts)
    const { _scene_images: sceneImages, _thumbnail_images: thumbnailImages, ...publicStatus } = status
    res.json({
      episode_code: code,
      title: idea?.title || '',
      idea_id: idea?.id,
      // Raw EpisodeStatus (script/scene_prompts/thumb_prompts/metadata/…) plus
      // the `prompts` back-compat alias the list route exposes, so consumers
      // reading either name keep working.
      status: { ...publicStatus, prompts: (status as any).scene_prompts },
      scene_images: sceneImages || { total: 0, present: 0, complete: false },
      thumbnail_images: thumbnailImages || { total: 0, present: 0, complete: false },
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
    // Per-idea outcome: { accepted, skipped, failed: [{ id, title, reason }] }.
    // One bad idea no longer aborts the rest of the batch.
    const result = await im.acceptMultipleIdeas(req.params.slug, idea_ids)
    res.json(result)
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

// ── Manually tag/check an episode folder ────────────────────────────────────

// ── Migrate old episodes to new folder structure ────────────────────────────

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
