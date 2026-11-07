/**
 * YouTube Channel Settings Contract (Item 20: Playlist inventory & End-Screen settings).
 *
 * Distinguishes honestly between:
 * 1. Remote YouTube integration (Playlists):
 *    Supported by YouTube Data API v3 (`playlists.list`, `playlistItems.insert`).
 *    Manages playlist inventory and channel default playlist assignment.
 * 2. End-screen SETUP PLAN (manual, local):
 *    YouTube Data API v3 has NO official endpoint for programmatic end-screen
 *    management, so Story Studio never claims a remote write. It saves the
 *    creator's plan (window, template, elements) and generates the exact steps
 *    to apply it by hand in YouTube Studio.
 *
 * Numeric bounds below are NOT guessed. Source, verified by fetch 2026-11-07:
 *   YouTube Help — "Add end screens to videos"
 *   https://support.google.com/youtube/answer/6388789
 *     "End screens can be added to the last 5–20 seconds of a video."
 *     "Your video has to be at least 25 seconds long to have an end screen."
 *     "You can add up to four elements to your end screen for videos with
 *      standard 16:9 aspect ratio." (other aspect ratios may allow fewer)
 */

export interface PlaylistSummary {
  id: string
  title: string
  description: string
  privacyStatus: 'public' | 'unlisted' | 'private'
  itemCount: number
}

export interface PlaylistInventoryState {
  account_id: string
  playlists: PlaylistSummary[]
  default_playlist_id: string
  cached_at: number | null
  count: number
  has_connected_account: boolean
}

export type EndScreenElementType =
  | 'subscribe'
  | 'best_for_viewer'
  | 'latest_upload'
  | 'playlist'
  | 'specific_video'

export interface EndScreenElement {
  id: string
  type: EndScreenElementType
  playlist_id?: string
  custom_video_id?: string
  label?: string
}

export type EndScreenTemplateId =
  | 'one_video_one_subscribe'
  | 'playlist_and_subscribe'
  | 'two_videos'
  | 'video_playlist_subscribe'
  | 'custom'

/**
 * A saved MANUAL plan for one video's end screen. Nothing here is rendered by
 * Story Studio: `notes_for_youtube_studio` is the deliverable the creator
 * follows inside YouTube Studio's editor.
 */
export interface EndScreenConfig {
  /** Window at the video's end the plan targets. YouTube allows 5–20 s. */
  duration_seconds: number
  /** Selected template preset (YouTube Studio's editor offers the same kind). */
  template: EndScreenTemplateId
  /** Planned elements, max 4 for standard 16:9. */
  elements: EndScreenElement[]
  /** Generated step-by-step instructions to apply the plan by hand. */
  notes_for_youtube_studio?: string
}

export interface YouTubeEndScreenCapability {
  readonly remote_api_supported: false
  readonly remote_status: 'unsupported_by_youtube_data_api_v3'
  readonly reason: string
  readonly manual_plan_supported: true
  /** Last 5–20 seconds — YouTube Help 6388789. */
  readonly min_duration_seconds: number
  readonly max_duration_seconds: number
  /** Video must be at least 25 s long — YouTube Help 6388789. */
  readonly min_video_length_seconds: number
  /** Up to four elements (standard 16:9) — YouTube Help 6388789. */
  readonly max_elements: number
}

export const YOUTUBE_END_SCREEN_CAPABILITY: YouTubeEndScreenCapability = Object.freeze({
  remote_api_supported: false,
  remote_status: 'unsupported_by_youtube_data_api_v3',
  reason:
    'YouTube Data API v3 does not expose an official endpoint for programmatic end-screen '
    + 'management. Story Studio saves your plan and writes out the steps to apply it by hand '
    + 'in YouTube Studio.',
  manual_plan_supported: true,
  min_duration_seconds: 5,
  max_duration_seconds: 20,
  min_video_length_seconds: 25,
  max_elements: 4,
})

export const END_SCREEN_TEMPLATES: Record<
  EndScreenTemplateId,
  { label: string; description: string; elements: (defaultPlaylistId?: string) => EndScreenElement[] }
> = {
  playlist_and_subscribe: {
    label: 'Playlist & Subscribe',
    description: 'Promotes your series playlist and the channel subscribe button.',
    elements: (defaultPlaylistId) => [
      { id: 'elem_playlist', type: 'playlist', playlist_id: defaultPlaylistId || '', label: 'Series Playlist' },
      { id: 'elem_sub', type: 'subscribe', label: 'Subscribe' },
    ],
  },
  one_video_one_subscribe: {
    label: '1 Video & 1 Subscribe',
    description: 'Recommends best video for viewer and channel subscribe button.',
    elements: () => [
      { id: 'elem_best', type: 'best_for_viewer', label: 'Best for viewer' },
      { id: 'elem_sub', type: 'subscribe', label: 'Subscribe' },
    ],
  },
  two_videos: {
    label: '2 Videos',
    description: 'Shows your latest upload alongside the best video for the viewer.',
    elements: () => [
      { id: 'elem_latest', type: 'latest_upload', label: 'Latest upload' },
      { id: 'elem_best', type: 'best_for_viewer', label: 'Best for viewer' },
    ],
  },
  video_playlist_subscribe: {
    label: 'Video, Playlist & Subscribe',
    description: 'Three elements: best for viewer, series playlist, and subscribe button.',
    elements: (defaultPlaylistId) => [
      { id: 'elem_best', type: 'best_for_viewer', label: 'Best for viewer' },
      { id: 'elem_playlist', type: 'playlist', playlist_id: defaultPlaylistId || '', label: 'Series Playlist' },
      { id: 'elem_sub', type: 'subscribe', label: 'Subscribe' },
    ],
  },
  custom: {
    label: 'Custom Layout',
    description: 'User-specified elements (up to 4 items).',
    elements: () => [
      { id: 'elem_sub', type: 'subscribe', label: 'Subscribe' },
    ],
  },
}

export function createDefaultEndScreenConfig(defaultPlaylistId?: string): EndScreenConfig {
  const template: EndScreenTemplateId = 'playlist_and_subscribe'
  const elements = END_SCREEN_TEMPLATES[template].elements(defaultPlaylistId)
  return {
    duration_seconds: 20,
    template,
    elements,
    notes_for_youtube_studio: buildYouTubeStudioGuidance({
      duration_seconds: 20,
      template,
      elements,
    }),
  }
}

export function formatSecondsToTimestamp(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00'
  const m = Math.floor(totalSeconds / 60)
  const s = Math.floor(totalSeconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(m)}:${pad(s)}`
}

export function buildYouTubeStudioGuidance(
  config: Pick<EndScreenConfig, 'duration_seconds' | 'elements' | 'template'>,
  videoDurationSeconds?: number,
  playlistTitle?: string,
): string {
  const duration = Math.max(5, Math.min(20, config.duration_seconds || 20))
  const lines: string[] = []

  lines.push('YouTube Studio End-Screen Setup (manual)')
  lines.push('---------------------------------------')
  lines.push('Story Studio cannot write end screens: the YouTube Data API v3 has no endpoint for it.')
  lines.push('Open YouTube Studio > Video details > Editor > End screen and follow these steps:')
  lines.push('')

  if (typeof videoDurationSeconds === 'number' && videoDurationSeconds > 0) {
    const startSec = Math.max(0, videoDurationSeconds - duration)
    lines.push(
      `Window: ${formatSecondsToTimestamp(startSec)} - ${formatSecondsToTimestamp(
        videoDurationSeconds,
      )} (the last ${duration}s; YouTube allows the last 5–20s)`,
    )
  } else {
    lines.push(`Window: the last ${duration} seconds of the video (YouTube allows 5–20s).`)
  }

  lines.push(`Elements (${config.elements.length} of max 4):`)
  config.elements.forEach((elem, idx) => {
    let desc = elem.label || elem.type
    if (elem.type === 'playlist') {
      desc = `Playlist (${playlistTitle || elem.playlist_id || 'Default channel playlist'})`
    } else if (elem.type === 'subscribe') {
      desc = 'Channel Subscribe button'
    } else if (elem.type === 'best_for_viewer') {
      desc = 'Video: Best for viewer'
    } else if (elem.type === 'latest_upload') {
      desc = 'Video: Most recent upload'
    } else if (elem.type === 'specific_video') {
      desc = `Specific Video: ${elem.custom_video_id || 'Enter video URL/ID in Studio'}`
    }
    lines.push(`  ${idx + 1}. ${desc}`)
  })
  lines.push('')
  lines.push('The video must be at least 25 seconds long for an end screen.')

  return lines.join('\n')
}

export function normalizeEndScreenConfig(
  raw: unknown,
  defaultPlaylistId?: string,
): EndScreenConfig {
  const fallback = createDefaultEndScreenConfig(defaultPlaylistId)
  if (!raw || typeof raw !== 'object') return fallback

  const candidate = raw as Record<string, any>

  let duration_seconds = Number(candidate.duration_seconds)
  if (!Number.isFinite(duration_seconds)) duration_seconds = 20
  duration_seconds = Math.max(5, Math.min(20, Math.round(duration_seconds)))

  const validTemplates: EndScreenTemplateId[] = [
    'one_video_one_subscribe',
    'playlist_and_subscribe',
    'two_videos',
    'video_playlist_subscribe',
    'custom',
  ]
  const template: EndScreenTemplateId = validTemplates.includes(candidate.template)
    ? candidate.template
    : 'playlist_and_subscribe'

  let elements: EndScreenElement[] = []
  if (Array.isArray(candidate.elements) && candidate.elements.length > 0) {
    const validTypes: EndScreenElementType[] = [
      'subscribe',
      'best_for_viewer',
      'latest_upload',
      'playlist',
      'specific_video',
    ]
    elements = candidate.elements
      .slice(0, 4)
      .map((item, idx) => {
        if (!item || typeof item !== 'object') {
          return { id: `elem_${idx + 1}`, type: 'subscribe' as const, label: 'Subscribe' }
        }
        const itemType = validTypes.includes(item.type) ? item.type : 'subscribe'
        return {
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `elem_${idx + 1}`,
          type: itemType,
          playlist_id: typeof item.playlist_id === 'string' ? item.playlist_id.trim() : undefined,
          custom_video_id:
            typeof item.custom_video_id === 'string' ? item.custom_video_id.trim() : undefined,
          label: typeof item.label === 'string' ? item.label.trim() : undefined,
        }
      })
  }

  if (elements.length === 0) {
    elements = END_SCREEN_TEMPLATES[template].elements(defaultPlaylistId)
  }

  const normalized: EndScreenConfig = {
    duration_seconds,
    template,
    elements,
  }

  normalized.notes_for_youtube_studio = buildYouTubeStudioGuidance(normalized)
  return normalized
}
