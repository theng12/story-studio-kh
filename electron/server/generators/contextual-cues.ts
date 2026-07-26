/**
 * Contextual Cues proposal job.
 *
 * This is intentionally a small number of structured GenStudio requests, not
 * one request per scene. It writes only proposed editorial data; rendering is
 * handled later by Video Assembly after a person resolves every proposal.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { callAi, sanitizeJsonControlChars } from '../lib/ai-client.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { getConfig } from '../services/project-manager.js'
import { isCancelled } from '../services/job-queue.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  normalizeContextualCueConfig,
  readContextualCueTimeline,
  normalizeContextualCueProposalSettings,
  normalizeContextualCueTemplate,
  validateContextualCueTimeline,
  writeContextualCueTimeline,
} from '../services/contextual-cues.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type { ContextualCue, ContextualCueKind, ContextualCueTemplate, Job, ScenePlan } from '../models/types.js'

interface CueCandidate {
  scene_id: string
  title: string
  subtitle?: string
  kind?: ContextualCueKind
  template?: ContextualCueTemplate
  anchor_offset_sec?: number
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

function parseCandidates(raw: string): CueCandidate[] {
  const object = JSON.parse(sanitizeJsonControlChars(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')))
  if (!object || !Array.isArray(object.cues)) throw new Error('GenStudio returned no contextual cue list.')
  return object.cues.filter((cue: any): cue is CueCandidate => (
    cue && typeof cue.scene_id === 'string' && typeof cue.title === 'string'
  ))
}

function safeCandidate(
  candidate: CueCandidate,
  plan: ScenePlan,
  density: 'restrained' | 'standard' | 'editorial',
  placement: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
  now: string,
): ContextualCue | null {
  const scene = plan.scenes.find(row => row.id === candidate.scene_id)
  if (!scene) return null
  const title = candidate.title.trim().replace(/\s+/g, ' ').slice(0, 80)
  const subtitle = candidate.subtitle?.trim().replace(/\s+/g, ' ').slice(0, 100) || undefined
  if (!title) return null
  const sceneDuration = scene.end_sec - scene.start_sec
  if (sceneDuration < 2.25) return null
  const dwell = Math.min(density === 'editorial' ? 4 : 3.5, 4.5, sceneDuration)
  const offset = Math.max(0, Math.min(sceneDuration - dwell, Number(candidate.anchor_offset_sec) || 0.15))
  const start = Number((scene.start_sec + offset).toFixed(3))
  const end = Number((start + dwell).toFixed(3))
  const kind: ContextualCueKind = candidate.kind === 'location_date' || candidate.kind === 'person' || candidate.kind === 'chapter'
    ? candidate.kind : 'historical_context'
  // The model may propose a treatment, but a missing or invalid answer gets a
  // predictable editorial default. Every choice remains proposed until a
  // human reviews it in the Contextual Cues workspace.
  const inferredTemplate: ContextualCueTemplate = kind === 'location_date'
    ? 'map-pin'
    : kind === 'chapter'
      ? 'chapter-plate'
      : kind === 'person' ? 'archival-caption' : 'documentary-label'
  const template = candidate.template
    ? normalizeContextualCueTemplate(candidate.template)
    : inferredTemplate
  return {
    id: `cue-${scene.id}`,
    scene_id: scene.id,
    start_sec: start,
    end_sec: end,
    title,
    ...(subtitle ? { subtitle } : {}),
    kind,
    placement,
    template,
    entrance: 'fade',
    exit: 'dissolve',
    status: 'proposed',
    created_at: now,
    updated_at: now,
  }
}

/** Keep a conservative, non-overlapping proposal set before it reaches review. */
function applySafePacing(cues: ContextualCue[], density: 'restrained' | 'standard' | 'editorial', totalDuration: number): ContextualCue[] {
  const minGap = density === 'editorial' ? 1 : density === 'standard' ? 2.5 : 5
  const targetSpacing = density === 'editorial' ? 35 : density === 'standard' ? 60 : 90
  const maximum = Math.max(1, Math.ceil(totalDuration / targetSpacing))
  const out: ContextualCue[] = []
  for (const cue of cues.sort((a, b) => a.start_sec - b.start_sec)) {
    if (out.length >= maximum) break
    const previous = out[out.length - 1]
    if (previous && cue.start_sec < previous.end_sec + minGap) continue
    out.push(cue)
  }
  return out
}

export async function generateContextualCues(job: Job): Promise<void> {
  const episodeId = job.episode_id
  if (!episodeId) throw new Error('Contextual Cues needs an episode.')
  const paths = await resolveEpisodePathsByCodeWithSidecar(job.project_slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('Build Scene Plan before proposing contextual cues.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  if (!plan.scenes?.length) throw new Error('Scene Plan has no scenes to annotate.')
  const config = normalizeContextualCueConfig((await getConfig(job.project_slug))?.contextual_cues)
  if (!config.enabled) throw new Error('Contextual Cues are disabled for this project. Enable them first.')
  const settings = normalizeContextualCueProposalSettings(job.params)
  const model = settings.model
  if (!model) throw new Error('Choose a live GenStudio model in Contextual Cues before proposing cues.')

  const prior = await readContextualCueTimeline(planPath)
  const protectedCues = prior?.cues.filter(cue => cue.status !== 'proposed') || []
  const batches = chunk(plan.scenes, 50)
  const candidates: CueCandidate[] = []
  job.output_lines.push(`Proposing contextual cues in ${batches.length} GenStudio batch(es); existing approved or disabled cues stay untouched.`)
  for (const [index, scenes] of batches.entries()) {
    if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
    const raw = await callAi(
      model,
      'You are a restrained documentary editor. Return strict JSON only: {"cues":[{"scene_id":"exact input id","title":"short label","subtitle":"optional second line","kind":"location_date|historical_context|person|chapter","template":"documentary-label|map-pin|archival-caption|chapter-plate","anchor_offset_sec":0.2}]}. Propose only genuinely useful on-screen context: location/date, historical event or era, important institution/person, or a short explanatory label. Use map-pin only for a real place, archival-caption for historic people/documents/eras, chapter-plate only for a major new chapter, and documentary-label otherwise. Do not repeat narration, do not label every scene, never use more than one cue per scene, and prefer no cue when uncertain.',
      `PACING: ${settings.density}. Cues are small corner labels, shown for 2.25–4.5 seconds and reviewed by an editor. Return only candidates that add real orientation.\n\nSCENES:\n${JSON.stringify(scenes.map(scene => ({ scene_id: scene.id, start_sec: scene.start_sec, end_sec: scene.end_sec, narration: scene.transcript_segment.slice(0, 420) })) )}`,
      {}, false,
      { slug: job.project_slug, jobId: `${job.job_id}:batch-${index + 1}`, requestIdentity: `${job.project_slug}:${episodeId}:contextual-cues:${index + 1}`, maxTokens: 3000, jsonMode: true, disableReasoning: true, temperature: 0.2 },
    )
    candidates.push(...parseCandidates(raw))
    job.progress = Math.round(((index + 1) / batches.length) * 80)
  }
  const now = new Date().toISOString()
  const proposed = applySafePacing(
    candidates.map(candidate => safeCandidate(candidate, plan, settings.density, settings.placement, now)).filter((cue): cue is ContextualCue => !!cue),
    settings.density,
    plan.total_duration_sec || plan.scenes[plan.scenes.length - 1]?.end_sec || 0,
  )
  if (settings.auto_approve) {
    for (const cue of proposed) cue.status = 'approved'
  }
  const timeline = {
    schema_version: 1 as const,
    generated_at: now,
    source_scene_plan_generated_at: plan.generated_at,
    cues: [...protectedCues, ...proposed],
  }
  const issues = validateContextualCueTimeline(timeline, plan)
  if (issues.length) throw new Error(`Generated cues did not pass safe pacing validation: ${issues.slice(0, 3).map(issue => issue.detail).join('; ')}`)
  await writeContextualCueTimeline(planPath, timeline)
  job.output_dir = paths.episode_dir
  job.progress = 100
  job.result = { proposed: settings.auto_approve ? 0 : proposed.length, approved: settings.auto_approve ? proposed.length : 0, preserved: protectedCues.length }
  job.output_lines.push(settings.auto_approve
    ? `Saved and auto-approved ${proposed.length} contextual cue(s) using this trusted preset. The validated timeline can continue through Pipeline.`
    : `Saved ${proposed.length} proposed contextual cue(s). Review and approve or disable every cue before Video Assembly.`)
  requireJobCompletion(job, { label: 'Contextual cue proposal', expected: 1, completed: 1 })
}
