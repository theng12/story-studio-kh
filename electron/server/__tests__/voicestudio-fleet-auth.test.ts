import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveVoiceStudioFleetToken } from '../lib/voicestudio-client.js'

describe('Voice Studio fleet authentication', () => {
  test('uses the configured shared Hub token without a network lookup', async () => {
    let calls = 0
    const token = await resolveVoiceStudioFleetToken({
      mode: 'direct', hubUrl: 'http://hub.example:47873', hubToken: ' shared-fleet-token ',
    }, async () => {
      calls++
      throw new Error('should not fetch')
    })
    assert.equal(token, 'shared-fleet-token')
    assert.equal(calls, 0)
  })

  test('loads the fleet token from a loopback Hub only', async () => {
    let requested = ''
    const token = await resolveVoiceStudioFleetToken({
      mode: 'hub', hubUrl: 'http://127.0.0.1:47873', hubToken: '',
    }, async (input) => {
      requested = String(input)
      return new Response(JSON.stringify({ token: 'local-fleet-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    assert.equal(requested, 'http://127.0.0.1:47873/api/hub/fleet')
    assert.equal(token, 'local-fleet-token')
  })

  test('never asks a remote Hub to reveal its fleet token', async () => {
    let calls = 0
    const token = await resolveVoiceStudioFleetToken({
      mode: 'hub', hubUrl: 'http://100.64.0.10:47873', hubToken: '',
    }, async () => {
      calls++
      return new Response('{}')
    })
    assert.equal(token, '')
    assert.equal(calls, 0)
  })
})
