import { test } from 'node:test'
import assert from 'node:assert/strict'

import { orderJobsForDisplay } from '../utils/jobs-list.js'

interface Row {
  job_id: string
  status: string
  type: string
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  queue_position?: number
}

function job(overrides: Partial<Row> & Pick<Row, 'job_id' | 'status' | 'type'>): Row {
  return { created_at: '2026-10-18T00:00:00.000Z', ...overrides }
}

const KINDS = ['video_assembly', 'audio']

test('the Jobs page order is running, queued by kind and dispatch position, paused, then latest finished', () => {
  const rows = [
    job({ job_id: 'done-old', status: 'done', type: 'video_assembly', finished_at: '2026-10-18T08:00:00.000Z' }),
    job({ job_id: 'queued-video-2', status: 'queued', type: 'video_assembly', queue_position: 2 }),
    job({ job_id: 'paused-1', status: 'paused', type: 'audio' }),
    job({ job_id: 'running-2', status: 'running', type: 'audio', started_at: '2026-10-18T11:00:00.000Z' }),
    job({ job_id: 'queued-audio-1', status: 'queued', type: 'audio', queue_position: 1 }),
    job({ job_id: 'done-new', status: 'done', type: 'audio', finished_at: '2026-10-18T12:00:00.000Z' }),
    job({ job_id: 'running-1', status: 'running', type: 'video_assembly', started_at: '2026-10-18T10:00:00.000Z' }),
    job({ job_id: 'queued-video-1', status: 'queued', type: 'video_assembly', queue_position: 1 }),
  ]

  assert.deepEqual(
    orderJobsForDisplay(rows, KINDS).map(row => row.job_id),
    [
      'running-1', 'running-2',
      'queued-video-1', 'queued-video-2', 'queued-audio-1',
      'paused-1',
      'done-new', 'done-old',
    ],
  )
})

test('the order does not depend on the array order a live update produced', () => {
  const rows = [
    job({ job_id: 'b', status: 'queued', type: 'video_assembly', queue_position: 2 }),
    job({ job_id: 'a', status: 'queued', type: 'video_assembly', queue_position: 1 }),
    job({ job_id: 'd', status: 'done', type: 'audio', finished_at: '2026-10-18T12:00:00.000Z' }),
    job({ job_id: 'c', status: 'done', type: 'audio', finished_at: '2026-10-18T08:00:00.000Z' }),
  ]
  const expected = ['a', 'b', 'd', 'c']
  assert.deepEqual(orderJobsForDisplay(rows, KINDS).map(row => row.job_id), expected)
  assert.deepEqual(orderJobsForDisplay([...rows].reverse(), KINDS).map(row => row.job_id), expected)
  assert.deepEqual(orderJobsForDisplay([rows[2]!, rows[0]!, rows[3]!, rows[1]!], KINDS).map(row => row.job_id), expected)
})

test('equal rows fall back to created_at then job_id, so nothing swaps between updates', () => {
  const rows = [
    job({ job_id: 'later', status: 'queued', type: 'audio', created_at: '2026-10-18T01:00:00.000Z' }),
    job({ job_id: 'same-b', status: 'queued', type: 'audio' }),
    job({ job_id: 'same-a', status: 'queued', type: 'audio' }),
  ]
  assert.deepEqual(
    orderJobsForDisplay(rows, KINDS).map(row => row.job_id),
    ['same-a', 'same-b', 'later'],
  )
})

test('unknown kinds still have a fixed order after the known ones', () => {
  const rows = [
    job({ job_id: 'z-kind', status: 'queued', type: 'z_custom', queue_position: 1 }),
    job({ job_id: 'audio', status: 'queued', type: 'audio', queue_position: 2 }),
    job({ job_id: 'a-kind', status: 'queued', type: 'a_custom', queue_position: 1 }),
  ]
  assert.deepEqual(
    orderJobsForDisplay(rows, KINDS).map(row => row.job_id),
    ['audio', 'a-kind', 'z-kind'],
  )
})
