/**
 * Frontend helpers for the Upload Center's pacing UI (Story 386 Item 1).
 *
 * EVERY type, constant and validator is re-exported from the one shared
 * contract (`electron/server/contracts/upload-pacing.ts`) — the same module
 * the backend slot calculator and route handlers use. Nothing here restates a
 * tier count, a window rule or a conflict shape; a duplicate would be a second
 * source of truth that drifts the first time either side is edited.
 *
 * The scheduling algorithm (slot calculation, eligibility checks) stays
 * backend-only in `electron/server/services/upload-pacing.ts`.
 */
export * from '../../electron/server/contracts/upload-pacing'

import type { UploadWaitReason } from '../../electron/server/contracts/upload-pacing'

/**
 * One row of the persistent upload-queue projection the overview carries
 * (`upload_queue`). The backend owns the queue; this is the shape the UI reads.
 * When the backend publishes its own type in the shared contract, this
 * interface should become a re-export of it — never a second definition.
 */
export interface UploadQueueEntry {
  episode_code: string
  title?: string
  upload_at?: string | null
  publish_at?: string | null
  wait_reason?: UploadWaitReason | string
  wait_detail?: string
  next_eligible_at?: string | null
  is_paused?: boolean
  position?: number
  /** The queue job behind this row — the id every pause/move/cancel control acts on. */
  job_id?: string
  can_remove?: boolean
  can_reorder?: boolean
}

export interface UploadQueueProjection {
  queue?: UploadQueueEntry[]
  paused_count?: number
  total_count?: number
}

/**
 * Plain waiting reason for the queue list. The server's own `detail` wins when
 * present (it knows the exact hold); the code is the fallback so a row is
 * never shown as a bare code or an empty cell.
 */
export function waitingReasonLabel(reason: UploadWaitReason | string | undefined, detail?: string): string {
  if (detail && detail.trim()) return detail
  switch (reason) {
    case 'ready': return 'Ready to upload'
    case 'waiting_for_upload_on': return 'Waiting for upload date'
    case 'invalid_upload_on': return 'Invalid upload date'
    case 'outside_window': return 'Outside upload window'
    case 'daily_limit_reached': return 'Daily limit reached'
    case 'spacing_hold': return 'Waiting for minimum spacing'
    case 'weekday_not_allowed': return 'Day not allowed for uploads'
    case 'publish_deadline_conflict': return 'Publication deadline conflict'
    case 'unconfigured_pacing': return 'Upload pacing not configured'
    case 'quota_exhausted': return 'Quota exhausted, waiting for reset'
    default: return 'Waiting in queue'
  }
}
