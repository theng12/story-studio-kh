/**
 * Keeping an episode's stitched transcript current, automatically (v1.4.0).
 *
 * The owner's report: *"i need you to make sure that the subtitle is
 * automatically stitched/re-stitched."* Until now stitching was something a
 * person remembered to do — from the Subtitles workspace, or as a side effect of
 * a transcribe. Forgetting it left `{CODE}_stitched.srt` describing an older
 * version of the episode, and the renderer burned it faithfully.
 *
 * ── Why a content hash, and not the file's timestamp ──
 *
 * mtime lies. Copying a project folder, restoring one from a backup, syncing it
 * through iCloud or checking it out again all rewrite modification times without
 * changing a single word — and, worse, can make a stale stitch look NEWER than
 * the chapters it was built from. A hash of the bytes answers the only question
 * that matters: is this file still the correct consequence of these inputs?
 *
 * The fingerprint covers what the stitch is actually computed FROM, rather than
 * the files that happen to carry it:
 *   - every per-chapter SRT the stitcher would consume, by content;
 *   - which chapter each one feeds, and that chapter's audio duration;
 *   - the inter-chapter gap;
 *   - the measured intro lead-in the timeline is offset by.
 *
 * Hashing `audio_chapters.json` wholesale would have been easier and worse: it
 * carries fields the stitch never reads, so a harmless rewrite would report the
 * timeline as stale every single render.
 *
 * ── Why an unmeasurable lead-in stops the render ──
 *
 * Because the alternative is the defect this codebase has already paid for
 * twice. A lead-in that could not be measured used to become `0`, which is also
 * the correct answer for an episode with no intro — and roughly 284 episodes
 * were stitched sixteen seconds early with nothing in any log to see. AGENTS.md
 * states the rule ("A Zero That Means Two Things Is A Defect"); this module is
 * the render-time half of obeying it. If the offset cannot be established, the
 * captions' alignment cannot be certified, so the render stops and says why
 * rather than producing a video whose subtitles may be wrong.
 *
 * That refusal is deliberately NARROW. It applies only when a stitch is actually
 * needed. An episode with no per-chapter transcripts at all has nothing to
 * stitch and is not blocked — it simply falls through to whatever transcript it
 * does have.
 */

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { readStitchPlan, stitchSubtitles, type StitchResult } from '../services/subtitle-stitcher.js'
import { verifyWrittenSubtitleTimeline } from '../services/scene-timeline-integrity.js'
import { resolveEpisodeIntroLeadIn, type EpisodeIntroLeadIn } from './intro-lead-in.js'
import { hashSubtitleAudioSources, inspectSubtitleSourceFreshness } from '../services/subtitle-completion.js'

/** Millisecond precision, so float noise never reads as a changed input. */
const roundMs = (n: number): number => Math.round((Number(n) || 0) * 1000) / 1000

export interface StitchSignatureSection {
  slug: string
  duration_sec: number
  /** The per-chapter SRT feeding this section, or null when none matched. */
  source_srt: string | null
  /** sha256 of that file's bytes, or null when there is no file. */
  sha256: string | null
  /** sha256 of the active audio bytes, when the assembly sidecar names them. */
  source_audio_sha256?: string | null
}

export interface StitchInputSignature {
  schema: 1
  gap_sec: number
  lead_in_sec: number
  sections: StitchSignatureSection[]
}

export async function sha256File(filePath: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Compare the fingerprint recorded beside a stitched file against the episode as
 * it stands now. Pure, so the decision can be tested without touching a disk.
 *
 * Every outcome names what moved. "Re-stitched" with no reason is the kind of
 * background activity that trains a person to ignore the log.
 */
export function decideRestitch(
  recorded: StitchInputSignature | null | undefined,
  current: StitchInputSignature,
  stitchedExists: boolean,
): { restitch: boolean; reason: string; changed: string[] } {
  if (!stitchedExists) {
    return { restitch: true, reason: 'this episode has no stitched transcript yet', changed: [] }
  }
  if (!recorded || recorded.schema !== 1 || !Array.isArray(recorded.sections)) {
    return {
      restitch: true,
      // Not an error. Every stitch written before v1.4.0 lacks a fingerprint, so
      // the first render of an existing episode rebuilds once and records one.
      reason: 'the existing transcript carries no record of what it was built from',
      changed: [],
    }
  }

  const changed: string[] = []
  if (roundMs(recorded.gap_sec) !== roundMs(current.gap_sec)) {
    changed.push(`the gap between chapters changed (${roundMs(recorded.gap_sec)}s → ${roundMs(current.gap_sec)}s)`)
  }
  if (roundMs(recorded.lead_in_sec) !== roundMs(current.lead_in_sec)) {
    changed.push(`the intro lead-in changed (${roundMs(recorded.lead_in_sec)}s → ${roundMs(current.lead_in_sec)}s)`)
  }

  const before = new Map(recorded.sections.map(s => [s.slug, s]))
  const after = new Map(current.sections.map(s => [s.slug, s]))
  for (const [slug, now] of after) {
    const was = before.get(slug)
    if (!was) { changed.push(`${slug} is a new chapter`); continue }
    if (was.source_srt !== now.source_srt) {
      changed.push(`${slug} now reads ${now.source_srt || '(no file)'} instead of ${was.source_srt || '(no file)'}`)
    } else if (was.sha256 !== now.sha256) {
      changed.push(`${slug}'s transcript was edited`)
    }
    if (was.source_audio_sha256 !== now.source_audio_sha256) {
      changed.push(`${slug}'s active audio changed`)
    }
    if (roundMs(was.duration_sec) !== roundMs(now.duration_sec)) {
      changed.push(`${slug}'s audio length changed (${roundMs(was.duration_sec)}s → ${roundMs(now.duration_sec)}s)`)
    }
  }
  for (const slug of before.keys()) {
    if (!after.has(slug)) changed.push(`${slug} is no longer part of this episode`)
  }

  return changed.length
    ? { restitch: true, reason: changed.join('; '), changed }
    : { restitch: false, reason: 'every input still matches the transcript on disk', changed: [] }
}

export type AutoStitchOutcome =
  /** Nothing to stitch — this episode has no per-chapter transcripts. Not a failure. */
  | { status: 'not-applicable'; reason: string; path: null }
  /** The stitched file on disk is still the correct consequence of its inputs. */
  | { status: 'fresh'; reason: string; path: string; lead_in: EpisodeIntroLeadIn }
  /** Inputs are gone but a stitched file exists; it is left exactly as it is. */
  | { status: 'kept'; reason: string; path: string }
  /** Rebuilt. `reason` names what moved. */
  | { status: 'stitched'; reason: string; changed: string[]; path: string; result: StitchResult; created: boolean; lead_in: EpisodeIntroLeadIn }

/**
 * Thrown when a stitch is required and cannot be performed. Distinguished from a
 * generic Error so the render path can say "captions" rather than guessing.
 */
export class SubtitleStitchBlocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubtitleStitchBlocked'
  }
}

export interface EnsureStitchedOptions {
  episodeDir: string
  subtitlesDir: string
  mergedAudioDir: string
  episodeCode: string
  /** Active chapter audio. Omitted only by legacy/test callers without a source manifest. */
  audioDir?: string
  /** The episode's resolved Script folder, when the caller knows it (a renamed folder must still be seen). */
  scriptDir?: string
  /** Re-stitch even when the fingerprint matches — the manual "Re-stitch" button. */
  force?: boolean
}

/**
 * Bring `{CODE}_stitched.srt` up to date if it is not already, and say what
 * happened. Throws `SubtitleStitchBlocked` when a stitch is needed and cannot be
 * completed — never a silent partial result.
 */
export async function ensureStitchedSubtitle(
  opts: EnsureStitchedOptions,
): Promise<AutoStitchOutcome> {
  const { episodeDir, subtitlesDir, mergedAudioDir, episodeCode } = opts
  const code = episodeCode.toUpperCase()
  const stitchedPath = path.join(subtitlesDir, `${code}_stitched.srt`)
  const stitchedExists = existsSync(stitchedPath)

  const plan = await readStitchPlan(episodeDir, subtitlesDir, code)
  if (!plan.ok) {
    // No usable inputs. If a stitched file already exists it stays untouched —
    // deleting or rebuilding it here would destroy a good timeline because its
    // sources have since been tidied away.
    if (stitchedExists) return { status: 'kept', reason: plan.reason, path: stitchedPath }
    return { status: 'not-applicable', reason: plan.reason, path: null }
  }
  const matchedCount = plan.matched.filter(m => m.source_srt).length
  if (!matchedCount) {
    const reason = 'no per-chapter transcript matches any audio section, so there is nothing to stitch'
    if (stitchedExists) return { status: 'kept', reason, path: stitchedPath }
    return { status: 'not-applicable', reason, path: null }
  }

  // Only now is the lead-in relevant — and only now can an unmeasurable one
  // block anything. An episode that never needed a stitch is never stopped by a
  // number it does not use.
  if (opts.audioDir) {
    const freshness = await inspectSubtitleSourceFreshness(episodeDir, opts.audioDir, subtitlesDir, code, opts.scriptDir)
    if (freshness.stale_sections.length) {
      throw new SubtitleStitchBlocked(
        `Video Assembly is blocked: ${code}'s subtitles need updating for ${freshness.stale_sections.join(', ')} because the active audio changed. `
        + 'Re-transcribe the listed chapter, then retry.',
      )
    }
  }

  const leadIn: EpisodeIntroLeadIn = await resolveEpisodeIntroLeadIn(episodeDir, mergedAudioDir, code)
  if (leadIn.status === 'unmeasurable') {
    throw new SubtitleStitchBlocked(
      `Video Assembly is blocked: ${code}'s captions cannot be timed because ${leadIn.reason} `
      + 'The stitched timeline is offset by however much audio plays before the narration starts, and that '
      + 'offset could not be established — so this app cannot tell "this episode has no intro" apart from '
      + '"I could not measure the intro". Rendering anyway would risk burning captions that run ahead of the '
      + 'voice for the whole episode. Re-run Audio Assembly for this episode so the merge records its opening, '
      + 'then retry.',
    )
  }

  let sourceBySlug = new Map<string, string[]>()
  if (opts.audioDir) {
    try {
      const sidecar = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8')) as {
        sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>
      }
      for (const section of sidecar.sections || []) {
        if (typeof section.slug !== 'string' || !section.slug.trim()) continue
        const listed = Array.isArray(section.source_files)
          ? section.source_files.filter((name): name is string => typeof name === 'string' && path.basename(name) === name)
          : []
        const fallback = typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file
          ? [section.source_file]
          : []
        const files = listed.length ? listed : fallback
        if (files.length) sourceBySlug.set(section.slug.toLowerCase(), files.map(name => path.join(opts.audioDir!, name)))
      }
    } catch { /* Legacy sidecars have no active source identity. */ }
  }
  const sections: StitchSignatureSection[] = []
  for (const [i, sec] of plan.sections.entries()) {
    const file = plan.matched[i]?.source_srt || null
    const sources = sourceBySlug.get(sec.slug.toLowerCase()) || []
    sections.push({
      slug: sec.slug,
      duration_sec: roundMs(sec.duration_s),
      source_srt: file,
      sha256: file ? await sha256File(path.join(subtitlesDir, file)) : null,
      ...(sources.length ? { source_audio_sha256: await hashSubtitleAudioSources(sources) } : {}),
    })
  }
  const current: StitchInputSignature = {
    schema: 1,
    gap_sec: roundMs(plan.gap_sec),
    lead_in_sec: roundMs(leadIn.seconds),
    sections,
  }

  const recorded = await readRecordedSignature(stitchedPath)
  let decision = opts.force
    ? { restitch: true, reason: 'a re-stitch was asked for', changed: [] as string[] }
    : decideRestitch(recorded, current, stitchedExists)

  if (!decision.restitch) {
    if (await verifyWrittenSubtitleTimeline(subtitlesDir, code)) {
      return { status: 'fresh', reason: decision.reason, path: stitchedPath, lead_in: leadIn }
    }
    decision = {
      restitch: true,
      reason: 'the existing stitched subtitle output no longer matches its verification record',
      changed: [],
    }
  }

  try {
    const result = await stitchSubtitles({
      episode_dir: episodeDir,
      subtitles_dir: subtitlesDir,
      episode_code: code,
      lead_in_sec: leadIn.seconds,
      lead_in: leadIn,
      input_signature: current,
    })
    return {
      status: 'stitched',
      reason: decision.reason,
      changed: decision.changed,
      path: result.output_path,
      result,
      created: !stitchedExists,
      lead_in: leadIn,
    }
  } catch (e: any) {
    // The stitcher's own messages already name the missing chapter or the empty
    // transcript and say how to repair it, so they are carried through rather
    // than replaced by a generic one.
    throw new SubtitleStitchBlocked(
      `Video Assembly is blocked: ${code}'s stitched transcript is out of date and could not be rebuilt. `
      + `${e?.message || String(e)}`,
    )
  }
}

/** The fingerprint recorded beside a stitched file, or null when there is none. */
export async function readRecordedSignature(stitchedPath: string): Promise<StitchInputSignature | null> {
  try {
    const meta = JSON.parse(await fs.readFile(`${stitchedPath}.json`, 'utf-8'))
    const sig = meta?.inputs
    return sig && typeof sig === 'object' ? sig as StitchInputSignature : null
  } catch {
    return null
  }
}

/** One line for a job log or a toast, stating what the auto-stitch did. */
export function describeAutoStitch(outcome: AutoStitchOutcome, code: string): string {
  switch (outcome.status) {
    case 'not-applicable':
      return `Subtitles: nothing to stitch for ${code} — ${outcome.reason}.`
    case 'kept':
      return `Subtitles: keeping ${code}'s existing stitched transcript — ${outcome.reason}.`
    case 'fresh':
      return `Subtitles: ${code}'s stitched transcript is up to date — ${outcome.reason}.`
    case 'stitched':
      return outcome.created
        ? `Subtitles: stitched ${code}'s transcript for the first time (${outcome.result.total_cues} cues) — ${outcome.reason}.`
        : `Subtitles: re-stitched ${code}'s transcript (${outcome.result.total_cues} cues) because ${outcome.reason}.`
  }
}
