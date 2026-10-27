/**
 * Sound Design — the retired standalone router (v1.4.365).
 *
 * The page it served is gone: "Sound & Labels" is one page now and
 * `routes/sound-and-labels.ts` answers for both halves. This router stays
 * mounted only so a stale bookmark or an in-flight request reads a plain 410
 * with the new address in `detail`, rather than a bare 404 that reads like the
 * feature was deleted.
 *
 * Nothing here writes. The file it used to own (`sound_design.json`) is
 * untouched and still read by the merged route, the renderer and the board.
 */
import { Router } from 'express'

export const router = Router()

const RETIRED = {
  detail: 'Sound Design is now part of Sound & Labels. Open the Sound & Labels page for this episode.',
  moved_to: '/sound-and-labels',
}

router.use('/projects/:slug/sound-design', (_req, res) => {
  res.status(410).json(RETIRED)
})
