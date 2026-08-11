/**
 * Research evidence + claim-review contract.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for two questions:
 *
 *   1. "Does this episode have real research evidence?" → isResearchComplete()
 *   2. "What has been decided about its claims?"        → readResearchTriage()
 *
 * Research is optional enrichment. Its evidence and triage are still surfaced
 * honestly, but neither may block generation or episode completion.
 *
 * ── Why research has a review state ──────────────────────────────────────
 * Research used to be a pure enrichment step: generating it made it "done".
 * For scientific / historical channels that is wrong — an LLM returning
 * plausible prose is not evidence that the claims are true. So a generated
 * sidecar is not complete until the claims have been triaged.
 *
 * ── ONE decision, derived (v1.0.761) ─────────────────────────────────────
 * v1.0.760 shipped TWO stacked "verify" actions: the per-claim
 * Verified / Ignore triage that decides which claims reach the Script
 * Generator, AND a separate research-level attestation banner. That was one
 * decision too many, and the banner's wording ("checked against the cited
 * sources") was false: Story Studio's only research adapter is `llm-only`,
 * which is explicitly told it has NO live web access and must not invent
 * URLs. Real runs come back with zero citations, so nothing could have been
 * checked against them.
 *
 * The research-level state is therefore DERIVED from the per-claim triage:
 *
 *   reviewed        = there is at least one claim AND none are 'unreviewed'
 *   usable          = at least one claim was kept ('verified')
 *   complete        = real evidence exists
 *
 * The all-ignored case is a legitimate editorial outcome ("I read these and
 * none of them are good enough"), so it counts as REVIEWED while leaving the
 * Script Generator no kept claims. It does not block any workflow.
 *
 * ── Where the state lives ────────────────────────────────────────────────
 * In the claims themselves (`{code} - 11 Research/research.json`, see
 * lib/research-paths.ts), so it travels with the artifact it describes and
 * survives folder renames / re-imports. The sidecar also carries a `review`
 * PROVENANCE record — who finished the triage (a person, or an unattended
 * Pipeline run) — which is recorded for honesty and is never an input to the
 * completion rule.
 */

import type {
  ResearchClaim,
  ResearchOutput,
  ResearchReviewRecord,
  ResearchReviewedBy,
} from '../models/types.js'

/** Note stamped on sidecars whose triage was completed by an unattended run. */
export const PIPELINE_AUTO_REVIEW_NOTE =
  'Claim review auto-completed by an unattended one-click Pipeline run — no human read these claims.'

/** Note stamped when a person triaged every claim on the Research page. */
export const HUMAN_REVIEW_NOTE =
  'Every claim was triaged by hand on the Research page — kept or ignored.'

/**
 * Does this sidecar contain usable research at all?
 *
 * Artifact-based, per the Verified Completion Contract: a summary with real
 * text, or at least one claim with real text. Never "the folder exists" and
 * never "the file parsed".
 */
export function hasResearchEvidence(research: unknown): boolean {
  if (!research || typeof research !== 'object') return false
  const r = research as Partial<ResearchOutput>
  if (typeof r.summary === 'string' && r.summary.trim()) return true
  return Array.isArray(r.claims)
    && r.claims.some(claim => typeof claim?.text === 'string' && claim.text.trim().length > 0)
}

/** Counts + derived flags for the per-claim triage. THE state of a sidecar. */
export interface ResearchTriage {
  /** Claims that carry real text. Blank placeholders are not countable work. */
  total: number
  /** Kept — these are the claims the Script Generator receives. */
  verified: number
  /** Read and rejected. Recorded, but not passed downstream. */
  ignored: number
  /** Still waiting for a Verified / Ignore decision. */
  pending: number
  /** Every claim has a decision, and there is at least one claim. */
  reviewed: boolean
  /** At least one claim was kept, so the script has something to work from. */
  hasUsableClaims: boolean
}

/**
 * Read the per-claim triage. Only claims with real text are counted: a blank
 * placeholder cannot be meaningfully reviewed and must not be able to hold an
 * episode hostage (it is not evidence either — see hasResearchEvidence).
 */
export function readResearchTriage(research: unknown): ResearchTriage {
  const raw = (research as { claims?: unknown } | null | undefined)?.claims
  const claims: Partial<ResearchClaim>[] = Array.isArray(raw) ? raw as Partial<ResearchClaim>[] : []
  let verified = 0
  let ignored = 0
  let pending = 0
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') continue
    if (typeof claim.text !== 'string' || !claim.text.trim()) continue
    if (claim.status === 'verified') verified++
    else if (claim.status === 'ignored') ignored++
    else pending++          // 'unreviewed', absent, or junk → still owed a decision
  }
  const total = verified + ignored + pending
  return {
    total,
    verified,
    ignored,
    pending,
    reviewed: total > 0 && pending === 0,
    hasUsableClaims: verified > 0,
  }
}

/** Has every claim been triaged? (Zero claims is never "reviewed".) */
export function isResearchReviewed(research: unknown): boolean {
  return readResearchTriage(research).reviewed
}

/** Normalized review provenance, or null when nobody has finished a triage. */
export function readResearchReview(research: unknown): ResearchReviewRecord | null {
  const raw = (research as { review?: unknown } | null | undefined)?.review
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ResearchReviewRecord>
  // Only the two known actors are trusted; anything else is dropped rather
  // than echoed back to the UI as if the app had vouched for it.
  if (r.completed_by !== 'human' && r.completed_by !== 'pipeline-auto') return null
  return {
    completed_by: r.completed_by,
    completed_at: r.completed_at ? String(r.completed_at) : '',
    ...(r.note ? { note: String(r.note) } : {}),
  }
}

/**
 * Research-stage completion is evidence-only. Claim triage controls which
 * claims reach Script Generator, not whether any other workflow may proceed.
 */
export function isResearchComplete(research: unknown): boolean {
  return hasResearchEvidence(research)
}

/**
 * Reset a sidecar to untriaged. Called every time research is generated or
 * regenerated — new claims have never been read, so neither an old per-claim
 * decision nor an old review record may carry over onto them.
 *
 * Also strips the retired v1.0.760 `verification` attestation block so a
 * stale "someone attested to this" never rides along on a fresh generation.
 */
export function withResearchUntriaged<T extends ResearchOutput>(research: T): T {
  const next = { ...research } as T & { verification?: unknown }
  next.claims = (research.claims || []).map(claim => ({ ...claim, status: 'unreviewed' as const }))
  delete next.review
  delete next.verification
  return next
}

/** Stamp the review provenance record. `by` records WHO finished the triage. */
export function withResearchReviewRecord<T extends ResearchOutput>(
  research: T,
  by: ResearchReviewedBy,
  note?: string,
): T {
  const next = { ...research } as T & { verification?: unknown }
  delete next.verification
  next.review = {
    completed_by: by,
    completed_at: new Date().toISOString(),
    note: note ?? (by === 'pipeline-auto' ? PIPELINE_AUTO_REVIEW_NOTE : HUMAN_REVIEW_NOTE),
  }
  return next
}

/**
 * Machine-complete the triage for an unattended one-click Pipeline run.
 *
 * An unattended batch must never stall on "somebody still has to click
 * through the claims", so every claim still pending is accepted. Decisions a
 * human already made are left exactly as they are, and the record says
 * `pipeline-auto` so nothing ever pretends a person read these claims.
 */
export function autoCompleteResearchReview<T extends ResearchOutput>(research: T): T {
  const promoted = {
    ...research,
    claims: (research.claims || []).map(claim => (
      claim.status === 'verified' || claim.status === 'ignored'
        ? claim
        : { ...claim, status: 'verified' as const }
    )),
  }
  return withResearchReviewRecord(promoted, 'pipeline-auto')
}
