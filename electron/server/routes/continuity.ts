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
import { DEFAULT_SCENE_PACING } from '../contracts/pacing.js'
import type { ContinuityConfig, ProjectMeta } from '../models/types.js'
import { truncateChars } from '../lib/well-formed-text.js'

export const router = Router()

export const CONTINUITY_FILENAME = 'continuity.json'

type ContinuityMode = NonNullable<ProjectMeta['continuity_mode']>

/** One Continuity Engine supports three safe starting behaviours. The selected
 * project mode is only a default: an episode's saved Character Sheet can
 * still opt into different references without changing its channel. */
export function defaultContinuityConfig(mode: ContinuityMode = 'independent-stills'): ContinuityConfig {
  const characterChain = mode === 'character-continuity'
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    // Imported, not hardcoded: this is the same decision as the scene-plan
    // fallback, and a project that creates a continuity config must not
    // silently get different pacing from one that has not. See
    // contracts/pacing.ts for why this used to drift.
    pacing: { ...DEFAULT_SCENE_PACING },
    references: {
      prev_render: characterChain,
      sheet: characterChain,
      characters: characterChain,
      style: false,
      composition: false,
    },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
    updated_at: '',
  }
}

// ── GET ───────────────────────────────────────────────────────────────
router.get('/projects/:slug/continuity/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const sidecarPath = path.join(paths.episode_dir, CONTINUITY_FILENAME)
    try {
      const raw = await fs.readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw) as ContinuityConfig
      res.json({ exists: true, config: parsed })
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return res.json({ exists: false, config: defaultContinuityConfig(project.continuity_mode || 'independent-stills') })
      }
      throw e
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read continuity config'))
  }
})

/**
 * Coerce + clamp an untrusted (possibly partial) continuity payload into a
 * clean ContinuityConfig, stamping a fresh `updated_at`. Shared by the PUT
 * route and the pipeline's Character-Sheet auto-apply (routes/pipeline.ts) so
 * both produce byte-identical sidecars — a saved `continuity_page` preset
 * applied by an unattended batch run lands exactly as a manual Save would.
 */
export function buildContinuityConfig(
  body: Partial<ContinuityConfig> | undefined,
  mode: ContinuityMode = 'independent-stills',
): ContinuityConfig {
  const b = body || {}
  const defaults = defaultContinuityConfig(mode)
  // Coerce + clamp the numeric fields so a malformed client can't write junk.
  // Falls back to `defaults.pacing` (DEFAULT_SCENE_PACING), not a re-hardcoded
  // literal, so an omitted min_sec/max_sec can't drift from the fresh-config
  // default above -- the exact "two places, one decision" shape that caused
  // this default to disagree with itself before (see contracts/pacing.ts).
  const minSec = Math.max(1, Math.min(60, Number(b.pacing?.min_sec) || defaults.pacing.min_sec))
  const maxSec = Math.max(minSec, Math.min(60, Number(b.pacing?.max_sec) || defaults.pacing.max_sec))
  const openingDuration = Number(b.pacing?.opening_duration_sec)
  const settledMin = Number(b.pacing?.settled_min_sec)
  const settledMax = Number(b.pacing?.settled_max_sec)
  const hasSettledPacing = Number.isFinite(openingDuration) && openingDuration >= 0
    && Number.isFinite(settledMin) && Number.isFinite(settledMax)
    && settledMin >= 1 && settledMax >= settledMin
  const denoise = Math.max(0, Math.min(1, Number(b.denoise_strength)))
  return {
    schema_version: 1,
    anchor_character_ids: Array.isArray(b.anchor_character_ids)
      ? b.anchor_character_ids.filter((x): x is string => typeof x === 'string')
      : [],
    use_episode_sheet: !!b.use_episode_sheet,
    pacing: {
      min_sec: minSec,
      max_sec: maxSec,
      ...(hasSettledPacing
        ? {
            opening_duration_sec: Math.min(3 * 60 * 60, Math.round(openingDuration)),
            settled_min_sec: Math.max(1, Math.min(60, settledMin)),
            settled_max_sec: Math.max(Math.max(1, Math.min(60, settledMin)), Math.min(60, settledMax)),
          }
        : {}),
    },
    references: {
      prev_render: b.references?.prev_render ?? defaults.references.prev_render,
      sheet: b.references?.sheet ?? defaults.references.sheet,
      characters: b.references?.characters ?? defaults.references.characters,
      style: b.references?.style === true,
      composition: b.references?.composition === true,
    },
    denoise_strength: Number.isFinite(denoise) ? denoise : 0.5,
    // v1.0.243 — render-time Style Bible + negative prompt. Trimmed; capped so
    // a malformed client can't write an unbounded blob into the prompt.
    style_bible: typeof b.style_bible === 'string' ? truncateChars(b.style_bible.trim(), 2000) : '',
    negative_prompt: typeof b.negative_prompt === 'string' ? truncateChars(b.negative_prompt.trim(), 1000) : '',
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build + write continuity.json for an episode, returning the persisted
 * config. Folder resolution uses resolveEpisodePathsByCode so the sidecar
 * lands in the real `{code} - {title}` folder. Used by the PUT route and the
 * pipeline Character-Sheet step.
 */
export async function writeContinuityConfig(
  slug: string, episodeId: string, body: Partial<ContinuityConfig> | undefined,
  mode: ContinuityMode = 'independent-stills',
): Promise<ContinuityConfig> {
  const config = buildContinuityConfig(body, mode)
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  await fs.writeFile(path.join(paths.episode_dir, CONTINUITY_FILENAME), JSON.stringify(config, null, 2), 'utf-8')
  return config
}

// ── PUT ───────────────────────────────────────────────────────────────
router.put('/projects/:slug/continuity/:episodeId', async (req, res) => {
  const { slug, episodeId } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const body = req.body as Partial<ContinuityConfig> | undefined
  if (!body || body.schema_version !== 1) {
    return res.status(400).json({ detail: 'Invalid continuity payload (missing schema_version: 1)' })
  }

  try {
    const config = await writeContinuityConfig(slug, episodeId, body, project.continuity_mode || 'independent-stills')
    res.json({ ok: true, config })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save continuity config'))
  }
})
