import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  checkRunningJobsAction, redoFailedJobsAction, MORE_ACTION_HINTS,
  providerHoldReason, classifyCheckedJob, describeCheckResult,
} from '../utils/job-actions-bar.js'
import { jobDisplayStatus } from '../utils/episode-recovery.js'

const idle = { self: false, other: false }

test('Check Running Jobs counts what it will ask about and says it never charges', () => {
  const a = checkRunningJobsAction({ unsettled: 2, repairable: 3, episodes: 1, running: 4 }, idle)
  assert.equal(a.label, 'Check Running Jobs (6)')
  assert.equal(a.disabled, false)
  assert.match(a.hint, /Never generates anything new or charges/)
})

test('Check is off with a reason when there is nothing to check', () => {
  const running = checkRunningJobsAction({ unsettled: 0, repairable: 0, episodes: 0, running: 2 }, idle)
  assert.equal(running.disabled, true)
  assert.match(running.hint, /2 running jobs are watched automatically/)
  assert.match(checkRunningJobsAction({ unsettled: 0, repairable: 0, episodes: 0, running: 0 }, idle).hint, /no failed or unfinished jobs/)
  assert.match(checkRunningJobsAction({ unsettled: 1, repairable: 0, episodes: 0, running: 0 }, { self: false, other: true }).hint, /Wait for the action/)
})

test('Retry Failed Jobs promises no double charge and names what waits for a check', () => {
  const a = redoFailedJobsAction({ redo: 10, waitingForCheck: 3, alreadyComplete: 0 }, idle)
  assert.equal(a.label, 'Retry Failed Jobs (10)')
  assert.equal(a.disabled, false)
  assert.match(a.hint, /not charged twice/)
  assert.match(a.hint, /3 more wait for "Check Running Jobs" first/)
})

test('Retry is off with the reason that actually applies', () => {
  assert.match(redoFailedJobsAction({ redo: 0, waitingForCheck: 2, alreadyComplete: 0 }, idle).hint, /click "Check Running Jobs" first/)
  assert.match(redoFailedJobsAction({ redo: 0, waitingForCheck: 0, alreadyComplete: 4 }, idle).hint, /found every file/)
  const none = redoFailedJobsAction({ redo: 0, waitingForCheck: 0, alreadyComplete: 0 }, idle)
  assert.equal(none.disabled, true)
  assert.equal(none.hint, 'Nothing failed.')
  assert.equal(redoFailedJobsAction({ redo: 5, waitingForCheck: 0, alreadyComplete: 0 }, { self: true, other: false, progress: 'Retrying 2/5…' }).label, 'Retrying 2/5…')
})

test('every supplementary action has a one-line hint saying what it never does', () => {
  assert.match(MORE_ACTION_HINTS.recover, /Never generates or charges/)
  assert.match(MORE_ACTION_HINTS.repair, /Never generates or charges/)
  assert.match(MORE_ACTION_HINTS.clearFailed, /Keeps files and billing records/)
  assert.match(MORE_ACTION_HINTS.clearFinished, /Keeps files and billing records/)
})

test('Recover and Repair hints say what each one looks at, so they are not clicked at random', () => {
  assert.match(MORE_ACTION_HINTS.recover, /^Per episode:/)
  assert.match(MORE_ACTION_HINTS.repair, /^Per failed job:/)
})

// Dreamlands 2026-10-03 (LOG 10:41): after "Check on running jobs (5)" the bar
// still said "1 more waits for 'Check on running jobs' first" — a loop.
test('a job the check already looked at is never told to wait for the check again', () => {
  assert.equal(providerHoldReason(undefined, false), 'waiting-for-check')
  assert.equal(providerHoldReason('checking', true), 'could-not-check')
  assert.equal(providerHoldReason('unreachable', false), 'could-not-check')
  assert.equal(providerHoldReason('unsettled', true), 'still-running')
  const afterCheck = redoFailedJobsAction({ redo: 0, waitingForCheck: 0, stillRunning: 1, couldNotCheck: 1, alreadyComplete: 0 }, idle)
  assert.doesNotMatch(afterCheck.hint, /Check Running Jobs/)
  assert.match(afterCheck.hint, /1 is still running on the Macs/)
  assert.match(afterCheck.hint, /1 could not be checked/)
  const mixed = redoFailedJobsAction({ redo: 2, waitingForCheck: 0, stillRunning: 1, alreadyComplete: 0 }, idle)
  assert.equal(mixed.disabled, false)
  assert.doesNotMatch(mixed.hint, /wait.? for "Check Running Jobs"/)
})

test('the check ends with one plain line and names any recovery jobs it started', () => {
  const outcomes = [
    classifyCheckedJob({ displayStatus: 'recovered' }),
    classifyCheckedJob({ displayStatus: 'error', repairable: true, repair: { outcome: 'measured', result: { stillMissing: 0 } } }),
    classifyCheckedJob({ displayStatus: 'error', hold: 'still-running' }),
    classifyCheckedJob({ displayStatus: 'error', repairable: true, repair: { outcome: 'measured', result: { stillMissing: 2 } } }),
    classifyCheckedJob({ displayStatus: 'error' }),
  ]
  assert.equal(describeCheckResult(outcomes), 'Checked 5: 2 finished and saved, 1 still running, 2 need Retry.')
  assert.equal(classifyCheckedJob({ displayStatus: 'error', repairable: true }), 'could-not-check', 'a repair that never answered is not "needs Redo"')
  assert.match(describeCheckResult(outcomes, 3), /Started 3 free image recovery jobs \(downloads only, no charge\)\.$/)
})

test('a failed row the backend settled shows as Recovered, not "needs attention"', () => {
  assert.equal(jobDisplayStatus({ status: 'error', resolved: { reason: 'made later' } }), 'recovered')
  assert.equal(jobDisplayStatus({ status: 'error' }), 'error')
  assert.equal(jobDisplayStatus({ status: 'cancelled', resolved: { reason: 'x' } }), 'cancelled')
})

test('Jobs page: the check counts only what it has not looked at, repairs thumbnails in place and never waits minutes per job', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)), 'utf8')
  const check = page.slice(page.indexOf('async function checkOnRunningJobs('), page.indexOf('function retryAllAttentionLabel('))
  assert.match(page, /repairable: repairableFailedJobs\.value\.filter\(needsRepairCheck\)\.length/, 'a repaired job leaves the check count')
  assert.match(page, /episodes: recoverableEpisodes\.value\.filter\(job => !episodesLookedAt\.value\.has/, 'a recovered episode leaves the check count')
  assert.match(page, /source_job_id: '__JOB__'/, 'thumbnail Repair works on the failed job itself — no second row')
  assert.doesNotMatch(page, /waitForJobTerminal/, 'no 10-minute wait per repair job')
  assert.match(check, /settle-completed|settleCompletedFailures\(\)/)
  assert.match(check, /describeCheckResult\(outcomes, imagesQueued\)/)
  assert.doesNotMatch(check, /retryAllFailed|\/retry`/, 'the check never starts generation')
})
