import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveGenStudioModelId,
  unavailableLegacyModelMessage,
} from '../services/genstudio-model-migration.js'

describe('Gateway model migration boundary', () => {
  test('accepts exact owner-defined product identifiers and known transport prefixes', () => {
    assert.equal(resolveGenStudioModelId('chat', 'genstudio-chat:genstudio-chat-current-v1'), 'genstudio-chat-current-v1')
    assert.equal(resolveGenStudioModelId('chat', 'claude-sonnet-4-6'), 'claude-sonnet-4-6')
    assert.equal(resolveGenStudioModelId('video', 'genstudio-video:genstudio-video-current-v1'), 'genstudio-video-current-v1')
    assert.equal(resolveGenStudioModelId('image', 'genstudio-image-current-v1'), 'genstudio-image-current-v1')
  })

  test('leaves retirement authority to the live catalog without implying submission or charge', () => {
    assert.equal(resolveGenStudioModelId('chat', 'gpt-4o'), 'gpt-4o')
    const message = unavailableLegacyModelMessage('chat', 'gpt-4o')
    assert.match(message, /retired or unavailable/)
    assert.match(message, /was not submitted/)
    assert.match(message, /No generation request or credit charge was made/)
  })
})
