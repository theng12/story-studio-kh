/**
 * The hold endpoint on its FIXED loopback port (127.0.0.1:8647) — the seam
 * the Studio Launcher actually calls, via the signed feed's holdURL. The
 * behaviour tests live in update-hold.test.ts (same handlers, mounted by the
 * main server); this file proves the two things that file cannot see:
 *
 *   1. The listener mounts on the exact host/port/path the contract names,
 *      over a REAL HTTP request from outside the process — a hold served only
 *      on the app's random API port is unreachable and would have passed every
 *      in-process supertest.
 *   2. A taken port fails OPEN: one plain log line, no throw, Story carries on.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { sleep, waitFor } from './_timing.js'

// Dynamic imports in before() — the hold-endpoint chain (routes/system.ts →
// job-queue) must load AFTER useTempDataDir() claims the sandbox, or its
// stores write to the owner's real paths and the isolation guard refuses.
let HOLD_ENDPOINT_PORT: number
let HOLD_ENDPOINT_URL: string
let startHoldEndpoint: () => http.Server

let tempDir: string
let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let holdServer: http.Server

let chapterRuns = 0
let chapterFree = false
const chapterGates: Array<() => void> = []
let metadataRuns = 0

function enqueue(projectSlug: string, type: 'chapter-only' | 'metadata', episodeId: string, title: string) {
  return jq.enqueuePreparedForTest({ project_slug: projectSlug, type, episode_id: episodeId, title, params: {} })
}

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  ;({ HOLD_ENDPOINT_PORT, HOLD_ENDPOINT_URL, startHoldEndpoint } = await import('../hold-endpoint.js'))
  await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true })
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  jq.registerExecutor('chapter-only', async () => {
    chapterRuns += 1
    if (!chapterFree) await new Promise<void>(resolve => { chapterGates.push(resolve) })
  })
  jq.registerExecutor('metadata', async () => { metadataRuns += 1 })
})

after(async () => {
  jq._clearUpdateHoldForTesting()
  chapterFree = true
  for (const resolve of chapterGates.splice(0)) resolve()
  if (holdServer?.listening) await new Promise<void>(resolve => holdServer.close(() => resolve()))
  await cleanup()
})

describe('fixed hold endpoint on 127.0.0.1:8647', () => {
  test('the contract URL answers over real HTTP and the hold stops dispatch', async () => {
    assert.equal(HOLD_ENDPOINT_PORT, 8647, 'the port the contract table assigns Story')
    assert.equal(HOLD_ENDPOINT_URL, 'http://127.0.0.1:8647/api/maintenance/hold', 'the exact URL the feed must publish')

    holdServer = startHoldEndpoint()
    await waitFor(() => holdServer.listening, { label: 'the hold listener to bind 8647' })
    const address = holdServer.address() as import('net').AddressInfo
    assert.equal(address.address, '127.0.0.1', 'loopback only, never 0.0.0.0')
    assert.equal(address.port, 8647)

    // Live work queued, behind a running job in the same single-slot lane —
    // the fixture update-hold.test.ts uses, now driven over real HTTP.
    const project = await pm.createProject({ name: 'Hold Endpoint Live Work' })
    const running = enqueue(project.slug, 'chapter-only', 'UH100', 'in flight on 8647')
    await waitFor(() => chapterRuns === 1 && jq.getJob(running.job_id)?.status === 'running', {
      label: 'the chapter job to occupy its lane',
    })
    const queuedBehind = enqueue(project.slug, 'chapter-only', 'UH101', 'queued behind the live job')

    // POST the URL the signed feed will name — not supertest, the real wire.
    const held = await fetch(`${HOLD_ENDPOINT_URL}?timeout_s=0&pause_s=60`, { method: 'POST' })
    assert.equal(held.status, 200)
    const heldBody = await held.json() as { safe: boolean; unsettled: string[]; dispatch_paused_s: number; in_flight: number }
    assert.deepEqual(Object.keys(heldBody).sort(), ['dispatch_paused_s', 'in_flight', 'safe', 'unsettled'])
    assert.equal(heldBody.in_flight, 1)
    assert.equal(heldBody.dispatch_paused_s, 60)

    // The running job settles WHILE the hold owns dispatch; nothing new starts.
    chapterFree = true
    for (const resolve of chapterGates.splice(0)) resolve()
    await waitFor(() => jq.getJob(running.job_id)?.status === 'done', { label: 'the live job to settle' })

    // A different, completely free lane — nothing new may be claimed anywhere.
    const queuedFreeLane = enqueue(project.slug, 'metadata', 'UH102', 'queued on a free lane')
    await sleep(300) // observation window: the hold must keep both rows queued
    assert.equal(chapterRuns, 1, 'no second chapter job was claimed during the hold')
    assert.equal(metadataRuns, 0, 'the free lane claimed no job during the hold')
    assert.equal(jq.getJob(queuedBehind.job_id)?.status, 'queued')
    assert.equal(jq.getJob(queuedFreeLane.job_id)?.status, 'queued')

    const resumed = await fetch(HOLD_ENDPOINT_URL, { method: 'DELETE' })
    assert.equal(resumed.status, 200)
    const resumedBody = await resumed.json() as { dispatch_paused_s: number }
    assert.equal(resumedBody.dispatch_paused_s, 0, 'DELETE resumes at once')
    await waitFor(() => jq.getJob(queuedBehind.job_id)?.status === 'done', { label: 'the held lane to resume' })
    await waitFor(() => jq.getJob(queuedFreeLane.job_id)?.status === 'done', { label: 'the other lane to resume' })
    assert.equal(chapterRuns, 2)
    assert.equal(metadataRuns, 1)
  })

  test('a taken port fails open: one log line, no throw, the app carries on', async () => {
    await new Promise<void>(resolve => holdServer.close(() => resolve()))
    // Someone else owns 8647 — a second copy of Story, or another app.
    const blocker = http.createServer()
    await new Promise<void>(resolve => blocker.listen(HOLD_ENDPOINT_PORT, '127.0.0.1', resolve))

    const logged: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')) }
    let second: http.Server
    try {
      second = startHoldEndpoint() // must not throw — fail open is the contract
      await waitFor(() => logged.some(line => line.includes('could not be opened')), {
        label: 'the plain fail-open log line',
      })
    } finally {
      console.log = origLog
    }
    assert.ok(logged.some(line => line.includes('8647')), 'the log line names the port and the reason')
    assert.equal(second.listening, false, 'the failed listener is closed, not half-open')
    assert.equal(blocker.listening, true, 'the port owner was never disturbed')
    await new Promise<void>(resolve => blocker.close(() => resolve()))
  })
})
