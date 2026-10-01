/**
 * `redactSecrets` skips its eight regex scans for text that cannot match any of them.
 *
 * Job records carry hundreds of log lines each, and every one of them went through all eight scans on
 * every write and every snapshot (4.7 us per line; 0.6-2.5 s for a project's 800 jobs). The skip is a
 * substring pre-test, so what matters is that it never lets a real secret through: every pattern
 * family has a positive case below, in each casing the pattern allows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSensitiveFieldName, redactSecrets, redactSensitiveValue } from '../lib/redact-secrets.js'

const MUST_CHANGE: Array<[string, string]> = [
  ['bearer header', 'Authorization failed: Bearer abcdefgh12345678'],
  ['Key scheme', 'header was Key abcdefgh12345678'],
  ['sk token', 'rejected sk-abcdefgh12345678'],
  ['gsk token, upper case', 'rejected GSK_abcdefgh12345678'],
  ['authorization field', 'authorization: abcd1234'],
  ['api_key json', '{"api_key":"abcd1234"}'],
  ['apikey equals', 'apikey=abcd1234'],
  ['access_token', "access_token: 'abcd1234'"],
  ['refresh-token', 'refresh-token = abcd1234'],
  ['session_secret', 'session_secret=abcd1234'],
  ['client secret', 'client-secret: abcd1234'],
  ['password', 'password: hunter22'],
  ['passphrase', 'passphrase=hunter22'],
  ['bot token', 'bot_token=123456:abcdef'],
  ['hub token', 'hub-token: abcd1234'],
  ['genstudio api key', 'genstudio_api_key=abcd1234'],
  ['query string key', 'GET /v1/x?key=abcd1234&n=1'],
  ['query string token', 'GET /v1/x?n=1&token=abcd1234'],
  ['query string secret', 'GET /v1/x?secret=abcd1234'],
  ['url credentials', 'fetching https://user:pass@example.com/path'],
]

test('every pattern family still redacts through the fast-path test', () => {
  for (const [label, text] of MUST_CHANGE) {
    const out = redactSecrets(text)
    assert.notEqual(out, text, `${label}: nothing was redacted`)
    assert.ok(out.includes('[REDACTED]'), `${label}: no marker in ${out}`)
  }
})

test('an ordinary job log line is returned untouched', () => {
  const lines = [
    '  ✓ Scene 12: saved EP0001_Scene12_v1.png (3.2 MB) in 12.3s via job_abc123',
    'Stitching (no crossfades)…',
    'Waiting for a free Mac — next try 14:05',
  ]
  for (const line of lines) assert.equal(redactSecrets(line), line)
})

test('field-name checks are stable across repeated and unbounded names', () => {
  assert.equal(isSensitiveFieldName('api_key'), true)
  assert.equal(isSensitiveFieldName('apiKey'), true)
  assert.equal(isSensitiveFieldName('genstudioApiKey'), true)
  assert.equal(isSensitiveFieldName('title'), false)
  for (let i = 0; i < 5_000; i++) assert.equal(isSensitiveFieldName(`scene-${i}`), false)
  assert.equal(isSensitiveFieldName('api_key'), true, 'a cleared cache answers the same')
  assert.deepEqual(redactSensitiveValue({ title: 'x', api_key: 'abc', nested: { password: 'p', list: ['Bearer abcdefgh12345678'] } }), {
    title: 'x', api_key: '[REDACTED]', nested: { password: '[REDACTED]', list: ['Bearer [REDACTED]'] },
  })
})
