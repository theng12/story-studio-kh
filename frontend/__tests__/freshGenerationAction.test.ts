import assert from 'node:assert/strict'
import test from 'node:test'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction'

test('an unresolved action keeps its id for the same scope and changes it for a deliberate scope edit', () => {
  const action = useFreshGenerationAction()
  const first = action.begin({ episode: 'EP0001', model: 'voice-a' })
  assert.equal(action.begin({ episode: 'EP0001', model: 'voice-a' }), first)
  assert.equal(action.isRetry({ episode: 'EP0001', model: 'voice-a' }), true)

  const changed = action.begin({ episode: 'EP0001', model: 'voice-b' })
  assert.notEqual(changed, first)
  assert.equal(action.isRetry({ episode: 'EP0001', model: 'voice-a' }), false)
  assert.equal(action.isRetry({ episode: 'EP0001', model: 'voice-b' }), true)
})

test('independent row targets retain their own unresolved actions and success clears only its action', () => {
  const action = useFreshGenerationAction()
  const first = action.begin({ words: 500 }, 'chapter:1')
  const second = action.begin({ words: 700 }, 'chapter:2')
  assert.equal(action.begin({ words: 500 }, 'chapter:1'), first)
  assert.equal(action.begin({ words: 700 }, 'chapter:2'), second)

  action.complete(first)
  assert.equal(action.isRetry({ words: 500 }, 'chapter:1'), false)
  assert.equal(action.isRetry({ words: 700 }, 'chapter:2'), true)
  assert.equal(action.hasPending.value, true)
  action.complete(second)
  assert.equal(action.hasPending.value, false)
})
