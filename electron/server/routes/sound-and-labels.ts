/**
 * Sound & Labels — ONE page's backend (v1.4.365).
 *
 * This file is the surviving half of two routers. `routes/contextual-cues.ts`
 * remains mounted because the `contextual_cues` JOB lives there and queued
 * jobs and the history still name it; every page-facing route it used to serve
 * moved here, so the two halves read the same plan, the same captions and the
 * same re-anchor rules in one response.
 *
 * Why one route instead of two:
 *
 *   - The old pair each answered "is this episode ready?" from a DIFFERENT
 *     rule, and the sound half's PUT returned `validation: []` while its GET
 *     validated with `requireResolved` — so a page said "ready" for a cue the
 *     renderer would refuse. One read cannot drift from itself.
 *   - Both halves now carry a scene + word anchor and must be re-timed against
 *     the same plan. Deriving them in two reads would let one move and the
 *     other not.
 *
 * What did NOT move: file names (`contextual_cues.json`, `sound_design.json`),
 * the schema a v1 file reads as, the two preset types, and the two project
 * config keys (`contextual_cues.enabled`, `sound_design.enabled`). Nothing on
 * disk is rewritten to compensate for this merge (AGENTS.md §5, trap 2).
 */
import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import {
  DEFAULT_CONTEXTUAL_CUE_CONFIG,
  normalizeContextualCueConfig,
  normalizeContextualCueProposalSettings,
  normalizeContextualCueTemplate,
  normalizeCuePlacement,
  normalizeCuePositionPair,
  readContextualCueProgress,
  readContextualCueTimeline,
  resolveRenderableContextualCues,
  validateContextualCueTimeline,
  writeContextualCueTimeline,
} from '../services/contextual-cues.js'
import {
  DEFAULT_SOUND_DESIGN_CONFIG,
  normalizeSoundDesignConfig,
  normalizeSoundDesignCredit,
  normalizeSoundDesignSettings,
  readSoundDesignTimeline,
  resolveRenderableSoundCues,
  validateSoundDesignTimeline,
  writeSoundDesignTimeline,
} from '../services/sound-design.js'
import {
  describeAnchorMoves,
  persistReanchoredLabels,
  persistReanchoredSounds,
  readAnchoredEpisodeCues,
} from '../services/sound-cue-anchors.js'
import { stitchedSrtPath } from '../services/subtitle-correction.js'
import type { ContextualCue, ContextualCueTimeline, ScenePlan, SoundDesignCue, SoundDesignTimeline } from '../models/types.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

/** The two project switches, as the page reads them on load. */
router.get('/projects/:slug/sound-and-labels/config', async (req, res) => {
  const current = await pm.getConfig(req.params.slug)
  if (!current) return res.status(404).json({ detail: 'Project not found' })
  res.json({
    on_screen_text: normalizeContextualCueConfig(current.contextual_cues).enabled,
    sound: normalizeSoundDesignConfig(current.sound_design).enabled,
  })
})

/** The two project switches. Same two keys, same two files — nothing rewritten. */
router.put('/projects/:slug/sound-and-labels/config', async (req, res) => {
  const slug = req.params.slug
  const current = await pm.getConfig(slug)
  if (!current) return res.status(404).json({ detail: 'Project not found' })
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
  // Each switch writes ONLY its own key, and only when the caller named it, so
  // flipping one cannot blank the other's stored value.
  const patch: Record<string, unknown> = {}
  if ('on_screen_text' in body) patch.contextual_cues = { ...normalizeContextualCueConfig(current.contextual_cues), enabled: body.on_screen_text === true }
  if ('sound' in body) patch.sound_design = { ...normalizeSoundDesignConfig(current.sound_design), enabled: body.sound === true }
  if (!Object.keys(patch).length) return res.status(400).json({ detail: 'Name on_screen_text or sound.' })
  if (!await pm.updateConfig(slug, patch as any)) return res.status(404).json({ detail: 'Project not found' })
  const next = await pm.getConfig(slug)
  res.json({
    on_screen_text: normalizeContextualCueConfig(next?.contextual_cues).enabled,
    sound: normalizeSoundDesignConfig(next?.sound_design).enabled,
  })
})

/**
 * A page read reports what would be refused; it never throws for it.
 *
 * The failure message is kept verbatim so the page can show the renderer's own
 * sentence beside the row at fault, rather than a second, differently-worded
 * opinion of its own.
 */
function asReport<T extends { cues: unknown[]; skipped: unknown[] }>(resolve: () => T): { cues: any[]; skipped: any[]; refuses?: string } {
  try {
    return resolve()
  } catch (error: any) {
    // The reason is a sentence naming each cue at fault, so the page can still
    // put it beside the row. Nothing is rendered by a read; the renderer makes
    // the same refusal for itself.
    return { cues: [], skipped: [], refuses: String(error?.message || 'These items cannot be drawn or mixed yet.') }
  }
}

/** Both halves of one episode, at one instant, against one plan. */
async function loadEpisode(slug: string, episodeId: string) {
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('Build Scene Plan before working with on-screen text or sound.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  if (!plan.scenes?.length) throw new Error('This episode has no Scene Plan scenes to place text or sound on. Build Scene Plan first.')
  const config = await pm.getConfig(slug)
  const cueConfig = normalizeContextualCueConfig(config?.contextual_cues)
  const soundConfig = normalizeSoundDesignConfig(config?.sound_design)
  const anchored = await readAnchoredEpisodeCues(
    planPath, plan, stitchedSrtPath(paths.subtitles_dir, episodeId),
  )
  return { paths, planPath, plan, cueConfig, soundConfig, anchored }
}

/**
 * The scopes a sound picker draws from.
 *
 * `gateway` is the Gateway's shared library (Openverse, CC0-first). `offline`
 * is the distinct thing the old route got wrong: it silently skipped every
 * pool that was not online, so a page with a disconnected SSD showed an EMPTY
 * picker and then said "approved" — the customer's own library looked gone.
 * Now the page is told, so it can say which folder is unavailable.
 */
router.get('/projects/:slug/sound-and-labels/:episodeId', async (req, res) => {
  try {
    const { plan, cueConfig, soundConfig, anchored } = await loadEpisode(req.params.slug, req.params.episodeId)
    const { labels, sounds } = anchored
    // A read REPORTS; it never refuses. `resolveRenderable*` throws for exactly
    // the defects the renderer throws for, and the page has to be able to show
    // the row that caused one — a 400 here would hide the very thing that needs
    // fixing. The renderer still refuses, from the same rule.
    const label = asReport(() => resolveRenderableContextualCues(cueConfig, labels, plan))
    const sound = asReport(() => resolveRenderableSoundCues(soundConfig, sounds, plan))
    res.json({
      config: { on_screen_text: cueConfig.enabled, sound: soundConfig.enabled },
      // Whole timelines, every status. The page edits them; the renderer uses
      // the two resolved lists below.
      labels, sounds,
      // ONE readiness answer, derived exactly as Video Assembly derives it, so
      // the page and the renderer can never disagree about what is missing.
      readiness: {
        labels: { will_render: label.cues.length, skipped: label.skipped, refuses: label.refuses },
        sound: { will_mix: sound.cues.length, skipped: sound.skipped, refuses: sound.refuses },
      },
      // What the last read moved because a Scene Plan re-run moved its scene.
      moved: anchored.moves,
      moved_notes: describeAnchorMoves(anchored.moves),
      // Full validation, including warnings, for the rows themselves.
      validation: {
        labels: labels ? validateContextualCueTimeline(labels, plan, { subtitles: { enabled: false } as any }) : [],
        sound: sounds ? validateSoundDesignTimeline(sounds, plan, sounds.settings, { requireResolved: false }) : [],
      },
      // `scene_index` is 1-based position and is RECOMPUTED from the order,
      // never taken on faith: a hand-edited or pre-v1 plan may not carry it, and
      // "Scene undefined" is not a scene name.
      scenes: plan.scenes.map((scene, index) => ({
        id: scene.id,
        scene_index: Number.isInteger(scene.scene_index) ? scene.scene_index : index + 1,
        start_sec: scene.start_sec,
        end_sec: scene.end_sec,
        transcript_segment: typeof scene.transcript_segment === 'string' ? scene.transcript_segment : '',
      })),
      subtitles: anchored.subtitles,
    })
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not load Sound & Labels for this episode.'))
  }
})

/** Accept a moved cue so the stored seconds stop disagreeing with the anchors. */
router.post('/projects/:slug/sound-and-labels/:episodeId/accept-moves', async (req, res) => {
  try {
    const { planPath, plan, anchored } = await loadEpisode(req.params.slug, req.params.episodeId)
    const beforeLabels = await readContextualCueTimeline(planPath)
    const beforeSounds = await readSoundDesignTimeline(planPath)
    if (anchored.labels && beforeLabels) await persistReanchoredLabels(planPath, beforeLabels, anchored.labels)
    if (anchored.sounds && beforeSounds) await persistReanchoredSounds(planPath, beforeSounds, anchored.sounds)
    res.json({ moved_notes: describeAnchorMoves(anchored.moves) })
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not save the re-placed text and sound.'))
  }
})

// ── On-screen text (labels) ────────────────────────────────────────────────

router.put('/projects/:slug/sound-and-labels/:episodeId/labels', async (req, res) => {
  try {
    const { planPath, plan } = await loadEpisode(req.params.slug, req.params.episodeId)
    const raw = Array.isArray(req.body?.cues) ? req.body.cues : null
    if (!raw) return res.status(400).json({ detail: 'cues array is required.' })
    const now = new Date().toISOString()
    const cues = raw.map((cue: any): ContextualCue => ({
      ...cue,
      id: String(cue.id || ''), scene_id: String(cue.scene_id || ''),
      ...(typeof cue.anchor_word === 'string' && cue.anchor_word.trim() ? { anchor_word: cue.anchor_word.trim().slice(0, 80) } : {}),
      ...(typeof cue.anchor_offset_sec === 'number' && Number.isFinite(cue.anchor_offset_sec) && cue.anchor_offset_sec >= 0
        ? { anchor_offset_sec: Math.min(600, cue.anchor_offset_sec) } : {}),
      title: String(cue.title || '').trim(),
      ...(typeof cue.subtitle === 'string' && cue.subtitle.trim() ? { subtitle: cue.subtitle.trim() } : {}),
      start_sec: Number(cue.start_sec), end_sec: Number(cue.end_sec),
      kind: cue.kind === 'location_date' || cue.kind === 'person' || cue.kind === 'chapter' ? cue.kind : 'historical_context',
      placement: normalizeCuePlacement(cue.placement),
      ...normalizeCuePositionPair(cue.position_x_pct, cue.position_y_pct),
      ...(cue.target_x_pct != null || cue.target_y_pct != null ? (() => {
        const target = normalizeCuePositionPair(cue.target_x_pct, cue.target_y_pct)
        return { target_x_pct: target.position_x_pct, target_y_pct: target.position_y_pct }
      })() : {}),
      template: normalizeContextualCueTemplate(cue.template), entrance: cue.entrance === 'slide' || cue.entrance === 'dissolve' ? cue.entrance : 'fade',
      exit: cue.exit === 'slide' || cue.exit === 'dissolve' ? cue.exit : 'fade',
      status: cue.status === 'approved' || cue.status === 'disabled' ? cue.status : 'proposed',
      created_at: typeof cue.created_at === 'string' ? cue.created_at : now, updated_at: now,
    }))
    // A hold reason stays with its cue while that cue is still awaiting review.
    const stillProposed = new Set(cues.filter((cue: ContextualCue) => cue.status === 'proposed').map((cue: ContextualCue) => cue.id))
    const holds = ((await readContextualCueTimeline(planPath))?.auto_approval_holds || []).filter(hold => stillProposed.has(hold.cue_id))
    const timeline: ContextualCueTimeline = {
      schema_version: 2, generated_at: now, source_scene_plan_generated_at: plan.generated_at, cues,
      ...(holds.length ? { auto_approval_holds: holds } : {}),
    }
    const issues = validateContextualCueTimeline(timeline, plan)
    // Only a defect that makes the label UNRENDERABLE refuses the save. An
    // unreviewed cue, a long hold and a caption-overlap warning all belong to
    // the reviewer and come back with the saved timeline so the page can show
    // them beside the row — they are not the app's business to block an edit.
    const blocking = issues.filter(issue => issue.severity !== 'warning'
      && (!issue.cue_id || /timing is invalid|inside its scene timing|readable for at least|treatment is invalid|placement is invalid|empty or too long/.test(issue.detail)))
    if (blocking.length) return res.status(422).json({ detail: 'Cue timeline is not safe to save.', issues: blocking })
    await writeContextualCueTimeline(planPath, timeline)
    res.json({ timeline, validation: issues })
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not save on-screen text.'))
  }
})

// ── Sound ──────────────────────────────────────────────────────────────────

function normalizeCue(cue: any, now: string): SoundDesignCue {
  return {
    id: String(cue.id || ''),
    kind: cue.kind === 'bed' ? 'bed' : 'spot',
    label: String(cue.label || '').trim(),
    ...(typeof cue.scene_id === 'string' && cue.scene_id ? { scene_id: cue.scene_id } : {}),
    ...(typeof cue.anchor_word === 'string' && cue.anchor_word.trim() ? { anchor_word: cue.anchor_word.trim().slice(0, 80) } : {}),
    ...(typeof cue.anchor_offset_sec === 'number' && Number.isFinite(cue.anchor_offset_sec) && cue.anchor_offset_sec >= 0
      ? { anchor_offset_sec: Math.min(600, cue.anchor_offset_sec) } : {}),
    start_sec: Number(cue.start_sec),
    ...(cue.kind === 'bed' ? { end_sec: Number(cue.end_sec) } : {}),
    source: cue.source === 'gateway' ? 'gateway' : 'pool',
    ...(typeof cue.pool_id === 'string' && cue.pool_id ? { pool_id: cue.pool_id } : {}),
    clip: String(cue.clip || ''),
    // Credits are stored as the clip published them. Nothing derives one.
    ...(normalizeSoundDesignCredit(cue.credit) ? { credit: normalizeSoundDesignCredit(cue.credit) } : {}),
    gain_db: Number(cue.gain_db),
    status: cue.status === 'approved' || cue.status === 'excluded' || cue.status === 'matched' ? cue.status : 'proposed',
    created_at: typeof cue.created_at === 'string' ? cue.created_at : now,
    updated_at: now,
  }
}

router.put('/projects/:slug/sound-and-labels/:episodeId/sounds', async (req, res) => {
  try {
    const { planPath, plan } = await loadEpisode(req.params.slug, req.params.episodeId)
    const raw = Array.isArray(req.body?.cues) ? req.body.cues : null
    if (!raw) return res.status(400).json({ detail: 'cues array is required.' })
    const now = new Date().toISOString()
    const cues = raw.map((cue: any) => normalizeCue(cue, now))
    const timeline: SoundDesignTimeline = {
      schema_version: 2,
      generated_at: now,
      source_scene_plan_generated_at: plan.generated_at,
      settings: normalizeSoundDesignSettings(req.body?.settings),
      cues,
    }
    const issues = validateSoundDesignTimeline(timeline, plan, timeline.settings)
    // Only an unrenderable mixing defect refuses. Everything else — an
    // unreviewed cue, an excluded row with stale times, a missing pick — is a
    // note on the row, and the save stores the reviewer's edit. That is the
    // 422 that made an excluded cue impossible even to delete.
    const blocking = issues.filter(issue => issue.severity !== 'warning')
    if (blocking.length) return res.status(422).json({ detail: 'Sound timeline is not safe to save.', issues: blocking })
    await writeSoundDesignTimeline(planPath, timeline)
    res.json({ timeline, validation: issues })
  } catch (error: any) {
    res.status(400).json(humanizeBackendError(error, 'Could not save sound.'))
  }
})

// ── Pickers ────────────────────────────────────────────────────────────────

/**
 * The sounds a row can choose from, with the reason each source has no clips.
 *
 * `unavailable` is the fix for "the picker was empty and the page still said
 * approved": a pool that is offline is REPORTED, not silently filtered out.
 */
router.get('/projects/:slug/sound-and-labels/:episodeId/sounds/available', async (req, res) => {
  try {
    const pools = await import('../services/broll-pool-manager.js')
    const clips: Array<{ source: 'pool'; pool_id: string; filename: string; tags: string[] }> = []
    const unavailable: Array<{ id: string; name: string; reason: string }> = []
    for (const pool of await pools.listPools()) {
      if (pools.poolMedia(pool) !== 'audio') continue
      if (!(await pools.isPoolOnline(pool.id))) {
        unavailable.push({ id: pool.id, name: pool.name || pool.id, reason: 'its folder is not reachable right now (external drive unplugged?)' })
        continue
      }
      for (const clip of await pools.listClips(pool.id, { includeMissing: false })) {
        clips.push({ source: 'pool', pool_id: pool.id, filename: clip.filename, tags: clip.tags || [] })
      }
    }
    res.json({ pool_clips: clips, unavailable })
  } catch (error: any) {
    res.status(500).json({ detail: error?.message || 'Could not list local sound files.' })
  }
})

/**
 * One pool clip's bytes, so a row can be PLAYED before it is approved.
 *
 * There was no play button at all — the only way to know what a file sounded
 * like was to approve it and render the episode.
 */
router.get('/projects/:slug/sound-and-labels/sounds/pool-audio/:poolId/:filename', async (req, res) => {
  try {
    const pools = await import('../services/broll-pool-manager.js')
    const pool = await pools.getPool(req.params.poolId)
    if (!pool) return res.status(404).json({ detail: `That sound folder is no longer registered.` })
    const safe = path.basename(req.params.filename)
    const abs = path.join(pool.folder_path, safe)
    if (!existsSync(abs)) return res.status(404).json({ detail: 'That sound file is not on disk right now.' })
    const AUDIO_MIME: Record<string, string> = {
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    }
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Type', AUDIO_MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Accept-Ranges', 'none')
    const fsMod = await import('fs')
    fsMod.createReadStream(abs).pipe(res)
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not play that sound file.'))
  }
})

/**
 * The Gateway's shared sound library, read-only.
 *
 * CC0 first, as the Gateway sorts it. `configured: false` says the Gateway has
 * no sound source key — a real answer the page can show, not an empty list
 * that reads as "there are no sounds".
 *
 * A result is a SEARCH HIT, not yet a file. The page keeps the one the customer
 * picks (below), which downloads it once and returns the sha the cue stores.
 */
router.get('/projects/:slug/sound-and-labels/sounds/library', async (req, res) => {
  try {
    const { fetchSoundLibrary } = await import('../lib/gateway-sound-library.js')
    res.json(await fetchSoundLibrary(String(req.query.q || '')))
  } catch (error: any) {
    res.status(502).json({ detail: error?.message || 'The Gateway sound library could not be reached.' })
  }
})

/**
 * Keep one Gateway clip in the Gateway's own library and hand back its credit.
 *
 * Deliberately takes the sha the LIST route published rather than re-deriving
 * one: the gateway is the only thing that knows what it stored, and a second
 * download of the same clip would cost another upstream request for bytes that
 * are already there (`download_into_library` is idempotent on the hash).
 */
router.post('/projects/:slug/sound-and-labels/:episodeId/sounds/keep', async (req, res) => {
  try {
    const source = typeof req.body?.source === 'string' ? req.body.source : ''
    const sourceId = typeof req.body?.source_id === 'string' ? req.body.source_id : ''
    if (!source || !sourceId) return res.status(400).json({ detail: 'source and source_id are required.' })
    const { keepSoundInLibrary } = await import('../lib/gateway-sound-library.js')
    res.json(await keepSoundInLibrary(source, sourceId))
  } catch (error: any) {
    res.status(502).json({ detail: error?.message || 'That sound could not be kept in the Gateway library.' })
  }
})

/** One kept clip's bytes, so a row can be played without downloading it again. */
router.get('/projects/:slug/sound-and-labels/sounds/library-audio/:sha256', async (req, res) => {
  try {
    // The clip may not be on this Mac yet: the Gateway is usually another machine.
    // Fetch it once (hash-checked into this Mac's cache) so a kept row can play.
    const { gatewaySoundClipPath } = await import('../services/sound-design-resolver.js')
    const file = await gatewaySoundClipPath(req.params.sha256)
    const AUDIO_MIME: Record<string, string> = {
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    }
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Type', AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
    const fsMod = await import('fs')
    fsMod.createReadStream(file).pipe(res)
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not play that library sound.'))
  }
})

export { DEFAULT_CONTEXTUAL_CUE_CONFIG, DEFAULT_SOUND_DESIGN_CONFIG }
