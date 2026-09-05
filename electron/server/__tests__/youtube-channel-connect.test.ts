import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import {
  appSecretsPath,
} from '../services/app-secrets-store.js'
import {
  configureYouTubeApplication,
  readYouTubeChannelTokensForServer,
  readYouTubeConnectionRegistry,
  youtubeConnectionsPath,
} from '../services/youtube-connection-store.js'
import {
  readYouTubeChannelConnectStatus,
  startYouTubeChannelConnect,
} from '../services/youtube-channel-connect.js'
import { YOUTUBE_OAUTH_TERMINAL_RETENTION_MS, YOUTUBE_OWNER_SCOPES } from '../lib/youtube-oauth.js'
import type { OAuthFlowDeps } from '../lib/youtube-oauth.js'
import { waitForValue } from './_timing.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const CLIENT_ID = 'youtube-connect-client-id'
const CLIENT_SECRET = 'youtube-connect-client-secret-value'
const ACCESS_TOKEN = 'youtube-connect-access-token-value'
const REFRESH_TOKEN = 'youtube-connect-refresh-token-value'

async function isolate(): Promise<void> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await configureYouTubeApplication({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
}

/**
 * A provider-free OAuth seam. The callback server is a local stub, so nothing
 * binds a port and no request leaves the process.
 */
function fakeDeps(input: {
  channel_id: string
  channel_title?: string
  scope?: string | null
  exchangeFails?: boolean
}): { deps: OAuthFlowDeps; callback: (state: string) => Promise<string> } {
  let fire: ((state: string) => Promise<string>) | undefined
  const deps: OAuthFlowDeps = {
    async exchangeCode() {
      if (input.exchangeFails) throw Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' })
      return {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_at: Date.now() + 3_600_000,
        ...(input.scope === null ? {} : { scope: input.scope ?? YOUTUBE_OWNER_SCOPES.join(' ') }),
      }
    },
    async fetchPrimaryChannel() {
      return { channel_id: input.channel_id, channel_title: input.channel_title ?? input.channel_id }
    },
    async refreshAccessToken() {
      return { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: Date.now() + 3_600_000 }
    },
    async createCallbackServer({ host, path: callbackPath, onRequest }) {
      const redirect_uri = `http://${host}:47999${callbackPath}`
      fire = async (state: string) => onRequest({
        host,
        port: 47999,
        path: callbackPath,
        query: { code: 'authorization-code', state },
      })
      return { close: async () => {}, redirect_uri }
    },
  }
  return {
    deps,
    callback: async (state: string) => {
      if (!fire) throw new Error('callback server was never created')
      return fire(state)
    },
  }
}

/** Pull the `state` the flow generated straight out of the authorization URL. */
function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get('state')!
}

describe('youtube channel connect', () => {
  test('returns a least-privilege PKCE authorization url without opening a browser', async () => {
    await isolate()
    const fake = fakeDeps({ channel_id: 'channel-connect-url' })
    const started = await startYouTubeChannelConnect({ deps: fake.deps })

    const url = new URL(started.auth_url)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('scope'), YOUTUBE_OWNER_SCOPES.join(' '))
    assert.match(url.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\//)
    assert.equal(typeof started.flow_id, 'string')
    assert.equal(started.auth_url.includes(CLIENT_SECRET), false)

    assert.equal((await readYouTubeChannelConnectStatus(started.flow_id)).status, 'pending')
  })

  test('saves the grant before reporting success', async () => {
    await isolate()
    const fake = fakeDeps({ channel_id: 'channel-connect-saved', channel_title: 'Saved Channel' })
    const started = await startYouTubeChannelConnect({ deps: fake.deps })
    await fake.callback(stateOf(started.auth_url))

    const status = await waitForValue(async () => {
      const current = await readYouTubeChannelConnectStatus(started.flow_id)
      return current.status === 'pending' ? undefined : current
    }, { label: 'connect status' })

    assert.equal(status.status, 'success')
    // The saved grant is readable the moment success is reported.
    const registry = await readYouTubeConnectionRegistry()
    assert.equal(registry.channels['channel-connect-saved']?.title, 'Saved Channel')
    assert.equal(registry.channels['channel-connect-saved']?.status, 'connected')
    assert.equal(typeof registry.channels['channel-connect-saved']?.last_refresh_at, 'string')
    assert.notEqual(await readYouTubeChannelTokensForServer('channel-connect-saved'), null)

    const serialized = JSON.stringify(status)
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, 'authorization-code']) {
      assert.equal(serialized.includes(secret), false, `${secret} must not reach the connect status`)
    }
  })

  test('marks a partial grant as needing a scope upgrade, and never persists it as connected first', async () => {
    await isolate()
    const fake = fakeDeps({
      channel_id: 'channel-connect-partial',
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    })

    // Watch every durable state the registry passes through. A partial grant
    // that is ever written as `connected` — even for one write — is a record
    // claiming permission it does not have, and a crash in that window would
    // make it permanent.
    const seen: string[] = []
    const registryPath = youtubeConnectionsPath()
    const mutableFs = fs as typeof fs & { rename: typeof fs.rename }
    const originalRename = mutableFs.rename
    mutableFs.rename = async (from, to) => {
      const result = await originalRename(from, to)
      if (to === registryPath) {
        const written = JSON.parse(await fs.readFile(registryPath, 'utf8'))
        const status = written.channels?.['channel-connect-partial']?.status
        if (status) seen.push(status)
      }
      return result
    }

    try {
      const started = await startYouTubeChannelConnect({ deps: fake.deps })
      await fake.callback(stateOf(started.auth_url))
      const status = await waitForValue(async () => {
        const current = await readYouTubeChannelConnectStatus(started.flow_id)
        return current.status === 'pending' ? undefined : current
      }, { label: 'partial scope status' })
      assert.equal(status.status === 'success' && status.scope_upgrade_required, true)
    } finally {
      mutableFs.rename = originalRename
    }

    const registry = await readYouTubeConnectionRegistry()
    assert.equal(registry.channels['channel-connect-partial']?.status, 'scope_upgrade_required')
    assert.deepEqual(seen, ['scope_upgrade_required'], 'exactly one durable write, never `connected`')
  })

  test('a terminal success stays readable while the flow is still retained', async () => {
    await isolate()
    const fake = fakeDeps({ channel_id: 'channel-connect-reread', channel_title: 'Reread' })
    const started = await startYouTubeChannelConnect({ deps: fake.deps })
    await fake.callback(stateOf(started.auth_url))

    const first = await waitForValue(async () => {
      const current = await readYouTubeChannelConnectStatus(started.flow_id)
      return current.status === 'pending' ? undefined : current
    }, { label: 'first terminal read' })
    assert.equal(first.status, 'success')

    // A second tab, or a retried request for the same idempotent GET, must not
    // be told the connection it just made never happened.
    const second = await readYouTubeChannelConnectStatus(started.flow_id)
    assert.equal(second.status, 'success')
    assert.deepEqual(second, first)
  })

  test('purges the saved terminal result at the OAuth retention boundary', async () => {
    await isolate()
    const originalSetTimeout = globalThis.setTimeout
    const retentionCallbacks: Array<() => void> = []
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === YOUTUBE_OAUTH_TERMINAL_RETENTION_MS) {
        retentionCallbacks.push(() => callback(...args))
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      }
      return originalSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout
    try {
      const fake = fakeDeps({ channel_id: 'channel-connect-purged', channel_title: 'Purged' })
      const started = await startYouTubeChannelConnect({ timeout_ms: 1_000, deps: fake.deps })
      await fake.callback(stateOf(started.auth_url))
      const first = await waitForValue(async () => {
        const current = await readYouTubeChannelConnectStatus(started.flow_id)
        return current.status === 'pending' ? undefined : current
      }, { label: 'terminal status before purge' })
      assert.equal(first.status, 'success')
      assert.equal(retentionCallbacks.length, 2, 'OAuth and its save wrapper share one retention boundary')

      // OAuth registers its retention callback first. Fire only the wrapper's
      // callback so this assertion proves its own map entry was removed.
      retentionCallbacks[1]!()
      assert.equal((await readYouTubeChannelConnectStatus(started.flow_id)).status, 'unknown')
      retentionCallbacks[0]!()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('refuses a reconnect that authorizes a different channel and saves nothing', async () => {
    await isolate()
    const fake = fakeDeps({ channel_id: 'channel-actually-authorized' })
    const started = await startYouTubeChannelConnect({
      expected_channel_id: 'channel-expected',
      deps: fake.deps,
    })
    await fake.callback(stateOf(started.auth_url))

    const status = await waitForValue(async () => {
      const current = await readYouTubeChannelConnectStatus(started.flow_id)
      return current.status === 'pending' ? undefined : current
    }, { label: 'mismatch status' })

    assert.equal(status.status, 'error')
    assert.equal(status.status === 'error' && status.error_code, 'YOUTUBE_CHANNEL_MISMATCH')
    const registry = await readYouTubeConnectionRegistry()
    assert.deepEqual(Object.keys(registry.channels), [])
    assert.equal(await readYouTubeChannelTokensForServer('channel-actually-authorized'), null)
  })

  test('refuses an app-A grant after the owner replaces the application with app B', async () => {
    await isolate()
    const fake = fakeDeps({ channel_id: 'channel-stale-flow' })
    const started = await startYouTubeChannelConnect({ deps: fake.deps })

    await configureYouTubeApplication({
      client_id: 'youtube-connect-client-id-replacement',
      client_secret: 'youtube-connect-client-secret-replacement',
    })
    const registryBeforeCallback = await fs.readFile(youtubeConnectionsPath())
    const secretsBeforeCallback = await fs.readFile(appSecretsPath())

    await fake.callback(stateOf(started.auth_url))
    const status = await waitForValue(async () => {
      const current = await readYouTubeChannelConnectStatus(started.flow_id)
      return current.status === 'pending' ? undefined : current
    }, { label: 'stale application connect status' })

    assert.equal(status.status, 'error')
    assert.equal(status.status === 'error' && status.error_code, 'YOUTUBE_APPLICATION_CHANGED')
    assert.match(status.status === 'error' ? status.error : '', /application changed|start.*again/i)
    assert.deepEqual(await fs.readFile(youtubeConnectionsPath()), registryBeforeCallback)
    assert.deepEqual(await fs.readFile(appSecretsPath()), secretsBeforeCallback)
    assert.equal(await readYouTubeChannelTokensForServer('channel-stale-flow'), null)
  })

  test('maps a provider rejection to a stable code and leaks no provider text', async () => {
    await isolate()
    const fake = fakeDeps({ channel_id: 'channel-rejected', exchangeFails: true })
    const started = await startYouTubeChannelConnect({ deps: fake.deps })
    await fake.callback(stateOf(started.auth_url))

    const status = await waitForValue(async () => {
      const current = await readYouTubeChannelConnectStatus(started.flow_id)
      return current.status === 'pending' ? undefined : current
    }, { label: 'rejection status' })

    assert.equal(status.status, 'error')
    assert.equal(status.status === 'error' && status.error_code, 'YOUTUBE_OAUTH_PROVIDER_REJECTED')
    assert.equal(JSON.stringify(status).includes('invalid_grant'), false)
    assert.deepEqual(Object.keys((await readYouTubeConnectionRegistry()).channels), [])
  })

  test('reports an unknown flow instead of throwing', async () => {
    await isolate()
    const status = await readYouTubeChannelConnectStatus('flow-that-never-existed')
    assert.equal(status.status, 'unknown')
    assert.equal(status.status === 'unknown' && status.error_code, 'YOUTUBE_OAUTH_FLOW_UNKNOWN')
  })

  test('refuses to start without a configured owner application', async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    await assert.rejects(
      startYouTubeChannelConnect({}),
      (error: unknown) => (error as { code?: string }).code === 'YOUTUBE_APPLICATION_NOT_CONFIGURED',
    )
  })
})
