/**
 * Research gate + verification contract (v1.0.760).
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for two questions:
 *
 *   1. "Does this project require research?"      → resolveResearchRequired()
 *   2. "Does this episode's research count as     → isResearchComplete()
 *       complete right now?"
 *
 * Everything that has an opinion about research completion — the generator,
 * the Job Queue, the Pipeline, the Production Board, the Research pending
 * filter, and the downstream gates — must call these helpers rather than
 * re-deriving the rule. That is the Verified Completion Contract requirement
 * that one authoritative rule is shared by every reader.
 *
 * ── Why research got a verification state ────────────────────────────────
 * Research used to be a pure enrichment step: generating it made it "done".
 * For scientific / historical channels that is wrong — an LLM returning
 * plausible prose is not evidence that the claims are true. So a generated
 * research sidecar now enters an explicit `unverified` state and only
 * counts as complete once someone attests to it.
 *
 * ── Why the gate is per project, not global ──────────────────────────────
 * Turning this on globally would retroactively mark every already-shipped
 * episode incomplete. The gate therefore defaults ON for newly created
 * projects (project-manager.createProject stamps `research_required: true`)
 * and OFF for every project that predates the field. That default is
 * resolved EXPLICITLY below — absence means "legacy project", not "someone
 * forgot to set a boolean". Never replace resolveResearchRequired() with a
 * bare truthiness check.
 *
 * ── Where the state lives ────────────────────────────────────────────────
 * In the research sidecar itself (`{code} - 11 Research/research.json`,
 * see lib/research-paths.ts) under the `verification` key, so it travels
 * with the artifact it describes and survives folder renames / re-imports.
 */

import type {
  ProjectMeta,
  ResearchOutput,
  ResearchVerification,
  ResearchVerifiedBy,
} from '../models/types.js'

/** Note stamped on sidecars auto-verified by an unattended Pipeline run. */
export const PIPELINE_AUTO_VERIFY_NOTE =
  'Auto-verified by an unattended one-click Pipeline run — no human reviewed these claims.'

/** What the user is attesting to when they press Verify on the Research page. */
export const HUMAN_VERIFY_ATTESTATION =
  'I have read this research and checked its claims against the cited sources.'

/**
 * Resolve the per-project research gate.
 *
 * EXPLICIT default resolution — do not inline this as `!!meta.research_required`:
 *
 *   • `true`      → gate ON  (research must be verified to count as complete)
 *   • `false`     → gate OFF (research is optional, exactly as before)
 *   • absent/other → gate OFF, because the project predates the field.
 *     New projects are stamped `true` at creation time, so "absent" can only
 *     mean "created before the gate existed" and those episodes must not
 *     retroactively flip to incomplete.
 */
export function resolveResearchRequired(project: Pick<ProjectMeta, 'research_required'> | null | undefined): boolean {
  if (!project) return false
  const value = (project as { research_required?: unknown }).research_required
  if (value === true) return true
  if (value === false) return false
  // Field absent → legacy project created before the gate shipped. OFF.
  return false
}

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

/** Normalized verification block. Missing/legacy blocks read as unverified. */
export function readResearchVerification(research: unknown): ResearchVerification {
  const raw = (research as { verification?: unknown } | null | undefined)?.verification
  if (!raw || typeof raw !== 'object') return { verified: false }
  const v = raw as Partial<ResearchVerification>
  if (v.verified !== true) return { verified: false }
  const by: ResearchVerifiedBy | undefined =
    v.verified_by === 'human' || v.verified_by === 'pipeline-auto' ? v.verified_by : undefined
  return {
    verified: true,
    ...(v.verified_at ? { verified_at: String(v.verified_at) } : {}),
    ...(by ? { verified_by: by } : {}),
    ...(v.note ? { note: String(v.note) } : {}),
  }
}

/** Has someone (human or the unattended Pipeline) attested to this research? */
export function isResearchVerified(research: unknown): boolean {
  return readResearchVerification(research).verified
}

/**
 * THE completion rule. `researchRequired` is the resolved project gate.
 *
 *   gate OFF → complete when evidence exists (identical to pre-gate behaviour)
 *   gate ON  → complete only when evidence exists AND it has been verified
 */
export function isResearchComplete(research: unknown, researchRequired: boolean): boolean {
  const hasEvidence = hasResearchEvidence(research)
  if (!researchRequired) return hasEvidence
  return hasEvidence && isResearchVerified(research)
}

/**
 * Reset a sidecar to unverified. Called every time research is generated or
 * regenerated — new claims have never been reviewed, so an old attestation
 * must never carry over onto them.
 */
export function withResearchUnverified<T extends ResearchOutput>(research: T): T {
  return { ...research, verification: { verified: false } }
}

/** Stamp an attestation onto a sidecar. `by` records WHO/WHAT attested. */
export function withResearchVerified<T extends ResearchOutput>(
  research: T,
  by: ResearchVerifiedBy,
  note?: string,
): T {
  return {
    ...research,
    verification: {
      verified: true,
      verified_at: new Date().toISOString(),
      verified_by: by,
      note: note ?? (by === 'pipeline-auto' ? PIPELINE_AUTO_VERIFY_NOTE : HUMAN_VERIFY_ATTESTATION),
    },
  }
}

/**
 * Actionable "what is missing and how do I fix it" sentence, or null when
 * research is fine. Used by the Pipeline preflight and downstream gates so
 * every surface reports the SAME reason in the SAME words.
 */
export function describeResearchGap(input: {
  episodeId: string
  researchRequired: boolean
  hasEvidence: boolean
  verified: boolean
}): string | null {
  if (!input.researchRequired) return null
  if (!input.hasEvidence) {
    return `${input.episodeId}: research is required for this project but no research evidence exists. `
      + 'Open Research, run it for this episode, then press Verify research.'
  }
  if (!input.verified) {
    return `${input.episodeId}: research exists but is not verified. `
      + 'Open Research (the pending filter lists it), read the claims against their sources, then press Verify research. '
      + 'Pipeline runs verify automatically.'
  }
  return null
}
