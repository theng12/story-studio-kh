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
import { generateTtsToUrl as generateTtsKie } from '../lib/kie-tts-client.js'
// v1.0.149+ — Voice Studio KH (Pinokio FastAPI wrapper, multi-engine).
// v1.0.150+ — superseded the standalone Chatterbox helper entirely;
// Chatterbox-mlx is reachable through Voice Studio's family list now.
import { generateTtsToFile as generateTtsVoiceStudio } from '../providers/audio/voicestudio.js'
import { DEFAULT_VOICESTUDIO_BASE_URL } from '../lib/voicestudio-client.js'
import { generateTtsToFile as generateTtsMacos } from '../lib/macos-say-client.js'
// v1.0.378+ — Fish Audio (direct cloud TTS; streams bytes inline like ElevenLabs).
import { generateTtsToFile as generateTtsFishaudio } from '../lib/fishaudio-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { resolveApiKeyForProviderId } from '../providers/registry.js'
import { parseEnabledEndpoints, healthyEndpoints, createDispatcher, runOnPool, type Dispatcher } from '../lib/endpoint-pool.js'
import { newLatencyStats, recordCall as recordLatency, summarize as summarizeLatency } from '../lib/endpoint-latency-stats.js'
import { assertBalanceAvailable } from '../services/utils.js'
import { sleepCancellable, fileExistsWithContent, isCloudEvictedPlaceholder } from '../lib/http-retry.js'
import { recordTask, hashInput, readManifest, type Manifest } from '../services/task-manifest.js'
import { tryRecoverAudioFromManifest } from '../lib/manifest-recovery.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { runFfmpeg, formatConcatFileLine } from '../lib/ffmpeg-utils.js'
import { planRoutedSegments, type RoutingPlan } from '../lib/audio-route-segments.js'
import type { GenerateAudioRequest, Job, AudioModelConfig } from '../models/types.js'

type AudioProviderId = 'fal' | 'genaipro' | 'elevenlabs' | 'voicestudio' | 'macos' | 'fishaudio' | 'kie'

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
    if (modelId.startsWith('voicestudio-')) return 'voicestudio'
    if (modelId.startsWith('macos-')) return 'macos'
    if (modelId.startsWith('fishaudio-')) return 'fishaudio'
    if (modelId.startsWith('kie-')) return 'kie'
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
  // Prefer the Markdown narration; fall back to a legacy .docx.
  const filename = `${code}_Script_Narration.md`
  const candidates = new Set([filename, `${code}_Script_Narration.docx`])

  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  async function findRecursive(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      // Within a directory, a present .md wins over a sibling .docx.
      const names = entries.filter(e => e.isFile()).map(e => e.name)
      if (names.includes(filename)) return path.join(dir, filename)
      for (const name of names) {
        if (candidates.has(name)) return path.join(dir, name)
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = await findRecursive(path.join(dir, entry.name))
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

  // Level B (opt-in): audio is heavy media — route to the external media root
  // when the project configured one; otherwise resolve under the iCloud
  // episodeDir exactly as before.
  const { mediaEpisodeBaseForCode } = await import('../services/media-root.js')
  const base = (await mediaEpisodeBaseForCode(projectSlug, code)) ?? episodeDir

  // v1.0.338 — shared lookup (handles the ✅ done-marker prefix); falls
  // back to the config-based path, which the writer creates on demand.
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  return (await findSubfolder(base, audioName)) ?? path.join(base, audioName)
}

export async function generateAudio(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateAudioRequest

  // Load the project's effective brand once for the lexicon substitution
  // applied to parsed sections further down. Best-effort — a brand load
  // failure must never break audio generation.
  let brand: import('../models/types.js').Brand | null = null
  try {
    const { getEffectiveBrand } = await import('../services/brand-loader.js')
    brand = await getEffectiveBrand(project_slug)
  } catch { /* brand layer must never break audio generation */ }

  // No silent defaults (v1.0.210+): a voice MUST be explicitly chosen.
  // The Audio tab requires a pick before Generate, and pipeline runs carry
  // the voice from each step's saved preset (the pipeline pre-flight also
  // rejects a voiceless audio preset). If we still arrive here without a
  // voice, fail loudly rather than letting a brand/provider default quietly
  // substitute a voice the user never chose — that masked-default behaviour
  // is exactly what produced "wrong voice" renders before.
  if (!req.voice || !String(req.voice).trim()) {
    throw new Error(
      'No voice selected for audio generation. Pick a voice on the Audio tab and '
      + 're-save your preset — there is no default voice.',
    )
  }

  // Format fallback for TTS settings (speed/stability/similarity). Each
  // channel format ships sensible audioDefaults — listicle wants snappier
  // pacing, sleep-story wants slow + breathy, etc. The frontend already
  // seeds these into the form, so most calls already carry them. This
  // layer covers callers that bypass the page (legacy presets dropped
  // a field, programmatic enqueues, retried jobs whose params predate
  // the format-aware roll-out) so the format-tuned defaults still land
  // instead of falling through to the TTS client's generic hardcoded
  // values. Precedence: req body → brand → format → client default.
  try {
    const fmt = await getEffectiveFormat(project_slug)
    const fmtAudio = fmt?.script.audioDefaults
    if (fmtAudio) {
      if (typeof fmtAudio.speed === 'number' && req.speed === undefined) req.speed = fmtAudio.speed
      if (typeof fmtAudio.stability === 'number' && req.stability === undefined) req.stability = fmtAudio.stability
      if (typeof fmtAudio.similarity === 'number' && req.similarity === undefined) req.similarity = fmtAudio.similarity
    }
  } catch { /* format layer must never break audio generation */ }

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
    : providerId === 'voicestudio' ? 'Voice Studio (Local)'
    : providerId === 'macos' ? 'macOS say (Local)'
    : providerId === 'fishaudio' ? 'Fish Audio'
    : providerId === 'kie' ? 'ElevenLabs (kie.ai)'
    : 'fal.ai'

  // Voice Studio KH is special — there is no API key. The "key" we resolve
  // is the base URL of the Tailscale-reachable Pinokio modal stored in the
  // per-machine secrets bucket. URL set in App Settings → Local Models IS
  // the enable signal; no per-project toggle needed.
  let apiKey: string
  if (providerId === 'voicestudio') {
    // v1.0.149+ — same pattern as chatterbox: the "apiKey" we resolve is
    // the base URL of the Tailscale-reachable Voice Studio modal. Unlike
    // chatterbox there's no per-project enable flag — the URL being set
    // in App Settings → Local Models IS the enable. Falls through to the
    // default tailnet IP if nothing is configured (which fails fast at
    // the first connection if Tailscale isn't up).
    apiKey = (await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!apiKey) {
      throw new Error(
        'Voice Studio modal URL not configured. ' +
        'Open App Settings → Local Models and set the URL.',
      )
    }
  } else if (providerId === 'macos') {
    // macOS built-in `say` — local synthesis, no key, no URL. The voice
    // (form.voice) is the only input; the render reads it per chunk.
    apiKey = ''
  } else {
    apiKey = await resolveApiKeyForProviderId(project_slug, providerId, {
      model: req.model,
      jobId: job.job_id,
    })
    if (!apiKey) throw new Error(`No ${providerLabel} API key configured. Add one in Settings → API Keys.`)
  }

  // Preflight: for providers that expose a numeric balance, refuse the job
  // up front if it's definitively empty. GenAIPro doesn't expose a balance
  // endpoint we can query cheaply, so the preflight is skipped there and
  // the provider surfaces any quota issue on first call. Chatterbox is local
  // — no balance to check.
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

  // v1.0.381/387/388 — inline expression markup. When the operator enabled the
  // expressive script, swap each section's spoken text for its tagged version
  // (matched by slug), auto-generating any un-tagged section so a Pipeline /
  // cockpit run is fully hands-off. Runs BEFORE normalization so the inline
  // [tags] get the same punctuation cleanup (normalizeForTts leaves square
  // brackets untouched). Gated to tag-capable models via dialectForModel —
  // Fish S2-Pro (fish dialect) and ElevenLabs v3 (elevenlabs dialect) — and the
  // tags are generated/reused in THAT model's dialect so Fish tags never reach
  // ElevenLabs (or vice versa), which would otherwise be read aloud.
  if (req.use_expression === true) {
    const {
      dialectForModel, readExpression, writeExpression, markupSectionText,
      expressionTagConcurrency, mapExpressionConcurrent,
    } = await import('../services/audio-expression.js')
    const exprDialect = dialectForModel(req.model)
    if (exprDialect) {
      const expr = await readExpression(narrationPath)
      // Only reuse saved tags if they were written in THIS model's dialect.
      const reusable = expr && (expr.dialect ?? 'fish') === exprDialect
      const sectionsOut: Record<string, string> = { ...(reusable ? expr!.sections : {}) }
      const markupModel = (typeof (req as any).expression_model === 'string' && (req as any).expression_model.trim())
        ? (req as any).expression_model.trim() : 'deepseek-v4-flash'
      const apiKeys = {
        anthropic_api_key: (config as any).anthropic_api_key,
        openai_api_key: (config as any).openai_api_key,
        kie_api_key: (config as any).kie_api_key,
      }
      let applied = 0
      let generated = 0
      const missing = allSections.filter(s => !(typeof sectionsOut[s.slug] === 'string' && sectionsOut[s.slug].trim()))
      const concurrency = await expressionTagConcurrency(markupModel, missing.length)
      if (missing.length) {
        job.output_lines.push(`Expression (${exprDialect}): tagging ${missing.length} section(s) at concurrency ${concurrency}.`)
      }
      await mapExpressionConcurrent(missing, concurrency, async (s) => {
        try {
          job.output_lines.push(`Expression (${exprDialect}): auto-tagging "${s.label}" with ${markupModel}…`)
          sectionsOut[s.slug] = await markupSectionText(markupModel, s.text, apiKeys, project_slug, exprDialect)
          generated++
        } catch (e: any) {
          job.output_lines.push(`  ⚠ auto-tag failed for ${s.label} (${e?.message || e}) — using plain text`)
        }
      })
      for (const s of allSections) {
        let tagged = sectionsOut[s.slug]
        if (typeof tagged === 'string' && tagged.trim()) { s.text = tagged; applied++ }
      }
      if (generated > 0) {
        await writeExpression(narrationPath, {
          schema_version: 1, model: markupModel, dialect: exprDialect, generated_at: new Date().toISOString(), sections: sectionsOut,
        }).catch(() => { /* sidecar persistence is best-effort */ })
        job.output_lines.push(`Expression (${exprDialect}): auto-generated markup for ${generated} new section(s).`)
      }
      job.output_lines.push(`Expression (${exprDialect}): applied tagged narration to ${applied}/${allSections.length} section(s).`)
    }
  }

  // v1.0.215+ — TTS-friendly normalization (the deterministic safeguard).
  // LLM narration often carries em dashes, smart quotes, ellipses, semicolons
  // and stray markdown that local engines (Kokoro/Bark) read unnaturally —
  // an em dash becomes a garbled run-on or an odd pause, which is what makes
  // the audio sound fake. Rewrite to simple spoken punctuation on every
  // section BEFORE lexicon + chunking, so delivery is natural no matter what
  // the script carried. The audio reconciler applies the SAME pass so its
  // predicted chunk boundaries/filenames stay aligned.
  {
    const { normalizeForTts } = await import('../lib/tts-text.js')
    let totalFixed = 0
    for (const s of allSections) {
      const r = normalizeForTts(s.text)
      if (r.changes) { s.text = r.text; totalFixed += r.changes }
    }
    if (totalFixed) {
      job.output_lines.push(
        `Normalized ${totalFixed} TTS-unfriendly mark(s) (em dashes, smart quotes, …) for natural delivery.`,
      )
    }
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

  // v1.0.383/388 — auto-pacing. When enabled, deterministically insert pause
  // tags at sentence + paragraph boundaries so the read gets breathing room.
  // Runs AFTER normalization (keys off cleaned punctuation) and composes with
  // the expression pass (the dedup inside addSentencePacing prevents stacked
  // pauses). Gated to tag-capable models; the dialect picks the right tokens
  // (Fish: [short/long pause]; ElevenLabs: [pause] at paragraphs).
  if (req.fish_autopace === true) {
    const { dialectForModel, addSentencePacing } = await import('../services/audio-expression.js')
    const paceDialect = dialectForModel(req.model)
    if (paceDialect) {
      for (const s of allSections) s.text = addSentencePacing(s.text, paceDialect)
      job.output_lines.push(`Auto-pacing (${paceDialect}): inserted pause tags.`)
    }
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

  // [per-model chunk-size cap] v1.0.155+ — ElevenLabs comfortably handles
  // ~4800-char chunks (chunker's default). Local MLX TTS models have
  // much tighter soft caps (VoxCPM2: 600, F5-TTS: 400, etc., per the
  // modal's own /api/catalog). Read the cap off
  // AudioModelConfig.tts_soft_max_chars when set; the chunker falls
  // back to 4800 when the field is undefined (every cloud model today).
  // Story Studio's chunker splits at sentence boundaries within this
  // cap; ffmpeg concatenates the per-chunk WAVs in the usual
  // section-merge step — same code path that already handles
  // ElevenLabs's smaller cloud chunks. The result: VoxCPM2-driven
  // sections come out cleanly stitched at sentence boundaries instead
  // of mlx-audio's arbitrary internal cuts.
  const modelEntry = config.audio_models?.[req.model] as any
  const modelDefaultCap: number | undefined =
    typeof modelEntry?.tts_soft_max_chars === 'number' && modelEntry.tts_soft_max_chars > 0
      ? modelEntry.tts_soft_max_chars
      : undefined
  // Per-job override (Audio page form). Used primarily for voice-cloning
  // engines like VoxCPM2 where the cloned voice drifts after a certain
  // duration — smaller chunks keep each chunk within the model's coherence
  // window. Validated 50-3000 at the contract layer.
  const reqAny = req as any
  const overrideCap: number | undefined = typeof reqAny.max_chunk_chars === 'number' && reqAny.max_chunk_chars > 0
    ? reqAny.max_chunk_chars
    : undefined
  const ttsChunkCap: number | undefined = overrideCap ?? modelDefaultCap
  if (overrideCap) {
    job.output_lines.push(
      `Chunk cap for ${req.model}: ${overrideCap} chars per submit ` +
      `(per-job override from the Audio page; default would have been ${modelDefaultCap ?? 'unset'}).`,
    )
  } else if (ttsChunkCap) {
    job.output_lines.push(
      `Chunk cap for ${req.model}: ${ttsChunkCap} chars per submit ` +
      `(model-specific; see AudioModelConfig.tts_soft_max_chars).`,
    )
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

    const chunks = chunkText(section.text, ttsChunkCap)
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
      // v1.0.155+ — routed-segment chunking honours the same per-model
      // cap as the main-section chunker above, so character-routed
      // dialogue lines respect VoxCPM2's 500-char limit too.
      const segChunks = chunkText(seg.text, ttsChunkCap)
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
  const baseAudioConcurrency = Math.max(1, Math.min(50, rawConcurrency || 3))
  const isLocalAudioProvider = providerId === 'voicestudio'

  // v1.0.293 — Voice Studio voice-pool resolution. Each Voice Studio
  // instance has its OWN voice library with locally-unique UUIDs, so a
  // voice saved on m1 isn't directly addressable on m4. The picker now
  // stores voices by NAME (`vsname:Vincent`) and this module maps the
  // name to the right UUID for each endpoint we dispatch to. Legacy
  // projects with raw UUIDs in form.voice fall back to single-endpoint
  // pinning (see the comment below).
  let voicePool: import('../services/voicestudio-voice-pool.js').VoicePoolResult | null = null
  let voiceFilteredEndpoints: string[] | null = null
  let voiceJobName: string | null = null   // for per-chunk lookup in the lambda
  if (isLocalAudioProvider && req.voice) {
    const { resolveVoicePool, parseVoiceName } = await import('../services/voicestudio-voice-pool.js')
    voicePool = await resolveVoicePool(apiKey)
    voiceJobName = parseVoiceName(req.voice)
    if (voiceJobName) {
      // Name-keyed voice — filter the dispatcher to endpoints that have it.
      const v = voicePool.voicesByName[voiceJobName]
      if (!v) {
        const reachable = voicePool.reachableEndpoints.length
        const total = voicePool.endpoints.length
        const hint = reachable < total
          ? `(${reachable}/${total} endpoints responded; some may be offline)`
          : `(${reachable} endpoint(s) queried)`
        throw new Error(
          `Voice "${voiceJobName}" not found in Voice Studio's voice library on any reachable endpoint ${hint}. `
          + `Save it via Voice Studio → Voices on at least one Mac, then retry. `
          + `For full parallel speed across your pool, save the same reference clip under the same name on every Mac.`,
        )
      }
      voiceFilteredEndpoints = [...v.availableOn]
      job.output_lines.push(
        `Voice "${voiceJobName}" found on ${v.availableOn.length}/${voicePool.reachableEndpoints.length} endpoint(s).`
        + (v.availableOn.length < voicePool.reachableEndpoints.length
          ? ` Other endpoint(s) will be skipped for THIS job — save the voice there too for full parallel speed.`
          : ''),
      )
    } else {
      // Legacy UUID — find which endpoint has this UUID and pin to it.
      // This keeps pre-v1.0.293 projects working without re-selecting the
      // voice, at the cost of losing parallel dispatch (only one endpoint
      // has this UUID, so we can only run on one Mac). The user can re-
      // select the voice from the picker to upgrade to name-keyed.
      const rawId = req.voice
      let matchEndpoint: string | undefined
      let matchName: string | undefined
      outer: for (const v of Object.values(voicePool.voicesByName)) {
        for (const [ep, id] of Object.entries(v.idByEndpoint)) {
          if (id === rawId) { matchEndpoint = ep; matchName = v.name; break outer }
        }
      }
      if (matchEndpoint && matchName) {
        voiceFilteredEndpoints = [matchEndpoint]
        job.output_lines.push(
          `Legacy voice UUID "${rawId}" matches "${matchName}" on ${matchEndpoint} — pinning chunks here. `
          + `Re-select this voice from the picker to enable name-keyed multi-endpoint dispatch.`,
        )
      }
      // If no endpoint has this UUID at all, leave voiceFilteredEndpoints
      // null → falls through to the unfiltered pool, and the eventual
      // TTS call will fail with Voice Studio's own "voice not found"
      // error. That's the right place to surface it — we don't pre-empt.
    }
  }

  // v1.0.255 — Voice Studio multi-endpoint pool (run TTS across several Macs).
  // A single MLX modal serialises submits, so local concurrency was clamped to
  // 1. With multiple endpoints we parallelise ACROSS Macs (one chunk per Mac),
  // health-checking + least-busy + failover, same as the image renderer.
  let audioDispatcher: Dispatcher | null = null
  let voicePoolSize = 1
  if (isLocalAudioProvider) {
    // v1.0.437 — honour the per-Mac on/off switch: build the pool over enabled
    // endpoints only, so a Mac switched off in Settings is never used.
    const eps = parseEnabledEndpoints(apiKey)
    if (eps.length > 1) {
      const { health: voiceHealth } = await import('../lib/voicestudio-client.js')
      const { healthy, offline } = await healthyEndpoints(eps, async (u) => (await voiceHealth(u)).ok)
      let usable = healthy.length ? healthy : eps
      // v1.0.293 — further filter to endpoints that actually have the
      // requested voice. Computed above when the voice is name-keyed
      // or matches a known legacy UUID. Null = no voice-aware filter
      // (cloud, or no voice selected, or unknown UUID).
      if (voiceFilteredEndpoints && voiceFilteredEndpoints.length > 0) {
        const filtered = usable.filter(u => voiceFilteredEndpoints!.includes(u))
        if (filtered.length > 0) {
          usable = filtered
        }
        // If filter wiped out usable, fall back to unfiltered (voice exists
        // somewhere we couldn't health-check). The per-chunk lambda's
        // resolver will still pick the right endpoint via pickEndpointForVoice.
      }
      audioDispatcher = createDispatcher(usable)
      voicePoolSize = usable.length
      const filterNote = voiceFilteredEndpoints && voiceFilteredEndpoints.length < eps.length
        ? ` (filtered by voice availability — ${voiceFilteredEndpoints.length} endpoint(s) have the selected voice)`
        : ''
      job.output_lines.push(
        `Voice Studio pool: ${healthy.length}/${eps.length} online` +
        (offline.length ? ` (offline: ${offline.join(', ')})` : '') +
        ` — distributing least-busy across ${usable.length} endpoint(s)${filterNote}.`,
      )
    }
  }

  // Local: serial per Mac (MLX is serial), but parallelise across the pool.
  // Cloud providers keep their tier-tuned default (3 = ElevenLabs Starter-safe).
  const concurrency = isLocalAudioProvider
    ? Math.max(1, Math.min(baseAudioConcurrency, voicePoolSize))
    : baseAudioConcurrency
  if (isLocalAudioProvider && voicePoolSize === 1 && baseAudioConcurrency !== 1) {
    job.output_lines.push(
      `Local modal (${providerId}): concurrency 1 ` +
      `(single Apple Silicon MLX endpoint is serial — add more Image/Voice Studio URLs to parallelise across Macs).`,
    )
  }

  // v1.0.155 — `ttsChunkCap` is computed earlier (just before the
  // section loop) so the chunkText() calls in the loop can reference it
  // without a forward-reference error. See the block annotated
  // "[per-model chunk-size cap]" above.
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

  // v1.0.294 — per-endpoint latency tracking for Voice Studio pool.
  // After the first N successful calls per endpoint, we lock in a
  // "baseline avg seconds/chunk" and watch the rolling window. If the
  // recent window's average exceeds 2× baseline, the modal is probably
  // suffering from MLX memory pressure (KV cache fragmentation, VAE
  // decode churn) and we surface a one-time "restart this Mac soon"
  // hint to the Jobs panel. Single-job scoped — each new audio job
  // starts with fresh baselines. Only meaningful when isLocalAudioProvider.
  const latencyStats = isLocalAudioProvider ? newLatencyStats() : null

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
      } else if (providerId === 'fishaudio') {
        // Fish Audio (direct): streams MP3 bytes inline → write straight to
        // disk. `effectiveVoice` is the Fish reference_id (cloned voice / any
        // fish.audio model id). Stability/similarity don't apply; speed maps
        // to Fish prosody.speed and fish_temperature to expressiveness.
        await generateTtsFishaudio(task.chunkText, apiKey, task.outputPath, {
          model: req.model,
          voiceId: effectiveVoice,
          speed: req.speed,
          temperature: typeof req.fish_temperature === 'number' ? req.fish_temperature : undefined,
          signal: controller.signal,
          onProgress: makeChunkCb(),
        })
      } else if (providerId === 'kie') {
        // kie.ai ElevenLabs gateway: submit → poll → download the finished
        // audio URL (mirrors the genaipro/fal URL-download path). Same
        // ElevenLabs voices; cheapest per-character pricing of the gateways.
        const audioUrl = await generateTtsKie(task.chunkText, apiKey, {
          model: req.model,
          voiceId: effectiveVoice,
          speed: req.speed,
          stability: req.stability,
          similarity: req.similarity,
          signal: controller.signal,
          isCancelled,
          // Persist the kie taskId so a completed-but-lost download can be
          // repaired later (re-fetched from kie's task history) without paying again.
          onTaskSubmitted: async (taskId) => {
            await recordTask(audioDir, path.basename(task.outputPath), {
              provider: 'kie',
              task_id: taskId,
              submitted_at: new Date().toISOString(),
              input_hash: hashInput(task.chunkText),
            })
          },
        })
        // Retry the download itself — re-fetching the same kie CDN URL is
        // idempotent (no re-charge), so a transient "fetch failed" here
        // shouldn't kill an already-generated chunk.
        {
          let dlErr: any = null
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (isCancelled()) throw new Error('Cancelled by user')
            try { await downloadAudio(audioUrl, task.outputPath, makeChunkCb()); dlErr = null; break }
            catch (e: any) { dlErr = e; if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt)) }
          }
          if (dlErr) throw dlErr
        }
      } else if (providerId === 'macos') {
        // macOS built-in `say` — local, single-machine, no pool. Renders the
        // chunk to AIFF then transcodes to MP3 at task.outputPath. `speed`
        // maps to words-per-minute inside the client. effectiveVoice is the
        // plain voice name (e.g. "Evan"); undefined → system default voice.
        await generateTtsMacos(task.outputPath, {
          text: task.chunkText,
          voiceId: effectiveVoice,
          speed: req.speed,
        }, { signal: controller.signal })
      } else if (providerId === 'voicestudio') {
        // v1.0.149+ — Voice Studio KH writes the WAV straight to the
        // output path via its async job pipeline (POST → poll → download).
        // v1.0.255 — multi-endpoint pool: dispatch to a least-busy healthy mac.
        // v1.0.293 — voice-name resolution: if `effectiveVoice` is in the
        // `vsname:<name>` format (the new picker convention), resolve it
        // to the per-endpoint UUID at call time. Per-task character-routed
        // voice overrides go through the same path. Raw UUIDs (legacy
        // projects) pass through unchanged — pre-filtered above to the
        // single endpoint that has them.
        await runOnPool(audioDispatcher, apiKey, async (ep) => {
          let voiceIdForCall: string | undefined = effectiveVoice
          if (effectiveVoice && voicePool) {
            const { parseVoiceName, pickEndpointForVoice } = await import('../services/voicestudio-voice-pool.js')
            const name = parseVoiceName(effectiveVoice)
            if (name) {
              const picked = pickEndpointForVoice(voicePool, name, ep)
              if (!picked) {
                throw new Error(
                  `Voice "${name}" not found in Voice Studio library on any reachable endpoint. `
                  + `Save it via Voice Studio → Voices and retry.`,
                )
              }
              voiceIdForCall = picked.voiceId
              if (picked.endpoint !== ep) {
                // Dispatcher picked an endpoint that lacks this character-
                // voice; route this single chunk to the endpoint that has
                // it. The dispatcher's busy-counter is slightly off for
                // this chunk, but it self-corrects on the next call.
                ep = picked.endpoint
              }
            }
          }
          // v1.0.294 — time each successful call so the latency tracker
          // can detect MLX memory-pressure degradation. We start the
          // timer just before the actual TTS submit (after name resolution
          // overhead) and stop on success only — failures hand off to
          // the dispatcher's failover path and don't say anything useful
          // about model health.
          const callStartMs = performance.now()
          const callResult = await generateTtsVoiceStudio(ep, task.outputPath, {
            text: task.chunkText,
            apiKey: ep, // ignored by the helper but required by the AudioGenerationRequest type
            modelId: req.model,
            voiceId: voiceIdForCall,
            speed: req.speed,
          }, {
            signal: controller.signal,
            isCancelled,
            onProgress: makeChunkCb(),
          })
          if (latencyStats) {
            recordLatency(latencyStats, ep, performance.now() - callStartMs, {
              onDegradation: (msg) => job.output_lines.push(msg),
            })
          }
          return callResult
        })
      } else {
        const chunkFilename = path.basename(task.outputPath)
        // User-configurable TTS timeout (minutes → ms). Undefined means use
        // the client's built-in default (20 min for GenAIPro, 5 min for fal).
        const timeoutMinutes = (config as any)?.generation_timeouts?.tts_minutes
        const timeoutMs = typeof timeoutMinutes === 'number' && timeoutMinutes > 0
          ? timeoutMinutes * 60_000 : undefined
        // Auto-recovery: before issuing a fresh submit, see if the task
        // sidecar has a stored task_id from a previous run. If the provider
        // still has the result, polling it is free; only the fresh submit
        // below would charge a second time. Covers GenAIPro (task_id) and
        // fal (statusUrl + responseUrl pair). ElevenLabs streams direct —
        // no task_id, no recovery possible.
        if ((providerId === 'genaipro' || providerId === 'fal') && !req.force) {
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
        // Both GenAIPro and fal persist their task reference the moment the
        // submit returns, so a later timeout or crash still leaves a reference
        // the reconciler can look up deterministically. fal stores the status
        // URL (poll_path) and response URL (result_url) instead of an opaque
        // task_id — its queue API hands back URL pairs rather than ids.
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
          : await generateTtsFal(task.chunkText, apiKey, {
              ...commonOpts,
              onTaskSubmitted: async (ref) => {
                if (!ref.statusUrl || !ref.responseUrl) return
                await recordTask(audioDir, chunkFilename, {
                  provider: 'fal',
                  task_id: ref.requestId || ref.statusUrl,
                  submitted_at: new Date().toISOString(),
                  input_hash: hashInput(task.chunkText),
                  poll_path: ref.statusUrl,
                  result_url: ref.responseUrl,
                })
              },
            })
        await downloadAudio(audioUrl, task.outputPath, makeChunkCb())
      }
      job.output_lines.push(`  Saved: ${path.basename(task.outputPath)}`)
    } catch (e: any) {
      // A user cancel is NOT a chunk failure. Recording it in errors[] makes
      // the run end with a misleading "N section(s) failed: … Cancelled by
      // user". Skip it — the queue stamps the job 'cancelled' on its own (it
      // checks the cancel set on both the throw and clean-return paths).
      if (isCancelled() || /cancell?ed|abort/i.test(e?.message || '')) {
        job.output_lines.push('  Cancelled.')
        return
      }
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
  // v1.0.161+ — Defensive cross-request handling for local-modal providers.
  //
  // [1] Inter-chunk cooldown. Apple Silicon Metal driver releases buffers
  // ASYNCHRONOUSLY — the moment a forward pass finishes returning bytes,
  // the underlying GPU allocations are still queued for deallocation. A
  // back-to-back submit can hit a partly-cleaned memory pool that doesn't
  // have headroom for the next allocation, even when each request would
  // fit individually. Reproducer (voicestudio v1.2.6, M4): two 1500-char
  // submits in sequence crashed the server on submit #2 with the same
  // Abort: 6 / Metal OOM that v1.0.160 fixed for single-request size.
  // 3 s gives Metal a reliable window to drain the previous pass's pool.
  //
  // [2] Server-died detection. When a chunk fails with a network-layer
  // error (ECONNRESET / fetch failed / refused) AFTER the modal previously
  // succeeded in this run, the modal process has likely died. Subsequent
  // submits into a dead process just queue pointless work and produce
  // cascading confusing errors. processTask sets `modalDiedDuringRun`
  // when it detects the pattern (mid-loop, before catching); the worker
  // checks the flag at top of each iteration and short-circuits with a
  // clear "modal died — restart Voice Studio and retry" message.
  const isLocalModalAudio = providerId === 'voicestudio'
  const LOCAL_MODAL_INTER_CHUNK_DELAY_MS = 3_000
  let localModalPriorChunkCompleted = false
  let modalDiedDuringRun = false
  function looksLikeServerDied(err: any): boolean {
    const msg = (err?.message || String(err || '')).toLowerCase()
    return (
      msg.includes('econnreset') ||
      msg.includes('fetch failed') ||
      msg.includes('connection refused') ||
      msg.includes('socket hang up') ||
      msg.includes('cannot reach voice studio') ||
      msg.includes('refused the connection')
    )
  }

  async function worker(workerIndex: number): Promise<void> {
    if (launchStaggerMs > 0 && workerIndex > 0) {
      try {
        await sleepCancellable(workerIndex * launchStaggerMs, isCancelled)
      } catch { return /* cancelled mid-stagger */ }
    }
    while (cursor < tasks.length) {
      if (isCancelled()) return
      const i = cursor++
      // Server-died short-circuit. processTask sets the flag below
      // when it catches a network-layer failure that came AFTER a
      // successful chunk in the same run.
      if (isLocalModalAudio && modalDiedDuringRun) {
        const skipMsg =
          `  Skipping chunk ${i + 1} — local Voice Studio modal stopped ` +
          `responding earlier in this run. Restart Voice Studio in ` +
          `Pinokio (Stop → Start) and retry the generation.`
        job.output_lines.push(skipMsg)
        errors.push(`${tasks[i]!.sectionLabel}: modal died mid-batch — restart required`)
        continue
      }
      // Inter-chunk cooldown — only between consecutive successful
      // submits to the same local modal. First chunk runs immediately
      // (no prior buffers to wait on); cooldown kicks in starting at
      // chunk #2.
      if (isLocalModalAudio && localModalPriorChunkCompleted) {
        try {
          await sleepCancellable(LOCAL_MODAL_INTER_CHUNK_DELAY_MS, isCancelled)
        } catch { return /* cancelled mid-cooldown */ }
      }
      // Inspect the errors[] tail length to detect whether processTask
      // succeeded or pushed a new failure. processTask swallows
      // exceptions and appends to errors[] — we can't use a plain
      // try/catch around it.
      const errorsBefore = errors.length
      await processTask(tasks[i]!)
      const failed = errors.length > errorsBefore
      if (!failed) {
        if (isLocalModalAudio) localModalPriorChunkCompleted = true
      } else if (isLocalModalAudio && localModalPriorChunkCompleted) {
        // Failed AFTER at least one chunk in this run already succeeded.
        // Inspect the just-pushed error string for server-died patterns.
        const lastErr = errors[errors.length - 1] || ''
        if (looksLikeServerDied(lastErr)) {
          modalDiedDuringRun = true
          job.output_lines.push(
            `  ⚠ Local Voice Studio modal stopped responding mid-batch ` +
            `after chunk(s) had already succeeded — looks like a server ` +
            `crash on the modal side. Aborting remaining chunks. Restart ` +
            `Voice Studio in Pinokio (Stop → Start), then retry.`,
          )
        }
      }
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

  // v1.0.294 — emit per-endpoint latency summary into the Jobs panel.
  // Empty for cloud providers (latencyStats is null) and for single-call
  // local jobs where the baseline never locked in. Lines look like:
  //   Endpoint latency summary:
  //     • http://mac-m1:47870: 50 calls · recent avg 14.2s/chunk · baseline 13.8s
  //     • http://mac-m4:47870: 50 calls · recent avg 24.1s/chunk · baseline 12.0s · 2.0× slower · ⚠ degraded mid-job
  if (latencyStats) {
    for (const line of summarizeLatency(latencyStats)) {
      job.output_lines.push(line)
    }
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
  // instead of 'done'. But never throw on a cancel — the queue's own cancel
  // check would stamp it 'cancelled' anyway, and throwing here only attaches a
  // misleading "N section(s) failed" message to a job the user chose to stop.
  if (errors.length && !isCancelled()) {
    job.output_lines.push(`Completed with ${errors.length} error(s)`)
    const preview = errors.slice(0, 3).join('; ')
    const suffix = errors.length > 3 ? `; +${errors.length - 3} more` : ''
    throw new Error(`${errors.length} section(s) failed: ${preview}${suffix}`)
  }
  job.output_lines.push(`All audio saved to: ${audioDir}`)
  job.output_dir = audioDir
}
