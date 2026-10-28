/**
 * Where a cue sits in TIME (v1.4.365, Sound & Labels).
 *
 * A contextual label and a sound cue are both authored against a MOMENT in the
 * episode: a thing the narrator says. Until this file existed both stored only
 * absolute seconds, so re-running Scene Plan moved every scene and left every
 * label and every sound attached to whatever now happened at that clock time.
 * The owner's report was blunt: cues "start at scene start +0.15 s for 3.5 s,
 * not when the word is spoken", and a re-plan silently re-times them.
 *
 * So a cue now carries an ANCHOR — its scene, plus the words spoken as it
 * appears — and its absolute seconds are DERIVED from that anchor every time
 * they are needed. Stored seconds remain, because v1 readers still need them
 * and a v1 file must render unchanged, but they are never the authority for a
 * v2 cue.
 *
 * Deliberately small and self-contained: it takes the plan and the subtitle
 * cues as plain data, so the same function answers for the renderer, the
 * Production Board and the review page — the page shows what the backend
 * re-anchored, never its own second opinion. (It borrows only the spoken-length
 * measure `script-timed-cues.ts` already uses for captions; the arithmetic is
 * proportional inside one subtitle cue and holds no wall clock of its own.)
 */

import { spokenWeight } from '../lib/script-timed-cues.js'

/** One subtitle cue on the merged-audio clock. Structurally `SrtCue`. */
export interface CueTiming {
  start_sec: number
  end_sec: number
  text: string
}

/** What a cue must carry to be placed in time. */
export interface CueAnchorInput {
  /** The Scene Plan scene this cue belongs to. Absent on v1 sound cues. */
  scene_id?: string
  /** A short phrase the narration speaks as the cue appears. */
  anchor_word?: string
  /** Fallback: seconds into the scene, used when no word is anchored. */
  anchor_offset_sec?: number
}

/** A scene as the resolvers need it — never the whole `ScenePlanEntry`. */
export interface AnchorScene {
  id: string
  start_sec: number
  end_sec: number
}

export type AnchorSource = 'word' | 'scene-offset' | 'scene-start'

export interface AnchorResolution {
  start_sec: number
  /** Which rule placed it. `word` is the only one that follows the narration. */
  source: AnchorSource
  /** Set when the anchor named a scene that no longer exists. */
  missing_scene?: boolean
  /**
   * True when the cue carried NO anchor at all — every v1 file, and a v2 cue
   * whose anchor was deliberately cleared.
   *
   * Such a cue keeps the seconds it was saved with. Re-anchoring it to
   * `scene.start_sec` would move every label in every existing episode to the
   * top of its scene the first time the plan was rebuilt, which is rewriting
   * stored data to compensate for a change of shape (AGENTS.md §5, trap 2) —
   * and it would look exactly like the defect this feature exists to fix.
   */
  unanchored?: boolean
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Where inside one subtitle cue a phrase starts, as a 0..1 share of that cue's
 * spoken duration.
 *
 * The SRT is the only timing we hold, so this is the same proportional model
 * `lib/script-timed-cues.ts` uses inside a span, applied one level finer: the
 * words BEFORE the phrase weigh against the whole cue. Returns 0 when the
 * phrase starts the cue (the common case — a label names the thing being said).
 */
function shareWithinCue(cueText: string, phrase: string): number {
  const text = normalizeText(cueText)
  const at = text.indexOf(phrase)
  if (at <= 0) return 0
  const total = spokenWeight(text)
  if (!total) return 0
  return Math.min(1, spokenWeight(text.slice(0, at)) / total)
}

/**
 * The start second an anchor resolves to.
 *
 * Order: the spoken word inside this scene's own subtitle cues, then the
 * reviewer's offset into the scene, then the scene's own start. Each fallback
 * is reported by `source` so a caller can say which one it used rather than
 * pretending an estimate is a measurement (AGENTS.md §6).
 */
export function resolveAnchoredStart(
  anchor: CueAnchorInput,
  scene: AnchorScene | undefined,
  subtitles: readonly CueTiming[] = [],
): AnchorResolution {
  if (!scene) return { start_sec: 0, source: 'scene-start', missing_scene: true }
  const phrase = normalizeText(anchor.anchor_word || '')
  if (phrase) {
    // Only this scene's cues: the same words recur across an episode, and a
    // match in the next scene would silently drag the cue out of the scene the
    // reviewer placed it in.
    const scoped = subtitles
      .filter(cue => cue.end_sec > scene.start_sec && cue.start_sec < scene.end_sec)
      .sort((a, b) => a.start_sec - b.start_sec)
    for (const cue of scoped) {
      const share = shareWithinCue(cue.text, phrase)
      if (!normalizeText(cue.text).includes(phrase)) continue
      const start = cue.start_sec + (cue.end_sec - cue.start_sec) * share
      return { start_sec: round(start), source: 'word' }
    }
  }
  const offset = Number(anchor.anchor_offset_sec)
  if (anchor.anchor_offset_sec !== undefined && anchor.anchor_offset_sec !== null && Number.isFinite(offset)) {
    const span = Math.max(0, scene.end_sec - scene.start_sec)
    return { start_sec: round(scene.start_sec + Math.min(Math.max(0, offset), span)), source: 'scene-offset' }
  }
  return { start_sec: round(scene.start_sec), source: 'scene-start', unanchored: true }
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

/** The fields any timed, anchored cue must expose to be reconciled. */
export interface AnchoredCue extends CueAnchorInput {
  id: string
  start_sec: number
  /** A spot effect has no end; a bed and a label do. */
  end_sec?: number
}

export interface ReconcileResult<T> {
  cues: T[]
  /** Cues whose stored seconds disagreed with their anchor. */
  moved: Array<{ cue: T; from: number; to: number }>
  /** Cues whose scene is gone from the plan. Kept, never dropped. */
  orphaned: T[]
}

/**
 * Re-derive every cue's window from its anchor against the CURRENT plan.
 *
 * A cue's reviewed LENGTH is kept — that is an editorial decision the reviewer
 * made (`end - start`) — and only its start moves. A cue is never dropped and
 * never silently re-timed: whoever calls this gets the moves back so the page,
 * the job log and the render notes can say what changed.
 *
 * Clamped to its scene, because a cue that outlasts the scene it belongs to
 * would otherwise overlap the next one's images.
 */
export function reconcileAnchoredCues<T extends AnchoredCue>(
  cues: readonly T[],
  plan: { scenes: readonly AnchorScene[] },
  subtitles: readonly CueTiming[] = [],
): ReconcileResult<T> {
  const byId = new Map(plan.scenes.map(scene => [scene.id, scene]))
  const moved: Array<{ cue: T; from: number; to: number }> = []
  const orphaned: T[] = []
  const out = cues.map(cue => {
    if (!cue.scene_id) return cue
    const scene = byId.get(cue.scene_id)
    if (!scene) {
      orphaned.push(cue)
      return cue
    }
    const resolved = resolveAnchoredStart(cue, scene, subtitles)
    // No anchor means no opinion: the cue keeps exactly what it was saved with.
    if (resolved.unanchored) return cue
    const duration = Math.max(0, (cue.end_sec ?? cue.start_sec) - cue.start_sec)
    const start = Math.min(Math.max(resolved.start_sec, scene.start_sec), Math.max(scene.start_sec, scene.end_sec - Math.min(duration, scene.end_sec - scene.start_sec)))
    const end = round(start + Math.min(duration, scene.end_sec - start))
    if (Math.abs(start - cue.start_sec) < 0.0005
      && (cue.end_sec === undefined || Math.abs(end - cue.end_sec) < 0.0005)) return cue
    moved.push({ cue, from: cue.start_sec, to: start })
    return { ...cue, start_sec: round(start), end_sec: end }
  })
  return { cues: out, moved, orphaned }
}

/**
 * The anchor phrase for a window of narration, for a proposal to stamp.
 *
 * A short run of words from `text` that starts where the cue should appear.
 * Kept short on purpose: the anchor has to be findable in a subtitle cue
 * verbatim, and a long phrase is one normalisation away from never matching.
 */
export function anchorPhraseAt(text: string, maxWords = 4): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  if (!words.length) return ''
  return words.slice(0, Math.max(1, maxWords)).join(' ').replace(/[^\p{L}\p{N} ]/gu, '').trim()
}
