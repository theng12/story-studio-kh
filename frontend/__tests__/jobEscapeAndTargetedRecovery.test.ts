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
  it('is offered ONLY where recovering the episode can actually help', () => {
    // v1.4.43 — this was the inverse rule ("anything the per-job Repair does
    // not cover"), which put the button on Scene Plan (text — nothing to
    // recover) and Scene Review (files the audit cannot see), the two the
    // owner was actually looking at. An allow-list cannot drift that way.
    assert.match(jobsPage, /const EPISODE_RECOVERY_TYPES = new Set\(\['audio_merge', 'video_assembly'\]\)/)
    assert.match(jobsPage, /if \(!EPISODE_RECOVERY_TYPES\.has\(job\.type\)\) return null/)
    assert.match(jobsPage, /board\?repair=1&episode=\$\{encodeURIComponent\(job\.episode_id\)\}/)
    // App-level jobs have no episode to recover.
    assert.match(jobsPage, /project === '_app_' \|\| !job\.episode_id\) return null/)
  })

  it('never points at a job type that no longer exists', () => {
    // `images` / `scene_images` went with the retired generator in 1.4.41.
    const map = jobsPage.slice(jobsPage.indexOf('const REPAIR_ENDPOINTS'))
    const decl = map.slice(0, map.indexOf('\nfunction jobCanBeRepaired'))
    // Match the key at the start of its own line — `thumb_images:` ends with
    // the string `images:`, and a substring check "passes" by finding the key
    // that is supposed to still be there.
    for (const dead of ['images', 'scene_images']) {
      assert.doesNotMatch(decl, new RegExp(`^\\s{2}${dead}: \\{`, 'm'),
        `${dead} is a retired job type and cannot be repaired`)
    }
    for (const live of ['audio', 'thumb_images']) {
      assert.match(decl, new RegExp(`^\\s{2}${live}: \\{`, 'm'))
    }
  })

  it('is offered in both the active and the history lists', () => {
    const links = jobsPage.match(/episodeRecoveryLink\(job\)!/g) || []
    assert.equal(links.length, 2)
  })

  it('Retry tells the truth about Scene Review, which recovers for free', () => {
    // The generator replays its task manifest and pulls back every image the
    // provider already produced before it re-submits anything. The tooltip
    // used to say the opposite — "no partial/repair path" — which made the
    // free option read as the expensive one.
    assert.match(jobsPage, /jobType === 'continuity_render'/)
    assert.match(jobsPage, /FREE WHERE POSSIBLE[^']*at no charge/)
  })

  it('the board accepts a LIST of episodes and clears it on close', () => {
    assert.match(board, /:episode-codes="repairEpisodes"/)
    assert.match(board, /const list = Array\.isArray\(raw\) \? raw : \[raw\]/)
    assert.match(board, /function onRepairClosed\(\)[\s\S]{0,200}repairEpisodes\.value = \[\]/)
  })

  it('the dialog scopes the audit request instead of filtering a full scan', () => {
    assert.match(repairDialog, /episode=\$\{encodeURIComponent\(code\)\}`\)\.join\('&'\)/)
    assert.match(repairDialog, /assets\/repair-all`, isScoped\.value \? \{ episode_codes: scopedCodes\.value \} : \{\}\)/)
  })

  it('says which of the two it is doing, so a scoped run is never mistaken for a full one', () => {
    assert.match(repairDialog, /Recover \$\{scopeLabel\} — generated but not received/)
    assert.match(repairDialog, /Nothing else in the library is scanned or touched/)
    // The library-wide wording survives untouched for the unscoped case.
    assert.match(repairDialog, /Scans every accepted episode for gaps/)
  })
})

describe('every entry point that already knows the episodes hands them over', () => {
  // The owner's objection, verbatim: *"it didn't fix the one error but brings
  // me here and run a channel wide hunt. waste of time. we just need what we
  // need to get repaired. not a witch hunt."* Each of these screens had the
  // failing episode codes on screen and threw them away on the way to Repair.
  it('the batch-finished banner repairs the episodes that failed in that batch', () => {
    assert.match(jobsPage, /const batchRepairLink = computed\(\(\) => \{/)
    assert.match(jobsPage, /batchSummary\.value\?\.failed_episodes \|\| \[\]/)
    assert.match(jobsPage, /:to="batchRepairLink"/)
  })

  it('the missing-assets report repairs the episodes it just listed', () => {
    const dialog = read('frontend/components/MissingAssetsDialog.vue')
    assert.match(dialog, /const gapCodes = computed\(\(\) => episodesWithGaps\.value/)
    assert.match(dialog, /const repairLink = computed\(/)
    assert.ok(!dialog.includes('`/projects/${slug}/board?repair=1`'),
      'no path in this dialog may start an unscoped scan — it knows the codes')
  })

  it('the one remaining whole-project sweep says so on the button', () => {
    // It is allowed to exist; it is not allowed to look like the per-job fix.
    assert.match(jobsPage, /Scan all for repair/)
    assert.match(jobsPage, /Scans EVERY accepted episode in this project/)
  })
})
