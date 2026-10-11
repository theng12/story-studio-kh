/**
 * Story → Trash (1.4.289). `GET /trash` lists it, `POST /trash/restore` puts one
 * item back, `POST /trash/empty` deletes everything in it for good.
 *
 * Empty is the owner's alone (standing rule: agents never permanently delete): it
 * needs the typed confirmation the Trash page asks for, and a request carrying an
 * automation key is refused with 403 whether or not the key is valid, from
 * loopback too.
 */
import { Router } from 'express'

import { readAutomationKeyHeader } from '../lib/auth-session.js'
import { respondWithError } from '../lib/humanize-backend-error.js'
import { emptyTrash, listTrash, restoreTrashItem } from '../services/trash.js'

export const router = Router()

/** What the owner types on the Trash page. */
export const EMPTY_TRASH_CONFIRMATION = 'EMPTY TRASH'

router.get('/trash', async (_req, res) => {
  try { res.json(await listTrash()) } catch (error) { respondWithError(res, error, 'Could not read the Trash') }
})

router.post('/trash/restore', async (req, res) => {
  try { res.json(await restoreTrashItem(req.body?.id)) } catch (error) { respondWithError(res, error, 'Could not restore the item') }
})

router.post('/trash/empty', async (req: any, res) => {
  if (req.user?.via === 'automation_key' || readAutomationKeyHeader(req.headers || {}) !== undefined) {
    return res.status(403).json({ detail: 'Only the owner can empty the Trash, on Story → Trash. Automation keys never can.' })
  }
  if (req.body?.confirm !== EMPTY_TRASH_CONFIRMATION) {
    return res.status(400).json({ detail: `Type ${EMPTY_TRASH_CONFIRMATION} to confirm. Emptying deletes everything in the Trash for good.` })
  }
  try {
    const result = await emptyTrash()
    console.log(`[trash] emptied by the owner: ${result.removed} item(s), ${result.bytes_freed} bytes`)
    res.json(result)
  } catch (error) { respondWithError(res, error, 'Could not empty the Trash') }
})
