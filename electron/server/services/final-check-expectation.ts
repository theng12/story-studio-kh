/**
 * A plan-less final's expectation, frozen onto the file it belongs to.
 *
 * A final rendered before the 1.4.327 plan sidecar records no plan of its own, so its expected
 * length and its own intro have to come from somewhere — and the only other source is the channel's
 * Video Assembly settings, which are a moving target. Owner decision, 2026-10-20: every already-made
 * Sprout final keeps its long silent still tail and its branded intro, while FUTURE episodes drop
 * that 6000 s `after_scenes` clip. Read the settings after that change and SS0063's 9354 s final is
 * measured against a ~15 s tail and STOPPED — a file the owner said to keep.
 *
 * So the shape is taken ONCE, from the settings as they were, and written beside the final
 * (`frozenExpectationPath`). Every later check reads that record and never the live preset. The sweep
 * below takes it for every plan-less final already on disk, at boot, so it happens before the preset
 * changes.
 *
 * What is NOT frozen: the episode's own chapters (`audio_chapters.json`) and its own Scene Plan
 * speech end. Those are per-episode artifacts of the episode the final belongs to, not project
 * settings that a future episode's change can move, and a check reads them fresh — the same way it
 * does for a final that carries a plan.
 */

import { createHash } from 'node:crypto'
import fs from 'fs/promises'
import path from 'path'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import {
  freezeShape, freshStoredExpectation, isIntroAssetBlack, measureIntroAssetBlack, measureOpeningBlack,
  plannedSecFromSectionGaps, readFrozenShape, readPlannedSectionGaps, readStoredFinalCheck,
  unplannedDurationIssue,
  type FinalCheckExpectation, type FrozenFinalCheckShape, type OwnerFreezeDecision,
} from '../lib/final-video-check.js'
import {
  resolveEpisodeRenderShape, resolveIntroSlot, resolveTimelineSlot, shapeFromVideoAssemblySettings,
} from './opening-assets.js'
import { createProjectFactsCache, resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { findYouTubeSourceVideoPath } from './youtube-source-video.js'
import { getProjectDir, getProjectOutputRoot, listProjects } from './project-manager.js'
import { logLine } from './logger.js'

/** What a plan-less final's expectation is, or why it cannot be established. */
export type PlanlessExpectation =
  | { kind: 'frozen'; shape: FrozenFinalCheckShape }
  | { kind: 'unknown'; reason: string }

/** The words the check reports when the shape cannot be established. */
export const SETTINGS_CHANGED_REASON =
  "the channel's Video Assembly settings changed after this video was rendered, and no expectation was frozen for it before they did"

export interface PlanlessFinalRef {
  slug: string
  episode_code: string
  episode_dir: string
  video_path: string
  /** The final's mtime (ms) — when it was written, for the settings-changed test. */
  mtime_ms: number
}

/**
 * The owner's own decision, recorded so a freeze taken on it can say whose authority it rests on.
 *
 * Two things were decided, on two turns. First the retention: *"i want all already made videos to
 * retain this"* (turn `662f2e99`, 2026-10-20T13:17:16.768Z) — the already-made finals stay as they
 * are rather than being re-measured against a preset that was about to change. Then, asked how to
 * get their expectation written down when nothing on disk proves which settings made them, the owner
 * approved taking it from today's settings: *"yes. this is the right approach and i approve of it.
 * ship asap"*, of *"each finished video gets its expected length and intro saved on the video's own
 * record, taken from today's settings"*.
 *
 * A freeze taken on this is `source: 'owner'` and carries these words, so it is never mistaken for
 * the app having proved which settings produced the file. It is scoped — one channel, and only
 * finals rendered before the decision — and it is confirmed against the file before it is written:
 * see `ownerAttestedShape`.
 */
export const OWNER_FREEZE_DECISION = {
  decision_at: '2026-10-20T13:17:16.768Z',
  turn_id: '662f2e99',
  described_as: "each finished video gets its expected length and intro saved on the video's own record, taken from today's settings",
  approve_quote: 'yes. this is the right approach and i approve of it. ship asap',
  retain_quote: 'i want all already made videos to retain this',
} as const

/**
 * The channels the owner's decision names — and only those.
 *
 * The decision is about Story Sprout's already-made finals, not about every channel's: a freeze
 * taken on "today's settings" for a channel the owner did not decide about would be exactly the
 * fallback this record exists to prevent.
 */
export const OWNER_DECISION_SLUGS: readonly string[] = ['story-sprout']

/** The words reported when the owner's decision reaches a final and the file does not confirm it. */
export const OWNER_ATTESTATION_REFUSED_REASON =
  "the owner's decision of 2026-10-20 allows this final's expectation to be taken from the channel's "
  + "settings, but the file does not confirm it"

/**
 * The frozen expectation for a plan-less final, taken now if it is still safe to take.
 *
 * Order, strongest evidence first:
 *
 *  1. the freeze already beside the file;
 *  2. **the final's own render request**, when it is still saved — the settings the render was
 *     actually asked for, which needs no guess about what has moved since (2026-10-20);
 *  3. the channel's settings, but ONLY when they can be shown not to have been written since the
 *     final was;
 *  4. the owner's own recorded decision, in the channels and for the finals it names, and only when
 *     the file itself confirms the shape (length and opening black) — `ownerAttestation`;
 *  5. else `unknown`.
 *
 * It never falls back to "the settings, whatever they say": step 4 is an authority that has been
 * recorded in the owner's words and confirmed against the bytes, and it is taken only by the boot
 * sweep, so it happens once and before any preset can move. `freeze: false` answers the same
 * question without writing anything, for a read-only caller.
 */
export async function planlessExpectationFor(
  input: PlanlessFinalRef,
  opts: { freeze?: boolean; ownerAttestation?: boolean } = {},
): Promise<PlanlessExpectation> {
  const write = opts.freeze !== false
  const frozen = await readFrozenShape(input.video_path)
  if (frozen && !frozen.stale) return { kind: 'frozen', shape: frozen.shape }

  const fromRequest = await expectationFromRenderRequest(input).catch(() => null)
  if (fromRequest) {
    if (write) await freezeShape(input.video_path, fromRequest)
    return { kind: 'frozen', shape: fromRequest }
  }

  if (opts.ownerAttestation) {
    const attested = await ownerAttestedShape(input).catch(() => null)
    if (attested?.kind === 'frozen') {
      if (write) await freezeShape(input.video_path, attested.shape)
      return attested
    }
    if (attested?.kind === 'unknown' && attested.reason !== SETTINGS_CHANGED_REASON) return attested
  }

  if (!(await settingsUnchangedSince(input.slug, input.mtime_ms))) {
    return { kind: 'unknown', reason: SETTINGS_CHANGED_REASON }
  }
  const shape = await deriveShapeFromSettings(input)
  if (write) await freezeShape(input.video_path, shape)
  return { kind: 'frozen', shape }
}

/**
 * The frozen shape taken from the FINAL'S OWN RENDER REQUEST, or null when it is not still saved.
 *
 * A `video_assembly` job carries the settings that render was given (`routes/pipeline.ts` flattens
 * the Video Assembly bundle into its `params`: `intro`, `timeline_clips`, `post_audio`), so the
 * shape can be measured from the REQUEST rather than from the channel's settings as they are today.
 * That is the strongest evidence there is about what a file was made to be: it is not an inference
 * from a timestamp, it is the instruction the render ran on.
 *
 * It is not always available — the durable job store keeps the newest 750 finished jobs per project
 * (`services/job-queue.ts`'s `MAX_PERSISTED_TERMINAL_HISTORY`), so a channel that renders hundreds
 * of episodes forgets an old render's request long before its final stops mattering. When it is
 * gone the settings test below is what remains, and when that cannot be shown either the answer
 * stays `unknown`.
 *
 * Three tests, each of which is what stops a DIFFERENT render's request being read as this file's:
 * the request must have been MADE no later than the final (a request written after the file on disk
 * describes a later render); the render must have FINISHED no earlier than the final (a request that
 * finished before the file existed is an earlier render's, and the file has since been replaced);
 * and it must have finished at all — a queued or running request has not produced the file that is
 * there now, it is about to replace it. Anything less is a shape certified for the wrong video,
 * which is the defect this whole record exists to close.
 */
async function expectationFromRenderRequest(input: PlanlessFinalRef): Promise<FrozenFinalCheckShape | null> {
  const request = await renderRequestForEpisode(input.slug, input.episode_code, input.mtime_ms)
  if (!request) return null
  const stat = await fs.stat(input.video_path).catch(() => null)
  const settings = videoAssemblySettingsFromRenderRequest(request.params)
  const outputRoot = (await getProjectOutputRoot(input.slug).catch(() => '')) || ''
  const reserved = await scenePlanOpeningReservedSec(input.slug, input.episode_code, input.episode_dir)
  const rendered = await shapeFromVideoAssemblySettings(settings, outputRoot, getAudioDuration, {
    opening_reserved_sec: reserved,
  })
  return {
    schema_version: 1,
    frozen_at: new Date().toISOString(),
    episode_code: input.episode_code.toUpperCase(),
    file: stat ? { size: stat.size, mtime_ms: stat.mtimeMs } : { size: 0, mtime_ms: 0 },
    source: 'job',
    after_narration_sec: rendered.after_narration_sec,
    // Measured HERE, once, for this file: a later check must not re-measure an asset that may have
    // been replaced since the final was made.
    intro: rendered.intro
      ? { ...rendered.intro, black: await measureIntroAssetBlack(rendered.intro.asset) }
      : null,
    shaping_fingerprint: shapingFingerprint(settings),
    evidence: `this render's own saved request (job ${request.job_id}, ${request.created_at})`,
  }
}

/**
 * The owner's decision applied to one final — or why it does not reach it.
 *
 * In scope only when BOTH are true: the channel is one the decision names, and the final was
 * rendered BEFORE the decision. A final made after it is not an "already made video", and freezing
 * it on today's settings would bind a shape to a file the owner never decided about.
 *
 * In scope, the shape is taken from today's settings and then CONFIRMED AGAINST THE FILE twice,
 * because an attestation is only worth the agreement it is checked against:
 *
 *  - the file's own measured length is the length its episode adds up to — the episode's chapters
 *    plus everything its settings put after the narration, judged by the final check's own
 *    allowance (`unplannedDurationIssue`), so this and the check cannot disagree; and
 *  - any black in the file's opening is black the INTRO ASSET itself carries (`isIntroAssetBlack`)
 *    — the same rule the check uses to tell the owner's opening from a stretch the render invented.
 *
 * Either failure answers `unknown` with the reason, and nothing is written. A channel or a render
 * date outside the decision answers `unknown` with the ordinary settings reason, exactly as it would
 * have without this.
 */
async function ownerAttestedShape(input: PlanlessFinalRef): Promise<PlanlessExpectation> {
  if (!OWNER_DECISION_SLUGS.includes(input.slug)) return { kind: 'unknown', reason: SETTINGS_CHANGED_REASON }
  const decidedAt = Date.parse(OWNER_FREEZE_DECISION.decision_at)
  if (!Number.isFinite(decidedAt) || !(input.mtime_ms > 0) || input.mtime_ms >= decidedAt) {
    return { kind: 'unknown', reason: SETTINGS_CHANGED_REASON }
  }

  // The length is the episode's own chapters plus what its settings put after them. Without the
  // chapters there is no expectation to confirm, so there is nothing to attest either.
  const chaptersSec = plannedSecFromSectionGaps(await readPlannedSectionGaps(input.episode_dir))
  if (chaptersSec === null) {
    return {
      kind: 'unknown',
      reason: `${OWNER_ATTESTATION_REFUSED_REASON}: the episode's own chapters cannot say how long it should be`,
    }
  }

  const actualSec = await getAudioDuration(input.video_path).catch(() => undefined)
  if (!actualSec || !(actualSec > 0)) {
    return { kind: 'unknown', reason: `${OWNER_ATTESTATION_REFUSED_REASON}: its length could not be measured` }
  }

  const shape = await deriveShapeFromSettings(input)
  const expectedSec = chaptersSec + Math.max(0, Number(shape.after_narration_sec) || 0)
  const lengthIssue = unplannedDurationIssue(actualSec, expectedSec, 0)
  if (lengthIssue) {
    return { kind: 'unknown', reason: `${OWNER_ATTESTATION_REFUSED_REASON}: ${lengthIssue}` }
  }

  // The opening: the black the file shows must be the black the intro ASSET carries. A shape that
  // claims no intro asserts nothing about an opening, and the check reports head black on its own.
  const openingEndSec = Math.max(0, Number(shape.intro?.window?.end_sec) || 0)
  const openingBlack = await measureOpeningBlack(input.video_path, openingEndSec)
  const unclaimed = openingBlack.filter(run => !isIntroAssetBlack(run, shape.intro ?? undefined))
  if (unclaimed.length) {
    return {
      kind: 'unknown',
      reason: `${OWNER_ATTESTATION_REFUSED_REASON}: `
        + `${unclaimed.length} black stretch${unclaimed.length === 1 ? '' : 'es'} in its opening `
        + `(${unclaimed.map(run => `${run.start_sec.toFixed(1)}s–${run.end_sec.toFixed(1)}s`).join(', ')}) `
        + 'is not black the intro asset carries',
    }
  }

  return {
    kind: 'frozen',
    shape: {
      ...shape,
      source: 'owner',
      owner: { ...OWNER_FREEZE_DECISION },
      evidence: `today's settings, taken on the owner's decision of 2026-10-20 (turn ${OWNER_FREEZE_DECISION.turn_id}), `
        + 'confirmed against this file: its length matches its own chapters plus its settings, and its '
        + "opening black is the intro asset's own",
    },
  }
}

/** The episode's newest FINISHED `video_assembly` request that belongs to the final on disk. */
async function renderRequestForEpisode(
  slug: string,
  code: string,
  mtimeMs: number,
): Promise<{ job_id: string; created_at: string; params: Record<string, unknown> } | null> {
  if (!(mtimeMs > 0)) return null
  const { getJobs } = await import('./job-queue.js')
  const jobs = await getJobs(slug, { type: 'video_assembly' }).catch(() => [])
  const wanted = code.toUpperCase()
  const eligible = jobs
    .filter(job => String(job.episode_id || '').toUpperCase() === wanted)
    // A request that has not finished is about to REPLACE the file, not the one that made it.
    .filter(job => job.status === 'done' && !!job.finished_at)
    .map(job => ({ job, made: Date.parse(String(job.created_at || '')), done: Date.parse(String(job.finished_at)) }))
    // Made no later than the final, and finished no earlier than it: the render wrote the file, then
    // checked it, then ended. A request that finished before the file existed is an earlier render's.
    .filter(entry => Number.isFinite(entry.made) && entry.made <= mtimeMs)
    .filter(entry => Number.isFinite(entry.done) && entry.done >= mtimeMs)
    .sort((a, b) => b.made - a.made)
  const newest = eligible[0]
  if (!newest) return null
  return {
    job_id: String(newest.job.job_id),
    created_at: String(newest.job.created_at),
    params: (newest.job.params || {}) as Record<string, unknown>,
  }
}

/** The bundle id a saved render request is measured under, so one measurement serves both sources. */
const RENDER_REQUEST_BUNDLE_ID = 'final-check-render-request'

/**
 * A saved render request as the bundle-shaped settings `shapeFromVideoAssemblySettings` measures.
 *
 * Pipeline writes the flattened request (`intro`, `timeline_clips`, `outro`, `post_audio`) into the
 * job's params; placing those back into the bundle's own slot shape is what lets the request be
 * measured by the exact code that measures the live settings, instead of by a second implementation
 * that could disagree about how the intro's window or the post-roll is counted.
 */
export function videoAssemblySettingsFromRenderRequest(params: Record<string, unknown>): any {
  const intro = (params?.intro && typeof params.intro === 'object' ? params.intro : {}) as Record<string, unknown>
  const outro = (params?.outro && typeof params.outro === 'object' ? params.outro : { enabled: false, video_path: '' })
  const videoPath = String(intro.video_path || '')
  return {
    video_bundle_presets: [{
      id: RENDER_REQUEST_BUNDLE_ID,
      name: "This render's own request",
      data: {
        fallback: {
          intro: {
            enabled: intro.enabled !== false && !!videoPath,
            video_path: videoPath,
            outro,
            timeline_clips: Array.isArray(params?.timeline_clips) ? params.timeline_clips : [],
          },
          timeline: { post_audio: params?.post_audio ?? null, title_image: params?.title_image },
        },
      },
    }],
    video_bundle_last_preset: RENDER_REQUEST_BUNDLE_ID,
  }
}

/**
 * A content fingerprint of ONLY the fields that shape the expectation.
 *
 * The channel's whole settings file cannot answer "did the fields that shaped this final move?":
 * any save anywhere in the channel rewrites it, so its mtime is newer than every final ever
 * rendered and proves nothing (measured on the mini 2026-10-20 — thirteen of nineteen channels'
 * files were rewritten inside seven seconds by one campaign, long after their finals were made).
 * This is the narrow version of the same question, over exactly the fields that produce a shape —
 * the intro slot (its clip, its outro, its timeline clips) and the timeline slot's post-audio block
 * — and nothing else. Two settings with the same fingerprint ask for the same tail and the same
 * intro, whatever else moved beside them.
 *
 * It is recorded with every freeze so the record names which settings it was taken from; it is
 * never a substitute for knowing that those settings are the ones the render read.
 */
export function shapingFingerprint(settings: any): string {
  const intro = resolveIntroSlot(settings) ?? null
  const timeline = resolveTimelineSlot(settings) ?? null
  const shaping = {
    intro: intro ? {
      enabled: intro.enabled === true,
      video_path: String(intro.video_path || ''),
      outro: {
        enabled: intro.outro?.enabled === true,
        video_path: String(intro.outro?.video_path || ''),
      },
      timeline_clips: (Array.isArray(intro.timeline_clips) ? intro.timeline_clips : []).map((clip: any) => ({
        id: String(clip?.id || ''),
        kind: String(clip?.kind || ''),
        anchor: String(clip?.anchor || ''),
        enabled: clip?.enabled !== false,
        duration_sec: Number(clip?.duration_sec) || 0,
        video_path: String(clip?.video_path || ''),
        image_path: String(clip?.image_path || ''),
      })),
    } : null,
    post_audio: timeline?.post_audio ?? null,
  }
  return createHash('sha256').update(JSON.stringify(shaping)).digest('hex')
}

/**
 * The frozen shape as the fields a check reads. `frozen_at` is what says the shape is ESTABLISHED for
 * these bytes — a frozen 0 s tail and no intro are answers, not absences (AGENTS.md §6).
 */
export function expectationFromFrozenShape(
  shape: FrozenFinalCheckShape,
): Pick<FinalCheckExpectation, 'after_narration_sec' | 'intro' | 'frozen_at'> {
  return {
    after_narration_sec: Math.max(0, Number(shape.after_narration_sec) || 0),
    ...(shape.intro ? { intro: shape.intro } : {}),
    frozen_at: shape.frozen_at,
  }
}

/**
 * True when the project's own settings file has not been written since this final was.
 *
 * `config.json` is where every Video Assembly preset lives, and a save that CHANGES it rewrites it
 * (`project-manager.ts`'s `updateConfig` leaves a no-op save alone). So a config older than the
 * final proves the settings that produced it have not moved; a config newer than it proves nothing
 * about the preset the render actually read — and "nothing" is answered as unknown, never as
 * today's settings.
 *
 * This is the WEAKEST of the three tests, and in practice the least useful: the file is
 * project-wide, so one campaign that touches anything at all in any channel's settings defeats it
 * for every final that channel has ever made (2026-10-20: thirteen of nineteen channels' files were
 * rewritten inside seven seconds, long after their finals). It stays because a file that provably
 * predates the final IS proof; the render request above is simply better evidence when it exists.
 */
async function settingsUnchangedSince(slug: string, mtimeMs: number): Promise<boolean> {
  if (!(mtimeMs > 0)) return false
  const projectDir = getProjectDir(slug)
  if (!projectDir) return false
  const stat = await fs.stat(path.join(projectDir, 'config.json')).catch(() => null)
  return !!stat && stat.mtimeMs <= mtimeMs
}

/** The shape the settings ask for now, measured the way the renderer measures it. */
async function deriveShapeFromSettings(input: PlanlessFinalRef): Promise<FrozenFinalCheckShape> {
  const stat = await fs.stat(input.video_path).catch(() => null)
  const reserved = await scenePlanOpeningReservedSec(input.slug, input.episode_code, input.episode_dir)
  const rendered = await resolveEpisodeRenderShape(input.slug, getAudioDuration, { opening_reserved_sec: reserved })
  return {
    schema_version: 1,
    frozen_at: new Date().toISOString(),
    episode_code: input.episode_code.toUpperCase(),
    file: stat ? { size: stat.size, mtime_ms: stat.mtimeMs } : { size: 0, mtime_ms: 0 },
    source: 'settings',
    after_narration_sec: rendered.after_narration_sec,
    // The intro's own black is measured HERE, once, for the file this freeze is about: a later check
    // must not re-measure an asset that may have been replaced since the final was made.
    intro: rendered.intro
      ? { ...rendered.intro, black: await measureIntroAssetBlack(rendered.intro.asset) }
      : null,
    shaping_fingerprint: await shapingFingerprintOfProject(input.slug),
    evidence: 'the channel’s Video Assembly settings, whose file had not been written since this final was',
  }
}

/** The shaping fingerprint of a project's settings as they stand now, or undefined when unreadable. */
async function shapingFingerprintOfProject(slug: string): Promise<string | undefined> {
  try {
    const { getConfig } = await import('./project-manager.js')
    const config = await getConfig(slug)
    return config ? shapingFingerprint(config) : undefined
  } catch {
    return undefined
  }
}

/**
 * The opening the episode's own Scene Plan reserved, when it can be read.
 *
 * The renderer trims or pads the intro clip to exactly this when the plan reserved an opening it did
 * not measure from the clips (`generators/video.ts`'s `req.intro.duration`), so the clip in the file
 * is that long and not the asset's own length. Read from the file directly — the Scene Plan's own GET
 * route writes as it reads, and a check has no business writing.
 */
async function scenePlanOpeningReservedSec(slug: string, code: string, episodeDir: string): Promise<number> {
  try {
    const planPath = await resolveScenePlanPath(slug, code, episodeDir)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    return Math.max(0, Number(plan?.opening_reserved_sec) || 0)
  } catch {
    return 0
  }
}

export interface FreezeSweepResult {
  /** Plan-less finals considered (a final with its own recorded plan needs no freeze). */
  planless: number
  frozen: number
  /** Of `frozen`, the ones taken on the owner's recorded decision rather than from the file's own evidence. */
  owner_attested: number
  kept: number
  replaced: number
  unknown: number
  /** The freeze records written or already there, so a person can look at each one. */
  records: string[]
  /** The finals that could not be established, with the reason. */
  unknown_finals: string[]
}

/**
 * Freeze every plan-less final on disk that does not have a freeze yet.
 *
 * Runs at boot (before any preset change can land) and is idempotent: a final that already carries a
 * freeze for its own bytes is left exactly as it is, so re-running this can never move an answer a
 * check has already been decided against. A final that already records its own plan is skipped — its
 * sidecar IS the record.
 *
 * Never throws: a boot task that fails must not take the app's start with it. What it could not do is
 * counted and returned, and the caller logs it.
 */
export async function freezeExistingPlanlessFinals(): Promise<FreezeSweepResult> {
  const result: FreezeSweepResult = {
    planless: 0, frozen: 0, owner_attested: 0, kept: 0, replaced: 0, unknown: 0, records: [], unknown_finals: [],
  }
  const { getIdeas } = await import('./idea-manager.js')
  const projects = await listProjects().catch(() => []) as Array<{ slug?: string }>
  for (const project of projects) {
    const slug = project.slug
    if (!slug) continue
    const cache = createProjectFactsCache(slug)
    const ideas = await getIdeas(slug, undefined, cache).catch(() => []) as Array<Record<string, unknown>>
    for (const idea of ideas) {
      const code = String(idea?.episode_code || '').toUpperCase()
      if (!code) continue
      try {
        const paths = await resolveEpisodePathsByCode(slug, code, cache).catch(() => null)
        if (!paths) continue
        const title = String(idea?.title || '')
        const videoPath = await findYouTubeSourceVideoPath(paths, slug, code, title, cache).catch(() => '')
        if (!videoPath) continue
        const stat = await fs.stat(videoPath).catch(() => null)
        if (!stat || !(stat.size > 0)) continue
        const stored = await readStoredFinalCheck(videoPath)
        // Only a verdict that still describes THESE bytes is evidence about them. A verdict the file
        // has outlived would hand the freeze below the previous final's tail and intro, stamped with
        // this file's size and mtime — a shape certified for the wrong video, and one a later check
        // would then read back as fresh (2026-10-20).
        const recorded = freshStoredExpectation(stored)
        // A final whose render recorded a plan of its own is measured against THAT plan; it needs no
        // freeze and must not get one (its sidecar is the plan the file was made for).
        if (recorded && Number(recorded.planned_sec) > 0) continue
        result.planless += 1
        const existing = await readFrozenShape(videoPath)
        if (existing && !existing.stale) {
          result.kept += 1
          result.records.push(videoPath)
          continue
        }
        const fromVerdict = frozenShapeFromStoredVerdict(recorded, code, stat)
        if (fromVerdict) {
          const wrote = await freezeShape(videoPath, fromVerdict)
          if (wrote === 'kept') result.kept += 1
          else if (wrote === 'replaced') result.replaced += 1
          else result.frozen += 1
          result.records.push(videoPath)
          continue
        }
        const settled = await planlessExpectationFor({
          slug, episode_code: code, episode_dir: paths.episode_dir, video_path: videoPath, mtime_ms: stat.mtimeMs,
        }, { ownerAttestation: true })
        if (settled.kind === 'frozen') {
          if (settled.shape.source === 'owner') result.owner_attested += 1
          result.frozen += 1
          result.records.push(videoPath)
        } else {
          result.unknown += 1
          result.unknown_finals.push(videoPath)
        }
      } catch {
        // One episode that cannot be walked must not stop the rest: the sweep's whole value is that
        // it covers as much as it can before the settings move.
        continue
      }
    }
  }
  // Quiet in the steady state: once every plan-less final is frozen there is nothing to report, and
  // a boot line per launch would be noise. What is written, and what could not be, is said out loud —
  // the record paths are what a person reads back to verify each final's frozen expectation.
  if (result.frozen + result.replaced + result.unknown > 0) {
    logLine('info', `[boot] frozen final-check expectations: ${result.frozen} taken `
      + `(${result.owner_attested} on the owner's decision), ${result.kept} already there, `
      + `${result.replaced} replaced, ${result.unknown} could not be established (of ${result.planless} plan-less final(s))`)
    for (const record of result.records) logLine('info', `[boot]   frozen: ${record}`)
    for (const unknown of result.unknown_finals) logLine('warn', `[boot]   no expectation could be established: ${unknown}`)
  }
  return result
}

/**
 * The shape a stored verdict already recorded, when it recorded one.
 *
 * A verdict written before this freeze existed still says what its check measured the file against
 * (a recorded `after_narration_sec` or `intro`), and that IS the answer for those bytes — the check
 * wrote it from the settings as they were at the time. A verdict with neither is not a shape: it
 * recorded nothing about the tail or the intro, so the sweep takes the shape itself.
 */
function frozenShapeFromStoredVerdict(
  expected: FinalCheckExpectation | null | undefined,
  code: string,
  stat: { size: number; mtimeMs: number },
): FrozenFinalCheckShape | null {
  if (!expected) return null
  const hasShape = Number(expected.after_narration_sec) > 0 || !!expected.intro
  if (!hasShape) return null
  return {
    schema_version: 1,
    frozen_at: typeof expected.frozen_at === 'string' && expected.frozen_at ? expected.frozen_at : new Date().toISOString(),
    episode_code: code.toUpperCase(),
    file: { size: stat.size, mtime_ms: stat.mtimeMs },
    source: 'plan',
    after_narration_sec: Math.max(0, Number(expected.after_narration_sec) || 0),
    intro: expected.intro ?? null,
    evidence: 'the plan this render recorded for itself, read back from the verdict beside the file',
  }
}

/** One final's freeze state, for a person verifying a channel without the app. */
export interface FinalFreezeState {
  episode_code: string
  title: string
  video_path: string
  /** The final's own mtime (ms), or 0 when it could not be read. */
  mtime_ms: number
  /** The freeze beside the final, when one has been taken. */
  frozen: {
    source: FrozenFinalCheckShape['source']
    frozen_at: string
    after_narration_sec: number
    intro_asset: string | null
    intro_window: { start_sec: number; end_sec: number } | null
    /** Whether the freeze still describes the bytes on disk right now. */
    stale: boolean
    shaping_fingerprint: string | null
    evidence: string | null
    /** Present on a `source: 'owner'` freeze: the decision it was taken on, in the owner's words. */
    owner: OwnerFreezeDecision | null
  } | null
  /** Why there is no freeze yet, in the words the check would report. Null when there is one. */
  unknown_reason: string | null
  /** The plan this render recorded for itself, when the verdict beside the file carries one. */
  planned_sec: number
}

/**
 * Every final this channel has, with its freeze state — verdict or no verdict.
 *
 * The check's own read (`GET .../youtube/final-check`) answers 404 before it looks beside the file,
 * so a final nobody has checked yet had no way to say whether it was frozen. This does: one row per
 * episode that has a rendered final, saying whether a freeze is beside it, what it was taken from,
 * and — when there is none — which evidence was missing. Read-only: it asks
 * `planlessExpectationFor` with `freeze: false`, so looking can never take one.
 */
export async function finalFreezeStates(slug: string): Promise<FinalFreezeState[]> {
  const { getIdeas } = await import('./idea-manager.js')
  const cache = createProjectFactsCache(slug)
  const ideas = await getIdeas(slug, undefined, cache).catch(() => []) as Array<Record<string, unknown>>
  const states: FinalFreezeState[] = []
  for (const idea of ideas) {
    const code = String(idea?.episode_code || '').toUpperCase()
    if (!code) continue
    const state = await finalFreezeStateFor(slug, code, String(idea?.title || ''), cache).catch(() => null)
    if (state) states.push(state)
  }
  return states
}

/**
 * One episode's freeze state, or null when it has no rendered final.
 *
 * Takes the same path resolution the check and the sweep use, so the three cannot disagree about
 * which file a final is.
 */
export async function finalFreezeStateFor(
  slug: string,
  code: string,
  title: string,
  cache?: ReturnType<typeof createProjectFactsCache>,
): Promise<FinalFreezeState | null> {
  const paths = await resolveEpisodePathsByCode(slug, code, cache).catch(() => null)
  if (!paths) return null
  const videoPath = await findYouTubeSourceVideoPath(paths, slug, code, title, cache).catch(() => '')
  if (!videoPath) return null
  const stat = await fs.stat(videoPath).catch(() => null)
  if (!stat || !(stat.size > 0)) return null
  const stored = await readStoredFinalCheck(videoPath)
  const recorded = freshStoredExpectation(stored)
  const shape = await readFrozenShape(videoPath)
  const frozen = shape
    ? {
        source: shape.shape.source,
        frozen_at: shape.shape.frozen_at,
        after_narration_sec: Math.max(0, Number(shape.shape.after_narration_sec) || 0),
        intro_asset: shape.shape.intro?.asset ?? null,
        intro_window: shape.shape.intro?.window ?? null,
        stale: shape.stale,
        shaping_fingerprint: shape.shape.shaping_fingerprint ?? null,
        evidence: shape.shape.evidence ?? null,
        owner: shape.shape.owner ?? null,
      }
    : null
  let unknownReason: string | null = null
  if (!frozen) {
    // `ownerAttestation` is asked here too, with `freeze: false`: it never writes, and it is what
    // turns "the settings cannot be shown" into the reason the owner's decision did or did not reach
    // this final. After the boot sweep an in-scope final is already frozen, so this only runs the
    // file's own confirmation (one duration probe and one opening decode) for the finals the sweep
    // refused — which are exactly the ones a person is looking here to understand.
    const settled = await planlessExpectationFor({
      slug, episode_code: code, episode_dir: paths.episode_dir, video_path: videoPath, mtime_ms: stat.mtimeMs,
    }, { freeze: false, ownerAttestation: true }).catch(() => null)
    unknownReason = settled?.kind === 'unknown' ? settled.reason : null
  }
  return {
    episode_code: code,
    title,
    video_path: videoPath,
    mtime_ms: stat.mtimeMs,
    frozen,
    unknown_reason: unknownReason,
    planned_sec: Number(recorded?.planned_sec) > 0 ? Number(recorded!.planned_sec) : 0,
  }
}
