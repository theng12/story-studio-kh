import fs from 'fs/promises'
import path from 'path'
import type {
  ScenePlan,
  SoundDesignCredit,
  SoundDesignCue,
  SoundDesignProjectConfig,
  SoundDesignSettings,
  SoundDesignTimeline,
} from '../models/types.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export const SOUND_DESIGN_FILENAME = 'sound_design.json'

export const DEFAULT_SOUND_DESIGN_CONFIG: SoundDesignProjectConfig = { enabled: false }
export const DEFAULT_SOUND_DESIGN_SETTINGS: SoundDesignSettings = {
  max_spots_per_minute: 3,
  default_bed_gain_db: -20,
  default_spot_gain_db: -12,
  ducking_profile: 'gentle',
}

export function normalizeSoundDesignConfig(value: unknown): SoundDesignProjectConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { enabled: raw.enabled === true }
}

/**
 * `density` was normalised here until v1.4.365 and read by nothing. It is gone
 * rather than deprecated: a settings key nobody honours is a control the
 * customer sets and then wonders why nothing changed (AGENTS.md §6 — a value
 * that cannot affect anything must not look like it can). A stored v1 timeline
 * that still carries it is read fine; the key is simply not carried forward.
 */
export function normalizeSoundDesignSettings(value: unknown): SoundDesignSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(raw[key])
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
  }
  return {
    max_spots_per_minute: Math.round(number('max_spots_per_minute', 3, 1, 12)),
    default_bed_gain_db: number('default_bed_gain_db', -20, -45, -6),
    default_spot_gain_db: number('default_spot_gain_db', -12, -35, -3),
    ducking_profile: raw.ducking_profile === 'standard' || raw.ducking_profile === 'strong' ? raw.ducking_profile : 'gentle',
  }
}

export function soundDesignPath(scenePlanPath: string): string {
  return path.join(path.dirname(scenePlanPath), SOUND_DESIGN_FILENAME)
}

/** Keep only the credit facts a clip actually carries — never invented ones. */
export function normalizeSoundDesignCredit(value: unknown): SoundDesignCredit | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const licence = typeof raw.licence === 'string' ? raw.licence.trim() : ''
  if (!licence) return undefined
  const text = (key: string) => (typeof raw[key] === 'string' && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined)
  return {
    licence,
    ...(text('licence_version') ? { licence_version: text('licence_version') } : {}),
    ...(text('author') ? { author: text('author') } : {}),
    ...(text('source_url') ? { source_url: text('source_url') } : {}),
    ...(text('source') ? { source: text('source') } : {}),
    ...(text('title') ? { title: text('title') } : {}),
  }
}

function normalizeCueAnchors(cue: SoundDesignCue): SoundDesignCue {
  const word = typeof cue.anchor_word === 'string' ? cue.anchor_word.trim() : ''
  const offset = cue.anchor_offset_sec
  return {
    ...cue,
    ...(word ? { anchor_word: word } : { anchor_word: undefined }),
    ...(typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
      ? { anchor_offset_sec: offset }
      : { anchor_offset_sec: undefined }),
  } as SoundDesignCue
}

export async function readSoundDesignTimeline(scenePlanPath: string): Promise<SoundDesignTimeline | null> {
  try {
    const raw = JSON.parse(await fs.readFile(soundDesignPath(scenePlanPath), 'utf8'))
    // v1 and v2 both read (v1.4.365). A v1 cue has no `scene_id` and no anchor,
    // and keeps the seconds it was saved with — nothing rewrites the file.
    if (!raw || (raw.schema_version !== 1 && raw.schema_version !== 2) || !Array.isArray(raw.cues) || !raw.cues.every(isCue)) return null
    return {
      schema_version: raw.schema_version,
      generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : '',
      source_scene_plan_generated_at: typeof raw.source_scene_plan_generated_at === 'string' ? raw.source_scene_plan_generated_at : '',
      settings: normalizeSoundDesignSettings(raw.settings),
      cues: raw.cues.map((cue: SoundDesignCue) => normalizeCueAnchors(cue)),
    }
  } catch {
    return null
  }
}

export async function writeSoundDesignTimeline(scenePlanPath: string, timeline: SoundDesignTimeline): Promise<void> {
  await writeJsonAtomic(soundDesignPath(scenePlanPath), timeline)
}

export interface SoundDesignIssue {
  cue_id?: string
  detail: string
  /** `'warning'` never blocks; anything without one is an error. See resolveRenderableSoundCues. */
  severity?: 'error' | 'warning'
}

/**
 * The episode's measured length, or `null` when the Scene Plan cannot supply one.
 *
 * v1.4.198 — this used to be `Math.max(0, ...plan.scenes.map(scene => Number(scene.end_sec) || 0))`,
 * which returns 0 for a plan with no scenes and for one whose timings were never
 * measured. That 0 was then used as an authority: every cue satisfies
 * `start_sec >= 0`, so a perfectly good timeline was rejected with "Cue start is
 * outside the episode timeline" — a message that names the cue as the problem
 * when the plan is. AGENTS.md §6: "no duration could be determined" and "the
 * duration is zero" must not be the same value.
 */
export function planDuration(plan: ScenePlan): number | null {
  const ends = (plan.scenes || [])
    .map(scene => Number(scene.end_sec))
    .filter(end => Number.isFinite(end) && end > 0)
  return ends.length ? Math.max(...ends) : null
}

export function validateSoundDesignTimeline(
  timeline: SoundDesignTimeline | null,
  plan: ScenePlan,
  settings: SoundDesignSettings,
  options: { requireResolved?: boolean } = {},
): SoundDesignIssue[] {
  // Same ruling as Contextual Cues: Sound Design is optional, and an episode
  // where no cue was ever added has nothing for a reviewer to approve or
  // exclude. Treating that emptiness as a validation failure made an optional
  // feature block Final Video the moment the project setting was switched on.
  // A timeline that exists with unresolved cues still reports below.
  if (!timeline) return []
  const issues: SoundDesignIssue[] = []
  // RE-TIMED TIMES ARE NOT A DEFECT (v1.4.365). This used to be an ERROR
  // whenever the plan's `generated_at` moved, so every Scene Plan re-run left
  // the whole sound timeline unsaveable — 422 on every edit, with no way to
  // clear it but re-adding every cue by hand. A cue that carries a scene +
  // word anchor now follows its scene and this line has nothing to say. A v1
  // cue has no anchor, which is a genuine "these times are from an older plan"
  // signal, and it is a WARNING: it tells the reviewer to check the row, not
  // refuse to store their edit. See services/sound-design-reanchor.ts.
  if (timeline.source_scene_plan_generated_at !== plan.generated_at) {
    const unanchored = timeline.cues.filter(cue => !cue.scene_id && cue.status !== 'excluded')
    if (unanchored.length) {
      issues.push({
        severity: 'warning',
        detail: `${unanchored.length} cue${unanchored.length === 1 ? ' was' : 's were'} placed before this Scene Plan was rebuilt and ${unanchored.length === 1 ? 'has' : 'have'} no scene anchor. Check ${unanchored.length === 1 ? 'it' : 'them'} against the new timing; anything anchored follows its scene automatically.`,
      })
    }
  }
  const duration = planDuration(plan)
  if (duration === null) {
    // Say which thing is missing. Silently skipping the length checks would let
    // an out-of-range cue through; blaming the cue would be a lie.
    issues.push({ detail: 'Scene Plan has no measured scene timings, so Sound Design cues cannot be checked against the episode length. Re-run Scene Plan.' })
  }
  const seen = new Set<string>()
  const approvedBeds: SoundDesignCue[] = []
  const approvedSpots: SoundDesignCue[] = []
  for (const cue of timeline.cues) {
    if (seen.has(cue.id)) issues.push({ cue_id: cue.id, detail: 'Duplicate cue ID.' })
    seen.add(cue.id)
    // An EXCLUDED cue is a decision already made, and every rule below is a
    // reason to refuse to DRAW it. Applying them to a cue nobody will hear
    // made its row impossible to save and impossible to remove (#v1.4.365):
    // the 422 named a cue the customer had already turned off.
    const excluded = cue.status === 'excluded'
    if (!excluded) {
      if (!cue.label.trim() || cue.label.length > 120) issues.push({ cue_id: cue.id, severity: 'warning', detail: 'Cue label is empty or too long.' })
      if (!Number.isFinite(cue.start_sec) || cue.start_sec < 0 || (duration !== null && cue.start_sec >= duration)) {
        issues.push({ cue_id: cue.id, severity: 'warning', detail: 'Cue start is outside the episode timeline, so it will not be mixed.' })
      }
      if (!Number.isFinite(cue.gain_db) || cue.gain_db < -45 || cue.gain_db > -3) {
        issues.push({ cue_id: cue.id, severity: 'warning', detail: 'Cue gain is outside the -45 dB to -3 dB range, so it will not be mixed.' })
      }
      if (cue.kind === 'bed') {
        if (!Number.isFinite(cue.end_sec) || (cue.end_sec || 0) <= cue.start_sec || (duration !== null && (cue.end_sec || 0) > duration)) {
          issues.push({ cue_id: cue.id, severity: 'warning', detail: 'Ambient bed timing is invalid, so it will not be mixed.' })
        }
      }
    }
    if (cue.status !== 'proposed' && cue.status !== 'matched' && cue.status !== 'approved' && cue.status !== 'excluded') {
      issues.push({ cue_id: cue.id, detail: 'Cue has an unknown review status.' })
    } else if (options.requireResolved && (cue.status === 'proposed' || cue.status === 'matched')) {
      // Still a note, never a refusal: see `resolveRenderableSoundCues`.
      issues.push({ cue_id: cue.id, severity: 'warning', detail: 'Cue still needs approval or exclusion, so it will not be mixed.' })
    }
    if (cue.status === 'approved') {
      if (!cue.clip || (cue.source !== 'gateway' && !cue.pool_id)) {
        issues.push({ cue_id: cue.id, severity: 'warning', detail: 'Approved cue needs a sound chosen for it, so it will not be mixed.' })
      }
      if (cue.kind === 'bed') approvedBeds.push(cue)
      else approvedSpots.push(cue)
    }
  }
  approvedBeds.sort((a, b) => a.start_sec - b.start_sec)
  for (let index = 1; index < approvedBeds.length; index++) {
    const previous = approvedBeds[index - 1]!
    const current = approvedBeds[index]!
    if (current.start_sec < (previous.end_sec || previous.start_sec)) {
      // Two ambient beds at once is a mixing defect, not a taste call.
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
    if (count > settings.max_spots_per_minute) {
      // A pacing CEILING the reviewer chose. Over it, the extras are dropped
      // from the mix and said so; refusing the whole render over a number the
      // same page lets you raise would be the app second-guessing its editor.
      issues.push({ severity: 'warning', detail: `Minute ${minute + 1} has ${count} approved spots; this preset allows ${settings.max_spots_per_minute}. Only the first ${settings.max_spots_per_minute} will be mixed.` })
    }
  }
  return issues
}

/**
 * What the mixer will actually receive, and what to say about the rest.
 *
 * v1.4.365 — same ruling as `resolveRenderableContextualCues`: Sound is an
 * OPTIONAL layer. A missing or unapproved cue is SILENCE plus a stated note,
 * never a refused render. The owner's words: "a missing sound = silence and a
 * stated note; nothing optional ever blocks Video Assembly."
 *
 * Only two things still refuse, because they are defects rather than pending
 * decisions: two approved ambient beds overlapping in time, and approved spots
 * crowded inside each other's 0.75s. Both would produce an audibly broken mix.
 */
export interface RenderableSoundCues {
  cues: SoundDesignCue[]
  skipped: SoundDesignIssue[]
}

export function resolveRenderableSoundCues(
  config: SoundDesignProjectConfig,
  timeline: SoundDesignTimeline | null,
  plan: ScenePlan,
): RenderableSoundCues {
  if (!config.enabled) return { cues: [], skipped: [] }
  if (!timeline) return { cues: [], skipped: [] }
  const settings = timeline.settings || DEFAULT_SOUND_DESIGN_SETTINGS
  const issues = validateSoundDesignTimeline(timeline, plan, settings, { requireResolved: true })
  const byCue = new Map<string, SoundDesignIssue[]>()
  for (const issue of issues) {
    if (!issue.cue_id) continue
    byCue.set(issue.cue_id, [...(byCue.get(issue.cue_id) || []), issue])
  }
  const hard = issues.filter(issue => !issue.cue_id && issue.severity !== 'warning')
  if (hard.length) {
    throw new Error(`Sound cannot be mixed: ${hard.map(issue => issue.detail).join('; ')} Open Sound & Labels and fix the cues marked.`)
  }
  const cues: SoundDesignCue[] = []
  const skipped: SoundDesignIssue[] = []
  const approved: SoundDesignCue[] = []
  for (const cue of timeline.cues) {
    if (cue.status !== 'approved') {
      skipped.push({
        cue_id: cue.id,
        severity: 'warning',
        detail: cue.status === 'excluded' ? 'turned off in review, so it is not mixed.' : 'still awaiting review, so it is not mixed.',
      })
      continue
    }
    const mine = (byCue.get(cue.id) || []).filter(issue => issue.severity !== 'warning')
    if (mine.length) {
      for (const issue of mine) skipped.push({ cue_id: cue.id, severity: 'warning', detail: issue.detail })
      continue
    }
    // Warnings that mean "this one produces no sound" ride along as notes.
    for (const issue of byCue.get(cue.id) || []) {
      if (issue.severity === 'warning' && /will not be mixed|needs a sound/.test(issue.detail)) {
        skipped.push({ cue_id: cue.id, severity: 'warning', detail: issue.detail })
      }
    }
    approved.push(cue)
  }
  // The pacing ceiling and the one-bed-at-a-time rule decide which approved
  // cues go in, in time order, exactly as the validator describes them.
  const beds = approved.filter(cue => cue.kind === 'bed').sort((a, b) => a.start_sec - b.start_sec)
  const spots = approved.filter(cue => cue.kind === 'spot').sort((a, b) => a.start_sec - b.start_sec)
  let bedEnd = -Infinity
  for (const bed of beds) {
    if (bed.start_sec < bedEnd) {
      skipped.push({ cue_id: bed.id, severity: 'warning', detail: 'overlaps another approved ambient bed, so it is not mixed.' })
      continue
    }
    bedEnd = Math.max(bedEnd, bed.end_sec || bed.start_sec)
    cues.push(bed)
  }
  const perMinute = new Map<number, number>()
  let lastSpot = -Infinity
  for (const spot of spots) {
    const minute = Math.floor(spot.start_sec / 60)
    const count = perMinute.get(minute) || 0
    if (count >= settings.max_spots_per_minute) {
      skipped.push({ cue_id: spot.id, severity: 'warning', detail: `over the ${settings.max_spots_per_minute}-per-minute spot limit, so it is not mixed.` })
      continue
    }
    if (spot.start_sec < lastSpot + 0.75) {
      skipped.push({ cue_id: spot.id, severity: 'warning', detail: 'too close to the spot before it, so it is not mixed.' })
      continue
    }
    perMinute.set(minute, count + 1)
    lastSpot = spot.start_sec
    cues.push(spot)
  }
  return { cues, skipped }
}

/** Kept for callers that only need the cue list; never throws for an editorial gap. */
export function assertSoundDesignReadiness(
  config: SoundDesignProjectConfig,
  timeline: SoundDesignTimeline | null,
  plan: ScenePlan,
): SoundDesignCue[] {
  return resolveRenderableSoundCues(config, timeline, plan).cues
}

function isCue(value: unknown): value is SoundDesignCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as Partial<SoundDesignCue>
  return typeof cue.id === 'string' && (cue.kind === 'bed' || cue.kind === 'spot')
    && typeof cue.label === 'string' && typeof cue.start_sec === 'number'
    && typeof cue.clip === 'string' && typeof cue.status === 'string'
}
