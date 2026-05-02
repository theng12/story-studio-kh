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
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
import { generateTts as generateTtsGenaipro } from '../lib/genaipro-client.js'
import { generateTtsToFile as generateTtsElevenLabs } from '../lib/elevenlabs-client.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { resolveApiKeyForProviderId } from '../providers/registry.js'
import { assertBalanceAvailable } from '../services/utils.js'
import { sleepCancellable, fileExistsWithContent, isCloudEvictedPlaceholder } from '../lib/http-retry.js'
import { recordTask, hashInput, readManifest, type Manifest } from '../services/task-manifest.js'
import { tryRecoverAudioFromManifest } from '../lib/manifest-recovery.js'
import { runFfmpeg, formatConcatFileLine } from '../lib/ffmpeg-utils.js'
import { planRoutedSegments, type RoutingPlan } from '../lib/audio-route-segments.js'
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

/**
 * Thrown by findNarrationFile when the expected `_Script_Narration.docx`
 * isn't on disk yet. Carries `code: 'NARRATION_MISSING'` so the frontend
 * can match on a stable string instead of regex-parsing the message.
 *
 * Mirrors the JsonCorruptError pattern in project-manager.ts: `expose: true`
 * tells humanizeBackendError it's safe to forward the code in the response.
 */
export class NarrationMissingError extends Error {
  readonly code = 'NARRATION_MISSING' as const
  readonly statusCode = 404
  readonly expose = true
  readonly episode_id: string
  readonly filename: string
  constructor(episodeId: string, filename: string) {
    super(`Could not find ${filename}. Generate the script first.`)
    this.name = 'NarrationMissingError'
    this.episode_id = episodeId
    this.filename = filename
  }
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
  throw new NarrationMissingError(episodeId, filename)
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

  // Load the project's effective brand once. Two downstream consumers
  // need it: the voice-fallback below, and the lexicon substitution
  // applied to parsed sections further down. Best-effort — a brand
  // load failure must never break audio generation.
  let brand: import('../models/types.js').Brand | null = null
  try {
    const { getEffectiveBrand } = await import('../services/brand-loader.js')
    brand = await getEffectiveBrand(project_slug)
  } catch { /* brand layer must never break audio generation */ }

  // Brand fallback for voice: when the request didn't pin a voice id,
  // use the project's brand-default voice (and any default settings).
  // Episode/per-character overrides downstream still win — this only
  // covers the "user didn't pick a voice" path that would otherwise
  // depend on the provider's hardcoded default.
  if ((!req.voice || !String(req.voice).trim()) && brand) {
    const fallbackVoice = brand.narration?.default_voice_id?.trim()
    if (fallbackVoice) {
      req.voice = fallbackVoice
      const settings = brand.narration?.default_voice_settings
      if (settings) {
        if (typeof settings.stability === 'number' && req.stability === undefined) req.stability = settings.stability
        if (typeof settings.similarity === 'number' && req.similarity === undefined) req.similarity = settings.similarity
        if (typeof settings.speed === 'number' && req.speed === undefined) req.speed = settings.speed
      }
      job.output_lines.push(`Voice fallback from brand: ${fallbackVoice}`)
    }
  }

  // Phase-wide download metrics (TTS streaming + fal/genaipro download).
  // Fires per chunk while audio bytes flow back; speed is a 5-second
  // rolling avg, total bytes left undefined (most TTS responses don't
  // send Content-Length) → UI shows indeterminate bar + speed.
  const speedTracker = new SpeedTracker()
  let cumulativeBytes = 0
  const writeProgress = throttle(() => {
    const { speedBps } = speedTracker.update(cumulativeBytes)
    job.bytes_done = cumulativeBytes
    job.speed_bps = speedBps
  }, 250)
  const makeChunkCb = () => {
    let lastReceived = 0
    return (received: number, _total?: number) => {
      const delta = received - lastReceived
      if (delta > 0) {
        cumulativeBytes += delta
        lastReceived = received
        writeProgress()
      }
    }
  }

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
  // Read the per-folder task manifest once so we can attempt free recovery
  // (existing-task poll) before issuing fresh submits. Only GenAIPro records
  // task_ids today (ElevenLabs streams direct, fal-audio doesn't); other
  // entries fall through to fresh generation.
  const audioManifest: Manifest = await readManifest(audioDir).catch(
    () => ({ schema_version: 1 as const, tasks: {} }),
  )

  const allSections = await parseNarrationDocx(narrationPath)
  job.output_lines.push(`Sections: ${allSections.length} found`)
  for (const s of allSections) {
    job.output_lines.push(`  ${s.label} (${s.text.length.toLocaleString()} chars)`)
  }

  // Apply the brand's pronunciation lexicon (pre-TTS substitution) to
  // every section's text BEFORE chunking + character routing. One log
  // line summarises every term that fired — the user can verify which
  // proper nouns were respelled without scanning the audio output. No
  // brand or empty lexicon = no-op.
  if (brand?.pronunciation_lexicon?.length) {
    try {
      const { applyLexicon, formatSubstitutionsLog } = await import('../lib/pronunciation.js')
      // Direct ElevenLabs supports SSML phoneme tags; other providers
      // (Fal-proxied ElevenLabs, GenAIPro) fall back to alt_spelling.
      // When a provider gains SSML support, flip its branch here.
      const ssmlSupported = providerId === 'elevenlabs'
      const totalCounts = new Map<string, { replacement: string; count: number }>()
      for (const s of allSections) {
        const result = applyLexicon(s.text, brand.pronunciation_lexicon, { ssmlSupported })
        if (result.substitutions.length) {
          s.text = result.text
          for (const sub of result.substitutions) {
            const prev = totalCounts.get(sub.term)
            totalCounts.set(sub.term, {
              replacement: sub.replacement,
              count: (prev?.count ?? 0) + sub.count,
            })
          }
        }
      }
      if (totalCounts.size) {
        const records = [...totalCounts.entries()].map(([term, v]) => ({
          term, replacement: v.replacement, count: v.count,
        }))
        const log = formatSubstitutionsLog(records)
        if (log) job.output_lines.push(log)
      }
    } catch { /* brand layer must never break audio generation */ }
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
    /**
     * Phase 6 multi-character routing: per-task voice override. When set,
     * the TTS call uses this voice instead of req.voice. Used by routed
     * sections where each segment renders with its character's voice.
     */
    voiceIdOverride?: string
    /**
     * When set, this task is one piece of a routed section. After the
     * concurrency pool finishes, all tasks sharing the same concatGroup
     * key are concatenated (in order) into the section's final mp3 file,
     * and the intermediates are deleted.
     */
    concatGroup?: string
    /** Order within the concat group (segment-index * 1000 + chunk-index). */
    concatOrder?: number
  }
  const tasks: ChunkTask[] = []
  /** finalPath → list of intermediate paths (in concatOrder) to merge into it. */
  const concatPlans = new Map<string, Array<{ order: number; path: string }>>()

  // ── Phase 6: load characters once for this project so routing detection
  // can match speaker tags against the cast. The auto-detect approach
  // (no character_ids in the audio request) means single/zero-character
  // episodes incur this one fs scan but otherwise behave exactly as before.
  const projectCharacters = await cm.listCharacters(project_slug).catch(() => [])
  if (projectCharacters.length) {
    const withVoices = projectCharacters.filter(c => c.speech?.voiceId).length
    job.output_lines.push(`Cast: ${projectCharacters.length} character(s), ${withVoices} with voice IDs`)
  }

  for (const section of sections) {
    if (isCancelled()) break
    const filename = `${code}_${section.slug}.mp3`
    const savePath = path.join(audioDir, filename)

    // Decide whether this section needs per-speaker routing. Returns null
    // when no characters have voice IDs OR the section has no speaker tags
    // — both fall through to the existing single-voice path unchanged.
    const plan = planRoutedSegments(section.text, projectCharacters, req.voice)

    if (plan && plan.multiVoice) {
      // ── Routed path: each segment becomes its own task with the segment's
      // voice. After the pool, intermediates are concatenated into the
      // section's final mp3 file. Intermediates are named with seg/part
      // indices so the concat order is deterministic.
      job.output_lines.push(
        `${section.label} (routed: ${plan.segments.length} speaker segment(s))`,
      )

      // iCloud-evicted: file is recoverable for free, don't re-bill.
      if (!req.force && await isCloudEvictedPlaceholder(savePath)) {
        job.output_lines.push(
          `  ⚠ ${path.basename(savePath)} is iCloud-evicted (download in Finder). Skipped to avoid re-billing.`,
        )
        continue
      }
      // Skip semantics for routed sections — only skip if the FINAL
      // section file already exists with content. Per-segment intermediates
      // are always regenerated (cheap to redo if a prior run was partial).
      if (await fileExistsWithContent(savePath) && !req.force) {
        if (req.no_overwrite) {
          // Caller wants versioned outputs; the routed final file gets a v{N}
          // suffix instead of overwriting.
          let v = 2
          while (existsSync(savePath.replace('.mp3', `_v${v}.mp3`))) v++
          // Concatenate into the versioned name instead.
          const versioned = savePath.replace('.mp3', `_v${v}.mp3`)
          enqueueRoutedSegments(section.label, plan, audioDir, code, section.slug, versioned)
        } else {
          job.output_lines.push(`  Skipping ${path.basename(savePath)} (exists)`)
          continue
        }
      } else {
        enqueueRoutedSegments(section.label, plan, audioDir, code, section.slug, savePath)
      }
      continue
    }

    const chunks = chunkText(section.text)
    job.output_lines.push(
      `${section.label} (${section.text.length.toLocaleString()} chars${chunks.length > 1 ? `, ${chunks.length} parts` : ''})`,
    )

    for (let i = 0; i < chunks.length; i++) {
      let chunkPath = chunks.length > 1 ? savePath.replace('.mp3', `_part${i + 1}.mp3`) : savePath

      // iCloud-evicted: skip regeneration to avoid re-billing.
      if (!req.force && await isCloudEvictedPlaceholder(chunkPath)) {
        job.output_lines.push(
          `  ⚠ ${path.basename(chunkPath)} is iCloud-evicted (download in Finder). Skipped to avoid re-billing.`,
        )
        continue
      }
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

  /** Helper used inside the section loop above. Closes over `tasks` + `concatPlans`. */
  function enqueueRoutedSegments(
    sectionLabel: string, plan: RoutingPlan, dir: string,
    code: string, sectionSlug: string, finalPath: string,
  ) {
    const intermediates: Array<{ order: number; path: string }> = []
    plan.segments.forEach((seg, segIdx) => {
      const segChunks = chunkText(seg.text)
      segChunks.forEach((chunkBody, chunkIdx) => {
        const speakerSlug = (seg.speaker || 'narrator').replace(/[^a-zA-Z0-9]/g, '_')
        const basename = `${code}_${sectionSlug}_seg${String(segIdx + 1).padStart(2, '0')}_${speakerSlug}_part${String(chunkIdx + 1).padStart(2, '0')}.mp3`
        const intermediatePath = path.join(dir, '.routed', basename)
        intermediates.push({ order: segIdx * 1000 + chunkIdx, path: intermediatePath })
        tasks.push({
          sectionLabel,
          chunkText: chunkBody!,
          outputPath: intermediatePath,
          voiceIdOverride: seg.voiceId,
          concatGroup: finalPath,
          concatOrder: segIdx * 1000 + chunkIdx,
        })
      })
    })
    concatPlans.set(finalPath, intermediates)
  }

  // ── Concurrency pool ───────────────────────────────────────────────────
  const rawConcurrency = Number((config as any).audio_concurrency) || 0
  const concurrency = Math.max(1, Math.min(15, rawConcurrency || 3))
  // Launch stagger: delay each pool worker's FIRST task by `i * staggerMs`
  // so all N workers don't submit to ElevenLabs/fal/GenAIPro in the same
  // millisecond. Default 0 (no stagger) — opt-in via Settings → Audio →
  // Launch stagger. Clamp 0..5000.
  const cfgAudioStagger = Number((config as any).audio_launch_stagger_ms) || 0
  const launchStaggerMs = Math.max(0, Math.min(5000, cfgAudioStagger))
  if (tasks.length > 1) {
    job.output_lines.push(
      `Pool: ${Math.min(concurrency, tasks.length)} in parallel` +
      (launchStaggerMs > 0 ? `, launch stagger ${launchStaggerMs}ms` : '') +
      ' (configure via Settings → Audio)',
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
    // Phase 6: per-task voice override for routed sections. Falls back to
    // the request's project-default voice when not set.
    const effectiveVoice = task.voiceIdOverride || req.voice || undefined
    // Ensure intermediate dir exists (routed-section files live in .routed/).
    await fs.mkdir(path.dirname(task.outputPath), { recursive: true }).catch(() => {})
    try {
      if (providerId === 'elevenlabs') {
        // Direct API streams MP3 bytes — write straight to disk.
        await generateTtsElevenLabs(task.chunkText, apiKey, task.outputPath, {
          model: req.model,
          voiceId: effectiveVoice,
          speed: req.speed,
          stability: req.stability,
          similarity: req.similarity,
          signal: controller.signal,
          onProgress: makeChunkCb(),
        })
      } else {
        const chunkFilename = path.basename(task.outputPath)
        // User-configurable TTS timeout (minutes → ms). Undefined means use
        // the client's built-in default (20 min for GenAIPro, 5 min for fal).
        const timeoutMinutes = (config as any)?.generation_timeouts?.tts_minutes
        const timeoutMs = typeof timeoutMinutes === 'number' && timeoutMinutes > 0
          ? timeoutMinutes * 60_000 : undefined
        // Auto-recovery (GenAIPro only): before issuing a fresh submit,
        // see if the task-manifest sidecar has a stored task_id from a
        // previous run. If the provider still has the result, polling it
        // is free; only the fresh submit below would charge a second time.
        // ElevenLabs streams direct, no task_id to recover. fal-audio
        // doesn't currently record manifest entries — it falls through.
        if (providerId === 'genaipro' && !req.force) {
          const recovered = await tryRecoverAudioFromManifest(
            audioManifest.tasks[chunkFilename] || null,
            apiKey, isCancelled, timeoutMs,
          )
          if (recovered) {
            await downloadAudio(recovered.url, task.outputPath, makeChunkCb())
            job.output_lines.push(
              `  Recovered: ${chunkFilename} from existing task ` +
              `${recovered.taskId.slice(0, 12)}… (no charge)`,
            )
            return
          }
        }
        const commonOpts = {
          model: req.model,
          voiceId: effectiveVoice,
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
        await downloadAudio(audioUrl, task.outputPath, makeChunkCb())
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
  // i-th worker delays its first task by i * launchStaggerMs to smooth the
  // initial-burst submit. sleepCancellable ticks every 200ms so a user
  // cancel during the stagger window unwinds without hanging.
  async function worker(workerIndex: number): Promise<void> {
    if (launchStaggerMs > 0 && workerIndex > 0) {
      try {
        await sleepCancellable(workerIndex * launchStaggerMs, isCancelled)
      } catch { return /* cancelled mid-stagger */ }
    }
    while (cursor < tasks.length) {
      if (isCancelled()) return
      const i = cursor++
      await processTask(tasks[i]!)
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, tasks.length) },
        (_, i) => worker(i),
      ),
    )
  } finally {
    clearInterval(cancelWatcher)
  }

  // Phase 6: post-pool concat for routed sections. Each concatPlans entry
  // pairs a final section path with its ordered intermediate segment files.
  // We FFmpeg-concat them, then delete the intermediates so the audio dir
  // stays clean (audio-merge downstream picks up the final per-section
  // files unchanged, just like the existing single-voice path produces).
  if (concatPlans.size > 0 && !isCancelled()) {
    job.output_lines.push(`Concatenating ${concatPlans.size} routed section(s)…`)
    for (const [finalPath, parts] of concatPlans) {
      // Only run if every intermediate exists — partial failures earlier
      // in the pool would skip the concat for that section so the user
      // sees a clear error rather than a half-merged file.
      const ordered = parts.slice().sort((a, b) => a.order - b.order)
      const allPresent = await Promise.all(ordered.map(p => fileExistsWithContent(p.path)))
      if (!allPresent.every(Boolean)) {
        const missing = ordered.filter((_, i) => !allPresent[i]).map(p => path.basename(p.path))
        errors.push(`routed section ${path.basename(finalPath)}: missing segments ${missing.join(', ')}`)
        continue
      }

      // Write concat list, run ffmpeg, clean up.
      const listFile = path.join(path.dirname(ordered[0].path), `_concat_${path.basename(finalPath, '.mp3')}.txt`)
      const listText = ordered.map(p => formatConcatFileLine(p.path)).join('\n') + '\n'
      try {
        await fs.writeFile(listFile, listText)
        // -c copy is safe because all intermediates use the same encoder
        // settings (same TTS provider/model).
        await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalPath])
        // Cleanup intermediates + list file. Best-effort; failures here
        // don't fail the job (the final file is what matters).
        await fs.unlink(listFile).catch(() => {})
        for (const p of ordered) await fs.unlink(p.path).catch(() => {})
        // Try to remove the empty .routed/ dir (only succeeds if empty).
        await fs.rmdir(path.join(path.dirname(ordered[0].path))).catch(() => {})
        job.output_lines.push(`  ✓ ${path.basename(finalPath)} (${ordered.length} segments)`)
      } catch (e: any) {
        errors.push(`routed section ${path.basename(finalPath)}: concat failed — ${e.message}`)
      }
    }
  }

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
