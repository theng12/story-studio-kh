import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keychainFailure } from '../routes/content-store.js'

// Dreamlands E2E: with no Keychain every install failed with the generic fallback and nothing said why.
test('an unavailable Keychain is reported as its own code, in plain words', () => {
  const failure = keychainFailure(new Error('Content Store key anchor requires available OS safeStorage'))!
  assert.equal(failure.status, 503)
  assert.equal(failure.body.code, 'CONTENT_STORE_KEYCHAIN_UNAVAILABLE')
  assert.match(String(failure.body.detail), /Keychain is not available/)
  assert.doesNotMatch(String(failure.body.detail), /safeStorage|anchor/)
})

test('other failures are not mistaken for it', () => {
  assert.equal(keychainFailure(new Error('boom')), null)
})
