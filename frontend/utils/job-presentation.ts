import { jobDisplayStatus } from './episode-recovery.js'

export interface JobControlLike {
  action: string
  enabled: boolean
}

export interface JobFilterLike {
  type?: string
  status?: string
  project_slug?: string
  params?: {
    pipeline_batch_id?: unknown
    force?: unknown
    generation_action?: { kind?: unknown }
    episode_recovery_id?: unknown
    episode_recovery?: { id?: unknown; completed?: readonly unknown[]; first_unresolved?: unknown }
  }
}

export interface CapacitySnapshotLike {
  capacity_verified?: boolean
  limitSource?: string
  refreshed_at?: string | null
}

export interface JobRequestIdentityLike {
  job_id: string
  genstudio_jobs?: readonly { id: string }[] | null
  remote_cancellations?: Readonly<Record<string, { provider_job_id: string }>> | null
}

const LIVE_CAPACITY_MAX_AGE_MS = 30_000

export function primaryControl<T extends JobControlLike>(controls: readonly T[]): T | null {
  return controls.find(control => control.action !== 'force-abandon') || controls[0] || null
}

export function secondaryControls<T extends JobControlLike>(controls: readonly T[]): T[] {
  const primary = primaryControl(controls)
  return controls.filter(control => control !== primary)
}

export function filterJobsForView<T extends JobFilterLike>(
  jobs: readonly T[],
  filters: { type: string; status: string; project: string; batch: string | null },
): T[] {
  return jobs.filter(job => {
    if (filters.project !== 'all' && job.project_slug !== filters.project) return false
    if (filters.type !== 'all' && job.type !== filters.type) return false
    if (filters.status !== 'all' && jobDisplayStatus(job) !== filters.status) return false
    if (filters.batch && job.params?.pipeline_batch_id !== filters.batch) return false
    return true
  })
}

export function isVerifiedLiveCapacity(snapshot: CapacitySnapshotLike | null | undefined, nowMs: number): boolean {
  if (snapshot?.capacity_verified !== true || snapshot.limitSource !== 'account-overview' || !snapshot.refreshed_at) return false
  const refreshedAt = Date.parse(snapshot.refreshed_at)
  if (!Number.isFinite(refreshedAt)) return false
  const age = nowMs - refreshedAt
  return age >= -5_000 && age <= LIVE_CAPACITY_MAX_AGE_MS
}

export function jobRequestIds(job: JobRequestIdentityLike): string[] {
  return [
    job.job_id,
    ...(job.genstudio_jobs || []).map(remote => remote.id),
    ...Object.values(job.remote_cancellations || {}).map(record => record.provider_job_id),
  ].filter(Boolean)
}

/** Remove request identities only from presentation; the source job evidence is untouched. */
export function customerSafeJobText(value: unknown, exactIds: readonly string[] = []): string {
  let text = String(value || '')
  for (const id of [...new Set(exactIds.filter(id => id.length >= 6))].sort((a, b) => b.length - a.length)) {
    text = text.split(id).join('[request hidden]')
  }
  return text
    .replace(/\b((?:provider[ _-]?)?(?:job|task|request)[ _-]?id)\s*[:=#]\s*[A-Za-z0-9._:-]{6,}/gi, '$1: hidden')
    .replace(/\b((?:story\s+)?(?:job|task|request))\s+(?=[A-Za-z0-9._:-]{6,}\b)(?=[A-Za-z0-9._:-]*\d)(?=[A-Za-z0-9._:-]*[_.:-])[A-Za-z0-9._:-]+\b/gi, '$1 [request hidden]')
}

/** A navigation-only shortcut; opening a workspace never retries provider work. */
export function jobWorkspaceLink(job: {
  type: string
  status: string
  project_slug?: string | null
  episode_id?: string | null
  params?: { mode?: unknown; pool?: unknown }
}): { to: string; label: string; ariaLabel: string } | null {
  if (!['error', 'cancelled'].includes(job.status) || !job.project_slug || job.project_slug === '_app_') return null
  const destinations: Record<string, [string, string]> = {
    idea_campaign: ['ideas', 'Ideas Generator'],
    'script-only': ['scripts', 'Script Generator'],
    'chapter-only': ['scripts', 'Script Generator'],
    outline_only: ['scripts', 'Script Generator'],
    expand_chapters: ['scripts', 'Script Generator'],
    'introduction-only': ['introduction', 'Introduction'],
    research_run: ['research', 'Research'],
    image_prompts: job.params?.mode === 'scenes' ? ['scene-plan', 'Scene Plan'] : ['image-prompts', 'Thumbnail Prompts'],
    thumb_images: ['images', 'Thumbnail Generator'],
    images_repair: job.params?.pool === 'scenes' ? ['scene-review', 'Scene Review'] : ['images', 'Thumbnail Generator'],
    composition_generate: ['character-sheet', 'Character Sheet'],
    broll_select: ['broll', 'B-Roll'],
    audio: ['audio', 'Audio Generator'],
    expression_markup: ['audio', 'Audio Generator'],
    audio_merge: ['audio-merge', 'Audio Assembly'],
    subtitles_transcribe: ['subtitles', 'Subtitles'],
    metadata: ['metadata', 'YouTube Finalizer'],
    scene_plan_run: ['scene-plan', 'Scene Plan'],
    contextual_cues: ['contextual-cues', 'Contextual Cues'],
    scene_image_generate: ['scene-review', 'Scene Review'],
    continuity_render: ['scene-review', 'Scene Review'],
    scene_clip_generate: ['motion-review', 'Motion Review'],
    scene_clips_batch: ['motion-review', 'Motion Review'],
    video: ['motion-review', 'Motion Review'],
    video_assembly: ['video-assembly', 'Video Assembly'],
    youtube_upload: ['upload/publish', 'Upload Center'],
    youtube_playlist_update: ['upload/publish', 'Upload Center'],
    youtube_thumbnail_refresh: ['upload/publish', 'Upload Center'],
    image_pool_generate: ['image-pool', 'Image Pool'],
    music_generate: ['music', 'Music'],
    music_video: ['music', 'Music'],
  }
  if (!Object.hasOwn(destinations, job.type)) return null
  const destination = destinations[job.type]
  const [page, label] = destination
  // These tasks use a pool ID or a bulk-operation sentinel, not an episode code.
  const episodeId = job.type === 'idea_campaign' || job.type === 'image_pool_generate' || job.type === 'music_generate' || job.episode_id === '_thumbnail_refresh_' ? null : job.episode_id
  const episode = episodeId ? `?episode_id=${encodeURIComponent(episodeId)}` : ''
  return { to: `/projects/${encodeURIComponent(job.project_slug)}/${page}${episode}`, label: `Open ${label}`, ariaLabel: `Open ${label}${episodeId ? ` for ${episodeId}` : ''}` }
}
