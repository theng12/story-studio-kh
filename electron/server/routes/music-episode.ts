/**
 * Episode Builder routes (SPEC §4–5). Nothing here generates or buys a song.
 *
 *   GET  /projects/:slug/music-episodes                      episodes + pools
 *   POST /projects/:slug/music-episodes                      new episode { title }
 *   GET  /projects/:slug/music-episodes/:code                the builder view
 *   PUT  /projects/:slug/music-episodes/:code                save settings / songs / breaks / prompts
 *   POST /projects/:slug/music-episodes/:code/draw           (re-)draw unlocked songs
 *   POST /projects/:slug/music-episodes/:code/order          re-apply the order mode
 *   GET  /projects/:slug/music-episodes/:code/swap?key=      five closest free songs
 *   GET  /projects/:slug/music-episodes/:code/songs?q=       songs that can be added
 *   POST /projects/:slug/music-episodes/:code/scenes/:id/keep       keep the current picture
 *   POST /projects/:slug/music-episodes/:code/scenes/:id/use-still  use an Image Pool still
 *   POST /projects/:slug/music-episodes/:code/build          stitch + hand to Video Assembly
 *
 * Scene pictures are made through the existing Scene Review routes
 * (`continuity-render`), which fan out across the fleet.
 */

import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as im from '../services/idea-manager.js'
import * as bp from '../services/broll-pool-manager.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { resolveScenePlanPath } from '../services/utils.js'
import { resolveSceneImagesDir } from '../generators/scene-image.js'
import { checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import {
  drawEpisode,
  normalizeEpisodeSettings,
  orderEpisode,
  songKey,
  swapCandidates,
  isUsable,
  type EpisodeSong,
} from '../services/music-episode.js'
import {
  buildEpisodeView,
  channelStartingSettings,
  episodeDirFor,
  keepScenePicture,
  loadEpisodeContext,
  readEpisodeDoc,
  saveEpisodeDoc,
  type MusicEpisodeDoc,
} from '../services/music-episode-store.js'
import { listSongPools } from '../services/music-pool-source.js'
import type { JobType, ScenePlan } from '../models/types.js'

export const router = Router()

class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

async function requireEpisode(slug: string, code: string): Promise<string> {
  if (!await pm.getProject(slug)) throw new HttpError(404, 'Project not found')
  const upper = String(code || '').toUpperCase()
  const idea = (await im.getIdeas(slug, 'accepted')).find(i => (i.episode_code || '').toUpperCase() === upper)
  if (!idea) throw new HttpError(404, `There is no episode ${upper} in this channel.`)
  return upper
}

function fail(res: any, e: any, fallback: string) {
  if (e instanceof HttpError) return res.status(e.statusCode).json({ detail: e.message })
  return res.status(e?.statusCode || 500).json(humanizeBackendError(e, fallback))
}

async function emptyDoc(slug: string, code: string): Promise<MusicEpisodeDoc> {
  return {
    schema_version: 1,
    episode_code: code,
    settings: (await channelStartingSettings(slug)).settings,
    songs: [],
    draw_round: 0,
    scene_breaks: [],
    prompt_overrides: {},
    updated_at: new Date().toISOString(),
  }
}

router.get('/projects/:slug/music-episodes', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const { music_channel, settings } = await channelStartingSettings(slug)
    const episodes = []
    for (const idea of await im.getIdeas(slug, 'accepted')) {
      if (!idea.episode_code) continue
      const doc = await readEpisodeDoc(slug, idea.episode_code).catch(() => null)
      episodes.push({
        code: idea.episode_code,
        title: idea.title,
        has_plan: !!doc,
        songs: doc?.songs.length || 0,
        built_at: doc?.built?.at || null,
        total_sec: doc?.built?.total_sec ?? null,
      })
    }
    res.json({ music_channel, channel_settings: settings, episodes, pools: await listSongPools() })
  } catch (e) {
    fail(res, e, 'Could not list music episodes')
  }
})

router.post('/projects/:slug/music-episodes', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 160) : ''
    if (!title) return res.status(400).json({ detail: 'Give the episode a title.' })
    const [idea] = await im.addIdeas(slug, [{
      title, logline: '', themes: [], suggested_chapters: 1, suggested_length: '', mood: '',
    }], 'episode-builder')
    const accepted = await im.acceptIdea(slug, idea!.id)
    res.status(201).json({ code: accepted.episode_code, title })
  } catch (e) {
    fail(res, e, 'Could not create the episode')
  }
})

router.get('/projects/:slug/music-episodes/:code', async (req, res) => {
  try {
    const code = await requireEpisode(req.params.slug, req.params.code)
    res.json(await buildEpisodeView(req.params.slug, code))
  } catch (e) {
    fail(res, e, 'Could not open the episode')
  }
})

function parseSongs(value: unknown): EpisodeSong[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'songs must be a list.')
  const out: EpisodeSong[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (!row || typeof row.pool_id !== 'string' || typeof row.song_id !== 'string') throw new HttpError(400, 'Each song needs pool_id and song_id.')
    const ref = { pool_id: row.pool_id, song_id: row.song_id, ...(row.locked === true ? { locked: true } : {}) }
    if (seen.has(songKey(ref))) throw new HttpError(400, 'A song can only be in an episode once.')
    seen.add(songKey(ref))
    out.push(ref)
  }
  return out
}

router.put('/projects/:slug/music-episodes/:code', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const doc = (await readEpisodeDoc(slug, code)) ?? await emptyDoc(slug, code)
    const body = req.body || {}
    if (body.settings !== undefined) doc.settings = normalizeEpisodeSettings(body.settings, doc.settings)
    if (body.songs !== undefined) doc.songs = parseSongs(body.songs)
    if (Array.isArray(body.scene_breaks)) doc.scene_breaks = body.scene_breaks.filter((k: unknown) => typeof k === 'string')
    if (body.prompt_overrides && typeof body.prompt_overrides === 'object') {
      for (const [id, prompt] of Object.entries(body.prompt_overrides)) {
        if (!/^ms-[0-9a-f]{12}$/.test(id)) continue
        const text = typeof prompt === 'string' ? prompt.trim().slice(0, 2000) : ''
        if (text) doc.prompt_overrides[id] = text
        else delete doc.prompt_overrides[id]
      }
    }
    const ctx = await loadEpisodeContext(slug, code, doc.settings)
    const unknown = doc.songs.filter(ref => !ctx.byKey.has(songKey(ref)))
    if (body.songs !== undefined && unknown.length) {
      return res.status(400).json({ detail: `${unknown.length} song(s) are not in the selected pools: ${unknown.map(songKey).slice(0, 3).join(', ')}.` })
    }
    await saveEpisodeDoc(slug, doc, ctx.byKey)
    res.json(await buildEpisodeView(slug, code))
  } catch (e) {
    fail(res, e, 'Could not save the episode')
  }
})

router.post('/projects/:slug/music-episodes/:code/draw', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const doc = (await readEpisodeDoc(slug, code)) ?? await emptyDoc(slug, code)
    if (req.body?.settings !== undefined) doc.settings = normalizeEpisodeSettings(req.body.settings, doc.settings)
    // The first draw is seeded by the episode code alone, so a rebuild gives the same
    // draw; every later Re-draw is a new round, so the button really changes something.
    const hadSongs = doc.songs.length > 0
    doc.draw_round = hadSongs ? doc.draw_round + 1 : doc.draw_round
    const ctx = await loadEpisodeContext(slug, code, doc.settings)
    const result = drawEpisode({
      songs: ctx.songs,
      current: doc.songs,
      targetSec: doc.settings.target_length_s,
      seed: `${code}:${doc.draw_round}`,
      theme: doc.settings.theme,
      blocked: ctx.blocked,
      order: doc.settings.order,
      join: doc.settings.join,
    })
    doc.songs = result.songs
    await saveEpisodeDoc(slug, doc, ctx.byKey)
    const view = await buildEpisodeView(slug, code)
    const avg = ctx.songs.filter(isUsable).reduce((sum, s, _i, all) => sum + s.duration_s / all.length, 0) || 225
    res.json({
      ...view,
      draw: {
        shortfall_sec: result.shortfall_sec,
        songs_missing: result.shortfall_sec > 0 ? Math.ceil(result.shortfall_sec / avg) : 0,
        notes: result.notes,
      },
    })
  } catch (e) {
    fail(res, e, 'Could not draw songs')
  }
})

router.post('/projects/:slug/music-episodes/:code/order', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const doc = await readEpisodeDoc(slug, code)
    if (!doc) return res.status(409).json({ detail: 'Draw songs first.' })
    if (req.body?.settings !== undefined) doc.settings = normalizeEpisodeSettings(req.body.settings, doc.settings)
    const ctx = await loadEpisodeContext(slug, code, doc.settings)
    doc.songs = orderEpisode(doc.songs, ctx.songs, doc.settings.order, `${code}:${doc.draw_round}`)
    await saveEpisodeDoc(slug, doc, ctx.byKey)
    res.json(await buildEpisodeView(slug, code))
  } catch (e) {
    fail(res, e, 'Could not re-order the songs')
  }
})

router.get('/projects/:slug/music-episodes/:code/swap', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const doc = await readEpisodeDoc(slug, code)
    if (!doc) return res.status(409).json({ detail: 'Draw songs first.' })
    const ctx = await loadEpisodeContext(slug, code, doc.settings)
    const target = ctx.byKey.get(String(req.query.key || ''))
    if (!target) return res.status(404).json({ detail: 'That song is not in the selected pools any more.' })
    const inEpisode = new Set(doc.songs.map(songKey))
    res.json({ candidates: swapCandidates(target, ctx.songs, inEpisode, ctx.blocked).map(song => ({ ...song, key: songKey(song) })) })
  } catch (e) {
    fail(res, e, 'Could not find songs to swap in')
  }
})

router.get('/projects/:slug/music-episodes/:code/songs', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const doc = (await readEpisodeDoc(slug, code)) ?? await emptyDoc(slug, code)
    const ctx = await loadEpisodeContext(slug, code, doc.settings)
    const q = String(req.query.q || '').trim().toLowerCase()
    const inEpisode = new Set(doc.songs.map(songKey))
    const songs = ctx.songs
      .filter(song => isUsable(song) && !inEpisode.has(songKey(song)))
      .filter(song => !q || [song.title, song.mood, song.ensemble, song.key, ...(song.tags || [])].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => Number(ctx.blocked.has(songKey(a))) - Number(ctx.blocked.has(songKey(b))) || a.plays - b.plays || a.title.localeCompare(b.title))
      .slice(0, 200)
      .map(song => ({ ...song, key: songKey(song), blocked_by: ctx.blocked.get(songKey(song)) || null }))
    res.json({ songs })
  } catch (e) {
    fail(res, e, 'Could not list songs')
  }
})

router.post('/projects/:slug/music-episodes/:code/scenes/:sceneId/keep', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    if (!/^ms-[0-9a-f]{12}$/.test(req.params.sceneId)) return res.status(400).json({ detail: 'Unknown scene.' })
    await keepScenePicture(slug, code, req.params.sceneId)
    res.json(await buildEpisodeView(slug, code))
  } catch (e) {
    fail(res, e, 'Could not keep the picture')
  }
})

router.post('/projects/:slug/music-episodes/:code/scenes/:sceneId/use-still', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const sceneId = req.params.sceneId
    if (!/^ms-[0-9a-f]{12}$/.test(sceneId)) return res.status(400).json({ detail: 'Unknown scene.' })
    const pool = await bp.getPool(String(req.body?.pool_id || ''))
    if (!pool || bp.poolMedia(pool) !== 'image') return res.status(404).json({ detail: 'That Image Pool was not found.' })
    const filename = String(req.body?.filename || '')
    if (!filename || filename !== path.basename(filename)) return res.status(400).json({ detail: 'Pick a still from the pool.' })
    const source = path.join(pool.folder_path, filename)
    if (!existsSync(source)) return res.status(404).json({ detail: `${filename} is not in ${pool.name} any more (is the drive connected?).` })
    const episodeDir = await episodeDirFor(slug, code)
    const planPath = await resolveScenePlanPath(slug, code, episodeDir)
    if (!existsSync(planPath)) return res.status(409).json({ detail: 'Draw songs first.' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
    const scene = plan.scenes.find(s => s.id === sceneId)
    if (!scene) return res.status(404).json({ detail: 'That scene is not in this episode any more. Reload the page.' })
    const outDir = await resolveSceneImagesDir(slug, code, episodeDir)
    await fs.mkdir(outDir, { recursive: true })
    const outPath = path.join(outDir, `${sceneId}.png`)
    const tempPath = path.join(outDir, `.tmp_${sceneId}.png`)
    // A real PNG under the scene's own name, so every reader of `<id>.png` agrees.
    await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', source, '-frames:v', '1', '-update', '1', tempPath])
    await fs.rename(tempPath, outPath)
    await checkpointSceneImage(planPath, sceneId, outPath, scene.visual_prompt, true)
    res.json(await buildEpisodeView(slug, code))
  } catch (e) {
    fail(res, e, 'Could not use that still')
  }
})

router.post('/projects/:slug/music-episodes/:code/build', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = await requireEpisode(slug, req.params.code)
    const doc = await readEpisodeDoc(slug, code)
    if (!doc?.songs.length) return res.status(409).json({ detail: 'Draw songs first.' })
    if (jq.isDuplicate(slug, code, 'music_episode_build' as JobType)) {
      return res.status(409).json({ detail: `${code} is already being stitched.` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'music_episode_build' as JobType,
      episode_id: code,
      title: `Music episode — ${code} (stitch, no credits)`,
      params: { episode_id: code },
    })
    res.status(201).json(job)
  } catch (e) {
    fail(res, e, 'Could not start the stitch')
  }
})
