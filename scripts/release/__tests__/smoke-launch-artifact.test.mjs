import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TERM_GRACE_MS, TERM_POLL_MS, finalizeLaunchSandbox, shutdownMarkerLines, stopChild } from '../smoke-launch-artifact.mjs'

// These tests drive the real exported functions the smoke launch uses — the
// settle and the retention decision — with stub children and a private temp
// project root. No app is launched, no process is spawned, no network is used,
// and the repository's own _trash is never touched.
//
// This test is meant to run inside the real repository only: importing the
// module reads release/desktop-release-contract.json at load time, which exists
// in the repo tree but not in an isolated mirror of scripts/release/. It is not
// runnable standalone from this evidence folder.
//
// Temporary directories under the OS temp dir are deliberately left in place:
// this project's rule is that nothing is ever `rm`-ed, and these are throwaway
// sandboxes, not project files.

describe('smoke launch TERM-only stop', () => {
  test('sends one SIGTERM and reports settled once the exit evidence arrives', async () => {
    let alive = true
    const kills = []
    const sleeps = []
    const child = { kill: (signal) => { kills.push(signal); return true } }

    const settled = await stopChild(child, {
      exited: () => !alive,
      graceMs: 1_000,
      pollMs: 100,
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 3) alive = false },
    })

    assert.equal(settled, true)
    assert.deepEqual(kills, ['SIGTERM'], 'exactly one signal, and it is SIGTERM')
    assert.equal(sleeps.length, 3, 'it stops polling as soon as the process is gone')
  })

  test('bounds the wait, reports unsettled and never escalates', async () => {
    const kills = []
    let slept = 0
    const child = { kill: (signal) => { kills.push(signal); return true } }

    const settled = await stopChild(child, {
      exited: () => false,
      graceMs: 500,
      pollMs: 100,
      sleep: async () => { slept += 1 },
    })

    assert.equal(settled, false, 'a child that never exits is reported unsettled')
    assert.deepEqual(kills, ['SIGTERM'], 'still only SIGTERM — no escalation')
    assert.equal(slept, 5, 'the wait is bounded by counted polls (500ms / 100ms), not wall clock')
  })

  test('does not signal a child that has already exited', async () => {
    const kills = []
    const child = { kill: (signal) => { kills.push(signal); return true } }

    const settled = await stopChild(child, { exited: () => true, sleep: async () => {} })

    assert.equal(settled, true)
    assert.deepEqual(kills, [], 'nothing to stop, so nothing is sent')
  })

  test('the module never calls kill with SIGKILL', () => {
    const source = fs.readFileSync(new URL('../smoke-launch-artifact.mjs', import.meta.url), 'utf8')
    assert.equal(/\.kill\(\s*['"]SIGKILL['"]\s*\)/.test(source), false)
  })

  test('the production TERM grace is still 50 polls of 100ms', () => {
    assert.equal(TERM_GRACE_MS, 5_000)
    assert.equal(TERM_POLL_MS, 100)
    assert.equal(TERM_GRACE_MS / TERM_POLL_MS, 50)
  })

  test('the shutdown-marker filter keeps only stage lines, never URLs or raw output', () => {
    const output = [
      'Backend running on https://127.0.0.1:61611',
      '[shutdown] before-quit event',
      'GET /api/health 200',
      '[shutdown] server close requested',
      '    [shutdown] will-quit event',
    ].join('\n')
    assert.deepEqual(shutdownMarkerLines(output), [
      '[shutdown] before-quit event',
      '[shutdown] server close requested',
      '[shutdown] will-quit event',
    ])
    assert.equal(shutdownMarkerLines('').length, 0, 'no markers, no evidence lines')
    const repeated = Array.from({ length: 25 }, (_, index) => `[shutdown] stage ${index}`)
    assert.deepEqual(shutdownMarkerLines(repeated.join('\n')), repeated.slice(-20), 'retain only the last 20 markers')
  })
})

describe('smoke launch sandbox retention', () => {
  test('leaves an unsettled sandbox in place and moves a settled one into _trash', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-term-test-'))
    const warnings = []
    const warn = (message) => warnings.push(message)

    const unsettled = fs.mkdtempSync(path.join(projectRoot, 'sandbox-'))
    fs.writeFileSync(path.join(unsettled, 'in-use.txt'), 'the app is still running')

    const retained = finalizeLaunchSandbox(unsettled, { settled: false, projectRoot, warn })
    assert.deepEqual(retained, { moved: false, retained: unsettled })
    assert.ok(fs.existsSync(path.join(unsettled, 'in-use.txt')), 'the active sandbox is untouched')
    assert.equal(fs.existsSync(path.join(projectRoot, '_trash')), false, 'nothing was moved into _trash')
    assert.match(warnings.at(-1), /retained at/)
    assert.match(warnings.at(-1), /no SIGKILL was sent/)

    const settled = fs.mkdtempSync(path.join(projectRoot, 'sandbox-'))
    fs.writeFileSync(path.join(settled, 'boot.log'), 'served and exited')

    const moved = finalizeLaunchSandbox(settled, { settled: true, projectRoot, warn })
    assert.equal(moved.moved, true)
    assert.equal(fs.existsSync(settled), false, 'the settled sandbox left its original path')
    assert.ok(fs.existsSync(path.join(moved.path, 'boot.log')), 'its files moved with it')
    assert.ok(moved.path.startsWith(path.join(projectRoot, '_trash', 'release-')), 'and into the disposable _trash')
  })
})
