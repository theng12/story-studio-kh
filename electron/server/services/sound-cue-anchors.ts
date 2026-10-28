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
