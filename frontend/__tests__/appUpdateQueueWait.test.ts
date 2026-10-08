/** Updates wait for an empty queue (owner, 2026-10-08): the words the panel and the banner show. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installNowQuestion, waitingForQueueText } from '../utils/app-update.js'

test('the ready line counts the jobs left and says when a paused queue keeps it waiting', () => {
  assert.equal(waitingForQueueText('1.4.261', 3, false), 'Update 1.4.261 ready — installs when the queue is empty (3 jobs left).')
  assert.equal(waitingForQueueText('1.4.261', 1, false), 'Update 1.4.261 ready — installs when the queue is empty (1 job left).')
  assert.match(waitingForQueueText('1.4.261', 2, true), /The queue is paused with jobs still in it, so the update keeps waiting/)
  assert.doesNotMatch(waitingForQueueText('1.4.261', 0, true), /paused/)
})

test('Install Now asks like Quit does, and only when the queue holds jobs', () => {
  assert.equal(installNowQuestion('1.4.261', 0), null)
  const q = installNowQuestion('1.4.261', 2)!
  assert.equal(q.title, "2 jobs are in the queue; they'll continue after the update.")
  assert.match(q.message, /pauses the queue, lets running jobs finish \(up to 30 minutes\), installs 1\.4\.261 and restarts/)
  assert.match(installNowQuestion('1.4.261', 1)!.title, /^1 job is in the queue; it'll continue/)
})
