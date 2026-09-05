import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { describe, test } from 'node:test'

import {
  getFlowStatus,
  refreshAccessToken,
  startOAuthFlow,
  YOUTUBE_OWNER_SCOPES,
  type OAuthFlowDeps,
  type OAuthTokenBundle,
} from '../lib/youtube-oauth.js'

const CLIENT_ID = 'oauth-client-id'
const CLIENT_SECRET = 'oauth-client-secret'
const AUTH_CODE = 'authorization-code-secret'
const ACCESS_TOKEN = 'access-token-secret'
const REFRESH_TOKEN = 'refresh-token-secret'
const NEXT_ACCESS_TOKEN = 'next-access-token-secret'
const CALLBACK_PORT = 43123

const EXPECTED_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const

const CHANNEL = {
  channel_id: 'channel-123',
  channel_title: 'Owner Channel',
  custom_url: '@owner-channel',
  thumbnail_url: 'https://img.example/channel.png',
}

const TOKENS: OAuthTokenBundle = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_at: 1_900_000_000_000,
  scope: `${EXPECTED_SCOPES[0]}   ${EXPECTED_SCOPES[1]}`,
}

type CallbackRequest = Parameters<NonNullable<OAuthFlowDeps['createCallbackServer']>>[0]

type PromiseOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }

const MAX_OBSERVATION_TURNS = 1_000

async function waitForPromise<T>(promise: Promise<T>, label: string): Promise<PromiseOutcome<T>> {
  let outcome: PromiseOutcome<T> | undefined
  void promise.then(
    value => { outcome = { status: 'fulfilled', value } },
    error => { outcome = { status: 'rejected', error } },
  )
  for (let turn = 0; turn < MAX_OBSERVATION_TURNS; turn += 1) {
    if (outcome) return outcome
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (outcome) return outcome
  throw new Error(`${label} did not settle within ${MAX_OBSERVATION_TURNS} event turns`)
}

function callbackServerFake() {
  let input: CallbackRequest | undefined
  let closeCalls = 0
  return {
    get input() { return input },
    get closeCalls() { return closeCalls },
    createCallbackServer: async (next: CallbackRequest) => {
      input = next
      return {
        redirect_uri: `http://${next.host}:${CALLBACK_PORT}${next.path}`,
        close: async () => { closeCalls += 1 },
      }
    },
  }
}

function makeDeps(
  fake: ReturnType<typeof callbackServerFake>,
  overrides: Partial<OAuthFlowDeps> = {},
): OAuthFlowDeps {
  return {
    createCallbackServer: fake.createCallbackServer,
    exchangeCode: async () => ({ ...TOKENS }),
    fetchPrimaryChannel: async () => ({ ...CHANNEL }),
    refreshAccessToken: async () => ({
      access_token: NEXT_ACCESS_TOKEN,
      expires_at: 1_900_000_000_000,
    }),
    ...overrides,
  }
}

async function startWith(
  overrides: Partial<OAuthFlowDeps> = {},
  options: { timeout_ms?: number } = {},
) {
  const fake = callbackServerFake()
  const flow = await startOAuthFlow({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    timeout_ms: options.timeout_ms,
    deps: makeDeps(fake, overrides),
  })
  assert.ok(fake.input, 'the callback server seam must be initialized before returning')
  return { fake, flow, callback: fake.input! }
}

function validCallback(callback: CallbackRequest, state: string, code = AUTH_CODE) {
  return callback.onRequest({
    host: callback.host,
    port: CALLBACK_PORT,
    path: callback.path,
    query: { state, code },
  })
}

function statusError(flowId: string) {
  const status = getFlowStatus(flowId)
  assert.equal(status.status, 'error')
  if (status.status !== 'error') throw new Error('expected error status')
  return status
}

describe('YouTube OAuth authorization security', () => {
  test('builds a least-privilege URL with PKCE S256 and exact aggregate scopes', async () => {
    const { flow } = await startWith()
    const params = new URL(flow.auth_url).searchParams

    assert.deepEqual(YOUTUBE_OWNER_SCOPES, EXPECTED_SCOPES)
    assert.deepEqual(params.get('scope')?.split(' '), [...EXPECTED_SCOPES])
    assert.equal(params.get('scope')?.split(' ').includes('https://www.googleapis.com/auth/youtube'), false)
    assert.equal(params.get('code_challenge_method'), 'S256')
    assert.match(params.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/)
    assert.equal(params.get('state')?.length, 32)
    assert.equal(params.get('redirect_uri'), `http://127.0.0.1:${CALLBACK_PORT}/callback`)

    flow.cancel()
    await assert.rejects(flow.promise)
  })

  test('sends the matching PKCE verifier and exact redirect to the injected exchange', async () => {
    let exchangeInput: Parameters<OAuthFlowDeps['exchangeCode']>[0] | undefined
    const { flow, callback } = await startWith({
      exchangeCode: async input => {
        exchangeInput = input
        return { ...TOKENS }
      },
    })
    const params = new URL(flow.auth_url).searchParams
    const callbackPromise = validCallback(callback, params.get('state')!)
    await callbackPromise
    await flow.promise

    assert.ok(exchangeInput)
    assert.equal(exchangeInput?.code, AUTH_CODE)
    assert.equal(exchangeInput?.redirect_uri, params.get('redirect_uri'))
    assert.equal(exchangeInput?.client_id, CLIENT_ID)
    assert.equal(exchangeInput?.client_secret, CLIENT_SECRET)
    assert.equal(createHash('sha256').update(exchangeInput?.code_verifier || '').digest('base64url'), params.get('code_challenge'))
  })

  test('rejects wrong state before processing a provider error', async () => {
    let exchangeCalls = 0
    const { flow, callback } = await startWith({
      exchangeCode: async () => {
        exchangeCalls += 1
        return { ...TOKENS }
      },
    })
    const html = await callback.onRequest({
      host: callback.host,
      port: CALLBACK_PORT,
      path: callback.path,
      query: { state: 'wrong-state', error: 'access_denied', code: AUTH_CODE },
    })
    const status = statusError(flow.flow_id)

    assert.equal(exchangeCalls, 0)
    assert.equal(status.error_code, 'YOUTUBE_OAUTH_STATE_MISMATCH')
    assert.equal(status.error, 'The OAuth security state did not match. Please start again.')
    assert.doesNotMatch(html, /wrong-state|access_denied|authorization-code-secret|oauth-client-secret/)
    await assert.rejects(flow.promise, /The OAuth security state did not match/)
  })

  test('rejects every callback whose host, port, or path differs from the initiating redirect', async () => {
    for (const [label, request] of [
      ['host', { host: 'localhost', port: CALLBACK_PORT, path: '/callback' }],
      ['port', { host: '127.0.0.1', port: CALLBACK_PORT + 1, path: '/callback' }],
      ['path', { host: '127.0.0.1', port: CALLBACK_PORT, path: '/wrong' }],
    ] as const) {
      let exchangeCalls = 0
      const { flow, callback } = await startWith({
        exchangeCode: async () => {
          exchangeCalls += 1
          return { ...TOKENS }
        },
      })
      const state = new URL(flow.auth_url).searchParams.get('state')!
      const html = await callback.onRequest({ ...request, query: { state, code: AUTH_CODE } })
      const status = statusError(flow.flow_id)
      assert.equal(exchangeCalls, 0, `${label} mismatch must fail before exchange`)
      assert.equal(status.error_code, 'YOUTUBE_OAUTH_REDIRECT_MISMATCH', `${label} mismatch code`)
      assert.doesNotMatch(html, /authorization-code-secret|oauth-client-secret/)
      await assert.rejects(flow.promise, /OAuth redirect did not match/)
    }
  })

  test('atomically claims a callback so duplicate callbacks cannot exchange twice', async () => {
    let exchangeCalls = 0
    let releaseExchange!: () => void
    const exchangeStarted = new Promise<void>(resolve => { releaseExchange = resolve })
    const { flow, callback } = await startWith({
      exchangeCode: async () => {
        exchangeCalls += 1
        await exchangeStarted
        return { ...TOKENS }
      },
    })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    const first = validCallback(callback, state)
    await Promise.resolve()
    const second = await validCallback(callback, state)

    assert.equal(exchangeCalls, 1)
    assert.match(second, /no longer available|already handled/i)
    releaseExchange()
    await first
    await flow.promise
  })

  test('treats a duplicate with a different redirect as harmless after the callback is claimed', async () => {
    let releaseExchange!: () => void
    const exchangeStarted = new Promise<void>(resolve => { releaseExchange = resolve })
    let exchangeCalls = 0
    const { flow, callback } = await startWith({
      exchangeCode: async () => {
        exchangeCalls += 1
        await exchangeStarted
        return { ...TOKENS }
      },
    })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    const first = validCallback(callback, state)
    await Promise.resolve()
    const duplicate = await callback.onRequest({
      host: 'localhost',
      port: CALLBACK_PORT + 1,
      path: '/wrong',
      query: { state, code: AUTH_CODE },
    })

    assert.equal(exchangeCalls, 1)
    assert.match(duplicate, /no longer available|already handled/i)
    releaseExchange()
    await first
    await flow.promise
    assert.equal(getFlowStatus(flow.flow_id).status, 'success')
  })

  test('cancel closes the callback server and makes later callbacks harmless', async () => {
    let exchangeCalls = 0
    const { fake, flow, callback } = await startWith({
      exchangeCode: async () => {
        exchangeCalls += 1
        return { ...TOKENS }
      },
    })
    const rejected = assert.rejects(flow.promise, /OAuth flow was cancelled/)
    flow.cancel()
    const status = statusError(flow.flow_id)
    const html = await validCallback(callback, new URL(flow.auth_url).searchParams.get('state')!)

    assert.equal(status.error_code, 'YOUTUBE_OAUTH_CANCELLED')
    assert.equal(status.error, 'The OAuth flow was cancelled. Please try again.')
    assert.equal(fake.closeCalls, 1)
    assert.equal(exchangeCalls, 0)
    assert.doesNotMatch(html, /authorization-code-secret|oauth-client-secret|refresh-token-secret/)
    await rejected
  })

  test('timeout closes the callback server, records a safe error, and blocks later callbacks', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let exchangeCalls = 0
    const { fake, flow, callback } = await startWith({
      exchangeCode: async () => {
        exchangeCalls += 1
        return { ...TOKENS }
      },
    }, { timeout_ms: 10 })
    const rejected = assert.rejects(flow.promise, /OAuth flow timed out/)
    t.mock.timers.tick(10)
    const status = statusError(flow.flow_id)
    const html = await validCallback(callback, new URL(flow.auth_url).searchParams.get('state')!)

    assert.equal(status.error_code, 'YOUTUBE_OAUTH_TIMEOUT')
    assert.equal(status.error, 'The OAuth flow timed out. Please start again.')
    assert.equal(fake.closeCalls, 1)
    assert.equal(exchangeCalls, 0)
    assert.doesNotMatch(html, /authorization-code-secret|oauth-client-secret|refresh-token-secret/)
    await rejected
  })

  test('maps provider rejection and unavailable errors to fixed redacted public status and HTML', async () => {
    for (const [providerError, expectedCode, expectedMessage] of [
      [Object.assign(new Error(`raw-body-${ACCESS_TOKEN}-${CLIENT_SECRET}`), { code: 'invalid_grant', status: 400 }), 'YOUTUBE_OAUTH_PROVIDER_REJECTED', 'YouTube rejected the authorization request. Please try again.'],
      [Object.assign(new Error(`raw-body-${ACCESS_TOKEN}-${CLIENT_SECRET}`), { status: 503 }), 'YOUTUBE_OAUTH_UNAVAILABLE', 'YouTube is unavailable right now. Please try again.'],
      [Object.assign(new Error(`raw-body-${ACCESS_TOKEN}-${CLIENT_SECRET}`), { code: 'invalid_grant', status: 503 }), 'YOUTUBE_OAUTH_UNAVAILABLE', 'YouTube is unavailable right now. Please try again.'],
    ] as const) {
      const { flow, callback } = await startWith({
        exchangeCode: async () => { throw providerError },
      })
      const state = new URL(flow.auth_url).searchParams.get('state')!
      const html = await validCallback(callback, state)
      const status = statusError(flow.flow_id)

      assert.equal(status.error_code, expectedCode)
      assert.equal(status.error, expectedMessage)
      assert.doesNotMatch(JSON.stringify(status), /raw-body|access-token-secret|oauth-client-secret|authorization-code-secret/)
      assert.doesNotMatch(html, /raw-body|access-token-secret|oauth-client-secret|authorization-code-secret/)
      await assert.rejects(flow.promise, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })

  test('maps a transport TypeError to unavailable without exposing its message', async () => {
    const { flow, callback } = await startWith({
      exchangeCode: async () => { throw new TypeError(`network-${ACCESS_TOKEN}-${CLIENT_SECRET}`) },
    })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    const html = await validCallback(callback, state)
    const status = statusError(flow.flow_id)

    assert.equal(status.error_code, 'YOUTUBE_OAUTH_UNAVAILABLE')
    assert.equal(status.error, 'YouTube is unavailable right now. Please try again.')
    assert.doesNotMatch(JSON.stringify(status), /network|access-token-secret|oauth-client-secret/)
    assert.doesNotMatch(html, /network|access-token-secret|oauth-client-secret/)
    await assert.rejects(flow.promise, /YouTube is unavailable right now/)
  })

  test('maps a generic network transport failure to unavailable', async () => {
    const { flow, callback } = await startWith({
      exchangeCode: async () => { throw new Error(`network request failed: ${ACCESS_TOKEN}`) },
    })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    await validCallback(callback, state)
    const status = statusError(flow.flow_id)

    assert.equal(status.error_code, 'YOUTUBE_OAUTH_UNAVAILABLE')
    assert.equal(status.error, 'YouTube is unavailable right now. Please try again.')
    await assert.rejects(flow.promise, /YouTube is unavailable right now/)
  })

  test('maps access_denied to a safe cancellation status without echoing the provider value', async () => {
    const { flow, callback } = await startWith()
    const state = new URL(flow.auth_url).searchParams.get('state')!
    const html = await callback.onRequest({
      host: callback.host,
      port: CALLBACK_PORT,
      path: callback.path,
      query: { state, error: 'access_denied', error_description: 'secret-provider-description' },
    })
    const status = statusError(flow.flow_id)

    assert.equal(status.error_code, 'YOUTUBE_OAUTH_CANCELLED')
    assert.equal(status.error, 'The OAuth flow was cancelled. Please try again.')
    assert.doesNotMatch(html, /access_denied|secret-provider-description|oauth-client-secret/)
    await assert.rejects(flow.promise, /OAuth flow was cancelled/)
  })

  test('returns token-free legacy-compatible pending, success, and unknown statuses', async () => {
    const { flow, callback } = await startWith()
    assert.deepEqual(getFlowStatus(flow.flow_id), { status: 'pending', flow_id: flow.flow_id })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    await validCallback(callback, state)
    await flow.promise

    const success = getFlowStatus(flow.flow_id)
    assert.deepEqual(success, {
      status: 'success',
      flow_id: flow.flow_id,
      result: {
        channel: CHANNEL,
        granted_scopes: [EXPECTED_SCOPES[0], EXPECTED_SCOPES[1]],
      },
    })
    assert.equal('tokens' in success, false)
    assert.doesNotMatch(JSON.stringify(success), /access-token-secret|refresh-token-secret|oauth-client-secret|authorization-code-secret/)

    const routeShaped = success
    if (routeShaped.status === 'success') {
      assert.equal(routeShaped.result.channel.channel_id, CHANNEL.channel_id)
    }
    const unknown = getFlowStatus('missing-flow-id')
    assert.deepEqual(unknown, {
      status: 'unknown',
      flow_id: 'missing-flow-id',
      error: 'This OAuth flow is no longer available. Start again.',
      error_code: 'YOUTUBE_OAUTH_FLOW_UNKNOWN',
    })
  })

  test('retains terminal state only through the injected clock and then returns safe unknown', async () => {
    let current = new Date('2026-09-01T00:00:00.000Z')
    const { flow, callback } = await startWith({
      now: () => current,
    })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    await validCallback(callback, state)
    await flow.promise
    assert.equal(getFlowStatus(flow.flow_id).status, 'success')

    current = new Date(current.getTime() + 5 * 60 * 1000 + 1)
    assert.deepEqual(getFlowStatus(flow.flow_id), {
      status: 'unknown',
      flow_id: flow.flow_id,
      error: 'This OAuth flow is no longer available. Start again.',
      error_code: 'YOUTUBE_OAUTH_FLOW_UNKNOWN',
    })
  })

  test('refresh carries forward omitted refresh token and prior scope, but normalizes provider scope when present', async () => {
    const calls: Array<Record<string, string>> = []
    const retained = await refreshAccessToken({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      previous_scope: 'prior.scope  other.scope',
      transport: async input => {
        calls.push(input)
        return { access_token: NEXT_ACCESS_TOKEN, expires_at: 1_900_000_000_000 }
      },
    })
    assert.deepEqual(calls, [{
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }])
    assert.deepEqual(retained, {
      access_token: NEXT_ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_at: 1_900_000_000_000,
      scope: 'prior.scope  other.scope',
    })

    const narrowed = await refreshAccessToken({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      previous_scope: EXPECTED_SCOPES.join(' '),
      transport: async () => ({
        access_token: NEXT_ACCESS_TOKEN,
        refresh_token: 'provider-refresh-token',
        expires_at: 1_900_000_000_000,
        scope: ` ${EXPECTED_SCOPES[0]}   ${EXPECTED_SCOPES[1]} `,
      }),
    })
    assert.deepEqual(narrowed, {
      access_token: NEXT_ACCESS_TOKEN,
      refresh_token: 'provider-refresh-token',
      expires_at: 1_900_000_000_000,
      scope: `${EXPECTED_SCOPES[0]} ${EXPECTED_SCOPES[1]}`,
    })
  })

  test('does not invent scope when both the prior grant and provider response omit it', async () => {
    const result = await refreshAccessToken({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      transport: async () => ({ access_token: NEXT_ACCESS_TOKEN, expires_at: 1_900_000_000_000 }),
    })
    assert.deepEqual(result, {
      access_token: NEXT_ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_at: 1_900_000_000_000,
    })
  })

  test('returns an observable flow state when the optional opener rejects', async () => {
    const fake = callbackServerFake()
    const flow = await startOAuthFlow({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      deps: makeDeps(fake, {
        openExternal: async () => {
          throw new Error(`opener leaked ${CLIENT_SECRET}`)
        },
      }),
    })

    await new Promise<void>(resolve => setImmediate(resolve))
    const status = statusError(flow.flow_id)
    assert.equal(status.error_code, 'YOUTUBE_OAUTH_UNAVAILABLE')
    assert.equal(status.error, 'YouTube is unavailable right now. Please try again.')
    assert.equal(fake.closeCalls, 1)
    await assert.rejects(flow.promise, /YouTube is unavailable right now/)
  })

  test('does not block returning the flow state when the optional opener hangs', async () => {
    const fake = callbackServerFake()
    const result = await Promise.race([
      startOAuthFlow({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        timeout_ms: 1_000,
        deps: makeDeps(fake, { openExternal: async () => new Promise<void>(() => {}) }),
      }),
      new Promise<'timed_out'>(resolve => setImmediate(() => resolve('timed_out'))),
    ])

    if (result === 'timed_out') throw new Error('startOAuthFlow remained blocked on the opener')
    result.cancel()
    await assert.rejects(result.promise, /OAuth flow was cancelled/)
    assert.equal(getFlowStatus(result.flow_id).status, 'error')
    assert.equal(fake.closeCalls, 1)
  })

  test('timeout races a hung exchange and resolves an injected callback with fixed safe HTML', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let releaseExchange!: () => void
    let exchangeStarted!: () => void
    const exchangeRelease = new Promise<void>(resolve => { releaseExchange = resolve })
    const exchangeStartedPromise = new Promise<void>(resolve => { exchangeStarted = resolve })
    const { fake, flow, callback } = await startWith({
      exchangeCode: async () => {
        exchangeStarted()
        await exchangeRelease
        return { ...TOKENS }
      },
    }, { timeout_ms: 10 })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    const callbackPromise = validCallback(callback, state)

    try {
      const exchangeStart = await waitForPromise(exchangeStartedPromise, 'OAuth exchange start')
      assert.equal(exchangeStart.status, 'fulfilled')
      t.mock.timers.tick(10)
      await assert.rejects(flow.promise, /OAuth flow timed out/)
      const response = await waitForPromise(callbackPromise, 'timed-out OAuth callback response')
      assert.equal(response.status, 'fulfilled')
      if (response.status !== 'fulfilled') throw new Error('timed-out OAuth callback did not return a response')
      const html = response.value
      assert.match(html, /The OAuth flow timed out\. Please start again\./)
      assert.doesNotMatch(html, /authorization-code-secret|oauth-client-secret|refresh-token-secret/)
      assert.equal(fake.closeCalls, 1)
    } finally {
      t.mock.timers.tick(10)
      releaseExchange()
      await waitForPromise(callbackPromise, 'timed-out OAuth callback response').catch(() => {})
    }
  })

  test('cancel races a hung channel lookup and resolves an injected callback with fixed safe HTML', async () => {
    let releaseChannel!: () => void
    let channelStarted!: () => void
    const channelReady = new Promise<void>(resolve => { channelStarted = resolve })
    const { fake, flow, callback } = await startWith({
      fetchPrimaryChannel: async () => {
        channelStarted()
        await new Promise<void>(resolve => { releaseChannel = resolve })
        return { ...CHANNEL }
      },
    }, { timeout_ms: 1_000 })
    const state = new URL(flow.auth_url).searchParams.get('state')!
    const callbackPromise = validCallback(callback, state)
    await channelReady

    flow.cancel()
    await assert.rejects(flow.promise, /OAuth flow was cancelled/)
    const html = await Promise.race([
      callbackPromise,
      new Promise<'still-pending'>(resolve => setImmediate(() => resolve('still-pending'))),
    ])
    try {
      assert.notEqual(html, 'still-pending', 'claimed callback must terminate after cancellation')
      assert.match(html, /The OAuth flow was cancelled\. Please try again\./)
      assert.doesNotMatch(html, /authorization-code-secret|oauth-client-secret|refresh-token-secret/)
      assert.equal(fake.closeCalls, 1)
    } finally {
      releaseChannel()
      await callbackPromise
    }
  })

  test('default loopback HTTP callback responds after timeout while exchange is hung', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let releaseExchange!: () => void
    let exchangeStarted!: () => void
    const exchangeRelease = new Promise<void>(resolve => { releaseExchange = resolve })
    const exchangeStartedPromise = new Promise<void>(resolve => { exchangeStarted = resolve })
    const flow = await startOAuthFlow({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      timeout_ms: 20,
      deps: {
        exchangeCode: async () => {
          exchangeStarted()
          await exchangeRelease
          return { ...TOKENS }
        },
        fetchPrimaryChannel: async () => ({ ...CHANNEL }),
        refreshAccessToken: async () => ({
          access_token: NEXT_ACCESS_TOKEN,
          expires_at: 1_900_000_000_000,
        }),
      },
    })
    const params = new URL(flow.auth_url).searchParams
    const callbackUrl = new URL(params.get('redirect_uri')!)
    callbackUrl.searchParams.set('state', params.get('state')!)
    callbackUrl.searchParams.set('code', AUTH_CODE)
    const httpResponse = new Promise<string>((resolve, reject) => {
      const request = http.get(callbackUrl, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve(body))
      })
      request.on('error', reject)
    })

    try {
      const exchangeStart = await waitForPromise(exchangeStartedPromise, 'default OAuth exchange start')
      assert.equal(exchangeStart.status, 'fulfilled')
      t.mock.timers.tick(20)
      await assert.rejects(flow.promise, /OAuth flow timed out/)
      const response = await waitForPromise(httpResponse, 'default loopback HTTP callback response')
      assert.equal(response.status, 'fulfilled')
      if (response.status !== 'fulfilled') throw new Error('default loopback HTTP callback did not return a response')
      const html = response.value
      assert.match(html, /The OAuth flow timed out\. Please start again\./)
      assert.doesNotMatch(html, /authorization-code-secret|oauth-client-secret|refresh-token-secret/)
    } finally {
      t.mock.timers.tick(20)
      releaseExchange()
      await waitForPromise(flow.promise, 'timed-out OAuth flow cleanup').catch(() => {})
      await waitForPromise(httpResponse, 'default loopback HTTP callback cleanup').catch(() => {})
    }
  })

  test('uses an injected opener only as a test seam and never requires it for URL-returning production behavior', async () => {
    const opened: string[] = []
    const { fake, flow } = await startWith({
      openExternal: async url => { opened.push(url) },
    })
    assert.deepEqual(opened, [flow.auth_url])
    flow.cancel()
    await assert.rejects(flow.promise)
    assert.equal(fake.closeCalls, 1)
  })

  test('redacts callback-server setup failures before they reach the caller', async () => {
    const deps = makeDeps(callbackServerFake(), {
      createCallbackServer: async () => {
        throw new Error(`callback setup leaked ${CLIENT_SECRET}`)
      },
    })
    await assert.rejects(
      startOAuthFlow({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, deps }),
      error => {
        assert.equal((error as Error).message, 'YouTube is unavailable right now. Please try again.')
        assert.doesNotMatch((error as Error).message, new RegExp(CLIENT_SECRET))
        return true
      },
    )
  })

  test('maps an invalid callback-server redirect through unavailable cleanup', async () => {
    let closeCalls = 0
    const deps = makeDeps(callbackServerFake(), {
      createCallbackServer: async () => ({
        redirect_uri: 'not-a-valid-redirect',
        close: async () => { closeCalls += 1 },
      }),
    })

    await assert.rejects(
      startOAuthFlow({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, deps }),
      error => {
        assert.equal((error as Error).message, 'YouTube is unavailable right now. Please try again.')
        return true
      },
    )
    assert.equal(closeCalls, 1)
  })
})
