/**
 * The stored YouTube metadata audit, read without asking YouTube.
 *
 * Production's ledger adapter joins two native records that already exist on
 * disk: the append-only `metadata_updates[]` receipts on each operation, and
 * the per-video observation ledger in `youtube/video-audit.json`.
 * `GET .../youtube/operations` publishes the receipts; `GET .../videos/snippets`
 * answers from the same observation file BUT re-reads stale videos from the
 * provider and spends quota doing it. This is the third read: both records,
 * from the stores, with no provider call and no write.
 *
 * An empty answer says why it is empty. A video with no observation is absent
 * — never "unchanged" (a missing entry means we never looked). An observation
 * older than Story's own last write carries `current: false`. Identity is the
 * project's assigned channel, the same ownership boundary every other read
 * here scopes to, so a reassigned project cannot answer with the previous
 * channel's records. No token, account credential or provider payload is in
 * any record this returns.
 */

import { Router } from 'express'

import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { YouTubeFoundationError } from '../contracts/youtube-upload-center.js'
import { getProjectYouTubeAssignment } from '../services/youtube-connection-store.js'
import { listYouTubeOperations, type YouTubeOperationRecordV1 } from '../services/youtube-operation-store.js'
import {
  readChannelVideoAudit,
  videoAuditEntryIsCurrent,
} from '../services/youtube-video-audit-store.js'
import { METADATA_SNIPPET_HASH_ALGORITHM } from '../services/youtube-metadata-update.js'

export const router = Router()

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

/**
 * The durable facts the adapter joins on, and nothing else.
 *
 * The whole record also carries the constructed request payload and the
 * resumable session hash — neither is a credential, neither has any use to a
 * reader of receipts, so neither is sent (the same rule as the Upload Center's
 * own operation projection). `metadata_updates` is always present: an empty
 * array is "no receipt yet", which is a different fact from the key being
 * missing.
 */
function auditOperation(record: YouTubeOperationRecordV1) {
  return {
    operation_id: record.operation_id,
    project_slug: record.project_slug,
    episode_code: record.episode_code,
    channel_id: record.channel_id,
    ...(record.video_id ? { video_id: record.video_id } : {}),
    lifecycle: record.lifecycle,
    origin: record.origin,
    final_action: record.final_action,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(record.accepted_at ? { accepted_at: record.accepted_at } : {}),
    metadata_updates: record.metadata_updates ?? [],
  }
}

/**
 * READ-ONLY: the stored operations receipts and the stored per-video
 * observations for this project's assigned channel.
 *
 * Never contacts YouTube, never writes a file, never migrates config. An
 * unassigned project is a 200 with `channel_id: null` and a reason — the
 * publication-cache route answers the same way, because "which channel?" is a
 * state of the project, not a failure of the read.
 */
router.get('/projects/:slug/youtube/audit', async (req, res) => {
  try {
    const slug = req.params.slug
    const assignment = await getProjectYouTubeAssignment(slug)
    const channelId = assignment?.channel_id ?? null
    const readAt = new Date().toISOString()

    if (!channelId) {
      res.json({
        project_slug: slug,
        channel_id: null,
        read_at: readAt,
        unavailable_reason: 'no_channel_assigned',
        operations: [],
        videos: [],
      })
      return
    }

    const [records, observations] = await Promise.all([
      listYouTubeOperations(slug),
      readChannelVideoAudit(slug, channelId),
    ])
    const operations = records
      .filter(record => record.channel_id === channelId)
      .map(auditOperation)
    const videos = Object.values(observations).map(entry => ({
      ...entry,
      // Honest state, computed by the store's own rule: an observation taken
      // before Story's last write ( or under an older hash rule) is stale.
      current: videoAuditEntryIsCurrent(entry, METADATA_SNIPPET_HASH_ALGORITHM),
    }))

    res.json({
      project_slug: slug,
      channel_id: channelId,
      read_at: readAt,
      unavailable_reason: operations.length || videos.length ? null : 'nothing_recorded',
      operations,
      videos,
    })
  } catch (error) {
    fail(res, error, 'Failed to read the stored YouTube metadata audit.')
  }
})
