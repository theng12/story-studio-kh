/**
 * Pin-down tests for the API-key scrubber that wraps every provider error
 * before it reaches the renderer / job-queue output / `logs/*.log`.
 *
 * Background: Session 06 / finding #9 (H2) re-confirmed that every adapter
 * slices an upstream response body into `throw new Error(...)`. If kie/fal/
 * genaipro ever echo the submitted Authorization header in a 4xx body, the
 * key would land in plaintext in the support-bundle log file the operator
 * mails between machines. `redactSecrets` is the single sanitisation seam
 * for that path, so the contract here is load-bearing.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  redactSecrets,
  redactSensitiveValue,
  registerSecretForRedaction,
} from '../lib/redact-secrets.js'

describe('redactSecrets()', () => {
  test('removes the exact secret from a Bearer-style header echo', () => {
    const out = redactSecrets('header: Bearer sk-abc123\ndetail=foo', 'sk-abc123')
    assert.ok(!out.includes('sk-abc123'),
      'the exact secret must not appear in the redacted output')
    assert.match(out, /\[REDACTED\]/, 'must mark redactions so logs are still readable')
  })

  test('skips undefined / null / empty secrets without throwing', () => {
    const out = redactSecrets('plain text', undefined, null, '')
    assert.equal(out, 'plain text', 'no-op when no secrets are passed')
  })

  test('redacts case variants of the secret', () => {
    const lower = redactSecrets('Got Sk-Abcdef-123 in body', 'SK-ABCDEF-123')
    assert.ok(!/sk-abcdef-123/i.test(lower),
      'a lowercased echo of the key must also be scrubbed')
  })

  test('defensive Bearer-token mask redacts unknown tokens too', () => {
    // Caller forgot to pass the secret — defensive pattern still kicks in.
    const out = redactSecrets('Authorization: Bearer eyJabc.def.ghi-jkl', undefined)
    assert.ok(!out.includes('eyJabc.def.ghi-jkl'),
      'Bearer-token pattern must scrub even when the caller didn\'t thread the secret in')
    assert.match(out, /Bearer \[REDACTED\]/)
  })

  test('defensive sk-* mask redacts standalone OpenAI-style tokens', () => {
    const out = redactSecrets('error: invalid key sk-proj-XYZ123abc456 detected')
    assert.ok(!out.includes('sk-proj-XYZ123abc456'))
    assert.match(out, /\[REDACTED\]/)
  })

  test('redacts every occurrence, not just the first', () => {
    const out = redactSecrets('first: KEY1 second: KEY1 third: KEY1', 'KEY1')
    assert.equal((out.match(/\[REDACTED\]/g) || []).length, 3)
    assert.ok(!out.includes('KEY1'))
  })

  test('handles empty input', () => {
    assert.equal(redactSecrets('', 'sk-abc'), '')
  })

  test('preserves surrounding diagnostic context so the error stays useful', () => {
    const out = redactSecrets(
      'kie.ai poll: 401 Unauthorized — {"error":"bad key sk-abc123"}',
      'sk-abc123',
    )
    assert.ok(out.includes('401 Unauthorized'),
      'status code context must survive redaction')
    assert.ok(out.includes('"error":"bad key'),
      'JSON envelope context must survive redaction')
    assert.ok(!out.includes('sk-abc123'))
  })

  test('redacts GenStudio scoped keys before the secrets store has loaded', () => {
    const out = redactSecrets('GenStudio rejected gsk_test_ThisMustNeverReachTheRenderer123')
    assert.ok(!out.includes('gsk_test_ThisMustNeverReachTheRenderer123'))
    assert.match(out, /\[REDACTED\]/)
  })

  test('registered arbitrary credentials are removed from later crash text', () => {
    const opaque = 'opaque-production-credential-with-no-provider-prefix'
    registerSecretForRedaction(opaque)
    const out = redactSecrets(`socket failed while using ${opaque}`)
    assert.ok(!out.includes(opaque))
  })

  test('removes secrets from credential-bearing URLs and query strings', () => {
    const out = redactSecrets(
      'https://user:password@example.com/v1?api_key=abc12345&token=xyz98765',
    )
    assert.ok(!out.includes('user:password'))
    assert.ok(!out.includes('abc12345'))
    assert.ok(!out.includes('xyz98765'))
  })

  test('deep redaction protects persisted job diagnostics and renderer payloads', () => {
    const safe = redactSensitiveValue({
      params: {
        model: 'genstudio-chat-model',
        genstudio_api_key: 'should-not-persist',
        nested: { Authorization: 'Bearer secret-value-1234' },
      },
      output_lines: ['request api_key=another-secret-value'],
    })
    const serialized = JSON.stringify(safe)
    assert.ok(!serialized.includes('should-not-persist'))
    assert.ok(!serialized.includes('secret-value-1234'))
    assert.ok(!serialized.includes('another-secret-value'))
    assert.ok(serialized.includes('genstudio-chat-model'))
  })
})
