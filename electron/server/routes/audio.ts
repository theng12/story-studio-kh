import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveArtifact } from '../lib/episode-artifacts.js'
import { validateBody } from '../lib/validate.js'
import { GenerateAudioSchema } from '../schemas/index.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { getAudioStatus, reconcileAudio } from '../services/audio-reconciler.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  catalogHasVoice,
  downloadVoicePreview,
  listVoices as listGenStudioVoices,
  listTtsModels as listGenStudioTtsModels,
} from '../lib/genstudio-client.js'
import { unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import { resolveDefaultChatModel, describeHealedDefaultChatModel } from '../services/genstudio-default-model.js'

export const router = Router()

/**
 * Resolve the default text model for an expression-markup run when the
 * caller didn't specify one. Never falls back to a hardcoded external
 * product id — GenStudio owns the catalog, so this asks it directly and
 * prefers the project's saved `prompt_model` preference when still usable.
 */
async function resolveExpressionDefaultModel(config: any): Promise<{ model: string, notice: string }> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    throw new Error('No GenStudio API key configured. Add it in Settings → This Mac before generating expression markup.')
  }
  const saved = typeof config?.prompt_model === 'string' ? config.prompt_model : null
  const resolved = await resolveDefaultChatModel(apiKey, saved)
  // `healed` was dropped here, so a run against a substituted model looked
  // exactly like a run against the one the project had saved.
  return { model: resolved.modelId, notice: describeHealedDefaultChatModel(resolved) || '' }
}

router.post('/projects/:slug/generate/audio', validateBody(GenerateAudioSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  // The customer picks a GenStudio TTS model and is charged by it. The model id
  // is GenStudio's own, validated against the live /v1/tts/models catalogue
  // below; Story Studio neither maps nor renames it.
  const migratedModel = (req.body.model || '').trim()
  if (!migratedModel) {
    return res.status(409).json({ detail: unavailableLegacyModelMessage('voice', req.body.model || '(none)') })
  }
  req.body.model = migratedModel

  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    return res.status(400).json({
      code: 'GENSTUDIO_KEY_REQUIRED',
      detail: 'No GenStudio KH API key configured. Add it in Settings → This Mac.',
    })
  }

  try {
    const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === migratedModel)
    if (!ttsModel) {
      return res.status(409).json({ detail: `The saved voice model "${req.body.model}" is not currently in your GenStudio KH catalogue.` })
    }
    if (!ttsModel.generation_enabled) {
      return res.status(409).json({ detail: `GenStudio KH has generation turned off for ${ttsModel.display_name}. Choose another voice model.` })
    }
    if (ttsModel.locked) {
      return res.status(409).json({ detail: `${ttsModel.display_name} is locked for this GenStudio account. Choose an unlocked voice model.` })
    }
    const voices = await listGenStudioVoices(apiKey, { modelId: migratedModel })
    const selectedVoice = voices.find(voice => voice.id === req.body.voice && voice.generation_enabled !== false)
    if (!selectedVoice || !catalogHasVoice(voices, req.body.voice)) {
      return res.status(400).json({
        detail: `The selected voice is not available on ${ttsModel.display_name} in your GenStudio KH catalog. `
          + 'Refresh the voice picker and choose an available voice.',
      })
    }
    // voice_tier is published metadata, kept beside the job for history. It is
    // no longer a selector and no longer a price band.
    if (selectedVoice.voice_tier) req.body.tts_tier = selectedVoice.voice_tier
  } catch (error: any) {
    return res.status(502).json(humanizeBackendError(error, 'Could not verify the GenStudio KH voice catalog'))
  }
  if (jq.isDuplicate(slug, req.body.episode_id, 'audio')) {
    return res.status(409).json({ detail: `Audio generation already queued/running for ${req.body.episode_id}` })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'audio',
    episode_id: req.body.episode_id,
    title: `Audio (${req.body.sections || 'all'})`,
    params: req.body,
  })
  res.status(201).json(job)
})

/** Play the stored GenStudio voice sample without submitting a billable TTS job. */
router.post('/projects/:slug/preview-voice', async (req, res) => {
  const { slug } = req.params
  const { voice_id, model } = req.body
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const migratedModel = (model || '').trim()
  if (!migratedModel) return res.status(409).json({ detail: unavailableLegacyModelMessage('voice', model || '(none)') })
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    return res.status(400).json({
      code: 'GENSTUDIO_KEY_REQUIRED',
      detail: 'No GenStudio KH API key configured. Add it in Settings → This Mac.',
    })
  }
  const resolvedVoiceId = typeof voice_id === 'string' ? voice_id.trim() : ''
  if (!resolvedVoiceId) return res.status(400).json({ detail: 'Select a GenStudio voice before previewing.' })

  try {
    // Scoped by the model this preview belongs to. GenStudio requires
    // `model_id` on `/v1/voices` (ADR-0016) and answers 422 without it, so an
    // unscoped read here failed the preview for a perfectly valid voice. The
    // model was already resolved and validated above — pass it.
    const voices = await listGenStudioVoices(apiKey, { modelId: migratedModel })
    const voice = voices.find(entry => entry.id === resolvedVoiceId)
    if (!voice) {
      return res.status(404).json({ detail: 'That voice is no longer available in your GenStudio catalog.' })
    }
    if (!voice.preview_available || !voice.preview_url) {
      return res.status(404).json({ detail: 'No saved preview is available for this voice yet.' })
    }
    const preview = await downloadVoicePreview(apiKey, voice.preview_url)
    return res.json({
      audio_url: `data:${preview.mediaType};base64,${preview.bytes.toString('base64')}`,
      preview_text: voice.preview_text || null,
      preview_notice: voice.preview_notice || null,
      generated: false,
    })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Voice preview failed'))
  }
})

// ── Fish S2 expression markup (the "expressive script" sidecar) ───────────
// Tagged narration for Fish Audio S2-Pro: an LLM pass inserts inline [tags]
// (whispering, excited, long pause, …) that the Audio Generator swaps in at
// render time when "Use expression" is on. Stored per section slug so the real
// narration always stays the authoritative source of section structure.

/** Resolve the narration path or send a 404. Returns null after responding. */
async function resolveNarrationOr404(slug: string, code: string, res: any): Promise<string | null> {
  const { findNarrationFile } = await import('../generators/audio.js')
  try {
    return await findNarrationFile(slug, code)
  } catch {
    res.status(404).json({ detail: 'No narration found for this episode. Generate the script first.' })
    return null
  }
}

/**
 * GenStudio's own credit figures for the narration a Generate press would send.
 *
 * The narration is not one request. This resolves the SAME jobs the generator
 * will submit — same normalization, same section selection, same split at the
 * selected model's published `maximum_input_characters`, via the one shared
 * planner — then asks GenStudio to price each of them. The response carries
 * every part's own returned figure plus their sum. Story Studio adds; it never
 * computes a price.
 *
 * Quoting is not generation: no TTS job is submitted here and nothing is
 * charged for asking.
 */
router.post('/projects/:slug/episodes/:code/tts-quote', async (req, res) => {
  const { slug, code } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const modelId = String(req.body?.model || '').trim()
    const voiceId = String(req.body?.voice || '').trim()
    if (!modelId) return res.status(400).json({ detail: 'Choose a voice model before asking for a quote.' })
    if (!voiceId) return res.status(400).json({ detail: 'Choose a voice before asking for a quote.' })

    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) {
      return res.status(400).json({
        code: 'GENSTUDIO_KEY_REQUIRED',
        detail: 'No GenStudio KH API key configured. Add it in Settings → This Mac.',
      })
    }

    // The boundary and the price in force are read live, from the model the
    // customer selected. Nothing here is remembered between requests.
    const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === modelId)
    if (!ttsModel) {
      return res.status(409).json({ detail: `The selected voice model "${modelId}" is not currently in your GenStudio KH catalogue.` })
    }
    if (!ttsModel.generation_enabled || ttsModel.locked) {
      return res.status(409).json({ detail: `${ttsModel.display_name} is not available for generation on this GenStudio account.` })
    }
    const voices = await listGenStudioVoices(apiKey, { modelId })
    const voice = voices.find(candidate => candidate.id === voiceId)
    if (!voice) {
      return res.status(400).json({
        detail: `The selected voice is not available on ${ttsModel.display_name} in your GenStudio KH catalog.`,
      })
    }

    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const {
      flattenTtsRequestPlan, normalizeSectionsForTts, planGenStudioTtsRequests,
      resolveTtsRequestBudget, selectNarrationSections,
    } = await import('../services/tts-request-plan.js')
    const allSections = await parseNarrationDocx(narrationPath)
    normalizeSectionsForTts(allSections)
    const sections = selectNarrationSections(allSections, String(req.body?.sections || 'all'))
    if (!sections.length) {
      return res.status(400).json({ detail: 'There is no narration on disk yet for the selected sections.' })
    }
    // NOT filtered or trimmed: these are the request bodies as submitted. A
    // quote over a tidied-up copy would be a quote for work nobody does. The
    // budget comes from the same function the generator calls, on the same live
    // catalogue row, so both split identically.
    const requestBudget = resolveTtsRequestBudget(ttsModel)
    const requests = flattenTtsRequestPlan(
      planGenStudioTtsRequests(sections, requestBudget.effective),
    )
    if (!requests.some(request => request.text.trim())) {
      return res.status(400).json({ detail: 'There is no narration on disk yet to quote.' })
    }

    const speed = Number(req.body?.speed)
    const { requestGenStudioTtsQuote } = await import('../lib/genstudio-client.js')
    const { resolveTtsControlValues } = await import('../lib/tts-controls.js')
    const { quoteNarrationRequests } = await import('../services/tts-narration-quote.js')
    // Resolved against the SELECTED model's published `controls[]`, so a name
    // this model does not publish cannot reach the quote and a value outside
    // its published range cannot either. GenStudio prices controls, so quoting
    // without the ones generation will send would quote different work.
    const controls = resolveTtsControlValues(ttsModel.controls, req.body?.controls)
    const quote = await quoteNarrationRequests({
      requests,
      quoteEnabled: voice.quote_enabled !== false,
      quoteRequest: text => requestGenStudioTtsQuote(apiKey, {
        modelId,
        voiceId,
        text,
        // Generation always sends a speed (`req.speed ?? 1`). Quote the same
        // one — speed changes the billed duration on some models.
        speed: Number.isFinite(speed) ? speed : 1,
        controls,
      }),
    })

    res.json({
      ...quote,
      // Published context, so the reader can still see the rate in force even
      // when no quote could be obtained. These are GenStudio's figures.
      model_id: ttsModel.id,
      model_name: ttsModel.display_name,
      provider_name: ttsModel.provider_name,
      credits_per_1000_characters: ttsModel.credits_per_1000_characters,
      minimum_credits: ttsModel.minimum_credits,
      maximum_input_characters: ttsModel.maximum_input_characters,
      // What was actually priced, after resolution against this model's
      // published list — so the page can show it is what generation will send.
      controls,
      // Story Studio's own figures, not GenStudio's, and labelled as such by
      // the page: the boundary planning actually enforced, and the fraction of
      // the published one held back to get there.
      planned_request_characters: requestBudget.effective,
      request_safety_margin: requestBudget.safety_margin,
      section_count: sections.length,
    })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not get GenStudio KH quotes for this narration'))
  }
})

// Load each section's original text + any saved tagged version.
router.get('/projects/:slug/episodes/:code/expression', async (req, res) => {
  const { slug, code } = req.params
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const { readExpression } = await import('../services/audio-expression.js')
    const parsed = await parseNarrationDocx(narrationPath)
    const expr = await readExpression(narrationPath)
    const sections = parsed.map(s => ({
      slug: s.slug, label: s.label, original: s.text, expressive: expr?.sections?.[s.slug] || '',
    }))
    // job_active = a background "Tag all" is queued/running for this episode, so
    // the panel knows to keep polling for progress even across navigations.
    const jobActive = jq.isDuplicate(slug, code, 'expression_markup')
    res.json({ model: expr?.model || null, dialect: expr?.dialect || null, generated_at: expr?.generated_at || null, sections, job_active: jobActive })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load expression markup'))
  }
})

// Background "Tag all" — enqueue the markup job so it keeps running after the
// operator leaves the page (saves the sidecar after each section).
router.post('/projects/:slug/episodes/:code/expression/generate-all', async (req, res) => {
  const { slug, code } = req.params
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    const config = await pm.getConfig(slug)
    const resolvedDefault = requestedModel ? null : await resolveExpressionDefaultModel(config)
    const model = requestedModel || resolvedDefault!.model
    const { dialectForModel } = await import('../services/audio-expression.js')
    const dialect = dialectForModel(req.body?.audio_model) || 'fish'
    if (jq.isDuplicate(slug, code, 'expression_markup')) {
      return res.status(409).json({ detail: 'Expression tagging is already running for this episode.' })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'expression_markup',
      episode_id: code,
      title: `Expression markup — ${code}`,
      // The heal notice rides into the job because this route resolves the
      // model before any job exists to announce it on.
      params: { episode_id: code, model, dialect, ...(resolvedDefault?.notice ? { model_heal_notice: resolvedDefault.notice } : {}) },
    })
    res.status(201).json({ job_id: job.job_id })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to start expression markup'))
  }
})

// Run the LLM markup pass for some/all sections and persist the result.
router.post('/projects/:slug/episodes/:code/expression/generate', async (req, res) => {
  const { slug, code } = req.params
  const requestedSlugs: string[] | null = Array.isArray(req.body?.slugs)
    ? req.body.slugs.filter((x: any) => typeof x === 'string') : null
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })
    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    const syncResolvedDefault = requestedModel ? null : await resolveExpressionDefaultModel(config)
    const model = requestedModel || syncResolvedDefault!.model
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const {
      readExpression, writeExpression, markupSectionText, dialectForModel,
      expressionTagConcurrency, mapExpressionConcurrent,
    } = await import('../services/audio-expression.js')
    const dialect = dialectForModel(req.body?.audio_model) || 'fish'
    const parsed = await parseNarrationDocx(narrationPath)
    const targets = requestedSlugs && requestedSlugs.length
      ? parsed.filter(s => requestedSlugs.includes(s.slug)) : parsed
    if (!targets.length) return res.status(400).json({ detail: 'No matching sections to mark up.' })

    const apiKeys = {
      anthropic_api_key: (config as any).anthropic_api_key,
      openai_api_key: (config as any).openai_api_key,
      kie_api_key: (config as any).kie_api_key,
    }
    const existing = await readExpression(narrationPath)
    // Drop tags from a different dialect so Fish + ElevenLabs tags never mix.
    const reusable = existing && (existing.dialect ?? 'fish') === dialect
    const sectionsOut: Record<string, string> = { ...(reusable ? existing!.sections : {}) }
    const concurrency = await expressionTagConcurrency(model, targets.length)
    await mapExpressionConcurrent(targets, concurrency, async (s) => {
      sectionsOut[s.slug] = await markupSectionText(model, s.text, apiKeys, slug, dialect)
    })
    const generated_at = new Date().toISOString()
    await writeExpression(narrationPath, { schema_version: 1, model, dialect, generated_at, sections: sectionsOut })
    const sections = parsed.map(s => ({ slug: s.slug, label: s.label, original: s.text, expressive: sectionsOut[s.slug] || '' }))
    // Synchronous route: no job log exists, so the substitution travels back
    // with the result instead of being dropped on the floor.
    res.json({ model, generated_at, sections, ...(syncResolvedDefault?.notice ? { model_notice: syncResolvedDefault.notice } : {}) })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to generate expression markup'))
  }
})

// Save manual edits / toolbar inserts. Empty text for a slug clears it (that
// section falls back to the plain narration at render time).
router.put('/projects/:slug/episodes/:code/expression', async (req, res) => {
  const { slug, code } = req.params
  const incoming = req.body?.sections
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ detail: 'sections object required' })
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const { readExpression, writeExpression } = await import('../services/audio-expression.js')
    const parsed = await parseNarrationDocx(narrationPath)
    const validSlugs = new Set(parsed.map(s => s.slug))
    const existing = await readExpression(narrationPath)
    const sectionsOut: Record<string, string> = { ...(existing?.sections || {}) }
    for (const [k, v] of Object.entries(incoming)) {
      if (!validSlugs.has(k)) continue
      const text = typeof v === 'string' ? v : ''
      if (text.trim()) sectionsOut[k] = text
      else delete sectionsOut[k]
    }
    const generated_at = new Date().toISOString()
    await writeExpression(narrationPath, { schema_version: 1, model: existing?.model, dialect: existing?.dialect, generated_at, sections: sectionsOut })
    const sections = parsed.map(s => ({ slug: s.slug, label: s.label, original: s.text, expressive: sectionsOut[s.slug] || '' }))
    res.json({ model: existing?.model || null, generated_at, sections })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save expression markup'))
  }
})

// ── Audio reconciliation (recover missing chunks) ─────────────────────────
// Scans expected vs present audio chunks for an episode. `/status` is
// read-only; `/repair` can reclaim accepted GenStudio jobs only. Historical
// direct-provider sidecars remain readable evidence and fail without contact.

router.get('/projects/:slug/episodes/:code/audio-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const status = await getAudioStatus(req.params.slug, req.params.code)
    res.json({
      audio_dir: status.audio_dir,
      total: status.expected.length,
      present: status.present.length,
      missing: status.missing.length,
      missing_files: status.missing,
    })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute audio status'))
  }
})

// Per-section status for the audio chapter selector. Aggregates the chunk-
// level reconciler view into one row per section (Introduction / Chapter 1
// / Chapter 2 / …) with: how many chunks the section needs, how many exist
// on disk, and a derived overall status. The audio.vue selector uses this
// to render status pills without users having to open the script.
router.get('/projects/:slug/episodes/:code/audio-sections', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    // `?model=` is the voice model the customer has SELECTED in the form, not
    // the one this episode last used. The chunk counts shown must follow the
    // choice being made now: two models publish different request boundaries,
    // so the same chapter is one request under one and several under another.
    // Omitted (any other caller), planning falls back to job history.
    const selectedModel = typeof req.query.model === 'string' ? req.query.model : undefined
    const status = await getAudioStatus(req.params.slug, req.params.code, selectedModel)

    const bySlug = new Map<string, {
      label: string
      slug: string
      total_chunks: number
      present_chunks: number
      word_count: number
      character_count: number
    }>()
    for (const ec of status.expected) {
      // Derive slug from the filename — section.slug maps 1:1 to the prefix
      // before "_part" (or the whole base if single-chunk). Filenames are
      // already authoritative because the reconciler reuses generators/audio
      // naming, so re-deriving here keeps us in lockstep.
      const base = ec.filename.replace(/\.mp3$/, '')
      const slug = base.replace(/_part\d+$/, '').replace(new RegExp(`^${req.params.code}_`, 'i'), '')
      const entry = bySlug.get(slug) || {
        label: ec.sectionLabel,
        slug,
        total_chunks: 0,
        present_chunks: 0,
        word_count: ec.sectionWordCount,
        character_count: ec.sectionCharacterCount,
      }
      entry.total_chunks += 1
      if (status.present.includes(ec.filename)) entry.present_chunks += 1
      bySlug.set(slug, entry)
    }

    // Per-chapter refactor: detect stale audio by comparing each
    // chapter's source mtime against its audio chunks' mtimes. If a
    // chapter source is newer than every matching audio chunk, the
    // audio is stale (chapter was regenerated after audio was made).
    //
    // Path discovery: derive scriptDir from the unified narration path
    // the audio reconciler already located. resolveEpisodePaths needs a
    // title to build the right episode folder name, which we don't have
    // here — but findNarrationFile traverses the project root by code
    // alone, so it works on legacy episodes too. The script dir is the
    // narration's parent directory.
    const fs = await import('fs/promises')
    const path = await import('path')
    const { findNarrationFile } = await import('../generators/audio.js')
    const code = req.params.code
    let scriptDir: string | null = null
    try {
      const narrationPath = await findNarrationFile(req.params.slug, code)
      scriptDir = path.dirname(narrationPath)
    } catch { /* no narration → no per-chapter sources to check, fall through */ }

    async function isSectionStale(slug: string): Promise<boolean> {
      if (!scriptDir) return false
      // Source: chapter file for Chapter_NN, intro file for Introduction.
      let sourcePath: string | null = null
      if (slug === 'Introduction') {
        sourcePath = resolveArtifact(scriptDir, `${code}_Introduction`)
      } else {
        const m = slug.match(/^Chapter_(\d+)$/)
        if (m) sourcePath = resolveArtifact(scriptDir, `${code}_Chapter_${m[1]}`)
      }
      if (!sourcePath) return false
      let sourceMs: number
      try { sourceMs = (await fs.stat(sourcePath)).mtimeMs }
      catch { return false } // no source → can't be stale
      // Compare against ALL existing chunks for this section.
      const chunkRe = new RegExp(`^${code}_${slug}(?:_part\\d+)?\\.mp3$`)
      let dirEntries: string[] = []
      try { dirEntries = await fs.readdir(status.audio_dir) } catch { return false }
      const matchingChunks = dirEntries.filter(n => chunkRe.test(n))
      if (!matchingChunks.length) return false // nothing generated → not "stale", just not done
      // Stat all chunks in parallel — they're independent files. Sequential
      // awaits made multi-chunk sections pay N round-trips of disk latency
      // before we could decide; parallel stats finish in one round-trip.
      const chunkStats = await Promise.all(
        matchingChunks.map(c => fs.stat(path.join(status.audio_dir, c)).catch(() => null)),
      )
      // "Not stale" iff at least one chunk is newer than the source.
      if (chunkStats.some(s => s != null && s.mtimeMs >= sourceMs)) return false
      return true
    }

    const sections = await Promise.all(
      Array.from(bySlug.values()).map(async s => ({
        ...s,
        // 'generated' = every chunk is on disk; 'partial' = some chunks
        // exist but the section isn't whole; 'not_generated' = nothing yet.
        status: s.present_chunks === 0 ? 'not_generated'
          : s.present_chunks < s.total_chunks ? 'partial'
          : 'generated',
        // Purely informational. Front-end shows a "⚠ stale" pill so the
        // user can choose to regenerate; we do NOT auto-delete.
        audio_stale: await isSectionStale(s.slug),
      })),
    )

    res.json({ audio_dir: status.audio_dir, sections })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute audio sections'))
  }
})

// GET /projects/:slug/episodes/:code/audio-file?section=<slug>[&part=N]
// Streams a generated section's audio so the user can listen IN-APP instead
// of digging into the audio folder in Finder. Reuses the reconciler's
// present-file view to resolve the filename, then hands off to res.sendFile
// (sets audio/mpeg + supports Range requests for seeking). Single-chunk
// sections are the norm; ?part selects a chunk for multi-part sections.
router.get('/projects/:slug/episodes/:code/audio-file', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const section = typeof req.query.section === 'string' ? req.query.section : ''
    if (!section) return res.status(400).json({ detail: 'section query param required' })

    const status = await getAudioStatus(slug, code)
    const path = await import('path')
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Match this section's chunk filenames: `<CODE>_<section>[_partN][_vN].mp3`
    // (the optional `_vN` is appended by "save as new version" audio runs).
    const re = new RegExp(`^${esc(code)}_${esc(section)}(?:_part\\d+)?(?:_v\\d+)?\\.mp3$`, 'i')
    const matches = (status.present || []).filter((f: string) => re.test(f)).sort()
    if (!matches.length) return res.status(404).json({ detail: 'No generated audio for this section yet' })

    const partRaw = typeof req.query.part === 'string' ? parseInt(req.query.part, 10) : 0
    const idx = Number.isFinite(partRaw) ? Math.max(0, Math.min(partRaw, matches.length - 1)) : 0
    const abs = path.resolve(status.audio_dir, matches[idx]!)

    // Path-traversal guard — the resolved file must live inside audio_dir.
    const dirAbs = path.resolve(status.audio_dir)
    if (abs !== dirAbs && !abs.startsWith(dirAbs + path.sep)) {
      return res.status(400).json({ detail: 'Invalid path' })
    }
    // Content-Type by CONTENT, not extension: Voice Studio (Kokoro etc.)
    // returns WAV bytes that we persist under a `.mp3` name, so trusting the
    // extension would mislabel them audio/mpeg and some players choke. Sniff
    // the RIFF/WAVE header and serve audio/wav; otherwise default to mpeg.
    let contentType = 'audio/mpeg'
    try {
      const fsp = await import('fs/promises')
      const fh = await fsp.open(abs, 'r')
      try {
        const buf = Buffer.alloc(12)
        await fh.read(buf, 0, 12, 0)
        if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
          contentType = 'audio/wav'
        }
      } finally {
        await fh.close()
      }
    } catch { /* unreadable → let sendFile fail below with a 404 */ }
    res.sendFile(abs, { headers: { 'Content-Type': contentType } }, (err: any) => {
      if (err && !res.headersSent) res.status(404).json({ detail: 'Audio file not found on disk' })
    })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not load audio file'))
  }
})

router.post('/projects/:slug/episodes/:code/audio-repair', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(req.params.slug)
    if (!config) return res.status(400).json({ detail: 'Project config missing' })

    // Recovery is deliberately GenStudio-only. Legacy provider evidence is
    // reported as non-executable and must be regenerated through GenStudio.
    const result = await reconcileAudio(req.params.slug, req.params.code)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Repair failed'))
  }
})

// ── Ingest externally-generated chapter audio ──────────────────────────────
//
// Lets an external tool (the Fish TTS Chrome extension) hand back narration
// it generated with the user's fish.audio WEB plan, so the bytes land in the
// episode's real "07 Audio Assets" folder as `{CODE}_{slug}.mp3` — exactly
// what Audio Assembly would have written. We then rebuild audio_chapters.json
// from the per-chapter files on disk so merge / subtitles / video pick it up.
//
// Reuses the generator's own path resolution (findNarrationFile +
// resolveAudioDir) so naming + media-root routing stay identical to native
// generation. The request carries a base64 audio blob (≤10 MB JSON body).
//
// Body: { chapterNumber?: number, slug?: string, audioBase64: string,
//         format?: 'mp3' | 'wav', rebuildSidecar?: boolean }
// Either `chapterNumber` (→ slug "Chapter_NN") or an explicit `slug` is required.
router.post('/projects/:slug/episodes/:code/audio-ingest', async (req, res) => {
  const { slug } = req.params
  const code = req.params.code.toUpperCase()
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const audioBase64 = req.body?.audioBase64
    const n = Number(req.body?.chapterNumber)
    const sectionSlug =
      typeof req.body?.slug === 'string' && req.body.slug.trim()
        ? req.body.slug.trim()
        : Number.isFinite(n)
          ? `Chapter_${String(n).padStart(2, '0')}`
          : ''
    if (!sectionSlug) return res.status(400).json({ detail: 'Provide chapterNumber or slug.' })
    if (typeof audioBase64 !== 'string' || !audioBase64) {
      return res.status(400).json({ detail: 'audioBase64 is required.' })
    }
    const ext = req.body?.format === 'wav' ? 'wav' : 'mp3'

    const fs = await import('fs/promises')
    const path = await import('path')
    const { findNarrationFile, resolveAudioDir } = await import('../generators/audio.js')

    let narrationPath: string
    try {
      narrationPath = await findNarrationFile(slug, code)
    } catch {
      return res.status(404).json({ detail: 'No narration found for this episode. Generate the script first.' })
    }
    const audioDir = await resolveAudioDir(slug, narrationPath, code)
    await fs.mkdir(audioDir, { recursive: true })

    const buf = Buffer.from(audioBase64, 'base64')
    if (!buf.length) return res.status(400).json({ detail: 'Decoded audio is empty.' })
    const filename = `${code}_${sectionSlug}.${ext}`
    await fs.writeFile(path.join(audioDir, filename), buf)

    // Rebuild audio_chapters.json from every chapter file on disk so the new
    // file's duration is folded in. The sidecar lives at the episode root
    // (sibling of the audio folder); derive it the same way resolveAudioDir
    // derives the episode dir from the narration path.
    let sections: number | null = null
    if (req.body?.rebuildSidecar !== false) {
      const parent = path.dirname(narrationPath)
      const isScript = path.basename(parent).replace(/^✅\s*/, '').toLowerCase().includes('script')
      const episodeDir = isScript ? path.dirname(parent) : parent
      const { reconstructAudioChapters } = await import('../lib/audio-chapters-reconstruct.js')
      const rebuilt = await reconstructAudioChapters({ audioDir, episodeCode: code })
      if (rebuilt) {
        await fs.writeFile(
          path.join(episodeDir, 'audio_chapters.json'),
          JSON.stringify(
            {
              sections: rebuilt.sections.map((s) => ({
                slug: s.slug,
                duration_s: s.duration_s,
                source_file: s.source_file,
              })),
              gap_duration_s: rebuilt.gap_duration_s,
              reconstructed: true,
            },
            null,
            2,
          ),
          'utf-8',
        )
        sections = rebuilt.sections.length
      }
    }

    // Drop the cached episode status so audio-sections reflects the new file.
    try {
      const { episodeStatusCache } = await import('../services/episode-status-cache.js')
      episodeStatusCache.invalidate(slug, code)
    } catch {
      /* cache is best-effort */
    }

    res.json({ ok: true, saved_as: filename, audio_dir: audioDir, sections })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audio ingest failed'))
  }
})
