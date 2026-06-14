import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { registry } from '../providers/registry.js'
import { resolveArtifact } from '../lib/episode-artifacts.js'
import { validateBody } from '../lib/validate.js'
import { GenerateAudioSchema } from '../schemas/index.js'
import { generateTtsBuffer } from '../lib/elevenlabs-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { parseEndpoints } from '../lib/endpoint-pool.js'
import { getAudioStatus, reconcileAudioViaGenaipro } from '../services/audio-reconciler.js'
import { TtlCache, swrFetch } from '../lib/ttl-cache.js'
import type { AudioModelConfig } from '../models/types.js'

export const router = Router()

// v1.0.255 — the Voice Studio URL setting may hold several endpoints (one per
// Mac) for the TTS pool; single-endpoint ops (health/voices/availability) use
// the first. Render distribution happens in generators/audio.ts.
const vsFirst = (stored: string | null | undefined): string => parseEndpoints(stored)[0] || ''

// v1.0.337 — stale-while-revalidate caches for the provider probes the voice
// picker hits on every open. On big projects these requests used to queue
// behind episode-status disk scans and time out → empty dropdowns ("missing
// providers"). Now: repeat opens within the TTL are instant, and a failed
// probe serves the last-known-good list (flagged `stale: true`) instead of
// nothing. `?refresh=1` (sent by the picker's refresh button) bypasses.
const vsVoicesCache = new TtlCache<object>(60_000)        // pool/voicepack voices — users add clips occasionally
const vsModelsCache = new TtlCache<object>(60_000)        // available engines on the modal
const vsTranscribeCache = new TtlCache<object>(60_000)    // whisper availability
const macosVoicesCache = new TtlCache<object>(10 * 60_000) // changes only when user installs voices in System Settings

/** Pick the TTS provider for a model id, mirroring generators/audio.ts. */
function resolveAudioProvider(
  modelId: string | undefined,
  audioModels: Record<string, AudioModelConfig> | undefined,
): 'fal' | 'genaipro' | 'elevenlabs' | 'voicestudio' | 'macos' | 'fishaudio' {
  if (!modelId) return 'fal'
  const entry = audioModels?.[modelId]
  if (entry?.provider) return entry.provider
  if (modelId.startsWith('eleven_')) return 'elevenlabs'
  if (modelId.startsWith('genaipro-')) return 'genaipro'
  // v1.0.149+ — Voice Studio KH (Pinokio FastAPI wrapper, local Tailscale).
  if (modelId.startsWith('voicestudio-')) return 'voicestudio'
  // v1.0.329+ — macOS built-in `say` (local, free).
  if (modelId.startsWith('macos-')) return 'macos'
  // v1.0.378+ — Fish Audio (direct cloud TTS).
  if (modelId.startsWith('fishaudio-')) return 'fishaudio'
  return 'fal'
}

router.post('/projects/:slug/generate/audio', validateBody(GenerateAudioSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config missing.' })

  // Pick the TTS provider for the model the user selected and verify the
  // right key is set. v1.0.149+ added Voice Studio (local Pinokio modal,
  // no key — URL alone is the enable). v1.0.150 dropped the standalone
  // Chatterbox provider entirely (rolled into Voice Studio's family list).
  const providerId = resolveAudioProvider(req.body.model, config.audio_models)
  if (providerId === 'voicestudio') {
    // v1.0.149+ — no per-project enable flag; the modal URL is app-level
    // (set in App Settings → Local Models). If the URL is missing OR the
    // modal is offline we fail fast at generation time with a clear error
    // from the client rather than refusing the queue request here.
  } else {
    const apiKey = providerId === 'elevenlabs' ? ((config as any).elevenlabs_api_key || '')
      : providerId === 'genaipro' ? ((config as any).genaipro_api_key || '')
      : (config.fal_api_key || '')
    if (!apiKey) {
      const label = providerId === 'elevenlabs' ? 'ElevenLabs'
        : providerId === 'genaipro' ? 'GenAIPro' : 'fal.ai'
      return res.status(400).json({ detail: `No ${label} API key configured. Add one in Settings → API Keys.` })
    }
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'audio')) {
    return res.status(409).json({ detail: `Audio generation already queued/running for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'audio',
    episode_id: req.body.episode_id,
    title: `Audio (${req.body.sections || 'all'})`,
    params: req.body,
  })
  res.status(201).json(job)
})

/**
 * Voice preview — generates a short 1-sentence sample with the selected voice
 * so users can audition voices before committing to a full episode generation.
 */
router.post('/projects/:slug/preview-voice', async (req, res) => {
  const { slug } = req.params
  const { voice_id, model, speed, stability, similarity, text } = req.body
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config missing.' })

  const providerId = resolveAudioProvider(model, config.audio_models)
  let apiKey = ''
  if (providerId === 'voicestudio') {
    // v1.0.149+ — Voice Studio KH preview. "apiKey" carries the modal URL.
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { DEFAULT_VOICESTUDIO_BASE_URL } = await import('../lib/voicestudio-client.js')
    apiKey = vsFirst(await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
  } else {
    // (other providers handled below)
  }
  // v1.0.293 — for pooled clone voices the picker stores `vsname:<name>`
  // instead of a raw UUID. Resolve the name to whichever endpoint has it,
  // and pin the preview to that endpoint + use its UUID. We override the
  // resolved apiKey + voice_id here so the rest of the function below
  // works unchanged.
  let resolvedVoiceId: string | undefined = typeof voice_id === 'string' ? voice_id : undefined
  if (providerId === 'voicestudio' && resolvedVoiceId && resolvedVoiceId.startsWith('vsname:')) {
    const name = resolvedVoiceId.slice('vsname:'.length)
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { resolveVoicePool, pickEndpointForVoice } = await import('../services/voicestudio-voice-pool.js')
    const pool = await resolveVoicePool(await getApiKey('voicestudio'))
    const picked = pickEndpointForVoice(pool, name, apiKey)
    if (!picked) {
      return res.status(400).json({
        detail: `Voice "${name}" not found on any reachable Voice Studio endpoint. Save it in Voice Studio → Voices and retry.`,
      })
    }
    apiKey = picked.endpoint
    resolvedVoiceId = picked.voiceId
  }
  if (providerId === 'fishaudio') {
    // Fish Audio key lives in the per-machine app-secrets store (same path the
    // generator resolves), not the legacy per-project config fields.
    const { getApiKey } = await import('../services/app-secrets-store.js')
    apiKey = await getApiKey('fishaudio')
    if (!apiKey) {
      return res.status(400).json({ detail: 'No Fish Audio API key configured. Add one in Settings → API Keys.' })
    }
  } else if (providerId !== 'voicestudio' && providerId !== 'macos') {
    apiKey = providerId === 'elevenlabs' ? ((config as any).elevenlabs_api_key || '')
      : providerId === 'genaipro' ? ((config as any).genaipro_api_key || '')
      : (config.fal_api_key || '')
    if (!apiKey) {
      const label = providerId === 'elevenlabs' ? 'ElevenLabs'
        : providerId === 'genaipro' ? 'GenAIPro' : 'fal.ai'
      return res.status(400).json({ detail: `No ${label} API key configured. Add one in Settings → API Keys.` })
    }
  }

  const sample = typeof text === 'string' && text.trim().length > 0
    ? text.trim().slice(0, 300)
    : 'Welcome to the story. Take a deep breath, settle in, and let your mind drift.'

  try {
    if (providerId === 'macos') {
      // macOS built-in `say`: render to a temp MP3, inline as a data URL,
      // delete the file. Same contract as the voicestudio preview.
      const fs = await import('fs/promises')
      const provider = registry.getAudioProvider('macos')
      if (!provider) return res.status(500).json({ detail: 'macOS audio provider not registered' })
      const result = await provider.generateAudio({
        text: sample,
        apiKey: '',
        modelId: model || 'macos-say',
        voiceId: resolvedVoiceId || undefined,
        speed,
      })
      const filePath = result.audioUrl.startsWith('file://')
        ? new URL(result.audioUrl).pathname
        : result.audioUrl
      const buf = await fs.readFile(filePath)
      await fs.rm(filePath, { force: true }).catch(() => {})
      const dataUrl = `data:audio/mpeg;base64,${buf.toString('base64')}`
      return res.json({ audio_url: dataUrl })
    }

    if (providerId === 'voicestudio') {
      // Voice Studio KH (local Pinokio modal): generate to a temp WAV,
      // inline as a data URL, delete the file. Keeps the preview-voice
      // contract (return a playable URL) without exposing file:// or
      // making the browser hit the local modal directly.
      const fs = await import('fs/promises')
      const provider = registry.getAudioProvider('voicestudio')
      if (!provider) return res.status(500).json({ detail: 'voicestudio audio provider not registered' })
      const result = await provider.generateAudio({
        text: sample,
        apiKey,
        modelId: model || 'voicestudio-voxcpm-mlx',
        voiceId: resolvedVoiceId || undefined,
        speed, stability, similarity,
      })
      const filePath = result.audioUrl.startsWith('file://')
        ? new URL(result.audioUrl).pathname
        : result.audioUrl
      const buf = await fs.readFile(filePath)
      await fs.rm(filePath, { force: true }).catch(() => {})
      const dataUrl = `data:audio/wav;base64,${buf.toString('base64')}`
      return res.json({ audio_url: dataUrl })
    }

    if (providerId === 'elevenlabs') {
      // Direct API returns MP3 bytes inline — we can't get a hosted URL for
      // them, so encode as a data: URL the browser can play directly.
      const buf = await generateTtsBuffer(sample, apiKey, {
        model, voiceId: resolvedVoiceId || undefined, speed, stability, similarity,
        // Note: ElevenLabs ignores the vsname: prefix because resolvedVoiceId
        // only gets the prefix-strip treatment when providerId==='voicestudio'.
        // For ElevenLabs voice_id is the raw catalogue id, unchanged.
      })
      const dataUrl = `data:audio/mpeg;base64,${buf.toString('base64')}`
      return res.json({ audio_url: dataUrl })
    }

    if (providerId === 'fishaudio') {
      // Fish Audio (direct): MP3 bytes inline → data URL. voice_id is the
      // Fish reference_id (cloned voice / any fish.audio model id).
      const { generateTtsBuffer: generateFishBuffer } = await import('../lib/fishaudio-client.js')
      const buf = await generateFishBuffer(sample, apiKey, {
        model, voiceId: resolvedVoiceId || undefined, speed,
      })
      const dataUrl = `data:audio/mpeg;base64,${buf.toString('base64')}`
      return res.json({ audio_url: dataUrl })
    }

    const provider = registry.getAudioProvider(providerId)
    if (!provider) return res.status(500).json({ detail: `${providerId} audio provider not registered` })
    const defaultModel = providerId === 'genaipro' ? 'genaipro-multilingual-v2' : 'turbo-v2.5'
    const result = await provider.generateAudio({
      text: sample,
      apiKey,
      modelId: model || defaultModel,
      voiceId: resolvedVoiceId || undefined,
      speed, stability, similarity,
    })
    res.json({ audio_url: result.audioUrl })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Voice preview failed'))
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
    res.json({ model: expr?.model || null, generated_at: expr?.generated_at || null, sections, job_active: jobActive })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load expression markup'))
  }
})

// Background "Tag all" — enqueue the markup job so it keeps running after the
// operator leaves the page (saves the sidecar after each section).
router.post('/projects/:slug/episodes/:code/expression/generate-all', async (req, res) => {
  const { slug, code } = req.params
  const model = typeof req.body?.model === 'string' && req.body.model.trim()
    ? req.body.model.trim() : 'deepseek-v4-flash'
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    if (jq.isDuplicate(slug, code, 'expression_markup')) {
      return res.status(409).json({ detail: 'Expression tagging is already running for this episode.' })
    }
    const job = jq.enqueue({
      project_slug: slug,
      type: 'expression_markup',
      episode_id: code,
      title: `Expression markup — ${code}`,
      params: { episode_id: code, model },
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
  const model = typeof req.body?.model === 'string' && req.body.model.trim()
    ? req.body.model.trim() : 'deepseek-v4-flash'
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })
    const narrationPath = await resolveNarrationOr404(slug, code, res)
    if (!narrationPath) return
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const { readExpression, writeExpression, markupSectionText } = await import('../services/audio-expression.js')
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
    const sectionsOut: Record<string, string> = { ...(existing?.sections || {}) }
    for (const s of targets) {
      sectionsOut[s.slug] = await markupSectionText(model, s.text, apiKeys, slug)
    }
    const generated_at = new Date().toISOString()
    await writeExpression(narrationPath, { schema_version: 1, model, generated_at, sections: sectionsOut })
    const sections = parsed.map(s => ({ slug: s.slug, label: s.label, original: s.text, expressive: sectionsOut[s.slug] || '' }))
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
    await writeExpression(narrationPath, { schema_version: 1, model: existing?.model, generated_at, sections: sectionsOut })
    const sections = parsed.map(s => ({ slug: s.slug, label: s.label, original: s.text, expressive: sectionsOut[s.slug] || '' }))
    res.json({ model: existing?.model || null, generated_at, sections })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save expression markup'))
  }
})

// ── Audio reconciliation (recover missing chunks) ─────────────────────────
// Scans expected vs present audio chunks for an episode. `/status` is
// read-only; `/repair` hits GenAIPro's task-history API to download any
// chunks whose completed result URL never made it back to disk.

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
    const status = await getAudioStatus(req.params.slug, req.params.code)

    const bySlug = new Map<string, {
      label: string
      slug: string
      total_chunks: number
      present_chunks: number
    }>()
    for (const ec of status.expected) {
      // Derive slug from the filename — section.slug maps 1:1 to the prefix
      // before "_part" (or the whole base if single-chunk). Filenames are
      // already authoritative because the reconciler reuses generators/audio
      // naming, so re-deriving here keeps us in lockstep.
      const base = ec.filename.replace(/\.mp3$/, '')
      const slug = base.replace(/_part\d+$/, '').replace(new RegExp(`^${req.params.code}_`, 'i'), '')
      const entry = bySlug.get(slug) || { label: ec.sectionLabel, slug, total_chunks: 0, present_chunks: 0 }
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

    const provider = typeof req.body?.provider === 'string' ? req.body.provider : 'genaipro'
    if (provider !== 'genaipro') {
      return res.status(400).json({ detail: `Recovery for provider "${provider}" is not supported yet. Only GenAIPro can reconcile via task history.` })
    }
    const apiKey = (config as any).genaipro_api_key || ''
    const result = await reconcileAudioViaGenaipro(req.params.slug, req.params.code, apiKey)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Repair failed'))
  }
})

// ── Voice Studio KH (v1.0.149+) ───────────────────────────────────────────
//
// Local TTS modal launched via Pinokio, reached over Tailscale. The
// "apiKey" slot in app-secrets carries the base URL (no real secret —
// Tailscale handles transport auth). Three routes:
//   GET  /voicestudio/base-url        — read configured URL + default
//   PUT  /voicestudio/base-url        — persist URL (per-Mac via app-secrets)
//   POST /voicestudio/test            — health + availability probe in one call
//
// The test endpoint folds in the availability response so the Settings UI
// can show "Connected — voxcpm-mlx loaded · device mps" in one round-trip.
//
// Listing the user's saved voice library and proxying voice audio bytes
// to the renderer is handled by:
//   GET  /voicestudio/voices            — list saved voices for the picker
// (left as a future addition once the audio picker has UI to surface them).

router.get('/voicestudio/base-url', async (_req, res) => {
  try {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { DEFAULT_VOICESTUDIO_BASE_URL } = await import('../lib/voicestudio-client.js')
    const { getEndpointLabels, getDisabledEndpoints } = await import('../services/app-settings.js')
    const stored = await getApiKey('voicestudio')
    const labels = await getEndpointLabels('voicestudio')
    const disabled = await getDisabledEndpoints('voicestudio')
    res.json({ baseUrl: stored || '', defaultBaseUrl: DEFAULT_VOICESTUDIO_BASE_URL, labels, disabled })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read Voice Studio base URL'))
  }
})

router.put('/voicestudio/base-url', async (req, res) => {
  try {
    const raw = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
    if (!raw) return res.status(400).json({ detail: 'baseUrl is required' })
    // v1.0.255 — accept one OR more endpoints (comma/space separated) for the
    // multi-Mac TTS pool. Validate + clean each, store comma-joined.
    const urls = parseEndpoints(raw)
    if (!urls.length) return res.status(400).json({ detail: 'baseUrl is required' })
    for (const u of urls) {
      if (!/^https?:\/\//i.test(u)) {
        return res.status(400).json({ detail: `Each URL must start with http:// or https:// — got "${u}"` })
      }
    }
    const cleaned = urls.join(', ')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { setEndpointLabelsForUrls, setDisabledEndpointsForUrls } = await import('../services/app-settings.js')
    const { setDisabledEndpoints } = await import('../lib/endpoint-pool.js')
    await setApiKey('voicestudio', cleaned)
    // parseEndpoints already stripped trailing slashes, so `urls` are the cleaned keys.
    const labels = await setEndpointLabelsForUrls('voicestudio', urls, req.body?.labels)
    const disabled = await setDisabledEndpointsForUrls('voicestudio', urls, req.body?.disabled)
    setDisabledEndpoints('voicestudio', disabled)
    res.json({ ok: true, baseUrl: cleaned, labels, disabled })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not save Voice Studio base URL'))
  }
})

router.post('/voicestudio/test', async (req, res) => {
  try {
    const {
      health: vsHealth, availability: vsAvail, listVoices: vsVoices,
      DEFAULT_VOICESTUDIO_BASE_URL,
    } = await import('../lib/voicestudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const incoming = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
    const baseUrl = incoming || vsFirst(await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!baseUrl) {
      return res.json({ ok: false, error: 'No Voice Studio URL set. Enter your modal URL above and Save, then Test.' })
    }
    // Health first — if the process isn't reachable, skip the rest so the
    // user sees a clean "unreachable" response instead of three layered errors.
    const h = await vsHealth(baseUrl)
    if (!h.ok) {
      return res.json({ ok: false, baseUrl, error: h.error || 'Health check failed' })
    }
    // Availability + voice count in parallel — both are cheap GETs.
    const [a, v] = await Promise.all([
      vsAvail(baseUrl),
      vsVoices(baseUrl).catch(() => [] as any[]),
    ])
    const loadedFamilies = Object.entries(a.engines)
      .filter(([, on]) => on)
      .map(([fam]) => fam)
    res.json({
      ok: true,
      baseUrl,
      appVersion: h.appVersion,
      apiVersion: h.apiVersion,
      device: a.device,
      loadedFamilies,
      wiredFamilies: a.wiredFamilies,
      voiceLibraryCount: Array.isArray(v) ? v.length : 0,
    })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message || String(e) })
  }
})

// GET /voicestudio/voices[?model=<id>] — voices for the picker.
//   - voicepack models (Kokoro, …): the engine's built-in preset speakers
//     (`am_liam` etc.), pulled live from the availability probe.
//   - cloning models (VoxCPM) / no model: the user's saved reference clips.
// Both return the same {id,name,language,gender} shape so the picker's
// "Voice Studio library" section renders either unchanged. The `source`
// field lets the frontend relabel the section ('library' vs 'voicepack').
router.get('/voicestudio/voices', async (req, res) => {
  try {
    const {
      listPresetVoices, familyShipsVoicepack,
      familyForModelId, DEFAULT_VOICESTUDIO_BASE_URL,
    } = await import('../lib/voicestudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const { resolveVoicePool } = await import('../services/voicestudio-voice-pool.js')
    const stored = await getApiKey('voicestudio')
    const baseUrl = vsFirst(stored) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!baseUrl) { res.json({ voices: [], baseUrl: '', source: 'library' }); return }
    const modelId = typeof req.query.model === 'string' ? req.query.model : ''
    const family = familyForModelId(modelId)
    const forceRefresh = req.query.refresh === '1'

    // Voicepack engines (Kokoro / Qwen3 / Bark) ship preset speakers built
    // into the model itself — they're identical across every Voice Studio
    // instance. No pool resolution needed; one endpoint's preset list IS
    // the authoritative answer.
    if (family && familyShipsVoicepack(family)) {
      const r = await swrFetch(vsVoicesCache, `vs-voices:pack:${baseUrl}:${family}`, async () => {
        const voices = await listPresetVoices(baseUrl, family)
        return { voices, baseUrl, source: 'voicepack' as const }
      }, { forceRefresh })
      res.json({ ...r.value, stale: r.stale || undefined })
      return
    }
    // v1.0.293 — Clone-engine voices (VoxCPM2 / Chatterbox) are user-
    // uploaded references and live in each Voice Studio instance's
    // independent library. Query ALL configured endpoints and aggregate
    // so the picker can show one row per voice NAME with an availability
    // badge (✓ on every Mac / ⚠ only on m1 — will run serially). The
    // dispatcher reads the same pool to resolve names to per-endpoint
    // UUIDs at TTS time.
    const r = await swrFetch(vsVoicesCache, `vs-voices:pool:${stored || ''}`, async () => {
      const pool = await resolveVoicePool(stored)
      // Massage into the existing picker shape with extra availability
      // fields. `id` is now the NAME (the picker stores `vsname:<name>`
      // in form.voice instead of a raw UUID) — see voicestudio-voice-pool
      // module header for the rationale.
      const voices = pool.voices.map(v => ({
        id: v.name,                              // picker stores this; resolver re-maps to UUIDs per endpoint
        name: v.name,
        language: v.sample.language,
        gender: v.sample.gender,
        duration_seconds: v.sample.duration_seconds,
        has_transcript: v.sample.has_transcript,
        audio_url: v.sample.audio_url,
        // v1.0.293 — multi-endpoint availability metadata. Picker uses these
        // to render badges; legacy callers ignore them safely.
        available_on: v.availableOn,
        available_everywhere: v.availableEverywhere,
        endpoint_count: pool.reachableEndpoints.length,
        // Schema marker so the picker can detect "this is a pooled voice,
        // store the name with the vsname: prefix" vs. the old "store the
        // raw id directly" behaviour.
        voice_kind: 'voicestudio-pooled' as const,
      }))
      return {
        voices,
        baseUrl,
        source: 'library' as const,
        pool: {
          endpoints: pool.endpoints,
          reachable: pool.reachableEndpoints,
          unreachable: pool.unreachableEndpoints,
        },
      }
    }, { forceRefresh })
    res.json({ ...r.value, stale: r.stale || undefined })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not load Voice Studio voice library'))
  }
})

// GET /macos/voices — the renderable English macOS `say` voices for the picker.
// Best (Premium/Enhanced neural) first; classic novelty voices filtered out.
// The display name already carries the "(Enhanced)"/"(Premium)" qualifier, so
// the picker row shows it as-is. Stored plainly in form.voice (no vsname:
// prefix) — these aren't pooled. Empty + available:false on a non-macOS host.
router.get('/macos/voices', async (req, res) => {
  try {
    const { listMacosVoices, isMacosTtsAvailable } = await import('../lib/macos-say-client.js')
    if (!isMacosTtsAvailable()) {
      res.json({ voices: [], source: 'builtin', available: false })
      return
    }
    const r = await swrFetch(macosVoicesCache, 'macos-voices', async () => {
      const list = await listMacosVoices()
      const voices = list.map(v => ({
        id: v.id,
        name: v.name,
        language: v.language,
        tier: v.tier,
      }))
      return { voices, source: 'builtin' as const, available: true }
    }, { forceRefresh: req.query.refresh === '1' })
    res.json({ ...r.value, stale: r.stale || undefined })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list macOS voices'))
  }
})

// GET /voicestudio/models — the Voice Studio engines the live modal can
// currently run, for dynamically filtering the audio-model dropdown. Every
// engine in the catalog is always registered in DEFAULT_AUDIO_MODELS (so
// generation/preview work); this endpoint tells the frontend which to
// *show*. `ok:false` (modal offline/unreachable) → frontend falls back to
// showing all registered voicestudio models so the dropdown never empties.
router.get('/voicestudio/models', async (req, res) => {
  try {
    const { listAvailableEngines, DEFAULT_VOICESTUDIO_BASE_URL } = await import('../lib/voicestudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const stored = await getApiKey('voicestudio')
    const baseUrl = vsFirst(stored) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!baseUrl) { res.json({ ok: false, configured: false, models: [], baseUrl: '' }); return }
    const r = await swrFetch(vsModelsCache, `vs-models:${baseUrl}`, async () => {
      const result = await listAvailableEngines(baseUrl)
      return { ...result, configured: !!stored, baseUrl }
    }, { forceRefresh: req.query.refresh === '1' })
    res.json({ ...r.value, stale: r.stale || undefined })
  } catch (e: any) {
    // Non-fatal — report not-ok so the frontend keeps the static list.
    res.json({ configured: false, ok: false, models: [], error: e?.message || 'probe failed' })
  }
})

// v1.0.217+ — Whisper STT availability proxy. The Subtitles tab calls this to
// learn which Whisper models the modal has cached + ready, so it can gate the
// "Transcribe (local)" action and offer the right model. Non-fatal on a
// missing URL / offline modal (the tab falls back to OpenAI).
router.get('/voicestudio/transcribe-availability', async (req, res) => {
  try {
    const { transcribeAvailability, DEFAULT_VOICESTUDIO_BASE_URL } = await import('../lib/voicestudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const baseUrl = vsFirst(await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!baseUrl) { res.json({ available: false, configured: false, models: [] }); return }
    const r = await swrFetch(vsTranscribeCache, `vs-transcribe:${baseUrl}`, async () => {
      const avail = await transcribeAvailability(baseUrl)
      return { ...avail, configured: true }
    }, { forceRefresh: req.query.refresh === '1' })
    res.json({ ...r.value, stale: r.stale || undefined })
  } catch (e: any) {
    res.json({ available: false, configured: false, models: [], error: e?.message || 'probe failed' })
  }
})

// v1.0.217+ — Trigger a one-time Whisper model download on the modal (reuses
// the generic download manager the TTS models use). Returns immediately; the
// Subtitles tab polls /voicestudio/transcribe-availability for `cached: true`.
router.post('/voicestudio/download-model', async (req, res) => {
  try {
    const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : ''
    if (!repo) return res.status(400).json({ detail: 'repo is required' })
    const { downloadTranscribeModel, DEFAULT_VOICESTUDIO_BASE_URL } = await import('../lib/voicestudio-client.js')
    const { getApiKey } = await import('../services/app-secrets-store.js')
    const baseUrl = vsFirst(await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!baseUrl) return res.status(400).json({ detail: 'Voice Studio URL not set — add it in Settings → This Mac → Local Models.' })
    const r = await downloadTranscribeModel(baseUrl, repo)
    res.json({ ok: true, ...r })
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Could not start model download'))
  }
})

// v1.0.150+ — The /projects/:slug/chatterbox/reference upload route was
// removed alongside the rest of the Chatterbox integration. Voice Studio
// KH manages its own voice library via its built-in web UI (the user
// uploads reference clips there directly); Story Studio just reads them
// back through GET /voicestudio/voices.
