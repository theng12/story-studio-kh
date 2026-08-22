/**
 * The claim-walk exists twice on purpose. This is the alarm for when the two
 * copies stop agreeing.
 *
 * WHY A COPY AND NOT AN EXTRACTION (v1.4.20). `POST /upload/plans/:id/apply`
 * contains the same "find the latest FUTURE slot already claimed, so the walk
 * resumes past it" scan that `episode-autoschedule.ts` needs. Extracting it
 * would be the tidier move, and it was deliberately not done:
 *
 *   `upload-plans-compute.test.ts` covers `computeSlots` with fifteen tests.
 *   NOTHING covers the apply route — no test in this suite exercises
 *   `/upload/plans/` at all. Refactoring untested code that schedules the
 *   owner's real uploads means a mistake reaches YouTube before anything
 *   notices, and the owner weighed exactly that trade and chose the copy.
 *
 * So the duplication is bounded and watched instead. The hard part —
 * `computeSlots` and all its calendar, interval and monthly maths — is shared.
 * Only the scan is copied, and it must keep these four properties in both
 * places or the two paths will schedule differently:
 *
 *   1. PAST claims are ignored (a video that went live last week must not push
 *      new episodes further out)
 *   2. the target episode is EXCLUDED (so its own slot is not walked past)
 *   3. only `scheduled_for` counts
 *   4. the latest, not the first, wins
 *
 * WHEN THIS FAILS, read both copies and make them agree. Do not relax the test.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

async function source(rel: string): Promise<string> {
  return readFile(path.join(repoRoot, rel), 'utf8')
}

describe('the copied claim-walk cannot drift from the apply route', () => {
  test('both copies still ignore past claims, exclude the target, and take the latest', async () => {
    const routeSrc = await source('electron/server/routes/upload.ts')
    const autoSrc = await source('electron/server/services/episode-autoschedule.ts')

    const applyStart = routeSrc.indexOf('const targetSet = new Set(episode_codes)')
    assert.ok(applyStart > 0,
      'the apply route no longer builds a target set — the claim-walk has moved or changed shape, '
      + 'so this alarm must be re-pointed at it')
    const applyScan = routeSrc.slice(applyStart, applyStart + 1400)

    const walkStart = autoSrc.indexOf('export async function latestFutureClaim')
    assert.ok(walkStart > 0, 'latestFutureClaim must still exist in episode-autoschedule.ts')
    const walkScan = autoSrc.slice(walkStart, walkStart + 1400)

    const properties: Array<{ name: string; test: RegExp }> = [
      // 1. only future claims count
      { name: 'ignores past claims (compares against now)', test: /t\s*>\s*now/i },
      // 2. the episode being scheduled is skipped
      { name: 'excludes the target episode', test: /(targetSet\.has|===\s*excludeCode)/ },
      // 3. reads the same sidecar field
      { name: 'reads scheduled_for', test: /scheduled_for/ },
      // 4. keeps the latest, not the first
      { name: 'keeps the latest claim', test: /t\s*>\s*latest/i },
      // and both must parse the ISO string rather than compare it as text —
      // the v1.0.42 defect this scan replaced was a string Set that missed
      // any YouTube-synced timestamp without `.000Z` milliseconds.
      { name: 'parses the timestamp rather than string-matching', test: /Date\.parse/ },
    ]

    const missing: string[] = []
    for (const p of properties) {
      if (!p.test.test(applyScan)) missing.push(`apply route: ${p.name}`)
      if (!p.test.test(walkScan)) missing.push(`episode-autoschedule: ${p.name}`)
    }

    assert.deepEqual(missing, [],
      'The two claim-walks have drifted, so a one-click schedule and a manual apply will '
      + `disagree about where the next episode goes:\n  ${missing.join('\n  ')}`)
  })

  test('the apply route is still the untested one this copy exists to avoid touching', async () => {
    // The moment somebody covers the apply route, the argument for duplicating
    // changes and the extraction becomes the right call. This fails then, on
    // purpose, so the decision gets revisited rather than outliving its reason.
    const { readdir } = await import('node:fs/promises')
    const dir = path.join(repoRoot, 'electron/server/__tests__')
    const files = await readdir(dir)
    const exercisesApplyRoute: string[] = []
    for (const f of files) {
      if (!f.endsWith('.test.ts') || f.startsWith('episode-autoschedule')) continue
      const body = await readFile(path.join(dir, f), 'utf8')
      if (body.includes('upload/plans/') && body.includes('/apply')) exercisesApplyRoute.push(f)
    }
    assert.deepEqual(exercisesApplyRoute, [],
      'The apply route now has test coverage: '
      + `${exercisesApplyRoute.join(', ')}. The reason latestFutureClaim was copied instead of `
      + 'extracted was that refactoring it was unsafe without tests. Extract it now and delete '
      + 'this file.')
  })
})
