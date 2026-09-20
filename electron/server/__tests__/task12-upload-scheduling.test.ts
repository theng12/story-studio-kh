import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import * as uploadPlans from '../services/upload-plans.js'

describe('Task 12 upload scheduling safety', () => {
  test('walks Lord Howe calendar days once across the 30-minute DST rollback', () => {
    // Break caught: adding 86,400,000 ms to a local-midnight instant lands at
    // 23:30 on the same Lord Howe calendar day after DST ends, so that day is
    // emitted twice and the following day is skipped.
    assert.deepEqual(uploadPlans.computeSlots({
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      time_local: '12:00',
      timezone: 'Australia/Lord_Howe',
      start_date: '2026-04-04',
    }, 3), [
      '2026-04-04T01:00:00.000Z',
      '2026-04-05T01:30:00.000Z',
      '2026-04-06T01:30:00.000Z',
    ])
  })

  test('restores the completed prefix when a later schedule CAS write fails', async () => {
    // Implementation contract only: the original missing-helper RED is not
    // reproduction evidence. task12-upload-plan-route-rollback exercises the
    // actual apply and relayout routes against real disposable sidecars.
    const apply = (uploadPlans as Record<string, unknown>).applyScheduleAssignmentsWithRollback
    assert.equal(typeof apply, 'function', 'upload plans need one shared rollback-capable batch writer')

    const values = new Map<string, string | null>([
      ['EP0001', '2026-09-21T00:00:00.000Z'],
      ['EP0002', '2026-09-22T00:00:00.000Z'],
    ])
    let rejectSecond = true
    const write = async (episodeCode: string, next: string | null, expected: string | null) => {
      assert.equal(values.get(episodeCode) ?? null, expected, `${episodeCode} CAS expectation`)
      if (episodeCode === 'EP0002' && rejectSecond) {
        rejectSecond = false
        throw new Error('simulated second sidecar write failure')
      }
      values.set(episodeCode, next)
    }

    await assert.rejects(
      (apply as (
        assignments: Array<{ episode_code: string; publishAt: string }>,
        previous: Readonly<Record<string, string | null>>,
        writer: typeof write,
      ) => Promise<void>)([
        { episode_code: 'EP0001', publishAt: '2026-10-01T00:00:00.000Z' },
        { episode_code: 'EP0002', publishAt: '2026-10-02T00:00:00.000Z' },
      ], {
        EP0001: '2026-09-21T00:00:00.000Z',
        EP0002: '2026-09-22T00:00:00.000Z',
      }, write),
      /simulated second sidecar write failure/,
    )
    assert.deepEqual(Object.fromEntries(values), {
      EP0001: '2026-09-21T00:00:00.000Z',
      EP0002: '2026-09-22T00:00:00.000Z',
    })
  })

  for (const rollbackFailure of ['conflict', 'io'] as const) {
    test(`names an uncertain episode when compensation ${rollbackFailure === 'conflict' ? 'loses a CAS race' : 'cannot be written'}`, async () => {
      const apply = (uploadPlans as Record<string, unknown>).applyScheduleAssignmentsWithRollback
      assert.equal(typeof apply, 'function', 'upload plans need one shared rollback-capable batch writer')

      const oldFirst = '2026-09-21T00:00:00.000Z'
      const newFirst = '2026-10-01T00:00:00.000Z'
      const values = new Map<string, string | null>([
        ['EP0001', oldFirst],
        ['EP0002', '2026-09-22T00:00:00.000Z'],
      ])
      const write = async (episodeCode: string, next: string | null, expected: string | null) => {
        if (episodeCode === 'EP0002') throw new Error('simulated later CAS failure')
        if (episodeCode === 'EP0001' && next === oldFirst) {
          if (rollbackFailure === 'conflict') {
            values.set(episodeCode, '2026-10-03T00:00:00.000Z')
            throw Object.assign(new Error('simulated compensation conflict'), { code: 'CAS_MISMATCH' })
          }
          throw Object.assign(new Error('simulated compensation I/O failure'), { code: 'EACCES' })
        }
        assert.equal(values.get(episodeCode) ?? null, expected, `${episodeCode} CAS expectation`)
        values.set(episodeCode, next)
      }

      await assert.rejects(
        (apply as (
          assignments: Array<{ episode_code: string; publishAt: string }>,
          previous: Readonly<Record<string, string | null>>,
          writer: typeof write,
        ) => Promise<void>)([
          { episode_code: 'EP0001', publishAt: newFirst },
          { episode_code: 'EP0002', publishAt: '2026-10-02T00:00:00.000Z' },
        ], {
          EP0001: oldFirst,
          EP0002: '2026-09-22T00:00:00.000Z',
        }, write),
        (error: any) => {
          assert.match(error.message, /simulated later CAS failure/)
          assert.match(error.message, /EP0001/)
          assert.match(error.message, /Refresh the Upload Center and review/)
          assert.deepEqual(error.committed_episode_codes, [])
          assert.deepEqual(error.uncertain_episode_codes, ['EP0001'])
          return true
        },
      )
      assert.notEqual(values.get('EP0001'), oldFirst, 'failed compensation never claims the old value was restored')
    })
  }
})
