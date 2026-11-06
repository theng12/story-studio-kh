/**
 * The one finalization step. Preview and upload both call this, so what the
 * owner approves is byte-for-byte what the request carries.
 *
 * Spec section 8: "No hidden sanitizer may run afterward." Two corrections
 * used to happen after anyone could see them — `snippetFromMeta`'s cleanup,
 * and `youtube-client`'s silent downgrade of `privacyStatus` to `private`
 * whenever `publishAt` is set. Both are applied here instead and reported as
 * `modifications`, so the preview shows the real payload and says what changed.
 *
 * The sanitizer itself is NOT reimplemented: `snippetFromMeta` already owns
 * every YouTube limit and already narrates its own edits into a `logs` array.
 * That array is the source of the disclosure, so the two cannot drift.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { resolveUploadMetadata, snippetFromMeta } from '../lib/upload-metadata.js'
import * as pm from './project-manager.js'
import { getYoutubeDefaults } from './app-settings.js'
import { checkYouTubePublishDate, describeYouTubePublishDateProblem } from './youtube-publish-guard.js'
import type { PrivacyStatus, VideoSnippet, VideoStatus } from '../lib/youtube-client.js'

export interface YouTubeMetadataModification {
  field: 'title' | 'description' | 'tags' | 'category' | 'privacy'
  reason: string
}

export interface UploadChecklistItem {
  field: 'title' | 'description' | 'tags' | 'thumbnail' | 'schedule' | 'privacy' | 'category' | 'disclosure'
  label: string
  state: 'present' | 'missing' | 'not_checked'
  detail?: string
}

/** Presence information only; upload admission keeps its separate guards. */
export function uploadMetadataChecklist(
  snippet: VideoSnippet,
  status: VideoStatus,
  thumbnail: string | null | undefined,
): UploadChecklistItem[] {
  return [
    { field: 'title', label: 'Title', state: snippet.title?.trim() ? 'present' : 'missing' },
    { field: 'description', label: 'Description', state: snippet.description?.trim() ? 'present' : 'missing' },
    { field: 'tags', label: 'Tags', state: snippet.tags?.some(tag => tag.trim()) ? 'present' : 'missing' },
    { field: 'thumbnail', label: 'Thumbnail', state: thumbnail === undefined ? 'not_checked' : thumbnail ? 'present' : 'missing' },
    { field: 'schedule', label: 'Schedule', state: status.publishAt ? 'present' : 'missing', ...(status.publishAt ? {} : { detail: 'No publish date selected.' }) },
    { field: 'privacy', label: 'Visibility', state: status.privacyStatus ? 'present' : 'not_checked' },
    { field: 'category', label: 'Category', state: snippet.categoryId ? 'present' : 'missing' },
    { field: 'disclosure', label: 'AI disclosure choice', state: typeof status.containsSyntheticMedia === 'boolean' ? 'present' : 'not_checked' },
  ]
}

export interface YouTubeMetadataPackage {
  /** sha256 over the exact bytes the request will carry. */
  package_revision: string
  /** sha256 over the resolved source metadata. Doubles as the operation's `metadata_revision`. */
  source_sha256: string
  snippet: VideoSnippet
  status: VideoStatus
  modifications: YouTubeMetadataModification[]
  warnings: string[]
  checklist: UploadChecklistItem[]
  /** Resolved local thumbnail for this request. Not part of the video insert payload. */
  thumbnail_filename?: string | null
  /**
   * Whether the title/description are the OWNER's own text.
   *
   * The editorial strips are for a model's words. This says which text the
   * owner typed, so the page can offer to restore the generated description
   * and so the frozen payload carries the same answer.
   */
  authored: { title: boolean; description: boolean }
  /** Exactly what `acceptYouTubeOperation` persists, so equality is checkable. */
  final_payload: {
    snippet_json: string
    status_json: string
    source_sha256: string
    /**
     * Whether the frozen title is the owner's own text. FROZEN WITH THE
     * PAYLOAD, not re-derived later: a payload pushed back to YouTube days
     * after it was accepted must be read as it was frozen, not as whatever
     * the sidecar says today.
     */
    title_authored?: boolean
    /** Whether the frozen description is the owner's own text. */
    description_authored?: boolean
  }
}

/** Which field a sanitizer log line is talking about. */
function fieldOf(line: string): YouTubeMetadataModification['field'] {
  const text = line.toLowerCase()
  if (text.includes('tag')) return 'tags'
  if (text.includes('categor')) return 'category'
  if (text.includes('description')) return 'description'
  return 'title'
}

/** Stable key order, so the same payload always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Rehydrate the server-approved payload carried by a queued upload. A blank
 * title or description is refused HERE, on the bytes that would be sent, so
 * every frozen or recovered path is covered. The live metadata is never
 * consulted: a valid approval stays valid even if the sidecar has changed.
 */
export function metadataPackageFromFinalPayload(
  finalPayload: YouTubeMetadataPackage['final_payload'],
  episodeCode: string,
): YouTubeMetadataPackage {
  const snippet = JSON.parse(finalPayload.snippet_json) as VideoSnippet
  const status = JSON.parse(finalPayload.status_json) as VideoStatus
  const blank = (['title', 'description'] as const).filter(field => !snippet[field]?.trim())
  if (blank.length) {
    throw new Error(
      `${episodeCode} has a blank ${blank.join(' and ')} in the approved upload details. `
      + 'Review and confirm the exact video and YouTube details again; nothing was uploaded.',
    )
  }
  return {
    package_revision: sha256(canonical({ snippet, status })),
    source_sha256: finalPayload.source_sha256,
    snippet,
    status,
    modifications: [],
    warnings: ['Using the exact metadata approved before this YouTube upload was queued.'],
    checklist: uploadMetadataChecklist(snippet, status, undefined),
    authored: {
      title: finalPayload.title_authored === true,
      description: finalPayload.description_authored === true,
    },
    final_payload: finalPayload,
  }
}

/**
 * Re-run the sanitizer over a snippet that was stored earlier.
 *
 * `final_payload` is frozen at accept time, which is exactly what makes it
 * trustworthy as a record — and exactly why it can be STALE. A payload accepted
 * before a sanitizer rule existed still carries whatever that rule now removes,
 * so pushing those stored bytes would send what the current rule forbids.
 *
 * The sanitizer is idempotent, so for anything captured after the rule landed
 * this is a no-op. It reuses `snippetFromMeta` rather than restating any rule,
 * so a future rule is inherited here the same way.
 *
 * `title_authored` / `description_authored` say that the field holds the
 * OWNER's own text (saved in the episode's override sidecar) rather than a
 * model's. The editorial strips — markdown furniture, section labels, the URL
 * heuristic — apply to a model's words and NOT to the owner's, which is the
 * rule the resolver already follows at the read. Without this the push would
 * strip text the owner approved, and the bytes pushed would not be the bytes
 * the owner saw.
 */
export function resanitizeStoredSnippet(
  snippet: VideoSnippet,
  options: { title_authored?: boolean; description_authored?: boolean } = {},
): { snippet: VideoSnippet; changed: boolean } {
  const cleaned = snippetFromMeta(
    {
      title: snippet.title ?? '',
      description: snippet.description ?? '',
      tags: snippet.tags ?? [],
      thumbnailPath: '',
      ...(options.title_authored ? { title_from_override: true } : {}),
      ...(options.description_authored ? { description_from_override: true } : {}),
    },
    undefined,
    snippet.categoryId,
  )
  return { snippet: cleaned, changed: canonical(cleaned) !== canonical(snippet) }
}

/**
 * The disclosure flag and category a project actually uploads with.
 *
 * This rule - project config, else app default, else the built-in - lived in
 * THREE places that had drifted apart: the legacy backfill route, the upload
 * generator, and (as a hardcoded `true`) the Publish page's preview request.
 * So the "exact payload" panel printed "Marked as AI-generated: yes" while the
 * generator resolved the owner's real setting and sent something else. For a
 * project with disclosure turned OFF, the owner read that he had disclosed and
 * he had not - and disclosure is a compliance statement to YouTube, not a
 * preference.
 *
 * Resolving it HERE, once, is what makes the preview and the upload agree. Note
 * what this deliberately does NOT do: it does not freeze a package at preview
 * time and send that. The package is still rebuilt from live sources when the
 * upload runs - a stored payload replayed later is tell 6, and the guard
 * against a model or limit change between preview and send. Preview and send
 * match because they ask the same question of the same source, not because one
 * of them is a recording of the other.
 */
export async function resolveYouTubeUploadSettings(slug: string): Promise<{
  mark_as_ai_generated: boolean
  category_id?: number
}> {
  const [config, defaults] = await Promise.all([
    pm.getConfig(slug) as Promise<any>,
    getYoutubeDefaults(),
  ])
  const categoryId = typeof config?.category_id === 'number'
    && Number.isFinite(config.category_id) && config.category_id > 0
    ? config.category_id
    : defaults.default_yt_category_id
  return {
    mark_as_ai_generated: typeof config?.mark_as_ai_generated === 'boolean'
      ? config.mark_as_ai_generated
      : defaults.default_mark_as_ai_generated,
    ...(categoryId > 0 ? { category_id: categoryId } : {}),
  }
}

export async function buildYouTubeMetadataPackage(input: {
  project_slug: string
  episode_code: string
  privacy_status: PrivacyStatus
  publish_at?: string
  category_id?: string | number
  mark_as_ai_generated: boolean
  fallback_title?: string
  thumbnail_filename?: string | null
  /**
   * The title this upload goes up under, replacing the episode's own.
   *
   * 1.4.374 — a Short is its own video with its own title (the moment title
   * the passage was chosen for), while everything else — the description, the
   * tags, the thumbnail, the category — stays the episode's. The override is
   * applied HERE, before the sanitizer, so the Short's title is cleaned by
   * exactly the same rules the episode's title is.
   */
  title_override?: string
}): Promise<YouTubeMetadataPackage> {
  const meta = await resolveUploadMetadata({
    slug: input.project_slug,
    episode_code: input.episode_code,
    platform: 'youtube',
    ...(input.fallback_title !== undefined ? { fallback_title: input.fallback_title } : {}),
    ...(input.thumbnail_filename !== undefined ? { thumbnail_filename: input.thumbnail_filename } : {}),
  })
  if (typeof input.title_override === 'string' && input.title_override.trim()) {
    meta.title = input.title_override.trim()
    // The Short's title comes from the passage the model chose, so it is
    // MODEL text and the editorial strips apply to it — a `#` heading or
    // `**` marks in a Short title are furniture, exactly as they are in the
    // episode's. The platform's own limits still apply either way; they are
    // not conditional on this flag.
    meta.title_from_override = false
  }

  const logs: string[] = []
  const snippet = snippetFromMeta(meta, logs, input.category_id)
  const modifications: YouTubeMetadataModification[] = logs.map(line => ({ field: fieldOf(line), reason: line }))
  const warnings: string[] = []

  // The same rule youtube-client applies, applied where it can be seen.
  const scheduled = typeof input.publish_at === 'string' && input.publish_at.length > 0
  const privacyStatus: PrivacyStatus = scheduled ? 'private' : input.privacy_status
  if (scheduled && input.privacy_status !== 'private') {
    modifications.push({
      field: 'privacy',
      reason: `privacy set to private because a scheduled publish time is set (you chose ${input.privacy_status})`,
    })
  }

  if (scheduled) {
    // Reported, never corrected: rewriting the owner's schedule silently is
    // exactly the hidden edit this package exists to prevent. The words are
    // the provider's own, not a guess — a publishAt in the past is NOT
    // rejected by YouTube, it publishes the video right away
    // (https://developers.google.com/youtube/data/revision_history). Saying
    // "YouTube will reject it" was simply wrong, and a wrong warning is worse
    // than none: it reads as a guarantee that the video stays safe.
    const verdict = checkYouTubePublishDate(input.publish_at)
    if (!verdict.ok) warnings.push(describeYouTubePublishDateProblem(verdict.problem!, verdict.value))
  }

  const status: VideoStatus = {
    privacyStatus,
    ...(scheduled ? { publishAt: input.publish_at } : {}),
    containsSyntheticMedia: input.mark_as_ai_generated,
  }

  const source_sha256 = sha256(canonical({
    title: meta.title, description: meta.description, tags: meta.tags,
  }))

  // The authorship travels WITH the payload, so a payload frozen at accept
  // time can be read later as it was frozen. A record written before this
  // field existed carries no authorship and is treated as generated text —
  // which is what every payload before it was.
  const titleAuthored = meta.title_from_override === true
  const descriptionAuthored = meta.description_from_override === true

  return {
    package_revision: sha256(canonical({ snippet, status })),
    source_sha256,
    snippet,
    status,
    modifications,
    warnings,
    checklist: uploadMetadataChecklist(snippet, status, meta.thumbnailPath || null),
    ...(meta.thumbnailPath
      ? { thumbnail_filename: path.basename(meta.thumbnailPath) }
      : input.thumbnail_filename === null ? { thumbnail_filename: null } : {}),
    authored: { title: titleAuthored, description: descriptionAuthored },
    final_payload: {
      snippet_json: JSON.stringify(snippet),
      status_json: JSON.stringify(status),
      source_sha256,
      ...(titleAuthored ? { title_authored: true } : {}),
      ...(descriptionAuthored ? { description_authored: true } : {}),
    },
  }
}
