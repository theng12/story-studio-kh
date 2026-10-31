/**
 * Daily digest builder (v1.0.62+).
 *
 * Computes a per-project rollup from canonical operation/reconcile evidence,
 * with historical sidecars as a legacy fallback (no Analytics API needed):
 * how many are scheduled / ready / etc, plus the next + last scheduled
 * dates so the user can see how much buffer they have.
 *
 * Read-only — never writes to disk. Scans every project listed by the
 * project-manager so a single digest covers all your channels.
 *
 * Designed to be cheap: per-project, one `getIdeas('accepted')` call
 * plus one `readSidecarRaw` per accepted episode. For large projects
 * (~150 episodes) this is well under a second.
 */

import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { readItemSchedule } from './upload-plans.js'
import { readYouTubeRetentionStores, youtubeRetentionEvidenceFor } from './youtube-remote-video.js'

export interface DigestEpisode {
  episode_code: string
  /** ISO timestamp when the episode is/was scheduled to go live. */
  scheduled_for: string
}

export interface ProjectDigest {
  slug: string
  name: string
  /** Episodes whose scheduled_for is on the SAME local calendar day
   *  as `local_today_ymd`. These are the "going live today" highlights. */
  going_live_today: DigestEpisode[]
  /** Total accepted episodes scheduled in the future (incl. today). */
  total_scheduled_future: number
  /** Total accepted episodes already scheduled in the past — typically
   *  already-uploaded videos with their original publish time. */
  total_scheduled_past: number
  /** Accepted episodes with no durable provider-accepted identity. May or may
   *  not have a final video on disk; this is "still to upload", not readiness. */
  total_not_uploaded: number
  /** Accepted episodes with a durable provider-accepted identity. Processing
   *  and unavailable status remain here so this never implies a safe retry. */
  total_uploaded: number
  /** Earliest future scheduled episode — the next thing going live. */
  next_scheduled?: DigestEpisode
  /** Latest future scheduled episode — the current schedule coverage horizon. */
  last_scheduled?: DigestEpisode
}

export interface DigestData {
  /** ISO instant when this digest was computed. */
  generated_at: string
  /** Local YYYY-MM-DD the digest considers "today" — derived from the
   *  machine's locale at compute time. */
  local_today_ymd: string
  /** Friendly date string for display ("Tue May 5, 2026"). */
  local_today_label: string
  projects: ProjectDigest[]
  /** Free bytes on the fullest drive holding a channel; null when none could be asked. */
  free_disk_bytes?: number | null
  totals: {
    going_live_today: number
    scheduled_future: number
    not_uploaded: number
    uploaded: number
  }
}

/**
 * Local YYYY-MM-DD for the machine's timezone — used to bucket
 * "scheduled today" vs not. Implemented inline (no `date-fns` dep)
 * because we only need calendar-day comparison.
 */
function localYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function localFriendlyDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

export async function buildDigest(): Promise<DigestData> {
  const now = new Date()
  const todayYmd = localYmd(now)
  const todayLabel = localFriendlyDate(now)
  const nowMs = now.getTime()

  const projects = await pm.listProjects().catch(() => [])
  const projectDigests: ProjectDigest[] = []

  for (const proj of projects) {
    const ideas = await im.getIdeas(proj.slug, 'accepted').catch(() => [])
    const goingLiveToday: DigestEpisode[] = []
    let totalScheduledFuture = 0
    let totalScheduledPast = 0
    let totalNotUploaded = 0
    let totalUploaded = 0
    let next: DigestEpisode | undefined
    let last: DigestEpisode | undefined

    const [schedule, stores] = await Promise.all([
      readItemSchedule(proj.slug),
      readYouTubeRetentionStores(proj.slug),
    ])
    // Per-episode historical receipt reads remain bounded. Canonical records
    // and links were loaded once above.
    const concurrency = 16
    let cursor = 0
    const results: Array<{ code: string; scheduled_for: string | null; uploaded: boolean }> = []
    async function worker() {
      while (cursor < ideas.length) {
        const i = cursor++
        const idea = ideas[i]!
        if (!idea.episode_code) continue
        const evidence = await youtubeRetentionEvidenceFor(
          proj.slug, idea.episode_code, idea.title || '', stores.records, stores.state,
        )
        results.push({
          code: idea.episode_code,
          scheduled_for: schedule[idea.episode_code] || null,
          uploaded: evidence.accepted_operations.length > 0
            || !!evidence.reconcile_link
            || !!evidence.legacy_sidecar,
        })
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))

    for (const { code, scheduled_for: sched, uploaded } of results) {
      if (uploaded) totalUploaded++
      else totalNotUploaded++

      if (sched) {
        const t = Date.parse(sched)
        if (!Number.isFinite(t)) continue
        const ymd = localYmd(new Date(t))
        if (ymd === todayYmd) {
          goingLiveToday.push({ episode_code: code, scheduled_for: sched })
        }
        if (t >= nowMs) {
          totalScheduledFuture++
          if (!next || t < Date.parse(next.scheduled_for)) {
            next = { episode_code: code, scheduled_for: sched }
          }
          if (!last || t > Date.parse(last.scheduled_for)) {
            last = { episode_code: code, scheduled_for: sched }
          }
        } else {
          totalScheduledPast++
        }
      }
    }

    // Sort going-live-today by time so the digest reads chronologically.
    goingLiveToday.sort((a, b) =>
      Date.parse(a.scheduled_for) - Date.parse(b.scheduled_for))

    projectDigests.push({
      slug: proj.slug,
      name: proj.name,
      going_live_today: goingLiveToday,
      total_scheduled_future: totalScheduledFuture,
      total_scheduled_past: totalScheduledPast,
      total_not_uploaded: totalNotUploaded,
      total_uploaded: totalUploaded,
      next_scheduled: next,
      last_scheduled: last,
    })
  }

  // Project-level totals across the whole machine. Useful for the
  // top-line summary row.
  const totals = {
    going_live_today: 0,
    scheduled_future: 0,
    not_uploaded: 0,
    uploaded: 0,
  }
  for (const p of projectDigests) {
    totals.going_live_today += p.going_live_today.length
    totals.scheduled_future += p.total_scheduled_future
    totals.not_uploaded += p.total_not_uploaded
    totals.uploaded += p.total_uploaded
  }

  // shortcut: project folders only, a separate media drive is not measured; add output roots if one fills up.
  const { measureFreeBytes } = await import('./storage-audit.js')
  const free = (await Promise.all(projects.map(async proj => {
    const dir = pm.getProjectDir(proj.slug)
    return dir ? await measureFreeBytes(dir) : null
  }))).filter((bytes): bytes is number => bytes !== null)

  return {
    generated_at: now.toISOString(),
    local_today_ymd: todayYmd,
    local_today_label: todayLabel,
    projects: projectDigests,
    free_disk_bytes: free.length ? Math.min(...free) : null,
    totals,
  }
}
