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
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { SCENE_PLAN_FILENAME } from '../generators/scene-plan.js'
import { DEFAULT_SCENE_PACING } from '../contracts/pacing.js'
import type { ContinuityConfig, VisualRecipe, JobType, ScenePlan, ProjectMeta } from '../models/types.js'

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
    recipe: defaultVisualRecipe(),
    updated_at: '',
  }
}

/** v1.0.260 — a fresh, disabled explainer recipe. */
export function defaultVisualRecipe(): VisualRecipe {
  return {
    enabled: false,
    mode: 'guide',
    directive: '',
    guide_character_id: '',
    emotion_mode: 'auto',
    fixed_emotion: '',
  }
}

/** Coerce an untrusted recipe payload into a safe VisualRecipe (trim + cap). */
function sanitizeRecipe(raw: any): VisualRecipe {
  const r = (raw && typeof raw === 'object') ? raw : {}
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'scene' ? 'scene' : 'guide',
    directive: typeof r.directive === 'string' ? r.directive.trim().slice(0, 2000) : '',
    guide_character_id: typeof r.guide_character_id === 'string' ? r.guide_character_id.trim().slice(0, 200) : '',
    emotion_mode: r.emotion_mode === 'fixed' ? 'fixed' : 'auto',
    fixed_emotion: typeof r.fixed_emotion === 'string' ? r.fixed_emotion.trim().slice(0, 120) : '',
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
    style_bible: typeof b.style_bible === 'string' ? b.style_bible.trim().slice(0, 2000) : '',
    negative_prompt: typeof b.negative_prompt === 'string' ? b.negative_prompt.trim().slice(0, 1000) : '',
    // v1.0.260 — explainer composition recipe (drives the Prompt Director).
    recipe: sanitizeRecipe(b.recipe),
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

// ── POST apply-recipe (v1.0.260) ──────────────────────────────────────
// Enqueue the Prompt Director: rewrite every scene's prompt into the explainer
// composition (guide-at-side + framed subject) per the saved Visual Recipe.
router.post('/projects/:slug/continuity/:episodeId/apply-recipe', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })

  if (jq.isDuplicate(slug, episodeId, 'prompt_director' as JobType)) {
    return res.status(409).json({ detail: `Visual Recipe is already being applied for ${episodeId}` })
  }
  const job = await jq.enqueue({
    project_slug: slug,
    type: 'prompt_director' as JobType,
    episode_id: episodeId,
    title: `Apply Visual Recipe — ${episodeId}`,
    params: { episode_id: episodeId, model },
  })
  res.status(201).json(job)
})

// ── POST revert-recipe (v1.0.260) ─────────────────────────────────────
// Restore each scene's planner prompt: visual_prompt ← visual_prompt_raw, and
// clear the recipe's emotion + raw fields. Synchronous (no LLM). Idempotent.
router.post('/projects/:slug/continuity/:episodeId/revert-recipe', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
    if (!existsSync(planPath)) return res.status(404).json({ detail: 'No scene plan for this episode' })
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    let reverted = 0
    for (const s of plan.scenes) {
      // Only undo scenes the recipe actually composed (those have a saved raw
      // prompt). Leave never-composed scenes — and any emotion the user set on
      // them — untouched, so revert can't wipe unrelated edits.
      if (typeof s.visual_prompt_raw === 'string' && s.visual_prompt_raw.length) {
        s.visual_prompt = s.visual_prompt_raw
        delete s.visual_prompt_raw
        delete s.emotion
        delete s.emotion_locked
        reverted++
      }
    }
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    res.json({ ok: true, reverted })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to revert recipe'))
  }
})
