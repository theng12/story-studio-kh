import assert from 'node:assert/strict'
import Module from 'node:module'
import { test } from 'node:test'
import { CREDENTIALS_UNAVAILABLE, CredentialsUnavailableError } from '../lib/keychain-access.js'

test('the Mac wrapper guards availability, encrypt and decrypt before Electron, and unlock is explicit', async () => {
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
  const originalLoad = loader._load
  const version = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const events: string[] = []
  let status = -25308
  const ss = {
    isEncryptionAvailable() { events.push('electron:availability'); return true },
    encryptString(value: string) { events.push('electron:encrypt'); return Buffer.from(value) },
    decryptString(value: Buffer) { events.push('electron:decrypt'); return value.toString() },
  }
  const guard = {
    probe(_service: string, _account: string, interactive: boolean) {
      events.push(`probe:${interactive}`)
      if (interactive) status = 0
      return status
    },
    setInteractionAllowed(allowed: boolean) { events.push(`interaction:${allowed}`); return 0 },
  }
  try {
    Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true })
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    loader._load = (name, ...args) => {
      if (name === 'electron') return { safeStorage: ss, app: { getName: () => 'Story Studio KH' } }
      if (name.endsWith('keychain-guard.node')) return guard
      return originalLoad.call(Module, name, ...args)
    }
    const storage = await import(new URL('../lib/safe-storage.ts?guarded-wrapper', import.meta.url).href) as typeof import('../lib/safe-storage.js')
    for (const action of [storage.isEncryptionAvailable, () => storage.encryptToBase64('synthetic'), () => storage.decryptFromBase64('synthetic')]) {
      assert.throws(action, /Credentials unavailable/)
    }
    assert.equal(events.some(event => event.startsWith('electron:')), false)
    assert.equal(events.includes('probe:true'), false)
    assert.equal(storage.getCredentialsStatus().state, 'unavailable')
    assert.equal(storage.unlockCredentials(), true, 'a verified attended unlock reports success')
    assert.equal(events.filter(event => event === 'probe:true').length, 1)
    const encrypted = storage.encryptToBase64('synthetic')
    assert.equal(storage.decryptFromBase64(encrypted), 'synthetic')
    assert.equal(storage.getCredentialsStatus().state, 'available')
    assert.equal(events.filter(event => event === 'interaction:true').length, 0, 'only native probe scopes an attended read')

    // Existing-ciphertext verification: if the decrypt really fails, unlock must
    // NOT announce success — availability alone never proved the key works.
    assert.equal(storage.unlockCredentials(() => { throw new CredentialsUnavailableError('decrypt-failed') }), false)
    assert.equal(storage.getCredentialsStatus().state, 'unavailable')
    assert.equal(storage.getCredentialsStatus().code, 'decrypt-failed')
    assert.equal(storage.getCredentialsStatus().message, CREDENTIALS_UNAVAILABLE, 'no raw/native text in the status')
    assert.equal(storage.isEncryptionAvailable(), true)
    assert.equal(storage.getCredentialsStatus().state, 'unavailable', 'a capability check never announces usable credentials')
    assert.equal(storage.unlockCredentials(), true, 'a later verified unlock recovers')

    loader._load = (name, ...args) => name === 'electron' ? {} : originalLoad.call(Module, name, ...args)
    const missing = await import(new URL('../lib/safe-storage.ts?guarded-wrapper-missing', import.meta.url).href) as typeof import('../lib/safe-storage.js')
    assert.throws(missing.isEncryptionAvailable, /Credentials unavailable/, 'a broken Mac module must never select plaintext fallback')
    assert.equal(missing.getCredentialsStatus().state, 'unavailable')
    assert.equal(missing.getCredentialsStatus().code, 'module-unavailable')
  } finally {
    loader._load = originalLoad
    if (version) Object.defineProperty(process.versions, 'electron', version)
    else delete (process.versions as Record<string, unknown>).electron
    Object.defineProperty(process, 'platform', platform)
  }
})
