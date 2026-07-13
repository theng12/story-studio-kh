import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOB_TYPES } from '../models/types.js'
import { registerAllExecutors } from '../boot/executors.js'
import { knownJobTypes, unregisteredJobTypes } from '../services/job-queue.js'

test('every declared job type has a queue lane and registered executor', () => {
  registerAllExecutors({ loadSettings: false })
  assert.deepEqual([...knownJobTypes()].sort(), [...JOB_TYPES].sort())
  assert.deepEqual(unregisteredJobTypes(), [])
})
