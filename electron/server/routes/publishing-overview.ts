/**
 * The global Publishing Overview — every channel in one read.
 *
 * Provider-free: it composes local stores only (see
 * services/publishing-overview.ts) and never calls YouTube. The one call that
 * talks to YouTube is the explicit refresh the page offers, which is the
 * existing POST /youtube/sync — this router adds no provider write and no
 * provider read on render.
 *
 * "No writes" is not strictly true. TWO shared readers on this path repair their
 * own state, both locked and idempotent, neither a migration and neither adding
 * new data:
 *
 *   - the operation-index reader may write its index back when it loads a
 *     repaired one (youtube-operation-store.ts `listYouTubeOperations`);
 *   - the connection-registry reader finishes an interrupted registry
 *     transaction and clears its pending secret (youtube-connection-store.ts
 *     `recoverPendingRegistryTransaction`, reached through
 *     `getProjectYouTubeAssignment`).
 *
 * The feature itself writes nothing: no plan migration (unlike
 * `readChannelSchedule`), no config change.
 */

import { Router } from 'express'

import { respondWithError } from '../lib/humanize-backend-error.js'
import { readPublishingOverview } from '../services/publishing-overview.js'

export const router = Router()

router.get('/publishing/overview', async (_req, res) => {
  try {
    // Same rule as GET /projects: a Library that was chosen and is not there
    // right now is NOT "you have no channels". Without this, an unplugged drive
    // would render as an empty overview — the 1.4.2 defect wearing a new hat.
    const { describeLibrary } = await import('../services/library.js')
    const library = await describeLibrary()
    if (library.configured && !library.exists) {
      return res.status(409).json({
        code: 'LIBRARY_UNAVAILABLE',
        library_path: library.path,
        detail: `Your Library is not available. Story Studio looked for "${library.path}" and it is not there. `
          + 'If it lives on a drive that is not plugged in, reconnect it and try again — nothing has been lost. '
          + 'If you moved it, point Story Studio at the new place in Settings → Storage.',
      })
    }
    res.json(await readPublishingOverview())
  } catch (e: any) {
    respondWithError(res, e, 'Could not build the publishing overview')
  }
})
