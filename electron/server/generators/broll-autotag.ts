/**
 * Compatibility executor for historical B-Roll auto-tag jobs.
 *
 * GenStudio does not yet publish a qualified image-input LLM route. Persisted
 * jobs must therefore fail clearly on restart instead of reviving the retired
 * direct OpenAI or Chat Studio execution path.
 */
import type { Job } from '../models/types.js'

export async function generateBrollAutotag(job: Job): Promise<void> {
  job.output_lines.push('Visual auto-tagging requires a qualified GenStudio KH image-input LLM route.')
  throw new Error('Visual auto-tagging is unavailable. No direct cloud provider or local Studio connection was attempted.')
}
