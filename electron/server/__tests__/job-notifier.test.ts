/**
 * Tests for the OS-notification decision layer.
 *
 * Covers:
 *   • aggregateBatch counts success / fail / cancelled correctly across a
 *     fake batch and computes elapsed from min(created_at) → max(finished_at).
 *   • isBatchComplete flips only when the last queued/running job settles.
 *   • shouldNotifyForSingleJob ignores jobs that ran shorter than the
 *     threshold, and ignores batch-tagged jobs.
 *   • formatDuration produces the expected human strings.
 *   • getNotifierSettings / setNotifierSettings round-trip through
 *     app-settings.json.
 *
 * An integration-ish path through `jobEvents` with a stub Notification
 * constructor verifies that a batch settling into done+error triggers
 * exactly one notification.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { useTempDataDir } from './_helpers.js'
import {
  aggregateBatch,
  isBatchComplete,
  shouldNotifyForSingleJob,
  formatDuration,
  formatBatchMessage,
  formatFailureMessage,
  formatSingleJobMessage,
  summarizeBatchEpisodes,
  BATCH_EPISODE_LINE_LIMIT,
  shouldNotifyFailure,
  labelForJobType,
  getBatchId,
  getNotifierSettings,
  setNotifierSettings,
  DEFAULT_NOTIFIER_SETTINGS,
  formatQuitWarning,
  formatApprovalWaitMessage,
} from '../services/job-notifier.js'
import { formatTelegramText } from '../services/telegram-notifier.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
})

after(async () => { await cleanup() })

function mkJob(overrides: Partial<Job> & Pick<Job, 'status'>): Job {
  return {
    job_id: overrides.job_id || Math.random().toString(36).slice(2, 8),
    project_slug: 'p',
    type: overrides.type || 'chapter-only',
    episode_id: overrides.episode_id || 'EP001',
    title: overrides.title || 't',
    status: overrides.status,
    created_at: overrides.created_at || '2026-04-25T00:00:00.000Z',
    started_at: overrides.started_at ?? null,
    finished_at: overrides.finished_at ?? null,
    error: overrides.error ?? null,
    output_lines: overrides.output_lines || [],
    params: overrides.params || {},
  }
}

describe('getBatchId()', () => {
  test('returns batch id when set', () => {
    const j = mkJob({ status: 'done', params: { pipeline_batch_id: 'B1' } })
    assert.equal(getBatchId(j), 'B1')
  })
  test('returns null for non-batch jobs', () => {
    assert.equal(getBatchId(mkJob({ status: 'done' })), null)
    assert.equal(getBatchId(mkJob({ status: 'done', params: { pipeline_batch_id: '' } })), null)
  })
})

describe('aggregateBatch()', () => {
  const BATCH = 'B-TEST'
  const jobs: Job[] = [
    mkJob({ status: 'done',      job_id: '1', created_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:05:00.000Z', params: { pipeline_batch_id: BATCH } }),
    mkJob({ status: 'done',      job_id: '2', created_at: '2026-04-25T00:01:00.000Z', finished_at: '2026-04-25T00:10:00.000Z', params: { pipeline_batch_id: BATCH } }),
    mkJob({ status: 'error',     job_id: '3', created_at: '2026-04-25T00:02:00.000Z', finished_at: '2026-04-25T00:08:00.000Z', params: { pipeline_batch_id: BATCH } }),
    mkJob({ status: 'cancelled', job_id: '4', created_at: '2026-04-25T00:03:00.000Z', finished_at: '2026-04-25T00:04:00.000Z', params: { pipeline_batch_id: BATCH } }),
    // Different batch — must be ignored.
    mkJob({ status: 'done',      job_id: '5', created_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:20:00.000Z', params: { pipeline_batch_id: 'OTHER' } }),
    // Non-batch job — must be ignored.
    mkJob({ status: 'done',      job_id: '6', created_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:30:00.000Z' }),
  ]

  test('counts success / fail / cancelled across the target batch only', () => {
    const s = aggregateBatch(jobs, BATCH)
    assert.equal(s.total, 4)
    assert.equal(s.success, 2)
    assert.equal(s.fail, 1)
    assert.equal(s.cancelled, 1)
    assert.equal(s.still_active, 0)
  })

  test('elapsed = max(finished_at) - min(created_at) in ms', () => {
    const s = aggregateBatch(jobs, BATCH)
    // earliest_created = 00:00, latest_finished = 00:10 → 10 minutes
    assert.equal(s.elapsed_ms, 10 * 60 * 1000)
  })

  test('still_active > 0 when any job is queued/running', () => {
    const mixed = [
      ...jobs.slice(0, 3),
      mkJob({ status: 'running', job_id: 'x', params: { pipeline_batch_id: BATCH } }),
    ]
    const s = aggregateBatch(mixed, BATCH)
    assert.equal(s.still_active, 1)
    assert.equal(isBatchComplete(s), false)
  })

  test('isBatchComplete is true when total > 0 and nothing is still active', () => {
    const s = aggregateBatch(jobs, BATCH)
    assert.equal(isBatchComplete(s), true)
  })

  test('isBatchComplete is false for an unknown batch id (total === 0)', () => {
    const s = aggregateBatch(jobs, 'NOPE')
    assert.equal(s.total, 0)
    assert.equal(isBatchComplete(s), false)
  })
})

describe('shouldNotifyForSingleJob()', () => {
  const settings = { enabled: true, min_duration_ms: 5 * 60 * 1000 } // 5 min

  test('returns false for jobs shorter than the threshold', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T00:03:00.000Z', // 3 min
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })

  test('returns true for jobs at or above the threshold', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T00:07:00.000Z', // 7 min
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), true)
  })

  test('ignores batch-tagged jobs (those route through aggregateBatch)', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T01:00:00.000Z',
      params: { pipeline_batch_id: 'B' },
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })

  test('ignores non-terminal jobs', () => {
    const j = mkJob({
      status: 'running',
      started_at: '2026-04-25T00:00:00.000Z',
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })

  test('returns false when notifications are disabled', () => {
    const j = mkJob({
      status: 'done',
      started_at:  '2026-04-25T00:00:00.000Z',
      finished_at: '2026-04-25T01:00:00.000Z',
    })
    assert.equal(shouldNotifyForSingleJob(j, { enabled: false, min_duration_ms: 0 }), false)
  })

  test('ignores jobs missing started_at (queued-then-cancelled)', () => {
    const j = mkJob({
      status: 'cancelled',
      started_at: null,
      finished_at: '2026-04-25T00:10:00.000Z',
    })
    assert.equal(shouldNotifyForSingleJob(j, settings), false)
  })
})

describe('formatDuration()', () => {
  test('seconds under a minute', () => assert.equal(formatDuration(45_000), '45s'))
  test('minutes+seconds under an hour', () => assert.equal(formatDuration(7 * 60_000 + 3_000), '7m 3s'))
  test('hours+minutes over an hour', () => assert.equal(formatDuration(2 * 3_600_000 + 15 * 60_000), '2h 15m'))
  test('non-positive → "0s"', () => {
    assert.equal(formatDuration(0), '0s')
    assert.equal(formatDuration(-5), '0s')
  })
})

describe('formatBatchMessage()', () => {
  test('clean batch → neutral title', () => {
    const s = { batch_id: 'B', total: 5, success: 5, fail: 0, cancelled: 0, earliest_created_at: null, latest_finished_at: null, elapsed_ms: 60_000, still_active: 0 }
    const { title, body } = formatBatchMessage(s)
    assert.equal(title, 'Pipeline finished')
    assert.match(body, /5\/5 episodes succeeded/)
  })
  test('batch with failures → "with issues" title + failure count', () => {
    const s = { batch_id: 'B', total: 10, success: 7, fail: 2, cancelled: 1, earliest_created_at: null, latest_finished_at: null, elapsed_ms: 3_600_000, still_active: 0 }
    const { title, body } = formatBatchMessage(s)
    assert.equal(title, 'Pipeline finished with issues')
    assert.match(body, /7\/10/)
    assert.match(body, /2 failed/)
    assert.match(body, /1 cancelled/)
    assert.match(body, /1h/)
  })
})

describe('getNotifierSettings() / setNotifierSettings()', () => {
  beforeEach(async () => {
    // reset to defaults between tests — setNotifierSettings persists state
    await setNotifierSettings(DEFAULT_NOTIFIER_SETTINGS)
  })

  test('defaults come back when nothing is persisted', async () => {
    const got = await getNotifierSettings()
    assert.deepEqual(got, DEFAULT_NOTIFIER_SETTINGS)
  })

  test('partial patch preserves the other field', async () => {
    const after1 = await setNotifierSettings({ min_duration_ms: 120_000 })
    assert.equal(after1.min_duration_ms, 120_000)
    assert.equal(after1.enabled, DEFAULT_NOTIFIER_SETTINGS.enabled)

    const after2 = await setNotifierSettings({ enabled: false })
    assert.equal(after2.enabled, false)
    assert.equal(after2.min_duration_ms, 120_000) // unchanged
  })

  test('rejects negative or non-numeric thresholds by keeping current', async () => {
    await setNotifierSettings({ min_duration_ms: 60_000 })
    const after = await setNotifierSettings({ min_duration_ms: -5 as any })
    assert.equal(after.min_duration_ms, 60_000)
  })
})

// Integration — a bus-level test that mirrors what main.ts does. We
// fake the Notification constructor with a counter instead of importing
// Electron (tests run under tsx, no display server).
describe('batch settling fires exactly one notification', () => {
  test('done + error across a 2-episode batch → 1 notification', () => {
    const bus = new EventEmitter()
    const seen: string[] = []
    const notifiedBatches = new Set<string>()

    // The corpus the listener sees when it queries for state. A real
    // listener calls getJobs(slug); here we hand it this list.
    let corpus: Job[] = []

    function listen(job: Job) {
      if (!['done', 'error', 'cancelled'].includes(job.status)) return
      const batchId = getBatchId(job)
      if (!batchId || notifiedBatches.has(batchId)) return
      const stats = aggregateBatch(corpus, batchId)
      if (!isBatchComplete(stats)) return
      notifiedBatches.add(batchId)
      seen.push(formatBatchMessage(stats).body)
    }

    bus.on('update', listen)

    // First job transitions: running → done. Second still running.
    corpus = [
      mkJob({ status: 'done',    job_id: 'j1', started_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:02:00.000Z', params: { pipeline_batch_id: 'B' } }),
      mkJob({ status: 'running', job_id: 'j2', started_at: '2026-04-25T00:00:00.000Z', params: { pipeline_batch_id: 'B' } }),
    ]
    bus.emit('update', corpus[0])
    assert.equal(seen.length, 0, 'should not notify while j2 still running')

    // j2 errors out → batch is now complete → one notification fires.
    corpus = [
      corpus[0],
      mkJob({ status: 'error', job_id: 'j2', started_at: '2026-04-25T00:00:00.000Z', finished_at: '2026-04-25T00:06:00.000Z', error: 'boom', params: { pipeline_batch_id: 'B' } }),
    ]
    bus.emit('update', corpus[1])
    assert.equal(seen.length, 1)
    assert.match(seen[0], /1\/2 episodes succeeded/)
    assert.match(seen[0], /1 failed/)

    // A stray duplicate event for the same batch does not double-fire.
    bus.emit('update', corpus[1])
    assert.equal(seen.length, 1)
  })
})

describe('per-event toggles + failures (v1.0.367)', () => {
  const ALL_ON = { pipeline_finished: true, failures: true, long_job: true }

  test('labelForJobType maps new pipeline job types to friendly names', () => {
    assert.equal(labelForJobType('scene_plan_run'), 'Scene plan')
    assert.equal(labelForJobType('continuity_render'), 'Scene render')
    assert.equal(labelForJobType('subtitles_transcribe'), 'Subtitles')
    assert.equal(labelForJobType('unknown_type'), 'unknown_type')  // graceful fallback
  })

  test('shouldNotifyFailure: only for errors, and only when failures is on', () => {
    assert.equal(shouldNotifyFailure(mkJob({ status: 'error' }), ALL_ON), true)
    assert.equal(shouldNotifyFailure(mkJob({ status: 'error' }), { ...ALL_ON, failures: false }), false)
    assert.equal(shouldNotifyFailure(mkJob({ status: 'done' }), ALL_ON), false)
  })

  test('formatFailureMessage uses the friendly label + episode + error text', () => {
    const j = mkJob({ status: 'error', type: 'continuity_render', episode_id: 'EP0001', error: 'whisper timed out' })
    const p = formatFailureMessage(j, 'My Channel')
    assert.match(p.title, /Failed: Scene render/)
    assert.match(p.title, /My Channel/)
    assert.match(p.body, /EP0001/)
    assert.match(p.body, /whisper timed out/)
  })

  test('defaults include events (all on) + digest.quiet_when_empty=false', async () => {
    await setNotifierSettings(DEFAULT_NOTIFIER_SETTINGS)
    const s = await getNotifierSettings()
    assert.deepEqual(s.events, ALL_ON)
    assert.equal(s.digest?.quiet_when_empty, false)
  })

  test('a partial events patch merges (unset keys keep their value)', async () => {
    await setNotifierSettings(DEFAULT_NOTIFIER_SETTINGS)
    const after = await setNotifierSettings({ events: { failures: false } as any, digest: { quiet_when_empty: true } as any })
    assert.equal(after.events?.failures, false)
    assert.equal(after.events?.pipeline_finished, true)
    assert.equal(after.events?.long_job, true)
    assert.equal(after.digest?.quiet_when_empty, true)
  })
})

describe('Quit while jobs run', () => {
  test('says how many are running and that they continue after restart', () => {
    assert.equal(formatQuitWarning(0), null, 'nothing running: quit without asking')
    assert.equal(formatQuitWarning(1)?.title, "1 job is running; it'll continue after restart.")
    assert.equal(formatQuitWarning(3)?.title, "3 jobs are running; they'll continue after restart.")
    assert.match(formatQuitWarning(3)!.body, /Retry in Jobs/)
  })

  test('the app asks before quitting with running jobs, and Cancel keeps it open', async () => {
    const { readFile } = await import('node:fs/promises')
    const main = await readFile(new URL('../../main.ts', import.meta.url), 'utf8')
    // Wiring only, not ordering: the Cancel branch clears the shutdown deadline. The behaviour it
    // protects (nothing exits after a cancelled quit, even past the ceiling) is proved with a real
    // injected clock in shutdown-state.test.ts, so a UI reshuffle here cannot break that proof.
    const cancelBranch = main.slice(main.indexOf("if (choice === 1) {"))
    assert.match(cancelBranch.slice(0, 300), /cancelShutdown\(\)/,
      'Cancel must disarm the shutdown ceiling')
    const handler = main.slice(main.indexOf("electronApp.on('before-quit'"))
    assert.doesNotMatch(handler.slice(0, handler.indexOf("electronApp.on('will-quit'")), /electronApp\.quit\(\)/)
    assert.match(handler, /electronApp\.exit\(0\)/)
  })

})

describe('Scene Review waiting on the owner', () => {
  test('a finished scene render with unapproved scenes notifies once, in plain words', async () => {
    const job = { job_id: 'r1', type: 'continuity_render', status: 'done', episode_id: 'TN0329', result: { awaiting_approval: 1 } } as unknown as Job
    assert.deepEqual(formatApprovalWaitMessage(job, 'TerraNash'), {
      title: 'Waiting for your approval (1 scene) — TerraNash',
      body: 'TN0329 — Scene Review. Open it to approve the scenes.',
    })
    assert.equal(formatApprovalWaitMessage({ ...job, result: {} } as Job), null)
    assert.equal(formatApprovalWaitMessage({ ...job, status: 'error' } as Job), null)
    const { readFile } = await import('node:fs/promises')
    const main = await readFile(new URL('../../main.ts', import.meta.url), 'utf8')
    assert.match(main, /formatApprovalWaitMessage\(job, projectLabel\)[\s\S]{0,200}!notifiedJobs\.has\(`approval:\$\{job\.job_id\}`\)[\s\S]{0,200}dispatchNotification\(approvalWait/)
  })
})

// ── Owner request 2026-10-18: notifications must name the episode ──────────
// The owner's screenshot showed "Done: Chapter expansion — Domnak Kmouch /
// DM0013 — 9m 44s" (no title) and "Pipeline finished — Story Sprout / 1/1
// episodes succeeded. Elapsed 15h 47m." (no episode at all). These pin the
// episode code + title detail, the episode-vs-step counts, the bounded long-
// batch summary, and the Telegram escaping/length contracts.

describe('episode identity in single-job notifications', () => {
  const began = '2026-10-18T00:00:00.000Z'
  const ended = '2026-10-18T00:09:44.000Z' // 9m 44s — the owner's example duration

  test('a done job carries its episode code AND title', () => {
    const j = mkJob({ status: 'done', type: 'expand_chapters', episode_id: 'DM0013', started_at: began, finished_at: ended })
    const p = formatSingleJobMessage(j, 'Domnak Kmouch', 'The Lost Temple')
    assert.equal(p.title, 'Done: Chapter expansion — Domnak Kmouch')
    assert.equal(p.body, 'DM0013 — The Lost Temple — 9m 44s')
  })

  test('no title on record → the stable code stands alone, never a guess', () => {
    const j = mkJob({ status: 'done', type: 'expand_chapters', episode_id: 'DM0013', started_at: began, finished_at: ended })
    assert.equal(formatSingleJobMessage(j, 'Domnak Kmouch', '').body, 'DM0013 — 9m 44s')
    assert.equal(formatSingleJobMessage(j, 'Domnak Kmouch', '   ').body, 'DM0013 — 9m 44s')
    assert.equal(formatSingleJobMessage(j, 'Domnak Kmouch').body, 'DM0013 — 9m 44s')
  })

  test('cancelled keeps its own honest tag', () => {
    const j = mkJob({ status: 'cancelled', type: 'expand_chapters', episode_id: 'DM0013', started_at: began, finished_at: ended })
    assert.equal(formatSingleJobMessage(j, 'Domnak Kmouch', 'The Lost Temple').title, 'Cancelled: Chapter expansion — Domnak Kmouch')
  })

  test('a job with no episode id shows no identity', () => {
    const base = mkJob({ status: 'done', started_at: began, finished_at: ended })
    const p = formatSingleJobMessage({ ...base, episode_id: '' }, 'Domnak Kmouch', 'The Lost Temple')
    assert.equal(p.body, '9m 44s')
  })

  test('failure detail names the episode and scrubs credentials', () => {
    const j = mkJob({ status: 'error', type: 'expand_chapters', episode_id: 'DM0013', error: 'provider said sk-abcdefgh12345678 was rejected' })
    const p = formatFailureMessage(j, 'Domnak Kmouch', 'The Lost Temple')
    assert.equal(p.title, 'Failed: Chapter expansion — Domnak Kmouch')
    assert.equal(p.body, 'DM0013 — The Lost Temple — provider said [REDACTED] was rejected')
  })

  test('approval-wait ping names the episode too', () => {
    const j = { job_id: 'r2', type: 'continuity_render', status: 'done', episode_id: 'DM0013', result: { awaiting_approval: 1 } } as unknown as Job
    const p = formatApprovalWaitMessage(j, 'Domnak Kmouch', 'The Lost Temple')
    assert.equal(p?.body, 'DM0013 — The Lost Temple — Scene Review. Open it to approve the scenes.')
    assert.equal(formatApprovalWaitMessage(j, 'Domnak Kmouch')?.body, 'DM0013 — Scene Review. Open it to approve the scenes.')
  })
})

describe('summarizeBatchEpisodes()', () => {
  const step = (code: string, status: Job['status'], extra: Partial<Job> = {}) =>
    mkJob({ status, episode_id: code, ...extra })

  test('groups step jobs by episode; states rank failed > cancelled > done', () => {
    const jobs = [
      step('DM0013', 'done', { job_id: 'a1', type: 'outline_only', created_at: '2026-10-18T00:00:00.000Z', finished_at: '2026-10-18T00:30:00.000Z' }),
      step('DM0013', 'done', { job_id: 'a2', type: 'expand_chapters', created_at: '2026-10-18T00:30:00.000Z', finished_at: '2026-10-18T00:40:00.000Z' }),
      step('DM0014', 'error', { job_id: 'b1', type: 'expand_chapters', error: 'provider timed out' }),
      step('DM0015', 'cancelled', { job_id: 'c1', type: 'expand_chapters' }),
    ]
    const out = summarizeBatchEpisodes(jobs, new Map([['DM0013', 'The Lost Temple']]))
    assert.deepEqual(out.map(e => e.episode_id), ['DM0014', 'DM0015', 'DM0013'])
    assert.equal(out[0].state, 'failed')
    assert.equal(out[0].failed_step, 'Chapter expansion')
    assert.equal(out[0].failed_error, 'provider timed out')
    assert.equal(out[0].title, '') // no record → code alone, never guessed
    assert.equal(out[1].state, 'cancelled')
    assert.equal(out[2].state, 'done')
    assert.equal(out[2].title, 'The Lost Temple')
    assert.equal(out[2].steps_done, 2)
    assert.equal(out[2].steps_total, 2)
  })

  test('the earliest failure is the one reported, single-line', () => {
    const jobs = [
      step('DM0014', 'error', { job_id: 'late', type: 'image_prompts', error: 'second failure', created_at: '2026-10-18T03:00:00.000Z' }),
      step('DM0014', 'error', { job_id: 'early', type: 'expand_chapters', error: 'first failure\nwith details', created_at: '2026-10-18T01:00:00.000Z' }),
      step('DM0014', 'error', { job_id: 'mid', type: 'audio', error: 'other failure', created_at: '2026-10-18T02:00:00.000Z' }),
    ]
    const out = summarizeBatchEpisodes(jobs)
    assert.equal(out[0].failed_step, 'Chapter expansion')
    assert.equal(out[0].failed_error, 'first failure with details')
  })

  test('a credential-shaped error is scrubbed before it reaches the message', () => {
    const out = summarizeBatchEpisodes([step('DM0014', 'error', { type: 'audio', error: 'upstream: sk-abcdefgh12345678' })])
    assert.equal(out[0].failed_error, 'upstream: [REDACTED]')
  })

  test('a job still active marks the episode running, not done', () => {
    const jobs = [step('DM0013', 'done'), step('DM0013', 'queued', { job_id: 'q1' })]
    assert.equal(summarizeBatchEpisodes(jobs)[0].state, 'running')
  })

  test('rows with no episode id are skipped, not shown as a blank line', () => {
    const bare = { ...mkJob({ status: 'done' }), episode_id: '' }
    assert.deepEqual(summarizeBatchEpisodes([bare]), [])
  })
})

describe('formatBatchMessage() — per-episode detail', () => {
  const STATS = { batch_id: 'B', total: 1, success: 1, fail: 0, cancelled: 0, earliest_created_at: null, latest_finished_at: null, elapsed_ms: 56_820_000, still_active: 0 }

  test("the owner's run names its episode and each step it ran", () => {
    const jobs = [mkJob({ status: 'done', type: 'expand_chapters', episode_id: 'DM0013', params: { pipeline_batch_id: 'B' } })]
    const episodes = summarizeBatchEpisodes(jobs, new Map([['DM0013', 'The Lost Temple']]))
    const { title, body } = formatBatchMessage({ ...STATS }, 'Story Sprout', episodes)
    assert.equal(title, 'Pipeline finished — Story Sprout')
    assert.equal(body, '1/1 episodes succeeded. Elapsed 15h 47m.\nDM0013 — The Lost Temple: script ✓')
    assert.doesNotMatch(body, /done · \d+ step/)
  })

  test('seven step jobs are ONE episode — its seven steps are one line', () => {
    const jobs = Array.from({ length: 7 }, (_, i) => mkJob({ status: 'done', job_id: `s${i}`, episode_id: 'DM0013', created_at: `2026-10-18T0${i}:00:00.000Z`, finished_at: '2026-10-18T09:00:00.000Z' }))
    const episodes = summarizeBatchEpisodes(jobs, new Map([['DM0013', 'The Lost Temple']]))
    const { body } = formatBatchMessage({ ...STATS, total: 7, success: 7 }, undefined, episodes)
    assert.match(body, /^1\/1 episodes succeeded\./)
    assert.equal(body.split('\n').length, 2, 'one episode = one line, however many steps')
    assert.match(body, /DM0013 — The Lost Temple: chapter regen ✓ 9h · total 9h/)
  })

  test('mixed done / failed / cancelled: counts, ordered steps, honest states', () => {
    const jobs = [
      mkJob({ status: 'done', job_id: 'a1', episode_id: 'DM0013', type: 'outline_only' }),
      mkJob({ status: 'error', job_id: 'b1', episode_id: 'DM0014', type: 'expand_chapters', error: 'provider timed out' }),
      mkJob({ status: 'cancelled', job_id: 'c1', episode_id: 'DM0015', type: 'outline_only' }),
    ]
    const episodes = summarizeBatchEpisodes(jobs, new Map([['DM0013', 'The Lost Temple'], ['DM0014', 'River of Night']]))
    const { title, body } = formatBatchMessage({ ...STATS, total: 3, success: 1, fail: 1, cancelled: 1, elapsed_ms: 7_500_000 }, 'Story Sprout', episodes)
    assert.equal(title, 'Pipeline finished with issues — Story Sprout')
    assert.equal(body, [
      '1/3 episodes succeeded. 1 failed. 1 cancelled. Elapsed 2h 5m.',
      'DM0014 — River of Night: script ✗ — provider timed out',
      'DM0015: script — cancelled',
      'DM0013 — The Lost Temple: script ✓',
    ].join('\n'))
  })

  test('a long batch bounds its detail with an explicit omitted count', () => {
    const n = BATCH_EPISODE_LINE_LIMIT + 2
    const jobs = Array.from({ length: n }, (_, i) => mkJob({ status: 'done', job_id: `j${i}`, episode_id: `DM${1000 + i}` }))
    const episodes = summarizeBatchEpisodes(jobs)
    const { body } = formatBatchMessage({ ...STATS, total: n, success: n }, 'Story Sprout', episodes)
    const lines = body.split('\n')
    assert.equal(lines.length, 1 + BATCH_EPISODE_LINE_LIMIT + 1) // header + shown + omitted marker
    assert.match(lines[lines.length - 1]!, /^… and 2 more \(all done\)$/)
    assert.ok(!body.includes(`DM${1000 + n - 1}`), 'omitted episodes are counted, never silently kept')
  })

  test('omitted failures are still counted explicitly', () => {
    const n = BATCH_EPISODE_LINE_LIMIT + 3
    const jobs = [
      ...Array.from({ length: BATCH_EPISODE_LINE_LIMIT + 2 }, (_, i) => mkJob({ status: 'error', job_id: `e${i}`, episode_id: `DM${2000 + i}`, type: 'audio', error: 'boom' })),
      mkJob({ status: 'done', job_id: 'ok', episode_id: 'DM2100' }),
    ]
    const episodes = summarizeBatchEpisodes(jobs)
    assert.equal(episodes.length, n)
    const { body } = formatBatchMessage({ ...STATS, total: n, success: 1, fail: n - 1, elapsed_ms: 60_000 }, undefined, episodes)
    assert.match(body, /1\/11 episodes succeeded\. 10 failed\./)
    assert.match(body, /… and 3 more \(2 failed\)/)
  })

  test('an empty episode list falls back to the aggregate wording (nothing invented)', () => {
    const { body } = formatBatchMessage({ ...STATS, total: 2, success: 1, fail: 1, elapsed_ms: 60_000 }, 'P', [])
    assert.equal(body, '1/2 episodes succeeded. 1 failed. Elapsed 1m 0s.')
  })

  test('very long titles are truncated, never dropped silently', () => {
    const long = 'A'.repeat(200)
    const jobs = [mkJob({ status: 'done', episode_id: 'DM0013' })]
    const episodes = summarizeBatchEpisodes(jobs, new Map([['DM0013', long]]))
    const { body } = formatBatchMessage({ ...STATS }, undefined, episodes)
    assert.ok(body.includes(`DM0013 — ${'A'.repeat(80)}: `))
    assert.ok(!body.includes('A'.repeat(81)))
  })

  test("the owner's example: steps in pipeline order, with each outcome and elapsed", () => {
    const at = (h: number, m: number, s = 0) =>
      `2026-11-14T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`
    const step = (from: string, to: string, type: Job['type'], pipeline: string) =>
      mkJob({ status: 'done' as const, job_id: `${type}-${from}`, episode_id: 'DM0013', type, created_at: from, finished_at: to, params: { pipeline_step: pipeline } })
    const jobs = [
      step(at(0, 0), at(0, 3, 28), 'outline_only', 'script-only'),
      step(at(0, 3, 28), at(0, 3, 59), 'image_prompts', 'image_prompts'),
      step(at(0, 3, 59), at(0, 5, 59), 'thumb_images', 'thumb_images'),
      step(at(0, 5, 59), at(0, 14, 45), 'audio', 'audio'),
      step(at(0, 14, 45), at(0, 15, 41), 'subtitles_transcribe', 'subtitles'),
      step(at(0, 15, 41), at(0, 19, 25), 'scene_plan_run', 'scene_plan'),
      step(at(0, 19, 25), at(1, 43, 25), 'continuity_render', 'scene_review'),
      step(at(1, 43, 25), at(1, 55, 15), 'video_assembly', 'video_assembly'),
    ]
    // The chain still carried on the first job says an upload step was planned;
    // no job ever ran for it, so it reads "pending" rather than vanishing.
    jobs[0]!.params.pipeline_chain = [{ type: 'youtube_upload', params: { pipeline_step: 'youtube_upload' } }]
    const episodes = summarizeBatchEpisodes(jobs, new Map([['DM0013', 'The Lost Temple']]))
    const { body } = formatBatchMessage({ ...STATS, total: jobs.length, success: jobs.length }, 'Story Sprout', episodes)
    assert.equal(body, [
      '1/1 episodes succeeded. Elapsed 15h 47m.',
      'DM0013 — The Lost Temple: script ✓ 3m28s · image prompts ✓ 31s · thumbnails ✓ 2m · audio ✓ 8m46s'
        + ' · subtitles ✓ 56s · scene plan ✓ 3m44s · scene review ✓ 1h24m · video assembly ✓ 11m50s'
        + ' · youtube upload — pending · total 1h55m',
    ].join('\n'))
    assert.doesNotMatch(body, /done · \d+ step/)
  })

  test('a failed step names its reason and says the finished steps are kept', () => {
    const jobs = [
      mkJob({ status: 'done', job_id: 'ok', episode_id: 'DM0013', type: 'outline_only', created_at: '2026-11-14T00:00:00.000Z', finished_at: '2026-11-14T00:03:28.000Z', params: { pipeline_step: 'script-only' } }),
      mkJob({ status: 'error', job_id: 'bad', episode_id: 'DM0013', type: 'audio', error: 'provider <timeout> & retry exhausted', created_at: '2026-11-14T00:03:28.000Z', finished_at: '2026-11-14T00:12:14.000Z', params: { pipeline_step: 'audio' } }),
    ]
    jobs[0]!.params.pipeline_chain = [{ type: 'subtitles_transcribe', params: { pipeline_step: 'subtitles' } }]
    const episodes = summarizeBatchEpisodes(jobs, new Map([['DM0013', 'The Lost Temple']]))
    const { title, body } = formatBatchMessage({ ...STATS, total: 2, success: 1, fail: 1 }, 'Story Sprout', episodes)
    assert.equal(title, 'Pipeline finished with issues — Story Sprout')
    assert.equal(body, [
      '0/1 episodes succeeded. 1 failed. Elapsed 15h 47m.',
      'DM0013 — The Lost Temple: script ✓ 3m28s · audio ✗ 8m46s — provider <timeout> & retry exhausted'
        + ' · subtitles — pending · total 12m14s · finished steps are kept',
    ].join('\n'))
    assert.doesNotMatch(body, /done · \d+ step/)
  })
})

describe('Telegram text — escaping, Khmer titles, and the 4096 cap', () => {
  test('HTML specials are escaped; Khmer text passes through intact', () => {
    const text = formatTelegramText({ title: 'ព្រះអាទិត្យ & <មាស>', body: 'DM0013 — The Lost & Found <script>' })
    assert.ok(text.startsWith('<b>ព្រះអាទិត្យ &amp; &lt;មាស&gt;</b>\n'))
    assert.ok(text.endsWith('DM0013 — The Lost &amp; Found &lt;script&gt;'))
    assert.ok(!text.includes('<មាស>'))
    assert.ok(!text.includes('<script>'))
  })

  test('a long Khmer batch stays inside the Telegram length cap', () => {
    const khmer = 'ព្រះរាជាណាចក្រកម្ពុជា និងរឿងព្រេងបុរាណ & អច្ឆរិយៈ'
    const jobs = [
      ...Array.from({ length: BATCH_EPISODE_LINE_LIMIT + 4 }, (_, i) => mkJob({ status: 'done', job_id: `k${i}`, episode_id: `DM${3000 + i}` })),
      mkJob({ status: 'error', job_id: 'kf', episode_id: 'DM3900', type: 'audio', error: 'provider <timeout> & retry exhausted' }),
    ]
    const titles = new Map<string, string>(jobs.map(j => [j.episode_id, khmer] as [string, string]))
    const episodes = summarizeBatchEpisodes(jobs, titles)
    const text = formatTelegramText(formatBatchMessage({ ...{ batch_id: 'B', total: jobs.length, success: jobs.length - 1, fail: 1, cancelled: 0, earliest_created_at: null, latest_finished_at: null, elapsed_ms: 56_820_000, still_active: 0 } }, 'Domnak Kmouch', episodes))
    assert.ok(text.length <= 4096, `telegram text must stay ≤4096 chars, got ${text.length}`)
    assert.match(text, /… and 5 more/)
    assert.match(text, /DM3900/) // the failure line is always shown, never omitted
  })

  test('the sender still applies the hard cap as a backstop', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../services/telegram-notifier.ts', import.meta.url), 'utf8')
    assert.match(src, /text: truncateChars\(text, 4096\)/)
  })
})

describe('main.ts wiring resolves and passes episode identity', () => {
  test('all four builders receive the resolved title; the batch resolves in one idea-store read', async () => {
    const { readFile } = await import('node:fs/promises')
    const main = await readFile(new URL('../../main.ts', import.meta.url), 'utf8')
    assert.match(main, /formatFailureMessage\(job, projectLabel, await episodeTitleFor\(job\)\)/)
    assert.match(main, /formatSingleJobMessage\(job, projectLabel, await episodeTitleFor\(job\)\)/)
    assert.match(main, /formatApprovalWaitMessage\(job, projectLabel, await episodeTitleFor\(job\)\)/)
    assert.match(main, /formatBatchMessage\(stats, projectLabel, episodes\)/)
    assert.match(main, /summarizeBatchEpisodes\(batchJobs, titles\)/)
    assert.match(main, /createProjectFactsCache\(slug\)/)
    assert.match(main, /resolveEpisodeTitleByCode\(slug, code, cache\)/)
    assert.match(main, /if \(!code\) return ''/) // empty id → no lookup, no guess
  })
})
