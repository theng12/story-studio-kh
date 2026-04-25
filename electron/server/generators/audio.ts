/**
 * Audio generator — port of generate_audio.py.
 * Generates TTS narration audio via fal.ai (ElevenLabs).
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { chunkText } from '../lib/text-chunker.js'
import { generateTts as generateTtsFal, downloadAudio } from '../lib/fal-client.js'
import { generateTts as generateTtsGenaipro } from '../lib/genaipro-client.js'
import { generateTtsToFile as generateTtsElevenLabs } from '../lib/elevenlabs-client.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveApiKeyForProviderId } from '../providers/registry.js'
import { assertBalanceAvailable } from '../services/utils.js'
import { sleepCancellable, fileExistsWithContent } from '../lib/http-retry.js'
import { recordTask, hashInput } from '../services/task-manifest.js'
import type { GenerateAudioRequest, Job, AudioModelConfig } from '../models/types.js'

type AudioProviderId = 'fal' | 'genaipro' | 'elevenlabs'

/**
 * Pick the TTS provider for a given model. Prefers the explicit `provider`
 * field on AudioModelConfig if present; falls back to prefix detection for
 * backward-compat with projects created before the field existed.
 */
function resolveAudioProvider(
  modelId: string,
  audioModels: Record<string, AudioModelConfig> | undefined,
): AudioProviderId {
  const entry = audioModels?.[modelId]
  if (entry?.provider) return entry.provider
  if (typeof modelId === 'string') {
    if (modelId.startsWith('eleven_')) return 'elevenlabs'
    if (modelId.startsWith('genaipro-')) return 'genaipro'
  }
  return 'fal'
}

export async function findNarrationFile(slug: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const filename = `${code}_Script_Narration.docx`

  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  async function findRecursive(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isFile() && entry.name === filename) return fullPath
        if (entry.isDirectory()) {
          const found = await findRecursive(fullPath)
          if (found) return found
        }
      }
    } catch { /* skip */ }
    return null
  }

  const found = await findRecursive(outputRoot)
  if (found) return found
  throw new Error(`Could not find ${filename}. Generate the script first.`)
}

export async function resolveAudioDir(projectSlug: string, narrationPath: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const parent = path.dirname(narrationPath)
  const parentName = path.basename(parent).replace(/^✅\s*/, '').toLowerCase()

  const isScriptFolder = parentName.includes('script') && !parentName.includes('prompt')
  const episodeDir = isScriptFolder ? path.dirname(parent) : parent

  // Use centralized config helper for subfolder name
  const { resolveSubfolderNames } = await import('../services/utils.js')
  const names = await resolveSubfolderNames(projectSlug, code)
  const audioName = names.audio // e.g. "TN0024 - 07 Audio Assets"

  // Scan for existing folder (handles ✅ prefix)
  try {
    const entries = await fs.readdir(episodeDir)
    for (const entry of entries) {
      const clean = entry.replace(/^✅\s*/, '')
      if (clean === audioName) return path.join(episodeDir, entry)
    }
  } catch { /* fall through */ }

  // Fall back to config-based path (will be created)
  return path.join(episodeDir, audioName)
}

export async function generateAudio(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateAudioRequest

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  // Pick TTS backend. Prefer the explicit provider on the model catalog;
  // fall back to prefix detection for legacy model IDs.
  const providerId = resolveAudioProvider(req.model, config.audio_models)
  const providerLabel = providerId === 'elevenlabs' ? 'ElevenLabs (direct)'
    : providerId === 'genaipro' ? 'GenAIPro'
    : 'fal.ai'
  const apiKey = await resolveApiKeyForProviderId(project_slug, providerId, {
    model: req.model,
    jobId: job.job_id,
  })
  if (!apiKey) throw new Error(`No ${providerLabel} API key configured. Add one in Settings → API Keys.`)

  // Preflight: for providers that expose a numeric balance, refuse the job
  // up front if it's definitively empty. GenAIPro doesn't expose a balance
  // endpoint we can query cheaply, so the preflight is skipped there and
  // the provider surfaces any quota issue on first call.
  if (providerId === 'fal') await assertBalanceAvailable('fal', apiKey)
  else if (providerId === 'elevenlabs') await assertBalanceAvailable('elevenlabs', apiKey)

  const narrationPath = await findNarrationFile(project_slug, episode_id)
  job.output_lines.push(`Found narration: ${path.basename(narrationPath)}`)

  const audioDir = await resolveAudioDir(project_slug, narrationPath, episode_id)
  await fs.mkdir(audioDir, { recursive: true })

  const allSections = await parseNarrationDocx(narrationPath)
  job.output_lines.push(`Sections: ${allSections.length} found`)
  for (const s of allSections) {
    job.output_lines.push(`  ${s.label} (${s.text.length.toLocaleString()} chars)`)
  }

  // Filter sections
  let sections = allSections
  const sectionsParam = req.sections || 'all'

  if (sectionsParam.toLowerCase() === 'intro') {
    sections = sections.filter(s => s.label.toLowerCase() === 'introduction')
  } else if (sectionsParam !== 'all' && sectionsParam.includes(',')) {
    const requested = sectionsParam.split(',').map(x => x.trim()).filter(Boolean)
    const filtered = []
    for (const r of requested) {
      if (['intro', 'introduction'].includes(r.toLowerCase())) {
        filtered.push(...allSections.filter(s => s.label.toLowerCase() === 'introduction'))
      } else {
        const norm = r.replace(/^0+/, '') || '0'
        for (const s of allSections) {
          const slugNum = s.slug.replace(/\D/g, '').replace(/^0+/, '') || '0'
          if (slugNum === norm || s.slug === r || s.label === r) filtered.push(s)
        }
      }
    }
    sections = filtered
  } else if (sectionsParam !== 'all') {
    const norm = sectionsParam.replace(/^0+/, '') || '0'
    sections = allSections.filter(s => {
      const slugNum = s.slug.replace(/\D/g, '').replace(/^0+/, '') || '0'
      return slugNum === norm || s.slug === sectionsParam || s.label === sectionsParam
    })
  }

  if (!sections.length) {
    throw new Error(`No matching sections for '${sectionsParam}'`)
  }

  const errors: string[] = []
  const code = episode_id.toUpperCase()

  job.output_lines.push(`Generating ${sections.length} audio section(s)...`)

  const isCancelled = () => jq.isCancelled(job.job_id)

  // ── Flatten sections + chunks into a single task list ───────────────────
  // Previously this was two nested `for` loops with `await` + 1-second
  // pacing sleeps — a 10-chapter episode made 10 sequential TTS calls.
  // We now collect every chunk to generate, decide skip-vs-write semantics
  // up-front, then hand the whole list to a concurrency pool bounded by
  // `config.audio_concurrency` (default 3 — ElevenLabs Starter tier's safe
  // cap; user can go up to 15 for higher tiers).
  interface ChunkTask {
    sectionLabel: string
    chunkText: string
    outputPath: string
  }
  const tasks: ChunkTask[] = []

  for (const section of sections) {
    if (isCancelled()) break
    const filename = `${code}_${section.slug}.mp3`
    const savePath = path.join(audioDir, filename)
    const chunks = chunkText(section.text)
    job.output_lines.push(
      `${section.label} (${section.text.length.toLocaleString()} chars${chunks.length > 1 ? `, ${chunks.length} parts` : ''})`,
    )

    for (let i = 0; i < chunks.length; i++) {
      let chunkPath = chunks.length > 1 ? savePath.replace('.mp3', `_part${i + 1}.mp3`) : savePath

      // Only skip on a non-empty existing file. A zero-byte leftover from a
      // prior failure must be regenerated, not treated as a cache hit.
      if (await fileExistsWithContent(chunkPath) && !req.force) {
        if (req.no_overwrite) {
          let v = 2
          while (existsSync(chunkPath.replace('.mp3', `_v${v}.mp3`))) v++
          chunkPath = chunkPath.replace('.mp3', `_v${v}.mp3`)
        } else {
          job.output_lines.push(`  Skipping ${path.basename(chunkPath)} (exists)`)
          continue
        }
      }

      tasks.push({ sectionLabel: section.label, chunkText: chunks[i]!, outputPath: chunkPath })
    }
  }

  // ── Concurrency pool ───────────────────────────────────────────────────
  const rawConcurrency = Number((config as any).audio_concurrency) || 0
  const concurrency = Math.max(1, Math.min(15, rawConcurrency || 3))
  if (tasks.length > 1) {
    job.output_lines.push(
      `Pool: ${Math.min(concurrency, tasks.length)} in parallel (configure via Settings → Audio → Concurrency)`,
    )
  }

  // AbortController fed from a 500 ms cancel watcher — matches the subtitles
  // generator's pattern. ElevenLabs streams MP3 bytes directly from fetch, so
  // a signal tears that down the moment the user cancels instead of letting
  // the stream finish and still bill the account.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (isCancelled()) controller.abort()
  }, 500)

  async function processTask(task: ChunkTask): Promise<void> {
    if (isCancelled()) return
    try {
      if (providerId === 'elevenlabs') {
        // Direct API streams MP3 bytes — write straight to disk.
        await generateTtsElevenLabs(task.chunkText, apiKey, task.outputPath, {
          model: req.model,
          voiceId: req.voice || undefined,
          speed: req.speed,
          stability: req.stability,
          similarity: req.similarity,
          signal: controller.signal,
        })
      } else {
        const chunkFilename = path.basename(task.outputPath)
        // User-configurable TTS timeout (minutes → ms). Undefined means use
        // the client's built-in default (20 min for GenAIPro, 5 min for fal).
        const timeoutMinutes = (config as any)?.generation_timeouts?.tts_minutes
        const timeoutMs = typeof timeoutMinutes === 'number' && timeoutMinutes > 0
          ? timeoutMinutes * 60_000 : undefined
        const commonOpts = {
          model: req.model,
          voiceId: req.voice || undefined,
          speed: req.speed,
          stability: req.stability,
          similarity: req.similarity,
          timeoutMs,
          isCancelled,
        }
        // For GenAIPro we persist the task_id the moment the submit returns,
        // so a later timeout or crash still leaves a reference the reconciler
        // can look up deterministically.
        const audioUrl = providerId === 'genaipro'
          ? await generateTtsGenaipro(task.chunkText, apiKey, {
              ...commonOpts,
              onTaskSubmitted: async (taskId) => {
                await recordTask(audioDir, chunkFilename, {
                  provider: 'genaipro',
                  task_id: taskId,
                  submitted_at: new Date().toISOString(),
                  input_hash: hashInput(task.chunkText),
                })
              },
            })
          : await generateTtsFal(task.chunkText, apiKey, commonOpts)
        await downloadAudio(audioUrl, task.outputPath)
      }
      job.output_lines.push(`  Saved: ${path.basename(task.outputPath)}`)
    } catch (e: any) {
      // Settled-pool semantics: one chunk failure doesn't kill the batch.
      // The queue stamps status='error' after the loop if errors.length > 0.
      job.output_lines.push(`  Failed: ${e.message}`)
      errors.push(`${task.sectionLabel}: ${e.message}`)
    }
  }

  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      if (isCancelled()) return
      const i = cursor++
      await processTask(tasks[i]!)
    }
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
    )
  } finally {
    clearInterval(cancelWatcher)
  }
  // Silence unused-import lint if sleepCancellable is no longer referenced
  // elsewhere (it was the old pacing hook). Left imported for any future use.
  void sleepCancellable

  // Partial-failure semantics: throw so the queue stamps status='error'
  // instead of 'done'. A cancelled job is handled by the queue's own check.
  if (errors.length) {
    job.output_lines.push(`Completed with ${errors.length} error(s)`)
    const preview = errors.slice(0, 3).join('; ')
    const suffix = errors.length > 3 ? `; +${errors.length - 3} more` : ''
    throw new Error(`${errors.length} section(s) failed: ${preview}${suffix}`)
  }
  job.output_lines.push(`All audio saved to: ${audioDir}`)
  job.output_dir = audioDir
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
