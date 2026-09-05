/** Durable operation evidence for YouTube uploads. */

import { randomUUID } from 'node:crypto'

import { authorizeProjectYouTubeAction } from './youtube-connection-store.js'
import {
  acceptYouTubeOperation,
  createYouTubeOperation,
  readYouTubeOperation,
  updateYouTubeOperation,
} from './youtube-operation-store.js'
import type { YouTubeMetadataPackage } from './youtube-metadata-package.js'
import { resolveYouTubeSourceRevision } from './youtube-source-video.js'

export type YouTubeOperationHandle = {
  operation_id: string
  channel_id: string
  revision: number
}

/**
 * A cheap, stable identity for the rendered source.
 *
 * ponytail: name+size+mtime, not a content hash — hashing a multi-gigabyte
 * render on every upload would cost minutes for a value only used to tell two
 * renders apart. Switch to a content hash if a case appears where two
 * different renders can share all three.
 */
export async function resolveSourceRevision(filePath: string): Promise<string> {
  return resolveYouTubeSourceRevision(filePath)
}

/**
 * Open the durable record for one upload, before any provider request.
 *
 * `final_action` is domain truth, not a label: it distinguishes a normal
 * manual upload from the deliberately private upload path.
 */
export async function beginYouTubeOperation(input: {
  project_slug: string
  episode_code: string
  source_revision: string
  metadata_package: Pick<YouTubeMetadataPackage, 'source_sha256' | 'final_payload'>
  final_action: 'manual_upload' | 'private_upload'
  /** The channel the provider request will publish to. */
  provider_channel_id: string
}): Promise<YouTubeOperationHandle> {
  const authorized = await authorizeProjectYouTubeAction({
    project_slug: input.project_slug,
    video_channel_id: input.provider_channel_id,
  })
  const channelId = authorized.channel.channel_id

  const base = {
    project_slug: input.project_slug,
    episode_code: input.episode_code,
    channel_id: channelId,
    source_revision: input.source_revision,
    metadata_revision: input.metadata_package.source_sha256,
    final_payload: input.metadata_package.final_payload,
  }
  // Written as two explicit branches rather than one computed pair: the create
  // input is a closed discriminated union, and the origin/action/eligibility
  // triple is the discriminant. Collapsing it costs the compiler's check that
  // `private_upload` can never carry `fresh_manual_upload`.
  const record = await createYouTubeOperation({
    ...base,
    origin: 'manual',
    final_action: input.final_action,
  })

  return { operation_id: record.operation_id, channel_id: channelId, revision: record.revision }
}

/**
 * Move the record to `uploading` before the provider request.
 *
 * The resumable session is recorded by HASH — the URL itself is a credential
 * that grants further writes, and never enters the record. A fresh upload has
 * no session yet at this point, so the hash is optional: the lifecycle still
 * has to advance, otherwise a crash mid-upload leaves a record stuck at
 * `preparing` that reads as "never attempted".
 */
export async function markYouTubeOperationUploading(input: {
  project_slug: string
  handle: YouTubeOperationHandle
  session_url_hash?: string
  source_bytes: number
  last_confirmed_offset?: number
}): Promise<void> {
  const current = await readYouTubeOperation(input.project_slug, input.handle.operation_id)
  if (!current) throw new Error(`YouTube operation ${input.handle.operation_id} disappeared before upload.`)
  await updateYouTubeOperation({
    project_slug: input.project_slug,
    operation_id: input.handle.operation_id,
    expected_revision: current.revision,
    mutate(record) {
      record.lifecycle = 'uploading'
      if (input.session_url_hash) {
        record.resumable = {
          session_url_hash: input.session_url_hash,
          source_bytes: input.source_bytes,
          created_at: record.resumable?.created_at ?? new Date().toISOString(),
          last_confirmed_offset: input.last_confirmed_offset ?? 0,
        }
      }
    },
  })
}

/** Close a definite pre-session refusal so a later deliberate upload can retry. */
export async function markYouTubeOperationFailedBeforeSession(input: {
  project_slug: string
  handle: YouTubeOperationHandle
  error_code: string
}): Promise<void> {
  const current = await readYouTubeOperation(input.project_slug, input.handle.operation_id)
  if (!current || current.video_id || current.resumable || !['preparing', 'uploading'].includes(current.lifecycle)) return
  await updateYouTubeOperation({
    project_slug: input.project_slug,
    operation_id: current.operation_id,
    expected_revision: current.revision,
    mutate(record) {
      record.lifecycle = 'failed'
      record.actions.push({
        action_id: `action_${randomUUID()}`,
        action: record.final_action,
        classification: 'whole_upload',
        state: 'failed',
        occurred_at: new Date().toISOString(),
        error_code: input.error_code,
      })
    },
  })
}

/**
 * Checkpoint the accepted identity and link the episode.
 */
export async function completeYouTubeOperation(input: {
  project_slug: string
  episode_code: string
  handle: YouTubeOperationHandle
  video_id: string
  metadata_package: YouTubeMetadataPackage
}): Promise<void> {
  const current = await readYouTubeOperation(input.project_slug, input.handle.operation_id)
  if (!current) throw new Error(`YouTube operation ${input.handle.operation_id} disappeared after upload acceptance.`)

  await acceptYouTubeOperation({
    project_slug: input.project_slug,
    operation_id: input.handle.operation_id,
    expected_revision: current.revision,
    channel_id: input.handle.channel_id,
    video_id: input.video_id,
    accepted_at: new Date().toISOString(),
    final_payload: input.metadata_package.final_payload,
  })
}
