/**
 * Continuity-chain per-episode config routes (v1.0.189+).
 *
 *   GET /api/projects/:slug/continuity/:episodeId  — read continuity.json (or defaults)
 *   PUT /api/projects/:slug/continuity/:episodeId  — replace continuity.json
 *
 * The config (anchor characters, episode-sheet toggle, pacing guardrails,
 * per-scene reference toggles, denoise strength) is set on the Character Sheet
 * page and consumed by the density-paced scene planner (CC3) + the sequential
 * renderer (CC4). The episode SHEET image itself is uploaded via the existing
 * img2img-references/master route — this sidecar only holds the settings.
 *
 * Folder resolution uses resolveEpisodePathsByCode (v1.0.188 fix) so the
 * sidecar lands in the real `{code} - {title}` folder, not a phantom one.
 */

import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import type { ContinuityConfig } from '../models/types.js'

export const router = Router()

export const CONTINUITY_FILENAME = 'continuity.json'

/** Sensible defaults for a fresh episode — sequential continuity ON, all
 *  references on, a 2–8s "feels live" pacing band, mid denoise. */
export function defaultContinuityConfig(): ContinuityConfig {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { min_sec: 2, max_sec: 8 },
    references: { prev_render: true, sheet: true, characters: true, style: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
    updated_at: '',
  }
}

// ── GET ───────────────────────────────────────────────────────────────
router.get('/projects/:slug/continuity/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const sidecarPath = path.join(paths.episode_dir, CONTINUITY_FILENAME)
    try {
      const raw = await fs.readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw) as ContinuityConfig
      res.json({ exists: true, config: parsed })
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return res.json({ exists: false, config: defaultContinuityConfig() })
      }
      throw e
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read continuity config'))
  }
})

// ── PUT ───────────────────────────────────────────────────────────────
router.put('/projects/:slug/continuity/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const body = req.body as Partial<ContinuityConfig> | undefined
  if (!body || body.schema_version !== 1) {
    return res.status(400).json({ detail: 'Invalid continuity payload (missing schema_version: 1)' })
  }
  // Coerce + clamp the numeric fields so a malformed client can't write junk.
  const minSec = Math.max(1, Math.min(60, Number(body.pacing?.min_sec) || 2))
  const maxSec = Math.max(minSec, Math.min(60, Number(body.pacing?.max_sec) || 8))
  const denoise = Math.max(0, Math.min(1, Number(body.denoise_strength)))
  const config: ContinuityConfig = {
    schema_version: 1,
    anchor_character_ids: Array.isArray(body.anchor_character_ids)
      ? body.anchor_character_ids.filter((x): x is string => typeof x === 'string')
      : [],
    use_episode_sheet: !!body.use_episode_sheet,
    pacing: { min_sec: minSec, max_sec: maxSec },
    references: {
      prev_render: body.references?.prev_render !== false,
      sheet: body.references?.sheet !== false,
      characters: body.references?.characters !== false,
      style: body.references?.style === true,
    },
    denoise_strength: Number.isFinite(denoise) ? denoise : 0.5,
    // v1.0.243 — render-time Style Bible + negative prompt. Trimmed; capped so
    // a malformed client can't write an unbounded blob into the prompt.
    style_bible: typeof body.style_bible === 'string' ? body.style_bible.trim().slice(0, 2000) : '',
    negative_prompt: typeof body.negative_prompt === 'string' ? body.negative_prompt.trim().slice(0, 1000) : '',
    updated_at: new Date().toISOString(),
  }

  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    await fs.mkdir(paths.episode_dir, { recursive: true })
    const sidecarPath = path.join(paths.episode_dir, CONTINUITY_FILENAME)
    await fs.writeFile(sidecarPath, JSON.stringify(config, null, 2), 'utf-8')
    res.json({ ok: true, config })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save continuity config'))
  }
})
