import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'node:crypto'
import type {
  ContextualCue,
  ContextualCueAutoApprovalHold,
  ContextualCueKind,
  ContextualCuePlacement,
  ContextualCueProposalSettings,
  ContextualCueProjectConfig,
  ContextualCueTimeline,
  ContextualCueTemplate,
  ScenePlan,
  VideoSubtitleConfig,
} from '../models/types.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { isContextualCueCorner, resolveContextualCuePosition } from '../contracts/contextual-cue-position.js'

export const CONTEXTUAL_CUES_FILENAME = 'contextual_cues.json'
export const CONTEXTUAL_CUES_PROGRESS_FILENAME = 'contextual_cues.progress.json'
export const DEFAULT_CONTEXTUAL_CUE_CONFIG: ContextualCueProjectConfig = {
  enabled: false,
  auto_approve_cues: false,
}

export function normalizeContextualCueConfig(value: unknown): ContextualCueProjectConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: raw.enabled === true,
    // Default OFF — see ContextualCueProjectConfig.auto_approve_cues.
    auto_approve_cues: raw.auto_approve_cues === true,
  }
}

/**
 * The single place a placement value is accepted, so the four corners cannot
 * drift apart again across the six call sites that each used to decide this
 * for themselves.
 */
export function normalizeCuePlacement(value: unknown): ContextualCuePlacement {
  return isPlacement(value) ? value : 'top-right'
}

/**
 * A percentage anchor is kept only when it is a real number in range.
 *
 * Deliberately `typeof value === 'number'` rather than `Number(value)`:
 * `Number(null)` is 0, so coercing would turn a CLEARED anchor into a
 * deliberate placement at the top-left corner of the frame.
 */
function normalizePositionPct(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value < 0 || value > 100 ? null : value
}

/**
 * Both axes or neither, matching the caption rule in `normalizeSubtitleStyle`.
 * A half-written anchor is not a position, and silently keeping one axis would
 * move a label along it while leaving the other wherever it happened to be.
 */
export function normalizeCuePositionPair(
  x: unknown,
  y: unknown,
): { position_x_pct: number | null; position_y_pct: number | null } {
  const position_x_pct = normalizePositionPct(x)
  const position_y_pct = normalizePositionPct(y)
  return position_x_pct === null || position_y_pct === null
    ? { position_x_pct: null, position_y_pct: null }
    : { position_x_pct, position_y_pct }
}

/** Keep user-facing proposal controls independent from old project config. */
export function normalizeContextualCueProposalSettings(value: unknown): ContextualCueProposalSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    density: raw.density === 'standard' || raw.density === 'editorial' ? raw.density : 'restrained',
    // All four corners, because all four render and all four always have.
    // This used to collapse anything that was not 'top-left' to 'top-right',
    // which is what made the bottom half of a fully implemented, fully
    // validated feature unreachable — including for the customer whose logo
    // sits in a top corner.
    placement: normalizeCuePlacement(raw.placement),
    ...normalizeCuePositionPair(raw.position_x_pct, raw.position_y_pct),
    auto_approve: raw.auto_approve === true,
  }
}

export function contextualCuePath(scenePlanPath: string): string {
  return path.join(path.dirname(scenePlanPath), CONTEXTUAL_CUES_FILENAME)
}

export interface ContextualCueProgressCandidate {
  scene_id: string
  title: string
  subtitle?: string
  kind?: ContextualCueKind
  template?: ContextualCueTemplate
  anchor_offset_sec?: number
}

export interface ContextualCueProgress {
  schema_version: 1
  fingerprint: string
  source_scene_plan_generated_at: string
  model: string
  batch_size: number
  total_scenes: number
  total_batches: number
  completed_batches: Array<{
    index: number
    scene_ids: string[]
    candidates: ContextualCueProgressCandidate[]
  }>
  /** Latest proven terminal backpressure job per incomplete batch; seeds one fresh deterministic identity. */
  retry_scopes?: Record<string, string>
  /** Read-only preview from completed batches. Never accepted as final readiness. */
  provisional_cues?: ContextualCue[]
  updated_at: string
}

const DEFAULT_CONTEXTUAL_CUE_BATCH_SIZE = 50

/** A published maximum is a ceiling, not a recommendation to grow a batch. */
export function resolveContextualCueBatchSize(
  publishedMaximum: unknown,
  savedBatchSize?: unknown,
): number {
  const published = Number.isInteger(publishedMaximum) && Number(publishedMaximum) > 0
    ? Number(publishedMaximum)
    : null
  const policySize = Number.isInteger(savedBatchSize) && Number(savedBatchSize) > 0
    ? Number(savedBatchSize)
    : DEFAULT_CONTEXTUAL_CUE_BATCH_SIZE
  return published === null ? policySize : Math.min(policySize, published)
}

export function contextualCueProgressPath(scenePlanPath: string): string {
  return path.join(path.dirname(scenePlanPath), CONTEXTUAL_CUES_PROGRESS_FILENAME)
}

/** Exact plan + proposal settings identity. A changed plan/model starts fresh. */
export function contextualCueProgressFingerprint(
  plan: Pick<ScenePlan, 'generated_at' | 'scenes'>,
  settings: ContextualCueProposalSettings,
): string {
  const input = JSON.stringify({
    generated_at: plan.generated_at,
    scenes: plan.scenes.map(scene => ({
      id: scene.id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      transcript_segment: scene.transcript_segment,
    })),
    model: settings.model,
    density: settings.density,
    placement: settings.placement,
    auto_approve: settings.auto_approve,
  })
  return createHash('sha256').update(input).digest('hex')
}

function isContextualCueProgress(value: unknown): value is ContextualCueProgress {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<ContextualCueProgress>
  return raw.schema_version === 1
    && typeof raw.fingerprint === 'string'
    && typeof raw.source_scene_plan_generated_at === 'string'
    && typeof raw.model === 'string'
    && Number.isInteger(raw.batch_size) && Number(raw.batch_size) > 0
    && Number.isInteger(raw.total_scenes) && Number(raw.total_scenes) >= 0
    && Number.isInteger(raw.total_batches) && Number(raw.total_batches) >= 0
    && Array.isArray(raw.completed_batches)
    && raw.completed_batches.every(batch => Number.isInteger(batch?.index)
      && Array.isArray(batch?.scene_ids)
      && batch.scene_ids.every(id => typeof id === 'string')
      && Array.isArray(batch?.candidates))
    && (raw.provisional_cues === undefined || Array.isArray(raw.provisional_cues))
    && (raw.retry_scopes === undefined || (raw.retry_scopes !== null && typeof raw.retry_scopes === 'object' && !Array.isArray(raw.retry_scopes)))
    && typeof raw.updated_at === 'string'
}

export async function readContextualCueProgress(
  scenePlanPath: string,
  expectedFingerprint?: string,
): Promise<ContextualCueProgress | null> {
  try {
    const raw = JSON.parse(await fs.readFile(contextualCueProgressPath(scenePlanPath), 'utf8'))
    if (!isContextualCueProgress(raw)) return null
    if (expectedFingerprint && raw.fingerprint !== expectedFingerprint) return null
    return raw
  } catch {
    return null
  }
}

export async function writeContextualCueProgress(scenePlanPath: string, progress: ContextualCueProgress): Promise<void> {
  await writeJsonAtomic(contextualCueProgressPath(scenePlanPath), progress)
}

export async function removeContextualCueProgress(scenePlanPath: string): Promise<void> {
  await fs.rm(contextualCueProgressPath(scenePlanPath), { force: true })
}

/** A fresh paid request is safe only when GenStudio proves the old one cost zero. */
export function isReleasedContextualCueBackpressure(error: {
  failureCode?: string | null
  reservedCredits?: number | null
  settledCredits?: number | null
  releasedCredits?: number | null
}): boolean {
  return error.failureCode === 'LANGUAGE_PROVIDER_BACKPRESSURE'
    && typeof error.reservedCredits === 'number'
    && error.reservedCredits > 0
    && error.settledCredits === 0
    && error.releasedCredits === error.reservedCredits
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
      // Why a cue was held back from auto-approval. Dropped here before, so the
      // review page never saw a single hold reason it was built to show.
      ...(Array.isArray(raw.auto_approval_holds) && raw.auto_approval_holds.length
        ? { auto_approval_holds: raw.auto_approval_holds } : {}),
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
  /**
   * `'warning'` entries are shown and never block. Anything without a severity
   * is an error, so every rule written before this field existed keeps its
   * exact force. See `assertContextualCueReadiness`.
   */
  severity?: 'error' | 'warning'
}

/**
 * The shortest a cue may stay on screen — and the one timing rule that is
 * still a refusal.
 *
 * A cue arrives unannounced. Unlike a subtitle, the eye is not already
 * tracking the spot it appears in, so the viewer has to FIND the label before
 * reading it. Broadcast practice puts the floor for a subtitle the reader is
 * already following near 0.83s; a label that must be noticed first needs
 * meaningfully more than that. 2.25s is what this feature shipped with, it has
 * never been complained about, and a cue that flashes past unread is a genuine
 * defect in the output rather than a matter of taste — so it stays hard.
 */
export const CUE_MIN_DURATION_SEC = 2.25

/**
 * The point past which a cue is worth MENTIONING — and only mentioning.
 *
 * Derived, not chosen. The longest cue this validator accepts is an
 * 80-character title plus a 100-character subtitle: 180 characters. At the
 * ~15 characters per second that broadcast subtitling treats as a comfortable
 * reading rate (~180 wpm at ~5 characters a word), that text takes about 12
 * seconds to read. So 12s is the longest that any legal cue can still be doing
 * reading work; beyond it the label is being HELD, and holding a label is an
 * editorial choice about the pace of your own film.
 *
 * This replaces a hard 4.5s ceiling that refused the render outright. That
 * number was never anyone's decision — it arrived with the first commit of the
 * feature carrying no reasoning — and it is barely a third of what the longest
 * label the same function accepts actually needs in order to be read. It also
 * made the app overrule its own editor about taste, which is not its job.
 *
 * Nothing downstream depends on a cue being short: the 0.5s anti-crowding rule
 * below still keeps approved cues off each other, and a cue still cannot
 * outlast the scene it belongs to.
 */
export const CUE_LONG_DURATION_SEC = 12

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
  // Nothing was ever proposed. The project setting's own promise is that
  // "every PROPOSED cue must be approved or excluded" — with zero proposals
  // that is vacuously true, so there is nothing here to report and nothing for
  // a reviewer to resolve. Returning an issue instead made an OPTIONAL feature
  // block every render on an episode that had simply never generated cues,
  // which is the same shape AGENTS.md already rules out for Research: an
  // optional evidence workflow must never block generation or assembly.
  // A timeline that DOES exist with unresolved proposals still blocks below —
  // that gate is doing real work; only the nothing-exists case was wrong.
  if (!timeline) return []
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
    if (duration < CUE_MIN_DURATION_SEC) {
      issues.push({ cue_id: cue.id, detail: `Cue must stay readable for at least ${CUE_MIN_DURATION_SEC} seconds.` })
    } else if (duration > CUE_LONG_DURATION_SEC) {
      issues.push({
        cue_id: cue.id,
        severity: 'warning',
        detail: `Cue holds for ${duration.toFixed(1)}s — longer than the ~${CUE_LONG_DURATION_SEC}s even the longest label needs to be read. That is allowed; check it is deliberate.`,
      })
    }
    if (!cue.title.trim() || cue.title.length > 80 || (cue.subtitle?.length || 0) > 100) {
      issues.push({ cue_id: cue.id, detail: 'Cue text is empty or too long for a restrained on-screen label.' })
    }
    if (normalizeContextualCueTemplate(cue.template) !== cue.template) {
      issues.push({ cue_id: cue.id, detail: 'Cue treatment is invalid.' })
    }
    if (!isPlacement(cue.placement)) issues.push({ cue_id: cue.id, detail: 'Cue placement is invalid.' })
    // Captions live low in the frame, so a label placed low may sit on them.
    // Two things changed here, both deliberate:
    //
    //  * It is a WARNING. As a refusal it made "put the label at the bottom"
    //    impossible for anyone burning in subtitles — which is nearly
    //    everyone — so unlocking the bottom corners anywhere else would have
    //    just moved the dead end to render time.
    //  * It asks where the cue ACTUALLY lands, not which corner it names. A
    //    cue holding a precise anchor at 40% of frame height is nowhere near
    //    the captions, whatever corner it happens to still carry.
    if (options.subtitles?.enabled && resolveContextualCuePosition(cue).yPct >= 60) {
      issues.push({
        cue_id: cue.id,
        severity: 'warning',
        detail: 'Cue sits low in the frame where burned-in subtitles are drawn; check the two do not overlap.',
      })
    }
  }
  for (let index = 1; index < approved.length; index++) {
    const previous = approved[index - 1]!
    const current = approved[index]!
    if (current.start_sec < previous.end_sec + 0.5) {
      // Named by its time, as the review page shows it — never by an internal id.
      const at = `${Math.floor(previous.start_sec / 60)}:${String(Math.floor(previous.start_sec % 60)).padStart(2, '0')}`
      issues.push({ cue_id: current.id, detail: `Cue overlaps or crowds the approved cue at ${at}; keep at least 0.5s clear between approved cues.` })
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
    // Warnings never hold a cue back. A note about taste — a long hold, or a
    // label low in the frame — is not a structural failure, and holding a cue
    // for one would put it in front of a reviewer with nothing to fix.
    const issues = validateContextualCueTimeline(trial, plan, { subtitles })
      .filter(issue => issue.cue_id === cue.id && issue.severity !== 'warning')
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
  // Only errors stop a render. Warnings are shown on the review screen, where
  // the person who can judge them is; refusing to assemble an episode over a
  // matter of taste is how a 4.5s ceiling nobody chose came to block real work.
  const blocking = issues.filter(issue => issue.severity !== 'warning')
  if (blocking.length) {
    throw new Error(`Contextual Cues need review: ${blocking.slice(0, 5).map(issue => issue.cue_id ? `${issue.cue_id} — ${issue.detail}` : issue.detail).join('; ')} Open Contextual Cues, resolve every proposal, then retry.`)
  }
  // No timeline is no cues, not a failure — see `validateContextualCueTimeline`.
  return timeline ? timeline.cues.filter(cue => cue.status === 'approved') : []
}

const isPlacement = isContextualCueCorner

function isCue(value: unknown): value is ContextualCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as Partial<ContextualCue>
  return typeof cue.id === 'string' && typeof cue.scene_id === 'string'
    && typeof cue.start_sec === 'number' && typeof cue.end_sec === 'number'
    && typeof cue.title === 'string' && typeof cue.status === 'string'
}
