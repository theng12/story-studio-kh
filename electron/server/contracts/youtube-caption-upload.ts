/**
 * Contract for optional integrated YouTube captions (closed captions / subtitle track) upload.
 *
 * Implements Item 17 of release 1.4.386:
 * - Off by default: `enabled: false`. When disabled, caption upload is completely bypassed.
 * - Does not burn subtitles into video pixels (burned subtitles are handled separately by render).
 * - Uploads the episode's subtitle track (.srt/.vtt) to YouTube's captions API for the uploaded video.
 * - Deduplication guard: detects existing captions and avoids duplicate caption tracks.
 * - Honest failure: caption failures are non-fatal to the main upload and preserve the remote video ID.
 */

export type CaptionDedupeMode = 'skip_if_exists' | 'replace_existing' | 'upload_always'

export type CaptionSourcePreference = 'auto' | 'stitched' | 'whisper' | 'custom'

export interface YouTubeCaptionSettings {
  /** Master switch. OFF by default. Normal video upload proceeds unchanged when false. */
  enabled: boolean
  /** BCP-47 language tag (e.g. 'en', 'km'). Defaults to 'en'. */
  language: string
  /** Display title for the subtitle track in YouTube's CC menu (e.g. 'English', 'Khmer'). */
  track_name: string
  /** Whether the uploaded track is marked as draft (not visible to public viewers). Default false. */
  is_draft: boolean
  /** How to handle an existing caption track in the same language. Default 'skip_if_exists'. */
  dedupe_mode: CaptionDedupeMode
  /**
   * Subtitle source preference:
   * 'auto': prefers stitched > whisper > direct episode .srt
   * 'stitched': only stitched full-episode subtitle
   * 'whisper': only raw whisper transcription
   * 'custom': specific file if provided
   */
  preferred_source: CaptionSourcePreference
  /** Optional custom path override if preferred_source is 'custom'. */
  custom_srt_path?: string
}

export const DEFAULT_YOUTUBE_CAPTION_SETTINGS: Readonly<YouTubeCaptionSettings> = Object.freeze({
  enabled: false,
  language: 'en',
  track_name: 'English',
  is_draft: false,
  dedupe_mode: 'skip_if_exists',
  preferred_source: 'auto',
})

export function normalizeCaptionUploadSettings(input: unknown): YouTubeCaptionSettings {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_YOUTUBE_CAPTION_SETTINGS }
  }
  const raw = input as Record<string, unknown>
  const enabled = raw.enabled === true
  const language = typeof raw.language === 'string' && raw.language.trim()
    ? raw.language.trim().toLowerCase()
    : 'en'

  let defaultName = 'English'
  if (language === 'km') defaultName = 'Khmer'
  else if (language === 'es') defaultName = 'Spanish'
  else if (language === 'ja') defaultName = 'Japanese'
  else if (language === 'fr') defaultName = 'French'
  else if (language === 'de') defaultName = 'German'

  const track_name = typeof raw.track_name === 'string' && raw.track_name.trim()
    ? raw.track_name.trim()
    : defaultName

  const is_draft = raw.is_draft === true
  const dedupe_mode: CaptionDedupeMode =
    raw.dedupe_mode === 'replace_existing' || raw.dedupe_mode === 'upload_always'
      ? raw.dedupe_mode
      : 'skip_if_exists'

  const preferred_source: CaptionSourcePreference =
    raw.preferred_source === 'stitched' || raw.preferred_source === 'whisper' || raw.preferred_source === 'custom'
      ? raw.preferred_source
      : 'auto'

  const custom_srt_path = typeof raw.custom_srt_path === 'string' && raw.custom_srt_path.trim()
    ? raw.custom_srt_path.trim()
    : undefined

  return {
    enabled,
    language,
    track_name,
    is_draft,
    dedupe_mode,
    preferred_source,
    ...(custom_srt_path ? { custom_srt_path } : {}),
  }
}

export interface ResolvedCaptionTrack {
  file_path: string
  format: 'srt' | 'vtt'
  language: string
  track_name: string
  size_bytes: number
  sha256: string
  cues_count: number
  content: string
}

export interface YouTubeRemoteCaption {
  id: string
  videoId: string
  language: string
  name: string
  isDraft: boolean
  status?: string
  lastUpdated?: string
}

export type CaptionUploadStatus =
  | 'uploaded'
  | 'updated'
  | 'skipped_disabled'
  | 'skipped_no_subtitles'
  | 'skipped_already_exists'
  | 'failed'

export interface CaptionUploadOutcome {
  status: CaptionUploadStatus
  remote_video_id: string
  caption_id?: string
  language?: string
  track_name?: string
  source_file?: string
  error?: string
  warning?: string
  details?: Record<string, unknown>
}

/** Checkpoint shape recorded in upload sidecar or job result. */
export interface YouTubeCaptionUploadCheckpoint {
  enabled: boolean
  status: CaptionUploadStatus
  caption_id?: string
  language?: string
  track_name?: string
  uploaded_at?: string
  source_sha256?: string
  source_file?: string
  error?: string
}

export function buildCaptionUploadCheckpoint(
  outcome: CaptionUploadOutcome,
  settings: YouTubeCaptionSettings,
): YouTubeCaptionUploadCheckpoint {
  return {
    enabled: settings.enabled,
    status: outcome.status,
    ...(outcome.caption_id ? { caption_id: outcome.caption_id } : {}),
    ...(outcome.language ? { language: outcome.language } : {}),
    ...(outcome.track_name ? { track_name: outcome.track_name } : {}),
    ...(outcome.status === 'uploaded' || outcome.status === 'updated'
      ? { uploaded_at: new Date().toISOString() }
      : {}),
    ...(outcome.details?.sha256 ? { source_sha256: String(outcome.details.sha256) } : {}),
    ...(outcome.source_file ? { source_file: outcome.source_file } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}
