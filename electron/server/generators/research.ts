/**
 * Research job executor (v1.0.142+). Runs the user-picked research
 * adapter against the episode topic, writes the unified output to
 * <episode_dir>/research.json + research.md.
 *
 * Wired into the job queue as `research_run` so the long-running
 * web-search call doesn't block the request thread + so progress
 * surfaces in the Jobs panel like every other generator.
 */

import fs from 'fs/promises'
import { getResearchAdapter } from '../services/research/index.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { resolveResearchPaths, RESEARCH_JSON_FILENAME, RESEARCH_MD_FILENAME } from '../lib/research-paths.js'
import type { Job } from '../models/types.js'
import type { ResearchOutput, ResearchSourceProvider } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  autoCompleteResearchReview,
  hasResearchEvidence,
  readResearchReview,
  readResearchTriage,
  withResearchUntriaged,
} from '../lib/research-verification.js'

// Re-exported for back-compat with importers that referenced these here.
export { RESEARCH_JSON_FILENAME, RESEARCH_MD_FILENAME } from '../lib/research-paths.js'

interface ResearchRunParams {
  episode_id: string
  title?: string
  source_provider: ResearchSourceProvider
  topic: string
  specific_questions?: string
  max_sources?: number
  /** v1.0.175 — optional text model for the LLM-only adapter. */
  model?: string
}

export async function runResearchJob(job: Job): Promise<void> {
  const params = job.params as ResearchRunParams
  const { episode_id, source_provider, topic } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!source_provider) throw new Error('source_provider is required')
  if (!topic || !topic.trim()) throw new Error('topic is required')

  job.output_lines.push(`Source: ${source_provider}`)
  job.output_lines.push(`Topic: ${topic}`)
  if (params.specific_questions?.trim()) {
    job.output_lines.push(`Specific questions:\n${params.specific_questions.trim()}`)
  }

  const adapter = getResearchAdapter(source_provider)
  const configured = await adapter.isConfigured()
  if (!configured) {
    throw new Error(
      `${adapter.displayName} is not configured. Add the required API key under App Settings → API Keys.`,
    )
  }

  job.output_lines.push(`Running ${adapter.displayName}…`)
  job.progress = 10

  if (params.model && source_provider === 'llm-only') {
    job.output_lines.push(`Model: ${params.model}`)
  }
  const result = await adapter.run({
    topic,
    specific_questions: params.specific_questions,
    max_sources: params.max_sources,
    model: params.model,
  })

  job.progress = 80
  job.output_lines.push(
    `Returned ${result.claims.length} claim(s) across ${result.citations.length} citation(s).`,
  )

  // Persist sidecars.
  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  // {code} - 11 Research folder (auto-migrates any legacy loose sidecars).
  const { dir, jsonPath, mdPath } = await resolveResearchPaths(paths.episode_dir, episode_id)
  await fs.mkdir(dir, { recursive: true })

  // v1.0.761 — a fresh generation is ALWAYS untriaged: every claim goes back
  // to 'unreviewed' and any older review record is dropped, because nobody has
  // read the NEW claims. The one exception is an unattended one-click Pipeline
  // run, which machine-completes the triage so the batch is never left blocked
  // — recorded as `review.completed_by: 'pipeline-auto'` so the record never
  // pretends a human read it. `pipeline_batch_id` is stamped on every job the
  // batch runner enqueues (and re-stamped by the job-queue chain hook), so it
  // is the authoritative "this ran unattended" signal.
  const ranUnderPipeline = typeof (job.params as any)?.pipeline_batch_id === 'string'
    && !!(job.params as any).pipeline_batch_id
  const persisted = ranUnderPipeline
    ? autoCompleteResearchReview(result)
    : withResearchUntriaged(result)
  job.output_lines.push(
    ranUnderPipeline
      ? 'Claim review: AUTO-COMPLETED (unattended Pipeline run). Every claim was accepted by the machine — no human read them. Open Research to review them.'
      : 'Claim review: PENDING. Open Research and mark every claim Verified or Ignore (Verify all decides the whole list in one click).',
  )
  const uncited = persisted.claims.filter(c => !c.citation_indices?.length).length
  if (uncited) {
    job.output_lines.push(
      `${uncited} of ${persisted.claims.length} claim(s) carry no citation. Research runs on a language model `
      + 'with no live web access, so nothing here was checked against a live source.',
    )
  }

  await fs.writeFile(jsonPath, JSON.stringify(persisted, null, 2), 'utf-8')
  job.output_lines.push(`Wrote ${RESEARCH_JSON_FILENAME}`)

  await fs.writeFile(mdPath, renderResearchMarkdown(persisted), 'utf-8')
  job.output_lines.push(`Wrote ${RESEARCH_MD_FILENAME}`)

  job.output_dir = dir

  // The freshly written sidecar's status is now visible to the Production
  // Board / pending filters straight away rather than on the next mtime sweep.
  try {
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(job.project_slug, episode_id)
  } catch { /* cache refresh is best-effort — mtime watching is the safety net */ }

  // Same artifact rule the Production Board uses (lib/research-verification.ts),
  // so "the job succeeded" and "the board says researched" can never disagree.
  const hasUsableResearch = hasResearchEvidence(persisted)
  requireJobCompletion(job, {
    label: 'Research generation',
    expected: 1,
    completed: hasUsableResearch ? 1 : 0,
    missing: hasUsableResearch ? [] : ['research summary or claim'],
    retry_hint: 'The returned sidecars were kept for diagnosis. Retry with another source or model.',
  })
  job.progress = 100
}

/** Human-readable summary of the research output. Saved alongside the
 *  JSON so the user can read the research in any markdown viewer
 *  (incl. inside Finder's QuickLook) without firing up the app. */
function renderResearchMarkdown(r: ResearchOutput): string {
  const lines: string[] = []
  lines.push(`# Research — ${r.topic}`)
  lines.push('')
  lines.push(`*Generated ${r.generated_at} via ${r.source_provider}${r.source_model ? ` (${r.source_model})` : ''}*`)
  lines.push('')
  // Provenance disclaimer. The shipping adapter has no live web access, so the
  // record must never read as if the app checked anything for the user.
  if (r.source_provider === 'llm-only') {
    lines.push('*Model-generated research. It was produced by a language model with no live web access, '
      + 'so these claims were not checked against live sources — confirm anything load-bearing yourself.*')
    lines.push('')
  }
  // Review state is part of the human-readable record too — a reader opening
  // research.md in Finder must be able to see what was decided about these
  // claims, and by whom.
  const triage = readResearchTriage(r)
  const review = readResearchReview(r)
  const reviewedAt = review?.completed_at ? ` on ${review.completed_at}` : ''
  if (!triage.total) {
    lines.push('> **NO CLAIMS.** This run returned nothing to review, so nothing will reach the Script Generator.')
  } else if (!triage.reviewed) {
    lines.push(`> **REVIEW PENDING.** ${triage.pending} of ${triage.total} claim(s) still need a Verified / Ignore `
      + 'decision on the Research page. Only kept claims reach the Script Generator.')
  } else if (!triage.hasUsableClaims) {
    lines.push(`> **REVIEWED — EVERY CLAIM IGNORED.** All ${triage.total} claim(s) were rejected${reviewedAt}, `
      + 'so this research hands the Script Generator nothing.')
  } else if (review?.completed_by === 'pipeline-auto') {
    lines.push(`> **Review auto-completed** by an unattended Pipeline run${reviewedAt}. `
      + `No human read these claims. ${triage.verified} kept, ${triage.ignored} ignored.`)
  } else {
    lines.push(`> **Reviewed**${reviewedAt} — ${triage.verified} claim(s) kept, ${triage.ignored} ignored. `
      + 'Only the kept claims reach the Script Generator.')
  }
  lines.push('')

  if (r.summary) {
    lines.push('## Summary')
    lines.push('')
    lines.push(r.summary)
    lines.push('')
  }

  if (r.specific_questions?.trim()) {
    lines.push('## Specific questions asked')
    lines.push('')
    lines.push(r.specific_questions.trim())
    lines.push('')
  }

  if (r.claims.length) {
    lines.push('## Claims')
    lines.push('')
    for (let i = 0; i < r.claims.length; i++) {
      const c = r.claims[i]!
      const conf = c.confidence ? ` *(confidence: ${c.confidence})*` : ''
      // An absent citation is a fact the reader needs, not a blank to gloss
      // over: most llm-only claims arrive with nothing behind them.
      const refs = c.citation_indices?.length
        ? ` [${c.citation_indices.map(idx => idx + 1).join(', ')}]`
        : ' *(no source cited)*'
      const decision = c.status === 'verified' ? ' — kept'
        : c.status === 'ignored' ? ' — ignored'
        : ' — not reviewed'
      lines.push(`${i + 1}. ${c.text}${refs}${conf}${decision}`)
      if (c.note) lines.push(`   - *${c.note}*`)
    }
    lines.push('')
  }

  if (r.structure?.length) {
    lines.push('## Recommended episode structure')
    lines.push('')
    for (const s of r.structure) {
      lines.push(`### ${s.heading}`)
      lines.push('')
      lines.push(s.brief)
      lines.push('')
    }
  }

  if (!r.citations.length) {
    lines.push('## Sources')
    lines.push('')
    lines.push('None. This run returned no citations, which is normal for the model-only research route — '
      + 'it is instructed not to invent URLs. Find and check sources yourself before relying on these claims.')
    lines.push('')
  }

  if (r.citations.length) {
    lines.push('## Sources')
    lines.push('')
    for (let i = 0; i < r.citations.length; i++) {
      const c = r.citations[i]!
      const link = c.url ? `[${c.title}](${c.url})` : c.title
      lines.push(`${i + 1}. ${link}`)
      if (c.snippet) lines.push(`   > ${c.snippet}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
