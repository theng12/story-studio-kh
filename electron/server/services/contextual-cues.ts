import fs from 'fs/promises'
import path from 'path'
import type {
  ContextualCue,
  ContextualCueAutoApprovalHold,
  ContextualCuePlacement,
  ContextualCueProposalSettings,
  ContextualCueProjectConfig,
  ContextualCueTimeline,
  ContextualCueTemplate,
  ScenePlan,
  VideoSubtitleConfig,
} from '../models/types.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

export const CONTEXTUAL_CUES_FILENAME = 'contextual_cues.json'
export const DEFAULT_CONTEXTUAL_CUE_CONFIG: ContextualCueProjectConfig = {
  enabled: false,
  auto_approve_cues: false,
}

export const DEFAULT_CONTEXTUAL_CUE_PROPOSAL_SETTINGS: ContextualCueProposalSettings = {
  model: '',
  density: 'restrained',
  placement: 'top-right',
  auto_approve: false,
}

export function normalizeContextualCueConfig(value: unknown): ContextualCueProjectConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: raw.enabled === true,
    // Default OFF — see ContextualCueProjectConfig.auto_approve_cues.
    auto_approve_cues: raw.auto_approve_cues === true,
  }
}

/** Keep user-facing proposal controls independent from old project config. */
export function normalizeContextualCueProposalSettings(value: unknown): ContextualCueProposalSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    density: raw.density === 'standard' || raw.density === 'editorial' ? raw.density : 'restrained',
    // Cue defaults intentionally use only subtitle-safe top corners.
    placement: raw.placement === 'top-left' ? 'top-left' : 'top-right',
    auto_approve: raw.auto_approve === true,
  }
}

export function contextualCuePath(scenePlanPath: string): string {
  return path.join(path.dirname(scenePlanPath), CONTEXTUAL_CUES_FILENAME)
}

export async function readContextualCueTimeline(scenePlanPath: string): Promise<ContextualCueTimeline | null> {
  try {
    const raw = JSON.parse(await fs.readFile(contextualCuePath(scenePlanPath), 'utf8'))
    if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.cues)) return null
    return {
      schema_version: 1,
      generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : '',
      source_scene_plan_generated_at: typeof raw.source_scene_plan_generated_at === 'string' ? raw.source_scene_plan_generated_at : '',
      cues: raw.cues.filter(isCue),
    }
  } catch {
    return null
  }
}

export async function writeContextualCueTimeline(scenePlanPath: string, timeline: ContextualCueTimeline): Promise<void> {
  await writeJsonAtomic(contextualCuePath(scenePlanPath), timeline)
}

export interface ContextualCueIssue {
  cue_id?: string
  detail: string
}

export function normalizeContextualCueTemplate(value: unknown): ContextualCueTemplate {
  return value === 'map-pin' || value === 'archival-caption' || value === 'chapter-plate'
    ? value
    : 'documentary-label'
}

export function validateContextualCueTimeline(
  timeline: ContextualCueTimeline | null,
  plan: ScenePlan,
  options: { subtitles?: VideoSubtitleConfig; requireResolved?: boolean } = {},
): ContextualCueIssue[] {
  if (!timeline) return [{ detail: 'No contextual cue timeline exists. Generate and review cues before assembling.' }]
  const issues: ContextualCueIssue[] = []
  const seen = new Set<string>()
  const approved = timeline.cues.filter(cue => cue.status === 'approved').sort((a, b) => a.start_sec - b.start_sec)
  const byId = new Map(plan.scenes.map(scene => [scene.id, scene]))
  for (const cue of timeline.cues) {
    if (seen.has(cue.id)) issues.push({ cue_id: cue.id, detail: 'Duplicate cue ID.' })
    seen.add(cue.id)
    if (options.requireResolved && cue.status === 'proposed') issues.push({ cue_id: cue.id, detail: 'Cue still needs review.' })
    const scene = byId.get(cue.scene_id)
    if (!scene) { issues.push({ cue_id: cue.id, detail: 'Referenced Scene Plan scene no longer exists.' }); continue }
    if (!Number.isFinite(cue.start_sec) || !Number.isFinite(cue.end_sec) || cue.end_sec <= cue.start_sec) {
      issues.push({ cue_id: cue.id, detail: 'Cue timing is invalid.' }); continue
    }
    if (cue.start_sec < scene.start_sec - 0.01 || cue.end_sec > scene.end_sec + 0.01) {
      issues.push({ cue_id: cue.id, detail: 'Cue must remain inside its scene timing.' })
    }
    const duration = cue.end_sec - cue.start_sec
    if (duration < 2.25 || duration > 4.5) issues.push({ cue_id: cue.id, detail: 'Cue must remain readable for 2.25–4.5 seconds.' })
    if (!cue.title.trim() || cue.title.length > 80 || (cue.subtitle?.length || 0) > 100) {
      issues.push({ cue_id: cue.id, detail: 'Cue text is empty or too long for a restrained on-screen label.' })
    }
    if (normalizeContextualCueTemplate(cue.template) !== cue.template) {
      issues.push({ cue_id: cue.id, detail: 'Cue treatment is invalid.' })
    }
    if (!isPlacement(cue.placement)) issues.push({ cue_id: cue.id, detail: 'Cue placement is invalid.' })
    if (options.subtitles?.enabled && cue.placement.startsWith('bottom-')) {
      issues.push({ cue_id: cue.id, detail: 'Bottom-corner cues conflict with enabled subtitles. Use a top corner.' })
    }
  }
  for (let index = 1; index < approved.length; index++) {
    const previous = approved[index - 1]!
    const current = approved[index]!
    if (current.start_sec < previous.end_sec + 0.5) {
      issues.push({ cue_id: current.id, detail: `Cue overlaps or crowds ${previous.id}; keep at least 0.5s clear between approved cues.` })
    }
  }
  return issues
}

/**
 * Approve every candidate that clears the exact structural rules a human
 * reviewer is held to by `validateContextualCueTimeline` — never a looser
 * check. A candidate is evaluated in start_sec order against cues already
 * accepted (prior approvals from earlier runs, then ones accepted earlier
 * in this same pass), which is the same order a human approving cues one at
 * a time would hit the 0.5s crowding rule in. Anything that fails stays
 * `proposed` (never silently dropped) and is recorded in `holds` with the
 * validator's own detail string(s), so the caller can show exactly why the
 * machine declined it.
 *
 * Only called when a project has opted into `config.auto_approve_cues`; see
 * `assertContextualCueReadiness` for the one other place auto mode changes
 * behavior (it stops requiring every cue to be resolved before rendering,
 * since a held-back cue can never become 'approved' on its own).
 */
export function autoApproveEligibleCues(
  candidates: ContextualCue[],
  priorCues: ContextualCue[],
  plan: ScenePlan,
  subtitles?: VideoSubtitleConfig,
): { cues: ContextualCue[]; approvedCount: number; holds: ContextualCueAutoApprovalHold[] } {
  const runningApproved = priorCues.filter(cue => cue.status === 'approved').slice()
  const otherPrior = priorCues.filter(cue => cue.status !== 'approved')
  const holds: ContextualCueAutoApprovalHold[] = []
  const decided = new Map<string, ContextualCue>()
  for (const cue of [...candidates].sort((a, b) => a.start_sec - b.start_sec)) {
    const trialCue: ContextualCue = { ...cue, status: 'approved' }
    const trial: ContextualCueTimeline = {
      schema_version: 1,
      generated_at: '',
      source_scene_plan_generated_at: plan.generated_at,
      cues: [...otherPrior, ...runningApproved, trialCue],
    }
    const issues = validateContextualCueTimeline(trial, plan, { subtitles }).filter(issue => issue.cue_id === cue.id)
    if (issues.length) {
      holds.push({ cue_id: cue.id, reasons: issues.map(issue => issue.detail) })
      decided.set(cue.id, cue)
    } else {
      runningApproved.push(trialCue)
      decided.set(cue.id, trialCue)
    }
  }
  // Preserve the caller's original ordering rather than the start_sec sort
  // used above only to make the crowding check deterministic.
  const cues = candidates.map(cue => decided.get(cue.id) || cue)
  return { cues, approvedCount: candidates.length - holds.length, holds }
}

export function assertContextualCueReadiness(
  config: ContextualCueProjectConfig,
  timeline: ContextualCueTimeline | null,
  plan: ScenePlan,
  subtitles?: VideoSubtitleConfig,
): ContextualCue[] {
  if (!config.enabled) return []
  // Manual review requires every cue resolved (approved or disabled) before
  // Video Assembly. Once a project trusts `auto_approve_cues`, a cue held
  // back by the automatic pass can never resolve itself — requiring
  // resolution here would just re-introduce the manual review this setting
  // exists to remove. Every other structural rule below still applies
  // unconditionally; only this one check differs between the two modes.
  const issues = validateContextualCueTimeline(timeline, plan, { subtitles, requireResolved: !config.auto_approve_cues })
  if (issues.length) {
    throw new Error(`Contextual Cues need review: ${issues.slice(0, 5).map(issue => issue.cue_id ? `${issue.cue_id} — ${issue.detail}` : issue.detail).join('; ')} Open Contextual Cues, resolve every proposal, then retry.`)
  }
  return timeline!.cues.filter(cue => cue.status === 'approved')
}

function isPlacement(value: unknown): value is ContextualCuePlacement {
  return value === 'top-left' || value === 'top-right' || value === 'bottom-left' || value === 'bottom-right'
}

function isCue(value: unknown): value is ContextualCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as Partial<ContextualCue>
  return typeof cue.id === 'string' && typeof cue.scene_id === 'string'
    && typeof cue.start_sec === 'number' && typeof cue.end_sec === 'number'
    && typeof cue.title === 'string' && typeof cue.status === 'string'
}
