/**
 * Story → Trash (1.4.289). `GET /trash` lists it, `POST /trash/restore` puts one
 * item back. Owner, 2026-10-16 (managing the mini remotely): `POST /trash/macos-trash`
 * hands items to the Mac's own Trash once `{ expected_count, expected_bytes }` matches
 * what the server measures, `POST /trash/delete-permanently` deletes chosen items for
 * good once `{ confirm: true, expected_count, expected_bytes }` matches. That is the
 * ONLY permanent delete of anything in the Trash: the old `POST /trash/empty` (every
 * root, unindexed items too) is retired and answers 410.
 *
 * Both actions are the owner's alone (standing rule: agents never permanently
 * delete): a request carrying an automation key is refused with 403 whether or not
 * the key is valid, from loopback too, and so is one that is neither the app's own
 * window nor a signed-in browser (`isOwnerRequest`): a keyless loopback request is
 * not the owner. The owner's own actions never come from a timer; the automatic
 * age handoff that does run from one lives in `services/retention.ts`, moves only
 * to the Mac's Trash, and is governed by `GET/PUT /trash/retention`.
 */
import { Router } from 'express'

import { isOwnerRequest, readAutomationKeyHeader } from '../lib/auth-session.js'
import { respondWithError } from '../lib/humanize-backend-error.js'
import { getServerModeConfig } from '../lib/server-mode.js'
import { deletePermanently, electronTrashItem, listTrash, moveToMacTrash, restoreTrashItem } from '../services/trash.js'
import { getRetentionSettings, setRetentionSettings } from '../services/retention.js'

export const router = Router()

const viaAutomationKey = (req: any) => req.user?.via === 'automation_key' || readAutomationKeyHeader(req.headers || {}) !== undefined
const notOwner = (req: any) => viaAutomationKey(req) || !isOwnerRequest(req, getServerModeConfig()?.auth)
const counted = (body: any) => Number.isSafeInteger(body?.expected_count) && Number.isSafeInteger(body?.expected_bytes)

router.get('/trash', async (_req, res) => {
  try { res.json(await listTrash()) } catch (error) { respondWithError(res, error, 'Could not read the Trash') }
})

/** Automatic retention: the age handoff and the automatic all-channel cleanup (services/retention.ts). */
router.get('/trash/retention', async (_req, res) => {
  try { res.json({ ...await getRetentionSettings(), mac_trash_available: !!(await electronTrashItem()) }) } catch (error) { respondWithError(res, error, 'Could not read the retention settings') }
})

router.put('/trash/retention', async (req: any, res) => {
  if (notOwner(req)) return res.status(403).json({ detail: 'Only the owner can change retention, from Story → Trash in the app or a signed-in browser. Automation keys never can.' })
  try { res.json({ ...await setRetentionSettings(req.body || {}), mac_trash_available: !!(await electronTrashItem()) }) } catch (error) { respondWithError(res, error, 'Could not save the retention settings') }
})

router.post('/trash/restore', async (req, res) => {
  try { res.json(await restoreTrashItem(req.body?.id)) } catch (error) { respondWithError(res, error, 'Could not restore the item') }
})

// Retired 2026-10-16; kept only so a page loaded before the update gets a clear answer.
router.post('/trash/empty', (_req, res) => {
  res.status(410).json({ detail: 'Empty Trash was replaced by "Delete all permanently" on Story → Trash. Refresh the page; nothing was deleted.' })
})

router.post('/trash/macos-trash', async (req: any, res) => {
  if (notOwner(req)) {
    return res.status(403).json({ detail: 'Only the owner can move items to the Mac\'s Trash, from Story → Trash in the app or a signed-in browser. Automation keys never can.' })
  }
  if (!counted(req.body)) return res.status(400).json({ detail: 'Confirm the number of items and bytes to move. Nothing was moved.' })
  const trashItem = await electronTrashItem()
  if (!trashItem) return res.status(503).json({ detail: 'The Mac\'s Trash is only reachable while Story Studio runs as the app on the Mac. Nothing was moved.' })
  try {
    const result = await moveToMacTrash(req.body.ids, { count: req.body.expected_count, bytes: req.body.expected_bytes }, trashItem)
    console.log(`[trash] moved to the Mac's Trash by the owner: ${result.moved} item(s), ${result.bytes} bytes`)
    res.json(result)
  } catch (error) { respondWithError(res, error, 'Could not move the items to the Mac\'s Trash') }
})

router.post('/trash/delete-permanently', async (req: any, res) => {
  if (notOwner(req)) {
    return res.status(403).json({ detail: 'Only the owner can delete from the Trash, from Story → Trash in the app or a signed-in browser. Automation keys never can.' })
  }
  const { confirm, expected_count, expected_bytes, ids } = req.body || {}
  if (confirm !== true || !counted(req.body)) {
    return res.status(400).json({ detail: 'Confirm the number of items and bytes to delete. Deleting cannot be undone.' })
  }
  try {
    const result = await deletePermanently(ids, { count: expected_count, bytes: expected_bytes })
    console.log(`[trash] deleted permanently by the owner: ${result.deleted} item(s), ${result.bytes_freed} bytes`)
    res.json(result)
  } catch (error) { respondWithError(res, error, 'Could not delete the items') }
})
