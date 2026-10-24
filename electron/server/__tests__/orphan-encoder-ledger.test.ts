/**
 * Encoders orphaned by a backend crash are stopped before anything resumes,
 * and a resumed render never writes into the previous attempt's temp dir.
 *
 * Dreamlands E2E 2026-10-03 (chaos 7): after kill -9 of the backend, its xfade
 * ffmpeg (PPID 1) kept writing scenes_xfaded_03.mp4 into the same temp dir the
 * resumed render was using.
 */

import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let reaper: typeof import('../services/orphan-reaper.js')
let checkpointLib: typeof import('../lib/video-assembly-checkpoint.js')
let workTemp: typeof import('../lib/work-tempdir.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  reaper = await import('../services/orphan-reaper.js')
  checkpointLib = await import('../lib/video-assembly-checkpoint.js')
  workTemp = await import('../lib/work-tempdir.js')
})
after(async () => { await cleanup() })

describe('encoder PID ledger', () => {
  test('every child a job starts is recorded while it runs and forgotten when it exits', async () => {
    const proj = await pm.createProject({ name: 'LedgerProject' })
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    let childPid = 0
    let child!: ReturnType<typeof spawn>
    jq.registerExecutor('chapter-only', async () => {
      // Lives until the test closes its stdin — no timer decides when it exits.
      child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, NODE_OPTIONS: '' } })
      childPid = child.pid!
      jq.trackChild(child)
      await new Promise(resolve => child.once('exit', resolve))
      release()
    })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'chapter-only', episode_id: 'LEDGER_1', title: 't', params: {} })
    await waitFor(() => childPid > 0, { label: 'executor to spawn its child' })
    const whileRunning = reaper.readChildLedger()
    assert.ok(whileRunning.some(row => row.pid === childPid && row.bin === process.execPath),
      `ledger must hold the running child: ${JSON.stringify(whileRunning)}`)
    child.stdin!.end()
    await done
    await waitFor(() => !reaper.readChildLedger().some(row => row.pid === childPid), { label: 'ledger to forget the exited child' })
    await jq._waitForJobPersistenceForTesting()
  })

  test('boot stops only recorded children that are orphaned and still the same program', () => {
    const rows = [
      { pid: 4509, job_id: 'a', bin: '/Applications/Story Studio KH.app/Contents/Resources/ffmpeg/ffmpeg' },
      { pid: 4600, job_id: 'b', bin: '/opt/homebrew/bin/ffmpeg' }, // parent alive (another running Story)
      { pid: 4700, job_id: 'c', bin: '/opt/homebrew/bin/ffmpeg' }, // PID reused by another program
      { pid: 4800, job_id: 'd', bin: '/opt/homebrew/bin/ffmpeg' }, // already gone
    ]
    const ps = [
      '  PID  PPID COMMAND',
      ' 4509     1 /Applications/Story Studio KH.app/Contents/Resources/ffmpeg/ffmpeg -y -i /var/folders/x/story-studio-kh/p/EP0002/.tmp_1/chunk_03.txt scenes_xfaded_03.mp4',
      ' 4600  4915 /opt/homebrew/bin/ffmpeg -y -i in.mp4 out.mp4',
      ' 4700     1 /usr/bin/python3 -m http.server',
    ].join('\n')
    assert.deepEqual(reaper.pickRecordedOrphans(rows, ps).map(o => o.pid), [4509])
  })

  test('boot reap kills a recorded orphan and clears the ledger', async () => {
    const ledger = reaper.childLedgerPath()
    await fs.mkdir(path.dirname(ledger), { recursive: true })
    await fs.writeFile(ledger, JSON.stringify({ children: [{ pid: 999_001, job_id: 'x', bin: '/opt/homebrew/bin/ffmpeg' }] }))
    const killed: number[] = []
    const realKill = process.kill
    ;(process as any).kill = (pid: number) => { killed.push(pid); return true }
    try {
      const reaped = await reaper.reapRecordedChildren({
        killAfterMs: 1,
        ps: async () => '999001     1 /opt/homebrew/bin/ffmpeg -i a.mp4 b.mp4\n',
      })
      assert.deepEqual(reaped.map(o => o.pid), [999_001])
      assert.ok(killed.includes(999_001), 'SIGTERM goes out at once')
    } finally {
      ;(process as any).kill = realKill
    }
    assert.deepEqual(reaper.readChildLedger(), [])
  })
})

describe('fresh temp dir per render attempt', () => {
  test('saved scene clips move into the new attempt folder; the old folder is not reused', async () => {
    const oldDir = await workTemp.getWorkTempDir('ledger-proj', 'EP0002')
    const newDir = path.join(path.dirname(oldDir), '.tmp_1')
    await fs.mkdir(newDir, { recursive: true })
    const clip = path.join(oldDir, 'scene_0000.mp4')
    await fs.writeFile(clip, 'clip')
    await fs.writeFile(path.join(oldDir, 'scenes_xfaded_03.mp4'), 'orphan output')
    const moved = await checkpointLib.moveCheckpointSceneClips({
      version: 1, job_id: 'j', project_slug: 'ledger-proj', episode_id: 'EP0002', work_dir: oldDir,
      render_fingerprint: 'a'.repeat(64),
      completed_scene_clips: [{ scene_index: 0, clip_path: clip, render_duration_sec: 4 }],
    }, newDir)
    assert.deepEqual(moved, [{ scene_index: 0, clip_path: path.join(newDir, 'scene_0000.mp4'), render_duration_sec: 4 }])
    assert.equal(await fs.readFile(moved[0].clip_path, 'utf8'), 'clip')
    await assert.rejects(fs.stat(path.join(newDir, 'scenes_xfaded_03.mp4')))
    await fs.rm(newDir, { recursive: true, force: true })
  })

  test('generateVideo never reuses the checkpoint work dir as its temp dir', async () => {
    const source = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /matchingCheckpoint\?\.work_dir\s*\|\|/)
    assert.match(source, /const tempDir = await getWorkTempDir\(project_slug, code\)/)
  })
})
