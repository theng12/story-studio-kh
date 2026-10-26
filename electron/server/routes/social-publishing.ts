/**
 * Settings → Publishing: connecting Facebook, Instagram and TikTok, and the
 * per-channel choice of which platforms to post to.
 *
 * Nothing here returns a client secret, an access token, a refresh token, a
 * Page token, a PKCE verifier, an authorization code, or a raw provider body.
 * The application read path answers only whether a secret is stored.
 */

import { Router } from 'express'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
  SocialError,
  type SocialOAuthProvider,
  type SocialPlatform,
} from '../contracts/social-publishing.js'
import {
  configureSocialApplication,
  disconnectSocialAccount,
  readProjectSocialAccounts,
  readProjectSocialOptIn,
  readSocialApplicationSecret,
  readSocialConnectionRegistry,
  socialAccountKey,
} from '../services/social-connection-store.js'
import { readSocialConnectStatus, startSocialConnect } from '../services/social-connect.js'
import { describeSocialState } from '../generators/social-publish.js'
import { SOCIAL_SCOPES } from '../lib/social-oauth.js'
import { getProject, updateConfig } from '../services/project-manager.js'
import { enqueueOrRun } from '../services/job-queue.js'

export const router = Router()

function fail(res: import('express').Response, error: unknown, fallback: string): void {
  if (error instanceof SocialError) {
    res.status(error.statusCode).json(error.toPublic())
    return
  }
  const tagged = error as { statusCode?: number; status?: number } | null
  const status = typeof tagged?.statusCode === 'number'
    ? tagged.statusCode
    : typeof tagged?.status === 'number' ? tagged.status : 500
  res.status(status).json(humanizeBackendError(error, fallback))
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readProvider(value: unknown): SocialOAuthProvider | null {
  const provider = readString(value)
  return provider === 'meta' || provider === 'tiktok' ? provider : null
}

/**
 * The whole connections view: applications (without secrets), accounts, the
 * scopes each platform needs, and which account each channel posts with.
 */
router.get('/social/connections', async (_req, res) => {
  try {
    const registry = await readSocialConnectionRegistry()
    const applications: Record<string, unknown> = {}
    for (const provider of ['meta', 'tiktok'] as const) {
      const stored = registry.applications[provider]
      if (!stored) continue
      const secret = await readSocialApplicationSecret(provider)
      applications[provider] = {
        provider,
        application_id: stored.application_id,
        client_id: stored.client_id,
        redirect_uri: stored.redirect_uri,
        configured_at: stored.configured_at,
        updated_at: stored.updated_at,
        has_client_secret: secret !== null,
        required_scopes: SOCIAL_SCOPES[provider],
      }
    }
    res.json({
      applications,
      accounts: Object.values(registry.accounts),
      platforms: SOCIAL_PLATFORMS.map(platform => ({
        platform,
        label: PLATFORM_LABELS[platform],
        provider: platform === 'tiktok' ? 'tiktok' : 'meta',
        required_scopes: SOCIAL_SCOPES[platform === 'tiktok' ? 'tiktok' : 'meta'],
      })),
    })
  } catch (error) {
    fail(res, error, 'Failed to read the publishing connections.')
  }
})

router.put('/social/connections/applications/:provider', async (req, res) => {
  try {
    const provider = readProvider(req.params.provider)
    if (!provider) {
      res.status(400).json({ detail: 'That is not a publishing provider Story Studio knows.' })
      return
    }
    const clientId = readString(req.body?.client_id)
    const clientSecret = readString(req.body?.client_secret)
    const redirectUri = readString(req.body?.redirect_uri)
    if (!clientId || !clientSecret || !redirectUri) {
      res.status(400).json({ detail: 'A client ID, client secret and redirect URI are all required.' })
      return
    }
    const saved = await configureSocialApplication({ provider, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri })
    res.json({
      application: {
        provider: saved.application.provider,
        application_id: saved.application.application_id,
        client_id: saved.application.client_id,
        redirect_uri: saved.application.redirect_uri,
        configured_at: saved.application.configured_at,
        updated_at: saved.application.updated_at,
        has_client_secret: true,
      },
      invalidated_accounts: saved.invalidated_accounts,
    })
  } catch (error) {
    fail(res, error, 'Failed to save the publishing application.')
  }
})

router.post('/social/connections/:provider/connect', async (req, res) => {
  try {
    const provider = readProvider(req.params.provider)
    if (!provider) {
      res.status(400).json({ detail: 'That is not a publishing provider Story Studio knows.' })
      return
    }
    // Production returns the URL and lets the caller open it; the server never
    // opens a browser of its own.
    res.json(await startSocialConnect({ provider }))
  } catch (error) {
    fail(res, error, 'Failed to start the account connection.')
  }
})

router.get('/social/connections/connect/:flow_id', async (req, res) => {
  try {
    res.json(await readSocialConnectStatus(req.params.flow_id))
  } catch (error) {
    fail(res, error, 'Failed to read the account connection.')
  }
})

router.delete('/social/connections/accounts/:platform/:remote_id', async (req, res) => {
  try {
    const platform = readString(req.params.platform) as SocialPlatform
    if (!SOCIAL_PLATFORMS.includes(platform)) {
      res.status(400).json({ detail: 'That is not a publishing platform Story Studio knows.' })
      return
    }
    const remoteId = readString(req.params.remote_id)
    if (!remoteId) {
      res.status(400).json({ detail: 'An account id is required.' })
      return
    }
    await disconnectSocialAccount(platform, remoteId)
    res.status(204).end()
  } catch (error) {
    fail(res, error, 'Failed to disconnect that account.')
  }
})

/** This channel's posting choices: which platforms, and which account for each. */
router.get('/projects/:slug/social/settings', async (req, res) => {
  try {
    const [platforms, accounts, registry] = await Promise.all([
      readProjectSocialOptIn(req.params.slug),
      readProjectSocialAccounts(req.params.slug),
      readSocialConnectionRegistry(),
    ])
    res.json({
      platforms,
      accounts: SOCIAL_PLATFORMS.map(platform => {
        const remoteId = accounts[platform] ?? null
        const account = remoteId ? registry.accounts[socialAccountKey(platform, remoteId)] : undefined
        return {
          platform,
          account_id: remoteId,
          account_name: account?.remote_name ?? null,
          status: account?.status ?? null,
        }
      }),
    })
  } catch (error) {
    fail(res, error, 'Failed to read this channel’s posting settings.')
  }
})

router.put('/projects/:slug/social/settings', async (req, res) => {
  try {
    const project = await getProject(req.params.slug)
    if (!project) {
      res.status(404).json({ detail: 'Project not found' })
      return
    }
    const rawPlatforms = req.body?.platforms
    if (!Array.isArray(rawPlatforms)) {
      res.status(400).json({ detail: 'platforms must be a list.' })
      return
    }
    const unknown = rawPlatforms.filter(value => !SOCIAL_PLATFORMS.includes(value as SocialPlatform))
    if (unknown.length) {
      res.status(400).json({ detail: `Unknown platform(s): ${unknown.join(', ')}.` })
      return
    }
    const platforms = SOCIAL_PLATFORMS.filter(platform => rawPlatforms.includes(platform))

    // Accounts are validated against the registry: a channel cannot point at an
    // account that is not connected, because the job would then fail at the
    // worst moment with a message about a missing credential.
    const registry = await readSocialConnectionRegistry()
    const accounts: Partial<Record<SocialPlatform, string>> = {}
    const rawAccounts = req.body?.accounts
    if (rawAccounts !== undefined) {
      if (typeof rawAccounts !== 'object' || rawAccounts === null || Array.isArray(rawAccounts)) {
        res.status(400).json({ detail: 'accounts must be an object keyed by platform.' })
        return
      }
      for (const platform of SOCIAL_PLATFORMS) {
        const remoteId = readString((rawAccounts as Record<string, unknown>)[platform])
        if (!remoteId) continue
        const account = registry.accounts[socialAccountKey(platform, remoteId)]
        if (!account) {
          res.status(400).json({ detail: `${PLATFORM_LABELS[platform]} account ${remoteId} is not connected on this Mac.` })
          return
        }
        if (account.platform !== platform) {
          res.status(400).json({ detail: `${remoteId} is a ${PLATFORM_LABELS[account.platform]} account, not ${PLATFORM_LABELS[platform]}.` })
          return
        }
        accounts[platform] = remoteId
      }
    } else {
      Object.assign(accounts, await readProjectSocialAccounts(req.params.slug))
    }

    // config.json, not project.json: these are publishing settings that travel
    // with the channel's configuration, exactly like the YouTube category and
    // the upload schedule beside them.
    await updateConfig(req.params.slug, { social_platforms: platforms, social_accounts: accounts } as never)
    res.json({ platforms, accounts })
  } catch (error) {
    fail(res, error, 'Failed to save this channel’s posting settings.')
  }
})

/** What is already posted for one episode, and what failed. */
router.get('/projects/:slug/social/episodes/:episode_code', async (req, res) => {
  try {
    res.json(await describeSocialState(req.params.slug, req.params.episode_code))
  } catch (error) {
    fail(res, error, 'Failed to read this episode’s posts.')
  }
})

/**
 * Post one episode to the platforms the owner ticked for THIS upload.
 *
 * `platforms` is required and is the only thing that decides what is posted —
 * the channel's saved choices merely pre-tick the page. An empty list is
 * refused rather than treated as "use the channel's defaults": a tick box that
 * the owner cleared must never post anyway.
 */
router.post('/projects/:slug/social/episodes/:episode_code/publish', async (req, res) => {
  try {
    const slug = req.params.slug
    const episodeCode = req.params.episode_code
    const project = await getProject(slug)
    if (!project) {
      res.status(404).json({ detail: 'Project not found' })
      return
    }
    const raw = req.body?.platforms
    if (!Array.isArray(raw) || !raw.length) {
      res.status(400).json({
        code: 'SOCIAL_NOTHING_SELECTED',
        detail: 'Tick at least one platform to post to. Nothing was posted.',
      })
      return
    }
    const unknown = raw.filter(value => !SOCIAL_PLATFORMS.includes(value as SocialPlatform))
    if (unknown.length) {
      res.status(400).json({ detail: `Unknown platform(s): ${unknown.join(', ')}.` })
      return
    }
    const platforms = SOCIAL_PLATFORMS.filter(platform => raw.includes(platform))

    // Refuse here, before a job exists, when a ticked platform has no account.
    // A queued job that fails later fails where the owner is not looking.
    const accounts = await readProjectSocialAccounts(slug)
    const registry = await readSocialConnectionRegistry()
    const unconnected = platforms.filter(platform => {
      const remoteId = accounts[platform]
      const account = remoteId ? registry.accounts[socialAccountKey(platform, remoteId)] : undefined
      return !account || account.status !== 'connected'
    })
    if (unconnected.length) {
      res.status(409).json({
        code: 'SOCIAL_ACCOUNT_NOT_CONNECTED',
        detail: `Connect an account for ${unconnected.map(platform => PLATFORM_LABELS[platform]).join(', ')} in Settings → Publishing before posting there. Nothing was posted.`,
        platforms: unconnected,
      })
      return
    }

    const captions = req.body?.captions
    const job = await enqueueOrRun({
      project_slug: slug,
      type: 'social_publish',
      episode_id: episodeCode,
      params: {
        episode_id: episodeCode,
        platforms,
        ...(captions && typeof captions === 'object' ? { captions } : {}),
      },
    })
    res.json({ job_id: job.job_id, episode_code: episodeCode, platforms })
  } catch (error) {
    fail(res, error, 'Failed to start posting this episode.')
  }
})
