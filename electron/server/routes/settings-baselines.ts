import { Router } from 'express'
import {
  applyBaseline, filterSafeBaselinePayload, listBaselines, listRestorePoints,
  previewBaselineApplication, previewChannelRestore, restoreChannelSnapshot,
  snapshotChannelAsBaseline,
} from '../services/settings-baseline.js'

export const router = Router()

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${label} is required.`), { statusCode: 400 })
  return value.trim()
}

function channels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(slug => typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug))) {
    throw Object.assign(new Error('Choose the channels to preview or apply.'), { statusCode: 400 })
  }
  return [...new Set(value)]
}

function fail(res: import('express').Response, error: unknown): void {
  const tagged = error as { statusCode?: number }
  res.status(tagged?.statusCode ?? 500).json({ detail: error instanceof Error ? error.message : 'Settings baseline operation failed.' })
}

router.get('/settings-baselines', async (_req, res) => {
  try {
    res.json((await listBaselines()).map(baseline => ({ ...baseline, payload: filterSafeBaselinePayload(baseline.payload) })))
  } catch (error) { fail(res, error) }
})

router.get('/settings-baselines/snapshots', async (_req, res) => {
  try {
    // Snapshot bytes stay on the server; the picker needs only identity and dates.
    res.json((await listRestorePoints()).map(snapshot => ({
      id: snapshot.id, channel_slug: snapshot.channel_slug, created_at: snapshot.created_at,
      reason: snapshot.reason, baseline_id: snapshot.baseline_id, restored_at: snapshot.restored_at,
    })))
  } catch (error) { fail(res, error) }
})

router.post('/settings-baselines/snapshot-channel', async (req, res) => {
  try {
    res.json(await snapshotChannelAsBaseline(
      text(req.body?.slug, 'Channel'), text(req.body?.name, 'Baseline name'),
      typeof req.body?.description === 'string' ? req.body.description : undefined,
    ))
  } catch (error) { fail(res, error) }
})

router.post('/settings-baselines/preview', async (req, res) => {
  try {
    res.json(await previewBaselineApplication(text(req.body?.baseline_id, 'Baseline'), channels(req.body?.channel_slugs)))
  } catch (error) { fail(res, error) }
})

router.post('/settings-baselines/apply', async (req, res) => {
  try {
    if (req.body?.explicit_confirm !== true) {
      res.status(400).json({ detail: 'Confirm the preview before applying a baseline.' })
      return
    }
    res.json(await applyBaseline({
      baseline_id: text(req.body?.baseline_id, 'Baseline'), channel_slugs: channels(req.body?.channel_slugs),
      explicit_confirm: true, create_restore_point: true,
    }))
  } catch (error) { fail(res, error) }
})

router.post('/settings-baselines/restore/preview', async (req, res) => {
  try {
    const preview = await previewChannelRestore(text(req.body?.restore_point_id, 'Restore point'), text(req.body?.channel_slug, 'Channel'))
    // A restore compares the whole config, including legacy secrets: expose keys, never values.
    res.json({ ...preview, diffs: preview.diffs.map(diff => ({ key: diff.key, status: diff.status })) })
  } catch (error) { fail(res, error) }
})

router.post('/settings-baselines/restore', async (req, res) => {
  try {
    if (req.body?.explicit_confirm !== true) {
      res.status(400).json({ detail: 'Confirm the restore preview before restoring settings.' })
      return
    }
    const result = await restoreChannelSnapshot({
      restore_point_id: text(req.body?.restore_point_id, 'Restore point'), channel_slug: text(req.body?.channel_slug, 'Channel'),
      expected_current_sha256: text(req.body?.expected_current_sha256, 'Current configuration hash'), explicit_confirm: true,
    })
    res.json({ ...result, readback: { ...result.readback, mismatches: result.readback.mismatches.map(mismatch => ({ key: mismatch.key })) } })
  } catch (error) { fail(res, error) }
})
