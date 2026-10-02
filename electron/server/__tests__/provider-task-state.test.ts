import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  effectiveGenStudioTaskState,
  reconciledGenStudioQueueState,
} from '../contracts/provider-task-state.js'

describe('Gateway provider task state', () => {
  test('provider-confirmed no-record state overrides a stale local running hint', () => {
    const entry = { state: 'not_created', queue_state: 'running' }
    assert.equal(effectiveGenStudioTaskState(entry), 'not_created')
    assert.equal(reconciledGenStudioQueueState(entry.state), 'not_created')
  })

  test('unrecognized provider states retain the established running reconciliation state', () => {
    assert.equal(effectiveGenStudioTaskState({ state: 'submitting', queue_state: 'running' }), 'running')
    assert.equal(reconciledGenStudioQueueState('provider_status_unavailable'), 'running')
  })
})
