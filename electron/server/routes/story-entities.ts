/**
 * Episode-owned story entity inventory routes (Episode Visual Setup Phase 1).
 *
 *   GET /api/projects/:slug/story-entities/:episodeId
 *       → { exists, doc, chapters }   (chapters: number | null — see §6)
 *   PUT /api/projects/:slug/story-entities/:episodeId
 *       → { ok: true, exists: true, doc }
 *
 * The PUT is a merge write inside the sidecar lock: omitted fields and
 * unmentioned entities keep their stored values, a malformed payload is a
 * 400 that names the offending entity, and an unknown episode code is a 404
 * before anything touches disk. The folder itself comes from
 * resolveEpisodePathsByCode — the client never names a path.
 */

import { Router } from 'express'
import { respondWithError } from '../lib/humanize-backend-error.js'
import {
  StoryEntitiesEpisodeNotFoundError,
  StoryEntitiesValidationError,
  readStoryEntities,
  writeStoryEntities,
} from '../services/story-entities.js'

export const router = Router()

function knownStatus(e: unknown): e is Error & { statusCode: number } {
  const status = (e as any)?.statusCode
  return e instanceof Error && typeof status === 'number'
}

router.get('/projects/:slug/story-entities/:episodeId', async (req, res) => {
  try {
    res.json(await readStoryEntities(req.params.slug, req.params.episodeId))
  } catch (e: any) {
    if (e instanceof StoryEntitiesValidationError || e instanceof StoryEntitiesEpisodeNotFoundError || knownStatus(e)) {
      return res.status(e.statusCode).json({ detail: e.message })
    }
    respondWithError(res, e, 'Failed to read story context')
  }
})

router.put('/projects/:slug/story-entities/:episodeId', async (req, res) => {
  try {
    const result = await writeStoryEntities(req.params.slug, req.params.episodeId, req.body)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    if (e instanceof StoryEntitiesValidationError || e instanceof StoryEntitiesEpisodeNotFoundError || knownStatus(e)) {
      return res.status(e.statusCode).json({ detail: e.message })
    }
    respondWithError(res, e, 'Failed to save story context')
  }
})
