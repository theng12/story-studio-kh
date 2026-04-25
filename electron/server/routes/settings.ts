import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { SUBFOLDER_LINKAGE, DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { validateBody } from '../lib/validate.js'
import {
  UpdateApiKeysSchema, UpdateConfigSchema, UpdateStandardsSchema,
  AddAccountSchema, UpdateAccountSchema,
} from '../schemas/index.js'
import * as accounts from '../services/secrets-accounts.js'
import { AccountsError } from '../services/secrets-accounts.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

router.get('/projects/:slug/settings/config', async (req, res) => {
  const config = await pm.getSafeConfig(req.params.slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })
  res.json(config)
})

router.put('/projects/:slug/settings/api-keys', validateBody(UpdateApiKeysSchema), async (req, res) => {
  if (!await pm.updateApiKeys(req.params.slug, req.body)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  res.json({ ok: true })
})

// ── Accounts (Delivery 2) ──────────────────────────────────────────────────
// All endpoints are scoped by project slug + provider id. The legacy
// PUT /api-keys above still works — it writes the default account per
// provider via the compat shim in secrets-store.ts.

function handleAccountsError(res: any, e: unknown): void {
  if (e instanceof AccountsError) {
    const status = e.code === 'unknown_provider' || e.code === 'account_not_found' ? 404 : 400
    res.status(status).json({ detail: e.message, code: e.code })
    return
  }
  res.status(500).json(humanizeBackendError(e, 'Unknown error'))
}

router.get('/projects/:slug/settings/accounts', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  try {
    res.json({ accounts: await accounts.listAllAccounts(req.params.slug) })
  } catch (e) { handleAccountsError(res, e) }
})

router.post(
  '/projects/:slug/settings/accounts/:providerId',
  validateBody(AddAccountSchema),
  async (req, res) => {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    try {
      const created = await accounts.addAccount(
        req.params.slug,
        req.params.providerId,
        req.body,
      )
      res.status(201).json(created)
    } catch (e) { handleAccountsError(res, e) }
  },
)

router.patch(
  '/projects/:slug/settings/accounts/:providerId/:accountId',
  validateBody(UpdateAccountSchema),
  async (req, res) => {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    try {
      const updated = await accounts.updateAccount(
        req.params.slug,
        req.params.providerId,
        req.params.accountId,
        req.body,
      )
      res.json(updated)
    } catch (e) { handleAccountsError(res, e) }
  },
)

router.delete(
  '/projects/:slug/settings/accounts/:providerId/:accountId',
  async (req, res) => {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    try {
      await accounts.removeAccount(
        req.params.slug,
        req.params.providerId,
        req.params.accountId,
      )
      res.json({ ok: true })
    } catch (e) { handleAccountsError(res, e) }
  },
)

router.put(
  '/projects/:slug/settings/accounts/:providerId/:accountId/default',
  async (req, res) => {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    try {
      await accounts.setDefaultAccount(
        req.params.slug,
        req.params.providerId,
        req.params.accountId,
      )
      res.json({ ok: true })
    } catch (e) { handleAccountsError(res, e) }
  },
)

router.put('/projects/:slug/settings/config', validateBody(UpdateConfigSchema), async (req, res) => {
  if (!await pm.updateConfig(req.params.slug, req.body)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  res.json({ ok: true })
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
