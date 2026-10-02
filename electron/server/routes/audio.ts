import { Router } from 'express'
import path from 'path'
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
  listTranscriptionModels as listGenStudioTranscriptionModels,
  listVoices as listGenStudioVoices,
  listTtsModels as listGenStudioTtsModels,
  quoteGenStudioTranscription,
} from '../lib/genstudio-client.js'
import { unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import { resolveChosenChatModel } from '../services/genstudio-default-model.js'
import { resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { inspectSubtitleSourceFreshness } from '../services/subtitle-completion.js'
import { findFreshActionJob, readOperationId, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { withLock } from '../lib/atomic-store.js'
import { inspectAudioQualityActionScope } from '../services/audio-quality.js'
import { readAudioQualityProvenance, updateAudioQualityProvenance } from '../services/audio-quality-store.js'
import { readSubtitleSourceModels } from '../services/subtitle-recovery.js'
import { stageActiveAudioQualityCheck } from '../services/audio-quality-transcription.js'

export const router = Router()

/**
 * Resolve the default text model for an expression-markup run when the
 * caller didn't specify one. Never falls back to a hardcoded external
 * product id — GenStudio owns the catalog, so this asks it directly and
 * prefers the project's saved `prompt_model` preference when still usable.
 */
async function resolveExpressionDefaultModel(config: any): Promise<string> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    throw new Error('No Gateway key configured. Add it in Settings → This Mac before generating expression markup.')
  }
  const saved = typeof config?.prompt_model === 'string' ? config.prompt_model : null
  return resolveChosenChatModel(apiKey, saved, 'the Audio Generator page (Expression tags)')
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
      detail: 'No Gateway key configured. Add it in Settings → This Mac.',
    })
  }

  try {
    const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === migratedModel)
    if (!ttsModel) {
      return res.status(409).json({ detail: `The saved voice model "${req.body.model}" is not currently in your Gateway catalogue.` })
    }
    if (!ttsModel.generation_enabled) {
      return res.status(409).json({ detail: `The Gateway has generation turned off for ${ttsModel.display_name}. Choose another voice model.` })
    }
    if (ttsModel.locked) {
      return res.status(409).json({ detail: `${ttsModel.display_name} is locked for this Gateway account. Choose an unlocked voice model.` })
    }
    const voices = await listGenStudioVoices(apiKey, { modelId: migratedModel })
    const selectedVoice = voices.find(voice => voice.id === req.body.voice && voice.generation_enabled !== false)
    if (!selectedVoice || !catalogHasVoice(voices, req.body.voice)) {
      return res.status(400).json({
        detail: `The selected voice is not available on ${ttsModel.display_name} in your Gateway catalog. `
          + 'Refresh the voice picker and choose an available voice.',
      })
    }
    // voice_tier is published metadata, kept beside the job for history. It is
    // no longer a selector and no longer a price band.
    if (selectedVoice.voice_tier) req.body.tts_tier = selectedVoice.voice_tier
  } catch (error: any) {
    return res.status(502).json(humanizeBackendError(error, 'Could not verify the Gateway voice catalog'))
  }
  const deliberateFresh = req.body.force === true || req.body.no_overwrite === true
  let operationId: string | null
  try {
    operationId = readOperationId(req.body, deliberateFresh)
  } catch (error) {
    return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
  }
  // Only the quality-confirm route can stamp a staged candidate. A public
  // Audio request may deliberately be fresh, but it cannot choose an internal
  // staging path or bypass active-output publication through this marker.
  const publicBody = { ...req.body }
  delete publicBody.quality_repair
  delete publicBody.quality_check
  const params = operationId
    ? stampFreshGenerationAction(publicBody, operationId)
    : (() => { const clean = { ...publicBody }; delete clean.generation_action; delete clean.operation_id; return clean })()
  const enqueueAudio = async () => {
    if (operationId) {
      const previous = findFreshActionJob(await jq.getJobs(slug), operationId)
      if (previous) {
        if (previous.params.generation_action_fingerprint !== params.generation_action_fingerprint) {
          return res.status(409).json({ detail: 'This operation_id already belongs to a different audio request.' })
        }
        return res.status(200).json({ ...previous, reused: true })
      }
    }
    if (jq.isDuplicate(slug, req.body.episode_id, 'audio')) {
      return res.status(409).json({ detail: `Audio generation already queued/running for ${req.body.episode_id}` })
    }

    const job = await jq.enqueue({
      project_slug: slug,
      type: 'audio',
      episode_id: req.body.episode_id,
      title: `Audio (${req.body.sections || 'all'})`,
      params,
    })
    return res.status(201).json(job)
  }
  if (operationId) return withLock(`fresh-audio:${slug}:${operationId}`, enqueueAudio)
  return enqueueAudio()
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
      detail: 'No Gateway key configured. Add it in Settings → This Mac.',
    })
  }
  const resolvedVoiceId = typeof voice_id === 'string' ? voice_id.trim() : ''
  if (!resolvedVoiceId) return res.status(400).json({ detail: 'Select a Gateway voice before previewing.' })

  try {
    // Scoped by the model this preview belongs to. GenStudio requires
    // `model_id` on `/v1/voices` (ADR-0016) and answers 422 without it, so an
    // unscoped read here failed the preview for a perfectly valid voice. The
    // model was already resolved and validated above — pass it.
    const voices = await listGenStudioVoices(apiKey, { modelId: migratedModel })
    const voice = voices.find(entry => entry.id === resolvedVoiceId)
    if (!voice) {
      return res.status(404).json({ detail: 'That voice is no longer available in your Gateway catalog.' })
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

/** Quote the exact selected candidate TTS scope without submitting work. */
async function quoteCandidateTts(input: {
  slug: string; code: string; modelId: string; voiceId: string; sections: string[]; speed?: unknown; controls?: unknown
}): Promise<Record<string, unknown>> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('No Gateway key configured.')
  const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === input.modelId)
  if (!ttsModel || !ttsModel.generation_enabled || ttsModel.locked) throw new Error('The selected voice model is no longer available for generation.')
  const voices = await listGenStudioVoices(apiKey, { modelId: input.modelId })
  const voice = voices.find(entry => entry.id === input.voiceId && entry.generation_enabled !== false)
  if (!voice || !catalogHasVoice(voices, input.voiceId)) throw new Error('The selected voice is no longer available on that model.')
  const { findNarrationFile } = await import('../generators/audio.js')
  const narration = await findNarrationFile(input.slug, input.code)
  const { parseNarrationDocx } = await import('../lib/docx-parser.js')
  const { flattenTtsRequestPlan, normalizeSectionsForTts, planGenStudioTtsRequests, resolveTtsRequestBudget, selectNarrationSections } = await import('../services/tts-request-plan.js')
  const allSections = await parseNarrationDocx(narration)
  normalizeSectionsForTts(allSections)
  const selected = selectNarrationSections(allSections, input.sections.join(','))
  if (selected.length !== input.sections.length) throw new Error('The selected narration scope changed before it could be quoted.')
  const budget = resolveTtsRequestBudget(ttsModel)
  const requests = flattenTtsRequestPlan(planGenStudioTtsRequests(selected, budget.effective))
  const { requestGenStudioTtsQuote, resolveGenStudioTtsSpeed } = await import('../lib/genstudio-client.js')
  const { resolveTtsControlValues } = await import('../lib/tts-controls.js')
  const { quoteNarrationRequests } = await import('../services/tts-narration-quote.js')
  const controls = resolveTtsControlValues(ttsModel.controls, input.controls as Record<string, unknown> | null | undefined)
  const quote = await quoteNarrationRequests({
    requests, quoteEnabled: voice.quote_enabled !== false,
    quoteRequest: text => requestGenStudioTtsQuote(apiKey, {
      modelId: input.modelId, voiceId: input.voiceId, text,
      speed: resolveGenStudioTtsSpeed(input.speed, ttsModel.supports_speed, ttsModel.minimum_speed, ttsModel.maximum_speed),
      supportsSpeed: ttsModel.supports_speed,
      minimumSpeed: ttsModel.minimum_speed,
      maximumSpeed: ttsModel.maximum_speed,
      controls,
    }),
  })
  return { ...quote, model_id: ttsModel.id, model_name: ttsModel.display_name,
    ...(ttsModel.provider_name ? { provider_name: ttsModel.provider_name } : {}), controls,
    section_count: selected.length, planned_request_characters: budget.effective,
    request_safety_margin: budget.safety_margin }
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
        detail: 'No Gateway key configured. Add it in Settings → This Mac.',
      })
    }

    // The boundary and the price in force are read live, from the model the
    // customer selected. Nothing here is remembered between requests.
    const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === modelId)
    if (!ttsModel) {
      return res.status(409).json({ detail: `The selected voice model "${modelId}" is not currently in your Gateway catalogue.` })
    }
    if (!ttsModel.generation_enabled || ttsModel.locked) {
      return res.status(409).json({ detail: `${ttsModel.display_name} is not available for generation on this Gateway account.` })
    }
    const voices = await listGenStudioVoices(apiKey, { modelId })
    const voice = voices.find(candidate => candidate.id === voiceId)
    if (!voice) {
      return res.status(400).json({
        detail: `The selected voice is not available on ${ttsModel.display_name} in your Gateway catalog.`,
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

    const { requestGenStudioTtsQuote, resolveGenStudioTtsSpeed } = await import('../lib/genstudio-client.js')
    const speed = resolveGenStudioTtsSpeed(req.body?.speed, ttsModel.supports_speed, ttsModel.minimum_speed, ttsModel.maximum_speed)
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
        speed,
        supportsSpeed: ttsModel.supports_speed,
        minimumSpeed: ttsModel.minimum_speed,
        maximumSpeed: ttsModel.maximum_speed,
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
    res.status(502).json(humanizeBackendError(e, 'Could not get the Gateway quotes for this narration'))
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
    const model = requestedModel || await resolveExpressionDefaultModel(config)
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
      params: { episode_id: code, model, dialect },
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
    const model = requestedModel || await resolveExpressionDefaultModel(config)
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
    res.json({ model, generated_at, sections })
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
    // Quality inspection parses and aligns raw subtitles. Keep the ordinary
    // Audio selector cheap when the project has deliberately left this opt-in
    // workflow off.
    const qualityEnabled = (await pm.getConfig(req.params.slug))?.audio_quality?.mode !== 'off'
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

    let staleSubtitleSections = new Set<string>()
    let qualityBySection = new Map<string, any>()
    let qualityRepairBySection = new Map<string, any>()
    const activeChecksBySection = new Map<string, any>()
    try {
      const paths = await resolveEpisodePathsByCodeWithSidecar(req.params.slug, req.params.code, 'audio_chapters.json')
      const freshness = await inspectSubtitleSourceFreshness(
        paths.episode_dir,
        paths.audio_dir,
        paths.subtitles_dir,
        req.params.code,
      )
      staleSubtitleSections = new Set(freshness.stale_sections.map(section => section.toLowerCase()))
      if (qualityEnabled && scriptDir) {
        const { inspectChapterAudioQuality } = await import('../services/audio-quality.js')
        const quality = await inspectChapterAudioQuality({
          episodeDir: paths.episode_dir,
          audioDir: paths.audio_dir,
          subtitlesDir: paths.subtitles_dir,
          scriptDir,
          episodeCode: req.params.code,
        })
        qualityBySection = new Map(quality.chapters.map(row => [row.slug.toLowerCase(), row]))
      }
      const qualityActions = qualityEnabled ? await readAudioQualityProvenance(paths.episode_dir) : null
      const newestActions = Object.values(qualityActions?.actions || {})
        .filter(action => ['candidate_ready', 'needs_approval', 'still_needs_review', 'fixed'].includes(action.state))
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
      const newestActiveChecks = Object.values(qualityActions?.actions || {})
        .filter(action => !!action.active_check)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
      const currentActionScope = async (action: NonNullable<typeof newestActions[number]>) => {
        if (!scriptDir) return null
        try {
          return await inspectAudioQualityActionScope({
            episodeDir: paths.episode_dir, audioDir: paths.audio_dir, subtitlesDir: paths.subtitles_dir,
            scriptDir, episodeCode: req.params.code,
          }, action.sections)
        } catch {
          return null
        }
      }
      const matchesOriginalActionScope = async (action: NonNullable<typeof newestActions[number]>) => {
        const scope = await currentActionScope(action)
        return !!scope && scope.source_fingerprint === action.source_fingerprint
      }
      const matchesPromotedCandidate = async (action: NonNullable<typeof newestActions[number]>) => {
        const candidate = action.candidate
        const scope = await currentActionScope(action)
        if (!candidate?.promoted_files || !candidate.candidate_audio_hashes || !scope
          || !action.script_fingerprint || scope.script_fingerprint !== action.script_fingerprint) return false
        return action.sections.every(section => (
          JSON.stringify(scope.source_files[section]) === JSON.stringify(candidate.promoted_files?.[section])
          && scope.source_audio_hashes[section] === candidate.candidate_audio_hashes?.[section]
        ))
      }
      for (const action of newestActiveChecks) {
        // A check is evidence about the exact active map and script quoted by
        // that action. A later ordinary Regenerate makes it history, never a
        // current passing/held row state.
        if (!await matchesOriginalActionScope(action)) continue
        const active = action.active_check!
        for (const actionSection of action.sections) {
          const key = actionSection.toLowerCase()
          if (activeChecksBySection.has(key)) continue
          activeChecksBySection.set(key, {
            action_id: action.action_id, source_fingerprint: action.source_fingerprint,
            sections: action.sections, state: active.state, model_id: active.model_id,
            verification: {
              ...(active.credit_ceiling !== undefined ? { credit_ceiling: active.credit_ceiling } : {}),
              ...(active.committed_credits !== undefined ? { committed_credits: active.committed_credits } : {}),
              quotes: Object.fromEntries(action.sections.flatMap(section => active.quotes[section]
                ? [[section, active.quotes[section]]] : [])),
            },
          })
        }
      }
      for (const action of newestActions) {
        const current = ['candidate_ready', 'fixed'].includes(action.state)
          ? await matchesPromotedCandidate(action)
          : await matchesOriginalActionScope(action)
        if (!current) continue
        // A historical Fixed badge is only true while its selected active
        // sources still inspect as current. A later ordinary regeneration or
        // script edit must surface Review needed instead of preserving an old
        // completion claim from the sidecar.
        if (action.state === 'fixed' && action.sections.some(section =>
          qualityBySection.get(section.toLowerCase())?.state !== 'no_issue_detected')) continue
        for (const actionSection of action.sections) {
          const key = actionSection.toLowerCase()
          if (qualityRepairBySection.has(key)) continue
          qualityRepairBySection.set(key, {
            action_id: action.action_id,
            source_fingerprint: action.source_fingerprint,
            sections: action.sections,
            state: action.state,
            ...(action.candidate ? { candidate: { model_id: action.candidate.model_id, voice_id: action.candidate.voice_id } } : {}),
            ...(action.verification_credit_ceiling !== undefined ? { verification: {
              credit_ceiling: action.verification_credit_ceiling,
              // model-drift-allow: local verification ledger begins at zero before a provider confirmation.
              committed_credits: action.verification_committed_credits || 0,
              ...(action.verification_quote ? action.verification_quote : {}),
            } } : {}),
            ...(action.refresh_needed ? { refresh_needed: action.refresh_needed } : {}),
          })
        }
      }
    } catch { /* status remains available when no assembled subtitle source exists */ }

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
        subtitles_stale: staleSubtitleSections.has(s.slug.toLowerCase()),
        ...(qualityBySection.has(s.slug.toLowerCase())
          ? { quality: {
            ...qualityBySection.get(s.slug.toLowerCase()),
            ...(qualityRepairBySection.has(s.slug.toLowerCase())
              ? { repair: qualityRepairBySection.get(s.slug.toLowerCase()) } : {}),
            ...(activeChecksBySection.has(s.slug.toLowerCase())
              ? { active_check: activeChecksBySection.get(s.slug.toLowerCase()) } : {}),
          } }
          : {}),
      })),
    )

    res.json({ audio_dir: status.audio_dir, sections })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute audio sections'))
  }
})

/**
 * Inspect an exact active-audio scope before a possible quality repair. The
 * check itself is local: it intentionally does not enqueue, quote, or submit
 * provider work. A later confirmation must prove the returned fingerprint is
 * still current before it can stage a candidate.
 */
router.post('/projects/:slug/episodes/:code/audio-quality/check', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    let operationId: string | null
    try {
      operationId = readOperationId(req.body, true)
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
    }
    const config = await pm.getConfig(slug)
    const mode = config?.audio_quality?.mode
    if (mode !== 'flag_issues' && mode !== 'check_and_repair') {
      return res.status(409).json({ detail: 'Enable Audio quality checks in Project Settings before checking chapters.' })
    }
    const requestedSections = Array.isArray(req.body?.sections)
      ? req.body.sections.filter((value: unknown): value is string => typeof value === 'string')
      : []
    const { findNarrationFile } = await import('../generators/audio.js')
    const narration = await findNarrationFile(slug, code).catch(() => null)
    if (!narration) return res.status(404).json({ detail: 'No narration was found for this episode.' })
    const path = await import('path')
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
    const scope = await inspectAudioQualityActionScope({
      episodeDir: paths.episode_dir,
      audioDir: paths.audio_dir,
      subtitlesDir: paths.subtitles_dir,
      scriptDir: path.dirname(narration),
      episodeCode: code,
    }, requestedSections)
    const analysisOnly = req.body?.analysis_only === true
    if (mode === 'check_and_repair' && !analysisOnly) {
      await updateAudioQualityProvenance(paths.episode_dir, current => {
        current.actions ||= {}
        const prior = current.actions[operationId!]
        if (prior && (prior.scope_fingerprint !== scope.scope_fingerprint || prior.source_fingerprint !== scope.source_fingerprint)) {
          throw new Error('This operation_id belongs to a different or now-stale audio-quality scope. Start a new check.')
        }
        current.actions[operationId!] ||= {
          action_id: operationId!,
          scope_fingerprint: scope.scope_fingerprint,
          source_fingerprint: scope.source_fingerprint,
          script_fingerprint: scope.script_fingerprint,
          sections: scope.sections,
          source_files: scope.source_files,
          mode: 'check_and_repair',
          state: 'checked',
          created_at: new Date().toISOString(),
        }
      })
    }
    const detectedIssue = scope.quality.some(row => row.state === 'review_needed')
    // Detection is advisory. A deliberate user-selected candidate repair has
    // its own authority: the check persists the exact current audio/script
    // fingerprint, then confirm re-proves it before any spend. That keeps an
    // old/missing SRT or changed script from becoming a dead end when the user
    // already knows the active narration needs replacement.
    const legacyUnverified = scope.quality.some(row => row.provenance === 'legacy')
    const sourceFactsChanged = scope.quality.some(row =>
      ['subtitle_stale', 'subtitle_missing', 'active_source_changed', 'script_changed'].includes(row.reason_code))
    const alternate = typeof config?.audio_quality?.alternate_transcription_model === 'string'
      ? config.audio_quality.alternate_transcription_model.trim() : ''
    const candidate = req.body?.candidate_audio && typeof req.body.candidate_audio === 'object'
      ? req.body.candidate_audio as Record<string, unknown> : null
    const hasCandidate = !!candidate
      && typeof candidate.model === 'string' && !!candidate.model.trim()
      && typeof candidate.voice === 'string' && !!candidate.voice.trim()
    const candidateEligibleScope = hasCandidate
    const eligible = mode === 'check_and_repair' && !analysisOnly && candidateEligibleScope && !!alternate
    const candidateQuote = eligible
      ? await quoteCandidateTts({
        slug, code, modelId: String(candidate!.model).trim(), voiceId: String(candidate!.voice).trim(),
        sections: scope.sections, speed: candidate!.speed, controls: candidate!.controls,
      })
      : null
    res.json({
      action_id: operationId,
      sections: scope.quality.map(quality => ({ slug: quality.slug, quality: {
        ...quality,
        source_fingerprint: scope.source_fingerprint,
      } })),
      ...(mode === 'check_and_repair' && !analysisOnly ? {
        repair: {
          eligible,
          ...(candidateEligibleScope ? { source_fingerprint: scope.source_fingerprint } : {}),
          ...(alternate ? { alternate_model_id: alternate } : {}),
          diagnostic_issue_detected: detectedIssue,
          provenance_unavailable: legacyUnverified,
          source_facts_changed: sourceFactsChanged,
          requires_source_confirmation: true,
          transcription: { required: candidateEligibleScope },
          candidate_tts: { required: candidateEligibleScope, ...(candidateQuote ? { advisory_quote: candidateQuote } : {}) },
        },
      } : {}),
    })
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not check audio quality'))
  }
})

/**
 * Commit an already-inspected quality action before its candidate TTS work is
 * queued. A local check cannot become billable by itself, and an HTTP replay
 * rejoins the same server-owned fresh action.
 */
router.post('/projects/:slug/episodes/:code/audio-quality/confirm', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    let operationId: string | null
    try { operationId = readOperationId(req.body, true) }
    catch (error) { return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' }) }
    if (req.body?.confirm_repair !== true) {
      return res.status(400).json({ detail: 'Confirm this selected quality repair before candidate audio can be generated.' })
    }
    const ceiling = req.body?.verification_credit_ceiling
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
      return res.status(400).json({ detail: 'Choose a positive whole-credit verification allowance for this repair.' })
    }
    const candidate = req.body?.candidate_audio && typeof req.body.candidate_audio === 'object'
      ? req.body.candidate_audio as Record<string, unknown> : null
    const model = typeof candidate?.model === 'string' ? candidate.model.trim() : ''
    const voice = typeof candidate?.voice === 'string' ? candidate.voice.trim() : ''
    if (!model || !voice) return res.status(400).json({ detail: 'Choose a current voice model and voice for the staged candidate.' })

    const config = await pm.getConfig(slug)
    if (config?.audio_quality?.mode !== 'check_and_repair') {
      return res.status(409).json({ detail: 'Enable Check and repair in Project Settings before confirming a candidate.' })
    }
    const configuredAlternateModel = config.audio_quality.alternate_transcription_model?.trim() || ''
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) return res.status(400).json({ code: 'GENSTUDIO_KEY_REQUIRED', detail: 'No Gateway key configured. Add it in Settings → This Mac.' })
    const [ttsModels, voices, transcriptionModels] = await Promise.all([
      listGenStudioTtsModels(apiKey),
      listGenStudioVoices(apiKey, { modelId: model }),
      listGenStudioTranscriptionModels(apiKey),
    ])
    const ttsModel = ttsModels.find(entry => entry.id === model)
    if (!ttsModel || !ttsModel.generation_enabled || ttsModel.locked) {
      return res.status(409).json({ detail: 'That voice model is no longer eligible for candidate generation. Refresh and choose a current model.' })
    }
    const selectedVoice = voices.find(entry => entry.id === voice && entry.generation_enabled !== false)
    if (!selectedVoice || !catalogHasVoice(voices, voice)) {
      return res.status(409).json({ detail: 'That voice is no longer eligible on the selected model. Refresh and choose a current voice.' })
    }

    const { findNarrationFile } = await import('../generators/audio.js')
    const narration = await findNarrationFile(slug, code).catch(() => null)
    if (!narration) return res.status(404).json({ detail: 'No narration was found for this episode.' })
    const path = await import('path')
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
    const run = async () => {
      const saved = await readAudioQualityProvenance(paths.episode_dir)
      const action = saved.actions?.[operationId!]
      if (!action) return res.status(409).json({ detail: 'Check these selected chapters again before confirming repair.' })
      if (action.state === 'cancelled') return res.status(409).json({ detail: 'This repair action was cancelled. Check the selected chapters again.' })
      const alternateModel = action.verification_model_id || configuredAlternateModel
      if (!alternateModel) return res.status(409).json({ detail: 'Choose a published alternate transcription model in Project Settings before repair.' })
      const alternate = transcriptionModels.find(entry => entry.id === alternateModel)
      if (!alternate || !alternate.available || alternate.qualification_only) {
        return res.status(409).json({ detail: 'The alternate transcription model for this action is no longer eligible. The staged candidate was preserved.' })
      }
      const scope = await inspectAudioQualityActionScope({
        episodeDir: paths.episode_dir, audioDir: paths.audio_dir, subtitlesDir: paths.subtitles_dir,
        scriptDir: path.dirname(narration), episodeCode: code,
      }, action.sections)
      if (scope.scope_fingerprint !== action.scope_fingerprint || scope.source_fingerprint !== action.source_fingerprint
        || JSON.stringify(scope.source_files) !== JSON.stringify(action.source_files)) {
        return res.status(409).json({ detail: 'The selected audio or script changed after this check. Check it again before repair.' })
      }
      // A stale/missing subtitle or changed script is not a detector finding,
      // but an explicitly checked action still binds the current source and
      // script above. Allow that deliberate replacement; normal recovery and
      // ordinary Regenerate retain their existing behavior.
      if (typeof req.body?.source_fingerprint === 'string' && req.body.source_fingerprint !== action.source_fingerprint) {
        return res.status(409).json({ detail: 'This confirmation does not match the inspected source. Check the selected chapters again.' })
      }
      const resumingHeldCandidate = action.state === 'needs_approval'
        && !!action.candidate
        && action.candidate.model_id === model
        && action.candidate.voice_id === voice
        && typeof action.verification_credit_ceiling === 'number'
        && ceiling > action.verification_credit_ceiling
      if (action.candidate && !resumingHeldCandidate && (action.candidate.model_id !== model || action.candidate.voice_id !== voice
        || action.verification_credit_ceiling !== ceiling)) {
        return res.status(409).json({ detail: 'This operation_id already belongs to a different candidate repair.' })
      }
      const candidateSpeed = resumingHeldCandidate && action.candidate?.speed !== undefined
        ? action.candidate.speed : typeof candidate?.speed === 'number' ? candidate.speed : 1
      const candidateControls = resumingHeldCandidate
        ? action.candidate?.controls
        : candidate?.controls && typeof candidate.controls === 'object'
          ? candidate.controls as Record<string, number | boolean | string> : undefined
      // Alternate means a distinct published model id, not a provider label.
      // Old SRTs without durable model provenance remain visible for review but
      // cannot silently become an automatic paid repair.
      const sourceModels = await readSubtitleSourceModels(paths.subtitles_dir)
      const knownSameModel = action.sections.filter(section => {
        const modelId = sourceModels[`${code.toUpperCase()}_${section}.srt`]
        return !!modelId && modelId === alternateModel
      })
      if (knownSameModel.length) {
        return res.status(409).json({
          detail: `A distinct alternate ASR model is required for ${knownSameModel.join(', ')}. This known source model cannot independently verify the staged candidate.`,
        })
      }
      const params = stampFreshGenerationAction({
        episode_id: code, model, voice, sections: action.sections.join(','),
        speed: candidateSpeed,
        controls: candidateControls,
        force: true, no_overwrite: false,
        quality_repair: { action_id: operationId!, source_fingerprint: action.source_fingerprint, verification_credit_ceiling: ceiling },
      }, operationId!)
      const prior = findFreshActionJob(await jq.getJobs(slug), operationId!)
      if (prior) {
        if (!resumingHeldCandidate && prior.params.generation_action_fingerprint !== params.generation_action_fingerprint) {
          return res.status(409).json({ detail: 'This operation_id already belongs to a different candidate repair.' })
        }
        if (!resumingHeldCandidate) return res.status(200).json({ ...prior, reused: true })
      }
      await updateAudioQualityProvenance(paths.episode_dir, current => {
        const currentAction = current.actions?.[operationId!]
        if (!currentAction || currentAction.source_fingerprint !== action.source_fingerprint) {
          throw new Error('The selected source changed while this repair was being confirmed.')
        }
        currentAction.state = 'confirmed'
        currentAction.confirmed_at ||= new Date().toISOString()
        currentAction.verification_credit_ceiling = ceiling
        currentAction.verification_committed_credits ||= 0
        currentAction.verification_model_id ||= alternateModel
        currentAction.candidate = {
          model_id: model, voice_id: voice, speed: candidateSpeed,
          ...(candidateControls && Object.keys(candidateControls).length ? { controls: candidateControls } : {}),
          staging_dir: path.join('.audio-quality-candidates', operationId!),
          source_audio_hashes: scope.source_audio_hashes,
        }
      })
      try {
        const job = await jq.enqueue({
          project_slug: slug, type: 'audio', episode_id: code,
          title: `Audio quality candidate (${action.sections.join(', ')})`,
          dedupeParams: queued => queued?.generation_action?.id === operationId!, params,
        })
        return res.status(201).json(job)
      } catch (error) {
        if (error instanceof jq.DuplicateJobError) {
          const winner = findFreshActionJob(await jq.getJobs(slug), operationId!)
          if (winner && winner.params.generation_action_fingerprint === params.generation_action_fingerprint) {
            return res.status(200).json({ ...winner, reused: true })
          }
          return res.status(409).json({ detail: 'This operation_id already belongs to a different candidate repair.' })
        }
        throw error
      }
    }
    return withLock(`audio-quality-confirm:${slug}:${code}:${operationId}`, run)
  } catch (error: any) {
    return res.status(400).json(humanizeBackendError(error, 'Could not confirm audio quality repair'))
  }
})


/**
 * Quote a deliberately selected independent ASR check over the unchanged
 * active audio. This stages a private copy only; it never alters narration,
 * subtitles, or a repair candidate.
 */
router.post('/projects/:slug/episodes/:code/audio-quality/active-check/quote', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    let operationId: string | null
    try { operationId = readOperationId(req.body, true) }
    catch (error) { return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' }) }
    const requestedSections = Array.isArray(req.body?.sections)
      ? req.body.sections.filter((value: unknown): value is string => typeof value === 'string') : []
    const config = await pm.getConfig(slug)
    if (!config?.audio_quality || config.audio_quality.mode === 'off') {
      return res.status(409).json({ detail: 'Enable Audio quality checks in Project Settings before checking active narration.' })
    }
    const alternateModel = config.audio_quality.alternate_transcription_model?.trim() || ''
    if (!alternateModel) return res.status(409).json({ detail: 'Choose a published alternate transcription model in Project Settings first.' })
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) return res.status(400).json({ code: 'GENSTUDIO_KEY_REQUIRED', detail: 'No Gateway key configured. Add it in Settings → This Mac.' })
    const eligible = (await listGenStudioTranscriptionModels(apiKey)).find(model => model.id === alternateModel)
    if (!eligible || !eligible.available || eligible.qualification_only) {
      return res.status(409).json({ detail: 'The selected alternate transcription model is no longer available. Refresh Settings and choose another model.' })
    }
    const narration = await resolveNarrationOr404(slug, code, res)
    if (!narration) return
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
    const scope = await inspectAudioQualityActionScope({
      episodeDir: paths.episode_dir, audioDir: paths.audio_dir, subtitlesDir: paths.subtitles_dir,
      scriptDir: path.dirname(narration), episodeCode: code,
    }, requestedSections)
    const run = async () => {
      const priorAction = (await readAudioQualityProvenance(paths.episode_dir)).actions?.[operationId!]
      if (priorAction) {
        if (priorAction.scope_fingerprint !== scope.scope_fingerprint || priorAction.source_fingerprint !== scope.source_fingerprint
          || priorAction.active_check?.model_id !== alternateModel) {
          return res.status(409).json({ detail: 'This operation_id belongs to a different or now-stale active-audio check.' })
        }
        if (priorAction.active_check) {
          const priorQuotes = priorAction.active_check.quotes
          const total = Object.values(priorQuotes).reduce((sum, quote) => sum + (quote.quoted_credit_cost || 0), 0)
          return res.json({ action_id: operationId, source_fingerprint: scope.source_fingerprint, model_id: alternateModel,
            sections: scope.sections.map(section => ({ slug: section, window: { kind: 'whole_chapter', fallback: true }, quote: priorQuotes[section] })),
            ...(total ? { total_quoted_credits: total } : {}), state: priorAction.active_check.state,
            ...(priorAction.active_check.credit_ceiling !== undefined ? { verification_credit_ceiling: priorAction.active_check.credit_ceiling } : {}),
            ...(priorAction.active_check.committed_credits !== undefined ? { verification_committed_credits: priorAction.active_check.committed_credits } : {}),
          })
        }
      }
      const sourceModels = await readSubtitleSourceModels(paths.subtitles_dir)
      const unknownSource = scope.sections.filter(section => !sourceModels[`${code.toUpperCase()}_${section}.srt`])
      if (unknownSource.length) {
        return res.status(409).json({ detail: `An independent active-audio check needs a saved source ASR receipt for ${unknownSource.join(', ')}. This legacy evidence remains reviewable; use Regenerate or a confirmed candidate repair if replacement is intended.` })
      }
      const sameSource = scope.sections.filter(section => sourceModels[`${code.toUpperCase()}_${section}.srt`] === alternateModel)
      if (sameSource.length) {
        return res.status(409).json({ detail: `Choose a distinct alternate ASR model for ${sameSource.join(', ')}. The saved source model cannot independently corroborate active audio.` })
      }
      const actionRoot = path.join(paths.episode_dir, '.audio-quality-checks', operationId!)
      const staged: Record<string, { audioPath: string; audioHash: string }> = {}
      for (const section of scope.sections) {
        staged[section] = await stageActiveAudioQualityCheck({
          audioDir: paths.audio_dir, checkOutDir: path.join(actionRoot, 'audio'), section,
          sourceFiles: scope.source_files[section]!,
        })
      }
      const quotes: Record<string, { id: string; audio_hash: string; quoted_credit_cost?: number; price_version?: string }> = {}
      for (const section of scope.sections) {
        const stagedSection = staged[section]!
        const quoted = await quoteGenStudioTranscription(apiKey, {
          audioPath: stagedSection.audioPath, modelId: alternateModel,
          requestIdentity: `${slug}:${code.toUpperCase()}:audio-quality-active:${operationId}:${section}`,
          language: undefined, wordTimestamps: true,
        })
        quotes[section] = {
          id: quoted.quote.id, audio_hash: stagedSection.audioHash,
          ...(typeof quoted.quote.quoted_credit_cost === 'number' ? { quoted_credit_cost: quoted.quote.quoted_credit_cost } : {}),
          ...(typeof quoted.quote.price_version === 'string' ? { price_version: quoted.quote.price_version } : {}),
        }
      }
      await updateAudioQualityProvenance(paths.episode_dir, current => {
      current.actions ||= {}
      const prior = current.actions[operationId!]
      if (prior && (prior.scope_fingerprint !== scope.scope_fingerprint || prior.source_fingerprint !== scope.source_fingerprint
        || prior.active_check?.model_id !== alternateModel)) {
        throw new Error('This operation_id belongs to a different or now-stale active-audio check.')
      }
      current.actions[operationId!] = {
        ...(prior || {
          action_id: operationId!, scope_fingerprint: scope.scope_fingerprint, source_fingerprint: scope.source_fingerprint,
          script_fingerprint: scope.script_fingerprint, sections: scope.sections, source_files: scope.source_files,
          mode: config.audio_quality!.mode, state: 'checked', created_at: new Date().toISOString(),
        }),
        active_check: { model_id: alternateModel, staging_dir: path.join('.audio-quality-checks', operationId!), state: 'quoted', quotes },
      }
      })
      const total = Object.values(quotes).reduce((sum, quote) => sum + (quote.quoted_credit_cost || 0), 0)
      return res.json({ action_id: operationId, source_fingerprint: scope.source_fingerprint, model_id: alternateModel,
        sections: scope.sections.map(section => ({ slug: section, window: { kind: 'whole_chapter', fallback: true }, quote: quotes[section] })),
        ...(total ? { total_quoted_credits: total } : {}), state: 'quoted' })
    }
    return await withLock(`audio-quality-active-check:${slug}:${code}:${operationId}`, run)
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not quote an active-audio quality check'))
  }
})

/** Confirm an already quoted active-audio ASR check within its stated ceiling. */
router.post('/projects/:slug/episodes/:code/audio-quality/active-check/confirm', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    let operationId: string | null
    try { operationId = readOperationId(req.body, true) }
    catch (error) { return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' }) }
    const ceiling = req.body?.verification_credit_ceiling
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) return res.status(400).json({ detail: 'Choose a positive whole-credit verification allowance.' })
    if (typeof req.body?.source_fingerprint !== 'string' || !req.body.source_fingerprint) {
      return res.status(400).json({ detail: 'Confirm the exact quoted active-audio source.' })
    }
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
    const run = async () => {
      const saved = await readAudioQualityProvenance(paths.episode_dir)
      const action = saved.actions?.[operationId!]
      const active = action?.active_check
      if (!action || !active || action.source_fingerprint !== req.body.source_fingerprint) {
        return res.status(409).json({ detail: 'This active-audio quote is no longer actionable. Quote the selected chapters again.' })
      }
      const config = await pm.getConfig(slug)
      if (!config?.audio_quality || config.audio_quality.mode === 'off'
        || config.audio_quality.alternate_transcription_model?.trim() !== active.model_id) {
        return res.status(409).json({ detail: 'The configured alternate transcription model changed. Quote the selected chapters again.' })
      }
      const params = stampFreshGenerationAction({ episode_id: code.toUpperCase(), model: active.model_id, sections: action.sections.join(','), speed: 1,
        force: false, no_overwrite: true,
        quality_check: { action_id: operationId!, source_fingerprint: action.source_fingerprint, verification_credit_ceiling: ceiling },
      }, operationId!)
      const prior = findFreshActionJob(await jq.getJobs(slug), operationId!)
      const resumingHeldCheck = active.state === 'needs_approval'
        && typeof active.credit_ceiling === 'number' && ceiling > active.credit_ceiling
      if (prior && !resumingHeldCheck) {
        if (prior.params.generation_action_fingerprint !== params.generation_action_fingerprint) return res.status(409).json({ detail: 'This operation_id belongs to a different active-audio check.' })
        return res.status(200).json({ ...prior, reused: true })
      }
      if (!['quoted', 'needs_approval'].includes(active.state)) {
        return res.status(409).json({ detail: 'This active-audio check has already finished. Start a new check for a new source scope.' })
      }
      await updateAudioQualityProvenance(paths.episode_dir, current => {
        const pending = current.actions?.[operationId!]?.active_check
        if (!pending || pending.state === 'no_issue_detected' || pending.state === 'review_needed') throw new Error('This active-audio check is no longer actionable.')
        pending.credit_ceiling = ceiling
        pending.committed_credits ||= 0
        pending.state = 'checking'
      })
      try {
        const job = await jq.enqueue({ project_slug: slug, type: 'audio', episode_id: code.toUpperCase(),
          title: `Check active narration quality (${action.sections.join(', ')})`, params,
          dedupeParams: queued => queued?.generation_action?.id === operationId!,
        })
        return res.status(201).json(job)
      } catch (error) {
        if (error instanceof jq.DuplicateJobError) {
          const winner = findFreshActionJob(await jq.getJobs(slug), operationId!)
          if (winner && winner.params.generation_action_fingerprint === params.generation_action_fingerprint) return res.status(200).json({ ...winner, reused: true })
          return res.status(409).json({ detail: 'This operation_id belongs to a different active-audio check.' })
        }
        throw error
      }
    }
    return await withLock(`audio-quality-active-check:${slug}:${code}:${operationId}`, run)
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not confirm an active-audio quality check'))
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
    // The reconciler's present list is the fallback when no verified active
    // mapping is available. Keep multi-part files in numeric order: lexical
    // ordering would put `_part10` before `_part2`.
    const compareParts = (left: string, right: string) => left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
    let matches = (status.present || []).filter((f: string) => re.test(f)).sort(compareParts)
    // A promoted verified candidate is selected through audio_chapters.json.
    // Prefer that exact active mapping over directory ordering, which would
    // otherwise play the historical base file beside its retained `_vN` copy.
    try {
      const fsp = await import('fs/promises')
      const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'audio_chapters.json')
      const sidecar = JSON.parse(await fsp.readFile(path.join(paths.episode_dir, 'audio_chapters.json'), 'utf8')) as {
        sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>
      }
      const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
      const selected = (sidecar.sections || []).find(row => typeof row.slug === 'string' && normalized(row.slug) === normalized(section))
      const sourceFiles = Array.isArray(selected?.source_files) ? selected.source_files : null
      // An active list is all-or-nothing. Ignoring an unsafe member would turn
      // a damaged selected map into a shorter, plausible playlist.
      const invalidListed = !!sourceFiles?.some(file => typeof file !== 'string' || path.basename(file) !== file)
      const listed: string[] = sourceFiles && !invalidListed ? sourceFiles as string[] : []
      const source = typeof selected?.source_file === 'string' && path.basename(selected.source_file) === selected.source_file
        ? [selected.source_file] : []
      const mapped = listed.length ? listed : source
      // The reconciler reports expected filenames, so a promoted `_vN` file
      // may be present on disk without appearing in `status.present`. Check
      // the active map against the real audio directory instead; that lets an
      // exact verified selection win without admitting another section or a
      // path outside the episode's audio folder.
      const mappedPresent = await Promise.all(mapped.map(async file => {
        if (!re.test(file)) return false
        try {
          return (await fsp.stat(path.join(status.audio_dir, file))).isFile()
        } catch {
          return false
        }
      }))
      const sidecarSelectsAudio = sourceFiles !== null || typeof selected?.source_file === 'string'
      if (sidecarSelectsAudio) {
        // Do not quietly play a retained base version when the authoritative
        // selection is incomplete. The customer needs to repair or regenerate
        // the selected audio, not hear a plausible but superseded recording.
        if (invalidListed || !mapped.length || !mappedPresent.every(Boolean)) {
          return res.status(404).json({ detail: 'The selected active audio for this section is unavailable on disk' })
        }
        matches = mapped
      }
    } catch { /* Fall back to the ordinary reconciled file list. */ }
    if (!matches.length) return res.status(404).json({ detail: 'No generated audio for this section yet' })

    // A read-only manifest lets native chapter playback queue every chunk
    // before opening the first one. It intentionally exposes only filenames:
    // callers keep using this route for bytes, so no filesystem path leaks.
    if (req.query.info === '1') {
      return res.json({ parts: matches.map((filename, part) => ({ part, filename })) })
    }

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
    // `sectionSlug` becomes a FILENAME below (`${code}_${sectionSlug}.${ext}`) and
    // is then written with `fs.writeFile`. It arrives from the request body with
    // only a `.trim()`, so `{"slug":"../../../../tmp/pwn"}` wrote outside the
    // project — an arbitrary-path file write of up to the body cap. A section
    // slug is a name: a path separator, a NUL, or a leading dot is never
    // legitimate, and traversal needs one of those.
    if (/[/\\\u0000]/.test(sectionSlug) || sectionSlug.startsWith('.')) {
      return res.status(400).json({ detail: 'Invalid slug — a chapter slug cannot contain a path separator.' })
    }
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
