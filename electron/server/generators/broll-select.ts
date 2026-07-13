import type { Job } from '../models/types.js'
import { pickBrollForEpisode } from '../services/broll-selection.js'
import { requireJobCompletion } from '../services/job-completion.js'

export async function generateBrollSelection(job: Job): Promise<void> {
  const result = await pickBrollForEpisode(job.project_slug, job.episode_id, job.params || {})
  job.output_lines.push(`Selected ${result.count} B-Roll clip(s) for ${job.episode_id}.`)
  for (const warning of result.warnings) job.output_lines.push(`Warning: ${warning}`)
  requireJobCompletion(job, {
    label: 'B-Roll selection', expected: 1, completed: result.count > 0 ? 1 : 0,
    missing: result.count > 0 ? [] : ['at least one usable B-Roll clip'],
    retry_hint: 'Scan or reconnect the selected pool, then retry the selection.',
  })
}
