import fs from 'node:fs/promises'
import type { Job } from '../models/types.js'
import { getConfig } from './project-manager.js'
import { resolveEpisodePathsByCode } from './utils.js'
import { checkpointJobState, findJobs, isCancelled, throwIfPauseRequested } from './job-queue.js'
import { runResearchJob } from '../generators/research.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { hasResearchEvidence } from '../lib/research-verification.js'
import { researchBeforeWritingEnabled } from '../lib/research-before-writing.js'
import { normalizeResearchMode, providerForResearchMode } from './research/index.js'
import { normalizeDomainList } from './research/web-capability.js'

export async function runResearchBeforeWriting(job: Job, {
  run = runResearchJob,
  checkpoint = checkpointJobState,
}: { run?: typeof runResearchJob; checkpoint?: typeof checkpointJobState } = {}): Promise<void> {
  const skip = (reason: string) => job.output_lines.push(`Research before writing skipped: ${reason} Writing continues.`)
  let checkpointPending = false
  try {
    const config = await getConfig(job.project_slug)
    if (!config || !await researchBeforeWritingEnabled(job.project_slug, config)) return
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const { jsonPath } = await resolveResearchPaths(paths.episode_dir, job.episode_id)
    let evidence: unknown
    try { evidence = JSON.parse(await fs.readFile(jsonPath, 'utf8')) } catch { /* absent or malformed is not evidence */ }
    if (hasResearchEvidence(evidence)) {
      job.output_lines.push('Research before writing: using existing evidence and keeping its claim decisions.')
      return
    }
    const previous = job.params.research_before_writing_run || (await findJobs(job.project_slug, candidate =>
      candidate.episode_id === job.episode_id && !!candidate.params.research_before_writing_run,
    ))[0]?.params.research_before_writing_run
    if (previous) {
      skip(previous.state === 'started'
        ? 'The earlier research outcome is not confirmed. Recover it in Research before trying research again.'
        : previous.reason || 'This writing job already attempted research.')
      return
    }
    const active = config.research_last_preset_research || config.research_last_preset
    const preset = (config.research_presets || []).find((item: any) => item.id === active && (!item.type || item.type === 'research' || item.type === 'all'))
    const data = preset?.data || preset
    const form = data?.form || data
    const mode = normalizeResearchMode(form?.research_mode)
    const model = (mode === 'web-search' ? form?.web_model : form?.source_model || form?.model)
    if (typeof model !== 'string' || !model.trim()) {
      skip('Choose a research preset.')
      return
    }
    if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
    throwIfPauseRequested(job.job_id)
    const attempt = {
      state: 'started',
      reason: '',
      params: {
        episode_id: job.episode_id,
        title: job.title,
        topic: job.title || job.episode_id,
        source_provider: providerForResearchMode(mode),
        research_mode: mode,
        model: model.trim(),
        specific_questions: form.specific_questions,
        max_sources: form.max_sources,
        ...(mode === 'web-search' ? {
          allowed_domains: normalizeDomainList(form.allowed_domains),
          blocked_domains: normalizeDomainList(form.blocked_domains),
        } : {}),
        generation_action: { kind: 'fresh', id: `${job.job_id}:research-before-writing` },
      },
    }
    job.params.research_before_writing_run = attempt
    // Persist before the call: a restart must never buy the optional research again.
    checkpointPending = true
    await checkpoint(job)
    checkpointPending = false
    const saved = { result: job.result, progress: job.progress, output_dir: job.output_dir }
    try {
      job.output_lines.push('Research before writing: running the selected research preset…')
      await run(job, attempt.params)
      attempt.state = 'done'
    } catch (error) {
      attempt.state = 'skipped'
      attempt.reason = error instanceof Error ? error.message : String(error)
      skip(attempt.reason)
    } finally {
      Object.assign(job, saved)
    }
    checkpointPending = true
    await checkpoint(job)
    checkpointPending = false
  } catch (error) {
    // An uncertain checkpoint must reach the queue's persistence fence, never a fresh provider call.
    if (checkpointPending || job.params.research_before_writing_run?.state === 'started' || isCancelled(job.job_id)) throw error
    throwIfPauseRequested(job.job_id)
    skip(error instanceof Error ? error.message : String(error))
  }
  if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
  throwIfPauseRequested(job.job_id)
}
