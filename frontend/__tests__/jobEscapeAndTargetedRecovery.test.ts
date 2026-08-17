/**
 * v1.2.8 — the two new ways out of a stuck job, asserted against the shipped
 * sources rather than a copy of them.
 *
 * The bug being guarded: a job that could not be cancelled, could not be
 * deleted, and offered only a disabled "Checking provider status" button — no
 * exit at all. Two things must therefore be true on the Jobs page and stay
 * true: the override is confirmed before it fires and says honestly what it
 * cannot do, and the targeted recovery it points at scans one episode rather
 * than the whole library.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(process.cwd(), '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const jobsPage = read('frontend/pages/projects/[slug]/jobs.vue')
const board = read('frontend/pages/projects/[slug]/board.vue')
const repairDialog = read('frontend/components/RepairAssetsDialog.vue')
const jobControl = read('electron/server/services/job-control.ts')

describe('force-abandon on the Jobs page', () => {
  it('confirms before it fires, using the backend\'s own wording', () => {
    assert.match(
      jobsPage,
      /control\.action === 'force-abandon'[\s\S]{0,400}useConfirm\(\)[\s\S]{0,300}message: control\.reason/,
      'the abandon confirmation must be populated from control.reason, not from a second copy of the wording',
    )
    assert.match(jobsPage, /confirmLabel: 'Abandon this job'/)
    // No confirmation, no request.
    assert.match(jobsPage, /\}\)\) return\n\s*\}\n\s*controlBusy\.value/)
  })

  it('posts to the abandon endpoint and points the user at Retry', () => {
    assert.match(jobsPage, /post\(`\$\{jobQueuePath\(job\)\}\/abandon`, \{\}\)/)
    assert.match(jobsPage, /use Retry on this row to run the step again/)
  })

  it('states all three things it does not do, in the confirmation itself', () => {
    // The dialog renders `control.reason` verbatim, so this is the text the
    // customer reads before agreeing. Each clause is asserted separately so a
    // future edit cannot quietly drop one.
    assert.match(jobControl, /does not cancel provider work GenStudio has already accepted/)
    assert.match(jobControl, /does not refund credits already spent/)
    assert.match(jobControl, /Output may still arrive, and it stays recoverable/)
    // And it is not written as a scare. He has accepted these consequences.
    assert.doesNotMatch(jobControl, /FORCE_ABANDON_REASON[\s\S]{0,600}?(WARNING|irreversible|cannot be undone)/i)
  })

  it('re-running is reachable from the same row, because Retry covers cancelled jobs', () => {
    const retryButtons = jobsPage.match(/v-if="job\.status === 'error' \|\| job\.status === 'cancelled'"/g) || []
    assert.equal(retryButtons.length, 2, 'both the active and the history lists must offer Retry')
  })
})

describe('per-episode targeted recovery', () => {
  it('links to the episode-scoped repair, and only where the per-job Repair cannot help', () => {
    assert.match(jobsPage, /function episodeRecoveryLink\(job: RJob\): string \| null/)
    assert.match(jobsPage, /if \(jobCanBeRepaired\(job\)\) return null/)
    assert.match(jobsPage, /board\?repair=1&episode=\$\{encodeURIComponent\(job\.episode_id\)\}/)
    // App-level jobs have no episode to recover.
    assert.match(jobsPage, /project === '_app_' \|\| !job\.episode_id\) return null/)
  })

  it('is offered in both the active and the history lists', () => {
    const links = jobsPage.match(/episodeRecoveryLink\(job\)!/g) || []
    assert.equal(links.length, 2)
  })

  it('the board passes the episode through and clears it on close', () => {
    assert.match(board, /:episode-code="repairEpisode"/)
    assert.match(board, /route\.query\.episode === 'string' \? route\.query\.episode : undefined/)
    assert.match(board, /function onRepairClosed\(\)[\s\S]{0,200}repairEpisode\.value = undefined/)
  })

  it('the dialog scopes the audit request instead of filtering a full scan', () => {
    assert.match(repairDialog, /props\.episodeCode \? `\?episode=\$\{encodeURIComponent\(props\.episodeCode\)\}` : ''/)
    assert.match(repairDialog, /assets\/repair-all`, props\.episodeCode \? \{ episode_codes: \[props\.episodeCode\] \} : \{\}\)/)
  })

  it('says which of the two it is doing, so a scoped run is never mistaken for a full one', () => {
    assert.match(repairDialog, /Recover \$\{episodeCode\} — generated but not received/)
    assert.match(repairDialog, /Nothing else in the library is scanned or touched/)
    // The library-wide wording survives untouched for the unscoped case.
    assert.match(repairDialog, /Scans every accepted episode for gaps/)
  })
})
