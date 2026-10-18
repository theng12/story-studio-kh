/**
 * One episode-probe bound, shared by both readiness sweeps.
 *
 * ── Why the bound is 4 and not 32 ──
 *
 * Both surfaces that ask "which episodes are finished and not on YouTube yet" —
 * the global Publishing Overview and the Upload Center's publishable listing —
 * resolve EVERY accepted episode. Each one costs a sidecar resolution plus a
 * rendered-video probe, so a 19-channel / 854-episode Library is tens of
 * thousands of async fs calls. Those share ONE libuv threadpool with everything
 * else in the process, and on the production Mac mini (2026-10-18) an in-flight
 * upload reading 2–4 GB through that pool at 32-wide fan-out turned the whole
 * app unresponsive: GET /projects 49 s, /thumbnails 22 s, /app-update/status
 * 45 s, preview-media streams stalled.
 *
 * ── What is pinned ──
 *
 * The number, and that BOTH files take it from the one shared constant rather
 * than each carrying their own literal. They are the same sweep over the same
 * episodes; a bound that drifts apart between them is how the two screens start
 * disagreeing about readiness — which is the agreement the Publishing Overview
 * and the Upload Center were deliberately brought into.
 *
 * The fan-out width is not observable from outside (nothing in the sweep is
 * injectable), so the wiring is asserted against the source. What IS observable
 * is the constant's value, and that is asserted directly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function source(relative: string): string {
  return readFileSync(path.join(SERVER_ROOT, relative), 'utf8')
}

test('the sweep bound is small enough to leave the threadpool room', async () => {
  const { EPISODE_PROBE_BATCH } = await import('../services/utils.js')
  assert.ok(EPISODE_PROBE_BATCH >= 1, 'a zero-width batch would never finish the sweep')
  assert.ok(
    EPISODE_PROBE_BATCH <= 8,
    `EPISODE_PROBE_BATCH is ${EPISODE_PROBE_BATCH}: a sweep this wide queues thousands of fs calls `
    + 'behind the running uploads and stops the app answering (measured 2026-10-18)',
  )
})

test('both readiness sweeps take the bound from the one shared constant', () => {
  const overview = source('services/publishing-overview.ts')
  const uploadCenter = source('routes/youtube-upload-center.ts')

  assert.match(overview, /EPISODE_PROBE_BATCH/)
  assert.match(overview, /i \+= EPISODE_PROBE_BATCH/)
  assert.match(overview, /withCode\.slice\(i, i \+ EPISODE_PROBE_BATCH\)/)

  assert.match(uploadCenter, /EPISODE_PROBE_BATCH/)
  assert.match(uploadCenter, /const BATCH = EPISODE_PROBE_BATCH/)
  assert.match(uploadCenter, /i \+= BATCH/)

  // And neither carries its own literal again. The two that were here (32 and
  // 32) are exactly what this constant replaces.
  assert.doesNotMatch(uploadCenter, /const BATCH = \d/)
  assert.doesNotMatch(overview, /READINESS_BATCH/)
})
