/** Updates install promptly (owner, 2026-10-09; 1.4.265): the words the panel and the banner show. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROMPT_INSTALL_TEXT, installNowQuestion, readyText, waitingText } from '../utils/app-update.js'

test('the ready line says it installs promptly, or that the owner\'s own pause holds it', () => {
  assert.equal(PROMPT_INSTALL_TEXT, "Installs as soon as it's ready (work resumes after the restart)")
  assert.equal(readyText('1.4.265', false), "Update 1.4.265 ready. Installs as soon as it's ready (work resumes after the restart).")
  assert.match(readyText('1.4.265', true), /You paused the queue, so it waits for you: resume the queue, or press Install Now/)
})

test('a storage operation holding the Mac is named, and the queue is said to keep running', () => {
  // 2026-10-19/20: a staged release waited on a ~9-hour all-channel Free Up Space run. The queue
  // runs through it, and the line must not leave the owner thinking work has stopped.
  assert.equal(
    readyText('1.4.333', false, { kind: 'run', status: 'running' }),
    'Update 1.4.333 ready. It waits for the media cleanup to finish before installing; the queue keeps running.',
  )
  assert.equal(
    readyText('1.4.333', false, { kind: 'preview', status: 'verifying' }),
    'Update 1.4.333 ready. It waits for the file review to finish before installing; the queue keeps running.',
  )
  // The owner's own pause is still his to act on, and it is said first.
  assert.match(readyText('1.4.333', true, { kind: 'run', status: 'running' }), /You paused the queue/)
  assert.equal(readyText('1.4.333', false, null), "Update 1.4.333 ready. Installs as soon as it's ready (work resumes after the restart).")
})

test('while it waits, it names what for: requests already sent, and jobs that cannot resume', () => {
  assert.equal(waitingText('1.4.265', null), 'Installing Story Studio 1.4.265: new work is paused. Everything else resumes after the restart.')
  assert.equal(
    waitingText('1.4.265', { submits: 1, jobs: ['music_video', 'music_video'] }),
    'Installing Story Studio 1.4.265: new work is paused; waiting for 1 request already sent to the Gateway to be answered'
      + ' and 2 jobs that cannot pick up where they stopped (music video). Everything else resumes after the restart.',
  )
})

test('a final check still measuring a finished video is named too, so the wait is never unexplained', () => {
  // The check runs in the background: it is not a queue job either, and a restart loses the whole
  // measurement rather than resuming it.
  assert.equal(
    waitingText('1.4.265', { submits: 0, jobs: [], finalChecks: 1 }),
    'Installing Story Studio 1.4.265: new work is paused; waiting for 1 final check still measuring'
      + ' a finished video. Everything else resumes after the restart.',
  )
  assert.equal(
    waitingText('1.4.265', { submits: 0, jobs: [], finalChecks: 2 }),
    'Installing Story Studio 1.4.265: new work is paused; waiting for 2 final checks still measuring'
      + ' a finished video. Everything else resumes after the restart.',
  )
})

test('a storage operation that cannot resume is named too, as a review or a cleanup', () => {
  // Free up space / Clear Uploaded Videos are not queue jobs, so `jobs` is empty and it is named on
  // its own: without this the line would say the update is waiting for nothing.
  assert.equal(
    waitingText('1.4.265', { submits: 0, jobs: [], maintenance: { kind: 'run', status: 'running' } }),
    'Installing Story Studio 1.4.265: new work is paused; waiting for the media cleanup to finish'
      + ' (it cannot pick up where it stopped). Everything else resumes after the restart.',
  )
  assert.equal(
    waitingText('1.4.265', { submits: 0, jobs: [], maintenance: { kind: 'preview', status: 'verifying' } }),
    'Installing Story Studio 1.4.265: new work is paused; waiting for the file review to finish'
      + ' (it cannot pick up where it stopped). Everything else resumes after the restart.',
  )
  assert.equal(
    waitingText('1.4.265', { submits: 0, jobs: [], maintenance: null }),
    'Installing Story Studio 1.4.265: new work is paused. Everything else resumes after the restart.',
  )
})

test('Install Now asks like Quit does, and only when the queue holds jobs', () => {
  assert.equal(installNowQuestion('1.4.265', 0), null)
  const q = installNowQuestion('1.4.265', 2)!
  assert.equal(q.title, "2 jobs are in the queue; they'll continue after the update.")
  assert.match(q.message, /pauses new work, waits for requests already sent to the Gateway and for jobs that cannot pick up where they stopped \(up to 30 minutes\), installs 1\.4\.265 and restarts/)
  assert.match(installNowQuestion('1.4.265', 1)!.title, /^1 job is in the queue; it'll continue/)
})

test('Install now (don\'t wait) is offered while a release downloads, is ready or waits, and asks first', async () => {
  const { INSTALL_IMMEDIATELY_LABEL, canInstallImmediately, installImmediatelyQuestion } = await import('../utils/app-update.js')
  for (const phase of ['downloading', 'ready', 'draining']) assert.equal(canInstallImmediately(phase), true, phase)
  for (const phase of ['idle', 'installing', 'installed', 'failed', 'rolled_back', undefined]) assert.equal(canInstallImmediately(phase), false, String(phase))
  assert.equal(INSTALL_IMMEDIATELY_LABEL, "Install now (don't wait)")
  assert.equal(
    installImmediatelyQuestion('1.4.310').message,
    'Running jobs are stopped now and pick up again after the restart (paid work that cannot resume waits for Retry). Install Story Studio 1.4.310 now?',
  )
})

test('the banner and the Settings panel both ask, then post { immediately: true }; plain Install Now posts {}', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['AppUpdateBanner.vue', 'AppUpdatePanel.vue']) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8')
    assert.match(source, /v-if="canInstallImmediately\(/, `${file} shows the button in ready/draining/downloading`)
    assert.match(source, /@click="installNow\(true\)"/, file)
    assert.match(source, /@click="installNow\(\)"/, `${file} keeps Install Now (never passes the click event)`)
    assert.match(source, /immediately \? installImmediatelyQuestion\(/, `${file} confirms through ask()`)
    assert.match(source, /immediately \? \{ immediately: true \} : \{\}/, `${file} posts the flag`)
  }
  assert.match(readFileSync(new URL('../components/AppUpdateBanner.vue', import.meta.url), 'utf8'), /if \(s\.phase === 'downloading'\)/, 'the banner shows while downloading')
})
