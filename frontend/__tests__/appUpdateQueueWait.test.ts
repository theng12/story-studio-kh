/** Updates install promptly (owner, 2026-10-09; 1.4.265): the words the panel and the banner show. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROMPT_INSTALL_TEXT, installNowQuestion, readyText, waitingText } from '../utils/app-update.js'

test('the ready line says it installs promptly, or that the owner\'s own pause holds it', () => {
  assert.equal(PROMPT_INSTALL_TEXT, "Installs as soon as it's ready (work resumes after the restart)")
  assert.equal(readyText('1.4.265', false), "Update 1.4.265 ready. Installs as soon as it's ready (work resumes after the restart).")
  assert.match(readyText('1.4.265', true), /You paused the queue, so it waits for you: resume the queue, or press Install Now/)
})

test('while it waits, it names what for: requests already sent, and jobs that cannot resume', () => {
  assert.equal(waitingText('1.4.265', null), 'Installing Story Studio 1.4.265: new work is paused. Everything else resumes after the restart.')
  assert.equal(
    waitingText('1.4.265', { submits: 1, jobs: ['music_video', 'music_video'] }),
    'Installing Story Studio 1.4.265: new work is paused; waiting for 1 request already sent to the Gateway to be answered'
      + ' and 2 jobs that cannot pick up where they stopped (music video). Everything else resumes after the restart.',
  )
})

test('Install Now asks like Quit does, and only when the queue holds jobs', () => {
  assert.equal(installNowQuestion('1.4.265', 0), null)
  const q = installNowQuestion('1.4.265', 2)!
  assert.equal(q.title, "2 jobs are in the queue; they'll continue after the update.")
  assert.match(q.message, /pauses new work, waits for requests already sent to the Gateway and for jobs that cannot pick up where they stopped \(up to 30 minutes\), installs 1\.4\.265 and restarts/)
  assert.match(installNowQuestion('1.4.265', 1)!.title, /^1 job is in the queue; it'll continue/)
})
