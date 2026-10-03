import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyRowSelection, spreadPublishTimes } from '../utils/upload-bulk'

describe('upload bulk helpers', () => {
  const rows = ['EP4', 'EP3', 'EP2', 'EP1']
  test('a plain click toggles one row', () => {
    assert.deepEqual(applyRowSelection([], rows, null, 'EP3', true), ['EP3'])
    assert.deepEqual(applyRowSelection(['EP3', 'EP1'], rows, null, 'EP3', false), ['EP1'])
  })
  test('shift-click applies the clicked state to the on-screen range, either direction', () => {
    assert.deepEqual(applyRowSelection(['EP4'], rows, 'EP4', 'EP2', true), ['EP4', 'EP3', 'EP2'])
    assert.deepEqual(applyRowSelection(['EP4', 'EP3', 'EP2', 'EP1'], rows, 'EP1', 'EP3', false), ['EP4'])
  })
  test('an anchor no longer on screen falls back to a single row', () => {
    assert.deepEqual(applyRowSelection([], rows, 'EP9', 'EP2', true), ['EP2'])
  })
  test('publish times keep the wall-clock time and step by whole days', () => {
    const times = spreadPublishTimes('2099-03-01T18:30', 3, 7).map(iso => new Date(iso))
    assert.equal(times.length, 3)
    assert.deepEqual(times.map(t => [t.getDate(), t.getHours(), t.getMinutes()]), [[1, 18, 30], [8, 18, 30], [15, 18, 30]])
  })
  test('an unusable request gives no times rather than a guess', () => {
    assert.deepEqual(spreadPublishTimes('', 2, 1), [])
    assert.deepEqual(spreadPublishTimes('not a date', 2, 1), [])
    assert.deepEqual(spreadPublishTimes('2099-03-01T18:30', 2, 0), [])
    assert.deepEqual(spreadPublishTimes('2099-03-01T18:30', 0, 1), [])
  })
})
