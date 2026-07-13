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

  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf-8')
  job.output_lines.push(`Wrote ${RESEARCH_JSON_FILENAME}`)

  await fs.writeFile(mdPath, renderResearchMarkdown(result), 'utf-8')
  job.output_lines.push(`Wrote ${RESEARCH_MD_FILENAME}`)

  job.output_dir = dir
  const hasUsableResearch = !!result.summary?.trim() || result.claims.some(claim => !!claim.text?.trim())
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
      const refs = c.citation_indices.length
        ? ` [${c.citation_indices.map(idx => idx + 1).join(', ')}]`
        : ''
      lines.push(`${i + 1}. ${c.text}${refs}${conf}`)
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
