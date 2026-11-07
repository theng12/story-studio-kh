/** YouTube Data API operation costs used by the app-scoped quota ledger. */
export const QUOTA_COST = {
  videos_insert: 1600,
  videos_update: 50,
  thumbnails_set: 50,
  channels_list: 1,
  playlist_items_list: 1,
  playlists_list: 1,
  playlists_insert: 50,
  playlist_items_insert: 50,
  videos_list: 1,
  video_categories_list: 1,
  comment_threads_list: 1,
  comments_insert: 50,
  // YouTube Data API captions costs, from Google's own endpoint pages
  // (developers.google.com/youtube/v3/docs/captions/{list,insert,update},
  // read 2026-11-07): list 50, insert 400, update 450 units. All three bill
  // against the same Cloud-project allowance as the other endpoints above.
  captions_list: 50,
  captions_insert: 400,
  captions_update: 450,
} as const

export type QuotaKey = keyof typeof QUOTA_COST

/** Translate the provider's quota response without guessing its configured limit. */
export function friendlyQuotaErrorMessage(respStatus: number, body: string): string | null {
  if (respStatus !== 403) return null
  let parsed: any
  try { parsed = JSON.parse(body) } catch { return null }
  const errors: any[] = parsed?.error?.errors || []
  const hit = errors.find(error => error?.reason === 'quotaExceeded' || error?.reason === 'dailyLimitExceeded')
  if (!hit) return null
  return [
    'YouTube API daily quota reached.',
    'Retry after the reset shown in Upload Center, or review the YouTube Data API quota in Google Cloud Console.',
  ].join(' ')
}
