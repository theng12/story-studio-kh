import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  YOUTUBE_FOUNDATION_ERROR_CODES,
  YOUTUBE_VIDEO_LIFECYCLES,
  YouTubeFoundationError,
} from '../contracts/youtube-upload-center.js'

test('defines the closed lifecycle vocabulary and safe public foundation errors', () => {
  assert.deepEqual(YOUTUBE_VIDEO_LIFECYCLES, [
    'preparing', 'uploading', 'accepted', 'processing', 'ready',
    'failed', 'rejected', 'status_unavailable',
  ])
  assert.deepEqual(YOUTUBE_FOUNDATION_ERROR_CODES, [
    'YOUTUBE_APPLICATION_NOT_CONFIGURED',
    'YOUTUBE_APPLICATION_CHANGED',
    'YOUTUBE_CHANNEL_NOT_CONNECTED',
    'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    'YOUTUBE_CHANNEL_ALREADY_ASSIGNED',
    'YOUTUBE_ASSIGNMENT_CHANGED',
    'YOUTUBE_CHANNEL_MISMATCH',
    'YOUTUBE_VIDEO_ID_CONFLICT',
    'YOUTUBE_RECORD_REVISION_CONFLICT',
    'YOUTUBE_QUOTA_EXHAUSTED',
    // Phase 9: the connection registry itself will not parse, so Story Studio
    // cannot tell what the state IS and refuses rather than proceeding.
    'YOUTUBE_LEDGER_UNREADABLE',
    // Already on YouTube with nothing in flight — a different next step from
    // an attempt that is still running.
    'YOUTUBE_ALREADY_PUBLISHED',
    'YOUTUBE_OPERATION_NOT_FOUND',
    'YOUTUBE_OPERATION_RECORD_CORRUPT',
    'YOUTUBE_SECRET_STORAGE_UNAVAILABLE',
    'YOUTUBE_SECRET_RECOVERY_REQUIRED',
    'YOUTUBE_OAUTH_PROVIDER_REJECTED',
    'YOUTUBE_OAUTH_UNAVAILABLE',
    'YOUTUBE_OAUTH_STATE_MISMATCH',
    'YOUTUBE_OAUTH_REDIRECT_MISMATCH',
    'YOUTUBE_OAUTH_TIMEOUT',
    'YOUTUBE_OAUTH_CANCELLED',
    'YOUTUBE_OAUTH_FLOW_UNKNOWN',
  ])

  const error = new YouTubeFoundationError(
    409,
    'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    'Assign a YouTube channel before continuing.',
  )
  assert.deepEqual(error.toPublic(), {
    code: 'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    detail: 'Assign a YouTube channel before continuing.',
  })

  for (const code of YOUTUBE_FOUNDATION_ERROR_CODES) {
    const publicError = new YouTubeFoundationError(409, code, `detail:${code}`).toPublic()
    assert.deepEqual(publicError, { code, detail: `detail:${code}` })
  }
})

test('preserves HTTP statusCode so an accidental status-only field mutation cannot become a 500', () => {
  const error = new YouTubeFoundationError(
    409,
    'YOUTUBE_CHANNEL_NOT_ASSIGNED',
    'Assign a YouTube channel before continuing.',
  )

  assert.equal(error.statusCode, 409)
})
