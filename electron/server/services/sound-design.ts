import fs from 'fs/promises'
import path from 'path'
import type {
  ScenePlan,
  SoundDesignCue,
  SoundDesignProjectConfig,
  SoundDesignSettings,
  SoundDesignTimeline,
} from '../models/types.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export const SOUND_DESIGN_FILENAME = 'sound_design.json'

export const DEFAULT_SOUND_DESIGN_CONFIG: SoundDesignProjectConfig = { enabled: false }
export const DEFAULT_SOUND_DESIGN_SETTINGS: SoundDesignSettings = {
  density: 'minimal',
  max_spots_per_minute: 3,
  default_bed_gain_db: -20,
  default_spot_gain_db: -12,
  ducking_profile: 'gentle',
}

export function normalizeSoundDesignConfig(value: unknown): SoundDesignProjectConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { enabled: raw.enabled === true }
}

export function normalizeSoundDesignSettings(value: unknown): SoundDesignSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(raw[key])
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
  }
  return {
    density: raw.density === 'balanced' || raw.density === 'rich' ? raw.density : 'minimal',
    max_spots_per_minute: Math.round(number('max_spots_per_minute', 3, 1, 12)),
    default_bed_gain_db: number('default_bed_gain_db', -20, -45, -6),
    default_spot_gain_db: number('default_spot_gain_db', -12, -35, -3),
    ducking_profile: raw.ducking_profile === 'standard' || raw.ducking_profile === 'strong' ? raw.ducking_profile : 'gentle',
  }
}

export function soundDesignPath(scenePlanPath: string): string {
  return path.join(path.dirname(scenePlanPath), SOUND_DESIGN_FILENAME)
}

export async function readSoundDesignTimeline(scenePlanPath: string): Promise<SoundDesignTimeline | null> {
  try {
    const raw = JSON.parse(await fs.readFile(soundDesignPath(scenePlanPath), 'utf8'))
    if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.cues) || !raw.cues.every(isCue)) return null
    return {
      schema_version: 1,
      generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : '',
      source_scene_plan_generated_at: typeof raw.source_scene_plan_generated_at === 'string' ? raw.source_scene_plan_generated_at : '',
      settings: normalizeSoundDesignSettings(raw.settings),
      cues: raw.cues,
    }
  } catch {
    return null
  }
}

export async function writeSoundDesignTimeline(scenePlanPath: string, timeline: SoundDesignTimeline): Promise<void> {
  await writeJsonAtomic(soundDesignPath(scenePlanPath), timeline)
}

export interface SoundDesignIssue { cue_id?: string; detail: string }

function planDuration(plan: ScenePlan): number {
  return Math.max(0, ...plan.scenes.map(scene => Number(scene.end_sec) || 0))
}

export function validateSoundDesignTimeline(
  timeline: SoundDesignTimeline | null,
  plan: ScenePlan,
  settings: SoundDesignSettings,
  options: { requireResolved?: boolean } = {},
): SoundDesignIssue[] {
  if (!timeline) return [{ detail: 'No Sound Design timeline exists. Add and approve cues before assembling.' }]
  const issues: SoundDesignIssue[] = []
  if (timeline.source_scene_plan_generated_at !== plan.generated_at) {
    issues.push({ detail: 'Sound Design is based on an older Scene Plan. Re-open it, check the timeline, and save it again.' })
  }
  const duration = planDuration(plan)
  const seen = new Set<string>()
  const approvedBeds: SoundDesignCue[] = []
  const approvedSpots: SoundDesignCue[] = []
  for (const cue of timeline.cues) {
    if (seen.has(cue.id)) issues.push({ cue_id: cue.id, detail: 'Duplicate cue ID.' })
    seen.add(cue.id)
    if (!cue.label.trim() || cue.label.length > 120) issues.push({ cue_id: cue.id, detail: 'Cue label is empty or too long.' })
    if (!Number.isFinite(cue.start_sec) || cue.start_sec < 0 || cue.start_sec >= duration) {
      issues.push({ cue_id: cue.id, detail: 'Cue start is outside the episode timeline.' })
    }
    if (!Number.isFinite(cue.gain_db) || cue.gain_db < -45 || cue.gain_db > -3) {
      issues.push({ cue_id: cue.id, detail: 'Cue gain must remain between -45 dB and -3 dB.' })
    }
    if (cue.kind === 'bed') {
      if (!Number.isFinite(cue.end_sec) || (cue.end_sec || 0) <= cue.start_sec || (cue.end_sec || 0) > duration) {
        issues.push({ cue_id: cue.id, detail: 'Ambient bed timing is invalid.' })
      }
    }
    if (cue.status !== 'proposed' && cue.status !== 'matched' && cue.status !== 'approved' && cue.status !== 'excluded') {
      issues.push({ cue_id: cue.id, detail: 'Cue has an unknown review status.' })
    } else if (options.requireResolved && (cue.status === 'proposed' || cue.status === 'matched')) {
      issues.push({ cue_id: cue.id, detail: 'Cue still needs approval or exclusion.' })
    }
    if (cue.status === 'approved') {
      if (!cue.pool_id || !cue.clip) issues.push({ cue_id: cue.id, detail: 'Approved cue needs a local-library clip.' })
      if (cue.kind === 'bed') approvedBeds.push(cue)
      else approvedSpots.push(cue)
    }
  }
  approvedBeds.sort((a, b) => a.start_sec - b.start_sec)
  for (let index = 1; index < approvedBeds.length; index++) {
    const previous = approvedBeds[index - 1]!
    const current = approvedBeds[index]!
    if (current.start_sec < (previous.end_sec || previous.start_sec)) {
      issues.push({ cue_id: current.id, detail: `Ambient bed overlaps ${previous.id}; approve one bed at a time.` })
    }
  }
  approvedSpots.sort((a, b) => a.start_sec - b.start_sec)
  for (let index = 1; index < approvedSpots.length; index++) {
    if (approvedSpots[index]!.start_sec < approvedSpots[index - 1]!.start_sec + 0.75) {
      issues.push({ cue_id: approvedSpots[index]!.id, detail: 'Spot effects need at least 0.75 seconds of clear space.' })
    }
  }
  const perMinute = new Map<number, number>()
  for (const spot of approvedSpots) {
    const minute = Math.floor(spot.start_sec / 60)
    perMinute.set(minute, (perMinute.get(minute) || 0) + 1)
  }
  for (const [minute, count] of perMinute) {
    if (count > settings.max_spots_per_minute) issues.push({ detail: `Minute ${minute + 1} has ${count} approved spots; this preset allows ${settings.max_spots_per_minute}.` })
  }
  return issues
}

export function assertSoundDesignReadiness(
  config: SoundDesignProjectConfig,
  timeline: SoundDesignTimeline | null,
  plan: ScenePlan,
): SoundDesignCue[] {
  if (!config.enabled) return []
  const issues = validateSoundDesignTimeline(timeline, plan, timeline?.settings || DEFAULT_SOUND_DESIGN_SETTINGS, { requireResolved: true })
  if (issues.length) {
    throw new Error(`Sound Design needs review: ${issues.slice(0, 5).map(issue => issue.cue_id ? `${issue.cue_id} — ${issue.detail}` : issue.detail).join('; ')} Open Sound Design, resolve every cue, then retry.`)
  }
  return timeline!.cues.filter(cue => cue.status === 'approved')
}

function isCue(value: unknown): value is SoundDesignCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as Partial<SoundDesignCue>
  return typeof cue.id === 'string' && (cue.kind === 'bed' || cue.kind === 'spot')
    && typeof cue.label === 'string' && typeof cue.start_sec === 'number'
    && typeof cue.clip === 'string' && typeof cue.status === 'string'
}
