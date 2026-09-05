/**
 * Settings → YouTube: the owner's single OAuth application, its channel grants,
 * and which channel each project publishes to.
 *
 * This is app-level, not project-level. The older Upload Center endpoints use
 * this same registry while its UI is replaced in later consolidation slices.
 *
 * Nothing here returns a client secret, access token, refresh token, PKCE
 * verifier, authorization code, or raw provider body. The application read path
 * answers only whether a secret is stored.
 */

import { Router } from 'express'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import type { YouTubeApplicationRecord } from '../contracts/youtube-upload-center.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
  disconnectYouTubeChannel,
  getProjectYouTubeAssignment,
  readYouTubeConnectionRegistry,
  recoverYouTubeCredentialAuthority,
  unassignProjectYouTubeChannel,
} from '../services/youtube-connection-store.js'
import {
  readYouTubeChannelConnectStatus,
  startYouTubeChannelConnect,
} from '../services/youtube-channel-connect.js'
import { registryCredentialFor } from '../lib/youtube-client.js'
import { readAppSecrets, youtubeSecretRecoveryRequired } from '../services/app-secrets-store.js'

export const router = Router()

/** A public application view: identity and whether a secret exists, never the secret. */
function publicApplication(
  application: YouTubeApplicationRecord | null,
  hasClientSecret: boolean,
): (Omit<YouTubeApplicationRecord, never> & { has_client_secret: boolean }) | null {
  if (!application) return null
  return { ...application, has_client_secret: hasClientSecret }
}

/**
 * One failure shape for this surface: `{ code, detail }` from the closed
 * foundation list where the error is one of ours, and otherwise the repo's
 * standard humanizer.
 *
 * Anything that is not a `YouTubeFoundationError` still reaches here — a
 * corrupt `project.json` raises `JsonCorruptError` from `getProject()`, for
 * example. Those must NOT be passed through raw just because they carry the
 * repo-wide `expose: true` marker: `humanizeBackendError` is what runs the
 * message through secret redaction and decides whether a `code` may be
 * forwarded. Both `statusCode` and `status` are read, because the two
 * conventions coexist in this codebase and reading only one silently turns a
 * 409 into a 500.
 */
function fail(res: import('express').Response, error: unknown, fallback: string): void {
  if (error instanceof YouTubeFoundationError) {
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

router.get('/youtube/connections', async (_req, res) => {
  try {
    if (await youtubeSecretRecoveryRequired()) {
      throw new YouTubeFoundationError(
        409,
        'YOUTUBE_SECRET_RECOVERY_REQUIRED',
        'The local YouTube credential store needs repair. Remove only its unusable YouTube credentials, then reconnect the retained channels.',
      )
    }
    const registry = await readYouTubeConnectionRegistry()
    const secretBucket = (await readAppSecrets()).youtube
    const oauthClient = registry.application
      && secretBucket?.oauth_client?.application_id === registry.application.application_id
      ? secretBucket.oauth_client
      : null
    const ownerByChannel = new Map<string, string>()
    for (const assignment of Object.values(registry.assignments)) {
      ownerByChannel.set(assignment.channel_id, assignment.project_slug)
    }
    res.json({
      application: publicApplication(registry.application, oauthClient !== null),
      channels: Object.values(registry.channels).map(channel => {
        const token = secretBucket?.channel_tokens?.[channel.channel_id]
        const hasCurrentToken = !!oauthClient && token?.application_id === registry.application?.application_id
        return {
          ...channel,
          status: hasCurrentToken ? channel.status : 'reconnect_required',
          assigned_project_slug: ownerByChannel.get(channel.channel_id) ?? null,
        }
      }),
      assignments: Object.values(registry.assignments),
    })
  } catch (error) {
    fail(res, error, 'Failed to read the YouTube connections.')
  }
})

router.delete('/youtube/connections/credential-authority', async (_req, res) => {
  try {
    await recoverYouTubeCredentialAuthority()
    res.status(204).end()
  } catch (error) {
    fail(res, error, 'Failed to recover the YouTube credential store.')
  }
})

router.put('/youtube/connections/application', async (req, res) => {
  try {
    const clientId = readString(req.body?.client_id)
    const clientSecret = readString(req.body?.client_secret)
    if (!clientId || !clientSecret) {
      res.status(400).json({ detail: 'A Google Cloud OAuth client ID and client secret are both required.' })
      return
    }
    const cloudProject = readString(req.body?.google_cloud_project_id)

    const before = await readYouTubeConnectionRegistry()
    const application = await configureYouTubeApplication({
      client_id: clientId,
      client_secret: clientSecret,
      ...(cloudProject ? { google_cloud_project_id: cloudProject } : {}),
    })

    // Replacing the application invalidates every existing grant. Report how
    // many channels that touched so the UI can say it before and after.
    const replaced = before.application !== null && before.application.application_id !== application.application_id
    res.json({
      application: publicApplication(application, true),
      replaced_previous_application: replaced,
      dependent_channel_count: replaced ? Object.keys(before.channels).length : 0,
    })
  } catch (error) {
    fail(res, error, 'Failed to save the YouTube OAuth application.')
  }
})

router.post('/youtube/connections/channels/connect', async (req, res) => {
  try {
    const expected = readString(req.body?.expected_channel_id)
    // Production returns the URL and lets the caller open it; the server never
    // opens a browser of its own.
    const started = await startYouTubeChannelConnect(expected ? { expected_channel_id: expected } : {})
    res.json(started)
  } catch (error) {
    fail(res, error, 'Failed to start the YouTube channel connection.')
  }
})

router.get('/youtube/connections/channels/connect/:flow_id', async (req, res) => {
  try {
    res.json(await readYouTubeChannelConnectStatus(req.params.flow_id))
  } catch (error) {
    fail(res, error, 'Failed to read the YouTube channel connection.')
  }
})

router.delete('/youtube/connections/channels/:channel_id', async (req, res) => {
  try {
    await disconnectYouTubeChannel({ channel_id: req.params.channel_id })
    res.status(204).end()
  } catch (error) {
    fail(res, error, 'Failed to disconnect the YouTube channel.')
  }
})

router.get('/projects/:slug/youtube/assignment', async (req, res) => {
  try {
    res.json({ assignment: await getProjectYouTubeAssignment(req.params.slug) })
  } catch (error) {
    fail(res, error, 'Failed to read the project YouTube channel.')
  }
})

router.put('/projects/:slug/youtube/assignment', async (req, res) => {
  try {
    const channelId = readString(req.body?.channel_id)
    if (!channelId) {
      res.status(400).json({ detail: 'A YouTube channel is required.' })
      return
    }
    // The caller states which assignment it believes it is replacing, so a
    // stale page cannot silently move a project to another channel.
    const expectedPrevious = readString(req.body?.expected_previous_channel_id)
    const assignment = await assignProjectYouTubeChannel({
      project_slug: req.params.slug,
      channel_id: channelId,
      expected_previous_channel_id: expectedPrevious || null,
    })

    // Seed the upload plan from the project's cadence, if it has one.
    //
    // Settings says "this becomes the channel's upload plan the moment you
    // connect a YouTube account" — and the only caller of `ensurePlanForAccount`
    // was `/upload/oauth/start`, deleted in the cutover. Since then a cadence
    // set in Settings created nothing, ever, while the sentence promising it
    // stayed on screen. The deleted-surface sweep missed it because a route's
    // SIDE EFFECTS are not visible in its path or its response.
    //
    // No-throw and no-op when a plan is already active, so re-assigning the same
    // channel cannot overwrite a plan the owner has since edited.
    const { ensurePlanForAccount } = await import('../services/publish-cadence.js')
    const seeded = await ensurePlanForAccount(
      req.params.slug, 'youtube', registryCredentialFor(channelId),
    )

    res.json({ assignment, ...(seeded ? { seeded_plan_id: seeded } : {}) })
  } catch (error) {
    fail(res, error, 'Failed to assign the YouTube channel.')
  }
})

router.delete('/projects/:slug/youtube/assignment', async (req, res) => {
  try {
    const expected = readString(req.body?.expected_channel_id)
    if (!expected) {
      res.status(400).json({ detail: 'Name the YouTube channel you expect to release.' })
      return
    }
    await unassignProjectYouTubeChannel({ project_slug: req.params.slug, expected_channel_id: expected })
    res.status(204).end()
  } catch (error) {
    fail(res, error, 'Failed to release the YouTube channel.')
  }
})
