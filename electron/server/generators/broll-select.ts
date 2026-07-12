import type { Job } from '../models/types.js'
import { pickBrollForEpisode } from '../services/broll-selection.js'

export async function generateBrollSelection(job: Job): Promise<void> {
  const result = await pickBrollForEpisode(job.project_slug, job.episode_id, job.params || {})
  job.output_lines.push(`Selected ${result.count} B-Roll clip(s) for ${job.episode_id}.`)
  for (const warning of result.warnings) job.output_lines.push(`Warning: ${warning}`)
}
