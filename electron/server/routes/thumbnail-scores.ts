/**
 * Thumbnail scoring routes — run the scoring, and read the record.
 *
 *   POST /projects/:slug/episodes/:code/thumbnail-scores  → score the candidates now
 *   GET  /projects/:slug/episodes/:code/thumbnail-scores  → the record
 *
 * The POST exists so Production can run it on an EXISTING episode for a trial —
 * an episode rendered before this feature existed has no record until somebody
 * asks for one.
 *
 * A failed scoring run is NOT a failed request. It answers 200 with the
 * record, whose candidates read "not scored" and carry the reason. The
 * thumbnail step never fails over scoring and an upload is never held by it
 * (AGENTS §8).
 */
import { Router } from 'express'

import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { listUploadThumbnails } from '../lib/upload-metadata.js'
import { listChatModels, chatImageEligibility } from '../lib/genstudio-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { readSelectedThumbnail } from '../services/upload-overrides.js'
import {
  readThumbnailScoreRecord,
  runThumbnailScoring,
  thumbnailScoreEpisodeDir,
} from '../services/thumbnail-scoring.js'

export const router = Router()

/**
 * The models that may score thumbnails.
 *
 * Free only: the owner approved this feature as free, and a paid model is
 * never picked on its own. A row that does not publish `chargeable` is not
 * known to be free, so it is not offered — an unknown price is not a free
 * price (§6).
 */
router.get('/projects/:slug/thumbnail-scores/vision-models', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const apiKey = await getApiKey('genstudio')
    if (!apiKey) return res.status(400).json({ detail: 'Add a Gateway API Key first.' })
    const rows = await listChatModels(apiKey)
    const models = rows
      .filter(row => row.available === true && row.locked !== true && row.qualification_only === false)
      .map(row => ({ row, eligibility: chatImageEligibility(row) }))
      .filter(entry => entry.eligibility.eligible)
      .filter(entry => entry.row.chargeable === false)
      .map(({ row }) => ({
        id: row.id,
        display_name: row.display_name || row.id,
        // §2 — shown wherever the catalogue publishes it, never used to route.
        provider_name: row.provider_name,
        provider_id: row.provider_id,
        structured_output_mode: row.structured_output_mode,
      }))
    res.json({
      models,
      reason: models.length
        ? null
        : 'No free Gateway model publishes image input right now, so thumbnails cannot be scored.',
    })
  } catch (error: any) {
    res.status(502).json(humanizeBackendError(error, 'Could not load Gateway vision models'))
  }
})

/** The episode's title — what the model judges the picture against. */
async function episodeTitle(slug: string, code: string): Promise<string> {
  const idea = (await im.getIdeas(slug, 'accepted').catch(() => []))
    .find(i => (i.episode_code || '').toUpperCase() === code.toUpperCase())
  return idea?.title || ''
}

/** The record, with the pick and the candidates in the picker's order. */
router.get('/projects/:slug/episodes/:code/thumbnail-scores', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const title = await episodeTitle(slug, code)
    const episodeDir = await thumbnailScoreEpisodeDir(slug, code, title)
    const record = await readThumbnailScoreRecord(episodeDir, code)
    res.json({ record, episode_code: code })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read the thumbnail scores'))
  }
})

/**
 * Score the episode's candidates now.
 *
 * Answers 200 whatever happened: a failure to score is recorded as "not
 * scored" with a reason, never as a failed request. A caller that wanted the
 * scores reads them from the record either way.
 */
router.post('/projects/:slug/episodes/:code/thumbnail-scores', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const title = await episodeTitle(slug, code)
    const config = await pm.getConfig(slug)
    const options = await listUploadThumbnails({ slug, episode_code: code, fallback_title: title, platform: 'youtube' })
    if (!options.length) {
      return res.status(200).json({
        record: { schema: 1, episode_code: code, scored_at: '', candidates: {} },
        picked: '',
        summary: 'This episode has no thumbnail artwork to score.',
        not_scored: true,
      })
    }
    const pinned = await readSelectedThumbnail(slug, code, title, 'youtube').catch(() => null)

    const run = await runThumbnailScoring({
      slug,
      episodeCode: code,
      fallbackTitle: title,
      candidates: options.map(option => ({ filename: option.filename, path: option.path })),
      title,
      config,
      pinned,
    })

    res.json({
      record: run.record,
      picked: run.pick,
      summary: run.summary,
      not_scored: run.notScored,
    })
  } catch (e: any) {
    // A crash here is still not a failed thumbnail step. The record stays as
    // it was, and the caller is told plainly that nothing was scored.
    res.status(200).json({
      record: null,
      picked: '',
      summary: `The thumbnails were not scored (${e?.message || 'unknown error'}).`,
      not_scored: true,
    })
  }
})
