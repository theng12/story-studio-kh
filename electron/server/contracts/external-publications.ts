/**
 * Publications made outside Story (2026-11-16) — imported, reviewed, then counted.
 *
 * A channel published elsewhere must be visible in cadence coverage.
 * Nothing here talks to YouTube: a row arrives UNLINKED from a picked CSV/JSON file, a human
 * verifies it, and only a verified row with a real date counts. A guessed date or “no data” as
 * zero is never accepted.
 */
import { z } from 'zod'

const DATE_DAY = /^\d{4}-\d{2}-\d{2}$/
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

/** A real date: a calendar day, or a full ISO-8601 instant with an explicit zone. */
export function parseExternalPublishedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (DATE_DAY.test(text)) {
    const [y, m, d] = text.split('-').map(Number)
    const date = new Date(Date.UTC(y!, m! - 1, d!))
    return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d ? text : null
  }
  if (ISO_ZONED.test(text)) {
    const parsed = new Date(text)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

export const ExternalPublicationSchema = z.object({
  id: z.string().trim().min(1).max(120),
  video_url: z.string().url().max(500).optional(),
  video_id: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(300),
  /** A calendar day or an ISO instant with a zone; refused otherwise. */
  published_at: z.string().trim().min(10).max(40),
  episode_code: z.string().trim().min(1).max(40).optional(),
  state: z.enum(['unlinked', 'verified', 'dismissed']),
  source: z.literal('import'),
  imported_at: z.string(),
  verified_at: z.string().nullable(),
  verified_by: z.string().nullable(),
}).strict()
export type ExternalPublication = z.infer<typeof ExternalPublicationSchema>

export interface ExternalImportRefusal {
  row: number
  reason: string
}

/**
 * Validate an imported file's rows. Nothing is written when any row is refused — the caller shows
 * the refused rows and the operator fixes the file. Imported rows are UNLINKED; import never
 * verifies.
 */
export function validateExternalImport(
  rows: readonly unknown[],
  existing: readonly Pick<ExternalPublication, 'id' | 'video_id' | 'video_url' | 'published_at' | 'episode_code'>[],
): { entries: ExternalPublication[]; refusals: ExternalImportRefusal[] } {
  const refusals: ExternalImportRefusal[] = []
  const entries: ExternalPublication[] = []
  const seenIds = new Set(existing.map(row => row.id))
  const seenVideos = new Set(existing.flatMap(row => [row.video_id, row.video_url].filter(Boolean) as string[]))
  const seenKeys = new Set(existing.map(row => `${row.published_at}|${row.episode_code || ''}`))
  rows.forEach((raw, index) => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const date = parseExternalPublishedAt(row.published_at)
    const videoId = typeof row.video_id === 'string' && row.video_id.trim() ? row.video_id.trim() : undefined
    const videoUrl = typeof row.video_url === 'string' && row.video_url.trim() ? row.video_url.trim() : undefined
    const episodeCode = typeof row.episode_code === 'string' && row.episode_code.trim() ? row.episode_code.trim() : undefined
    if (!title) { refusals.push({ row: index + 1, reason: 'title is required' }); return }
    if (!date) {
      refusals.push({ row: index + 1, reason: `published date "${String(row.published_at ?? '')}" is not a real YYYY-MM-DD date or ISO-8601 instant with a zone` })
      return
    }
    const id = videoId || videoUrl || `${date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)}`
    const key = `${date}|${episodeCode || ''}`
    if (seenIds.has(id) || seenKeys.has(key) || (videoId && seenVideos.has(videoId)) || (videoUrl && seenVideos.has(videoUrl))) {
      refusals.push({ row: index + 1, reason: 'duplicate of an entry already imported' })
      return
    }
    seenIds.add(id)
    if (videoId) seenVideos.add(videoId)
    if (videoUrl) seenVideos.add(videoUrl)
    seenKeys.add(key)
    entries.push({
      id, ...(videoUrl ? { video_url: videoUrl } : {}), ...(videoId ? { video_id: videoId } : {}),
      title, published_at: date, ...(episodeCode ? { episode_code: episodeCode } : {}),
      state: 'unlinked', source: 'import', imported_at: new Date().toISOString(),
      verified_at: null, verified_by: null,
    })
  })
  return { entries, refusals }
}

/** Coverage counts only VERIFIED entries with a real date; unlinked/dismissed never count. */
export function externalCoverage(
  entries: readonly ExternalPublication[],
  localDates: ReadonlySet<string> = new Set(),
): { verified: number; days: string[]; overlappingLocal: string[] } {
  const verified = entries.filter(entry => entry.state === 'verified' && parseExternalPublishedAt(entry.published_at))
  const days = [...new Set(verified.map(entry => entry.published_at.slice(0, 10)))].sort()
  return {
    verified: verified.length,
    days,
    overlappingLocal: days.filter(day => localDates.has(day)),
  }
}
