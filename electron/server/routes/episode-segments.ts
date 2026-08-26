/**
 * The Introduction page's API — and, in time, every other positioned segment.
 *
 * v1.4.73. One channel-level answer, read and written here, replacing a
 * per-session checkbox that lived on another page's tab and forgot itself.
 */

import { Router } from 'express'
import {
  getChannelSegments,
  saveChannelSegment,
  hasEverProducedSegment,
} from '../services/channel-segments.js'
import {
  BEAT_LIBRARY,
  SEGMENT_KINDS,
  WORD_TARGET_MAX,
  WORD_TARGET_MIN,
  type ChannelSegment,
} from '../lib/episode-segments.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

/**
 * What the page needs to draw itself.
 *
 * `kinds` travels with the answer so the page never carries its own copy of
 * the segment list — adding a sponsorship segment later must not require
 * editing the page to make it appear.
 *
 * `opening_profile` is the niche's descriptive label, where the niche has
 * one. It is wording only. It used to decide whether this feature existed at
 * all for a channel, which is why it was invisible on seven of ten of them.
 */
router.get('/projects/:slug/segments', async (req, res) => {
  try {
    const segments = await getChannelSegments(req.params.slug)
    let openingProfile: unknown = null
    try {
      const { getEffectiveNiche } = await import('../services/niche-loader.js')
      openingProfile = (await getEffectiveNiche(req.params.slug) as any)?.openingProfile || null
    } catch {
      openingProfile = null
    }
    res.json({
      segments,
      kinds: Object.values(SEGMENT_KINDS),
      // What each beat actually produces, so the page can say so instead of
      // showing seven labels and trusting the reader to guess. It travels with
      // the answer for the same reason `kinds` does: the page keeps no copy,
      // so an explanation improved here is improved everywhere at once.
      beat_library: Object.values(BEAT_LIBRARY),
      opening_profile: openingProfile,
      word_target_min: WORD_TARGET_MIN,
      word_target_max: WORD_TARGET_MAX,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read this channel\'s segments'))
  }
})

router.put('/projects/:slug/segments/:segmentId', async (req, res) => {
  const { slug, segmentId } = req.params
  if (!SEGMENT_KINDS[segmentId]) {
    return res.status(404).json({ detail: `Unknown episode segment: ${segmentId}` })
  }
  const body = req.body || {}
  const patch: Partial<ChannelSegment> = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (body.recipe && typeof body.recipe === 'object') patch.recipe = body.recipe
  try {
    const segments = await saveChannelSegment(slug, segmentId, patch)
    res.json({ segments })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not save this segment'))
  }
})

/**
 * How many episodes already carry this segment, and which do not.
 *
 * The gap this whole change was found through was four episodes with no
 * opening, sitting in a list that had no way of showing it. `status.introduction`
 * has been returned per episode all along and rendered nowhere.
 */
router.get('/projects/:slug/segments/:segmentId/coverage', async (req, res) => {
  const { slug, segmentId } = req.params
  if (!SEGMENT_KINDS[segmentId]) {
    return res.status(404).json({ detail: `Unknown episode segment: ${segmentId}` })
  }
  try {
    res.json({ ever_produced: await hasEverProducedSegment(slug, segmentId) })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not check segment coverage'))
  }
})
