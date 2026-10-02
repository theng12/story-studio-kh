/**
 * Routes for the v1.4.37 music library — a channel's record collection.
 *
 *   GET    /api/projects/:slug/music-library                  — every track
 *   PATCH  /api/projects/:slug/music-library/tracks/:filename — title / enabled / tags
 *   DELETE /api/projects/:slug/music-library/tracks/:filename — remove from disk
 *   POST   /api/projects/:slug/music-library/generate         — top up (SPENDS CREDITS)
 *   POST   /api/projects/:slug/music-library/preview-mix      — what a mix would use (FREE)
 *   POST   /api/projects/:slug/music-library/render           — build the video (FREE)
 *
 * NOT the same thing as `/music-pool`, which stays exactly as it is for the
 * background bed that ducks under narration. Two pages, two jobs, per the
 * owner's ruling — merging the folders would put a narration bed into a mix.
 *
 * ONE ROUTE SPENDS MONEY and it is named for what it does. `preview-mix` and
 * `render` read the library and nothing else, which is what lets the page show
 * a full tracklist and a runtime before anything is committed to.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as im from '../services/idea-manager.js'
import * as lib from '../services/music-library.js'
import { DEFAULT_MIX_RULES, buildMusicMix, renderTracklist, type MixCandidate } from '../services/music-mix.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import type { JobType } from '../models/types.js'

export const router = Router()

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function requireProject(slug: string): Promise<boolean> {
  return !!(await pm.getProject(slug))
}

router.get('/projects/:slug/music-library', async (req, res) => {
  try {
    if (!await requireProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    res.json(await lib.listLibrary(req.params.slug))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not read the music library'))
  }
})

router.patch('/projects/:slug/music-library/tracks/:filename', async (req, res) => {
  try {
    if (!await requireProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const patch: Record<string, unknown> = {}
    if (typeof req.body?.title === 'string') patch.title = req.body.title.trim().slice(0, 200)
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled
    if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.map(String).slice(0, 12)
    await lib.upsertTrackMeta(req.params.slug, req.params.filename, patch)
    res.json(await lib.listLibrary(req.params.slug))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not update the track'))
  }
})

router.delete('/projects/:slug/music-library/tracks/:filename', async (req, res) => {
  try {
    if (!await requireProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    await lib.removeTrack(req.params.slug, req.params.filename)
    res.json(await lib.listLibrary(req.params.slug))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not remove the track'))
  }
})

/**
 * Top up the library. THE ONLY ROUTE HERE THAT SPENDS CREDITS.
 *
 * `count` is how many TRACKS to plan. Each request returns every variation the
 * model produces — measured at two for the published Suno route — so the number
 * of tracks that arrive is usually higher than the number of requests paid for,
 * and every one of them is kept.
 */
router.post('/projects/:slug/music-library/generate', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const brief = String(req.body?.brief || '').trim()
    if (!brief) return res.status(400).json({ detail: 'Describe the sound you want.' })
    const count = Math.max(1, Math.min(100, Math.round(Number(req.body?.count) || 1)))
    const operationId = typeof req.body?.operation_id === 'string' ? req.body.operation_id.trim() : ''
    if (!OPERATION_ID.test(operationId)) return res.status(400).json({ detail: 'operation_id must be a UUID for a music top-up.' })
    const model = String(req.body?.model || '')
    const plannerModel = String(req.body?.planner_model || '')
    const instrumental = req.body?.instrumental !== false
    // Track length for an instrumental model (seconds). A singing model's length follows its lyrics,
    // so a value sent with vocals is simply ignored. Bounded here; the model's own bounds are applied
    // (and explained in the job log) when the job runs.
    const requestedSeconds = Number(req.body?.duration_seconds)
    const durationSeconds = instrumental && Number.isFinite(requestedSeconds) && requestedSeconds > 0
      ? Math.max(10, Math.min(1800, Math.round(requestedSeconds)))
      : undefined
    const sameActionRequest = (candidate: any) => candidate.type === 'music_generate'
      && candidate.params?.generation_action?.id === operationId
      && candidate.params?.brief === brief
      && candidate.params?.count === count
      && candidate.params?.model === model
      && candidate.params?.planner_model === plannerModel
      && candidate.params?.instrumental === instrumental
      && candidate.params?.duration_seconds === durationSeconds
    const actionJobs = (await jq.getJobs(slug)).filter(job =>
      job.type === 'music_generate'
      && job.params?.generation_action?.id === operationId,
    )
    if (actionJobs.length) {
      const existing = actionJobs[0]!
      if (!sameActionRequest(existing)) return res.status(409).json({ detail: 'operation_id already belongs to a different music top-up.' })
      return res.status(201).json({ ...existing, reused: true })
    }
    let job: Awaited<ReturnType<typeof jq.enqueue>>
    try {
      job = await jq.enqueue({
        project_slug: slug,
        type: 'music_generate' as JobType,
        episode_id: '',
        title: `Music library top-up (${count} track${count === 1 ? '' : 's'})`,
        params: {
          brief,
          count,
          model,
          planner_model: plannerModel,
          instrumental,
          ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
          generation_action: { id: operationId, kind: 'fresh' },
          brief_id: operationId,
        },
      })
    } catch (error) {
      if (error instanceof jq.DuplicateJobError) {
        const replay = (await jq.getJobs(slug)).find(candidate =>
          candidate.type === 'music_generate'
          && candidate.params?.generation_action?.id === operationId,
        )
        if (replay && sameActionRequest(replay)) return res.status(201).json({ ...replay, reused: true })
        if (replay) return res.status(409).json({ detail: 'operation_id already belongs to a different music top-up.' })
        return res.status(409).json({ detail: 'A music top-up is already queued or running.' })
      }
      throw error
    }
    res.status(201).json(job)
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not start the music top-up'))
  }
})

/**
 * What a mix WOULD use. Reads the library; buys nothing; changes nothing.
 *
 * This exists so the page can show the whole tracklist, the real runtime, and
 * any shortfall BEFORE the owner commits — the same reasoning as showing a
 * cost before a purchase rather than after it.
 */
router.post('/projects/:slug/music-library/preview-mix', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const targetSeconds = Math.max(60, Math.round(Number(req.body?.target_seconds) || 3600))
    const seed = String(req.body?.episode_id || 'preview')
    const state = await lib.listLibrary(slug)
    const candidates: MixCandidate[] = state.tracks.map(track => ({
      filename: track.filename,
      title: track.title,
      duration_sec: track.duration_sec || 0,
      enabled: track.enabled,
      ...(track.sibling_group ? { sibling_group: track.sibling_group } : {}),
      times_used: track.times_used,
    }))
    const plan = buildMusicMix(candidates, targetSeconds, seed, {
      ...DEFAULT_MIX_RULES,
      siblingGapTracks: Number.isInteger(req.body?.sibling_gap_tracks)
        ? req.body.sibling_gap_tracks
        : DEFAULT_MIX_RULES.siblingGapTracks,
    })
    res.json({ ...plan, tracklist: renderTracklist(plan) })
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not plan the mix'))
  }
})

/** Build the video. Reads the library; buys nothing. */
router.post('/projects/:slug/music-library/render', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const episodeId = String(req.body?.episode_id || '').trim()
    if (!episodeId) return res.status(400).json({ detail: 'Type the episode code this video is for.' })
    // A typo here used to create a stray "<code> - " folder and render into it.
    if (!(await im.getIdeas(slug, 'accepted')).some(idea => idea.episode_code === episodeId)) {
      return res.status(400).json({ detail: `There is no episode ${episodeId} in this project. Check the code (for example EP0001) and try again.` })
    }
    const backgroundPath = String(req.body?.background_path || '').trim()
    if (!backgroundPath) return res.status(400).json({ detail: 'Choose a background for this video.' })
    if (jq.isDuplicate(slug, episodeId, 'music_video' as JobType)) {
      return res.status(409).json({ detail: `A music video is already queued for ${episodeId}` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'music_video' as JobType,
      episode_id: episodeId,
      title: `Music video — ${episodeId} (no credits)`,
      params: {
        episode_id: episodeId,
        target_seconds: Math.max(60, Math.round(Number(req.body?.target_seconds) || 3600)),
        background_path: backgroundPath,
        sibling_gap_tracks: Number.isInteger(req.body?.sibling_gap_tracks)
          ? req.body.sibling_gap_tracks
          : DEFAULT_MIX_RULES.siblingGapTracks,
        crossfade_sec: Number(req.body?.crossfade_sec) || 0,
        description_footer: String(req.body?.description_footer || ''),
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not start the music video'))
  }
})
