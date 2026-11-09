import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CredentialsUnavailableError, KeychainAccess } from '../lib/keychain-access.js'

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
    assert.match(access.getStatus().message, /unchanged.*Help → Unlock credentials/s)
  }
})

test('missing or failed native guard refuses before Electron is called', () => {
  for (const load of [
    () => { throw new Error('missing binary') },
    () => ({ probe: () => 0, setInteractionAllowed: () => -1 }),
  ]) {
    const access = new KeychainAccess(load, 'Story Studio KH')
    assert.throws(() => access.run(() => assert.fail('must not enter Electron')), CredentialsUnavailableError)
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
  access.unlock(() => { events.push('electron') })
  assert.deepEqual(events, ['probe:false', 'probe:true', 'interaction:false', 'probe:false', 'interaction:false', 'electron'])
  assert.equal(access.getStatus().state, 'available')
})

test('cancelled attended read and an Electron failure remain unavailable', () => {
  const cancelled = new KeychainAccess(() => ({ probe: () => -128, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.throws(() => cancelled.unlock(() => assert.fail('cancelled')), CredentialsUnavailableError)
  const access = new KeychainAccess(() => ({ probe: () => 0, setInteractionAllowed: () => 0 }), 'Story Studio KH')
  assert.throws(() => access.run(() => { throw new Error('unavailable') }), CredentialsUnavailableError)
  assert.equal(access.getStatus().state, 'unavailable')
})
