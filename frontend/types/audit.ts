/**
 * Mirror of the server-side `manifest-audit.ts` shape. Hand-kept in sync
 * because the frontend is a separate TS project (Nuxt) and can't import
 * from electron/server/*. If either side drifts, the other will fail the
 * compile — interface is simple enough that manual parity is the cheapest
 * option.
 */

export type AuditStage =
  | 'audio'
  | 'scenes'
  | 'thumbnails'
  | 'video'
  | 'merged_audio'

export type AuditOutcome = 'measured' | 'not_started' | 'unmeasurable'

export interface StageAudit {
  stage: AuditStage
  outcome: AuditOutcome
  /** Safe, actionable explanation when this stage could not be measured. */
  error?: string
  started: boolean
  dir?: string
  expected: number
  present: number
  missing: string[]
  extra: string[]
}

export interface EpisodeAudit {
  episode_code: string
  title: string
  stages: StageAudit[]
}

export interface ProjectAudit {
  project_slug: string
  generated_at: string
  episodes: EpisodeAudit[]
  total_missing: number
  episodes_with_missing: number
}
