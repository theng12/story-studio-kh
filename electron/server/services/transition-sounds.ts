import { createHash } from 'crypto'
import type { ScenePlan, SoundDesignCue, SoundDesignCredit } from '../models/types.js'
import { reanchorSounds } from './sound-cue-anchors.js'
import { DEFAULT_SOUND_DESIGN_SETTINGS } from './sound-design.js'

export interface TransitionClip {
  source: 'pool' | 'gateway'
  clip: string
  pool_id?: string
  label: string
  tags: string[]
  credit?: SoundDesignCredit
}

export interface TransitionSet {
  id: string
  name: string
  enabled: boolean
  terms: string[]
  pinned: Array<{ source: 'pool' | 'gateway'; clip: string; pool_id?: string; label: string }>
  excluded: string[]
}

export const DEFAULT_TRANSITION_SETS: TransitionSet[] = [
  { id: 'mixed', name: 'Mixed', terms: ['whoosh', 'click', 'shutter', 'strum', 'pluck', 'paper', 'pencil'], enabled: true, pinned: [], excluded: [] },
  { id: 'whooshes', name: 'Whooshes', terms: ['whoosh', 'swoosh'], enabled: true, pinned: [], excluded: [] },
  { id: 'clicks-shutters', name: 'Clicks & Shutters', terms: ['click', 'shutter'], enabled: true, pinned: [], excluded: [] },
  { id: 'strums-plucks', name: 'Strums & Plucks', terms: ['strum', 'pluck'], enabled: true, pinned: [], excluded: [] },
  { id: 'paper-pencil', name: 'Paper & Pencil', terms: ['paper', 'pencil'], enabled: true, pinned: [], excluded: [] },
]

export function transitionClipKey(clip: Pick<TransitionClip, 'source' | 'pool_id' | 'clip'>): string {
  return JSON.stringify([clip.source, clip.pool_id || '', clip.clip])
}

/** Resolve against the current library; a missing pinned item is never silently substituted. */
export function resolveTransitionSet(set: TransitionSet, library: TransitionClip[]): { clips: TransitionClip[]; missing: string[] } {
  const available = new Map(library.map(clip => [transitionClipKey(clip), clip]))
  const pinned = new Set(set.pinned.map(transitionClipKey))
  const excluded = new Set(set.excluded)
  const terms = set.terms.map(term => term.trim().toLowerCase()).filter(Boolean)
  const clips = [...available.values()].filter(clip => {
    const key = transitionClipKey(clip)
    if (excluded.has(key)) return false
    return pinned.has(key) || terms.some(term => [clip.label, ...clip.tags].some(text => text.toLowerCase().includes(term)))
  }).sort((a, b) => transitionClipKey(a).localeCompare(transitionClipKey(b)))
  return { clips, missing: set.pinned.filter(clip => !available.has(transitionClipKey(clip))).map(clip => clip.label || clip.clip) }
}

/** Deterministic per episode and shuffle value; scene anchors follow the current plan. */
export function placeTransitionSounds(plan: ScenePlan, episodeId: string, shuffle: number, clips: TransitionClip[], gainDb: number): SoundDesignCue[] {
  if (!clips.length) return []
  const ordered = [...clips].sort((a, b) => transitionClipKey(a).localeCompare(transitionClipKey(b)))
  let previous = ''
  const cues: SoundDesignCue[] = []
  for (const scene of plan.scenes.slice(1)) {
    const choices = ordered.length > 1 ? ordered.filter(clip => transitionClipKey(clip) !== previous) : ordered
    const hash = createHash('sha256').update(JSON.stringify([episodeId, shuffle, scene.id])).digest()
    const selected = choices[hash.readUInt32BE(0) % choices.length]!
    previous = transitionClipKey(selected)
    cues.push({
      id: `transition:${scene.id}`, kind: 'spot', label: selected.label, scene_id: scene.id,
      anchor_offset_sec: 0, start_sec: scene.start_sec, source: selected.source,
      ...(selected.pool_id ? { pool_id: selected.pool_id } : {}), clip: selected.clip,
      ...(selected.credit ? { credit: selected.credit } : {}), gain_db: gainDb,
      status: 'approved', created_at: '', updated_at: '',
    })
  }
  return reanchorSounds({ schema_version: 2, generated_at: '', source_scene_plan_generated_at: plan.generated_at, settings: DEFAULT_SOUND_DESIGN_SETTINGS, cues }, plan, []).timeline!.cues
}
