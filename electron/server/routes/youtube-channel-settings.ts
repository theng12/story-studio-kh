/**
 * Authoritative channel YouTube settings (Item 20): GET/PUT
 * `/projects/:slug/youtube/channel-settings`.
 *
 * Pinned to the project's assigned channel inside the service — the client's
 * `account_id` / `expected_account_id` can only confirm that pin, never pick
 * it. Mount from `routes/index.ts`:
 *
 *   import { router as youtubeChannelSettingsRouter } from './youtube-channel-settings.js'
 *   app.use('/api', youtubeChannelSettingsRouter)
 *
 * Failure shapes, kept distinct on purpose:
 *   200 + `has_connected_account: false`  no channel assigned (honest state)
 *   409 foundation code                   assignment/identity problems
 *   502                                   YouTube itself failed to answer
 *   400                                   this request's own input (e.g. a
 *                                         playlist that is not on the channel)
 */

import { Router } from 'express'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import type { EndScreenConfig } from '../contracts/youtube-channel-settings.js'
import { getChannelSettings, updateChannelSettings } from '../services/upload-playlists.js'

export const router = Router()

/**
 * Same shape as `routes/youtube-connections.ts`: a foundation error answers
 * with its closed `{ code, detail }`, and everything else keeps the repo's
 * humanizer — reading both `statusCode` and `status`, because the two
 * conventions coexist here and reading only one silently turns a 502 into a 500.
 */
function fail(res: import('express').Response, error: unknown, fallback: string): void {
  if (error instanceof YouTubeFoundationError) {
    res.status(error.statusCode).json(error.toPublic())
    return
  }
  const tagged = error as { statusCode?: number; status?: number } | null
  const status = typeof tagged?.statusCode === 'number'
    ? tagged.statusCode
    : typeof tagged?.status === 'number' ? tagged.status : 500
  res.status(status).json(humanizeBackendError(error, fallback))
}

router.get('/projects/:slug/youtube/channel-settings', async (req, res) => {
  try {
    const requested = typeof req.query.account_id === 'string' ? req.query.account_id.trim() : ''
    const force = req.query.force === '1' || req.query.force === 'true'
    const settings = await getChannelSettings(req.params.slug, {
      force,
      ...(requested ? { expectedAccountId: requested } : {}),
    })
    res.json(settings)
  } catch (error) {
    fail(res, error, 'Failed to read the YouTube channel settings.')
  }
})

router.put('/projects/:slug/youtube/channel-settings', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const settings = await updateChannelSettings(req.params.slug, {
      ...(typeof body.expected_account_id === 'string' ? { expected_account_id: body.expected_account_id } : {}),
      ...(typeof body.default_playlist_id === 'string' ? { default_playlist_id: body.default_playlist_id } : {}),
      ...(body.end_screen && typeof body.end_screen === 'object'
        ? { end_screen: body.end_screen as Partial<EndScreenConfig> }
        : {}),
    })
    res.json(settings)
  } catch (error) {
    fail(res, error, 'Failed to save the YouTube channel settings.')
  }
})
