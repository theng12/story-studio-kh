/**
 * The thumbnail-scoring job.
 *
 * It scores one episode's thumbnail candidates and records the scores beside
 * the thumbnails. The owner approved this design (2026-11-01).
 *
 * What it must keep:
 *
 *   - **It never fails the episode.** A scoring run that cannot score records
 *     `not_scored` with a reason and finishes. It never fails the thumbnail
 *     step and never holds an upload (AGENTS §8).
 *   - **It spends nothing unless the channel named a free model.** A paid
 *     model is never picked on its own; a channel that names a paid one is
 *     told so and nothing is scored.
 *   - **A human pin always wins** and is never overwritten.
 */
import type { Job } from '../models/types.js'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import { listUploadThumbnails } from '../lib/upload-metadata.js'
import { readSelectedThumbnail } from '../services/upload-overrides.js'
import { runThumbnailScoring } from '../services/thumbnail-scoring.js'

/**
 * Score one episode's thumbnail candidates.
 *
 * NEVER throws. Every failure is recorded and reported in the job's log, and
 * the job ends `done` — a scoring run that could not score is not a failed
 * episode.
 */
export async function generateThumbnailScores(job: Job): Promise<void> {
  const slug = job.project_slug
  const episodeCode = job.episode_id || ''
  const config = await pm.getConfig(slug)
  if (!config) {
    job.output_lines.push('Thumbnails were not scored: this channel’s settings could not be read.')
    return
  }
  const title = (await im.getIdeas(slug, 'accepted').catch(() => []))
    .find(idea => (idea.episode_code || '').toUpperCase() === episodeCode.toUpperCase())?.title || ''

  const options = await listUploadThumbnails({
    slug, episode_code: episodeCode, fallback_title: title, platform: 'youtube',
  }).catch(() => [])
  if (!options.length) {
    job.output_lines.push('Thumbnails were not scored: this episode has no thumbnail artwork.')
    return
  }

  const pinned = await readSelectedThumbnail(slug, episodeCode, title, 'youtube').catch(() => null)
  const run = await runThumbnailScoring({
    slug,
    episodeCode,
    fallbackTitle: title,
    candidates: options.map(option => ({ filename: option.filename, path: option.path })),
    title,
    config,
    pinned,
  })
  job.output_lines.push(run.summary)
  for (const candidate of Object.values(run.record.candidates || {})) {
    if (candidate.state === 'scored') {
      job.output_lines.push(`— ${candidate.filename}: score ${candidate.score} — ${candidate.reason}`
        + (candidate.text_issue ? ` (text: ${candidate.text_issue})` : ''))
    } else if (candidate.state === 'rejected_by_rule') {
      job.output_lines.push(`— ${candidate.filename}: set aside by a local rule — ${candidate.reason}`)
    } else {
      job.output_lines.push(`— ${candidate.filename}: not scored — ${candidate.reason}`)
    }
  }
  job.result = { picked: run.pick, scored: run.record.scored_at, not_scored: run.notScored }
}
