import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldUseKeychain } from '../lib/safe-storage.js'

function withKeychainEnv(values: Record<string, string | undefined>, run: () => void): void {
  const keys = ['STORY_STUDIO_FORCE_KEYCHAIN', 'STORY_STUDIO_DISABLE_KEYCHAIN'] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) {
      const value = values[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('safeStorage is enabled by default for customer builds', () => {
  withKeychainEnv({}, () => assert.equal(shouldUseKeychain(), true))
})

test('safeStorage can be explicitly disabled for development recovery', () => {
  withKeychainEnv({ STORY_STUDIO_DISABLE_KEYCHAIN: '1' }, () => assert.equal(shouldUseKeychain(), false))
})

test('the force flag wins over an inherited disable flag', () => {
  withKeychainEnv(
    { STORY_STUDIO_FORCE_KEYCHAIN: '1', STORY_STUDIO_DISABLE_KEYCHAIN: '1' },
    () => assert.equal(shouldUseKeychain(), true),
  )
})
