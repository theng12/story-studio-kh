import fs from 'fs/promises'
import path from 'path'
import type {
  ContextualCue,
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

export function assertContextualCueReadiness(
  config: ContextualCueProjectConfig,
  timeline: ContextualCueTimeline | null,
  plan: ScenePlan,
  subtitles?: VideoSubtitleConfig,
): ContextualCue[] {
  if (!config.enabled) return []
  const issues = validateContextualCueTimeline(timeline, plan, { subtitles, requireResolved: true })
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
