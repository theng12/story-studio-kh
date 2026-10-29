/**
 * Cross-language timeline rebase for a translated episode (v1.4.368).
 *
 * ── Why this exists ──
 *
 * Translating an episode keeps the visuals: the stills, the clips, the thumbnails and the scene
 * plan are copied into the target channel so the Khmer episode shows the SAME pictures in the SAME
 * order (owner, 2026-10-28). But a scene plan's real content is not its prompts — it is its clock.
 * The copied plan still carries the SOURCE language's `start_sec` / `end_sec`,
 * `source_merged_audio.duration_sec` and `transcript_segment`, so the Khmer episode's own narration
 * (a different length, in a different language) lands under pictures timed for somebody else's
 * voice. The merged-audio freshness check then refuses the plan (0.5 s tolerance), "Reconcile
 * timings" cannot help because it matches text against the cues and the stored text is English,
 * and a plan rebuild would replace the very images the translation exists to reuse.
 *
 * ── The rule (what anchors the timing, and why) ──
 *
 * Khmer is SCRIPT-timed (owner rule): never ASR, never Whisper. So there is no Khmer word-level
 * timeline to align against — the only two facts that exist are the Khmer chapter boundaries (from
 * `audio_chapters.json`, which Audio Assembly writes from the audio it actually concatenated) and
 * the translated chapter text.
 *
 * Therefore a scene is tied to its TRANSLATED CHAPTER by the section clock it sat in on the source
 * episode (a measured fact: the plan was cut from the source's stitched captions, and those captions
 * are offset by the same chapter durations + gaps + intro lead-in the merge recorded). Then, within
 * that chapter, the scene keeps its SHARE of the chapter's spoken length: its source window's length
 * as a fraction of the source chapter's scenes' total length. The scenes of a chapter are laid
 * end-to-end across the Khmer chapter's own measured length.
 *
 * Why the share-of-chapter rule and not "map each scene's start time proportionally over the whole
 * episode": a chapter boundary is the ONE point where the two languages are known to coincide
 * (both narrations read the same chapter), so anchoring on it keeps every scene in the right
 * chapter even when Khmer runs much longer or shorter overall. Within a chapter, equal content is
 * spoken at a roughly equal pace in both languages, so the source's measured share is the most
 * faithful position available — and it is recorded, so the same input always produces the same
 * answer.
 *
 * ── What is deliberately untouched ──
 *
 * Every scene keeps its id, order, `image_path`, `image_version`, `image_sha256`, `approved` flag,
 * prompts and motion fields. No image is ever generated here. Provider image-to-video clips are
 * left alone (Video Assembly trims or holds them); Sketch Draw clips are invalidated by the ONE
 * existing freshness rule (`sceneClipStaleReason`, "scene length changed") when their window moves,
 * not by anything this module writes.
 *
 * ── Idempotence ──
 *
 * The provenance written with the retimed plan records each scene's chapter and share. A Retry with
 * the same narration is a no-op ("already retimed"); a Retry after a re-merge recomputes from the
 * RECORDED shares, never from the already-rebased times, so running it twice cannot walk the plan
 * away from the narration.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { mergedAudioCompletionPath, mergedClosingTailSec, narrationSecFromMaster } from '../lib/closing-tail.js'
import { resolveEpisodeIntroLeadIn, narrationExtentSec, scenePlanLeadInShiftSec } from '../lib/intro-lead-in.js'
import {
  MERGED_AUDIO_TOLERANCE_SEC,
  MIN_RENDERABLE_SCENE_SEC,
  readMergedAudioRecord,
} from '../lib/scene-plan-timeline.js'
import { reconstructAudioChapters } from '../lib/audio-chapters-reconstruct.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from './utils.js'
import { resolveArtifact, readArtifactRawText } from '../lib/episode-artifacts.js'
import { parseTranslatedChapter, parseTranslatedIntro, readTranslationProvenance, type TranslationProvenance } from './translation.js'
import type { ScenePlan, ScenePlanEntry, TranslationTimelineRebase } from '../models/types.js'

/** The one rule this module applies. Recorded beside the answer so a reader knows what produced it. */
export const TRANSLATION_REBASE_RULE = 'chapter-share'
export const TRANSLATION_REBASE_SCHEMA = 1

function refusal(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** One chapter of an episode's narration, as the merge recorded it. */
export interface SectionClock {
  sections: Array<{ slug: string; duration_s: number }>
  gap_sec: number
  /** Seconds of non-narration audio before the first chapter (intro file / music lead-in). */
  lead_in_sec: number
  /** The narration's own length — the merged file minus any closing music tail. */
  narration_sec: number
  merged_filename: string | null
  notes: string[]
}

/**
 * The section clock of an episode: chapter lengths, the gap between them, the intro lead-in and the
 * narration length. Reads the merge's own `audio_chapters.json`; when that sidecar is missing it
 * reconstructs the same numbers from the per-chapter audio on disk rather than answering "unknown".
 */
export async function readSectionClock(slug: string, code: string): Promise<SectionClock> {
  const paths = await resolveEpisodePathsByCode(slug, code)
  const notes: string[] = []
  let sections: Array<{ slug: string; duration_s: number }> = []
  let gap = 0

  const sidecarPath = path.join(paths.episode_dir, 'audio_chapters.json')
  if (existsSync(sidecarPath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(sidecarPath, 'utf-8'))
      const rows = Array.isArray(parsed?.sections) ? parsed.sections : []
      sections = rows
        .map((row: Record<string, unknown>) => ({ slug: String(row?.slug || '').trim(), duration_s: Number(row?.duration_s) }))
        .filter((row: { slug: string; duration_s: number }) => row.slug && row.duration_s > 0)
      gap = Math.max(0, Number(parsed?.gap_duration_s) || 0)
    } catch {
      notes.push('audio_chapters.json could not be read; the chapter lengths were measured from disk instead.')
    }
  }
  if (!sections.length) {
    const rebuilt = await reconstructAudioChapters({
      audioDir: paths.audio_dir,
      mergedAudioDir: paths.merged_audio_dir,
      episodeCode: code,
    })
    if (rebuilt?.sections.length) {
      sections = rebuilt.sections.map(s => ({ slug: s.slug, duration_s: s.duration_s }))
      gap = rebuilt.gap_duration_s
      notes.push('audio_chapters.json was missing; the chapter lengths were measured from the chapter audio on disk.')
    }
  }
  if (!sections.length) {
    throw refusal(409, `${code.toUpperCase()} has no chapter audio durations (no audio_chapters.json and no chapter audio on disk), `
      + 'so each scene cannot be tied to a chapter. Run Audio Assembly for that episode, then retry.')
  }

  const lead = await resolveEpisodeIntroLeadIn(paths.episode_dir, paths.merged_audio_dir, code)
  const leadIn = lead.status === 'measured' ? Math.max(0, lead.seconds) : 0
  if (lead.status !== 'measured') {
    notes.push(`The opening of ${code.toUpperCase()}'s merged audio could not be measured (${lead.reason}) — the chapter clock starts at 0.`)
  }
  let mergedFilename = lead.merged_filename ?? null
  if (!mergedFilename && existsSync(paths.merged_audio_dir)) {
    // The opening could not be described, but the track is still the one the rest of the app
    // renders with, so its length is still the narration's length.
    const { resolveEpisodeMergedAudioChoice, selectMergedAudioFilename } = await import('../lib/merged-audio-selection.js')
    const entries = await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])
    const choice = await resolveEpisodeMergedAudioChoice(paths.merged_audio_dir, code).catch(() => null)
    mergedFilename = choice?.source === 'selected' ? choice.filename : selectMergedAudioFilename(entries, code)
  }

  let narrationSec = 0
  if (mergedFilename) {
    const mergedPath = path.join(paths.merged_audio_dir, mergedFilename)
    const record = await readMergedAudioRecord(mergedAudioCompletionPath(mergedPath, code), mergedFilename).catch(() => null)
    if (record) narrationSec = record.duration_sec
    else {
      const whole = await getAudioDuration(mergedPath).catch(() => undefined)
      if (whole) narrationSec = narrationSecFromMaster(whole, await mergedClosingTailSec(mergedPath, code).catch(() => 0))
    }
  }
  if (!(narrationSec > 0)) {
    throw refusal(409, `${code.toUpperCase()} has no merged narration of a measurable length. `
      + 'Merge its narration in Audio Assembly first — a translated timeline cannot be built without the target audio.')
  }
  // The chapter clock must fit inside the narration it claims to describe. A sidecar rewritten
  // after a different merge cannot be used to place scenes, and saying so is the honest answer.
  const extent = leadIn + narrationExtentSec(sections, gap)
  if (extent > narrationSec + MERGED_AUDIO_TOLERANCE_SEC) {
    throw refusal(409, `${code.toUpperCase()}'s chapter lengths add up to ${extent.toFixed(1)}s including a ${leadIn.toFixed(1)}s `
      + `intro lead-in, but its merged narration is ${narrationSec.toFixed(1)}s — the chapter sidecar does not describe this `
      + 'track. Re-run Audio Assembly, then retry.')
  }
  if (narrationSec - extent > MERGED_AUDIO_TOLERANCE_SEC) {
    notes.push(`${code.toUpperCase()}'s merged file is ${(narrationSec - extent).toFixed(1)}s longer than its chapters; `
      + 'the scenes are timed to the chapters\' narration.')
  }
  return { sections, gap_sec: gap, lead_in_sec: leadIn, narration_sec: narrationSec, merged_filename: mergedFilename, notes }
}

/** Where each chapter sits on the merged clock: the same cursor math the subtitle stitcher uses. */
export function sectionWindows(clock: Pick<SectionClock, 'sections' | 'gap_sec' | 'lead_in_sec'>): Array<{
  slug: string
  start_sec: number
  end_sec: number
  duration_s: number
}> {
  let cursor = Math.max(0, clock.lead_in_sec)
  const gap = Math.max(0, clock.gap_sec)
  return clock.sections.map(section => {
    const duration = Math.max(0, section.duration_s)
    const window = { slug: section.slug, start_sec: round3(cursor), end_sec: round3(cursor + duration), duration_s: round3(duration) }
    cursor += duration + gap
    return window
  })
}

/** The chapter a moment on the clock belongs to; a moment in a gap goes to the nearer chapter. */
export function chapterForTime(
  windows: Array<{ slug: string; start_sec: number; end_sec: number }>,
  timeSec: number,
): string | null {
  if (!windows.length) return null
  const t = Number(timeSec) || 0
  const inside = windows.find(w => t >= w.start_sec - 1e-9 && t <= w.end_sec + 1e-9)
  if (inside) return inside.slug
  let best = windows[0]!
  let bestDistance = Infinity
  for (const window of windows) {
    const distance = t < window.start_sec ? window.start_sec - t : t - window.end_sec
    if (distance < bestDistance) { bestDistance = distance; best = window }
  }
  return best.slug
}

/**
 * Lay `shares` (each scene's share of the chapter's spoken length) end-to-end across
 * [start, end].
 *
 * The renderer plays no window shorter than `MIN_RENDERABLE_SCENE_SEC`, so every allocation gets
 * that floor first and only the remainder is shared by proportion — which leaves the proportions
 * intact whenever the chapter is long enough to matter. A chapter too short for its own scenes is
 * refused rather than squeezed: a row the renderer would silently play at the floor is exactly the
 * "the plan says one thing, the video does another" defect §8 forbids.
 */
export function allocateWithinWindow(
  shares: number[],
  startSec: number,
  endSec: number,
  options: { floorSec?: number; label?: string } = {},
): Array<{ start_sec: number; end_sec: number }> {
  const n = shares.length
  if (!n) return []
  const floor = Math.max(0, options.floorSec ?? MIN_RENDERABLE_SCENE_SEC)
  const total = Math.max(0, endSec - startSec)
  if (total < n * floor - 1e-9) {
    throw refusal(409, `${options.label || 'a chapter'}'s narration is ${total.toFixed(2)}s and it carries ${n} scene(s), `
      + `each of which needs at least ${floor.toFixed(1)}s. Re-plan that chapter or re-translate it — the pictures cannot be timed to this narration.`)
  }
  const sum = shares.reduce((a, b) => a + Math.max(0, b), 0)
  const weights = sum > 0 ? shares.map(s => Math.max(0, s) / sum) : shares.map(() => 1 / n)
  const spare = total - n * floor
  const durations = weights.map(weight => floor + weight * spare)
  const out: Array<{ start_sec: number; end_sec: number }> = []
  let cursor = startSec
  for (let index = 0; index < n; index += 1) {
    const isLast = index === n - 1
    const end = isLast ? endSec : cursor + durations[index]!
    out.push({ start_sec: round3(cursor), end_sec: round3(end) })
    cursor = end
  }
  // Rounding must never leave the last row short of (or past) the narration.
  const last = out[out.length - 1]!
  last.start_sec = Math.min(last.start_sec, round3(endSec))
  last.end_sec = round3(endSec)
  return out
}

/** A slice of `text` for the [fromFraction, toFraction) part of it, cut at whitespace. */
export function sliceTextByShare(text: string, fromFraction: number, toFraction: number): string {
  const value = String(text || '')
  if (!value.trim()) return ''
  const from = Math.min(1, Math.max(0, fromFraction)) * value.length
  const to = Math.min(1, Math.max(fromFraction, toFraction)) * value.length
  let start = Math.floor(from)
  let end = Math.ceil(to)
  // Never open or close a word in the middle.
  while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1
  while (end < value.length && !/\s/.test(value[end]!)) end += 1
  let slice = value.slice(start, end).trim()
  if (!slice) {
    // A scene narrower than one word still gets a word, never an empty segment.
    start = Math.min(value.length - 1, Math.max(0, start))
    end = value.length
    slice = value.slice(start, end).trim().split(/\s+/)[0] || value.trim().split(/\s+/)[0] || ''
  }
  return slice
}

interface ShareEntry {
  id: string
  chapter: string
  share: number
  source_start_sec: number
  source_end_sec: number
}

/** Chapter + share for every scene, on the clock the shares were measured on. */
export function assignSceneShares(
  scenes: ScenePlanEntry[],
  windows: Array<{ slug: string; start_sec: number; end_sec: number }>,
  recorded?: ShareEntry[],
): Map<string, ShareEntry> {
  const byId = new Map((recorded || []).map(entry => [entry.id, entry]))
  const out = new Map<string, ShareEntry>()
  const byChapter = new Map<string, ScenePlanEntry[]>()

  for (const scene of scenes) {
    const known = byId.get(scene.id)
    if (known) {
      out.set(scene.id, { ...known })
      continue
    }
    const start = Number(scene.start_sec) || 0
    const end = Number(scene.end_sec) || start
    const chapter = chapterForTime(windows, (start + end) / 2)
    if (!chapter) continue
    const list = byChapter.get(chapter) ?? []
    list.push(scene)
    byChapter.set(chapter, list)
    out.set(scene.id, { id: scene.id, chapter, share: 0, source_start_sec: round3(start), source_end_sec: round3(end) })
  }

  for (const [chapter, list] of byChapter) {
    const lengths = list.map(scene => Math.max(0, (Number(scene.end_sec) || 0) - (Number(scene.start_sec) || 0)))
    const sum = lengths.reduce((a, b) => a + b, 0)
    list.forEach((scene, index) => {
      const entry = out.get(scene.id)!
      entry.source_start_sec = round3(Number(scene.start_sec) || 0)
      entry.source_end_sec = round3(Number(scene.end_sec) || 0)
      entry.share = sum > 0 ? round6(lengths[index]! / sum) : round6(1 / list.length)
      entry.chapter = chapter
    })
  }
  return out
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/** The translated chapter's body text, keyed by the section slug it belongs to (lower case). */
async function translatedChapterTexts(
  slug: string,
  code: string,
  sections: Array<{ slug: string }>,
): Promise<Map<string, string>> {
  const paths = await resolveEpisodePathsByCode(slug, code)
  const out = new Map<string, string>()
  for (const section of sections) {
    const file = resolveArtifact(paths.script_dir, `${code}_${section.slug}`)
    if (!file) continue
    const raw = await readArtifactRawText(file).catch(() => '')
    if (!raw.trim()) continue
    const number = Number(/(\d+)/.exec(section.slug)?.[1] || 0)
    let body: string
    try {
      body = /^intro/i.test(section.slug)
        ? parseTranslatedIntro(raw).text
        : (number ? parseTranslatedChapter(raw, number).text : raw.trim())
    } catch {
      body = raw.trim()
    }
    if (body.trim()) out.set(section.slug.toLowerCase(), body)
  }
  return out
}

export interface TranslatedPlanRebaseOutcome {
  changed: boolean
  /** Set when nothing was retimed; one sentence fit to show a person. */
  skipped_reason?: string
  /** One sentence for a job log. */
  message: string
  narration_duration_sec: number
  lead_in_sec: number
  chapters: number
  scenes: number
  dropped: Array<{ id: string; chapter: string }>
  /** Scenes whose window moved enough that a Sketch Draw clip on them goes stale. */
  duration_changed_scene_ids: string[]
  notes: string[]
}

function sameClock(recorded: TranslationTimelineRebase['narration'] | undefined, clock: SectionClock): boolean {
  if (!recorded) return false
  if (recorded.filename && clock.merged_filename && recorded.filename !== clock.merged_filename) return false
  return Math.abs((Number(recorded.duration_sec) || 0) - clock.narration_sec) < MERGED_AUDIO_TOLERANCE_SEC
    && Math.abs((Number(recorded.lead_in_sec) || 0) - clock.lead_in_sec) < MERGED_AUDIO_TOLERANCE_SEC
}

/**
 * Retime a translated episode's copied Scene Plan onto ITS OWN narration.
 *
 * Called after the target narration is merged (Audio Assembly) and again before Video Assembly, so
 * a render can never use a plan still timed for the source language. Idempotent: the same narration
 * produces no write at all.
 */
export async function rebaseTranslatedScenePlan(options: {
  targetSlug: string
  targetEpisodeId: string
}): Promise<TranslatedPlanRebaseOutcome> {
  const { targetSlug, targetEpisodeId } = options
  const paths = await resolveEpisodePathsByCode(targetSlug, targetEpisodeId)
  const planPath = await resolveScenePlanPath(targetSlug, targetEpisodeId, paths.episode_dir)
  if (!existsSync(planPath)) {
    throw refusal(409, `${targetEpisodeId.toUpperCase()} has no Scene Plan to retime.`)
  }
  const provenance = await readTranslationProvenance(paths.episode_dir)
  if (!provenance) {
    throw refusal(409, `${targetEpisodeId.toUpperCase()} is not a translated episode, so it has no cross-language timeline to rebase.`)
  }
  const targetClock = await readSectionClock(targetSlug, targetEpisodeId)
  const targetWindows = sectionWindows(targetClock)
  const notes = [...targetClock.notes]

  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  if (!Array.isArray(plan.scenes) || !plan.scenes.length) {
    throw refusal(409, `${targetEpisodeId.toUpperCase()}'s Scene Plan has no scenes to retime.`)
  }
  const prior = plan.translation_rebase
  if (prior && prior.source_slug && prior.source_episode_id
    && (prior.source_slug !== provenance.source_slug || prior.source_episode_id !== provenance.source_episode_id)) {
    throw refusal(409, `${targetEpisodeId.toUpperCase()}'s Scene Plan was retimed for `
      + `${prior.source_slug}/${prior.source_episode_id} but this episode is translated from `
      + `${provenance.source_slug}/${provenance.source_episode_id}. Refusing to retime a plan that belongs to another source.`)
  }
  const reusablePrior = prior && prior.schema_version === TRANSLATION_REBASE_SCHEMA && prior.rule === TRANSLATION_REBASE_RULE
    ? prior
    : undefined

  if (reusablePrior && sameClock(reusablePrior.narration, targetClock)) {
    return {
      changed: false,
      skipped_reason: `the Scene Plan is already timed to this narration (${targetClock.narration_sec.toFixed(1)}s)`,
      message: `${targetEpisodeId.toUpperCase()}: the Scene Plan is already retimed to its own narration (${targetClock.narration_sec.toFixed(1)}s) — nothing to do.`,
      narration_duration_sec: round3(targetClock.narration_sec),
      lead_in_sec: round3(targetClock.lead_in_sec),
      chapters: targetWindows.length,
      scenes: plan.scenes.length,
      dropped: [],
      duration_changed_scene_ids: [],
      notes,
    }
  }

  // The clock the shares are measured on. On the first run that is the SOURCE episode's own
  // chapter clock; on a retry it is the clock recorded with the previous retime, so a re-merge
  // recomputes from the recorded shares instead of walking the plan away from the narration.
  let shareWindows: Array<{ slug: string; start_sec: number; end_sec: number }>
  let scenesForShare = plan.scenes
  if (reusablePrior?.chapters?.length) {
    shareWindows = reusablePrior.chapters.map(chapter => ({
      slug: chapter.slug, start_sec: Number(chapter.source_start_sec) || 0, end_sec: Number(chapter.source_end_sec) || 0,
    }))
  } else {
    const sourceClock = await readSectionClock(provenance.source_slug, provenance.source_episode_id)
    const sourceWindows = sectionWindows(sourceClock)
    // A source plan built before the merge added an intro lead-in is short by exactly that lead-in;
    // the renderer shifts it for the same reason, so the share clock uses the same correction.
    const leadInShift = scenePlanLeadInShiftSec(plan.scenes, sourceClock.lead_in_sec, sourceClock.narration_sec)
    scenesForShare = leadInShift > 0
      ? plan.scenes.map((scene, index) => index === 0
        ? scene
        : { ...scene, start_sec: scene.start_sec + leadInShift, end_sec: scene.end_sec + leadInShift })
      : plan.scenes
    shareWindows = sourceWindows
  }

  const shares = assignSceneShares(scenesForShare, shareWindows, reusablePrior?.scenes)
  if (!shares.size) {
    throw refusal(409, `${targetEpisodeId.toUpperCase()}'s scenes could not be tied to a chapter. `
      + 'Rebuild the Scene Plan timeline for this episode instead of translating it.')
  }

  const targetBySlug = new Map(targetWindows.map(window => [window.slug.toLowerCase(), window]))
  const chapterTexts = await translatedChapterTexts(targetSlug, targetEpisodeId, targetClock.sections)

  const kept: ScenePlanEntry[] = []
  const dropped: Array<{ id: string; chapter: string }> = []
  const recordedScenes: TranslationTimelineRebase['scenes'] = []
  const recordedChapters: TranslationTimelineRebase['chapters'] = []
  const durationChanged: string[] = []

  // Chapters in the SOURCE plan's order, so the Khmer episode shows the same pictures in the same order.
  const chapterOrder: string[] = []
  for (const scene of plan.scenes) {
    const chapter = shares.get(scene.id)?.chapter
    if (chapter && !chapterOrder.includes(chapter)) chapterOrder.push(chapter)
  }

  let sceneIndex = 0
  for (const chapterSlug of chapterOrder) {
    const target = targetBySlug.get(chapterSlug.toLowerCase())
    const chapterScenes = plan.scenes.filter(scene => shares.get(scene.id)?.chapter === chapterSlug)
    if (!target) {
      for (const scene of chapterScenes) dropped.push({ id: scene.id, chapter: chapterSlug })
      continue
    }
    const shareList = chapterScenes.map(scene => Math.max(0, Number(shares.get(scene.id)!.share) || 0))
    const windows = allocateWithinWindow(shareList, target.start_sec, target.end_sec, {
      label: `${targetEpisodeId.toUpperCase()} ${chapterSlug}`,
    })
    const text = chapterTexts.get(chapterSlug.toLowerCase()) || ''
    const sum = shareList.reduce((a, b) => a + b, 0)
    const weights = sum > 0 ? shareList.map(value => value / sum) : shareList.map(() => 1 / chapterScenes.length)
    let textCursor = 0

    chapterScenes.forEach((scene, index) => {
      const window = windows[index]!
      const share = weights[index]!
      const entry: ScenePlanEntry = { ...scene }
      if (Math.abs((Number(scene.end_sec) - Number(scene.start_sec)) - (window.end_sec - window.start_sec)) > 0.001) {
        durationChanged.push(scene.id)
      }
      entry.start_sec = window.start_sec
      entry.end_sec = window.end_sec
      entry.scene_index = ++sceneIndex
      if (text) {
        const from = textCursor
        textCursor = Math.min(1, textCursor + share)
        const segment = sliceTextByShare(text, from, textCursor)
        // The target episode must not show the source language's words as its own scene text (§4).
        if (segment) entry.transcript_segment = segment
      }
      kept.push(entry)
      const recorded = shares.get(scene.id)!
      recordedScenes.push({
        id: scene.id,
        chapter: chapterSlug,
        share: round6(share),
        source_start_sec: round3(recorded.source_start_sec),
        source_end_sec: round3(recorded.source_end_sec),
      })
    })

    recordedChapters.push({
      slug: chapterSlug,
      source_start_sec: round3(
        Math.min(...chapterScenes.map(scene => Number(shares.get(scene.id)!.source_start_sec) || 0)),
      ),
      source_end_sec: round3(
        Math.max(...chapterScenes.map(scene => Number(shares.get(scene.id)!.source_end_sec) || 0)),
      ),
      target_start_sec: target.start_sec,
      target_end_sec: target.end_sec,
    })
  }

  if (!kept.length) {
    throw refusal(409, `${targetEpisodeId.toUpperCase()}'s narration has none of the chapters its Scene Plan was copied from, `
      + 'so no scene could be retimed. Translate the chapters this plan covers (or rebuild the plan) and retry.')
  }

  const now = new Date().toISOString()
  const rebase: TranslationTimelineRebase = {
    schema_version: TRANSLATION_REBASE_SCHEMA,
    rule: TRANSLATION_REBASE_RULE,
    source_slug: provenance.source_slug,
    source_episode_id: provenance.source_episode_id,
    rebased_at: now,
    narration: {
      filename: targetClock.merged_filename || '',
      duration_sec: round3(targetClock.narration_sec),
      lead_in_sec: round3(targetClock.lead_in_sec),
    },
    chapters: recordedChapters,
    scenes: recordedScenes,
    dropped: dropped.map(entry => {
      const scene = plan.scenes.find(row => row.id === entry.id)
      return { id: entry.id, chapter: entry.chapter, scene_index: Number(scene?.scene_index) || 0, image_path: scene?.image_path }
    }),
  }

  await withLock(planPath, async () => {
    const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const freshById = new Map((fresh.scenes || []).map(row => [row.id, row]))
    // The retime owns the timing fields only: every other field comes from the document on disk,
    // so an edit made between the read above and this lock is not lost.
    fresh.scenes = kept.map(scene => {
      const onDisk = freshById.get(scene.id)
      return onDisk ? { ...onDisk, ...scene } : scene
    })
    fresh.total_duration_sec = round3(Math.max(...fresh.scenes.map(scene => Number(scene.end_sec) || 0)))
    fresh.source_merged_audio = { duration_sec: round3(targetClock.narration_sec) }
    // The plan's scene times were NOT derived from the target language's captions, so claiming
    // their stamp would be a false statement. Absent is "not known to be stale", which is true.
    delete fresh.source_timeline
    // The caption file this plan is now compared against is the target episode's own (the copied
    // name still carried the source code, which is another episode's artifact — AGENTS.md §4).
    if (fresh.source_stitched_srt) {
      fresh.source_stitched_srt = `${targetEpisodeId.toUpperCase()}_stitched.srt`
    }
    fresh.timeline_built_at = now
    fresh.generated_at = now
    fresh.translation_rebase = rebase
    await writeJsonAtomic(planPath, fresh)
  })

  try {
    const { episodeStatusCache } = await import('./episode-status-cache.js')
    episodeStatusCache.invalidate(targetSlug, targetEpisodeId)
  } catch { /* status cache is advisory only */ }

  const message = `${targetEpisodeId.toUpperCase()}: retimed ${kept.length} scene(s) onto its own narration `
    + `(${targetClock.narration_sec.toFixed(1)}s across ${recordedChapters.length} chapter(s)); `
    + `every scene kept its id, picture and order${dropped.length ? `; ${dropped.length} scene(s) dropped because the narration has no such chapter` : ''}.`
  // Say what the new timing means for clips, using the one existing freshness rule rather than a
  // second copy of it: a Sketch Draw clip is drawn at its scene's exact length, so a window that
  // moved no longer fits it. Provider clips are trimmed/held by Video Assembly and stay.
  if (durationChanged.length) {
    notes.push(`${durationChanged.length} scene(s) changed length, so a Sketch Draw clip on them no longer fits and needs a `
      + 're-render in Motion Review; provider image-to-video clips are trimmed or held by Video Assembly and stay as they are.')
  }
  return {
    changed: true,
    message,
    narration_duration_sec: round3(targetClock.narration_sec),
    lead_in_sec: round3(targetClock.lead_in_sec),
    chapters: recordedChapters.length,
    scenes: kept.length,
    dropped,
    duration_changed_scene_ids: durationChanged,
    notes,
  }
}

/**
 * The guard the chain calls: retime a translated episode's plan when it has one, and do nothing at
 * all for every other episode. Returns null when the episode is not translated.
 */
export async function ensureTranslatedEpisodePlanRebased(
  slug: string,
  episodeId: string,
): Promise<TranslatedPlanRebaseOutcome | null> {
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const provenance: TranslationProvenance | null = await readTranslationProvenance(paths.episode_dir)
  if (!provenance) return null
  if (!existsSync(await resolveScenePlanPath(slug, episodeId, paths.episode_dir))) return null
  return rebaseTranslatedScenePlan({ targetSlug: slug, targetEpisodeId: episodeId })
}
