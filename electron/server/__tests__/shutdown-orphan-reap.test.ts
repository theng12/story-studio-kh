/**
 * Tests for the shutdown / orphan-reap pipeline (audit H2).
 *
 * Two pieces under test:
 *
 *   1. `killAllTrackedChildren()` in job-queue.ts — the helper called from
 *      the Electron `before-quit` handler. SIGTERMs every child registered
 *      via `trackChild` across every job, then SIGKILL fallback. Without
 *      this, FFmpeg children survived a clean quit and became orphans.
 *
 *   2. `parsePsOutput()` in orphan-reaper.ts — the boot-time scanner's
 *      pure parser. Filters `ps -eo pid,ppid,command` output to ffmpeg
 *      processes whose PPID === 1 AND whose argv references PROJECTS_ROOT.
 *      We test the parser with fixtures rather than spawning real ffmpeg
 *      so the test is fast and deterministic.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { useTempDataDir } from './_helpers.js'
import { parsePsOutput } from '../services/orphan-reaper.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('killAllTrackedChildren()', () => {
  test('SIGTERMs every tracked child within the fallback window', async () => {
    const proj = await pm.createProject({ name: 'KillAllShutdown' })

    // Real subprocess that would otherwise sleep forever. The executor
    // registers it via trackChild so the shutdown helper can find it.
    let exitSignal: NodeJS.Signals | null = null
    let resolved: () => void = () => {}
    const exited = new Promise<void>((r) => { resolved = r })

    jq.registerExecutor('script-only', async () => {
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
      jq.trackChild(child)
      child.on('exit', (_code, signal) => {
        exitSignal = signal
        resolved()
      })
      // Block the executor so the child stays "tracked" until the
      // shutdown helper actually sends SIGTERM.
      await new Promise((r) => setTimeout(r, 5000))
    })

    jq.enqueuePreparedForTest({
      project_slug: proj.slug, type: 'script-only', episode_id: 'KILL_ALL_1',
      title: 't', params: {},
    })

    // Let processQueue dequeue and start the executor.
    await new Promise((r) => setTimeout(r, 150))

    assert.ok(jq._trackedChildCountForTesting() >= 1,
      'expected at least 1 tracked child before shutdown')

    // Fire the shutdown helper with a tight SIGKILL fallback so the test
    // doesn't sit at the 2s default if SIGTERM is somehow ignored.
    const pids = jq.killAllTrackedChildren(500)
    assert.ok(pids.length >= 1, 'expected the helper to report at least one pid')

    // Race the actual exit against a generous test timeout.
    await Promise.race([
      exited,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('child did not exit in 2s')), 2000)),
    ])

    assert.equal(exitSignal, 'SIGTERM',
      `expected child to exit with SIGTERM, got ${exitSignal}`)
  })
})

describe('parsePsOutput()', () => {
  const PROJECTS_ROOT = '/Users/test/Library/Application Support/Story Studio KH/projects'

  test('matches ffmpeg under PROJECTS_ROOT with PPID=1', () => {
    const fakePs = [
      '  PID  PPID COMMAND',
      ' 1234     1 /Applications/Story Studio KH.app/Contents/Resources/ffmpeg -i ' + PROJECTS_ROOT + '/myproject/out/audio.wav -c copy ' + PROJECTS_ROOT + '/myproject/out/final.mp4',
      '  555   888 /Applications/SomeOtherApp/ffmpeg -i input.mp4 output.mp4',  // wrong PPID
      '  777     1 /Applications/QuickTime/ffmpeg -i /Users/test/Movies/foo.mov',  // wrong path
      '  999     1 /usr/bin/python3 /some/script.py ' + PROJECTS_ROOT + '/x.json',  // not ffmpeg
      ' 4242     1 /opt/homebrew/bin/ffmpeg -i ' + PROJECTS_ROOT + '/another/in.wav -c:a aac /tmp/out.m4a',
    ].join('\n')

    const orphans = parsePsOutput(fakePs, PROJECTS_ROOT)
    assert.equal(orphans.length, 2, `expected 2 matches, got ${orphans.length}: ${JSON.stringify(orphans)}`)
    assert.deepEqual(orphans.map(o => o.pid).sort((a, b) => a - b), [1234, 4242])
  })

  test('skips header line', () => {
    const fakePs = '  PID  PPID COMMAND\n'
    assert.deepEqual(parsePsOutput(fakePs, PROJECTS_ROOT), [])
  })

  test('returns empty when no rows match', () => {
    const fakePs = [
      '  PID  PPID COMMAND',
      '  100     1 /bin/launchd',
      '  200   100 /System/Library/CoreServices/loginwindow',
    ].join('\n')
    assert.deepEqual(parsePsOutput(fakePs, PROJECTS_ROOT), [])
  })

  test('does not match ffmpeg under /Applications even with PPID=1', () => {
    const fakePs = [
      '  PID  PPID COMMAND',
      ' 1111     1 /Applications/HandBrake.app/Contents/MacOS/ffmpeg -i /Users/foo/movie.mkv',
    ].join('\n')
    assert.deepEqual(parsePsOutput(fakePs, PROJECTS_ROOT), [])
  })

  test('handles command paths containing spaces (Story Studio KH)', () => {
    const projectsRoot = '/Users/me/Library/Application Support/Story Studio KH/projects'
    const fakePs = [
      '  PID  PPID COMMAND',
      ' 7000     1 /Applications/Story Studio KH.app/Contents/Resources/ffmpeg -y -i ' + projectsRoot + '/proj/out/seg-001.mp4 -c copy ' + projectsRoot + '/proj/out/final.mp4',
    ].join('\n')
    const orphans = parsePsOutput(fakePs, projectsRoot)
    assert.equal(orphans.length, 1)
    assert.equal(orphans[0].pid, 7000)
    assert.match(orphans[0].command, /ffmpeg/)
  })

  test('ignores non-numeric pid/ppid lines', () => {
    const fakePs = [
      '  PID  PPID COMMAND',
      'garbage line that cannot be parsed',
      '   ',
      '  abc def /not-a-real-row',
      ' 1234     1 /opt/ffmpeg -i ' + PROJECTS_ROOT + '/x.wav out.mp4',
    ].join('\n')
    const orphans = parsePsOutput(fakePs, PROJECTS_ROOT)
    assert.equal(orphans.length, 1)
    assert.equal(orphans[0].pid, 1234)
  })
})
