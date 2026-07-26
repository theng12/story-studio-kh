import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveGenStudioModelId,
  unavailableLegacyModelMessage,
} from '../services/genstudio-model-migration.js'

describe('GenStudio model migration boundary', () => {
  test('accepts current GenStudio catalog identifiers and known transport prefixes', () => {
    assert.equal(resolveGenStudioModelId('chat', 'genstudio-chat:genstudio-chat-current-v1'), 'genstudio-chat-current-v1')
    assert.equal(resolveGenStudioModelId('video', 'genstudio-video:genstudio-video-current-v1'), 'genstudio-video-current-v1')
    assert.equal(resolveGenStudioModelId('image', 'genstudio-image-current-v1'), 'genstudio-image-current-v1')
  })

  test('fails retired provider identifiers closed without implying submission or charge', () => {
    assert.equal(resolveGenStudioModelId('chat', 'gpt-4o'), null)
    const message = unavailableLegacyModelMessage('chat', 'gpt-4o')
    assert.match(message, /retired/)
    assert.match(message, /was not submitted/)
    assert.match(message, /No generation request or credit charge was made/)
  })
})
