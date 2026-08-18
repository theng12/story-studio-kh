/**
 * The Library — choosing it, checking it, and moving it (v1.4.3).
 *
 * One location concept replaces four. See `services/library.ts` for the shape
 * and the owner's reasoning; this is the wire.
 *
 * These routes are deliberately reachable BEFORE a Library exists. Everything
 * else in the app assumes one, so first run has to be answerable from a state
 * where no project, no assets folder and no exports folder exist yet.
 */

import { Router } from 'express'
import {
  checkLibraryTarget,
  describeLibrary,
  getLibraryRoot,
  setLibraryRoot,
} from '../services/library.js'
import {
  dismissMigrationNotice,
  listMigrationNotices,
} from '../services/library-migration.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

/**
 * What the app knows about the Library right now.
 *
 * `configured` and `exists` are separate on purpose: never chosen means ask,
 * chosen but absent means an unplugged drive or a deleted folder — say where
 * you looked and offer to look again. Collapsing the two into one boolean is
 * how "your work is gone" and "please pick a folder" become the same screen.
 */
router.get('/library', async (_req, res) => {
  try {
    res.json(await describeLibrary())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read the Library location'))
  }
})

/**
 * Judge a candidate without creating anything.
 *
 * The first-run screen calls this as the person browses, so it must stay
 * side-effect free — a check that creates the folder it is checking would leave
 * a trail of empty Story Studio folders behind someone who was still deciding.
 */
router.post('/library/check', async (req, res) => {
  try {
    const result = await checkLibraryTarget(req.body?.path)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not check that folder'))
  }
})

/**
 * Adopt a Library.
 *
 * First run creates the folder and its two fixed subfolders. Changing it later
 * is a MOVE, and moves the files — `move: true` is required for that, so a
 * mis-click on the Storage tab cannot silently orphan a whole library by
 * repointing the app at an empty folder.
 */
router.put('/library', async (req, res) => {
  const target = typeof req.body?.path === 'string' ? req.body.path : ''
  const wantsMove = req.body?.move === true
  try {
    const current = await getLibraryRoot()
    if (current && wantsMove) {
      // Reuse the mover that already exists rather than writing a second one:
      // it copies every channel AND rewrites absolute `output_root` values on
      // the way, which a plain settings write would not do. It deliberately
      // leaves the old folder in place (`kept_old_at`) — deleting a person's
      // library after copying it is not a decision this app gets to make.
      const { migrateProjectsTo } = await import('../services/projects-storage-mover.js')
      const moved = await migrateProjectsTo(target, {
        merge_into_existing: req.body?.merge_into_existing === true,
      })
      // Point at the new place only AFTER the copy succeeded. Setting it first
      // and failing mid-copy would leave the app looking at a half-populated
      // folder and calling it the Library.
      const { setLibraryRoot: adopt } = await import('../services/library.js')
      await adopt(moved.target_path)
      return res.json({ ...(await describeLibrary()), moved })
    }
    if (current && current !== target) {
      return res.status(409).json({
        detail: 'This Mac already has a Library. Moving it copies every channel to the new place, '
          + 'so it has to be asked for explicitly.',
        code: 'LIBRARY_ALREADY_SET',
        current,
      })
    }
    res.json(await setLibraryRoot(target))
  } catch (e: any) {
    const status = e?.status === 400 ? 400 : 500
    res.status(status).json(humanizeBackendError(e, 'Could not set the Library location'))
  }
})

/**
 * One-time messages from the 1.4.3 upgrade.
 *
 * Kept separate from `GET /library` because they are not the Library's state —
 * they are things that happened to the settings around it, and they need to
 * survive until someone has actually read them.
 */
router.get('/library/notices', async (_req, res) => {
  try {
    res.json({ notices: await listMigrationNotices() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not read upgrade notices'))
  }
})

router.delete('/library/notices/:id', async (req, res) => {
  try {
    await dismissMigrationNotice(req.params.id)
    res.json({ ok: true, notices: await listMigrationNotices() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not dismiss that notice'))
  }
})
