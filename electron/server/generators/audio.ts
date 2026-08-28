/**
 * Audio generator — port of generate_audio.py.
 * Generates TTS narration exclusively through GenStudio KH.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import type { ProjectFactsCache } from '../services/utils.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
import { resolveTtsControlValues } from '../lib/tts-controls.js'
import {
  buildGenStudioSubmission,
  generateTtsToFile as generateTtsGenStudio,
  GenStudioArtifactUnavailableError,
  isGenStudioInsufficientCredits,
  isGenStudioRouteExhausted,
  recoverTtsToFile as recoverTtsGenStudio,
  listTtsModels as listGenStudioTtsModels,
  listVoices as listGenStudioVoices,
} from '../lib/genstudio-client.js'
import { isFleetBusyFailure } from '../lib/genstudio-fleet-busy.js'
import {
  delayUnlessAborted,
  nextTtsRouteRetryIdentity,
  TTS_ROUTE_RETRY_MAX_ATTEMPTS,
  ttsRouteRetryDelayMs,
} from '../services/tts-capacity-retry.js'
import {
  normalizeSectionsForTts,
  planGenStudioTtsRequests,
  resolveTtsRequestBudget,
  selectNarrationSections,
} from '../services/tts-request-plan.js'
import { getApiKey } from '../services/app-secrets-store.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { fileExistsWithContent, isCloudEvictedPlaceholder, isTransportFailure } from '../lib/http-retry.js'
import { recordTask, recordTaskStrict, hashInput, readManifest, type Manifest } from '../services/task-manifest.js'
import { checkpointGenStudioAsset, type GenStudioRecoveryState } from '../services/genstudio-recovery.js'
import { unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { resolveGenStudioTtsFanout } from '../lib/genstudio-runtime.js'
import { requireJobCompletion } from '../services/job-completion.js'
import type {
  GenerateAudioRequest, Job, AudioModelConfig, JobItemAttempt,
} from '../models/types.js'

type AudioProviderId = 'fal' | 'genaipro' | 'elevenlabs' | 'voicestudio' | 'genstudio' | 'macos' | 'fishaudio' | 'kie'

/**
 * TTS execution has one boundary. The union return type deliberately keeps
 * the old provider vocabulary readable to historical manifests/tests, while
 * this resolver ignores all project-owned catalog data and always dispatches
 * new work through GenStudio.
 */
export function resolveAudioProvider(
  _modelId: string,
  _audioModels: Record<string, AudioModelConfig> | undefined,
): AudioProviderId {
  void _modelId
  void _audioModels
  return 'genstudio'
}

/**
 * Local `last_state` values that mean the saved GenStudio TTS job can never
 * yield audio again. There is no `cancelled` JobState — cancellation arrives
 * as a boolean and is normalised into `failed` before it reaches the manifest.
 */
const TERMINAL_TTS_TASK_STATES: ReadonlySet<string> = new Set(['failed', 'artifact_expired'])

/**
 * An accepted GenStudio task can be safely reconnected after a restart or a
 * lost network response. A terminal provider failure cannot: its idempotency
 * key intentionally resolves to the same failed GenStudio job forever.
 */
export function isTerminalGenStudioTaskFailure(entry: {
  task_id?: string
  last_state?: string
} | null | undefined): boolean {
  return Boolean(entry?.task_id && entry.last_state && TERMINAL_TTS_TASK_STATES.has(entry.last_state))
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

export async function findNarrationFile(
  slug: string,
  episodeId: string,
  /**
   * The caller's request-scoped project facts, when it has them.
   *
   * v1.4.76 — the recursive search below scans the ENTIRE episodes tree, with
   * no depth limit, for one code-specific filename. A cold 302-episode
   * `/episodes` reaches it once per episode through `getAudioStatus`: measured
   * at ~684,000 `readdir` calls, ~44% of that endpoint's whole filesystem load.
   *
   * Given a cache we resolve the episode's OWN folder through the same
   * already-cached path resolver and confine the search to it. The filename
   * embeds the episode code, so a hit anywhere in the tree is necessarily this
   * episode's file — and it lives in this episode's folder.
   *
   * The miss case is what actually cost: on this project most episodes have no
   * narration yet, and each of those paid a fruitless walk of the WHOLE tree
   * before throwing. When the episode's folder exists, absent-from-that-folder
   * IS absent, so it throws without the walk.
   *
   * The full-tree search is kept for the case that made it necessary: an
   * episode folder renamed outside the app, where the templated path no longer
   * resolves. That is detected (the folder is not there) rather than assumed.
   */
  cache?: ProjectFactsCache,
): Promise<string> {
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

  if (cache) {
    try {
      const { resolveEpisodePathsByCode } = await import('../services/utils.js')
      const paths = await resolveEpisodePathsByCode(slug, code, cache)

      // The canonical spot the script generator writes to — one stat, no walk.
      // .md first, then the legacy .docx: the same precedence findRecursive
      // applies within a single directory.
      for (const name of [filename, `${code}_Script_Narration.docx`]) {
        const candidate = path.join(paths.script_dir, name)
        try {
          if ((await fs.stat(candidate)).isFile()) return candidate
        } catch { /* not there — try the next name */ }
      }

      // Not in the canonical spot. If the episode's folder is where the
      // template says, the file is inside it or it does not exist — so search
      // just that folder rather than the whole project.
      let episodeDirPresent = false
      try { episodeDirPresent = (await fs.stat(paths.episode_dir)).isDirectory() } catch { /* renamed or absent */ }
      if (episodeDirPresent) {
        const inEpisode = await findRecursive(paths.episode_dir)
        if (inEpisode) return inEpisode
        throw new NarrationMissingError(episodeId, filename)
      }
      // Episode folder is NOT where the template says (renamed outside the
      // app) — fall through to the full search, which is exactly what it is
      // for.
    } catch (e) {
      if (e instanceof NarrationMissingError) throw e
      /* anything else: fall through to the full search */
    }
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

  // No silent defaults (v1.0.210+): a voice MUST be explicitly chosen.
  // The Audio tab requires a pick before Generate, and pipeline runs carry
  // the voice from each step's saved preset (the pipeline pre-flight also
  // rejects a voiceless audio preset). If we still arrive here without a
  // voice, fail loudly rather than letting a provider default quietly
  // substitute a voice the user never chose — that masked-default behaviour
  // is exactly what produced "wrong voice" renders before.
  if (!req.voice || !String(req.voice).trim()) {
    throw new Error(
      'No voice selected for audio generation. Pick a voice on the Audio tab and '
      + 're-save your preset — there is no default voice.',
    )
  }

  // Format fallback for narration pace. Each channel format ships sensible
  // audioDefaults — listicle wants snappier pacing, sleep-story wants slow +
  // breathy. The frontend already seeds these into the form, so most calls
  // already carry them. This layer covers callers that bypass the page (legacy
  // presets that dropped a field, programmatic enqueues, retried jobs whose
  // params predate the format-aware roll-out). Precedence: req body → format.
  //
  // Only `speed` lives here. A format cannot ship per-model control defaults:
  // which controls exist, and what they accept, is published per model and
  // read live (lib/tts-controls.ts). A format naming one would be Story Studio
  // asserting a capability GenStudio did not publish.
  try {
    const fmt = await getEffectiveFormat(project_slug)
    const fmtAudio = fmt?.script.audioDefaults
    if (fmtAudio) {
      if (typeof fmtAudio.speed === 'number' && req.speed === undefined) req.speed = fmtAudio.speed
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

  // The customer chooses a GenStudio TTS model and is charged by it; the voice
  // is picked from the ones that model serves. Both are resolved against the
  // live catalogue here so the request boundary and price in force are the ones
  // GenStudio publishes right now.
  const resolvedVoiceModel = (req.model || '').trim()
  if (!resolvedVoiceModel) throw new Error(unavailableLegacyModelMessage('voice', req.model || '(none)'))
  req.model = resolvedVoiceModel

  // Persisted audio_models is historical evidence only and cannot influence
  // new execution: `resolveAudioProvider` returns GenStudio unconditionally,
  // whatever a stale config claims. Nothing branches on it any more — the
  // per-provider paths it used to select are gone — so it is no longer read
  // here; `audio-genstudio-only.test.ts` pins the invariant instead.
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('No GenStudio API key configured. Add it in Settings → This Mac.')

  // `maximum_input_characters` belongs to the model, is read fresh on every
  // run, and is never remembered between runs. Without it Story Studio has no
  // legitimate request boundary and refuses rather than guessing one.
  const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === req.model)
  if (!ttsModel) {
    throw new Error(
      `The selected voice model "${req.model}" is not in your GenStudio KH catalogue. `
      + 'Reopen the Audio Generator and choose a current model.',
    )
  }
  if (!ttsModel.generation_enabled) {
    throw new Error(`GenStudio KH has generation turned off for ${ttsModel.display_name}. Choose another voice model.`)
  }
  if (ttsModel.locked) {
    throw new Error(`${ttsModel.display_name} is locked for this GenStudio account. Choose an unlocked voice model. No request or credit charge was made.`)
  }
  // The published boundary, and the budget Story Studio actually plans at:
  // that boundary less the shared safety margin. `resolveTtsRequestBudget` is
  // the ONE place that decides it, and the quote route calls the same function
  // on the same live catalogue row — so the parts priced are the parts sent.
  const genStudioMaxCharacters = ttsModel.maximum_input_characters
  // The product every request in this run buys. Read once here, beside the
  // boundary, because both have to survive the handover into `processTask`.
  const genStudioModelId = ttsModel.id
  const genStudioProviderLabel = ttsModel.provider_name || 'this voice provider'
  const requestBudget = resolveTtsRequestBudget(ttsModel)
  // The control values this run submits, resolved against THIS model's
  // published `controls[]`. A name the model does not publish is dropped and a
  // value outside its published range is clamped, so a preset or a saved
  // project cannot smuggle another model's setting into the request. Empty
  // when the model publishes no controls — then nothing is sent, and the
  // idempotency key is exactly what it was before controls existed.
  const requestControls = resolveTtsControlValues(ttsModel.controls, req.controls)
  if (Object.keys(requestControls).length) {
    job.output_lines.push(
      `Model controls: ${Object.entries(requestControls).map(([name, value]) => `${name}=${value}`).join(', ')}`
      + ' (published by this model; resolved against its own ranges)',
    )
  }
  job.output_lines.push(
    `Voice model: ${ttsModel.display_name}`
    + `${ttsModel.provider_name ? ` (served by ${ttsModel.provider_name})` : ''}`
    + ` · ${genStudioMaxCharacters.toLocaleString()} characters per request published`
    + ` · splitting at ${requestBudget.effective.toLocaleString()}`
    + ` (${Math.round(requestBudget.safety_margin * 100)}% head-room, so a part cannot be refused`
    + ' for a character count GenStudio counts differently)',
  )

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
          if (isGenStudioInsufficientCredits(e)) throw e
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
  // and stray markdown that speech engines read unnaturally —
  // an em dash becomes a garbled run-on or an odd pause, which is what makes
  // the audio sound fake. Rewrite to simple spoken punctuation on every
  // section BEFORE lexicon + chunking, so delivery is natural no matter what
  // the script carried. The audio reconciler applies the SAME pass so its
  // predicted chunk boundaries/filenames stay aligned, and the quote route
  // reuses the very same helper so the pieces it prices are the pieces this
  // generator submits (services/tts-request-plan.ts).
  {
    const totalFixed = normalizeSectionsForTts(allSections)
    if (totalFixed) {
      job.output_lines.push(
        `Prepared ${totalFixed} TTS text item(s) (spoken numbers and punctuation) for natural delivery.`,
      )
    }
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

  // Filter sections. Shared with the quote route so a quote covers exactly the
  // sections a Generate press would submit — see services/tts-request-plan.ts.
  const sectionsParam = req.sections || 'all'
  const sections = selectNarrationSections(allSections, sectionsParam)

  if (!sections.length) {
    throw new Error(`No matching sections for '${sectionsParam}'`)
  }

  const errors: string[] = []
  const code = episode_id.toUpperCase()

  job.output_lines.push(`Generating ${sections.length} audio section(s)...`)

  const isCancelled = () => jq.isCancelled(job.job_id)

  // ── Flatten sections + chunks into a single task list ───────────────────
  // Collect every chunk, decide skip-vs-write semantics up-front, then stage
  // the requests concurrently. GenStudio owns durable account admission and
  // all provider/worker execution limits.
  interface ChunkTask {
    sectionLabel: string
    /** The section's stable slug, so live progress can be matched to a row. */
    sectionSlug: string
    chunkText: string
    outputPath: string
  }
  const tasks: ChunkTask[] = []

  // ── Phase 6: load characters once for this project so routing detection
  // can match speaker tags against the cast. The auto-detect approach
  // (no character_ids in the audio request) means single/zero-character
  // episodes incur this one fs scan but otherwise behave exactly as before.
  const projectCharacters = await cm.listCharacters(project_slug).catch(() => [])
  if (projectCharacters.length) {
    const withVoices = projectCharacters.filter(c => c.speech?.voiceId).length
    job.output_lines.push(`Cast: ${projectCharacters.length} character(s), ${withVoices} with voice IDs`)
  }

  // The submitted units, decided once, by the shared planner. The quote route
  // calls this same function with the same budget — derived from the same live
  // catalogue row by `resolveTtsRequestBudget` — so what GenStudio was asked to
  // price is what is about to be submitted.
  const genStudioRequestPlan = planGenStudioTtsRequests(sections, requestBudget.effective)

  for (const [sectionIndex, section] of sections.entries()) {
    if (isCancelled()) break
    const filename = `${code}_${section.slug}.mp3`
    const savePath = path.join(audioDir, filename)

    // One GenStudio request per planned part. `resolveAudioProvider` returns
    // GenStudio unconditionally, so there is no other boundary to honour.
    const chunks = genStudioRequestPlan[sectionIndex]!.parts
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
      if (await fileExistsWithContent(chunkPath)) {
        if (req.no_overwrite) {
          let v = 2
          while (existsSync(chunkPath.replace('.mp3', `_v${v}.mp3`))) v++
          chunkPath = chunkPath.replace('.mp3', `_v${v}.mp3`)
        } else if (!req.force) {
          job.output_lines.push(`  Skipping ${path.basename(chunkPath)} (exists)`)
          continue
        }
      }

      tasks.push({
        sectionLabel: section.label,
        sectionSlug: section.slug,
        chunkText: chunks[i]!,
        outputPath: chunkPath,
      })
    }
  }

  // The selected model's live hint is advisory. GenStudio admission remains
  // authoritative; no provider identity is inferred as a dispatch limit.
  const concurrency = resolveGenStudioTtsFanout(tasks.length, ttsModel.provider_submit_concurrency)

  if (tasks.length > 1) {
    job.output_lines.push(
      `Staging ${tasks.length} TTS request(s), ${concurrency === 1 ? 'one at a time' : `${concurrency} at a time`}`
      + ` for ${genStudioProviderLabel}`
      + '; GenStudio account admission is authoritative for the rest.',
    )
  }

  // ── Live per-item progress ────────────────────────────────────────────────
  // A run this long has to be able to say what it is doing. `job.progress`
  // drives the bar; `job.item_progress` names the section in flight and, when
  // a provider has asked us to wait, says so explicitly — which is the only
  // thing that distinguishes deliberate pacing from a wedged job.
  let completedTasks = 0
  let failedTasks = 0
  const activeTasks = new Map<string, JobItemAttempt>()
  function publishProgress(): void {
    job.progress = tasks.length
      ? Math.round(((completedTasks + failedTasks) / tasks.length) * 100)
      : 100
    job.item_progress = {
      total: tasks.length,
      completed: completedTasks,
      failed: failedTasks,
      concurrency,
      // Ordered by label so a re-render doesn't reshuffle rows when a Map
      // entry is replaced in place.
      active: [...activeTasks.values()].sort((a, b) => a.label.localeCompare(b.label)),
    }
  }
  publishProgress()

  // AbortController fed from a 500 ms cancel watcher — matches the subtitles
  // generator's pattern. ElevenLabs streams MP3 bytes directly from fetch, so
  // a signal tears that down the moment the user cancels instead of letting
  // the stream finish and still bill the account.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (isCancelled()) controller.abort()
  }, 500)

  /**
   * One TTS request, from identity through to the saved file.
   *
   * `submissionIdentity` is what makes the attempt distinct. Attempt 1 uses
   * the durable per-chunk identity (or the manual-retry identity, when the
   * saved job is terminally dead); every later attempt uses the identity
   * `nextTtsRouteRetryIdentity` derived from the job that just failed, so the
   * attempt is repeatable rather than merely new.
   */
  async function attemptTask(
    task: ChunkTask,
    options: {
      chunkFilename: string
      effectiveVoice: string | undefined
      submissionIdentity: string
      inputHash: string
      /** Reclaimable accepted work from a previous run. Only ever attempt 1. */
      recoveryEntry: Manifest['tasks'][string] | null
      announceRecoveryFromTerminal: boolean
    },
  ): Promise<void> {
    const {
      chunkFilename, effectiveVoice, submissionIdentity,
      inputHash, recoveryEntry, announceRecoveryFromTerminal,
    } = options
    {
      const prepared = buildGenStudioSubmission({
        text: task.chunkText,
        voiceId: effectiveVoice,
        // The PRODUCT being bought. GenStudio sells speech by model and rejects
        // a body without `model_id`, so the model this generator selected,
        // validated against the live catalogue and printed above has to reach
        // the wire — not just the log line.
        modelId: genStudioModelId,
        speed: req.speed ?? 1,
        controls: requestControls,
        // The PUBLISHED boundary, deliberately — this is the contract check
        // against what GenStudio will accept, not Story Studio's planning
        // head-room. A body planned inside the smaller budget passes it.
        maxInputCharacters: genStudioMaxCharacters,
        // Decided by the caller: the durable identity, the manual-retry
        // identity, or an identity derived from the job this chunk just
        // failed as. Every one of them is a pure function of what happened,
        // never of a clock — so replaying an attempt replays its job.
        requestIdentity: submissionIdentity,
      })
      const idempotencyKey = recoveryEntry?.idempotency_key || prepared.idempotencyKey
      const submittedAt = recoveryEntry?.submitted_at || new Date().toISOString()

      if (announceRecoveryFromTerminal) {
        job.output_lines.push(
          `  Previous GenStudio task failed terminally; submitting a new recovery task for ${chunkFilename}.`,
        )
      }
      // The identity above is derived ONCE per attempt, then persisted below
      // before the POST. Any later attempt reads the saved (non-terminal)
      // entry back and reuses its idempotency_key, so a lost response replays
      // the paid job instead of minting a second identity for it.

      // Persist identity before POST. Legacy manifest entries are deliberately
      // ignored unless they already represent this exact GenStudio request.
      await recordTaskStrict(audioDir, chunkFilename, {
        provider: 'genstudio',
        task_id: recoveryEntry?.task_id || '',
        submitted_at: submittedAt,
        input_hash: inputHash,
        idempotency_key: idempotencyKey,
        operation: 'tts',
        last_state: recoveryEntry?.last_state || 'prepared',
      })
      await checkpointGenStudioAsset(job, chunkFilename, {
        operation: 'tts',
        idempotency_key: idempotencyKey,
        ...(recoveryEntry?.task_id ? { job_id: recoveryEntry.task_id } : {}),
        state: (recoveryEntry?.last_state || 'prepared') as GenStudioRecoveryState,
      })
      job.output_lines.push(`  GenStudio request: ${task.sectionLabel} -> ${idempotencyKey}`)
      const request = {
        text: task.chunkText,
        voiceId: effectiveVoice,
        // Same rebuild, same reason as `maxInputCharacters` below: the submit
        // path builds the wire body from THIS object, so the selected product
        // has to travel on it. Carried on the recovery object too — harmless
        // there, and it keeps one literal serving both paths.
        modelId: genStudioModelId,
        speed: req.speed ?? 1,
        controls: requestControls,
        // The submit path rebuilds the request body from THIS object, so the
        // published boundary has to travel on it too. Without it the rebuild
        // refused every section — in GenStudio's name, for a figure GenStudio
        // had published correctly all along. Same live catalogue value as the
        // `prepared` submission above; there is only one source for it.
        maxInputCharacters: genStudioMaxCharacters,
        // THIS attempt's identity, not the chunk's durable one. The submit
        // path rebuilds a submission from this object, and a retry attempt
        // that rebuilt under the base identity would derive the dead job's
        // key again the moment `idempotencyKey` was ever absent.
        requestIdentity: submissionIdentity,
        idempotencyKey,
        signal: controller.signal,
        isCancelled,
        onProgress: makeChunkCb(),
        onJobAccepted: async (providerJobId: string, acceptedIdempotencyKey: string) => {
          await recordTaskStrict(audioDir, chunkFilename, {
            provider: 'genstudio',
            task_id: providerJobId,
            submitted_at: submittedAt,
            input_hash: inputHash,
            idempotency_key: acceptedIdempotencyKey,
            operation: 'tts',
            last_state: 'accepted',
          })
          await checkpointGenStudioAsset(job, chunkFilename, {
            operation: 'tts',
            idempotency_key: acceptedIdempotencyKey,
            job_id: providerJobId,
            state: 'accepted',
          })
          job.output_lines.push(`  GenStudio task: ${task.sectionLabel} -> ${providerJobId}`)
        },
        onState: async (state: GenStudioRecoveryState, providerJobId: string) => {
          await recordTaskStrict(audioDir, chunkFilename, {
            provider: 'genstudio',
            task_id: providerJobId,
            submitted_at: submittedAt,
            input_hash: inputHash,
            idempotency_key: idempotencyKey,
            operation: 'tts',
            last_state: state,
          })
          await checkpointGenStudioAsset(job, chunkFilename, {
            operation: 'tts',
            idempotency_key: idempotencyKey,
            job_id: providerJobId,
            state,
          })
        },
      }
      if (recoveryEntry?.task_id) {
        job.output_lines.push(`  Reclaiming accepted GenStudio task ${recoveryEntry.task_id.slice(0, 12)}… for ${chunkFilename}.`)
        await recoverTtsGenStudio(apiKey, task.outputPath, recoveryEntry.task_id, request)
      } else {
        await generateTtsGenStudio(apiKey, task.outputPath, request)
      }
      job.output_lines.push(`  Saved: ${path.basename(task.outputPath)}`)
    }
  }

  async function processTask(task: ChunkTask): Promise<void> {
    if (isCancelled()) return
    // Phase 6: per-task voice override for routed sections. Falls back to
    // the request's project-default voice when not set.
    const effectiveVoice = req.voice || undefined
    const chunkFilename = path.basename(task.outputPath)
    // Ensure intermediate dir exists (routed-section files live in .routed/).
    await fs.mkdir(path.dirname(task.outputPath), { recursive: true }).catch(() => {})

    // Resolved once: none of this depends on which attempt we are on. The
    // input hash in particular MUST stay on the chunk's durable identity, or a
    // resumed run would fail to recognise its own manifest entry and resubmit
    // work it had already paid for.
    const manifestEntry = audioManifest.tasks[chunkFilename]
    const requestIdentity = `${project_slug}:${episode_id.toUpperCase()}:audio:${chunkFilename}`
    const inputHash = hashInput(JSON.stringify({
      requestIdentity,
      text: task.chunkText,
      voiceId: effectiveVoice || '',
      speed: req.speed ?? 1,
      maxInputCharacters: genStudioMaxCharacters,
      // Spread conditionally for the same reason the idempotency digest does
      // it: a model publishing no controls hashes exactly as before, so an
      // existing manifest entry stays reusable across this upgrade instead of
      // being resubmitted (and recharged) for a request that has not changed.
      ...(Object.keys(requestControls).length ? { controls: requestControls } : {}),
    }))
    const legacyTextHash = hashInput(task.chunkText)
    const reusableEntry = manifestEntry?.provider === 'genstudio'
      && (manifestEntry.input_hash === inputHash
        || (!!manifestEntry.task_id && manifestEntry.input_hash === legacyTextHash))
      ? manifestEntry
      : null
    const terminalFailure = isTerminalGenStudioTaskFailure(reusableEntry)
    const explicitRegeneration = req.force === true
    // Explicit Regenerate/New version work owns the current Story job's fresh
    // identity and must never adopt a successful task from an older run.
    // Ordinary retries retain unfinished accepted work; terminal provider
    // failures receive a separate manual-retry identity.
    let submissionIdentity = explicitRegeneration
      ? `${requestIdentity}:regenerate:${job.job_id}`
      : terminalFailure
      ? `${requestIdentity}:manual-retry:${job.job_id}`
      : requestIdentity
    // Only the first attempt may reclaim work a previous run left accepted.
    let recoveryEntry = explicitRegeneration || terminalFailure ? null : reusableEntry

    activeTasks.set(chunkFilename, {
      label: task.sectionLabel,
      key: task.sectionSlug,
      state: 'running',
      attempt: 1,
      max_attempts: TTS_ROUTE_RETRY_MAX_ATTEMPTS,
    })
    publishProgress()
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await attemptTask(task, {
            chunkFilename,
            effectiveVoice,
            submissionIdentity,
            inputHash,
            recoveryEntry,
            announceRecoveryFromTerminal: terminalFailure && attempt === 1,
          })
          completedTasks++
          return
        } catch (e: any) {
          if (isGenStudioInsufficientCredits(e)) throw e
          // A user cancel is NOT a chunk failure. Recording it in errors[]
          // makes the run end with a misleading "N section(s) failed: …
          // Cancelled by user". Skip it — the queue stamps the job 'cancelled'
          // on its own (it checks the cancel set on both the throw and
          // clean-return paths).
          if (isCancelled() || /cancell?ed|abort/i.test(e?.message || '')) {
            job.output_lines.push('  Cancelled.')
            return
          }
          // A settled GenStudio outcome must be recorded locally, or the next
          // Retry has no way to know the saved job can never succeed and will
          // replay its dead idempotency key forever. `onState` covers a failed
          // job state; this covers the succeeded-but-artifact-gone case, which
          // has no state change.
          if (e instanceof GenStudioArtifactUnavailableError && e.modality === 'tts') {
            await recordTask(audioDir, chunkFilename, {
              provider: 'genstudio',
              task_id: e.jobId,
              submitted_at: new Date().toISOString(),
              operation: 'tts',
              last_state: 'artifact_expired',
            }).catch(() => { /* evidence write must never mask the real failure */ })
          }

          // THE FAILURES WORTH ASKING AGAIN ABOUT — both of which prove no
          // provider did any work and the reservation was released, so another
          // attempt costs time and nothing else. Any other terminal code may
          // describe work a provider already performed, and fails fast here
          // rather than being paid for twice.
          //
          //   CLOUD_PROVIDER_EXHAUSTED — every route GenStudio ranked for this
          //     product declined to take the request. Handled since 1.2.x.
          //
          //   SITE_PLACEMENT_EXHAUSTED / SITE_CAPACITY_UNAVAILABLE (v1.4.25) —
          //     GenStudio itself could not find a free MACHINE. A different
          //     thing from a provider declining, and it was not covered here:
          //     `tts-capacity-retry.ts` shipped on 7 August against the
          //     provider code alone, and VOICE_TTS then hit the fleet code five
          //     times on 13-15 August and lost those sections silently. Nobody
          //     noticed, because the only symptom is a missing chapter that a
          //     later manual retry quietly fills in.
          //
          // The owner found the same hole in subtitles the hard way — 122 of
          // 353 refused in one burst — and asked the obvious next question:
          // "what about the other generators". This is one of the answers.
          //   A DROPPED CONNECTION (v1.4.76) — the request was never answered,
          //     so no route can have taken it. This was the one class the rule
          //     above read backwards: `fetch failed` is not a
          //     GenStudioTerminalFailureError, so both predicates returned
          //     false and the section was abandoned on attempt 1 with the raw
          //     undici text ("9 section(s) failed: Chapter 1: fetch failed").
          //     The client's own retry is ~3.5s of backoff — fine for a blip,
          //     nowhere near a GenStudio restart, which is when whole batches
          //     were lost. This ladder is minutes, which is the right scale.
          const transportFailure = isTransportFailure(e)
          const worthRetrying = isGenStudioRouteExhausted(e) || isFleetBusyFailure(e, 'tts')
            || transportFailure
          if (!worthRetrying || attempt >= TTS_ROUTE_RETRY_MAX_ATTEMPTS) {
            failedTasks++
            // Settled-pool semantics: one chunk failure doesn't kill the
            // batch. The queue stamps status='error' after the loop if
            // errors.length > 0.
            job.output_lines.push(`  Failed: ${e.message}`)
            errors.push(`${task.sectionLabel}: ${e.message}`)
            return
          }

          const waitMs = ttsRouteRetryDelayMs(attempt - 1)
          const reason = transportFailure
            ? `Could not reach ${genStudioProviderLabel}`
            : isFleetBusyFailure(e, 'tts')
            ? 'Every machine was busy'
            : `No ${genStudioProviderLabel} route would accept this request`
          activeTasks.set(chunkFilename, {
            label: task.sectionLabel,
            key: task.sectionSlug,
            state: 'waiting_retry',
            attempt,
            max_attempts: TTS_ROUTE_RETRY_MAX_ATTEMPTS,
            retry_at: new Date(Date.now() + waitMs).toISOString(),
            reason,
          })
          publishProgress()
          job.output_lines.push(
            `  ${task.sectionLabel}: ${reason.toLowerCase()} — nothing was charged.`
            + ` Retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1} of ${TTS_ROUTE_RETRY_MAX_ATTEMPTS}).`,
          )
          if (transportFailure) {
            // THE IDENTITY MUST NOT MOVE. A settled failure is dead — its key
            // replays the same failure forever — so those retries mint a
            // derived identity below. A dropped connection is the opposite
            // case: the request may well have been RECEIVED, and a fresh
            // identity would be a fresh idempotency key, which is a second
            // job and a second charge for one chapter. Replaying the same key
            // is what makes GenStudio hand back the job it already has.
            //
            // Re-read the manifest rather than trusting the captured entry:
            // if the connection dropped AFTER the job was accepted,
            // `onJobAccepted` has already written its id, and reclaiming it
            // reconnects instead of submitting anything at all.
            const persisted = (await readManifest(audioDir).catch(() => null))?.tasks[chunkFilename]
            if (persisted?.provider === 'genstudio' && persisted.task_id) recoveryEntry = persisted
          } else {
            // Derived from the job that just failed, so this retry is repeatable:
            // replaying it returns the job GenStudio already has for it instead
            // of selling a second one.
            submissionIdentity = nextTtsRouteRetryIdentity(submissionIdentity, e.jobId || chunkFilename)
            recoveryEntry = null
          }
          await delayUnlessAborted(waitMs, controller.signal)
          if (isCancelled()) {
            job.output_lines.push('  Cancelled.')
            return
          }
          activeTasks.set(chunkFilename, {
            label: task.sectionLabel,
            key: task.sectionSlug,
            state: 'running',
            attempt: attempt + 1,
            max_attempts: TTS_ROUTE_RETRY_MAX_ATTEMPTS,
          })
          publishProgress()
        }
      }
    } finally {
      activeTasks.delete(chunkFilename)
      publishProgress()
    }
  }

  let cursor = 0
  let creditFailure: unknown
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      if (isCancelled() || creditFailure) return
      if (jq.isPauseRequested(job.job_id)) return
      const i = cursor++
      try {
        await processTask(tasks[i]!)
      } catch (error) {
        if (!isGenStudioInsufficientCredits(error)) throw error
        creditFailure ||= error
        return
      }
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, tasks.length) },
        () => worker(),
      ),
    )
  } finally {
    clearInterval(cancelWatcher)
  }
  if (creditFailure) throw creditFailure
  jq.throwIfPauseRequested(job.job_id)

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
  if (!isCancelled()) {
    const { getAudioStatus } = await import('../services/audio-reconciler.js')
    const status = await getAudioStatus(project_slug, episode_id)
    const selectedLabels = new Set(sections.map(section => section.label))
    const expected = status.expected.filter(chunk => selectedLabels.has(chunk.sectionLabel))
    const missingSet = new Set(status.missing)
    const missing = expected.filter(chunk => missingSet.has(chunk.filename)).map(chunk => chunk.filename)
    requireJobCompletion(job, {
      label: 'Audio generation',
      expected: Math.max(1, expected.length),
      completed: expected.length > 0 ? expected.length - missing.length : 0,
      missing: expected.length > 0 ? missing : sections.map(section => section.label),
      retry_hint: 'Completed audio files were kept. Retry generates or recovers only the missing sections.',
    })
  }
  job.output_lines.push(`All audio saved to: ${audioDir}`)
  job.output_dir = audioDir
}
