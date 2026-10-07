/**
 * v1.2.8 — the two new ways out of a stuck job, asserted against the shipped
 * sources rather than a copy of them.
 *
 * The bug being guarded: a job that could not be cancelled, could not be
 * deleted, and offered only a disabled "Checking provider status" button — no
 * exit at all. Two things must therefore be true on the Jobs page and stay
 * true: the override is confirmed before it fires and says honestly what it
 * cannot do, and targeted recovery stays on the job that needs it rather than
 * navigating to a second screen or scanning the library.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(process.cwd(), '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const jobsPage = read('frontend/pages/projects/[slug]/jobs.vue')
const jobControl = read('electron/server/services/job-control.ts')

describe('force-abandon on the Jobs page', () => {
  it('confirms before it fires, using the backend\'s own wording', () => {
    assert.match(
      jobsPage,
      /control\.action === 'force-abandon'[\s\S]{0,400}useConfirm\(\)[\s\S]{0,300}message: control\.reason/,
      'the abandon confirmation must be populated from control.reason, not from a second copy of the wording',
    )
    assert.match(jobsPage, /confirmLabel: 'Abandon This Job'/)
    // No confirmation, no request.
    assert.match(jobsPage, /\}\)\) return\n\s*\}\n\s*controlBusy\.value/)
  })

  it('posts to the abandon endpoint and points the user at Retry', () => {
    assert.match(jobsPage, /post(?:<\{ job: Job \}>)?\(`\$\{jobQueuePath\(job\)\}\/abandon`, \{\}\)/)
    assert.match(jobsPage, /use Retry on this row to run the step again/)
  })

  it('states all three things it does not do, in the confirmation itself', () => {
    // The dialog renders `control.reason` verbatim, so this is the text the
    // customer reads before agreeing. Each clause is asserted separately so a
    // future edit cannot quietly drop one.
    assert.match(jobControl, /does not cancel provider work the Gateway has already accepted/)
    assert.match(jobControl, /does not refund credits already spent/)
    assert.match(jobControl, /Output may still arrive, and it stays recoverable/)
    // And it is not written as a scare. He has accepted these consequences.
    assert.doesNotMatch(jobControl, /FORCE_ABANDON_REASON[\s\S]{0,600}?(WARNING|irreversible|cannot be undone)/i)
  })

  it('re-running is reachable from ordinary cancelled rows without disguising paid auto-repair as Retry', () => {
    const retryButtons = jobsPage.match(/v-if="canRetryJob\(job\)"/g) || []
    assert.equal(retryButtons.length, 1, 'only the history list offers Retry: the active list never holds failed jobs')
    const eligibility = jobsPage.slice(jobsPage.indexOf('function canRetryJob('), jobsPage.indexOf('function customerJobText('))
    assert.match(eligibility, /\['error', 'cancelled'\]\.includes\(job\.status\)/)
    assert.match(eligibility, /isRecoveredFailure\(job\)/)
    assert.match(eligibility, /isTerminalContinuityRender\(job\)/)
    assert.match(eligibility, /auto_repair_missing_prompts === true\) return false/)
    assert.equal((jobsPage.match(/v-if="isTerminalContinuityRender\(job\)"/g) || []).length, 1,
      'the history list offers Finish Missing Images for failed continuity renders')
    assert.equal((jobsPage.match(/@click="finishMissingImages\(job\)"/g) || []).length, 1)
  })
})

describe('per-episode targeted recovery', () => {
  it('links structured image issues to the exact Scene Review scene and distinguishes recovery from submission', () => {
    assert.match(jobsPage, /function jobAttentionLinks\(job: RJob\)/)
    assert.match(jobsPage, /completion\?\.issues/)
    assert.match(jobsPage, /scene-review\?episode_id=.*scene_id=/)
    assert.match(jobsPage, /paidReplacementAttemptMessage\(job: RJob\)/)
    // Plain-English wording (owner, 2026-10-03) still says nothing was submitted.
    assert.match(jobsPage, /nothing new was sent/i)
  })

  it('links the current structured subtitle prerequisite to its exact chapter', () => {
    assert.match(jobsPage, /currentSubtitleAttention/)
    assert.match(jobsPage, /const suffix = section \? `&section=\$\{encodeURIComponent\(section\)\}` : ''/)
    assert.match(jobsPage, /subtitle coverage gap/i)
  })

  it('uses typed current status for legacy Scene Plan rows and preserves structured image reasons', () => {
    assert.match(jobsPage, /loadCurrentSubtitleAttention/)
    assert.match(jobsPage, /video-editor\/subtitles\/timeline-integrity/)
    assert.doesNotMatch(
      jobsPage.slice(jobsPage.indexOf('async function loadCurrentSubtitleAttention'), jobsPage.indexOf('const SAFE_IMAGE_ISSUE_REASONS')),
      /video-editor\/subtitles\/status/,
      'historical rows must not run the full audio-hashing subtitle status check',
    )
    assert.match(jobsPage, /currentSubtitleAttentionSweepRunning/)
    assert.match(jobsPage, /await loadCurrentSubtitleAttention\(next\[1\]\)/)
    assert.match(jobsPage, /Current subtitle coverage gap/)
    assert.match(jobsPage, /SAFE_IMAGE_ISSUE_REASONS/)
    assert.match(jobsPage, /SAFE_PROMPT_ISSUE_REASONS/)
    assert.match(jobsPage, /const hasOpaqueLegacyInvalid = !structured\.length && legacyInvalid\.some/)
    assert.match(jobsPage, /scene_plan_run/)
    assert.match(jobsPage, /original_failure_not_eligible/)
    // Plain-English wording (owner, 2026-10-03) still says nothing was submitted.
    assert.match(jobsPage, /nothing new was sent/i)
  })

  it('shares one slow admission refresh instead of piling up interval requests', () => {
    assert.match(jobsPage, /let genStudioCapacityRequest: Promise<void> \| null = null/)
    assert.match(jobsPage, /if \(genStudioCapacityRequest\) return genStudioCapacityRequest/)
    assert.match(jobsPage, /genStudioCapacityRequest = null/)
  })

  it('offers direct recovery only for assembly jobs where existing assets can help', () => {
    assert.match(jobsPage, /const EPISODE_RECOVERY_TYPES = new Set\(\['audio_merge', 'video_assembly'\]\)/)
    assert.match(jobsPage, /function canRecoverEpisode\(job: RJob\): boolean/)
    assert.match(jobsPage, /\(job\.status === 'error' \|\| job\.status === 'cancelled'\)/)
    assert.match(jobsPage, /EPISODE_RECOVERY_TYPES\.has\(job\.type\)/)
    assert.match(jobsPage, /project !== '_app_' && !!job\.episode_id/)
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

  it('recovers in place from the history list and never opens the Board repair modal', () => {
    assert.equal((jobsPage.match(/v-if="canRecoverEpisode\(job\)"/g) || []).length, 1)
    assert.equal((jobsPage.match(/@click="recoverEpisode\(job\)"/g) || []).length, 1)
    assert.equal((jobsPage.match(/:disabled="episodeRecoveryBusy\(job\)"/g) || []).length, 1)
    assert.doesNotMatch(jobsPage, /episodeRecoveryLink|board\?repair=1|Scan all for repair|RepairAssetsDialog/)
  })

  it('keeps free recovery separate from retrying unfinished work', () => {
    assert.match(jobsPage, /recoverEpisodeAssets\(jobProjectSlug\(job\), job\.episode_id, post/)
    assert.match(jobsPage, /Checking this episode’s existing audio and images/)
    const directRecovery = jobsPage.slice(jobsPage.indexOf('async function recoverEpisode'), jobsPage.indexOf('async function recoverAllEpisodes'))
    assert.doesNotMatch(directRecovery, /retryJob\(|recover-episode|generate\//)
  })

  it('deduplicates and locks each project plus episode while recovery is in flight', () => {
    assert.match(jobsPage, /function episodeRecoveryKey\(job: RJob\): string \{ return `\$\{jobProjectSlug\(job\)\}:\$\{job\.episode_id\}` \}/)
    assert.match(jobsPage, /const seen = new Set<string>\(\)/)
    assert.match(jobsPage, /if \(seen\.has\(key\)\) return false/)
    assert.match(jobsPage, /recoveringEpisodes\.value\.has\(episodeRecoveryKey\(job\)\)/)
    assert.match(jobsPage, /other\.type === 'images_repair'/)
  })
})

describe('one-click Rebuild Timeline for a Scene Plan that cannot continue', () => {
  it('is offered only for the structured attention the generator writes', () => {
    assert.match(jobsPage, /attention\?\.kind === 'scene_plan_rebuild'/)
    assert.match(jobsPage, /v-if="needsTimelineRebuild\(job\)"[\s\S]{0,300}@click="rebuildTimeline\(job\)"/)
  })

  it('confirms the replacement first, then queues only the timeline stage', () => {
    assert.match(jobsPage, /async function rebuildTimeline[\s\S]{0,200}useConfirm\(\)\.ask\(\{[\s\S]{0,500}confirmLabel: 'Rebuild Timeline'[\s\S]{0,120}if \(!ok\) return/)
    assert.match(jobsPage, /post\(`\/projects\/\$\{jobProjectSlug\(job\)\}\/scene-plan\/\$\{encodeURIComponent\(job\.episode_id!\)\}\/run`, \{ stage: 'timeline' \}\)/)
  })
})
