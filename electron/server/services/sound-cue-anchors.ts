/**
 * Move labels and sounds with their scenes (v1.4.365).
 *
 * The two halves of Sound & Labels both store absolute seconds, and both used
 * to trust them forever. A Scene Plan re-run moves every scene boundary, and
 * the labels and sounds stayed on the clock they were saved at — so a label
 * that named a temple at 4:12 was drawn over the market at 4:12, and the
 * owner's complaint was exactly that: cues "start at scene start +0.15 s for
 * 3.5 s, not when the word is spoken".
 *
 * One function re-derives BOTH halves against the current plan, and reports
 * every move so the page, the job log and the render notes can say what
 * changed instead of the timeline shifting under the customer silently
 * (AGENTS.md §4: "a value that changes under the customer without a word is
 * the quiet version of the same fault").
 *
 * Never trusts the reviewer's own save to keep the two halves in step: this is
 * called on READ, so no save path can certify a stale time.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import type { ContextualCue, ContextualCueTimeline, ScenePlan, SoundDesignCue, SoundDesignTimeline } from '../models/types.js'
import { readContextualCueTimeline, writeContextualCueTimeline } from './contextual-cues.js'
import { readSoundDesignTimeline, writeSoundDesignTimeline } from './sound-design.js'
import { reconcileAnchoredCues, type CueTiming } from '../contracts/cue-anchor.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { stitchedSrtPath } from './subtitle-correction.js'

export interface AnchorMoves {
  label: {
    moved: Array<{ id: string; title: string; from: number; to: number }>
    orphaned: Array<{ id: string; title: string }>
  }
  sound: {
    moved: Array<{ id: string; label: string; from: number; to: number }>
    orphaned: Array<{ id: string; label: string }>
  }
}

function emptyMoves(): AnchorMoves {
  return { label: { moved: [], orphaned: [] }, sound: { moved: [], orphaned: [] } }
}

export function hasAnchorMoves(moves: AnchorMoves): boolean {
  return moves.label.moved.length + moves.label.orphaned.length
    + moves.sound.moved.length + moves.sound.orphaned.length > 0
}

/** One plain-English line per move, for a job log or a page notice. */
export function describeAnchorMoves(moves: AnchorMoves): string[] {
  const out: string[] = []
  for (const item of moves.label.moved) out.push(`Label "${item.title}" moved ${clock(item.from)} → ${clock(item.to)} with its scene.`)
  for (const item of moves.sound.moved) out.push(`Sound "${item.label}" moved ${clock(item.from)} → ${clock(item.to)} with its scene.`)
  for (const item of moves.label.orphaned) out.push(`Label "${item.title}" belongs to a scene that is no longer in the Scene Plan; it will not be drawn until you re-place it.`)
  for (const item of moves.sound.orphaned) out.push(`Sound "${item.label}" belongs to a scene that is no longer in the Scene Plan; it will not be mixed until you re-place it.`)
  return out
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * The episode's caption timing, or `[]`.
 *
 * Read soft on purpose: an episode with no subtitles yet still has labels and
 * sounds, and a missing SRT must fall back to the scene offset rather than
 * refuse to place anything. `[]` means "no word timing known", which the
 * resolver already distinguishes from "the word is at 0".
 */
export async function readEpisodeCueTiming(stitchedSrtFile: string): Promise<CueTiming[]> {
  if (!stitchedSrtFile || !existsSync(stitchedSrtFile)) return []
  try {
    return parseSrt(await fs.readFile(stitchedSrtFile, 'utf-8'))
      .map(cue => ({ start_sec: cue.start_sec, end_sec: cue.end_sec, text: cue.text }))
  } catch {
    return []
  }
}

export interface ReanchoredSide<T> {
  timeline: T | null
  moves: Array<{ cue: any; from: number; to: number }>
  orphaned: any[]
}

/** Re-derive one episode's labels against the plan. Pure: never writes. */
export function reanchorLabels(
  timeline: ContextualCueTimeline | null,
  plan: ScenePlan,
  subtitles: readonly CueTiming[],
): ReanchoredSide<ContextualCueTimeline> {
  if (!timeline) return { timeline: null, moves: [], orphaned: [] }
  const result = reconcileAnchoredCues<ContextualCue>(timeline.cues, plan, subtitles)
  return {
    timeline: { ...timeline, cues: result.cues },
    moves: result.moved,
    orphaned: result.orphaned,
  }
}

/** Re-derive one episode's sounds against the plan. Pure: never writes. */
export function reanchorSounds(
  timeline: SoundDesignTimeline | null,
  plan: ScenePlan,
  subtitles: readonly CueTiming[],
): ReanchoredSide<SoundDesignTimeline> {
  if (!timeline) return { timeline: null, moves: [], orphaned: [] }
  const result = reconcileAnchoredCues<SoundDesignCue>(timeline.cues, plan, subtitles)
  return {
    timeline: { ...timeline, cues: result.cues },
    moves: result.moved,
    orphaned: result.orphaned,
  }
}

/**
 * Read both halves off disk, re-anchor them, and hand back the moves.
 *
 * THE unified read for anything that has to agree about what renders: Video
 * Assembly, the Production Board's Sound & Labels cell, and the page itself.
 * Both sides are derived from the same plan and the same captions in one call,
 * so they cannot disagree about where a cue sits.
 */
export async function readAnchoredEpisodeCues(
  scenePlanPath: string,
  plan: ScenePlan,
  stitchedSrtFile: string,
): Promise<{
  labels: ContextualCueTimeline | null
  sounds: SoundDesignTimeline | null
  moves: AnchorMoves
  subtitles: CueTiming[]
}> {
  const subtitles = await readEpisodeCueTiming(stitchedSrtFile)
  const labelsRaw = await readContextualCueTimeline(scenePlanPath)
  const soundsRaw = await readSoundDesignTimeline(scenePlanPath)
  const labels = reanchorLabels(labelsRaw, plan, subtitles)
  const sounds = reanchorSounds(soundsRaw, plan, subtitles)
  const moves = emptyMoves()
  moves.label.moved = labels.moves.map(item => ({ id: item.cue.id, title: item.cue.title, from: item.from, to: item.to }))
  moves.label.orphaned = labels.orphaned.map(cue => ({ id: cue.id, title: cue.title }))
  moves.sound.moved = sounds.moves.map(item => ({ id: item.cue.id, label: item.cue.label, from: item.from, to: item.to }))
  moves.sound.orphaned = sounds.orphaned.map(cue => ({ id: cue.id, label: cue.label }))
  return { labels: labels.timeline, sounds: sounds.timeline, moves, subtitles }
}

// ── A cue whose SAVED seconds sit outside its scene ────────────────────────
//
// Re-anchoring fixes most of these before anyone sees them: a cue carrying an
// anchor is re-derived from the plan on every read, so the page and the
// renderer both place it correctly. What re-anchoring CANNOT fix is a cue whose
// saved window is outside its scene and that carries no anchor at all — every
// v1 file, and a v2 cue a plan change stranded. Those are real defects in the
// output, and before this existed the only answer the app had was the
// validator's "Cue must remain inside its scene timing", which the person
// could not act on: it named no scene, no distance, and no way out, so it sat
// in needs-attention forever (EP0006, 2026-11-02).
//
// Both halves are reported here — the stale ones a Repair can snap, and the
// ones nothing can place — each with ONE plain sentence saying which scene and
// how far out, so the page can offer the person the only two honest choices:
// move it inside, or leave it off. Never a silent move (AGENTS.md §4).

export interface SceneEscape {
  cue_id: string
  title: string
  scene_id: string
  /** 1-based position in the CURRENT plan, recomputed from order. */
  scene_index: number
  /** The saved window — what is wrong. */
  start_sec: number
  end_sec: number
  scene_start_sec: number
  scene_end_sec: number
  side: 'before' | 'after' | 'both'
  /** How far outside the scene the saved window reaches, in seconds. */
  outside_by_sec: number
  /**
   * True when the cue's own anchor already resolves INSIDE this scene: the
   * saved seconds are only stale, and Repair simply writes down what every
   * read already derives. False when nothing can place it, because the cue
   * carries no anchor at all.
   */
  rescues: boolean
  /** One plain sentence: which scene, and how far out. */
  detail: string
}

function escapeDetail(
  cue: { title: string; start_sec: number; end_sec: number },
  scene: { start_sec: number; end_sec: number },
  sceneIndex: number,
  side: SceneEscape['side'],
  outside: number,
  rescues: boolean,
): string {
  const where = side === 'both'
    ? `straddles both ends of Scene ${sceneIndex} (${clock(scene.start_sec)}–${clock(scene.end_sec)})`
    : side === 'before'
      ? `starts ${outside.toFixed(1)}s before Scene ${sceneIndex} begins (${clock(scene.start_sec)}–${clock(scene.end_sec)})`
      : `runs ${outside.toFixed(1)}s past the end of Scene ${sceneIndex} (${clock(scene.start_sec)}–${clock(scene.end_sec)})`
  const ending = rescues
    ? 'Its own anchor still places it inside that scene, so Repair moves it there and nothing is lost.'
    : 'It carries no anchor, so nothing can place it — Repair moves it inside, or leave it off.'
  return `Label "${cue.title}" is saved at ${clock(cue.start_sec)}–${clock(cue.end_sec)}, which ${where}. ${ending}`
}

/**
 * Every saved label whose window sits outside the scene it names.
 *
 * Compares the SAVED seconds, not the re-anchored ones — the saved seconds are
 * what is on disk and what the renderer would be handed by any reader that
 * forgets to re-anchor, so they are the thing that has to be reported.
 */
export function findSceneEscapes(
  timeline: ContextualCueTimeline | null,
  plan: ScenePlan,
  subtitles: readonly CueTiming[] = [],
): SceneEscape[] {
  if (!timeline?.cues?.length) return []
  const sceneById = new Map(plan.scenes.map(scene => [scene.id, scene]))
  const indexById = new Map(plan.scenes.map((scene, index) => [
    scene.id,
    Number.isInteger(scene.scene_index) ? scene.scene_index! : index + 1,
  ]))
  const placed = new Map(
    reconcileAnchoredCues(timeline.cues, plan, subtitles).cues.map(cue => [cue.id, cue]),
  )
  const out: SceneEscape[] = []
  for (const cue of timeline.cues) {
    const scene = sceneById.get(cue.scene_id)
    // An orphaned cue is a different, already-reported problem (`orphaned` on
    // the read) — it has no scene to be inside of, so there is nothing here.
    if (!scene) continue
    const sceneIndex = indexById.get(cue.scene_id) || 0
    const before = scene.start_sec - 0.01
    const after = scene.end_sec + 0.01
    if (cue.start_sec >= before && cue.end_sec <= after) continue
    const startsBefore = cue.start_sec < before
    const endsAfter = cue.end_sec > after
    const side: SceneEscape['side'] = startsBefore && endsAfter ? 'both' : startsBefore ? 'before' : 'after'
    const outside = side === 'both'
      ? cue.end_sec - cue.start_sec
      : side === 'before' ? scene.start_sec - cue.start_sec : cue.end_sec - scene.end_sec
    const resolved = placed.get(cue.id)
    const rescues = !!resolved && resolved.start_sec >= before && resolved.end_sec <= after
    out.push({
      cue_id: cue.id,
      title: cue.title,
      scene_id: cue.scene_id,
      scene_index: sceneIndex,
      start_sec: cue.start_sec,
      end_sec: cue.end_sec,
      scene_start_sec: scene.start_sec,
      scene_end_sec: scene.end_sec,
      side,
      outside_by_sec: Number(outside.toFixed(3)),
      rescues,
      detail: escapeDetail(cue, scene, sceneIndex, side, outside, rescues),
    })
  }
  return out
}

/** One plain line per escape, for a job log or a page notice. */
export function describeSceneEscapes(escapes: readonly SceneEscape[]): string[] {
  return escapes.map(escape => escape.detail)
}

/**
 * Move one label inside the scene it names, keeping everything else about it.
 *
 * Uses the cue's OWN anchor first — a word still spoken in that scene lands on
 * the word — and falls back to clamping the saved window into the scene, which
 * is what has to happen for a cue carrying no anchor at all. The resulting
 * offset is written down as `anchor_offset_sec`, so the next Scene Plan
 * re-derives the snapped position instead of stranding it again.
 *
 * Returns null when the cue names a scene the plan no longer has: there is
 * nothing to move it into, and inventing a scene would be the silent repair
 * AGENTS.md §4 rules out.
 */
export function snapCueIntoScene(
  cue: ContextualCue,
  plan: ScenePlan,
  subtitles: readonly CueTiming[] = [],
): ContextualCue | null {
  const scene = plan.scenes.find(row => row.id === cue.scene_id)
  if (!scene) return null
  const resolved = reconcileAnchoredCues([cue], plan, subtitles).cues[0] ?? cue
  const span = Math.max(0, scene.end_sec - scene.start_sec)
  const duration = Math.max(0, (resolved.end_sec ?? resolved.start_sec) - resolved.start_sec)
  const wanted = Math.min(duration, span)
  // Rounded to milliseconds, like every other second this file writes: the
  // subtraction of two millisecond figures otherwise carries a tail of binary
  // noise into `anchor_offset_sec`, which is then re-read as the offset.
  const offset = Number(Math.min(Math.max(0, resolved.start_sec - scene.start_sec), Math.max(0, span - wanted)).toFixed(3))
  const start = Number((scene.start_sec + offset).toFixed(3))
  const end = Number(Math.min(scene.end_sec, start + wanted).toFixed(3))
  const snapped: ContextualCue = {
    ...resolved,
    start_sec: start,
    end_sec: Math.max(start, end),
    anchor_offset_sec: offset,
  }
  delete snapped.disabled_reason
  return snapped
}

/**
 * Turn a label off with the reason it could not be placed, in plain words.
 *
 * The times are left exactly as they were — turning something off must never
 * move it — and the reason travels with the cue so the row can say it, and so
 * the validator can treat it as a note rather than a defect (a cue that is not
 * drawn cannot be wrong in the output).
 */
export function flagCueOutsideScene(cue: ContextualCue, escape: SceneEscape): ContextualCue {
  return { ...cue, status: 'disabled', disabled_reason: escape.detail }
}

/**
 * Re-check every label and sound against a Scene Plan that just moved, and
 * say what it found.
 *
 * Called by the Scene Plan job the moment it writes a new timeline, because a
 * re-plan is the thing that strands cues: the cues keep the seconds they were
 * saved at, the scenes move under them, and until now nobody was told until
 * the Sound & Labels page was opened (AGENTS.md §4 — a value that changes
 * under the customer without a word is the quiet version of the fault).
 *
 * Nothing is written here either. Reporting is the whole job: the person
 * chooses Keep these times, Repair, or turn it off.
 */
export async function recheckCuesAfterReplan(
  scenePlanPath: string,
  plan: ScenePlan,
  stitchedSrtFile: string,
): Promise<string[]> {
  const labels = await readContextualCueTimeline(scenePlanPath)
  // Say it only when a plan really has moved under these cues since they were
  // saved. The cue timeline names the plan it believes in, so an unchanged
  // stamp means this run did not re-cut anything and the same lines would be
  // repeated on every prompt regeneration after it. Escapes that survive that
  // are still reported by Sound & Labels itself, where the person can act.
  //
  // Each timeline owns its own stamp. A current label file says nothing about
  // the sounds beside it: they may still have been saved under an earlier
  // plan, and letting the label stamp return early hid exactly that drift.
  const planStamp = typeof plan.generated_at === 'string' ? plan.generated_at : ''
  const currentForPlan = (stamp: unknown) => !!stamp && !!planStamp && stamp === planStamp
  const labelsCurrent = currentForPlan(labels?.source_scene_plan_generated_at)
  const subtitles = await readEpisodeCueTiming(stitchedSrtFile)
  const sounds = await readSoundDesignTimeline(scenePlanPath)
  const soundsCurrent = currentForPlan(sounds?.source_scene_plan_generated_at)
  const lines: string[] = []
  if (labels && !labelsCurrent) {
    const result = reconcileAnchoredCues(labels.cues, plan, subtitles)
    if (result.moved.length) {
      lines.push(
        `${result.moved.length} label(s) follow their scene into a new time: `
        + `${result.moved.slice(0, 5).map(item => `"${item.cue.title}" ${clock(item.from)} → ${clock(item.to)}`).join('; ')}`
        + `${result.moved.length > 5 ? `; and ${result.moved.length - 5} more` : ''}. `
        + 'Open Sound & Labels to keep those times, repair a label, or leave one off.',
      )
    }
    for (const escape of findSceneEscapes(labels, plan, subtitles)) lines.push(escape.detail)
  }
  if (sounds && !soundsCurrent) {
    const result = reconcileAnchoredCues(sounds.cues, plan, subtitles)
    if (result.moved.length) {
      lines.push(
        `${result.moved.length} sound cue(s) follow their scene into a new time: `
        + `${result.moved.slice(0, 5).map(item => `"${item.cue.label}" ${clock(item.from)} → ${clock(item.to)}`).join('; ')}. `
        + 'Open Sound & Labels to keep those times.',
      )
    }
  }
  return lines
}

/**
 * Write back the moves a read just made.
 *
 * Deliberately separate from the read and deliberately explicit: opening a
 * page must not write, and a render must not write. The PAGE calls this when
 * the customer has seen the notice, so the stored seconds stop disagreeing
 * with the stored anchors. It writes schema v2 and only when a cue actually
 * moved — a v1 file with nothing to move is left exactly as it is.
 */
export async function persistReanchoredLabels(
  scenePlanPath: string,
  before: ContextualCueTimeline,
  after: ContextualCueTimeline,
): Promise<void> {
  if (!after.cues.some((cue, i) => cue.start_sec !== before.cues[i]?.start_sec)) return
  await writeContextualCueTimeline(scenePlanPath, { ...after, schema_version: 2 })
}

export async function persistReanchoredSounds(
  scenePlanPath: string,
  before: SoundDesignTimeline,
  after: SoundDesignTimeline,
): Promise<void> {
  if (!after.cues.some((cue, i) => cue.start_sec !== before.cues[i]?.start_sec)) return
  await writeSoundDesignTimeline(scenePlanPath, { ...after, schema_version: 2 })
}

/**
 * Say, in a Scene Plan job log, what the new timeline did to existing cues.
 *
 * Deliberately cannot fail the job: this is a note about labels, and a Scene
 * Plan that is otherwise correct must not be refused over one. Reads the plan
 * back off disk rather than taking the caller's in-memory copy, so what is
 * reported is what the next reader will load.
 */
export async function announceCueDriftAfterReplan(
  job: { output_lines: string[] },
  planPath: string,
  subtitlesDir: string,
  episodeCode: string,
): Promise<void> {
  try {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    if (!plan?.scenes?.length) return
    for (const line of await recheckCuesAfterReplan(planPath, plan, stitchedSrtPath(subtitlesDir, episodeCode))) {
      job.output_lines.push(line)
    }
  } catch {
    // Reporting only. A missing cue file or an unreadable SRT is not a reason
    // to fail a timeline that built correctly.
  }
}
