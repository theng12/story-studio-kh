import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { SUBFOLDER_LINKAGE, DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { validateBody } from '../lib/validate.js'
import {
  UpdateConfigSchema, UpdateStandardsSchema,
} from '../schemas/index.js'
import { updateProjectContentConfigSelections } from '../content-packs/project-pins.js'
import {
  getGlobalCompression, getProjectCompressionOverride, setProjectCompressionOverride,
} from '../services/generation-compression.js'

export const router = Router()

router.get('/projects/:slug/settings/config', async (req, res) => {
  const config = await pm.getSafeConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  res.json(config)
})

const retiredCredentialPath = (_req: any, res: any) => res.status(410).json({
  code: 'GENSTUDIO_ONLY',
  detail: 'Project/provider credentials are retired. Configure one Gateway key in Settings → This Mac.',
})
router.all('/projects/:slug/settings/api-keys', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts/:providerId', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts/:providerId/:accountId', retiredCredentialPath)
router.all('/projects/:slug/settings/accounts/:providerId/:accountId/default', retiredCredentialPath)

router.put('/projects/:slug/settings/config', validateBody(UpdateConfigSchema), async (req, res) => {
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
  res.json({ ok: true })
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
