import type { PublishingOverviewChannel, PublishingTimelineEpisode } from '@shared/publishing-overview'

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
export const timestamp = (value: string | null | undefined): number | null => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
export function monday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date.toISOString().slice(0, 10)
}
export function weekInZone(at: string, zone: string | null): string | null {
  if (!zone || timestamp(at) === null) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
    const part = (name: string) => parts.find(p => p.type === name)?.value
    return monday(`${part('year')}-${part('month')}-${part('day')}`)
  } catch { return null }
}
export const episodeKey = (episode: PublishingTimelineEpisode): string => episode.id || `${episode.episode_code}:${episode.title}`
export function dateProblem(episode: PublishingTimelineEpisode): string | null {
  const upload = timestamp(episode.upload_start_at), release = timestamp(episode.public_release_at)
  if ((episode.upload_start_at && upload === null) || (episode.public_release_at && release === null)) return 'Invalid date — open Upload Center to check the saved dates.'
  if (upload !== null && release !== null && upload > release) return 'Upload starts after release — check the dates in Upload Center.'
  return null
}
export interface TimelineItem {
  episode: PublishingTimelineEpisode
  left: number
  width: number
  lane: number
  upload: number | null
  release: number | null
}
export function layoutEpisodes(episodes: PublishingTimelineEpisode[], start: number, weeks: number, dayWidth: number) {
  const end = start + weeks * WEEK_MS, total = weeks * 7 * dayWidth
  const undated: PublishingTimelineEpisode[] = [], outside: PublishingTimelineEpisode[] = [], candidates: TimelineItem[] = []
  for (const episode of episodes) {
    const upload = timestamp(episode.upload_start_at), release = timestamp(episode.public_release_at)
    const dates = [upload, release].filter((at): at is number => at !== null)
    if (!dates.length || dateProblem(episode)) { undated.push(episode); continue }
    const first = Math.min(...dates), last = Math.max(...dates)
    if (last < start || first >= end) { outside.push(episode); continue }
    const left = Math.max(0, (first - start) / DAY_MS * dayWidth)
    const width = Math.min(total - left, Math.max(156, (last - first) / DAY_MS * dayWidth + 12))
    candidates.push({ episode, left, width, lane: 0, upload, release })
  }
  candidates.sort((a, b) => a.left - b.left || episodeKey(a.episode).localeCompare(episodeKey(b.episode)))
  const lanes = [-Infinity, -Infinity], visible: TimelineItem[] = [], folded: TimelineItem[] = []
  for (const item of candidates) {
    const lane = lanes.findIndex(right => right + 8 <= item.left)
    if (lane === -1) folded.push(item)
    else { item.lane = lane; lanes[lane] = item.left + item.width; visible.push(item) }
  }
  return { visible, folded, undated, outside }
}

/** Plans and observations are separate sets; an upload start is never a release. */
export function weeklyReleases(channel: PublishingOverviewChannel, week: string, target: number) {
  const confirmed = new Set<string>(), planned = new Set<string>()
  const scheduledCodes = new Set<string>()
  for (const entry of channel.confirmed.schedules) {
    if (entry.episode_code) scheduledCodes.add(entry.episode_code)
    if (weekInZone(entry.scheduled_for, channel.timezone) === week) confirmed.add(entry.episode_code || `video:${entry.video_id}`)
  }
  for (const episode of channel.timeline?.episodes || []) {
    if (!episode.public_release_at || dateProblem(episode) || weekInZone(episode.public_release_at, channel.timezone) !== week) continue
    const key = episode.episode_code || episodeKey(episode)
    if (episode.date_source === 'confirmed') {
      if (!scheduledCodes.has(episode.episode_code)) confirmed.add(key)
    } else if (episode.date_source === 'planned') planned.add(key)
  }
  for (const key of confirmed) planned.delete(key)
  const known = !!channel.timezone && weekInZone(`${week}T12:00:00Z`, channel.timezone) !== null
    && !!channel.timeline && !channel.timeline.error && channel.confirmed.freshness === 'fresh'
    && channel.confirmed.listing?.state === 'complete' && !channel.confirmed.listing.stale
  return { confirmed: confirmed.size, planned: planned.size, gap: known ? Math.max(0, target - confirmed.size) : null }
}
