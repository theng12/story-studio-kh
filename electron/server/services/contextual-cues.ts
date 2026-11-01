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
import { resolveOutputTokenBudget } from './output-token-budget.js'
import { isContextualCueCorner, resolveContextualCuePosition } from '../contracts/contextual-cue-position.js'
import { isLabelDesignId } from '../contracts/label-design.js'

export const CONTEXTUAL_CUES_FILENAME = 'contextual_cues.json'
export const CONTEXTUAL_CUES_PROGRESS_FILENAME = 'contextual_cues.progress.json'
export const DEFAULT_CONTEXTUAL_CUE_CONFIG: ContextualCueProjectConfig = {
  enabled: false,
}

export function normalizeContextualCueConfig(value: unknown): ContextualCueProjectConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  // `auto_approve_cues` is deliberately NOT carried through. v1.4.365 removed
  // the project-level switch (owner, 2026-10-28): the preset's `auto_approve`
  // is the only one, and a stale channel config must not be able to keep
  // approving cues nobody asked to auto-approve. The key is tolerated on read
  // and simply has no effect; nothing rewrites the stored file.
  const hidden = Array.isArray(raw.hidden_label_designs) ? raw.hidden_label_designs.filter((id): id is string => typeof id === 'string') : []
  return { enabled: raw.enabled === true, ...(hidden.length ? { hidden_label_designs: hidden } : {}) }
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

/**
 * The two reusable label-choice lists a preset may carry, or NOTHING.
 *
 * Absent when the preset named no real value, so a default settings object
 * stays exactly what it was before these fields existed and an empty list
 * cannot be mistaken for a deliberate choice of "none of them".
 */
function normalizeLabelChoiceLists(
  raw: Record<string, unknown>,
): Pick<ContextualCueProposalSettings, 'label_themes' | 'label_motions'> {
  const pick = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const list = [...new Set(
      value.filter((item): item is string => typeof item === 'string')
        .map(item => item.trim()).filter(Boolean),
    )]
    return list.length ? list : undefined
  }
  const label_themes = pick(raw.label_themes)
  const label_motions = pick(raw.label_motions)
  return { ...(label_themes ? { label_themes } : {}), ...(label_motions ? { label_motions } : {}) }
}

/** Keep user-facing proposal controls independent from old project config. */
export function normalizeContextualCueProposalSettings(value: unknown): ContextualCueProposalSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    density: raw.density === 'standard' || raw.density === 'editorial' ? raw.density : 'restrained',
    min_gap_sec: typeof raw.min_gap_sec === 'number' && Number.isFinite(raw.min_gap_sec) && raw.min_gap_sec >= 1 && raw.min_gap_sec <= 600 ? raw.min_gap_sec : 10,
    // All four corners, because all four render and all four always have.
    // This used to collapse anything that was not 'top-left' to 'top-right',
    // which is what made the bottom half of a fully implemented, fully
    // validated feature unreachable — including for the customer whose logo
    // sits in a top corner.
    placement: normalizeCuePlacement(raw.placement),
    ...normalizeCuePositionPair(raw.position_x_pct, raw.position_y_pct),
    ...normalizeLabelChoiceLists(raw),
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

/**
 * The output tokens ONE candidate costs, worst case, from the contract the
 * proposal is validated against (`CONTEXTUAL_CUES_OUTPUT_CONTRACT`).
 *
 * The contract caps a cue's `title` at 80 characters, its `subtitle` at 100,
 * its `point_at` at 80, its `anchor_word` at 80 and its sound description at
 * 120, and a cue may carry all of them plus its ids and numbers. That is the
 * answer's own published shape, so the number is derived from it rather than
 * guessed — but tokens are not characters (AGENTS.md §1), so this is a
 * deliberately PESSIMISTIC upper bound on the tokens those characters can
 * occupy: every character is counted as a whole token, which over-counts
 * English by roughly 4x and never under-counts it.
 */
const CUE_OUTPUT_TOKENS_PER_CANDIDATE = 520

/**
 * How many scenes one proposal request can carry, from the SELECTED product's
 * published output allowance.
 *
 * WHY THIS EXISTS (owner, 2026-11-01). A 68-scene episode failed three times
 * with the Gateway's "answer stopped early (length)": the batch was sized by
 * the published STRUCTURED-ITEM cap alone (`max_structured_items_per_request`),
 * which says how many ITEMS the product accepts, not how long its ANSWER may
 * be. 50 cues of the shape the contract allows is far more text than the
 * output allowance the request asked for, so the provider cut the answer off
 * mid-JSON and the whole proposal was lost three times over.
 *
 * So the batch is now sized from the OUTPUT allowance too, and the smaller of
 * the two rules wins:
 *
 *   - the published item cap, when the product publishes one (unchanged);
 *   - the published `max_output_tokens` divided by the tokens one candidate
 *     costs, with a safety fraction so the answer does not sit on the
 *     ceiling (this rule).
 *
 * NOTHING HERE IS A CONSTANT OF STORY STUDIO'S OWN ABOUT A MODEL. The
 * allowance is the product's published figure; the tokens-per-candidate is
 * derived from this app's own published output contract, not from a
 * remembered catalogue number.
 *
 * A product that publishes NO output allowance keeps today's behaviour
 * exactly: the batch is sized by the item cap alone, and the request omits
 * the ceiling so the provider decides (owner decision #6, 2026-09-20). A
 * product with a published allowance always gets at least one scene per
 * request — a batch of zero would ask for nothing.
 */
export function resolveContextualCueBatchSizeForOutput(
  publishedMaximumItems: unknown,
  publishedMaxOutputTokens: unknown,
  savedBatchSize?: unknown,
): number {
  const byItems = resolveContextualCueBatchSize(publishedMaximumItems, savedBatchSize)
  // The number the request will ACTUALLY ask for, from the same resolver the
  // request itself uses (`outputBudget: 'standard'`). Reading it here rather
  // than restating a fraction is what keeps the sizer and the request from
  // drifting apart: a product with a small ceiling asks for the tier's floor,
  // not a quarter of it.
  const allowance = resolveOutputTokenBudget('standard', publishedMaxOutputTokens)
  if (allowance === null) return byItems
  const affordable = Math.floor(allowance / CUE_OUTPUT_TOKENS_PER_CANDIDATE)
  return Math.max(1, Math.min(byItems, affordable))
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
    min_gap_sec: normalizeContextualCueProposalSettings(settings).min_gap_sec,
    placement: settings.placement,
    auto_approve: settings.auto_approve,
    // A preset that names its own designs or motions bought its batches under
    // those choices, so its saved progress must not be reused for a run that
    // would choose differently. JSON.stringify drops both when unset, which
    // keeps today's fingerprint byte for byte.
    label_themes: settings.label_themes,
    label_motions: settings.label_motions,
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
    // v1 and v2 both read. A v1 file's cues carry no anchor, which is exactly
    // why they keep their stored seconds — nothing rewrites them (AGENTS.md §5,
    // trap 2). A v2 file's cues carry `scene_id` + `anchor_word` and are
    // re-timed from those on every read.
    if (!raw || (raw.schema_version !== 1 && raw.schema_version !== 2) || !Array.isArray(raw.cues)) return null
    return {
      schema_version: raw.schema_version,
      generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : '',
      source_scene_plan_generated_at: typeof raw.source_scene_plan_generated_at === 'string' ? raw.source_scene_plan_generated_at : '',
      cues: raw.cues.filter(isCue).map(normalizeCueAnchors),
      // Why a cue was held back from auto-approval. Dropped here before, so the
      // review page never saw a single hold reason it was built to show.
      ...(Array.isArray(raw.auto_approval_holds) && raw.auto_approval_holds.length
        ? { auto_approval_holds: raw.auto_approval_holds } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Keep only anchors that are real.
 *
 * `typeof value === 'number'` rather than `Number(value)`, for the same reason
 * `normalizePositionPct` does it: `Number(null)` is 0, which would turn a
 * CLEARED anchor into a deliberate one at the very start of the scene.
 */
function normalizeCueAnchors(cue: ContextualCue): ContextualCue {
  const word = typeof cue.anchor_word === 'string' ? cue.anchor_word.trim() : ''
  const offset = cue.anchor_offset_sec
  return {
    ...cue,
    ...(word ? { anchor_word: word } : { anchor_word: undefined }),
    ...(typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
      ? { anchor_offset_sec: offset }
      : { anchor_offset_sec: undefined }),
  } as ContextualCue
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
   * exact force. See `resolveRenderableContextualCues`.
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
  return value === 'map-pin' || value === 'archival-caption' || value === 'chapter-plate' || isLabelDesignId(value)
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
  return resolveRenderableContextualCues(config, timeline, plan, subtitles).cues
}

/**
 * What Video Assembly will actually render, and what it must SAY about the rest.
 *
 * v1.4.365 — owner decision 2026-10-28. This used to THROW: one unreviewed cue
 * refused the whole episode. An optional editorial layer that is allowed to be
 * empty is not allowed to be a hard gate either — a label nobody has got round
 * to approving is a reason to render ONE FEWER LABEL, not a reason to refuse
 * to assemble an otherwise finished episode. The owner's rule: "render approved
 * ones, report the rest".
 *
 * So this returns two lists and never throws for an editorial gap:
 *
 *   `cues`    — approved cues that passed every structural rule. Rendered.
 *   `skipped` — cues that exist but will not render, each with the reason, so
 *               the job log and the Production Board can say what is missing
 *               instead of the video quietly coming back shorter than expected.
 *
 * What still refuses, because these are DEFECTS in the output rather than a
 * pending decision, and no amount of approving fixes them:
 *
 *   - a cue whose timing is invalid or that escapes its scene,
 *   - a cue shorter than `CUE_MIN_DURATION_SEC` (it flashes past unread).
 *
 * Crowded approved cues are skipped individually, keeping earlier labels.
 *
 * A cue with broken text or an invalid template is skipped with its reason
 * rather than refusing everything, because that IS something a reviewer fixes
 * by editing one row.
 */
export interface RenderableContextualCues {
  cues: ContextualCue[]
  skipped: ContextualCueIssue[]
}

export function resolveRenderableContextualCues(
  config: ContextualCueProjectConfig,
  timeline: ContextualCueTimeline | null,
  plan: ScenePlan,
  subtitles?: VideoSubtitleConfig,
): RenderableContextualCues {
  if (!config.enabled) return { cues: [], skipped: [] }
  // No timeline is no cues, not a failure — see `validateContextualCueTimeline`.
  if (!timeline) return { cues: [], skipped: [] }
  const issues = validateContextualCueTimeline(timeline, plan, { subtitles })
  const byCue = new Map<string, ContextualCueIssue[]>()
  for (const issue of issues) {
    if (!issue.cue_id) continue
    byCue.set(issue.cue_id, [...(byCue.get(issue.cue_id) || []), issue])
  }
  // A defect that cannot be fixed by approving the cue refuses the render,
  // because rendering anyway would draw something visibly wrong. Everything
  // else — a cue still waiting on a person, broken text, an invalid treatment —
  // is that ONE cue's problem and is skipped below with its reason.
  const unfixable = (issue: ContextualCueIssue) => issue.severity !== 'warning'
    && (/timing is invalid|inside its scene timing|readable for at least/.test(issue.detail))
  const hard = issues.filter(issue => !issue.cue_id && issue.severity !== 'warning')
    .concat(issues.filter(issue => !!issue.cue_id && unfixable(issue)))
  if (hard.length) {
    throw new Error(`Contextual Cues cannot be rendered: ${hard.slice(0, 5).map(issue => issue.cue_id ? `${cueName(timeline, issue.cue_id)} — ${issue.detail}` : issue.detail).join('; ')} Open Sound & Labels and fix the cue${hard.length === 1 ? '' : 's'} marked.`)
  }
  const cues: ContextualCue[] = []
  const skipped: ContextualCueIssue[] = []
  for (const cue of [...timeline.cues].sort((a, b) => a.start_sec - b.start_sec)) {
    if (cue.status !== 'approved') {
      skipped.push({
        cue_id: cue.id,
        severity: 'warning',
        detail: cue.status === 'disabled'
          ? 'turned off in review, so it is not drawn.'
          : 'still awaiting review, so it is not drawn.',
      })
      continue
    }
    const mine = (byCue.get(cue.id) || []).filter(issue => issue.severity !== 'warning' && !/overlaps or crowds/.test(issue.detail))
    if (mine.length) {
      for (const issue of mine) skipped.push({ cue_id: cue.id, severity: 'warning', detail: issue.detail })
      continue
    }
    const previous = cues[cues.length - 1]
    if (previous && cue.start_sec < previous.end_sec + 0.5) {
      skipped.push({ cue_id: cue.id, severity: 'warning', detail: `overlaps or crowds ${cueName(timeline, previous.id)}; keep at least 0.5s clear.` })
      continue
    }
    cues.push(cue)
  }
  return { cues, skipped }
}

/** Name a cue the way the page lists it — position, title, time. Never its id. */
function cueName(timeline: ContextualCueTimeline, id: string): string {
  const index = timeline.cues.findIndex(cue => cue.id === id)
  const cue = index >= 0 ? timeline.cues[index]! : null
  if (!cue) return 'A cue'
  return `Cue ${index + 1}${cue.title?.trim() ? ` "${cue.title.trim()}"` : ''} (${clock(cue.start_sec)})`
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

const isPlacement = isContextualCueCorner

function isCue(value: unknown): value is ContextualCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as Partial<ContextualCue>
  return typeof cue.id === 'string' && typeof cue.scene_id === 'string'
    && typeof cue.start_sec === 'number' && typeof cue.end_sec === 'number'
    && typeof cue.title === 'string' && typeof cue.status === 'string'
}
