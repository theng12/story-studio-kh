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
import {
  getResearchAdapterForMode,
  normalizeResearchMode,
  researchModeForProvider,
} from '../services/research/index.js'
import {
  researchModeLabel,
  researchModeNotice,
  researchRanAt,
  webRunUsageSentence,
  MODEL_KNOWLEDGE_CLAIM_NOTE,
} from '../services/research/provenance.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { resolveResearchPaths, RESEARCH_JSON_FILENAME, RESEARCH_MD_FILENAME } from '../lib/research-paths.js'
import type { Job } from '../models/types.js'
import type { ResearchMode, ResearchOutput, ResearchSourceProvider } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  autoApproveResearchReview,
  autoCompleteResearchReview,
  hasResearchEvidence,
  readResearchReview,
  readResearchTriage,
  researchAutoApproveEnabled,
  withResearchUntriaged,
} from '../lib/research-verification.js'
import { getConfig } from '../services/project-manager.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { canonicalHttpUrl, canonicalHttpUrls, sanitizeResearchOutputUrls } from '../services/research/urls.js'

// Re-exported for back-compat with importers that referenced these here.
export { RESEARCH_JSON_FILENAME, RESEARCH_MD_FILENAME } from '../lib/research-paths.js'

interface ResearchRunParams {
  episode_id: string
  title?: string
  source_provider: ResearchSourceProvider
  /** Which route to run. Absent = derived from source_provider, which for
   *  every job queued before web search existed means model-knowledge. */
  research_mode?: ResearchMode
  topic: string
  specific_questions?: string
  max_sources?: number
  /** v1.0.175 — optional GenStudio language-product id. */
  model?: string
  /** Web-mode domain filters. Ignored in model-knowledge mode. */
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export async function runResearchJob(job: Job): Promise<void> {
  const params = job.params as ResearchRunParams
  const { episode_id, source_provider, topic } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!source_provider) throw new Error('source_provider is required')
  if (!topic || !topic.trim()) throw new Error('topic is required')

  // A job queued before web search existed carries no mode; its provider is
  // the only thing that can tell us what it meant, and it can only have meant
  // model knowledge.
  const mode: ResearchMode = params.research_mode
    ? normalizeResearchMode(params.research_mode)
    : researchModeForProvider(source_provider)

  job.output_lines.push(`Mode: ${researchModeLabel(mode)}`)
  job.output_lines.push(`Topic: ${topic}`)
  if (params.specific_questions?.trim()) {
    job.output_lines.push(`Specific questions:\n${params.specific_questions.trim()}`)
  }

  const adapter = getResearchAdapterForMode(mode)
  const configured = await adapter.isConfigured()
  if (!configured) {
    throw new Error(
      `${adapter.displayName} is not configured. Add the required API key under App Settings → API Keys.`,
    )
  }

  job.output_lines.push(`Running ${adapter.displayName}…`)
  job.progress = 10

  if (params.model) {
    job.output_lines.push(`Model: ${params.model}`)
  }
  const result = sanitizeResearchOutputUrls(await adapter.run({
    topic,
    specific_questions: params.specific_questions,
    max_sources: params.max_sources,
    model: params.model,
    mode,
    ...(mode === 'web-search'
      ? {
          web_search: {
            allowed_domains: params.allowed_domains,
            blocked_domains: params.blocked_domains,
          },
        }
      : {}),
  }))

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
  //
  // The second exception is the project's own "Approve claims automatically"
  // setting on the Research page. It is read HERE, at run time, from
  // config.json — never baked into a preset or into the job's params — so
  // flipping it takes effect on the very next run. Absent means OFF, and a
  // config that fails to load means OFF: the app never accepts unread
  // evidence by accident. It is recorded as `auto-approval`, its own actor,
  // because "you asked for this standing" and "an unattended batch could not
  // wait" are different promises and must not share a sentence.
  const ranUnderPipeline = typeof (job.params as any)?.pipeline_batch_id === 'string'
    && !!(job.params as any).pipeline_batch_id
  let autoApprove = false
  try {
    autoApprove = researchAutoApproveEnabled(await getConfig(job.project_slug))
  } catch { /* unreadable config → off, the safe default */ }
  const persisted = ranUnderPipeline
    ? autoCompleteResearchReview(result)
    : autoApprove
      ? autoApproveResearchReview(result)
      : withResearchUntriaged(result)
  job.output_lines.push(
    ranUnderPipeline
      ? 'Claim review: AUTO-COMPLETED (unattended Pipeline run). Every claim was accepted by the machine — no human read them. Open Research to review them.'
      : autoApprove
        ? 'Claim review: AUTO-APPROVED — this project has "Approve claims automatically" turned on, so every claim was accepted and passed to the Script Generator without being read. Open Research to change any of them, or turn the setting off.'
        : 'Claim review: PENDING. Open Research and mark every claim Verified or Ignore (Verify all decides the whole list in one click).',
  )
  // Provenance in the job log, per mode. The two modes made different
  // promises, so they must not share a sentence here either.
  if (mode === 'web-search') {
    const attributed = persisted.claims.filter(c => c.citation_indices?.length).length
    const uncitedWeb = persisted.claims.length - attributed
    if (!persisted.citations.length) {
      job.output_lines.push(researchModeNotice(mode, persisted.citations.length, persisted.web_run))
    } else if (attributed > 0) {
      // Only claims GenStudio actually grounded are counted here. A claim it
      // could not ground is reported as uncited, never covered by the run's
      // source list.
      job.output_lines.push(
        `${persisted.citations.length} source(s) recorded for this run. `
        + `${attributed} of ${persisted.claims.length} claim(s) link to the specific sources that back them.`
        + (uncitedWeb
          ? ` ${uncitedWeb} of ${persisted.claims.length} claim(s) carry no citation — worth checking yourself.`
          : ''),
      )
    } else {
      job.output_lines.push(
        `${persisted.citations.length} source(s) recorded for this run. `
        + 'Sources back the run as a whole — individual claims are not linked to specific sources yet.',
      )
    }
    // Never compute a charge locally: report exactly what GenStudio reported,
    // under its confirmed field names, and say "not reported" otherwise.
    job.output_lines.push(webRunUsageSentence(persisted.web_run))
  } else {
    const uncited = persisted.claims.filter(c => !c.citation_indices?.length).length
    if (uncited) {
      job.output_lines.push(
        `${uncited} of ${persisted.claims.length} claim(s) carry no citation. ${MODEL_KNOWLEDGE_CLAIM_NOTE} — `
        + 'reliable on well-established facts, worth checking anything specific or recent.',
      )
    }
  }

  await fs.writeFile(jsonPath, JSON.stringify(persisted, null, 2), 'utf-8')
  job.output_lines.push(`Wrote ${RESEARCH_JSON_FILENAME}`)

  await fs.writeFile(mdPath, renderResearchMarkdown(persisted, await researchModelLabel(persisted)), 'utf-8')
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

/**
 * The catalogue's published NAME for the model this run used, or ''.
 *
 * `source_model` is an internal GenStudio product handle — strings on the order
 * of `gemini-3.1-flash-lite-discount`. It was being written straight into
 * research.md, a file whose whole purpose is that a person can open it in Finder
 * and read it. Nobody outside this codebase knows what a product handle is, and
 * a customer reading one has been shown plumbing and told nothing.
 *
 * The name comes from the live catalogue, which is where names come from
 * everywhere else in this app; the handle is never reconstructed into a name and
 * never used as one. When the catalogue cannot be read, or has no row for this
 * handle, the answer is '' and the line simply omits the model — a research
 * document that does not name its model is honest, and one that names it with an
 * internal id is not.
 */
export async function researchModelLabel(r: ResearchOutput): Promise<string> {
  const handle = typeof r.source_model === 'string' ? r.source_model.trim() : ''
  if (!handle) return ''
  try {
    const apiKey = (await getApiKey('genstudio'))?.trim()
    if (!apiKey) return ''
    const { listChatModels } = await import('../lib/genstudio-client.js')
    const products = await listChatModels(apiKey)
    const match = products.find(product => product.id === handle
      || (Array.isArray(product.legacy_ids) && product.legacy_ids.includes(handle)))
    return match?.display_name?.trim() || ''
  } catch {
    // Unreachable or unreadable catalogue. The document loses one optional
    // detail; it does not gain an internal identifier.
    return ''
  }
}

/** Human-readable summary of the research output. Saved alongside the
 *  JSON so the user can read the research in any markdown viewer
 *  (incl. inside Finder's QuickLook) without firing up the app.
 *
 *  `modelLabel` is the catalogue's published name for `r.source_model`, resolved
 *  by the caller. It is the ONLY thing that may stand for the model here — see
 *  `researchModelLabel`. */
export function renderResearchMarkdown(r: ResearchOutput, modelLabel = ''): string {
  const mode = readResearchOutputMode(r)
  const lines: string[] = []
  lines.push(`# Research — ${r.topic}`)
  lines.push('')
  // "Research ran on <date>" is the run-level recency signal for web sources.
  // There is deliberately no per-source retrieval timestamp — GenStudio does
  // not fetch the pages, so one would be falsely precise.
  // GenStudio's own `research_ran_at` wins when the envelope supplied it;
  // `generated_at` (when this app wrote the file) is only the fallback.
  // The model's published NAME or nothing. Never `r.source_model` — that is an
  // internal product handle, and this file is read by people.
  lines.push(`*${researchModeLabel(mode)} · research ran on ${researchRanAt(r.web_run, r.generated_at)}`
    + `${modelLabel ? ` · ${modelLabel}` : ''}*`)
  lines.push('')
  // Provenance, per mode. Model-knowledge output was never checked for the
  // user; web output cites the run, not each claim. Neither may borrow the
  // other's wording.
  lines.push(`*${researchModeNotice(mode, r.citations.length, r.web_run)}*`)
  lines.push('')
  if (mode === 'web-search' && r.web_run) {
    lines.push(`*${webRunUsageSentence(r.web_run)}*`)
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
  } else if (review?.completed_by === 'auto-approval') {
    lines.push(`> **Claims auto-approved** by this project’s "Approve claims automatically" setting${reviewedAt}. `
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
      // An uncited claim means different things per mode. In model-knowledge
      // mode it is the honest "no source cited" marker. In web mode, sources
      // are recorded at RUN level and never mapped to claims, so marking each
      // claim "no source cited" would misreport a run that DID cite sources.
      const refs = c.citation_indices?.length
        ? ` [${c.citation_indices.map(idx => idx + 1).join(', ')}]`
        : mode === 'web-search'
          ? ''
          : ` *(${MODEL_KNOWLEDGE_CLAIM_NOTE.toLowerCase()})*`
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

  lines.push('## Structured citations')
  lines.push('')
  if (!r.citations.length) {
    lines.push(mode === 'web-search'
      ? `None. ${researchModeNotice(mode, r.citations.length, r.web_run)}`
      : 'None. This run used the model’s own knowledge, which cannot cite live sources — it is deliberately '
        + 'not allowed to invent URLs. Find sources yourself for anything specific or recent.')
    lines.push('')
  } else {
    if (mode === 'web-search') {
      const attributed = r.claims.filter(c => c.citation_indices?.length).length
      lines.push(attributed > 0
        // Claims carry a [n] marker above; say what it means and, plainly,
        // that a claim without one is not covered by this list.
        ? `*${attributed} of ${r.claims.length} claims link to the specific sources that back them, `
          + 'shown as [n] against the claim. A claim with no marker carries no citation — these sources '
          + 'do not back it.*'
        : '*These sources back the run as a whole. Individual claims are not linked to specific '
          + 'sources yet.*')
      lines.push('')
    }
    for (let i = 0; i < r.citations.length; i++) {
      const c = r.citations[i]!
      const url = canonicalHttpUrl(c.url)
      const link = url ? `[${escapeMarkdownPlainText(c.title)}](<${url}>)` : escapeMarkdownPlainText(c.title)
      // publisher / published_at are carried through only when the provider
      // actually supplied them — they are not reliable today.
      const attribution = [c.publisher, c.published_at].map(escapeMarkdownPlainText).filter(Boolean).join(', ')
      lines.push(`${i + 1}. ${link}${attribution ? ` — ${attribution}` : ''}`)
      const snippet = escapeMarkdownPlainText(c.snippet)
      if (snippet) lines.push(`   > ${snippet}`)
    }
    lines.push('')
  }

  const sourceUrls = canonicalHttpUrls(r.web_run?.source_urls)
  if (mode === 'web-search' && sourceUrls.length) {
    lines.push('## Pages GenStudio reported retrieving')
    lines.push('')
    lines.push('These are pages the provider reported opening. They are not citations and do not back individual claims.')
    lines.push('')
    for (const url of sourceUrls) lines.push(`- <${url}>`)
    lines.push('')
  }

  return lines.join('\n')
}

function escapeMarkdownPlainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\[\]\(\)`*_]/g, '\\$&')
}

/** The mode a sidecar was produced in. Absent mode + legacy provider both
 *  resolve to model-knowledge — the only route that existed before. */
function readResearchOutputMode(r: ResearchOutput): ResearchMode {
  return r.research_mode
    ? normalizeResearchMode(r.research_mode)
    : researchModeForProvider(r.source_provider)
}
