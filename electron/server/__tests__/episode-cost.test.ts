import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'
import {
  computeEpisodeCost,
  computeProjectCost,
  detectThisMacClass,
  resolveWattsForMachine,
} from '../services/episode-cost.js'
import { DEFAULT_COST_SETTINGS, type CostSettings } from '../contracts/episode-cost.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let app: express.Express

describe('Episode and Channel Cost Calculations', () => {
  before(async () => {
    tmp = await useTempDataDir()
    process.env.STORY_STUDIO_TEST_MAC_CLASS = 'mac-studio'
    pm = await import('../services/project-manager.js')
    const { router: projectRouter } = await import('../routes/projects.js')
    const { router: settingsRouter } = await import('../routes/app-settings.js')
    app = express().use(express.json()).use(projectRouter).use(settingsRouter)
  })

  after(async () => {
    delete process.env.STORY_STUDIO_TEST_MAC_CLASS
    await tmp.cleanup()
  })

  // ── 1. REAL FIGURES ────────────────────────────────────────────────────────
  test('real figures: calculates exact paid Gateway charges and local compute costs', () => {
    // 60 minutes = 1 hour on Mac Studio (85W).
    // kWh = 1 hr * 0.085 kW = 0.085 kWh.
    // At 720 KHR/kWh: cost = 0.085 * 720 = 61.2 KHR.
    // At 4000 KHR/USD: cost = 61.2 / 4000 = $0.0153 USD.
    const jobs: Job[] = [
      {
        job_id: 'job-1',
        project_slug: 'demo',
        type: 'video_assembly',
        episode_id: 'EP0001',
        title: 'Video Assembly EP0001',
        status: 'done',
        created_at: '2026-10-27T10:00:00.000Z',
        started_at: '2026-10-27T10:00:00.000Z',
        finished_at: '2026-10-27T11:00:00.000Z', // 60 min
        error: null,
        output_lines: [],
        params: {},
        result: {
          selected_machine: {
            id: 'studio-1',
            label: 'Main Studio',
            chip: 'Apple M2 Max',
            memory_gb: 32,
            hardware_class: 'mac-studio',
          },
        },
      },
      {
        job_id: 'job-2',
        project_slug: 'demo',
        type: 'scene_image_generate',
        episode_id: 'EP0001',
        title: 'Images EP0001',
        status: 'done',
        created_at: '2026-10-27T09:00:00.000Z',
        started_at: '2026-10-27T09:00:00.000Z',
        finished_at: '2026-10-27T09:10:00.000Z', // 10 min
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [
          {
            id: 'task-img-1',
            operation: 'image.generation',
            state: 'succeeded',
            cost_source: 'provider',
            cost_usd: 0.08,
            settled_credits: 4,
            updated_at: '2026-10-27T09:05:00.000Z',
          },
          {
            id: 'task-img-2',
            operation: 'image.generation',
            state: 'succeeded',
            cost_source: 'provider',
            cost_usd: 0.04,
            settled_credits: 2,
            updated_at: '2026-10-27T09:08:00.000Z',
          },
        ],
        paid_image_replacement_attempts: [
          {
            state: 'succeeded',
            eligible_at: '2026-10-27T09:06:00.000Z',
            actual_settled_credits: 1,
          } as any,
        ],
      },
    ]

    const cost = computeEpisodeCost(jobs, 'EP0001', DEFAULT_COST_SETTINGS, 'mac-studio')

    // Paid cost check
    assert.equal(cost.paid.state, 'measured')
    assert.equal(cost.paid.usd, 0.12) // 0.08 + 0.04
    assert.equal(cost.paid.credits, 7) // 4 + 2 + 1 replacement

    // Local cost check
    assert.equal(cost.local.state, 'measured')
    assert.equal(cost.local.mac_minutes, 70) // 60 min + 10 min
    // 70 min on Mac Studio (85W) = 1.1667 hr * 0.085 kW = 0.099167 kWh
    // 0.099167 * 720 = 71.4 KHR => 71.4 / 4000 = $0.01785 ≈ 0.0179 USD
    assert.equal(cost.local.cost_khr, 71)
    assert.equal(cost.local.cost_usd, 0.0179)

    // Waste check (both jobs succeeded and neither redone => 0% waste)
    assert.equal(cost.waste.state, 'measured')
    assert.equal(cost.waste.percent, 0)
    assert.equal(cost.waste.waste_jobs_count, 0)
    assert.equal(cost.waste.total_jobs_count, 2)

    // Total USD check: paid 0.12 + local 0.0179 = 0.1379
    assert.equal(cost.total_usd?.state, 'measured')
    assert.equal(cost.total_usd?.value, 0.1379)
  })

  // ── 2. RULE §6: MISSING DATA SHOWN AS UNKNOWN, NOT 0 ──────────────────────
  test('rule §6: missing data is shown as unmeasurable and never as zero', () => {
    // Case A: No jobs for episode
    const emptyCost = computeEpisodeCost([], 'EP9999', DEFAULT_COST_SETTINGS)
    assert.equal(emptyCost.paid.state, 'unmeasurable')
    assert.equal(emptyCost.paid.reason, 'no_jobs')
    assert.equal(emptyCost.paid.usd, undefined)
    assert.equal(emptyCost.paid.credits, undefined)

    assert.equal(emptyCost.local.state, 'unmeasurable')
    assert.equal(emptyCost.local.reason, 'no_jobs')
    assert.equal(emptyCost.local.mac_minutes, undefined)
    assert.equal(emptyCost.local.cost_usd, undefined)

    assert.equal(emptyCost.waste.state, 'unmeasurable')
    assert.equal(emptyCost.waste.percent, undefined)

    assert.equal(emptyCost.total_usd?.state, 'unmeasurable')

    // Case B: Job exists but has no provider charges (e.g. local script job)
    const localOnlyJob: Job = {
      job_id: 'j-local-1',
      project_slug: 'demo',
      type: 'chapter-only',
      episode_id: 'EP0002',
      title: 'Script',
      status: 'done',
      created_at: '2026-10-27T10:00:00.000Z',
      started_at: '2026-10-27T10:00:00.000Z',
      finished_at: '2026-10-27T10:02:00.000Z',
      error: null,
      output_lines: [],
      params: {},
    }

    const localCostResult = computeEpisodeCost([localOnlyJob], 'EP0002', DEFAULT_COST_SETTINGS)
    assert.equal(localCostResult.paid.state, 'unmeasurable')
    assert.equal(localCostResult.paid.reason, 'no_charge_recorded')
    assert.equal(localCostResult.paid.usd, undefined)

    assert.equal(localCostResult.local.state, 'measured')
    assert.equal(localCostResult.local.mac_minutes, 2)

    // Case C: Explicit 0 charge (free model that recorded $0 and 0 credits)
    const freeJob: Job = {
      job_id: 'j-free-1',
      project_slug: 'demo',
      type: 'chapter-only',
      episode_id: 'EP0003',
      title: 'Free Script',
      status: 'done',
      created_at: '2026-10-27T10:00:00.000Z',
      started_at: '2026-10-27T10:00:00.000Z',
      finished_at: '2026-10-27T10:00:00.000Z',
      error: null,
      output_lines: [],
      params: {},
      genstudio_jobs: [
        {
          id: 'task-free',
          operation: 'chat.response',
          state: 'succeeded',
          cost_source: 'provider',
          cost_usd: 0,
          settled_credits: 0,
          updated_at: '2026-10-27T10:00:00.000Z',
        },
      ],
    }

    const freeResult = computeEpisodeCost([freeJob], 'EP0003', DEFAULT_COST_SETTINGS)
    assert.equal(freeResult.paid.state, 'measured', 'explicit 0 charge must be measured, not unmeasurable')
    assert.equal(freeResult.paid.usd, 0)
    assert.equal(freeResult.paid.credits, 0)
  })

  // ── 3. WASTE COMPUTED ─────────────────────────────────────────────────────
  test('waste % is computed accurately from failed, cancelled and superseded jobs', () => {
    // Scenario:
    // Audio job 1 failed (cost $0.20, local 5m).
    // Audio job 2 succeeded (cost $0.60, local 15m).
    // Total cost = $0.20 + $0.60 + local cost.
    const jobs: Job[] = [
      {
        job_id: 'audio-failed',
        project_slug: 'demo',
        type: 'audio',
        episode_id: 'EP0010',
        title: 'Audio 1',
        status: 'error',
        created_at: '2026-10-27T08:00:00.000Z',
        started_at: '2026-10-27T08:00:00.000Z',
        finished_at: '2026-10-27T08:05:00.000Z',
        error: 'TTS synthesis failed',
        output_lines: [],
        params: {},
        genstudio_jobs: [
          {
            id: 'tts-fail',
            operation: 'voice.tts',
            state: 'failed',
            cost_source: 'provider',
            cost_usd: 0.25,
            settled_credits: 5,
            updated_at: '2026-10-27T08:05:00.000Z',
          },
        ],
      },
      {
        job_id: 'audio-success',
        project_slug: 'demo',
        type: 'audio',
        episode_id: 'EP0010',
        title: 'Audio 2',
        status: 'done',
        created_at: '2026-10-27T08:10:00.000Z',
        started_at: '2026-10-27T08:10:00.000Z',
        finished_at: '2026-10-27T08:25:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [
          {
            id: 'tts-ok',
            operation: 'voice.tts',
            state: 'succeeded',
            cost_source: 'provider',
            cost_usd: 0.75,
            settled_credits: 15,
            updated_at: '2026-10-27T08:25:00.000Z',
          },
        ],
      },
    ]

    const cost = computeEpisodeCost(jobs, 'EP0010', DEFAULT_COST_SETTINGS, 'mac-studio')
    assert.equal(cost.waste.state, 'measured')
    assert.equal(cost.waste.waste_jobs_count, 1)
    assert.equal(cost.waste.total_jobs_count, 2)
    // Waste USD = 0.25 (paid) + local of audio-failed
    // Total USD = 1.00 (paid) + total local
    // Waste % is approximately 25%
    assert.ok(cost.waste.percent! >= 24 && cost.waste.percent! <= 26, `waste % should be ~25%, was ${cost.waste.percent}`)
  })

  // ── 4. A REDONE JOB COUNTED ONCE AS WASTE ─────────────────────────────────
  test('a redone job is counted exactly once as waste even if it also failed', () => {
    // Job 1: script step, failed.
    // Job 2: script step, retry succeeded.
    // Job 1 is both "failed" AND "superseded/redone". It must only be counted ONCE in waste!
    const jobs: Job[] = [
      {
        job_id: 'script-att-1',
        project_slug: 'demo',
        type: 'chapter-only',
        episode_id: 'EP0020',
        title: 'Script Attempt 1',
        status: 'error',
        created_at: '2026-10-27T07:00:00.000Z',
        started_at: '2026-10-27T07:00:00.000Z',
        finished_at: '2026-10-27T07:02:00.000Z',
        error: 'Rate limit',
        output_lines: [],
        params: {},
        genstudio_jobs: [
          {
            id: 'chat-fail',
            operation: 'chat.response',
            state: 'failed',
            cost_source: 'provider',
            cost_usd: 0.10,
            settled_credits: 2,
            updated_at: '2026-10-27T07:02:00.000Z',
          },
        ],
      },
      {
        job_id: 'script-att-2',
        project_slug: 'demo',
        type: 'chapter-only',
        episode_id: 'EP0020',
        title: 'Script Attempt 2',
        status: 'done',
        created_at: '2026-10-27T07:10:00.000Z',
        started_at: '2026-10-27T07:10:00.000Z',
        finished_at: '2026-10-27T07:13:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [
          {
            id: 'chat-ok',
            operation: 'chat.response',
            state: 'succeeded',
            cost_source: 'provider',
            cost_usd: 0.10,
            settled_credits: 2,
            updated_at: '2026-10-27T07:13:00.000Z',
          },
        ],
      },
    ]

    const cost = computeEpisodeCost(jobs, 'EP0020', DEFAULT_COST_SETTINGS)
    assert.equal(cost.waste.state, 'measured')
    assert.equal(cost.waste.waste_jobs_count, 1, 'Job 1 must be counted ONCE, not twice')
    assert.equal(cost.waste.total_jobs_count, 2)
    assert.equal(cost.waste.waste_credits, 2)
    assert.equal(cost.waste.total_credits, 4)
    // Waste percent should be ~50%
    assert.ok(cost.waste.percent! >= 49 && cost.waste.percent! <= 51, `waste % should be ~50%, was ${cost.waste.percent}`)
  })

  test('a completed job that was subsequently redone is counted as waste once', () => {
    // Job 1: images step, done.
    // Job 2: images step, redone (done).
    // Job 1 was superseded by Job 2, so Job 1 is waste.
    const jobs: Job[] = [
      {
        job_id: 'img-1',
        project_slug: 'demo',
        type: 'scene_image_generate',
        episode_id: 'EP0021',
        title: 'Images v1',
        status: 'done',
        created_at: '2026-10-27T06:00:00.000Z',
        started_at: '2026-10-27T06:00:00.000Z',
        finished_at: '2026-10-27T06:05:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [{ id: 't1', operation: 'image.generation', state: 'succeeded', settled_credits: 10, updated_at: '2026-10-27T06:05:00.000Z' }],
      },
      {
        job_id: 'img-2',
        project_slug: 'demo',
        type: 'scene_image_generate',
        episode_id: 'EP0021',
        title: 'Images v2',
        status: 'done',
        created_at: '2026-10-27T06:30:00.000Z',
        started_at: '2026-10-27T06:30:00.000Z',
        finished_at: '2026-10-27T06:35:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [{ id: 't2', operation: 'image.generation', state: 'succeeded', settled_credits: 10, updated_at: '2026-10-27T06:35:00.000Z' }],
      },
    ]

    const cost = computeEpisodeCost(jobs, 'EP0021', DEFAULT_COST_SETTINGS)
    assert.equal(cost.waste.waste_jobs_count, 1, 'Job 1 is superseded and counted once as waste')
    assert.equal(cost.waste.total_jobs_count, 2)
    assert.equal(cost.waste.waste_credits, 10)
    assert.equal(cost.waste.total_credits, 20)
    assert.equal(cost.waste.percent, 50)
  })

  // ── 5. CHANNEL TOTALS ─────────────────────────────────────────────────────
  test('computeProjectCost accurately computes channel totals across multiple episodes', () => {
    const jobs: Job[] = [
      // EP0001: paid $0.10, local 10 min
      {
        job_id: 'j-ep1',
        project_slug: 'demo-chan',
        type: 'audio',
        episode_id: 'EP0001',
        title: 'EP1 Audio',
        status: 'done',
        created_at: '2026-10-27T01:00:00.000Z',
        started_at: '2026-10-27T01:00:00.000Z',
        finished_at: '2026-10-27T01:10:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [{ id: 't-ep1', operation: 'voice.tts', state: 'succeeded', cost_source: 'provider', cost_usd: 0.10, settled_credits: 5, updated_at: '2026-10-27T01:10:00.000Z' }],
      },
      // EP0002: paid $0.30, local 20 min
      {
        job_id: 'j-ep2',
        project_slug: 'demo-chan',
        type: 'audio',
        episode_id: 'EP0002',
        title: 'EP2 Audio',
        status: 'done',
        created_at: '2026-10-27T02:00:00.000Z',
        started_at: '2026-10-27T02:00:00.000Z',
        finished_at: '2026-10-27T02:20:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [{ id: 't-ep2', operation: 'voice.tts', state: 'succeeded', cost_source: 'provider', cost_usd: 0.30, settled_credits: 15, updated_at: '2026-10-27T02:20:00.000Z' }],
      },
    ]

    const report = computeProjectCost(jobs, 'demo-chan', DEFAULT_COST_SETTINGS, 'mac-studio')
    assert.equal(report.project_slug, 'demo-chan')
    assert.equal(report.channel_total.paid.state, 'measured')
    assert.equal(report.channel_total.paid.usd, 0.40)
    assert.equal(report.channel_total.paid.credits, 20)
    assert.equal(report.channel_total.local.state, 'measured')
    assert.equal(report.channel_total.local.mac_minutes, 30) // 10 + 20
    assert.equal(report.channel_total.waste.state, 'measured')
    assert.equal(report.channel_total.waste.percent, 0)
    assert.equal(Object.keys(report.episodes).length, 2)
  })

  // ── 6. SETTINGS API ───────────────────────────────────────────────────────
  test('GET and PUT /app-settings/cost manage electricity and Mac power settings', async () => {
    // Read defaults
    const getRes = await request(app).get('/app-settings/cost').expect(200)
    assert.equal(getRes.body.electricity_khr_per_kwh, 720)
    assert.equal(getRes.body.khr_per_usd, 4000)
    assert.equal(getRes.body.mac_power_watts['mac-mini'], 35)
    assert.equal(getRes.body.mac_power_watts['mac-studio'], 85)

    // Update settings
    const putRes = await request(app)
      .put('/app-settings/cost')
      .send({
        electricity_khr_per_kwh: 800,
        khr_per_usd: 4100,
        mac_power_watts: {
          'mac-mini': 40,
        },
      })
      .expect(200)

    assert.equal(putRes.body.electricity_khr_per_kwh, 800)
    assert.equal(putRes.body.khr_per_usd, 4100)
    assert.equal(putRes.body.mac_power_watts['mac-mini'], 40)
    // mac-studio should be preserved
    assert.equal(putRes.body.mac_power_watts['mac-studio'], 85)

    // Rejection on invalid inputs
    await request(app)
      .put('/app-settings/cost')
      .send({ electricity_khr_per_kwh: -50 })
      .expect(400)

    await request(app)
      .put('/app-settings/cost')
      .send({ khr_per_usd: 0 })
      .expect(400)
  })

  // ── 7. HTTP PROJECT COST ROUTES ───────────────────────────────────────────
  test('GET /projects/:slug/cost and GET /projects/:slug/episodes/:code/cost', async () => {
    const project = await pm.createProject({ name: 'Cost Route Project' })
    const jobsPath = path.join(pm.getProjectDir(project.slug)!, 'jobs.json')
    const sampleJobs: Job[] = [
      {
        job_id: 'route-job-1',
        project_slug: project.slug,
        type: 'audio',
        episode_id: 'EP0100',
        title: 'EP0100 Audio',
        status: 'done',
        created_at: '2026-10-27T03:00:00.000Z',
        started_at: '2026-10-27T03:00:00.000Z',
        finished_at: '2026-10-27T03:05:00.000Z',
        error: null,
        output_lines: [],
        params: {},
        genstudio_jobs: [{ id: 'rj1', operation: 'voice.tts', state: 'succeeded', cost_source: 'provider', cost_usd: 0.15, settled_credits: 5, updated_at: '2026-10-27T03:05:00.000Z' }],
      },
    ]
    await fs.writeFile(jobsPath, JSON.stringify({ jobs: sampleJobs }), 'utf8')

    // Channel cost report
    const projectCostRes = await request(app).get(`/projects/${project.slug}/cost`).expect(200)
    assert.equal(projectCostRes.body.project_slug, project.slug)
    assert.equal(projectCostRes.body.channel_total.paid.state, 'measured')
    assert.equal(projectCostRes.body.channel_total.paid.usd, 0.15)
    assert.ok(projectCostRes.body.episodes.EP0100)

    // Single episode cost summary
    const epCostRes = await request(app).get(`/projects/${project.slug}/episodes/EP0100/cost`).expect(200)
    assert.equal(epCostRes.body.episode_code, 'EP0100')
    assert.equal(epCostRes.body.paid.state, 'measured')
    assert.equal(epCostRes.body.paid.usd, 0.15)
    assert.equal(epCostRes.body.local.state, 'measured')
    assert.equal(epCostRes.body.local.mac_minutes, 5)

    // Missing episode
    const epMissingRes = await request(app).get(`/projects/${project.slug}/episodes/EP_MISSING/cost`).expect(200)
    assert.equal(epMissingRes.body.paid.state, 'unmeasurable')
    assert.equal(epMissingRes.body.paid.reason, 'no_jobs')
  })
})
