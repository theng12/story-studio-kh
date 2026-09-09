import { normaliseRepairResult, type NormalisedRepairResult } from './repair-triage.js'

/** The small, injectable slice of useApi used by targeted free recovery. */
export type AssetRecoveryPost = <T = unknown>(path: string, body: unknown) => Promise<T>

export interface EpisodeAssetRecovery {
  episodeId: string
  /** Jobs newly queued to reconcile image or thumbnail files. They are not complete yet. */
  imageJobIds: string[]
  imagesQueued: number
  /** Image reconciliation was already queued or running for this episode. */
  imagesAlreadyPending: number
  /** Whether the synchronous audio reconciliation endpoint was called. */
  audioAttempted: boolean
  /** Null means the endpoint returned no trustworthy numeric result. It is never zero by default. */
  audio: NormalisedRepairResult | null
}

type AuditEntry = Record<string, unknown>

function requiredTarget(value: unknown, label: string): string {
  const target = typeof value === 'string' ? value.trim() : ''
  if (!target) throw new Error(`${label} is required for episode asset recovery.`)
  if (target === '_app_') throw new Error('App-level jobs do not have episode assets to recover.')
  return target
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Asset recovery returned an invalid audit response.')
  }
  return value as Record<string, unknown>
}

function responseArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Asset recovery returned an invalid ${field} list.`)
  return value
}

function scopedEntry(value: unknown, field: string, target: string): AuditEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Asset recovery returned an invalid ${field} entry.`)
  }
  const entry = value as AuditEntry
  if (entry.episode_id !== target) {
    throw new Error(`Asset recovery refused ${field} outside episode ${target}.`)
  }
  return entry
}

/**
 * Recover only the already-finished assets for one accepted episode.
 *
 * The server audit is deliberately checked before its follow-up audio request:
 * a stale row must never turn into a project-wide scan or an audio repair for a
 * different episode. Image repair is queued, so this reports its job IDs rather
 * than pretending the files have arrived.
 */
export async function recoverEpisodeAssets(
  projectSlug: string,
  episodeId: string,
  post: AssetRecoveryPost,
  onProgress?: (message: string) => void,
): Promise<EpisodeAssetRecovery> {
  const project = requiredTarget(projectSlug, 'Project')
  const target = requiredTarget(episodeId, 'Episode')
  onProgress?.('Checking this episode’s saved images and audio…')

  const audit = responseRecord(await post(
    `/projects/${encodeURIComponent(project)}/assets/repair-all`,
    { episode_codes: [target] },
  ))
  const audited = responseArray(audit.audited_episode_codes, 'audited episode')
  if (audited.length === 0) {
    throw new Error(`Episode ${target} was not accepted in this project, so no files were recovered.`)
  }
  if (audited.length !== 1 || audited[0] !== target) {
    throw new Error(`Asset recovery refused an audit outside episode ${target}.`)
  }

  const enqueued = responseArray(audit.enqueued, 'enqueued repair')
  const skipped = responseArray(audit.skipped, 'skipped repair')
  const audioCandidates = responseArray(audit.audio_repair_candidates, 'audio repair candidate')

  // Validate every server-returned target before any synchronous follow-up.
  // The audit endpoint is allowed to queue image work, but it is never allowed
  // to turn one Jobs row into recovery for another episode.
  const imageJobIds = enqueued.map((entry) => {
    const checked = scopedEntry(entry, 'enqueued repair', target)
    if (typeof checked.job_id !== 'string' || !checked.job_id.trim()) {
      throw new Error('Asset recovery returned an enqueued repair without a job ID.')
    }
    return checked.job_id
  })
  for (const entry of skipped) scopedEntry(entry, 'skipped repair', target)
  for (const candidate of audioCandidates) {
    if (candidate !== target) {
      throw new Error(`Asset recovery refused an audio repair outside episode ${target}.`)
    }
  }

  let audio: NormalisedRepairResult | null = null
  const audioAttempted = audioCandidates.length > 0
  if (audioAttempted) {
    onProgress?.('Recovering this episode’s saved audio…')
    // A duplicate candidate must not cause duplicate provider history lookups.
    const audioResponse = await post(
      `/projects/${encodeURIComponent(project)}/episodes/${encodeURIComponent(target)}/audio-repair`,
      {},
    )
    audio = normaliseRepairResult(audioResponse)
  }

  return {
    episodeId: target,
    imageJobIds,
    imagesQueued: imageJobIds.length,
    imagesAlreadyPending: skipped.length,
    audioAttempted,
    audio,
  }
}

/** A row-sized status: reports verified results and never calls queued images complete. */
export function describeEpisodeAssetRecovery(result: EpisodeAssetRecovery): string {
  const parts: string[] = []
  if (result.audio) {
    parts.push(`Audio: ${result.audio.recovered} recovered, ${result.audio.stillMissing} still missing.`)
  } else if (result.audioAttempted) {
    parts.push('Audio recovery returned no verified counts.')
  }
  if (result.imagesQueued > 0) {
    parts.push(`${result.imagesQueued} image repair job${result.imagesQueued === 1 ? '' : 's'} queued.`)
  }
  if (result.imagesAlreadyPending > 0) {
    parts.push(`${result.imagesAlreadyPending} image repair job${result.imagesAlreadyPending === 1 ? '' : 's'} already pending.`)
  }
  return parts.join(' ') || 'No missing audio or thumbnail files were found. Retry the unfinished step if needed.'
}
