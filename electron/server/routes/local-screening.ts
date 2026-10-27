/**
 * Duplicate screening routes.
 *
 * Three surfaces, all under `/api`:
 *
 * - `/local-screening/*` — this Mac's switch, the download/remove, and its
 *   status. App-level: the model is installed once per Mac, not per channel.
 * - `/projects/:slug/local-screening/...` — the two checks, which ARE
 *   per-channel (the vector cache lives in the channel's own folder).
 *
 * Every response says `checked` or `not_checked`, and `not_checked` always
 * carries a `reason` a person can act on. Nothing here refuses anything: a
 * failed check is a message, not a blocked upload.
 */
import express from 'express'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { getConfig, getProjectDir } from '../services/project-manager.js'
import { getIdeas } from '../services/idea-manager.js'
import {
  downloadLocalModel,
  getLocalModelProgress,
  localModelLooksInstalled,
  localModelStatus,
  removeLocalModel,
} from '../services/local-model-store.js'
import { localScreeningSettings, setLocalScreeningSettings } from '../services/local-screening-settings.js'
import {
  describeTitleMatch,
  screenEpisodeScenes,
  screenTitle,
  type ExistingTitle,
} from '../services/local-duplicate-screening.js'
import { LOCAL_EMBEDDING_MODEL } from '../contracts/local-duplicate-screening.js'
import { readEpisodeScenes } from '../services/local-screening-episode-reader.js'
import { resolveRecentEpisodeSceneScreens } from '../services/local-screening-episode-feed.js'

export const router = express.Router()

// ── This Mac ───────────────────────────────────────────────────────────────

/**
 * The whole state of the feature on this machine, in one read: the switch, the
 * download's progress, and whether the files verified.
 *
 * One endpoint rather than three so the page cannot show "on" beside "not
 * installed" for a moment and look broken.
 */
router.get('/local-screening', async (_req, res) => {
  try {
    const [settings, status, progress] = await Promise.all([
      localScreeningSettings(),
      localModelStatus(),
      Promise.resolve(getLocalModelProgress()),
    ])
    res.json({
      settings,
      status,
      progress,
      model_id: LOCAL_EMBEDDING_MODEL.model_id,
      onnx_repo: LOCAL_EMBEDDING_MODEL.onnx_repo,
      license: LOCAL_EMBEDDING_MODEL.license,
    })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not read the duplicate-screening status'))
  }
})

router.put('/local-screening', async (req, res) => {
  try {
    const body = req.body || {}
    const patch: Record<string, boolean> = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.compare_recent_episodes === 'boolean') patch.compare_recent_episodes = body.compare_recent_episodes
    if (!Object.keys(patch).length) {
      return res.status(400).json({ detail: 'Send enabled and/or compare_recent_episodes as booleans.' })
    }
    const settings = await setLocalScreeningSettings(patch)
    res.json({ settings, status: await localModelStatus() })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not save the duplicate-screening setting'))
  }
})

router.post('/local-screening/download', async (_req, res) => {
  try {
    // Already here? The hash-verified status is what an install IS, so this
    // route is one of the few places the full check belongs.
    if (await localModelLooksInstalled()) {
      return res.json({ ok: true, status: await localModelStatus(), already_installed: true })
    }
    const installed = await downloadLocalModel()
    res.json({ ok: true, status: installed })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'The screening model could not be downloaded'))
  }
})

router.get('/local-screening/download-progress', async (_req, res) => {
  res.json(getLocalModelProgress())
})

router.post('/local-screening/remove', async (_req, res) => {
  try {
    const result = await removeLocalModel()
    res.json({ ok: result.problems.length === 0, ...result, status: await localModelStatus() })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'The screening model could not be removed'))
  }
})

// ── Per-channel checks ─────────────────────────────────────────────────────

/**
 * Near-duplicate scenes in one episode.
 *
 * Returns `not_checked` for every scene — never an empty "all clear" — when the
 * switch is off, the model is not installed, or the encoder failed. The reason
 * travels with it.
 */
router.get('/projects/:slug/local-screening/scenes/:episodeCode', async (req, res) => {
  const { slug, episodeCode } = req.params
  try {
    const settings = await localScreeningSettings()
    if (!settings.enabled) {
      return res.json({ state: 'not_checked', reason: 'Duplicate screening is off for this Mac.', results: [] })
    }
    // The CHEAP check on a hot path. `localModelStatus` hashes all ~1 GB to
    // prove the files are intact, which is right once (on the Settings page)
    // and wrong on every Scene Review load: the worker gets its vector or its
    // error either way, so a corrupt file still ends up as "not checked".
    if (!(await localModelLooksInstalled())) {
      return res.json({ state: 'not_checked', reason: 'The screening model has not been downloaded yet.', results: [] })
    }

    const projectDir = getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
    const scenes = await readEpisodeScenes(slug, episodeCode.toUpperCase())
    if (!scenes.length) {
      // No plan, no scenes: say so rather than returning an empty list that a
      // caller could read as "nothing to flag" (§6).
      return res.json({
        state: 'not_checked',
        reason: 'This episode has no scene plan yet, so there are no scenes to compare.',
        results: [],
      })
    }

    const recentEpisodes = settings.compare_recent_episodes
      ? await resolveRecentEpisodeSceneScreens(slug, episodeCode).catch(() => [])
      : []

    const results = await screenEpisodeScenes({
      projectDir,
      revision: LOCAL_EMBEDDING_MODEL.revision,
      episodeCode: episodeCode.toUpperCase(),
      scenes,
      recentEpisodes,
    })

    const checked = results.some(result => result.state === 'checked')
    res.json({
      state: checked ? 'checked' : 'not_checked',
      reason: checked ? undefined : results.find(result => result.reason)?.reason,
      results,
    })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not screen this episode’s scenes'))
  }
})

/**
 * Does this title repeat one the channel has?
 *
 * Advises; never refuses. The candidate is passed in rather than read from a
 * draft so the same check works for a typed title, a generated idea, and a
 * campaign batch.
 */
router.post('/projects/:slug/local-screening/title', async (req, res) => {
  const { slug } = req.params
  try {
    const candidate = String((req.body || {}).title || '').trim()
    if (!candidate) return res.status(400).json({ detail: 'Send the title to check.' })

    const settings = await localScreeningSettings()
    if (!settings.enabled) {
      return res.json({ state: 'not_checked', matches: [], reason: 'Duplicate screening is off for this Mac.' })
    }
    if (!(await localModelLooksInstalled())) {
      return res.json({ state: 'not_checked', matches: [], reason: 'The screening model has not been downloaded yet.' })
    }

    const existing = await channelExistingTitles(slug)
    const projectDir = getProjectDir(slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
    // The channel's own title formula, read live (§1) — the same two keys the
    // Ideas page writes (see `TITLE_PREFIX_KEY` / `TITLE_SUFFIX_KEY` there).
    const config = await getConfig(slug).catch(() => null)
    const result = await screenTitle({
      projectDir,
      revision: LOCAL_EMBEDDING_MODEL.revision,
      candidate,
      existing,
      prefix: stringSetting(config, 'broll_channel_title_prefix'),
      suffix: stringSetting(config, 'broll_channel_title_suffix'),
    })
    res.json({ ...result, messages: result.matches.map(describeTitleMatch) })
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not check that title'))
  }
})

/** A channel config value that should be a string, or '' when it is anything else. */
function stringSetting(config: unknown, key: string): string {
  const value = (config as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Every title this channel already carries: its ideas and its accepted
 * episodes.
 *
 * Read fresh, so a title accepted a minute ago is in the pool. Formula titles
 * are included as they are — `screenTitle` strips the channel's formula before
 * comparing, which is the point.
 */
async function channelExistingTitles(slug: string): Promise<ExistingTitle[]> {
  const ideas = await getIdeas(slug).catch(() => [])
  const titles: ExistingTitle[] = []
  for (const idea of ideas || []) {
    if (!idea?.title) continue
    titles.push({ idea_id: idea.id, episode_code: idea.episode_code || undefined, title: idea.title })
  }
  return titles
}
