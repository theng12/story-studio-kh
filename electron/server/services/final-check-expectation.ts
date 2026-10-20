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

import fs from 'fs/promises'
import path from 'path'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import {
  freezeShape, measureIntroAssetBlack, readFrozenShape, readStoredFinalCheck,
  type FinalCheckExpectation, type FrozenFinalCheckShape,
} from '../lib/final-video-check.js'
import { resolveEpisodeRenderShape } from './opening-assets.js'
import { createProjectFactsCache, resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { findYouTubeSourceVideoPath } from './youtube-source-video.js'
import { getProjectDir, listProjects } from './project-manager.js'
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
 * The frozen expectation for a plan-less final, taken now if it is still safe to take.
 *
 * Order: the freeze already beside the file; else the settings, but ONLY when they can be shown to
 * have not moved since the final was written; else `unknown`. It never falls back to "the settings,
 * whatever they say" — a wrong number there is a STOP on a file the owner kept, which is the whole
 * defect this exists to close.
 */
export async function planlessExpectationFor(input: PlanlessFinalRef): Promise<PlanlessExpectation> {
  const frozen = await readFrozenShape(input.video_path)
  if (frozen && !frozen.stale) return { kind: 'frozen', shape: frozen.shape }
  if (!(await settingsUnchangedSince(input.slug, input.mtime_ms))) {
    return { kind: 'unknown', reason: SETTINGS_CHANGED_REASON }
  }
  const shape = await deriveShapeFromSettings(input)
  await freezeShape(input.video_path, shape)
  return { kind: 'frozen', shape }
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
 * `config.json` is where every Video Assembly preset lives, and saving one rewrites it. So a config
 * older than the final proves the settings that produced it have not moved; a config newer than it
 * proves nothing about the preset the render actually read — and "nothing" is answered as unknown,
 * never as today's settings.
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
  const result: FreezeSweepResult = { planless: 0, frozen: 0, kept: 0, replaced: 0, unknown: 0, records: [], unknown_finals: [] }
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
        // A final whose render recorded a plan of its own is measured against THAT plan; it needs no
        // freeze and must not get one (its sidecar is the plan the file was made for).
        if (stored && Number(stored.result.expected?.planned_sec) > 0) continue
        result.planless += 1
        const existing = await readFrozenShape(videoPath)
        if (existing && !existing.stale) {
          result.kept += 1
          result.records.push(videoPath)
          continue
        }
        const fromVerdict = frozenShapeFromStoredVerdict(stored?.result.expected, code, stat)
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
        })
        if (settled.kind === 'frozen') {
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
    logLine('info', `[boot] frozen final-check expectations: ${result.frozen} taken, ${result.kept} already there, `
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
  }
}
