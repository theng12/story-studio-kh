/**
 * Top up a channel's music library from one style brief (v1.4.37).
 *
 * WHAT THIS IS FOR. A music channel's economics only work if tracks are durable
 * assets. Measured 2026-08-23: one Suno request costs 100 credits ($0.06) and
 * returns TWO complete tracks of about three minutes. So ~10 requests buys an
 * hour of music, and a 200-song library is about $6 ONCE. After that a video
 * costs nothing to make. This generator is the only thing in the app that
 * spends money on music; building a video spends nothing, by design.
 *
 * A BRIEF, NOT A PROMPT. The owner describes the channel's sound once — "warm
 * lo-fi, rainy night, vinyl crackle, 80bpm" — and asks for N tracks. A planner
 * turns that into N DISTINCT prompts, because sending the same prompt N times
 * returns N near-identical tracks and an hour of those is unlistenable. The
 * planner writes the titles in the same call, so distinct human titles for the
 * tracklist cost nothing extra rather than needing a second paid step.
 *
 * BOTH TAKES ARE KEPT. Suno returns two songs per charge and both are the
 * owner's. They are saved as separate library tracks sharing a `sibling_group`,
 * because they came from one instruction and therefore sound like cousins —
 * played back to back a listener hears one song repeating. The mix builder
 * reads that group to keep them apart. Taking only the first would halve the
 * library for the same money and nothing would report it.
 */

import fs from 'fs/promises'
import path from 'path'
import { createHash, randomBytes } from 'crypto'

import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { withLock } from '../lib/atomic-store.js'
import { TRASH_DIRNAME, moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { musicWindowSizer, runRollingWindow } from '../lib/music-window.js'

import * as jq from '../services/job-queue.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { callAi } from '../lib/ai-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  GenStudioMusicTerminalFailureError,
  buildGenStudioMusicIdempotencyKey,
  generateMusicWithGenStudio,
  downloadGenStudioMusicTrack,
  isGenStudioPaymentRefusal,
  listMusicModels,
} from '../lib/genstudio-client.js'
import {
  fleetBusyRetryPlan,
  freeMacWaitLine,
  isFleetBusyFailure,
  isFreeMacPlan,
  waitUnlessStopped,
} from '../lib/genstudio-fleet-busy.js'
import {
  MUSIC_LIBRARY_DIRNAME,
  getLibraryDir,
  publishGeneratedTrack,
  siblingGroupForJob,
  upsertTrackMeta,
} from '../services/music-library.js'
import { measureTrackSeconds } from '../services/music-render.js'
import {
  musicDurationPlan,
  pickDefaultMusicModel,
  type MusicModelCapability,
  type MusicRequestNeeds,
} from '../contracts/music-model-choice.js'
import type { Job } from '../models/types.js'

/**
 * The modality every request in this generator belongs to.
 *
 * Read from `GenStudioMusicTerminalFailureError`, which builds its base with
 * `super('music', …)`. Named here rather than spelled inline so the test can
 * assert it against a LIVE error instance: a rename upstream must fail loudly
 * instead of silently turning the fleet-busy retry back off.
 */
export const MUSIC_GENSTUDIO_MODALITY = 'music'

/** Suno's own ceiling for a prompt with no lyrics. */
const MAX_BRIEF_PROMPT_CHARS = 500

export interface MusicGenerateParams {
  /** The channel's sound, in the owner's words. */
  brief: string
  /** How many TRACKS to add. Requests are ceil(count / outputs-per-request). */
  count: number
  /** GenStudio music model id. */
  model: string
  instrumental: boolean
  /** Track length in seconds for an instrumental model; default four minutes. A singing model's follows its lyrics. */
  duration_seconds?: number
  /**
   * Chat model that writes the N distinct prompts. Optional: with none, the
   * run degrades to N takes of the brief itself and SAYS SO, rather than
   * failing and costing the owner the whole top-up.
   */
  planner_model?: string
  /** Groups everything one top-up produced, for filtering the library later. */
  brief_id?: string
  /** Durable exact provider receipts for planned Library items. */
  music_library_items?: MusicLibraryItemsCheckpoint
  /** Server-copied source plan for one explicit unresolved-item replacement. */
  music_library_manual_item?: {
    version: 1
    source_job_id: string
    source_item_key: string
    plan: PlannedTrack
  }
}

/** One planned track: a distinct prompt and the title it will carry. */
export interface PlannedTrack {
  title: string
  prompt: string
  tags: string[]
  /** A lyric sheet with [Verse]/[Chorus] markers, written only for a model that sings from lyrics. */
  lyrics?: string
}

export interface MusicLibraryItemRequest {
  title: string
  prompt: string
  lyrics?: string
  instrumental: boolean
  duration_seconds?: number
  model_id: string
  output_format?: 'm4a'
}

export interface MusicLibraryItemReceipt {
  item_key: string
  index: number
  plan: PlannedTrack
  request: MusicLibraryItemRequest
  request_identity: string
  idempotency_key: string
  accepted_task_id?: string
  state?: string
}

export interface MusicLibraryItemsCheckpoint {
  version: 1
  items: MusicLibraryItemReceipt[]
}

export function readMusicLibraryItemsCheckpoint(
  job: Pick<Job, 'job_id' | 'project_slug' | 'params'>,
  value: unknown = job.params?.music_library_items,
  briefId = String(job.params?.brief_id || `brief-${job.job_id.slice(-10)}`),
): MusicLibraryItemsCheckpoint | null {
  if (value === undefined) return null
  const checkpoint = value as MusicLibraryItemsCheckpoint
  if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.items) || !checkpoint.items.length) {
    throw new Error('The saved Music Library item plan is invalid; it was not replaced with a new plan.')
  }
  for (const [index, item] of checkpoint.items.entries()) {
    const request = item?.request
    const planLyrics = item?.plan?.lyrics?.trim() || undefined
    const requestLyrics = request?.lyrics?.trim() || undefined
    const requestIdentity = `${job.project_slug}:music:${briefId}:${index}`
    const identityMatches = item?.request_identity === requestIdentity
      || new RegExp(`^${requestIdentity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[0-9a-f]{16}$`).test(item?.request_identity || '')
    const rebuiltKey = request && identityMatches
      ? buildGenStudioMusicIdempotencyKey({
          title: request.title,
          prompt: request.prompt,
          lyrics: requestLyrics,
          instrumental: request.instrumental,
          durationSeconds: request.duration_seconds,
          modelId: request.model_id,
          requestIdentity: item.request_identity,
          outputFormat: request.output_format,
        })
      : ''
    if (!item || item.index !== index || item.item_key !== `track-${index}`
      || !item.plan?.title?.trim() || !item.plan?.prompt?.trim()
      || !Array.isArray(item.plan.tags) || item.plan.tags.some(tag => typeof tag !== 'string')
      || !request?.title?.trim() || !request?.prompt?.trim()
      || !request?.model_id?.trim() || typeof request.instrumental !== 'boolean'
      || (request.duration_seconds !== undefined
        && (!Number.isInteger(request.duration_seconds) || request.duration_seconds <= 0))
      || (request.output_format !== undefined && request.output_format !== 'm4a')
      || request.title !== request.title.trim() || request.prompt !== request.prompt.trim()
      || request.model_id !== request.model_id.trim()
      || (request.lyrics !== undefined && request.lyrics !== requestLyrics)
      || !identityMatches || item.idempotency_key !== rebuiltKey
      || item.plan.title.trim() !== request.title.trim()
      || item.plan.prompt.trim() !== request.prompt.trim()
      || planLyrics !== requestLyrics
      || (item.accepted_task_id !== undefined
        && (typeof item.accepted_task_id !== 'string' || !item.accepted_task_id.trim()))) {
      throw new Error('The saved Music Library item plan is invalid; it was not replaced with a new plan.')
    }
  }
  return checkpoint
}

/**
 * The ONE failure this generator asks about a second time.
 *
 * GenStudio settles a job FAILED with `SITE_PLACEMENT_EXHAUSTED` when no fleet
 * machine was free, after a fifteen-minute placement window, and returns the
 * reservation whole — "the job never reached a worker, so there is nothing to
 * settle". Another attempt is therefore a fresh charge for work that never
 * happened, not a second charge for the same work. The argument extends to no
 * other code: a provider that WAS engaged may already have done and billed the
 * work. Retry nothing else.
 */
export function musicFleetBusyRetryPlan(
  e: unknown,
  attemptNum: number,
): { waitMs: number; reason: string; maxAttempts: number } | null {
  if (!isFleetBusyFailure(e, MUSIC_GENSTUDIO_MODALITY)) return null
  return fleetBusyRetryPlan(e, MUSIC_GENSTUDIO_MODALITY, attemptNum - 1)
}

const PLANNER_SYSTEM = 'You are a music director planning a set of instrumental background tracks for one '
  + 'long-form channel. Return strict JSON only: {"tracks":[{"title":"short evocative title",'
  + '"prompt":"a production brief for one track","tags":["mood","instrument"]}]}. '
  + 'Every prompt must describe the SAME channel sound with a genuinely different character — vary '
  + 'instrumentation, register, density and harmonic colour, never merely reword. Prompts are read by a '
  + 'music model, so name instruments, tempo and texture rather than emotions alone. Titles must be '
  + 'distinct from each other and must not repeat the brief verbatim.'

/** Planner brief for a model that SINGS (YuE2): every track also needs a lyric sheet. */
const PLANNER_SYSTEM_VOCAL = 'You are a music director planning a set of songs with vocals for one long-form '
  + 'channel. Return strict JSON only: {"tracks":[{"title":"short evocative title",'
  + '"prompt":"a style brief: genre, instruments, tempo, vocal character","tags":["mood","instrument"],'
  + '"lyrics":"[Verse]\\nline\\nline\\n[Chorus]\\nline\\nline"}]}. '
  + 'Every song must keep the SAME channel sound with a genuinely different character and different '
  + 'words. Lyrics are sung, so write short singable lines in [Verse], [Chorus], [Bridge] and [Outro] '
  + 'sections, 2 to 6 sections per song, 4 lines per section, no stage directions. Titles must be '
  + 'distinct and must not repeat the brief verbatim.'

/**
 * Turn one brief into N distinct prompts and titles.
 *
 * Falls back to the brief itself if the planner returns nothing usable, so a
 * top-up degrades to "N takes of one prompt" rather than failing outright and
 * costing the owner an entire run. It says so in the log when that happens —
 * silently buying twenty near-identical tracks is the outcome worth reporting.
 */
export async function planMusicTracks(
  job: Job,
  params: MusicGenerateParams,
  apiKeys: Record<string, string>,
  chatModel: string,
  options: { lyrics?: boolean } = {},
): Promise<PlannedTrack[]> {
  const wanted = Math.max(1, Math.floor(params.count))
  const withLyrics = options.lyrics === true
  const fallback = (): PlannedTrack[] => Array.from({ length: wanted }, (_, i) => ({
    title: `${params.brief.slice(0, 40).trim()} ${i + 1}`,
    prompt: params.brief.slice(0, MAX_BRIEF_PROMPT_CHARS),
    tags: [],
  }))
  if (!chatModel) {
    job.output_lines.push(
      'No planner model was chosen, so every track in this top-up uses the brief as written '
      + 'and they will sound similar. Pick a writing model to get distinct prompts.',
    )
    return fallback()
  }
  try {
    const raw = await callAi(
      chatModel,
      withLyrics ? PLANNER_SYSTEM_VOCAL : PLANNER_SYSTEM,
      `CHANNEL SOUND: ${params.brief}\n\nPlan exactly ${wanted} ${withLyrics ? 'songs' : 'tracks'}.`,
      apiKeys, false,
      { slug: job.project_slug, jobId: job.job_id, outputBudget: 'standard', temperature: 0.8 },
    )
    const parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''))
    const tracks: PlannedTrack[] = (Array.isArray(parsed?.tracks) ? parsed.tracks : [])
      .filter((t: any) => typeof t?.prompt === 'string' && t.prompt.trim())
      .map((t: any, i: number) => ({
        title: String(t.title || `${params.brief.slice(0, 40)} ${i + 1}`).trim().slice(0, 80),
        prompt: String(t.prompt).trim().slice(0, MAX_BRIEF_PROMPT_CHARS),
        tags: Array.isArray(t.tags) ? t.tags.map(String).slice(0, 8) : [],
        ...(withLyrics && typeof t.lyrics === 'string' && t.lyrics.trim() ? { lyrics: t.lyrics.trim().slice(0, 4000) } : {}),
      }))
    if (!tracks.length) {
      job.output_lines.push('The planner returned no usable prompts; falling back to the brief itself. '
        + 'Every track in this top-up will sound similar.')
      return fallback()
    }
    // Short is fine — the caller asks for what it got, never more.
    return tracks.slice(0, wanted)
  } catch (error) {
    job.output_lines.push(
      `Could not plan distinct prompts (${error instanceof Error ? error.message : String(error)}); `
      + 'falling back to the brief itself. Every track in this top-up will sound similar.',
    )
    return fallback()
  }
}

/** Filesystem-safe track filename that keeps the human title readable. */
export function musicTrackFilename(title: string, jobId: string, takeIndex: number, ext: 'm4a' | 'mp3' = 'm4a'): string {
  const stem = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${stem || 'track'}-${jobId.slice(-8)}-take${takeIndex}.${ext}`
}

const isWav = (b: Buffer) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE'
/** ISO-BMFF audio (`ftyp` brand M4A/M4B/mp42/isom), i.e. what `output_format: m4a` returns. */
export const isMp4Audio = (b: Buffer) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp'

const sha256Of = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Keep a refused/failed publication candidate in Story's Trash (never deleted); a failed move leaves the hidden file. */
function retainPublicationCandidate(dir: string, staging: string, filename: string, sha256: string): void {
  // `dir` is a project's music-library folder or a hidden folder inside it (the Song Pool's
  // `.incoming`); any other folder keeps its candidates in a `_trash` beside it.
  const library = path.basename(dir) === MUSIC_LIBRARY_DIRNAME ? dir : path.dirname(dir)
  const projectDir = path.dirname(library)
  const trash = path.basename(library) === MUSIC_LIBRARY_DIRNAME
    ? trashRootFor(projectDir, projectDir, path.basename(projectDir))
    : path.join(path.dirname(dir), TRASH_DIRNAME)
  try {
    moveToTrashSync(staging, path.join(trash, 'music-library-publication-candidates',
      `${filename}.${sha256.slice(0, 16)}.m4a`), 'music')
  } catch { /* the complete hidden staging file stays beside the library; nothing promotes or deletes it */ }
}

/**
 * The one writer for every direct-M4A destination (normal generation, the Song Pool's staging
 * folder, existing-task recovery). The complete body goes to a hidden same-directory staging file,
 * is synced, then published with `link`, which never replaces: a reader sees no final file or the
 * complete one. A final file with the same bytes is a harmless replay; different bytes are refused
 * (409), the final file is left untouched and the refused body is kept in Trash. The link — not a
 * caller's lock — is the cross-writer fence.
 */
async function publishM4aNoReplace(
  dir: string, filename: string, body: Buffer,
): Promise<{ sha256: string; size: number; disposition: 'created' | 'equal-replay' }> {
  const sha256 = sha256Of(body)
  const final = path.join(dir, filename)
  return withLock(`music-m4a-publish:${final}`, async () => {
    const staging = path.join(dir, `.${filename}.staging-${process.pid}-${randomBytes(4).toString('hex')}`)
    const handle = await fs.open(staging, 'wx')
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
    let disposition: 'created' | 'equal-replay' = 'created'
    try {
      await fs.link(staging, final)
      const folder = await fs.open(dir, 'r')
      try { await folder.sync() } finally { await folder.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        retainPublicationCandidate(dir, staging, filename, sha256)
        throw error
      }
      const existing = await fs.readFile(final)
      if (existing.length !== body.length || sha256Of(existing) !== sha256) {
        retainPublicationCandidate(dir, staging, filename, sha256)
        throw Object.assign(new Error(`${filename} already holds different audio; it was kept and not replaced.`), { statusCode: 409 })
      }
      disposition = 'equal-replay'
    }
    // The exact bytes now live under the final name (this link, or an identical file already
    // there), so dropping the staging name loses nothing. Only a refused or failed publication
    // keeps its candidate, in Trash, because then it may be the only copy.
    await fs.unlink(staging).catch(() => { /* a leftover hidden staging name is harmless and never promoted */ })
    return { sha256, size: body.length, disposition }
  })
}

/**
 * Store one paid track. An MP4/M4A body (the Hub already encoded AAC because we asked
 * for `output_format: m4a`) is stored as `.m4a` byte for byte — no second lossy
 * generation. A WAV body (Hub Stable Audio 3 sends ~43 MB of PCM per
 * track) is encoded to AAC (.m4a, native `aac` — `aac_at` measured +0.125 s
 * drift on concat); any other body (an MP3) is stored as delivered. The track
 * is already paid for, so an encode failure keeps the raw bytes under the old
 * `.mp3` name and warns rather than failing the save.
 */
export async function saveMusicTrack(
  dir: string, title: string, jobId: string, takeIndex: number, body: Buffer,
): Promise<{ filename: string; warning?: string; sha256?: string; size?: number; disposition?: 'created' | 'equal-replay' }> {
  const rawName = musicTrackFilename(title, jobId, takeIndex, 'mp3')
  if (isMp4Audio(body)) {
    const filename = musicTrackFilename(title, jobId, takeIndex)
    return { filename, ...(await publishM4aNoReplace(dir, filename, body)) }
  }
  if (!isWav(body)) {
    await fs.writeFile(path.join(dir, rawName), body)
    return { filename: rawName }
  }
  const filename = musicTrackFilename(title, jobId, takeIndex)
  const wav = path.join(dir, `.${filename}.partial-${process.pid}.wav`)
  const out = path.join(dir, `.${filename}.partial-${process.pid}`)
  try {
    await fs.writeFile(wav, body)
    await runFfmpeg(['-y', '-i', wav, '-vn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '256k',
      '-movflags', '+faststart', '-f', 'ipod', out])
    await fs.rename(out, path.join(dir, filename))
    return { filename }
  } catch (error) {
    await fs.rename(wav, path.join(dir, rawName)) // keep the paid bytes
    return { filename: rawName, warning: `could not compress to AAC (${error instanceof Error ? error.message : String(error)}); kept the original WAV` }
  } finally {
    await fs.rm(wav, { force: true }).catch(() => {})
    await fs.rm(out, { force: true }).catch(() => {})
  }
}

/**
 * Which music model a job will be charged for — resolved against the live catalogue, never
 * remembered, and **never substituted**.
 *
 * This was one expression, `models.find(m => m.id === params.model) || models[0]`, under a comment
 * reading *"a retired product must fail here, before anything is charged."* It did not fail. The
 * `||` collapsed two genuinely different requests into one answer, and the expensive half was the
 * named one: a job carrying a **retired** id was silently swapped for whichever music model the
 * account lists first — a different product, at a different price, charged to a customer who chose
 * neither. The comment described the intent and the next line broke it.
 *
 * A job naming **no** id is the other case, and it is deliberate rather than an oversight. The
 * Music page sends none and prices `models[0]` on screen *beside that model's own name*
 * (`frontend/pages/projects/[slug]/music.vue`), so the fallback is the model the customer was shown
 * a price for, never an unnamed one. **Do not "fix" it into a refusal** — the page's figure would
 * then describe a model nothing will use. It is a named, priced, displayed choice; the defect was
 * only ever the silent swap.
 *
 * A pure function so the rule is testable by calling it: the previous shape could only be pinned by
 * reading the source, and a source-level assertion cannot tell a live rule from a comment.
 */
export function resolveMusicModel<T extends { id: string } & MusicModelCapability>(
  models: readonly T[], requested: string | undefined | null,
  needs: MusicRequestNeeds = { instrumental: true, hasLyrics: false },
): T {
  const wanted = (requested || '').trim()
  if (wanted) {
    const named = models.find(m => m.id === wanted)
    if (!named) {
      throw new Error(
        `The music model "${wanted}" is no longer offered for this account, so nothing was charged. `
        + 'Pick a current model and start the job again.',
      )
    }
    return named
  }
  if (!models.length) throw new Error('The Gateway publishes no music model for this account.')
  // "The first published row" is only the right default when that row can make what is being
  // asked for. A vocal-only model (YuE2: lyrics required, no instrumental switch) listed first
  // would make every lyric-less top-up a certain refusal — see `contracts/music-model-choice.ts`,
  // which the Music page uses too, so the model priced on screen is the one charged.
  const usable = pickDefaultMusicModel(models, needs)
  if (!usable) {
    throw new Error(
      'None of the music models the Gateway publishes can make this track: each one needs lyrics, '
      + 'and this request has none. Nothing was charged. Pick a model or add lyrics.',
    )
  }
  return usable
}

export async function generateMusicLibraryTracks(job: Job): Promise<void> {
  const params = job.params as unknown as MusicGenerateParams
  const brief = (params.brief || '').trim()
  if (!brief) throw new Error('A style brief is required.')
  const wanted = Math.max(1, Math.floor(params.count || 1))
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add your Gateway API Key in Settings first.')
  const dir = await getLibraryDir(job.project_slug)
  if (!dir) throw new Error(`Project ${job.project_slug} has no folder on disk.`)

  // Resolve the model against the live catalogue rather than trusting a saved id.
  const models = await listMusicModels(apiKey)
  const instrumental = params.instrumental !== false
  // A top-up that asks for vocals supplies its own lyrics (the planner writes them), so a model that
  // requires lyrics is a fair choice for it — and is the one a vocal request should prefer.
  const model = resolveMusicModel(models, params.model, { instrumental, hasLyrics: !instrumental })
  const sings = model.requires_lyrics === true

  const apiKeys = { genstudio: apiKey }
  const briefId = params.brief_id || `brief-${job.job_id.slice(-10)}`
  const savedCheckpoint = readMusicLibraryItemsCheckpoint(job, params.music_library_items, briefId)
  const planned = savedCheckpoint
    ? savedCheckpoint.items.map(item => structuredClone(item.plan))
    : params.music_library_manual_item?.version === 1
      ? [structuredClone(params.music_library_manual_item.plan)]
      : await planMusicTracks(
          job, { ...params, brief, count: wanted }, apiKeys, (params.planner_model || '').trim(),
          { lyrics: sings },
        )
  // "Smaller files" for music (Settings, per-project override). On = ask for AAC at the source;
  // off = field omitted = WAV, which saveMusicTrack still encodes to AAC itself. A saved item keeps
  // the output choice it checkpointed before its first POST.
  const outputFormat = savedCheckpoint ? undefined : await resolveOutputFormat(job.project_slug, 'music')
  const checkpoint: MusicLibraryItemsCheckpoint = savedCheckpoint || {
    version: 1,
    items: planned.map((plan, index): MusicLibraryItemReceipt => {
      const lengthApplies = sings || typeof model.max_duration_seconds === 'number'
      const length = lengthApplies
        ? musicDurationPlan(model, { lyrics: plan.lyrics, requestedSeconds: params.duration_seconds })
        : undefined
      const requestIdentity = `${job.project_slug}:music:${briefId}:${index}`
      const normalizedRequest: MusicLibraryItemRequest = {
        title: plan.title.trim(),
        prompt: plan.prompt.trim(),
        ...(plan.lyrics?.trim() ? { lyrics: plan.lyrics.trim() } : {}),
        instrumental,
        ...(length ? { duration_seconds: length.seconds } : {}),
        model_id: model.id,
        ...(outputFormat ? { output_format: outputFormat } : {}),
      }
      return {
        item_key: `track-${index}`,
        index,
        plan: structuredClone(plan),
        request: normalizedRequest,
        request_identity: requestIdentity,
        idempotency_key: buildGenStudioMusicIdempotencyKey({
          title: normalizedRequest.title,
          prompt: normalizedRequest.prompt,
          lyrics: normalizedRequest.lyrics,
          instrumental: normalizedRequest.instrumental,
          durationSeconds: normalizedRequest.duration_seconds,
          modelId: normalizedRequest.model_id,
          requestIdentity,
          outputFormat: normalizedRequest.output_format,
        }),
      }
    }),
  }
  if (checkpoint.items.length !== planned.length
    || checkpoint.items.some(item => item.request.model_id !== model.id
      || item.request.instrumental !== instrumental)) {
    throw new Error('The saved Music Library item plan no longer matches this job model and mode.')
  }
  params.music_library_items = checkpoint
  await jq.checkpointJobState(job)
  // 1.4.270 — a rolling window sized to the fleet (lib/music-window.ts) instead of one request at a
  // time. Saved files and failures are reported in plan order.
  job.item_progress = { total: planned.length, completed: 0, failed: 0, concurrency: 1, active: [] }
  job.output_lines.push(
    `Adding ${planned.length} track request(s) to the library. `
    + 'Each request returns every variation the model produces, and all of them are kept.',
  )
  const sizer = await musicWindowSizer(apiKey, model.id, line => job.output_lines.push(line))
  const priority = sizer.priority
  const windowNow = async (inFlight: number): Promise<number> => {
    const size = Math.min(planned.length, await sizer.size(inFlight))
    job.item_progress!.concurrency = size
    return size
  }

  const savedByIndex: string[][] = planned.map(() => [])
  const failuresByIndex: (string | undefined)[] = planned.map(() => undefined)
  // A cancel, a pause or running out of credits stops every request: none of the others start, the
  // ones in flight stop at their next check, and the run waits for them before it ends.
  let stop: unknown = null
  const runOne = async (plan: (typeof planned)[number], index: number): Promise<void> => {
    const item = checkpoint.items[index]!
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    jq.throwIfPauseRequested(job.job_id)
    let attemptNum = 1
    if (sings && !plan.lyrics) {
      // A singing model refuses a request without lyrics. Say what to do instead of paying the Hub
      // to refuse it.
      const reason = `${model.display_name} sings from lyrics and none were written for this song. `
        + 'Pick a writing model so the planner can write them.'
      failuresByIndex[index] = `${plan.title}: ${reason}`
      job.output_lines.push(`✗ ${plan.title} skipped: ${reason}`)
      return
    }
    for (;;) {
      if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
      try {
        const result = await generateMusicWithGenStudio(apiKey, {
          title: item.request.title,
          prompt: item.request.prompt,
          instrumental: item.request.instrumental,
          ...(item.request.lyrics ? { lyrics: item.request.lyrics } : {}),
          ...(item.request.duration_seconds ? { durationSeconds: item.request.duration_seconds } : {}),
          modelId: item.request.model_id,
          ...(item.request.output_format ? { outputFormat: item.request.output_format } : {}),
          ...(priority ? { priority } : {}),
          requestIdentity: item.request_identity,
          idempotencyKey: item.idempotency_key,
          isCancelled: () => jq.isCancelled(job.job_id),
          onJobAccepted: async (taskId, idempotencyKey) => {
            if (idempotencyKey !== item.idempotency_key) {
              throw new Error(`Music item ${item.item_key} was accepted under an unexpected request key.`)
            }
            item.accepted_task_id = taskId
            item.state = 'accepted'
            await jq.checkpointJobState(job)
          },
          onState: async (state, taskId) => {
            if (item.accepted_task_id && item.accepted_task_id !== taskId) {
              throw new Error(`Music item ${item.item_key} changed provider task identity.`)
            }
            item.accepted_task_id ||= taskId
            item.state = state
            await jq.checkpointJobState(job)
          },
        })
        // EVERY track, not result.tracks[0]. Both are paid for.
        const group = siblingGroupForJob(result.jobId)
        for (const [take, track] of result.tracks.entries()) {
          const body = await downloadGenStudioMusicTrack(track.url, result.downloadHeaders, {
            isCancelled: () => jq.isCancelled(job.job_id),
          }, take + 1)
          const title = result.tracks.length > 1 ? `${plan.title} — take ${take + 1}` : plan.title
          let filename: string
          if (isMp4Audio(body)) {
            // Direct M4A: published and bound in one Song Pool transaction, so an owner edit or
            // removal made while this downloaded is never undone (see publishGeneratedTrack).
            filename = musicTrackFilename(plan.title, result.jobId, take + 1)
            await publishGeneratedTrack(job.project_slug, {
              filename,
              origin: {
                gateway_job_id: result.jobId,
                brief_id: briefId,
                sibling_group: result.tracks.length > 1 ? group : undefined,
                sibling_index: take + 1,
              },
              title,
              tags: plan.tags,
              claimReplay: true,
              publish: () => saveMusicTrack(dir, plan.title, result.jobId, take + 1, body),
            })
          } else {
            const saved = await saveMusicTrack(dir, plan.title, result.jobId, take + 1, body)
            filename = saved.filename
            if (saved.warning) job.output_lines.push(`⚠ ${filename}: ${saved.warning}`)
          }
          const trackPath = path.join(dir, filename)
          // MEASURED HERE, at save time, and this is not optional.
          //
          // The mix builder treats a track with no measured duration as
          // unusable — it cannot fill a runtime with a length it does not know.
          // Without this line a freshly generated library builds an EMPTY mix
          // and reports itself short, with every track sitting right there on
          // disk. Nothing errors; it simply produces nothing. Found by writing
          // the render layer, not by a test, because the two halves only meet
          // here.
          const durationSec = await measureTrackSeconds(trackPath)
          if (durationSec === undefined) {
            job.output_lines.push(
              `⚠ ${filename} saved but could not be measured, so a mix will skip it. `
              + 'Re-adding the track usually fixes this.',
            )
          }
          // A direct M4A row was already bound (with its duration) inside the pool transaction.
          if (!isMp4Audio(body)) {
            await upsertTrackMeta(job.project_slug, filename, {
              ...(durationSec !== undefined ? { duration_sec: durationSec } : {}),
              title,
              enabled: true,
              sibling_group: result.tracks.length > 1 ? group : undefined,
              sibling_index: take + 1,
              brief_id: briefId,
              tags: plan.tags,
              genstudio_job_id: result.jobId,
              added_at: new Date().toISOString(),
            })
          }
          savedByIndex[index]!.push(filename)
        }
        job.output_lines.push(
          `✓ ${plan.title} — ${result.tracks.length} track(s) saved`
          + (result.tracks.length > 1 ? ' (both variations kept)' : ''),
        )
        break
      } catch (error) {
        // Out of credits stops the whole run: every later request would fail
        // identically and charge nothing but time.
        if (isGenStudioPaymentRefusal(error)) throw error
        // A cancel is the owner stopping the job, not this track failing: stop at once instead of
        // logging a failure and "continuing with the rest".
        if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
        const plan2 = musicFleetBusyRetryPlan(error, attemptNum)
        const deadJobId = error instanceof GenStudioMusicTerminalFailureError ? error.jobId : ''
        if (plan2 && deadJobId && !jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
          // A settled-failed job can never be reopened, so the next attempt
          // needs a new identity — derived from the dead job id, never a clock.
          const retryScope = siblingGroupForJob(deadJobId)
          item.request_identity = `${job.project_slug}:music:${briefId}:${index}:${retryScope}`
          item.idempotency_key = buildGenStudioMusicIdempotencyKey({
            title: item.request.title,
            prompt: item.request.prompt,
            lyrics: item.request.lyrics,
            instrumental: item.request.instrumental,
            durationSeconds: item.request.duration_seconds,
            modelId: item.request.model_id,
            requestIdentity: item.request_identity,
            outputFormat: item.request.output_format,
          })
          delete item.accepted_task_id
          item.state = 'prepared'
          await jq.checkpointJobState(job)
          job.output_lines.push(isFreeMacPlan(plan2) ? freeMacWaitLine(plan.title, error, plan2.waitMs) :
            `${plan.title}: ${plan2.reason.toLowerCase()} — nothing was charged and the credits came back whole. `
            + `Waiting ${Math.round(plan2.waitMs / 1000)}s and asking again `
            + `(attempt ${attemptNum + 1} of ${plan2.maxAttempts}).`,
          )
          await waitUnlessStopped(
            plan2.waitMs,
            () => jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id),
          )
          if (!jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {
            attemptNum++
            continue
          }
        }
        const reason = error instanceof Error ? error.message : String(error)
        failuresByIndex[index] = `${plan.title}: ${reason}`
        job.output_lines.push(`✗ ${plan.title} failed: ${reason}. Continuing with the rest.`)
        break
      }
    }
  }
  await runRollingWindow(planned, windowNow, async (plan, index) => {
    if (stop) return
    const attempt = { label: plan.title, key: `track-${index}`, state: 'running' as const, attempt: 1, max_attempts: 1 }
    job.item_progress!.active.push(attempt)
    try {
      await runOne(plan, index)
    } catch (error) {
      stop ??= error
      return
    } finally {
      job.item_progress!.active = job.item_progress!.active.filter(a => a !== attempt)
    }
    if (failuresByIndex[index]) job.item_progress!.failed++
    else job.item_progress!.completed++
    job.progress = Math.round(((job.item_progress!.completed + job.item_progress!.failed) / planned.length) * 100)
  }, () => !!stop)
  if (stop) throw stop
  const saved = savedByIndex.flat()
  const failures = failuresByIndex.filter((f): f is string => !!f)

  job.result = { saved_tracks: saved, brief_id: briefId, requests: planned.length }
  requireJobCompletion(job, {
    label: 'Music library top-up',
    expected: planned.length,
    completed: planned.length - failures.length,
    missing: failures,
    retry_hint: 'Tracks already saved are kept; Retry asks only for the ones that failed.',
  })
}
