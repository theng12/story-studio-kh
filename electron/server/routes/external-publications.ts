/**
 * Publications made outside Story — the channel's list, its import and its review.
 *
 *   GET   /api/projects/:slug/external-publications            → entries + verified coverage
 *   POST  /api/projects/:slug/external-publications/import     → { path } from the app's picker
 *   PATCH /api/projects/:slug/external-publications/:id        → { state: 'verified'|'dismissed', reviewer }
 *
 * The import path comes from `POST /api/system/pick-file` (the app's one picker) and is validated
 * here: a regular `.csv`/`.json` file, nothing else. A refused row writes nothing and its row
 * number and reason come back so the page can show them.
 *
 * No YouTube call is made anywhere in this feature: a verified row is a human's statement about a
 * release elsewhere, counted as coverage only while it stays verified.
 */
import { Router } from 'express'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import * as pm from '../services/project-manager.js'
import {
  externalCoverageFor,
  importExternalPublications,
  setExternalPublicationState,
  EXTERNAL_PUBLICATIONS_FILENAME,
} from '../services/external-publications-store.js'

export const router = Router()

function fail(res: any, error: any, fallback: string): void {
  const status = typeof error?.statusCode === 'number' ? error.statusCode : 400
  res.status(status).json({ detail: humanizeBackendError(error, fallback) })
}

/** The channel's own scheduled days, so coverage can report — never hide — an overlap. */
async function localDaysFor(slug: string): Promise<Set<string>> {
  const { readItemSchedule } = await import('../services/upload-plans.js')
  const schedule = await readItemSchedule(slug).catch(() => ({} as Record<string, string>))
  const days = new Set<string>()
  for (const iso of Object.values(schedule)) if (iso) days.add(iso.slice(0, 10))
  return days
}

router.get('/projects/:slug/external-publications', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const coverage = await externalCoverageFor(req.params.slug, await localDaysFor(req.params.slug))
    res.json({
      file: EXTERNAL_PUBLICATIONS_FILENAME,
      status: coverage.status,
      ...(coverage.error ? { error: coverage.error } : {}),
      entries: coverage.entries,
      coverage: { verified: coverage.verified, days: coverage.days, overlapping_local: coverage.overlappingLocal },
    })
  } catch (error: any) { fail(res, error, 'Could not read this channel’s outside publications.') }
})

router.post('/projects/:slug/external-publications/import', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const picked = typeof req.body?.path === 'string' ? req.body.path : ''
    const result = await importExternalPublications(req.params.slug, picked)
    const coverage = await externalCoverageFor(req.params.slug, await localDaysFor(req.params.slug))
    res.json({
      imported: result.imported,
      refusals: result.refusals,
      // A refusal writes nothing; the page shows the rows and lets the operator fix the file.
      ...(result.refusals.length ? { detail: 'Nothing was imported — fix the rows listed below and import the file again.' } : {}),
      entries: coverage.entries,
    })
  } catch (error: any) { fail(res, error, 'Could not import that file.') }
})

router.patch('/projects/:slug/external-publications/:id', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const state = req.body?.state
    if (state !== 'verified' && state !== 'dismissed') {
      return res.status(400).json({ detail: 'An entry is either verified or dismissed.' })
    }
    const reviewer = typeof req.body?.reviewer === 'string' && req.body.reviewer.trim() ? req.body.reviewer.trim() : 'owner'
    const entry = await setExternalPublicationState(req.params.slug, String(req.params.id), state, reviewer)
    const coverage = await externalCoverageFor(req.params.slug, await localDaysFor(req.params.slug))
    res.json({
      entry,
      entries: coverage.entries,
      coverage: { verified: coverage.verified, days: coverage.days, overlapping_local: coverage.overlappingLocal },
    })
  } catch (error: any) { fail(res, error, 'Could not save that review.') }
})
