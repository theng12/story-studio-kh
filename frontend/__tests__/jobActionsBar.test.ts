import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkRunningJobsAction, redoFailedJobsAction, MORE_ACTION_HINTS } from '../utils/job-actions-bar.js'

const idle = { self: false, other: false }

test('Check on running jobs counts what it will ask about and says it never charges', () => {
  const a = checkRunningJobsAction({ unsettled: 2, repairable: 3, episodes: 1, running: 4 }, idle)
  assert.equal(a.label, 'Check on running jobs (6)')
  assert.equal(a.disabled, false)
  assert.match(a.hint, /Never starts new work or charges/)
})

test('Check is off with a reason when there is nothing to check', () => {
  const running = checkRunningJobsAction({ unsettled: 0, repairable: 0, episodes: 0, running: 2 }, idle)
  assert.equal(running.disabled, true)
  assert.match(running.hint, /2 running jobs are watched automatically/)
  assert.match(checkRunningJobsAction({ unsettled: 0, repairable: 0, episodes: 0, running: 0 }, idle).hint, /no failed or unfinished jobs/)
  assert.match(checkRunningJobsAction({ unsettled: 1, repairable: 0, episodes: 0, running: 0 }, { self: false, other: true }).hint, /Wait for the action/)
})

test('Redo failed jobs promises no double charge and names what waits for a check', () => {
  const a = redoFailedJobsAction({ redo: 10, waitingForCheck: 3, alreadyComplete: 0 }, idle)
  assert.equal(a.label, 'Redo failed jobs (10)')
  assert.equal(a.disabled, false)
  assert.match(a.hint, /not charged twice/)
  assert.match(a.hint, /3 more wait for "Check on running jobs" first/)
})

test('Redo is off with the reason that actually applies', () => {
  assert.match(redoFailedJobsAction({ redo: 0, waitingForCheck: 2, alreadyComplete: 0 }, idle).hint, /click "Check on running jobs" first/)
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
