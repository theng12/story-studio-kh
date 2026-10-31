import fs from 'node:fs/promises'
import path from 'node:path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { asKeyed, fetchVideoMetadata, runReport } from '../lib/youtube-analytics.js'
import { registryCredentialFor } from '../lib/youtube-client.js'
import { tokenHasAnalyticsScope } from '../lib/youtube-oauth.js'
import { getProjectDir } from './project-manager.js'
import { getProjectYouTubeAssignment, readYouTubeChannelTokensForServer, readYouTubeConnectionRegistry } from './youtube-connection-store.js'

// Weeks are Monday through Sunday, using UTC calendar dates.
const DAY = 86_400_000
const names = ['views', 'watch_minutes', 'avg_view_seconds', 'impressions', 'click_through_rate', 'subscribers_gained'] as const
type Name = typeof names[number]
type State = 'measured' | 'no_data' | 'not_fetched' | 'reconnect_required' | 'unavailable'
type Metric = { state: State; value: number | null; reason: string }
type Metrics = Record<Name, Metric>
type Report = Awaited<ReturnType<typeof runReport>>
export interface WeeklyResult {
  project_slug: string
  channel_id: string
  week: string
  end_date: string
  attempted_at: string
  complete: boolean
  metrics: Metrics
  top_videos: Array<{ video_id: string; title: string | null; title_reason: string | null; metrics: Metrics }>
  reason: string | null
}
const columns: Record<Name, string> = {
  views: 'views', watch_minutes: 'estimatedMinutesWatched', avg_view_seconds: 'averageViewDuration',
  impressions: 'videoThumbnailImpressions', click_through_rate: 'videoThumbnailImpressionsClickRate', subscribers_gained: 'subscribersGained',
}
const groups: Name[][] = [['views', 'watch_minutes', 'avg_view_seconds'], ['subscribers_gained'], ['impressions', 'click_through_rate']]
const metric = (state: State, reason: string, value: number | null = null): Metric => ({ state, value, reason })
const blank = (state: State, reason: string): Metrics => Object.fromEntries(names.map(n => [n, metric(state, reason)])) as Metrics
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export function monday(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return date(midnight - ((now.getUTCDay() + 6) % 7) * DAY)
}
function weekTime(week: string): number {
  const ms = Date.parse(`${week}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(ms) || date(ms) !== week || new Date(ms).getUTCDay() !== 1 || ms >= Date.parse(`${monday(new Date())}T00:00:00Z`)) {
    throw Object.assign(new Error('Choose a completed week by its Monday date (YYYY-MM-DD).'), { statusCode: 400, expose: true })
  }
  return ms
}
async function directory(slug: string): Promise<string> {
  await getProjectYouTubeAssignment(slug) // validates the project and slug
  const dir = getProjectDir(slug)
  if (!dir) throw Object.assign(new Error('Project not found.'), { statusCode: 404, expose: true })
  return path.join(dir, 'youtube', 'weekly-results')
}
export async function listWeeklyResults(slug: string): Promise<WeeklyResult[]> {
  const assignment = await getProjectYouTubeAssignment(slug)
  if (!assignment) return []
  const dir = path.join(await directory(slug), encodeURIComponent(assignment.channel_id))
  let files: string[]
  try { files = await fs.readdir(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const records = await Promise.all(files.filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(async f => JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as WeeklyResult))
  return records.filter(r => r.channel_id === assignment.channel_id).sort((a, b) => b.week.localeCompare(a.week))
}
export async function readWeeklyResult(slug: string, week: string): Promise<WeeklyResult | null> {
  weekTime(week)
  return (await listWeeklyResults(slug)).find(r => r.week === week) ?? null
}
export async function recomputeWeeklyResult(slug: string, week: string, fetchReport: typeof runReport = runReport): Promise<WeeklyResult> {
  const start = weekTime(week)
  const assignmentAtStart = await getProjectYouTubeAssignment(slug)
  if (!assignmentAtStart) throw Object.assign(new Error('Assign a YouTube channel first.'), { statusCode: 409, expose: true })
  const dir = path.join(await directory(slug), encodeURIComponent(assignmentAtStart.channel_id))
  const file = path.join(dir, `${week}.json`)
  return withLock(file, async () => {
    const assignment = await getProjectYouTubeAssignment(slug)
    if (!assignment || assignment.channel_id !== assignmentAtStart.channel_id) throw Object.assign(new Error('YouTube channel assignment changed.'), { statusCode: 409, expose: true })
    const channel = assignment.channel_id
    const account = registryCredentialFor(channel)
    const result: WeeklyResult = { project_slug: slug, channel_id: channel, week, end_date: date(start + 6 * DAY), attempted_at: new Date().toISOString(), complete: false, metrics: blank('not_fetched', 'Not fetched yet.'), top_videos: [], reason: null }
    const fail = (state: State, reason: string) => { result.metrics = blank(state, reason); result.reason = reason }
    try {
      const tokens = await readYouTubeChannelTokensForServer(channel)
      if (!tokens || !tokenHasAnalyticsScope(tokens.scope)) {
        fail('reconnect_required', 'Reconnect this channel and grant YouTube Analytics access.')
      } else {
        const base = { ids: 'channel==MINE', startDate: week, endDate: result.end_date }
        const reports: Array<{ names: Name[]; total?: Report; videos?: Report }> = []
        for (const group of groups) {
          const item: { names: Name[]; total?: Report; videos?: Report } = { names: group }
          reports.push(item)
          const metrics = group.map(n => columns[n]).join(',')
          try { item.total = await fetchReport(slug, account, { ...base, metrics }) } catch (error) {
            if ((error as { code?: string })?.code === 'YOUTUBE_RECONNECT_REQUIRED') throw error
            result.reason = 'One or more YouTube reports could not be read; retry this week.'
          }
          try { item.videos = await fetchReport(slug, account, { ...base, dimensions: 'video', metrics: group.includes('views') ? metrics : `views,${metrics}`, sort: '-views', maxResults: '200' }) } catch (error) {
            if ((error as { code?: string })?.code === 'YOUTUBE_RECONNECT_REQUIRED') throw error
            result.reason = 'One or more YouTube reports could not be read; retry this week.'
          }
        }
        const convert = (report: Report | undefined, row: unknown[] | undefined, group: Name[]): Partial<Metrics> => {
          const keyed = report && row ? asKeyed(report.columnHeaders, row) : null
          return Object.fromEntries(group.map(n => {
            const raw = keyed?.[columns[n]]
            return [n, !report ? metric('unavailable', 'YouTube did not provide this report.') : !row ? metric('no_data', 'YouTube returned no row for this period.') : typeof raw === 'number' && Number.isFinite(raw) ? metric('measured', 'Reported by YouTube.', raw) : metric('unavailable', 'YouTube did not provide this metric.')]
          })) as Partial<Metrics>
        }
        for (const report of reports) Object.assign(result.metrics, convert(report.total, report.total?.rows[0], report.names))
        const primary = reports[0]?.videos
        if (primary) {
          const ids = primary.rows.map(row => String(asKeyed(primary.columnHeaders, row).video ?? '')).filter(Boolean)
          let titles: Awaited<ReturnType<typeof fetchVideoMetadata>> = {}
          try { titles = await fetchVideoMetadata(slug, account, ids) } catch { result.reason = 'Some video titles could not be read; retry this week.' }
          result.top_videos = ids.map(id => {
            const metrics = blank('not_fetched', 'This video was not fetched.')
            for (const report of reports) {
              const row = report.videos?.rows.find(r => asKeyed(report.videos!.columnHeaders, r).video === id)
              Object.assign(metrics, convert(report.videos, row, report.names))
            }
            const title = titles[id]?.title || null
            if (!title) result.reason = 'Some video titles could not be read; retry this week.'
            return { video_id: id, title, title_reason: title ? null : 'YouTube did not return a title.', metrics }
          })
          if (primary.rows.length >= 200) result.reason = 'YouTube returned the first 200 videos; results may be truncated.'
        }
        result.complete = result.reason === null
      }
    } catch (error) {
      const revoked = (error as { code?: string })?.code === 'YOUTUBE_RECONNECT_REQUIRED'
      fail(revoked ? 'reconnect_required' : 'unavailable', revoked ? 'Reconnect this YouTube channel.' : 'YouTube analytics could not be read; retry this week.')
    }
    // Never write an old channel's figures under a newly assigned channel.
    if ((await getProjectYouTubeAssignment(slug))?.channel_id !== channel) throw new Error('YouTube channel assignment changed during the read.')
    await fs.mkdir(dir, { recursive: true })
    await writeJsonAtomic(file, result, { mode: 0o600 })
    return result
  })
}
let running = false
export async function weeklyResultsTick(now = new Date()): Promise<void> {
  if (running) return
  running = true
  try {
    const registry = await readYouTubeConnectionRegistry()
    for (const assignment of Object.values(registry.assignments)) {
      try {
        const latest = Date.parse(`${monday(now)}T00:00:00Z`) - 7 * DAY
        const assignedWeek = Date.parse(`${monday(new Date(assignment.assigned_at))}T00:00:00Z`)
        const first = Math.min(assignedWeek, latest)
        const records = await listWeeklyResults(assignment.project_slug)
        const completed = new Set(records.filter(r => r.complete).map(r => r.week))
        for (let current = first; current <= latest; current += 7 * DAY) {
          const week = date(current)
          if (!completed.has(week)) await recomputeWeeklyResult(assignment.project_slug, week)
        }
      } catch { console.error('[youtube-weekly-results] channel read failed; will retry on a later tick') }
    }
  } finally { running = false }
}
let timer: ReturnType<typeof setInterval> | undefined
export function startWeeklyResultsScheduler(): void {
  if (timer) clearInterval(timer)
  const tick = () => { void weeklyResultsTick().catch(() => console.error('[youtube-weekly-results] scheduler failed; will retry on a later tick')) }
  timer = setInterval(tick, 60_000)
  timer.unref?.()
  tick()
}
export async function allWeeklyResults(): Promise<Array<{ project_slug: string; results: WeeklyResult[] }>> {
  const registry = await readYouTubeConnectionRegistry()
  return Promise.all(Object.values(registry.assignments).map(async a => ({ project_slug: a.project_slug, results: await listWeeklyResults(a.project_slug) })))
}
