/**
 * The deliberate read-back of what YouTube has scheduled for one channel.
 *
 * No local pacing key is consulted: this route asks YouTube and writes the
 * answer to the channel-schedule store, which the Publishing Overview reads.
 * Agent route: GET /projects/:slug/youtube/schedule-days?from=YYYY-MM-DD&to=YYYY-MM-DD
 * returns one classification per date (on-youtube / planned / free / unknown),
 * with the scheduled count, next slot, free days in the first week, weeks under
 * cadence, ready-and-unscheduled count and last-read time in the same answer.
 */

import { Router } from 'express'

import { registryCredentialFor } from '../lib/youtube-client.js'
import { classifyChannelDates } from '../services/channel-date-classification.js'
import { invalidatePublishingOverviewCache } from '../services/publishing-overview.js'
import { readPublishingOverview } from '../services/publishing-overview.js'
import {
  getProjectYouTubeAssignment,
  readYouTubeConnectionRegistry,
} from '../services/youtube-connection-store.js'
import { refreshYouTubeChannelSchedule } from '../services/youtube-channel-schedule-store.js'

export const router = Router()

router.get('/projects/:slug/youtube/schedule-days', async (req, res) => {
  try {
    const result = await classifyChannelDates(
      req.params.slug, String(req.query.from || ''), String(req.query.to || ''),
    )
    // The ready count is the existing reviewed readiness sweep, not a new guess.
    const overview = await readPublishingOverview().catch(() => null)
    const channel = overview?.channels.find(entry => entry.slug === req.params.slug)
    result.ready_and_unscheduled_count = channel?.readiness.ready_to_publish ?? null
    res.json(result)
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode ?? 500
    res.status(status).json({ detail: error instanceof Error ? error.message : 'Failed to classify channel dates.' })
  }
})

router.post('/projects/:slug/youtube/schedule-refresh', async (req, res) => {
  try {
    const slug = req.params.slug
    const assignment = await getProjectYouTubeAssignment(slug)
    if (!assignment) {
      res.status(409).json({ detail: 'Assign a YouTube channel to this project first.' })
      return
    }
    const registry = await readYouTubeConnectionRegistry()
    const grant = registry.channels[assignment.channel_id]
    if (!grant || !registry.application
      || grant.application_id !== registry.application.application_id || grant.status !== 'connected') {
      res.status(409).json({ detail: 'The assigned YouTube channel needs to be reconnected in Settings → YouTube.' })
      return
    }
    const record = await refreshYouTubeChannelSchedule({
      project_slug: slug,
      account_id: registryCredentialFor(assignment.channel_id),
      channel_id: assignment.channel_id,
    })
    invalidatePublishingOverviewCache()
    res.json(record)
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : 'Failed to read the YouTube schedule.' })
  }
})
