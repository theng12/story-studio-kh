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
  setExportsRoot,
  setLibraryRoot,
} from '../services/library.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import path from 'path'
import os from 'os'

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
      // it copies every channel, verifies the file count, and reports what it
      // did, which a plain settings write would not. (It used to rewrite
      // absolute episode-folder paths on the way too; a channel's episodes now
      // always sit inside its own folder, so the copy carries them and there
      // is nothing to rewrite.) It deliberately leaves the old folder in place
      // (`kept_old_at`) — deleting a person's library after copying it is not
      // a decision this app gets to make.
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
      // v1.4.6 — repointing is allowed WITHOUT a move when the current Library
      // is not there. Refusing was a lockout: with the Library gone there are no
      // projects, so Settings (which lives under /projects/:slug) cannot be
      // opened, and this was the only other way to change the location. There is
      // also nothing to move — the folder being replaced does not exist.
      const { existsSync } = await import('fs')
      if (existsSync(current)) {
        return res.status(409).json({
          detail: 'This Mac already has a Library. Moving it copies every channel to the new place, '
            + 'so it has to be asked for explicitly.',
          code: 'LIBRARY_ALREADY_SET',
          current,
        })
      }
    }
    res.json(await setLibraryRoot(target))
  } catch (e: any) {
    const status = e?.status === 400 ? 400 : 500
    res.status(status).json(humanizeBackendError(e, 'Could not set the Library location'))
  }
})

/**
 * Choose where NEW finished videos go (v1.4.249). `{ path: '' }` returns to
 * the Library's own Exports folder. Moves nothing: videos already rendered
 * stay put and are still found in the folder they were made in.
 */
router.put('/library/exports', async (req, res) => {
  try {
    const target = typeof req.body?.path === 'string' ? req.body.path : ''
    res.json(await setExportsRoot(target))
  } catch (e: any) {
    const status = e?.status === 400 ? 400 : 500
    res.status(status).json(humanizeBackendError(e, 'Could not set the finished videos folder'))
  }
})

// ── Archive uploaded videos (v1.4.4) ──────────────────────────────────────
//
// Moves confirmed-uploaded finals out to a folder he picks, so what is left is
// a folder of finished videos he can back up, park, or delete with ordinary
// tools. The sweep runs in-process rather than through the job queue: it is a
// single Library-wide operation the customer is watching, not per-episode work
// that belongs in a per-project queue, and it needs a stop button more than it
// needs persistence across a restart.

interface SweepState {
  running: boolean
  /** Preview and move share one watcher-visible operation, never one long HTTP response. */
  phase: 'preview' | 'run' | null
  /** A run checks proof before it can begin copying. */
  stage: 'checking' | 'moving' | null
  done: number
  total: number
  checked: number
  current: string
  stop: boolean
  result: unknown | null
  error: string
}
const sweep: SweepState = {
  running: false, phase: null, stage: null, done: 0, total: 0, checked: 0,
  current: '', stop: false, result: null, error: '',
}

router.post('/library/archive/preview', async (req, res) => {
  if (sweep.running) return res.status(409).json({ detail: 'An archive check or sweep is already running.' })
  Object.assign(sweep, {
    running: true, phase: 'preview', stage: 'checking', done: 0, total: 0, checked: 0,
    current: '', stop: false, result: null, error: '',
  })
  // A source can be a slow external disk. Holding this request open made the
  // shared deadline answer 503 and the eventual scan then tried to write a
  // second response. The status endpoint already exists for long archive work,
  // so preview uses the same one instead of inventing another job system.
  res.json({ started: true })

  void (async () => {
    try {
      const { previewArchiveSweep } = await import('../services/archive-sweep.js')
      // The sweep WALKS AND HASHES every file under `source_root`, which arrives
      // from the request body. `{"source_root":"/"}` therefore read and hashed
      // the whole disk — unbounded CPU and I/O, and a filename/size oracle over
      // anything readable.
      //
      // The root is deliberately NOT confined to the Library: sweeping a folder
      // the OWNER CHOSE is the feature, and it may legitimately be an external
      // drive or a temp folder (`archive-preview-route.test.ts` scans one).
      // Confining it broke that contract and the gate said so in one run. What
      // is refused is a root that means "everything": the filesystem root, the
      // home directory itself, and any path too shallow to be a folder someone
      // picked on purpose.
      const requestedRoot = typeof req.body?.source_root === 'string' ? req.body.source_root.trim() : ''
      if (requestedRoot) {
        const resolved = path.resolve(requestedRoot)
        const segments = resolved.split(path.sep).filter(Boolean)
        const tooBroad = resolved === path.parse(resolved).root
          || resolved === path.resolve(os.homedir())
          || segments.length < 2
        if (tooBroad) {
          sweep.error = 'Choose the folder that holds the videos — a whole disk or your home folder is too broad to scan.'
          return
        }
      }
      sweep.result = await previewArchiveSweep({
        sourceRoot: req.body?.source_root,
        shouldStop: () => sweep.stop,
        onProgress: (checked, current) => { Object.assign(sweep, { checked, current }) },
      })
    } catch (e: any) {
      sweep.error = e?.message || 'Could not work out what would be archived'
    } finally {
      sweep.running = false
    }
  })()
})

router.post('/library/archive/run', async (req, res) => {
  if (sweep.running) return res.status(409).json({ detail: 'An archive sweep is already running.' })
  const destination = typeof req.body?.destination === 'string' ? req.body.destination.trim() : ''
  if (!destination) return res.status(400).json({ detail: 'Choose a folder to move the videos into.' })
  // v1.4.10 — the run may only act on the list he reviewed. Without it, the
  // preview he approved and the sweep that executes are two separate
  // computations of "what should move", and only one of them was ever shown to
  // him.
  const approved = Array.isArray(req.body?.approved)
    ? (req.body.approved as unknown[]).filter((p): p is string => typeof p === 'string' && !!p.trim())
    : null
  if (!approved) {
    return res.status(400).json({ detail: 'Check what would move first, then run the sweep on that list.' })
  }

  Object.assign(sweep, {
    running: true, phase: 'run', stage: 'checking', done: 0, total: approved.length, checked: 0,
    current: '', stop: false, result: null, error: '',
  })
  // Answer immediately and report through /status: a 220 GB move would sit on
  // an open request for many minutes, and any proxy in between would give up
  // long before the copy did.
  res.json({ started: true })

  void (async () => {
    try {
      const { runArchiveSweep } = await import('../services/archive-sweep.js')
      sweep.result = await runArchiveSweep({
        destination,
        sourceRoot: req.body?.source_root,
        approved,
        shouldStop: () => sweep.stop,
        onCheckProgress: (checked, current) => { Object.assign(sweep, { stage: 'checking', checked, current }) },
        onProgress: (done, total, current) => { Object.assign(sweep, { stage: 'moving', done, total, current }) },
      })
    } catch (e: any) {
      sweep.error = e?.message || String(e)
    } finally {
      sweep.running = false
    }
  })()
})

router.get('/library/archive/status', (_req, res) => {
  res.json({
    running: sweep.running,
    phase: sweep.phase,
    stage: sweep.stage,
    done: sweep.done,
    total: sweep.total,
    checked: sweep.checked,
    current: sweep.current,
    stopping: sweep.stop && sweep.running,
    result: sweep.result,
    error: sweep.error,
  })
})

/**
 * Ask the archive check or sweep to stop. A preview stops between entries and
 * cannot become an approval bill; a sweep finishes the file it is on and stops
 * before the next one, so a copy is never interrupted midway.
 */
router.post('/library/archive/stop', (_req, res) => {
  sweep.stop = true
  res.json({ stopping: sweep.running })
})
