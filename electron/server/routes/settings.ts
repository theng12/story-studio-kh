import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { SUBFOLDER_LINKAGE, DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { validateBody } from '../lib/validate.js'
import { migrateRetiredLlmLineup } from '../services/llm-lineup-migration.js'
import {
  UpdateConfigSchema, UpdateStandardsSchema,
} from '../schemas/index.js'
import { updateProjectContentConfigSelections } from '../content-packs/project-pins.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import {
  getGlobalCompression, getProjectCompressionOverride, setProjectCompressionOverride,
} from '../services/generation-compression.js'

export const router = Router()

router.get('/projects/:slug/settings/config', async (req, res) => {
  const config = await pm.getSafeConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  res.json(config)
})

/**
 * What this channel's images will actually use, and whether the style it names
 * could be used at all.
 *
 * Settings renders this, and it is the SAME resolution the generators run —
 * two screens must never disagree about which look goes into a prompt. It
 * exists because the divergence was silent in both directions: a Store style
 * whose Content Pack is not installed (renders with the format default) and one
 * of this channel's own presets the Store now owns (renders with the preset's
 * older prose). Nothing on disk is read differently; this only reports.
 */
router.get('/projects/:slug/settings/art-style', async (req, res) => {
  const config = await pm.getConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  const resolution = await resolveProjectArtStyle(req.params.slug)
  res.json({
    requestedId: (config.active_style_preset_id || '').trim(),
    applied: resolution.style
      ? { id: resolution.style.presetId ?? null, name: resolution.style.name ?? null }
      : null,
    fallback: resolution.fallback,
  })
})

// The one-time "LLM lineup is gone" notice on the Pipeline page, closed for good.
router.post('/projects/:slug/settings/llm-lineup-notice/dismiss', async (req, res) => {
  const config = await pm.getConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  if (config.llm_lineup_migration && !config.llm_lineup_migration.notice_dismissed_at) {
    await pm.updateConfig(req.params.slug, {
      llm_lineup_migration: { ...config.llm_lineup_migration, notice_dismissed_at: new Date().toISOString() },
    })
  }
  res.json({ ok: true })
})

const retiredCredentialPath = (_req: any, res: any) => res.status(410).json({
  code: 'GENSTUDIO_ONLY',
  detail: 'Project/provider credentials are retired. Configure one Gateway API Key in Settings → This Mac.',
})
router.all('/projects/:slug/settings/api-keys', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts/:providerId', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts/:providerId/:accountId', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts/:providerId/:accountId/default', retiredCredentialPath)

/**
 * 1.4.281 — keys this route accepts but does not save, and where each one goes instead. The response
 * names them (`ignored`) next to what it saved (`applied`) instead of a bare `{ ok: true }`.
 */
const CONFIG_KEYS_NOT_SAVED: Record<string, string> = {
  audio_models: 'retired: Gateway is the only voice catalog; choose voices in Audio',
  models: 'retired: custom model storage was removed; models come from Gateway',
  llm_lineup: 'retired (2026-10-03): each step chooses its own model',
  llm_lineup_migration: 'retired (2026-10-03): Story Studio keeps this record itself',
  audio_concurrency: 'use PUT /app-settings/concurrency',
  video_concurrency: 'use PUT /app-settings/concurrency',
  image_concurrency: 'use PUT /app-settings/concurrency',
  subtitle_concurrency: 'use PUT /app-settings/concurrency',
  image_launch_stagger_ms: 'retired: launch pacing is no longer a setting',
  audio_launch_stagger_ms: 'retired: launch pacing is no longer a setting',
  video_launch_stagger_ms: 'retired: launch pacing is no longer a setting',
  generation_timeouts: 'retired: generation timeouts are no longer a setting',
  // Owned by Motion Review, which pins the episodes that follow a moved default before saving.
  motion_presentation: 'saved by Motion Review (PUT /projects/:slug/motion-presentation)',
}

router.put('/projects/:slug/settings/config', (req, res, next) => {
  res.locals.requestedKeys = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body) : []
  next()
}, validateBody(UpdateConfigSchema), async (req, res) => {
  // A style or thumbnail selection goes through the signed Content Pack write, which saves the
  // other keys of the same body too (applyConfigRequest), so nothing is dropped.
  const hasContentSelection = Object.prototype.hasOwnProperty.call(req.body, 'active_style_preset_id')
    || Object.prototype.hasOwnProperty.call(req.body, 'thumbnail_template_id')
  const updated = hasContentSelection
    ? await updateProjectContentConfigSelections(
        req.params.slug,
        req.body,
        req.app.locals.contentPackOptions,
      ).then(() => true)
    : await pm.updateConfig(req.params.slug, req.body)
  if (!updated) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  // Migrate only after an explicit save, so its model choices take precedence.
  await migrateRetiredLlmLineup(req.params.slug).catch(error => {
    console.warn('[settings] LLM lineup migration skipped', { slug: req.params.slug, error: String(error) })
  })
  const requested: string[] = res.locals.requestedKeys
  const ignored = requested.filter(key => !Object.prototype.hasOwnProperty.call(req.body, key) || key === 'models')
    .map(key => ({ key, reason: CONFIG_KEYS_NOT_SAVED[key] ?? 'not a project setting' }))
  res.json({ ok: true, applied: requested.filter(key => !ignored.some(i => i.key === key)), ignored })
})

// "Smaller files" per project: the project's own on/off per asset type, or nothing = follow the
// app default. `effective` is what generation will actually use.
async function compressionPayload(slug: string, override: Record<string, boolean>) {
  const global = await getGlobalCompression()
  return { override, global, effective: { ...global, ...override } }
}

router.get('/projects/:slug/settings/generation-compression', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json(await compressionPayload(req.params.slug, await getProjectCompressionOverride(req.params.slug)))
})

router.put('/projects/:slug/settings/generation-compression', async (req, res) => {
  try {
    const override = await setProjectCompressionOverride(req.params.slug, req.body)
    if (!override) return res.status(404).json({ detail: 'Project not found' })
    res.json(await compressionPayload(req.params.slug, override))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json({ detail: e?.message || 'Failed to save smaller-files settings' })
  }
})

router.get('/projects/:slug/settings/standards', async (req, res) => {
  const content = await pm.getStandards(req.params.slug)
  if (content === null) return res.status(404).json({ detail: 'Project not found' })
  res.json({ content })
})

router.put('/projects/:slug/settings/standards', validateBody(UpdateStandardsSchema), async (req, res) => {
  // Accept both JSON body and plain text (schema is a discriminated union).
  const content = typeof req.body === 'string' ? req.body : req.body.content
  if (!await pm.updateStandards(req.params.slug, content)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  res.json({ ok: true })
})

// ── Subfolder names config with linkage ────────────────────────────────────

router.get('/projects/:slug/settings/subfolder-config', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const current = project.subfolder_names || DEFAULT_SUBFOLDER_NAMES
  const entries = Object.entries(SUBFOLDER_LINKAGE).map(([key, meta]) => ({
    key,
    label: meta.label,
    generator: meta.generator,
    order: meta.order,
    template: (current as any)[key] || (DEFAULT_SUBFOLDER_NAMES as any)[key],
  }))

  // Sort by order
  entries.sort((a, b) => a.order - b.order)

  res.json({
    subfolder_names: current,
    defaults: DEFAULT_SUBFOLDER_NAMES,
    linkage: entries,
  })
})

router.put('/projects/:slug/settings/subfolder-config', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const { subfolder_names } = req.body
  if (!subfolder_names || typeof subfolder_names !== 'object') {
    return res.status(400).json({ detail: 'subfolder_names object required' })
  }

  // Validate all templates contain {code}
  for (const [key, value] of Object.entries(subfolder_names)) {
    if (typeof value !== 'string' || !value.includes('{code}')) {
      return res.status(400).json({ detail: `Template for "${key}" must contain {code} placeholder` })
    }
  }

  const updated = await pm.updateProject(req.params.slug, { subfolder_names })
  res.json({ ok: true, subfolder_names: updated?.subfolder_names })
})

// ── Safety checks (1.4.300): Off / Warn / Block per channel ──────────────────
router.get('/projects/:slug/safety-checks', async (req, res) => {
  const { SAFETY_CHECKS, safetyModeFromConfig } = await import('../services/safety-checks.js')
  const { finalCheckOptionsFromConfig, FINAL_CHECK_DEFAULTS } = await import('../lib/final-video-check.js')
  const config = await pm.getConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  res.json({
    checks: SAFETY_CHECKS.map(check => ({ ...check, mode: safetyModeFromConfig(config, check.id) })),
    // The threshold in force for this channel — its own value or the default — so the control shows
    // exactly what the final check will use, never a number the server will not apply.
    silence_min_sec: finalCheckOptionsFromConfig(config).silence_min_sec ?? FINAL_CHECK_DEFAULTS.silence_min_sec,
  })
})

async function saveSafetyModes(slug: string, modes: unknown, silenceMinSec?: unknown): Promise<boolean | string> {
  const { SAFETY_CHECKS, isSafetyMode } = await import('../services/safety-checks.js')
  const { SILENCE_MIN_SEC_BOUNDS } = await import('../lib/final-video-check.js')
  const hasSilence = silenceMinSec !== undefined
  if (modes === undefined && !hasSilence) {
    return 'Send { modes: { <check id>: "off" | "warn" | "block" } } or { silence_min_sec: <seconds> }.'
  }
  const next: Record<string, 'off' | 'warn' | 'block'> = {}
  if (modes !== undefined) {
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return 'Send { modes: { <check id>: "off" | "warn" | "block" } }.'
    const switchable = new Set(SAFETY_CHECKS.filter(check => !check.locked).map(check => check.id))
    for (const [id, mode] of Object.entries(modes as Record<string, unknown>)) {
      if (!switchable.has(id)) return `"${id}" is not a safety check that can be switched.`
      if (!isSafetyMode(mode)) return `"${String(mode)}" is not Off, Warn or Block.`
      next[id] = mode
    }
  }
  const config = await pm.getConfig(slug)
  if (!config) return false
  // Only the keys this call was asked to move: a silence-only save must not rewrite the modes
  // object (a config.json rewrite stales every episode-status row, mtime included).
  const patch: { safety_checks?: Record<string, 'off' | 'warn' | 'block'>; final_check?: { silence_min_sec: number } } = {}
  if (modes !== undefined) patch.safety_checks = { ...(config.safety_checks || {}), ...next }
  if (hasSilence) {
    const value = silenceMinSec
    if (typeof value !== 'number' || !Number.isFinite(value) || value < SILENCE_MIN_SEC_BOUNDS.min || value > SILENCE_MIN_SEC_BOUNDS.max) {
      return `${String(silenceMinSec)} is not a silence threshold between ${SILENCE_MIN_SEC_BOUNDS.min} and ${SILENCE_MIN_SEC_BOUNDS.max} seconds.`
    }
    patch.final_check = { ...(config.final_check || {}), silence_min_sec: value }
  }
  return pm.updateConfig(slug, patch)
}

router.put('/projects/:slug/safety-checks', async (req, res) => {
  const saved = await saveSafetyModes(req.params.slug, req.body?.modes, req.body?.silence_min_sec)
  if (typeof saved === 'string') return res.status(400).json({ detail: saved })
  if (!saved) return res.status(404).json({ detail: 'Project not found' })
  res.json({ ok: true })
})

/** The same choices on every channel on this Mac. */
router.post('/safety-checks/apply-to-all', async (req, res) => {
  const projects = await pm.listProjects()
  const applied: string[] = []
  for (const project of projects) {
    const saved = await saveSafetyModes(project.slug, req.body?.modes, req.body?.silence_min_sec)
    if (typeof saved === 'string') return res.status(400).json({ detail: saved })
    if (saved) applied.push(project.slug)
  }
  res.json({ ok: true, applied })
})

/**
 * The format pool's per-episode assignment (owner 2026-11-15). The GET is a
 * pure read — it never creates the episode's assignment file; the pool's
 * deterministic pick is shown either way. The PUT is the override before
 * upload: a member id pins that format, null hands the episode back to the
 * pool's pick. Off = `enabled: false` and the UI shows nothing.
 */
router.get('/projects/:slug/episodes/:episodeId/format-assignment', async (req, res) => {
  try {
    const slug = String(req.params.slug)
    const episodeId = String(req.params.episodeId)
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project not found' })
    const { formatPoolFromConfig, resolveEpisodeFormatAssignment } = await import('../services/format-pool.js')
    const pool = formatPoolFromConfig(config)
    if (!pool) return res.json({ enabled: false, member: null, source: null, index: null, members: [] })
    const assignment = await resolveEpisodeFormatAssignment(slug, episodeId, pool)
    return res.json({
      enabled: true,
      member: assignment?.member || null,
      source: assignment?.source || null,
      index: assignment?.index ?? null,
      members: pool.members,
    })
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || 'Could not read this episode’s format assignment.' })
  }
})

router.put('/projects/:slug/episodes/:episodeId/format-assignment', async (req, res) => {
  try {
    const slug = String(req.params.slug)
    const episodeId = String(req.params.episodeId)
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project not found' })
    const { formatPoolFromConfig, resolveEpisodeFormatAssignment, writeEpisodeFormatAssignment } = await import('../services/format-pool.js')
    const pool = formatPoolFromConfig(config)
    if (!pool) {
      return res.status(400).json({ detail: 'The format pool is off for this channel. Turn it on in Settings → Writing & style first.' })
    }
    const raw = req.body?.member_id
    if (raw !== null && typeof raw !== 'string') {
      return res.status(400).json({ detail: 'Choose a format from the pool, or null to follow the pool’s pick.' })
    }
    if (typeof raw === 'string') {
      if (!raw.trim()) return res.status(400).json({ detail: 'Choose a format from the pool, or null to follow the pool’s pick.' })
      if (!pool.members.some(member => member.id === raw)) {
        return res.status(400).json({ detail: 'That format is not in this channel’s pool.' })
      }
    }
    await writeEpisodeFormatAssignment(slug, episodeId, raw === null ? null : String(raw))
    const assignment = await resolveEpisodeFormatAssignment(slug, episodeId, pool)
    return res.json({
      enabled: true,
      member: assignment?.member || null,
      source: assignment?.source || null,
      index: assignment?.index ?? null,
      members: pool.members,
    })
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || 'Could not save this episode’s format assignment.' })
  }
})
