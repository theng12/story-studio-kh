/**
 * Audio generator — port of generate_audio.py.
 * Generates TTS narration exclusively through GenStudio KH.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { createProjectFactsCache, resolveEpisodePathsByCode, resolveEpisodePathsByCodeWithSidecar, type ProjectFactsCache } from '../services/utils.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
import { resolveTtsControlValues } from '../lib/tts-controls.js'
import {
  buildGenStudioSubmission,
  generateTtsToFile as generateTtsGenStudio,
  GenStudioArtifactUnavailableError,
  isGenStudioInsufficientCredits,
  isGenStudioRouteExhausted,
  evidenceHoldsUnknownOutcome,
  recoverTtsToFile as recoverTtsGenStudio,
  listTtsModels as listGenStudioTtsModels,
  listVoices as listGenStudioVoices,
  resolveGenStudioTtsSpeed,
  refreshGenStudioAdmission,
} from '../lib/genstudio-client.js'
import { fleetBusyRetryPlan, freeMacWaitLine } from '../lib/genstudio-fleet-busy.js'
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
import { chapterScriptFingerprint } from '../services/audio-quality.js'
import { getApiKey } from '../services/app-secrets-store.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { fileExistsWithContent, isTransportFailure } from '../lib/http-retry.js'
import { recordTask, recordTaskStrict, hashInput, readManifest, type Manifest } from '../services/task-manifest.js'
import { checkpointGenStudioAsset, type GenStudioRecoveryState } from '../services/genstudio-recovery.js'
import { unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { resolveGenStudioTtsFanout } from '../lib/genstudio-runtime.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'
import { formatConcatFileLine, runFfmpeg } from '../lib/ffmpeg-utils.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { correctChapterCues } from '../lib/srt-correction.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { AudioQualityVerificationCreditCeilingError, verifyAudioQualityCandidateRawTranscript } from '../services/audio-quality-transcription.js'
import { promoteAudioQualityCandidate, readAudioQualityProvenance, updateAudioQualityProvenance } from '../services/audio-quality-store.js'
import { readAudioTtsModelRecord, writeAudioTtsModelRecord, type AudioTtsModelRecord } from '../services/audio-tts-model-record.js'
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
 * A normal successful overwrite supersedes a previously selected retained
 * candidate.  Versioned `no_overwrite` output intentionally does not call
 * this: it remains an alternate until the user explicitly selects it.
 */
async function selectNormalAudioSources(
  episodeDir: string,
  audioDir: string,
  sources: Record<string, string[]>,
  beforeCommit: () => Promise<void>,
): Promise<number | null> {
  const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
  return withLock(sidecarPath, async () => {
    let sidecar: { sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>; [key: string]: unknown }
    try { sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8')) }
    catch (error: any) {
      // Before Audio Assembly creates this optional selector, complete base
      // files are implicitly active. Malformed or unreadable selectors are
      // different: they may carry an active candidate mapping we must not
      // overwrite or silently ignore.
      if (error?.code === 'ENOENT') {
        await beforeCommit()
        return null
      }
      throw new Error(`the active audio selection cannot be read (${error?.message || String(error)})`)
    }
    if (!Array.isArray(sidecar.sections)) throw new Error('the active audio selection has no valid sections')
    const planned: Array<{ row: { source_file?: unknown; source_files?: unknown }; files: string[] }> = []
    for (const [slug, files] of Object.entries(sources)) {
      if (!files.length || files.some(file => !file.trim() || path.basename(file) !== file)) {
        throw new Error(`the replacement source list is invalid for ${slug}`)
      }
      const available = await Promise.all(files.map(async file => {
        try {
          const stat = await fs.stat(path.join(audioDir, file))
          return stat.isFile() && stat.size > 0
        } catch (error: any) {
          if (error?.code === 'ENOENT') return false
          throw error
        }
      }))
      if (!available.every(Boolean)) throw new Error(`replacement audio is missing or empty for ${slug}`)
      const row = sidecar.sections.find(section => typeof section.slug === 'string'
        && section.slug.toLowerCase() === slug.toLowerCase())
      if (!row) throw new Error(`the active audio selection has no row for ${slug}`)
      planned.push({ row, files })
    }
    await beforeCommit()
    for (const { row, files } of planned) {
      row.source_files = [...files]
      row.source_file = files[0]!
    }
    await writeJsonAtomic(sidecarPath, sidecar)
    return planned.length
  })
}

function audioActivationError(reason: string): Error {
  return new Error(
    `Audio replacement could not be activated because ${reason}. `
    + 'The paid audio files were kept and the previous selection and model remain active. '
    + 'Retry can reuse completed provider work; if a selected section was skipped without replacement evidence, '
    + 'use Replace/Regenerate to complete it or restore and reselect the intended source.',
  )
}

/**
 * A deliberate browser action receives this marker only from the route. Its
 * ID survives a queue retry, unlike the queue record's own ID. Keep accepting
 * pre-marker jobs below so an interrupted older job retains its prior recovery
 * behaviour.
 */
function freshGenerationActionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const action = value as { id?: unknown; kind?: unknown }
  return action.kind === 'fresh' && typeof action.id === 'string' && action.id.trim()
    ? action.id.trim()
    : undefined
}

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
   * The caller's request-scoped project facts, when it has them. A lone
   * lookup gets the same slug-bound cache so it follows the bounded path too.
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
  cache: ProjectFactsCache = createProjectFactsCache(slug),
  options: { strictIo?: boolean } = {},
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
    } catch (error) {
      if (options.strictIo && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    return null
  }

  try {
    const paths = await resolveEpisodePathsByCode(slug, code, cache)

    // The canonical spot the script generator writes to — one stat, no walk.
    // .md first, then the legacy .docx: the same precedence findRecursive
    // applies within a single directory.
    for (const name of [filename, `${code}_Script_Narration.docx`]) {
      const candidate = path.join(paths.script_dir, name)
      try {
        if ((await fs.stat(candidate)).isFile()) return candidate
      } catch (error) {
        if (options.strictIo && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
    }

    // Not in the canonical spot. If the episode's folder is where the
    // template says, the file is inside it or it does not exist — so search
    // just that folder rather than the whole project.
    let episodeDirPresent = false
    try {
      episodeDirPresent = (await fs.stat(paths.episode_dir)).isDirectory()
    } catch (error) {
      if (options.strictIo && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    if (episodeDirPresent) {
      const inEpisode = await findRecursive(paths.episode_dir)
      if (inEpisode) return inEpisode

      // Before episode folders, scripts lived directly under the output root
      // as `{CODE} - Script`. A later canonical folder can coexist with that
      // legacy narration while generation is moving files, so probe the known
      // flat location without reopening the project-wide walk.
      for (const name of [filename, `${code}_Script_Narration.docx`]) {
        const legacy = path.join(outputRoot, `${code} - Script`, name)
        try {
          if ((await fs.stat(legacy)).isFile()) return legacy
        } catch (error) {
          if (options.strictIo && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
        }
      }
      throw new NarrationMissingError(episodeId, filename)
    }
    // Episode folder is NOT where the template says (renamed outside the
    // app) — fall through to the full search, which is exactly what it is
    // for.
  } catch (e) {
    if (e instanceof NarrationMissingError) throw e
    if (options.strictIo && (e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
    /* anything else: fall through to the full search */
  }

  const found = await findRecursive(outputRoot)
  if (found) return found
  throw new NarrationMissingError(episodeId, filename)
}

/**
 * The episode ROOT that owns a narration file.
 *
 * Narration usually sits at the episode root, but the script folder is also a
 * legal home for it — in which case the episode root is one level up. Exported
 * so `resolveAudioDir` and the TTS-model record agree on one rule instead of
 * each re-deriving it (the sidecar must land exactly where the reconciler looks
 * for it).
 */
export function episodeDirForNarration(narrationPath: string): string {
  const parent = path.dirname(narrationPath)
  const parentName = path.basename(parent).replace(/^✅\s*/, '').toLowerCase()
  const isScriptFolder = parentName.includes('script') && !parentName.includes('prompt')
  return isScriptFolder ? path.dirname(parent) : parent
}

export async function resolveAudioDir(
  projectSlug: string,
  narrationPath: string,
  episodeId: string,
  cache?: ProjectFactsCache,
  options: { strictIo?: boolean } = {},
): Promise<string> {
  const code = episodeId.toUpperCase()
  const episodeDir = episodeDirForNarration(narrationPath)

  // Use centralized config helper for subfolder name
  const { resolveSubfolderNames } = await import('../services/utils.js')
  const names = await resolveSubfolderNames(projectSlug, code, cache)
  const audioName = names.audio // e.g. "TN0024 - 07 Audio Assets"

  // Level B (opt-in): audio is heavy media — route to the external media root
  // when the project configured one; otherwise resolve under the iCloud
  // episodeDir exactly as before.
  const { mediaEpisodeBaseForCode } = await import('../services/media-root.js')
  const base = (await mediaEpisodeBaseForCode(projectSlug, code, cache)) ?? episodeDir

  // v1.0.338 — shared lookup (handles the ✅ done-marker prefix); falls
  // back to the config-based path, which the writer creates on demand.
  const { findSubfolder } = await import('../lib/folder-resolver.js')
  return (await findSubfolder(base, audioName, options)) ?? path.join(base, audioName)
}

/**
 * Execute a paid alternate-ASR check over immutable staged copies of selected
 * active narration. It deliberately precedes the ordinary voice/TTS path and
 * never writes audio, subtitles, or an active source map.
 */
async function runActiveAudioQualityCheck(job: Job, req: GenerateAudioRequest, marker: NonNullable<GenerateAudioRequest['quality_check']>): Promise<void> {
  const actionId = marker.action_id.trim()
  const generationActionId = freshGenerationActionId((req as GenerateAudioRequest & { generation_action?: unknown }).generation_action)
  if (!actionId || actionId !== generationActionId) throw new Error('The active-audio quality check has no matching server-owned action.')
  const paths = await resolveEpisodePathsByCodeWithSidecar(job.project_slug, job.episode_id, 'audio_chapters.json')
  const action = (await readAudioQualityProvenance(paths.episode_dir)).actions?.[actionId]
  const active = action?.active_check
  if (!action || !active || action.source_fingerprint !== marker.source_fingerprint || active.state !== 'checking') {
    throw new Error('The active-audio quality check is no longer actionable.')
  }
  const expectedRoot = path.resolve(paths.episode_dir, '.audio-quality-checks', actionId)
  const checkRoot = path.resolve(paths.episode_dir, active.staging_dir)
  if (checkRoot !== expectedRoot) throw new Error('The active-audio quality check staging path is invalid.')
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('No Gateway key configured. Add it in Settings → This Mac.')
  const narrationPath = await findNarrationFile(job.project_slug, job.episode_id)
  const { inspectAudioQualityActionScope } = await import('../services/audio-quality.js')
  const proveScope = async () => {
    const scope = await inspectAudioQualityActionScope({
      episodeDir: paths.episode_dir, audioDir: paths.audio_dir, subtitlesDir: paths.subtitles_dir,
      scriptDir: path.dirname(narrationPath), episodeCode: job.episode_id,
    }, action.sections)
    if (scope.scope_fingerprint !== action.scope_fingerprint || scope.source_fingerprint !== action.source_fingerprint
      || JSON.stringify(scope.source_files) !== JSON.stringify(action.source_files)) {
      throw new Error('The selected active audio or script changed after its quality quote. Quote again before checking.')
    }
    return scope
  }
  await proveScope()
  const allSections = await parseNarrationDocx(narrationPath)
  const bySlug = new Map(allSections.map(section => [section.slug.toLowerCase(), section]))
  const outcomes: Array<{ slug: string; accepted: boolean; reason?: string }> = []
  for (const slug of action.sections) {
    if (jq.isCancelled(job.job_id)) {
      job.output_lines.push('Active narration quality check was cancelled before another ASR request. Active audio and subtitles were left unchanged.')
      return
    }
    const section = bySlug.get(slug.toLowerCase())
    const quote = active.quotes[slug]
    if (!section?.text.trim() || !quote) throw new Error(`Active-audio quality check is missing its staged ${slug} evidence.`)
    const stagedPath = path.join(checkRoot, 'audio', `${slug.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')}.mp3`)
    const stagedBytes = await fs.readFile(stagedPath).catch(() => null)
    const stagedHash = stagedBytes ? `sha256:${createHash('sha256').update(stagedBytes).digest('hex')}` : null
    if (!stagedHash || stagedHash !== quote.audio_hash) {
      throw new Error(`The staged active audio for ${slug} changed after its quote. No active output was modified.`)
    }
    let raw: Awaited<ReturnType<typeof verifyAudioQualityCandidateRawTranscript>>
    try {
      raw = await verifyAudioQualityCandidateRawTranscript({
        job, actionId, section: slug, candidateAudioPath: stagedPath,
        candidateOutDir: path.join(checkRoot, 'transcripts'), apiKey,
        transcription: { modelId: active.model_id },
        verification_credit_ceiling: active.credit_ceiling || marker.verification_credit_ceiling,
        // model-drift-allow: local verification ledger begins at zero before a provider confirmation.
        verification_committed_credits: active.committed_credits || 0,
        preparedQuote: quote,
        authorizeQuote: async liveQuote => {
          await proveScope()
          let held = false
          await updateAudioQualityProvenance(paths.episode_dir, current => {
            const pending = current.actions?.[actionId]?.active_check
            if (!pending || pending.model_id !== active.model_id) throw new Error('The active-audio quality checkpoint changed while the quote was pending.')
            const ceiling = pending.credit_ceiling || marker.verification_credit_ceiling
            // model-drift-allow: local verification ledger begins at zero before a provider confirmation.
            const committed = pending.committed_credits || 0
            const cost = liveQuote.quoted_credit_cost
            pending.quotes[slug] = { ...liveQuote, audio_hash: quote.audio_hash }
            if (!Number.isSafeInteger(ceiling) || typeof cost !== 'number' || !Number.isFinite(cost) || cost > ceiling - committed) {
              pending.state = 'needs_approval'
              held = true
              return
            }
            pending.committed_credits = committed + cost
          })
          if (held) throw new AudioQualityVerificationCreditCeilingError(liveQuote, 0)
        },
      })
    } catch (error) {
      if (error instanceof AudioQualityVerificationCreditCeilingError) {
        await updateAudioQualityProvenance(paths.episode_dir, current => {
          const pending = current.actions?.[actionId]?.active_check
          if (pending) {
            pending.state = 'needs_approval'
            pending.quotes[slug] = { ...error.quote, audio_hash: quote.audio_hash }
          }
        })
        job.result = { ...job.result, quality_check: { action_id: actionId, state: 'needs_approval', quote: error.quote } }
        job.output_lines.push(`Active narration ASR check is held for approval: ${error.message}`)
      }
      throw error
    }
    const trust = correctChapterCues(raw.rawCues, section.text).trust
    outcomes.push({ slug, accepted: trust.accepted, ...(trust.accepted ? {} : { reason: trust.reason }) })
  }
  if (jq.isCancelled(job.job_id)) {
    job.output_lines.push('Active narration quality check was cancelled before saving its result. Active audio and subtitles were left unchanged.')
    return
  }
  await proveScope()
  await updateAudioQualityProvenance(paths.episode_dir, current => {
    const pending = current.actions?.[actionId]?.active_check
    if (!pending) throw new Error('The active-audio quality check changed while its result was being saved.')
    pending.state = outcomes.every(result => result.accepted) ? 'no_issue_detected' : 'review_needed'
  })
  job.result = {
    ...job.result,
    quality_check: { action_id: actionId, state: outcomes.every(result => result.accepted) ? 'no_issue_detected' : 'review_needed', sections: outcomes },
  }
  job.output_lines.push(`Active narration quality check completed for ${outcomes.length} chapter(s); active audio and subtitles were left unchanged.`)
}

export async function generateAudio(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateAudioRequest
  const generationActionId = freshGenerationActionId((req as GenerateAudioRequest & {
    generation_action?: unknown
  }).generation_action)
  const qualityCheck = req.quality_check
  if (qualityCheck) {
    await runActiveAudioQualityCheck(job, req, qualityCheck)
    return
  }
  const qualityRepair = req.quality_repair
  const qualityRepairActionId = qualityRepair && typeof qualityRepair.action_id === 'string'
    ? qualityRepair.action_id.trim() : ''
  if (qualityRepair && (!qualityRepairActionId || qualityRepairActionId !== generationActionId)) {
    throw new Error('The staged audio-quality candidate has no matching server-owned fresh action.')
  }

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
  if (!apiKey) throw new Error('No Gateway key configured. Add it in Settings → This Mac.')

  // `maximum_input_characters` belongs to the model, is read fresh on every
  // run, and is never remembered between runs. Without it Story Studio has no
  // legitimate request boundary and refuses rather than guessing one.
  const ttsModel = (await listGenStudioTtsModels(apiKey)).find(model => model.id === req.model)
  if (!ttsModel) {
    throw new Error(
      `The selected voice model "${req.model}" is not in your Gateway catalogue. `
      + 'Reopen the Audio Generator and choose a current model.',
    )
  }
  if (!ttsModel.generation_enabled) {
    throw new Error(`The Gateway has generation turned off for ${ttsModel.display_name}. Choose another voice model.`)
  }
  if (ttsModel.locked) {
    throw new Error(`${ttsModel.display_name} is locked for this Gateway account. Choose an unlocked voice model. No request or credit charge was made.`)
  }
  // The published boundary, and the budget Story Studio actually plans at:
  // that boundary less the shared safety margin. `resolveTtsRequestBudget` is
  // the ONE place that decides it, and the quote route calls the same function
  // on the same live catalogue row — so the parts priced are the parts sent.
  const genStudioMaxCharacters = ttsModel.maximum_input_characters
  // The product every request in this run buys. Read once here, beside the
  // boundary, because both have to survive the handover into `processTask`.
  const genStudioModelId = ttsModel.id
  const genStudioSupportsSpeed = ttsModel.supports_speed
  const genStudioMinimumSpeed = ttsModel.minimum_speed
  const genStudioMaximumSpeed = ttsModel.maximum_speed
  const genStudioSpeed = resolveGenStudioTtsSpeed(
    req.speed ?? 1,
    genStudioSupportsSpeed,
    genStudioMinimumSpeed,
    genStudioMaximumSpeed,
  )
  const genStudioProviderLabel = ttsModel.provider_name || 'this voice provider'
  const admission = await refreshGenStudioAdmission(apiKey)
  const requestBudget = resolveTtsRequestBudget(ttsModel)
  // The control values this run submits, resolved against THIS model's
  // published `controls[]`. A name the model does not publish is dropped and a
  // value outside its published range is clamped, so a preset or a saved
  // project cannot smuggle another model's setting into the request. Empty
  // when the model publishes no controls — then nothing is sent, and the
  // idempotency key is exactly what it was before controls existed.
  const requestControls = resolveTtsControlValues(ttsModel.controls, req.controls)
  // "Smaller files" for narration (Settings, per-project override): ask for AAC on the wire.
  // Transport only — the chapter is still written as Story's 96 kbps MP3 either way.
  const narrationOutputFormat = await resolveOutputFormat(project_slug, 'narration')
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
    + ' for a character count Gateway counts differently)',
  )

  const narrationPath = await findNarrationFile(project_slug, episode_id)
  job.output_lines.push(`Found narration: ${path.basename(narrationPath)}`)

  const episodeDir = episodeDirForNarration(narrationPath)
  const priorActiveModelRecord = await readAudioTtsModelRecord(episodeDir)
  const selectedModelRecord: AudioTtsModelRecord = {
    schema_version: 1,
    episode_code: episode_id.toUpperCase(),
    model_id: genStudioModelId,
    ...(ttsModel.display_name ? { model_display_name: ttsModel.display_name } : {}),
    ...(ttsModel.provider_name ? { provider_name: ttsModel.provider_name } : {}),
    published_maximum_input_characters: genStudioMaxCharacters,
    request_budget: requestBudget.effective,
    safety_margin: requestBudget.safety_margin,
    recorded_at: new Date().toISOString(),
  }

  const activeAudioDir = await resolveAudioDir(project_slug, narrationPath, episode_id)
  const qualityPaths = qualityRepairActionId
    ? await resolveEpisodePathsByCodeWithSidecar(project_slug, episode_id, 'audio_chapters.json')
    : null
  // Candidates never share the active audio folder. The path is derived from
  // the server-stamped action id rather than accepting a client filename.
  const audioDir = qualityPaths
    ? path.join(qualityPaths.episode_dir, '.audio-quality-candidates', qualityRepairActionId, 'audio')
    : activeAudioDir
  await fs.mkdir(audioDir, { recursive: true })
  // Read the per-folder task manifest once so we can attempt free recovery
  // (existing-task poll) before issuing fresh submits. Only GenAIPro records
  // task_ids today (ElevenLabs streams direct, fal-audio doesn't); other
  // entries fall through to fresh generation.
  const audioManifest: Manifest = await readManifest(audioDir).catch(
    () => ({ schema_version: 1 as const, tasks: {} }),
  )
  if (qualityRepairActionId && qualityPaths) {
    const held = (await readAudioQualityProvenance(qualityPaths.episode_dir)).actions?.[qualityRepairActionId]
    if (held?.state === 'needs_approval' && held.candidate?.candidate_files) {
      const expected = Object.values(held.candidate.candidate_files).flat()
      const missing = await Promise.all(expected.map(async file => {
        const stat = await fs.stat(path.join(audioDir, file)).catch(() => null)
        return stat?.isFile() && stat.size > 0 ? null : file
      }))
      const absent = missing.filter((file): file is string => !!file)
      if (absent.length) {
        throw new Error(`Held candidate bytes are missing (${absent.join(', ')}); TTS was not regenerated. Start a new quality check to create another candidate.`)
      }
    }
  }

  const allSections = await parseNarrationDocx(narrationPath)
  job.output_lines.push(`Sections: ${allSections.length} found`)
  for (const s of allSections) {
    job.output_lines.push(`  ${s.label} (${s.text.length.toLocaleString()} chars)`)
  }
  // X-01 — capture each section's durable script fingerprint HERE, while the
  // text is still exactly what the script file holds. Everything below
  // transforms this array in memory for the run (normalization cleans it). The
  // freshness check later recomputes the fingerprint from the script file, so
  // recording a transformed value would report "the script changed" the moment
  // a customer changed nothing.
  const scriptFingerprints = new Map(
    allSections.map(section => [section.slug, chapterScriptFingerprint(section.text)]),
  )

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

      // Only skip on a non-empty existing file. A zero-byte leftover from a
      // prior failure must be regenerated, not treated as a cache hit.
      if (await fileExistsWithContent(chunkPath)) {
        if (req.no_overwrite) {
          let v = 2
          while (existsSync(chunkPath.replace('.mp3', `_v${v}.mp3`))) v++
          chunkPath = chunkPath.replace('.mp3', `_v${v}.mp3`)
        } else if (!req.force || !!qualityRepairActionId) {
          // A held quality candidate resumes verification from its retained
          // staged bytes. The fresh action still protects its own provider
          // identity; a higher verification allowance never regenerates TTS.
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

  // Both live publications are advisory local staging hints. GenStudio
  // admission remains authoritative; neither value is a remote gate.
  const concurrency = resolveGenStudioTtsFanout(
    tasks.length,
    ttsModel.provider_submit_concurrency,
    admission.burst_concurrency_ceiling,
  )

  if (tasks.length > 1) {
    job.output_lines.push(
      `Narrating ${tasks.length} part(s), ${concurrency === 1 ? 'one at a time' : `up to ${concurrency} at a time`}…`,
    )
  }

  // A record-less episode needs its exact split boundary before the first POST
  // so interrupted provider work remains reconstructable after queue history
  // ages out. An existing record is different: it describes still-active
  // audio and cannot move merely because a replacement was attempted. The
  // task manifest + genstudio_recovery checkpoint below persist that in-flight
  // request; the active record moves only with active-source promotion.
  if (!isCancelled() && !req.no_overwrite && !qualityRepairActionId && !priorActiveModelRecord) {
    await writeAudioTtsModelRecord(episodeDir, selectedModelRecord)
    job.output_lines.push(
      `Recorded voice model for recovery (audio_tts_model.json): ${genStudioModelId}`
      + ` · splitting at ${requestBudget.effective.toLocaleString()} characters`,
    )
  }

  // ── Live per-item progress ────────────────────────────────────────────────
  // A run this long has to be able to say what it is doing. `job.progress`
  // drives the bar; `job.item_progress` names the section in flight and, when
  // a provider has asked us to wait, says so explicitly — which is the only
  // thing that distinguishes deliberate pacing from a wedged job.
  let completedTasks = 0
  let failedTasks = 0
  /** Files actually written by this run; skipped legacy/base bytes never take over an active candidate. */
  const writtenChunkPaths = new Set<string>()
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
        speed: genStudioSpeed,
        supportsSpeed: genStudioSupportsSpeed,
        minimumSpeed: genStudioMinimumSpeed,
        maximumSpeed: genStudioMaximumSpeed,
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
        ...(narrationOutputFormat ? { outputFormat: narrationOutputFormat } : {}),
      })
      const idempotencyKey = recoveryEntry?.idempotency_key || prepared.idempotencyKey
      const submittedAt = recoveryEntry?.submitted_at || new Date().toISOString()

      if (announceRecoveryFromTerminal) {
        job.output_lines.push(
          `  The earlier request for ${chunkFilename} failed for good; sending a new one.`,
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
      const request = {
        text: task.chunkText,
        voiceId: effectiveVoice,
        // Same rebuild, same reason as `maxInputCharacters` below: the submit
        // path builds the wire body from THIS object, so the selected product
        // has to travel on it. Carried on the recovery object too — harmless
        // there, and it keeps one literal serving both paths.
        modelId: genStudioModelId,
        speed: genStudioSpeed,
        supportsSpeed: genStudioSupportsSpeed,
        minimumSpeed: genStudioMinimumSpeed,
        maximumSpeed: genStudioMaximumSpeed,
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
        ...(narrationOutputFormat ? { outputFormat: narrationOutputFormat } : {}),
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
          job.output_lines.push(`  ${task.sectionLabel} sent to the Gateway.`)
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
        job.output_lines.push(`  ${chunkFilename}: collecting the result of the earlier request (nothing new is made or charged; ref ${recoveryEntry.task_id.slice(0, 12)}).`)
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
      speed: genStudioSpeed,
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
    const relatedEvidence = reusableEntry
      ? (job.genstudio_jobs || []).filter(entry => {
          if (entry.operation !== 'voice.tts') return false
          const keys = [entry.request_key, entry.request?.idempotency_key]
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map(value => value.trim())
          const evidenceKey = new Set(keys).size === 1 ? keys[0] : undefined
          return entry.id === reusableEntry.task_id || evidenceKey === reusableEntry.idempotency_key
        })
      : []
    const exactEvidence = relatedEvidence.length === 1
      && relatedEvidence[0]!.id === reusableEntry?.task_id
      && [relatedEvidence[0]!.request_key, relatedEvidence[0]!.request?.idempotency_key]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .every(value => value.trim() === reusableEntry?.idempotency_key)
      && [relatedEvidence[0]!.request_key, relatedEvidence[0]!.request?.idempotency_key]
        .some(value => typeof value === 'string' && value.trim().length > 0)
    if (relatedEvidence.length && !exactEvidence) {
      throw new Error(`Saved Gateway task identity does not match ${chunkFilename}; no provider work was submitted.`)
    }
    const uncertainRecovery = exactEvidence
      && evidenceHoldsUnknownOutcome(relatedEvidence[0])
    const terminalFailure = isTerminalGenStudioTaskFailure(reusableEntry) && !uncertainRecovery
    // Every forced request starts with a fresh identity. A quality candidate
    // therefore cannot replay the old active-base TTS task on its first run.
    // Its exception is recovery only: once its own action-scoped request was
    // accepted and checkpointed, a restart must reclaim that exact task.
    const explicitRegeneration = req.force === true
    // Explicit Regenerate/New version work owns the current Story job's fresh
    // identity and must never adopt a successful task from an older run.
    // Ordinary retries retain unfinished accepted work; terminal provider
    // failures receive a separate manual-retry identity.
    let submissionIdentity = explicitRegeneration
      ? `${requestIdentity}:regenerate:${generationActionId || job.job_id}`
      : terminalFailure
      ? `${requestIdentity}:manual-retry:${job.job_id}`
      : requestIdentity
    // Only the first attempt may reclaim work a previous run left accepted.
    // Either format: the owner may have flipped "smaller files" since this request was made.
    const actionOwnedRecovery = !!qualityRepairActionId
      && [narrationOutputFormat, undefined].some(outputFormat => reusableEntry?.idempotency_key === buildGenStudioSubmission({
        text: task.chunkText, voiceId: effectiveVoice, modelId: genStudioModelId,
        speed: genStudioSpeed, supportsSpeed: genStudioSupportsSpeed,
        minimumSpeed: genStudioMinimumSpeed, maximumSpeed: genStudioMaximumSpeed,
        controls: requestControls, maxInputCharacters: genStudioMaxCharacters,
        requestIdentity: `${requestIdentity}:regenerate:${generationActionId || job.job_id}`,
        ...(outputFormat ? { outputFormat } : {}),
      }).idempotencyKey)
    let recoveryEntry = terminalFailure || (explicitRegeneration && !actionOwnedRecovery) ? null : reusableEntry

    activeTasks.set(chunkFilename, {
      label: task.sectionLabel,
      key: task.sectionSlug,
      state: 'running',
      attempt: 1,
      max_attempts: TTS_ROUTE_RETRY_MAX_ATTEMPTS,
    })
    publishProgress()
    let fleetBusyRetries = 0
    let maxAttempts = TTS_ROUTE_RETRY_MAX_ATTEMPTS
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
          writtenChunkPaths.add(task.outputPath)
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
          // A busy, offline or slow Mac waits on the shared fleet ladder (and, for free fleet work,
          // keeps waiting while the Gateway would) — it is never counted as a failed chapter.
          const fleetPlan = fleetBusyRetryPlan(e, 'tts', fleetBusyRetries)
          // Route/transport retries keep their own count, so a long wait for a Mac never uses them up.
          const routeAttempt = attempt - fleetBusyRetries
          const worthRetrying = !!fleetPlan
            || ((isGenStudioRouteExhausted(e) || transportFailure) && routeAttempt < TTS_ROUTE_RETRY_MAX_ATTEMPTS)
          if (!worthRetrying) {
            failedTasks++
            // Settled-pool semantics: one chunk failure doesn't kill the
            // batch. The queue stamps status='error' after the loop if
            // errors.length > 0.
            job.output_lines.push(`  Failed: ${e.message}`)
            errors.push(`${task.sectionLabel}: ${e.message}`)
            return
          }

          if (fleetPlan) fleetBusyRetries++
          const waitMs = fleetPlan ? fleetPlan.waitMs : ttsRouteRetryDelayMs(routeAttempt - 1)
          maxAttempts = fleetPlan ? fleetPlan.maxAttempts : TTS_ROUTE_RETRY_MAX_ATTEMPTS
          const reason = fleetPlan
            ? fleetPlan.reason
            : transportFailure
            ? `Could not reach ${genStudioProviderLabel}`
            : `No ${genStudioProviderLabel} route would accept this request`
          activeTasks.set(chunkFilename, {
            label: task.sectionLabel,
            key: task.sectionSlug,
            state: 'waiting_retry',
            attempt,
            max_attempts: maxAttempts,
            retry_at: new Date(Date.now() + waitMs).toISOString(),
            reason,
          })
          publishProgress()
          job.output_lines.push(fleetPlan?.free
            ? `  ${freeMacWaitLine(task.sectionLabel, e, waitMs)}`
            : `  ${task.sectionLabel}: ${reason.toLowerCase()} — nothing was charged.`
              + ` Retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1} of ${maxAttempts}).`,
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
            max_attempts: maxAttempts,
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
  if (!isCancelled() && !qualityRepairActionId) {
    const { getAudioStatus } = await import('../services/audio-reconciler.js')
    const status = await getAudioStatus(project_slug, episode_id, genStudioModelId)
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
  // Record enough durable, non-text provenance for a later opt-in quality
  // check. Versioned candidates deliberately do not replace this record: they
  // are not active audio until the quality promotion transaction says so.
  if (!isCancelled() && !req.no_overwrite && !qualityRepairActionId) {
    const manifest = await readManifest(audioDir)
    const updates: Array<{ slug: string; sourceFiles: string[]; sourceAudioHash: string; taskIds: Record<string, string>; idempotencyKeys: Record<string, string>; scriptHash: string }> = []
    for (const [index, section] of sections.entries()) {
      const parts = genStudioRequestPlan[index]!.parts
      const sourceFiles = parts.map((_, part) => parts.length > 1
        ? `${episode_id.toUpperCase()}_${section.slug}_part${part + 1}.mp3`
        : `${episode_id.toUpperCase()}_${section.slug}.mp3`)
      const sourceAudioHash = await hashSubtitleAudioSources(sourceFiles.map(file => path.join(audioDir, file)))
      if (!sourceAudioHash) continue
      const taskIds: Record<string, string> = {}
      const idempotencyKeys: Record<string, string> = {}
      for (const file of sourceFiles) {
        const task = manifest.tasks[file]
        if (task?.task_id) taskIds[file] = task.task_id
        if (task?.idempotency_key) idempotencyKeys[file] = task.idempotency_key
      }
      updates.push({
        slug: section.slug,
        sourceFiles,
        sourceAudioHash,
        taskIds,
        idempotencyKeys,
        // X-01 — the fingerprint of the script ON DISK, never the transformed
        // text this run generated from. See the capture above.
        scriptHash: scriptFingerprints.get(section.slug) ?? chapterScriptFingerprint(section.text),
      })
    }
    const recoveryAssets = job.params?.genstudio_recovery?.version === 1
      && job.params.genstudio_recovery.route === 'genstudio'
      ? job.params.genstudio_recovery.assets
      : {}
    const belongsToCompletedReplacement = (file: string): boolean => {
      if (writtenChunkPaths.has(path.join(audioDir, file))) return true
      const task = manifest.tasks[file]
      const recovery = recoveryAssets?.[file]
      return task?.provider === 'genstudio'
        && task.operation === 'tts'
        && task.last_state === 'succeeded'
        && !!task.task_id
        && !!task.idempotency_key
        && recovery?.operation === 'tts'
        && recovery.state === 'succeeded'
        && recovery.job_id === task.task_id
        && recovery.idempotency_key === task.idempotency_key
    }
    const replacementSources = Object.fromEntries(updates
      .filter(update => update.sourceFiles.every(belongsToCompletedReplacement))
      .map(update => [update.slug, update.sourceFiles]))
    const replacementCount = Object.keys(replacementSources).length
    if (replacementCount === 0 && writtenChunkPaths.size === 0) {
      // An ordinary non-force run over already-present audio is a no-op, not a
      // replacement. This includes genuine legacy/imported whole-chapter
      // files: do not demand task evidence for bytes this run never attempted
      // to activate, and do not rewrite their selection or committed model.
      job.output_lines.push('Existing audio was already present; active source selection was left unchanged.')
    } else {
      if (updates.length !== sections.length || replacementCount !== sections.length) {
        throw audioActivationError('not every requested section has complete durable replacement evidence')
      }

      const commitProvenance = () => updateAudioQualityProvenance(episodeDir, existing => {
        for (const update of updates) {
          existing.chapters[update.slug] = {
            normalized_script_hash: update.scriptHash,
            normalization: 'tts-v1',
            source_audio_hash: update.sourceAudioHash,
            source_files: update.sourceFiles,
            recorded_at: new Date().toISOString(),
            tts: {
              model_id: genStudioModelId,
              voice_id: req.voice,
              ...(ttsModel.provider_name ? { provider: ttsModel.provider_name } : {}),
              ...(Object.keys(update.taskIds).length ? { task_ids: update.taskIds } : {}),
              ...(Object.keys(update.idempotencyKeys).length ? { idempotency_keys: update.idempotencyKeys } : {}),
            },
          }
        }
      })

      let selectedSources: number | null
      try {
        selectedSources = await selectNormalAudioSources(
          episodeDir,
          audioDir,
          replacementSources,
          commitProvenance,
        )
      } catch (error: any) {
        throw audioActivationError(error?.message || String(error))
      }
      if (selectedSources !== null && selectedSources !== sections.length) {
        throw audioActivationError('the active selection did not accept every requested section')
      }
      await writeAudioTtsModelRecord(episodeDir, selectedModelRecord)
      job.output_lines.push(`Activated voice model boundary: ${genStudioModelId}`)
    }
  }
  if (!isCancelled() && qualityRepairActionId && qualityPaths) {
    const action = (await readAudioQualityProvenance(qualityPaths.episode_dir)).actions?.[qualityRepairActionId]
    const alternateModel = action?.verification_model_id || ''
    if (!action?.candidate || action.source_fingerprint !== qualityRepair?.source_fingerprint || !alternateModel) {
      throw new Error('The staged audio-quality repair checkpoint is missing or no longer matches this fresh action.')
    }
    const candidateTranscriptDir = path.join(qualityPaths.episode_dir, '.audio-quality-candidates', qualityRepairActionId, 'transcripts')
    const candidates: Array<{ slug: string; srt: string; modelId: string; sourceAudioHash: string; outputFile: string }> = []
    // Freeze the exact staged part map and bytes BEFORE any ASR request.  A
    // post-ASR hash alone would bless a candidate mutated while the provider
    // was listening. `promoteAudioQualityCandidate` rechecks this snapshot
    // again immediately before selecting active files.
    const candidateFiles = Object.fromEntries(sections.map((section, index) => {
      const parts = genStudioRequestPlan[index]!.parts
      return [section.slug, parts.map((_, part) => parts.length > 1
        ? `${code}_${section.slug}_part${part + 1}.mp3`
        : `${code}_${section.slug}.mp3`)]
    }))
    const candidateHashes: Record<string, string> = {}
    for (const [slug, files] of Object.entries(candidateFiles)) {
      const hash = await hashSubtitleAudioSources(files.map(file => path.join(audioDir, file)))
      if (!hash) throw new Error(`Candidate audio for ${slug} is missing before ASR; active audio was preserved.`)
      candidateHashes[slug] = hash
    }
    await updateAudioQualityProvenance(qualityPaths.episode_dir, current => {
      const pending = current.actions?.[qualityRepairActionId]
      if (!pending?.candidate || pending.source_fingerprint !== qualityRepair!.source_fingerprint) throw new Error('Candidate checkpoint changed before ASR.')
      pending.candidate.candidate_files = candidateFiles
      pending.candidate.candidate_audio_hashes = candidateHashes
    })
    try {
      for (const [index, section] of sections.entries()) {
        if (isCancelled()) break
        const files = genStudioRequestPlan[index]!.parts.map((_, part) => genStudioRequestPlan[index]!.parts.length > 1
          ? `${code}_${section.slug}_part${part + 1}.mp3`
          : `${code}_${section.slug}.mp3`)
        let candidateAudioPath = path.join(audioDir, files[0]!)
        let listPath: string | null = null
        let concatPath: string | null = null
        if (files.length > 1) {
          listPath = path.join(candidateTranscriptDir, `${section.slug}.concat.txt`)
          concatPath = path.join(candidateTranscriptDir, `${section.slug}.candidate.mp3`)
          await fs.mkdir(candidateTranscriptDir, { recursive: true })
          await fs.writeFile(listPath, files.map(file => formatConcatFileLine(path.join(audioDir, file))).join('\n') + '\n')
          await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', '192k', concatPath])
          candidateAudioPath = concatPath
        }
        const raw = await verifyAudioQualityCandidateRawTranscript({
          job, actionId: qualityRepairActionId, section: section.slug,
          candidateAudioPath, candidateOutDir: candidateTranscriptDir,
          apiKey, transcription: { modelId: alternateModel },
          verification_credit_ceiling: action.verification_credit_ceiling || qualityRepair!.verification_credit_ceiling,
          // model-drift-allow: local verification ledger begins at zero before a provider confirmation.
          verification_committed_credits: action.verification_committed_credits || 0,
          authorizeQuote: async quote => {
            const { inspectAudioQualityActionScope } = await import('../services/audio-quality.js')
            const liveScope = await inspectAudioQualityActionScope({
              episodeDir: qualityPaths.episode_dir, audioDir: qualityPaths.audio_dir,
              subtitlesDir: qualityPaths.subtitles_dir, scriptDir: path.dirname(narrationPath), episodeCode: code,
            }, action.sections)
            if (liveScope.source_fingerprint !== qualityRepair!.source_fingerprint) {
              throw new Error('The selected audio or script changed while candidate verification was pending.')
            }
            let remainingAllowance: number | null = null
            await updateAudioQualityProvenance(qualityPaths.episode_dir, current => {
              const pending = current.actions?.[qualityRepairActionId]
              if (!pending || pending.source_fingerprint !== qualityRepair!.source_fingerprint) {
                throw new Error('The active source changed while the candidate verification quote was pending.')
              }
              const ceiling = pending.verification_credit_ceiling
              // model-drift-allow: local verification ledger begins at zero before a provider confirmation.
              const spent = pending.verification_committed_credits || 0
              const cost = quote.quoted_credit_cost
              // Persist the real quote and held state before returning the
              // ceiling error. Throwing inside this updater would skip its
              // atomic write and strand a resumable candidate as Confirmed.
              pending.verification_quote = quote
              const validCeiling = typeof ceiling === 'number' && Number.isSafeInteger(ceiling)
              if (!validCeiling || typeof cost !== 'number' || !Number.isFinite(cost) || cost > ceiling - spent) {
                pending.state = 'needs_approval'
                remainingAllowance = Math.max(0, (validCeiling ? ceiling : 0) - spent)
                return
              }
              // Reservation is durable before the physical quote confirmation.
              // An interrupted response is uncertain provider ownership, so it
              // stays reserved until the recovered task gives an authority fact.
              pending.verification_committed_credits = spent + cost
            })
            if (remainingAllowance !== null) {
              throw new AudioQualityVerificationCreditCeilingError(quote, remainingAllowance)
            }
          },
        })
        const trust = correctChapterCues(raw.rawCues, section.text).trust
        if (!trust.accepted) {
          await updateAudioQualityProvenance(qualityPaths.episode_dir, current => {
            const pending = current.actions?.[qualityRepairActionId]
            if (pending) pending.state = 'still_needs_review'
          })
          job.result = { ...job.result, quality_repair: { action_id: qualityRepairActionId, state: 'still_needs_review', section: section.slug, reason: trust.reason } }
          job.output_lines.push(`Candidate ${section.slug} needs review: raw ASR does not support the intended script. Active audio was preserved.`)
          return
        }
        candidates.push({ slug: section.slug, srt: raw.srt, modelId: raw.modelId, sourceAudioHash: raw.audioHash, outputFile: raw.outputFile })
        if (listPath) await fs.unlink(listPath).catch(() => undefined)
        if (concatPath) await fs.unlink(concatPath).catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof AudioQualityVerificationCreditCeilingError) {
        // Keep the action resumable even when the helper rejects its local
        // ceiling before the shared-budget callback runs. The callback owns
        // reservation; this catch is only the durable held-state fallback.
        await updateAudioQualityProvenance(qualityPaths.episode_dir, current => {
          const pending = current.actions?.[qualityRepairActionId]
          if (pending && pending.source_fingerprint === qualityRepair!.source_fingerprint) {
            pending.state = 'needs_approval'
            pending.verification_quote = error.quote
          }
        })
        job.result = { ...job.result, quality_repair: { action_id: qualityRepairActionId, state: 'needs_approval', quote: error.quote } }
        job.output_lines.push(`Candidate verification is held for approval: ${error.message}`)
      }
      throw error
    }
    if (!isCancelled()) {
      const { inspectAudioQualityActionScope } = await import('../services/audio-quality.js')
      const finalScope = await inspectAudioQualityActionScope({
        episodeDir: qualityPaths.episode_dir, audioDir: qualityPaths.audio_dir,
        subtitlesDir: qualityPaths.subtitles_dir, scriptDir: path.dirname(narrationPath), episodeCode: code,
      }, action.sections)
      if (finalScope.source_fingerprint !== qualityRepair!.source_fingerprint) {
        throw new Error('The selected audio or script changed before candidate promotion; active audio was preserved.')
      }
      await updateAudioQualityProvenance(qualityPaths.episode_dir, current => {
        const pending = current.actions?.[qualityRepairActionId]
        if (!pending?.candidate || pending.source_fingerprint !== qualityRepair!.source_fingerprint) {
          throw new Error('The candidate checkpoint changed before promotion; active audio was preserved.')
        }
        pending.candidate.transcript_files = Object.fromEntries(candidates.map(candidate => [candidate.slug, candidate.outputFile]))
        pending.candidate.transcript_hashes = Object.fromEntries(candidates.map(candidate => [candidate.slug, hashInput(candidate.srt)]))
      })
      const storedAfterAsr = (await readAudioQualityProvenance(qualityPaths.episode_dir)).actions?.[qualityRepairActionId]
      if (!storedAfterAsr?.candidate?.candidate_files || !storedAfterAsr.candidate.candidate_audio_hashes) throw new Error('Candidate ASR snapshot was not saved.')
      const promoted = await promoteAudioQualityCandidate({
        episodeDir: qualityPaths.episode_dir, audioDir: qualityPaths.audio_dir, candidateAudioDir: audioDir,
        actionId: qualityRepairActionId, episodeCode: code, sections: candidates.map(candidate => candidate.slug),
        expectedSourceHashes: action.candidate.source_audio_hashes,
        expectedSourceFiles: action.source_files,
        expectedCandidateFiles: storedAfterAsr.candidate.candidate_files,
        expectedCandidateHashes: storedAfterAsr.candidate.candidate_audio_hashes,
      })
      // The map is now authoritative. Existing SRT and merged timeline inputs
      // are intentionally left in place but become stale through their saved
      // source hashes until the local Audio Assembly/subtitle refresh below.
      const existingRefresh = (await jq.getJobs(project_slug)).find(candidate =>
        candidate.type === 'audio_merge' && candidate.episode_id === episode_id
        && candidate.params?.audio_quality_refresh?.action_id === qualityRepairActionId,
      )
      const priorMerge = (await jq.getJobs(project_slug)).filter(candidate =>
        candidate.type === 'audio_merge' && candidate.episode_id === episode_id && candidate.status === 'done'
        && !candidate.params?.audio_quality_refresh,
      ).sort((left, right) => (right.finished_at || right.created_at).localeCompare(left.finished_at || left.created_at))[0]
      let refreshJob = existingRefresh
      if (!refreshJob && priorMerge) {
        refreshJob = await jq.enqueue({
          project_slug, episode_id, type: 'audio_merge',
          title: `Refresh audio-quality timeline (${candidates.map(candidate => candidate.slug).join(', ')})`,
          params: {
            ...priorMerge.params,
            episode_id,
            audio_quality_refresh: {
              action_id: qualityRepairActionId,
              source_fingerprint: qualityRepair!.source_fingerprint,
              sections: candidates.map(candidate => candidate.slug),
              promoted_files: promoted,
            },
          },
          dedupeParams: queued => queued?.audio_quality_refresh?.action_id === qualityRepairActionId,
        })
      }
      if (!priorMerge) {
        await updateAudioQualityProvenance(qualityPaths.episode_dir, current => {
          const pending = current.actions?.[qualityRepairActionId]
          if (pending) pending.refresh_needed = 'Run Audio Assembly with the prior mix settings before this candidate can be marked fixed.'
        })
      }
      // The candidate worker itself completed its bounded staged operation.
      // Keep the follow-up state nested: queue-level `complete: false` would
      // correctly turn this successfully persisted candidate into an error,
      // hiding the actionable local refresh job from Jobs and Audio.
      job.result = { ...job.result, quality_repair: {
        action_id: qualityRepairActionId, state: 'candidate_ready', promoted_sections: candidates.map(candidate => candidate.slug),
        active_files: promoted,
        ...(refreshJob ? { refresh_job_id: refreshJob.job_id } : {}),
        complete: false,
        ...(priorMerge ? {} : { refresh_needed: 'Run Audio Assembly with the prior mix settings before this candidate can be marked fixed.' }),
      } }
      job.output_lines.push(refreshJob
        ? `Verified candidate selected for ${candidates.length} chapter(s). Local Audio Assembly refresh queued as ${refreshJob.job_id}.`
        : `Verified candidate selected for ${candidates.length} chapter(s). Run Audio Assembly with the prior mix settings before this repair can be marked fixed.`)
    }
  }
  job.output_lines.push(qualityRepairActionId
    ? `Staged audio-quality candidate saved to: ${audioDir}`
    : `All audio saved to: ${audioDir}`)
  job.output_dir = audioDir
}
