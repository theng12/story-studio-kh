import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { registry } from '../providers/registry.js'
import { validateBody } from '../lib/validate.js'
import { GenerateAudioSchema } from '../schemas/index.js'
import { generateTtsBuffer } from '../lib/elevenlabs-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { getAudioStatus, reconcileAudioViaGenaipro } from '../services/audio-reconciler.js'
import type { AudioModelConfig } from '../models/types.js'

export const router = Router()

/** Pick the TTS provider for a model id, mirroring generators/audio.ts. */
function resolveAudioProvider(
  modelId: string | undefined,
  audioModels: Record<string, AudioModelConfig> | undefined,
): 'fal' | 'genaipro' | 'elevenlabs' {
  if (!modelId) return 'fal'
  const entry = audioModels?.[modelId]
  if (entry?.provider) return entry.provider
  if (modelId.startsWith('eleven_')) return 'elevenlabs'
  if (modelId.startsWith('genaipro-')) return 'genaipro'
  return 'fal'
}

router.post('/projects/:slug/generate/audio', validateBody(GenerateAudioSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config missing.' })

  // Pick the TTS provider for the model the user selected and verify the
  // right key is configured — the Audio Generator now supports three
  // providers (fal / genaipro / ElevenLabs direct), so gating on fal only
  // would reject every eleven_* / genaipro-* job.
  const providerId = resolveAudioProvider(req.body.model, config.audio_models)
  const apiKey = providerId === 'elevenlabs' ? ((config as any).elevenlabs_api_key || '')
    : providerId === 'genaipro' ? ((config as any).genaipro_api_key || '')
    : (config.fal_api_key || '')
  if (!apiKey) {
    const label = providerId === 'elevenlabs' ? 'ElevenLabs'
      : providerId === 'genaipro' ? 'GenAIPro' : 'fal.ai'
    return res.status(400).json({ detail: `No ${label} API key configured. Add one in Settings → API Keys.` })
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
  const apiKey = providerId === 'elevenlabs' ? ((config as any).elevenlabs_api_key || '')
    : providerId === 'genaipro' ? ((config as any).genaipro_api_key || '')
    : (config.fal_api_key || '')
  if (!apiKey) {
    const label = providerId === 'elevenlabs' ? 'ElevenLabs'
      : providerId === 'genaipro' ? 'GenAIPro' : 'fal.ai'
    return res.status(400).json({ detail: `No ${label} API key configured. Add one in Settings → API Keys.` })
  }

  const sample = typeof text === 'string' && text.trim().length > 0
    ? text.trim().slice(0, 300)
    : 'Welcome to the story. Take a deep breath, settle in, and let your mind drift.'

  try {
    if (providerId === 'elevenlabs') {
      // Direct API returns MP3 bytes inline — we can't get a hosted URL for
      // them, so encode as a data: URL the browser can play directly.
      const buf = await generateTtsBuffer(sample, apiKey, {
        model, voiceId: voice_id || undefined, speed, stability, similarity,
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
      voiceId: voice_id || undefined,
      speed, stability, similarity,
    })
    res.json({ audio_url: result.audioUrl })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Voice preview failed'))
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
        sourcePath = path.join(scriptDir, `${code}_Introduction.docx`)
      } else {
        const m = slug.match(/^Chapter_(\d+)$/)
        if (m) sourcePath = path.join(scriptDir, `${code}_Chapter_${m[1]}.docx`)
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
