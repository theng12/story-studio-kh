import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CREDENTIALS_UNAVAILABLE,
  CredentialsUnavailableError,
  KeychainAccess,
  type CredentialsStage,
  type KeychainGuard,
} from '../lib/keychain-access.js'

test('denied or interaction-required preflight never enters Electron or reports empty credentials', () => {
  for (const status of [-25308, -25293]) {
    const events: string[] = []
    const access = new KeychainAccess(() => ({
      probe(service, account, interactive) {
        assert.equal(service, 'Story Studio KH Safe Storage')
        assert.equal(account, 'Story Studio KH Key')
        events.push(`probe:${interactive}`)
        return status
      },
      setInteractionAllowed: () => { events.push('guard'); return 0 },
    }), 'Story Studio KH')
    assert.throws(() => access.run(() => events.push('electron')), CredentialsUnavailableError)
    assert.deepEqual(events, ['probe:false'])
    assert.equal(access.getStatus().state, 'unavailable')
    assert.equal(access.getStatus().code, 'access-denied')
    assert.equal(access.getStatus().os_code, status, 'the finite errSec* code is kept, not a message')
    assert.match(access.getStatus().message, /unchanged.*Help → Unlock credentials/s)
  }
})

test('missing or failed native guard refuses before Electron is called', () => {
  const cases: Array<{ load: () => KeychainGuard; code: CredentialsStage; osCode?: number }> = [
    { load: () => { throw new Error('missing binary at /Users/someone/lib/keychain-guard.node') }, code: 'guard-failed' },
    { load: () => ({ probe: () => 0, setInteractionAllowed: () => -1 }), code: 'access-denied', osCode: -1 },
  ]
  for (const { load, code, osCode } of cases) {
    const access = new KeychainAccess(load, 'Story Studio KH')
    assert.throws(() => access.run(() => assert.fail('must not enter Electron')), CredentialsUnavailableError)
    const status = access.getStatus()
    assert.equal(status.state, 'unavailable')
    assert.equal(status.code, code)
    assert.equal(status.os_code, osCode)
    assert.equal(status.message, CREDENTIALS_UNAVAILABLE, 'no raw text ever becomes a status message')
    assert.ok(!status.message.includes('/Users'), 'no path leaks into diagnostics')
  }
})

test('authorized and first-install reads enter Electron only after noninteractive guard succeeds', () => {
  for (const status of [0, -25300]) {
    const events: string[] = []
    const access = new KeychainAccess(() => ({
      probe: (_service, _account, interactive) => { events.push(`probe:${interactive}`); return status },
      setInteractionAllowed: allowed => { events.push(`interaction:${allowed}`); return 0 },
    }), 'Story Studio KH')
    assert.equal(access.run(() => { events.push('electron'); return 'encrypted' }), 'encrypted')
    assert.deepEqual(events, ['probe:false', 'interaction:false', 'electron'])
    assert.equal(access.getStatus().state, 'available')
    assert.equal(access.getStatus().code, undefined, 'a successful read carries no failure code')
  }
})

test('attended unlock retries a blocked preflight, then rechecks without interaction before Electron', () => {
  let allowed = false
  const events: string[] = []
  const access = new KeychainAccess(() => ({
    probe: (_service, _account, interactive) => {
      events.push(`probe:${interactive}`)
      if (interactive) allowed = true
      return allowed ? 0 : -25308
    },
    setInteractionAllowed: value => { events.push(`interaction:${value}`); return 0 },
  }), 'Story Studio KH')
  assert.throws(() => access.run(() => assert.fail('blocked')), CredentialsUnavailableError)
  assert.equal(access.unlock(() => { events.push('electron') }), true)
  assert.deepEqual(events, ['probe:false', 'probe:true', 'interaction:false', 'probe:false', 'interaction:false', 'electron'])
  assert.equal(access.getStatus().state, 'available')
})

test('cancelled attended read and an Electron failure remain unavailable with a finite code', () => {
  const cancelled = new KeychainAccess(() => ({ probe: () => -128, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.equal(cancelled.unlock(() => assert.fail('cancelled')), false, 'unlock reports, never throws, never announces success')
  assert.equal(cancelled.getStatus().state, 'unavailable')
  assert.equal(cancelled.getStatus().code, 'access-denied')
  const access = new KeychainAccess(() => ({ probe: () => 0, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.throws(() => access.run(() => { throw new Error('unavailable') }), CredentialsUnavailableError)
  assert.equal(access.getStatus().state, 'unavailable')
  assert.equal(access.getStatus().code, 'operation-failed')
})

test('no raw error text, path or native message ever reaches a credential diagnostic', () => {
  const leaky = new Error('decrypt failed for /Users/customer/project/app-secrets.json: secret-material-abc')
  const access = new KeychainAccess(() => ({ probe: () => 0, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.throws(() => access.run(() => { throw leaky }), (error: unknown) => {
    assert.ok(error instanceof CredentialsUnavailableError)
    assert.equal(error.message, CREDENTIALS_UNAVAILABLE)
    assert.ok(!error.message.includes('/Users') && !error.message.includes('secret-material'))
    return true
  })
  assert.equal(access.getStatus().message, CREDENTIALS_UNAVAILABLE)
  assert.equal(access.getStatus().code, 'operation-failed')

  // A coded stage raised inside the storage layer (encrypt/decrypt/module) is preserved.
  const coded = new KeychainAccess(() => ({ probe: () => 0, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.throws(() => coded.run(() => { throw new CredentialsUnavailableError('decrypt-failed') }), CredentialsUnavailableError)
  assert.equal(coded.getStatus().code, 'decrypt-failed')
})

test('attended unlock does not report success when ciphertext verification rejects', () => {
  const access = new KeychainAccess(() => ({ probe: () => 0, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.equal(access.unlock(() => { throw new CredentialsUnavailableError('decrypt-failed') }), false,
    'availability + a rejected decrypt is NOT success')
  assert.equal(access.getStatus().state, 'unavailable')
  assert.equal(access.getStatus().code, 'decrypt-failed')
  assert.equal(access.getStatus().message, CREDENTIALS_UNAVAILABLE)
  // After the actual fix (attended, verified), a later unlock succeeds.
  assert.equal(access.unlock(() => {}), true)
  assert.equal(access.getStatus().state, 'available')
})
