/**
 * Upload metadata resolver — reads the episode's Metadata Generator output
 * (docx-adjacent .json/.txt) and returns a platform-ready snippet.
 *
 * The Metadata Generator writes a JSON sidecar at `{episode}/02 Metadata/
 * {code}_Metadata.json` (primary) or a human-readable `.txt` (fallback).
 * We prefer the JSON for structured fields; fall back to parsing the txt
 * only when JSON is missing.
 *
 * Per-platform overrides (e.g. a different TikTok caption) are stored in
 * the episode's own sidecar: `{episode}/upload_metadata_overrides.json`.
 * Upload Center's override UI (not built yet in Phase 2) writes to that
 * file; this resolver merges it on top of the generator output.
 */

import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { resolveEpisodePaths } from '../services/utils.js'
import { parseMetadataTxt } from '../services/folder-migration.js'
import type { VideoSnippet } from './youtube-client.js'

export interface EpisodeMetadataForUpload {
  title: string
  description: string
  tags: string[]
  /** Highest-version thumbnail file on disk, or empty string if none. */
  thumbnailPath: string
}

export interface ResolveUploadMetadataInput {
  slug: string
  episode_code: string
  /** Episode title from the idea (used as last-resort fallback for title). */
  fallback_title?: string
  /** Platform id, for future per-platform override routing. */
  platform?: 'youtube' | 'tiktok' | 'facebook'
}

export async function resolveUploadMetadata(input: ResolveUploadMetadataInput): Promise<EpisodeMetadataForUpload> {
  const paths = await resolveEpisodePaths(input.slug, input.episode_code, input.fallback_title || '')

  // Prefer the JSON sidecar the Metadata Generator writes. Shape:
  //   { titles: string[], description: string, tags: string[], ... }
  // Older/txt-only episodes fall through to parsing the txt.
  let title = ''
  let description = ''
  let tags: string[] = []

  try {
    if (existsSync(paths.metadata_json)) {
      const raw = await fsp.readFile(paths.metadata_json, 'utf-8')
      const data = JSON.parse(raw)
      title = pickFirstNonEmpty([
        typeof data.title === 'string' ? data.title : '',
        Array.isArray(data.titles) ? data.titles.find((t: any) => typeof t === 'string' && t.trim()) : '',
      ])
      description = typeof data.description === 'string' ? data.description : ''
      tags = Array.isArray(data.tags) ? data.tags.filter((t: any) => typeof t === 'string' && t.trim()) : []
    }
  } catch { /* swallow — fall through to txt parse */ }

  if ((!title || !description || !tags.length) && existsSync(paths.metadata_txt)) {
    try {
      const raw = await fsp.readFile(paths.metadata_txt, 'utf-8')
      const parsed = parseMetadataTxt(raw)
      if (!title) {
        title = pickFirstNonEmpty([
          typeof parsed.title === 'string' ? parsed.title : '',
          parsed.description?.split('\n')[0] || '',
        ])
      }
      if (!description) description = parsed.description || ''
      if (!tags.length) tags = Array.isArray(parsed.tags) ? parsed.tags : []
    } catch { /* swallow */ }
  }

  // Per-platform overrides sidecar (optional).
  const overridesPath = path.join(paths.episode_dir, 'upload_metadata_overrides.json')
  if (existsSync(overridesPath)) {
    try {
      const raw = await fsp.readFile(overridesPath, 'utf-8')
      const data = JSON.parse(raw)
      const platformOverride = input.platform && typeof data[input.platform] === 'object' ? data[input.platform] : null
      if (platformOverride) {
        if (typeof platformOverride.title === 'string' && platformOverride.title.trim()) {
          title = platformOverride.title
        }
        if (typeof platformOverride.description === 'string') {
          description = platformOverride.description
        }
        if (Array.isArray(platformOverride.tags)) {
          tags = platformOverride.tags.filter((t: any) => typeof t === 'string' && t.trim())
        }
      }
    } catch { /* swallow */ }
  }

  // Last-resort title fallback — the idea's title. Never upload with an
  // empty title, YouTube rejects it.
  if (!title.trim()) {
    title = input.fallback_title || input.episode_code
  }

  // Resolve the thumbnail file. Two-tier:
  //   1. Pinned (per-platform `selected_thumbnail` in
  //      upload_metadata_overrides.json, set via the Images-page picker
  //      in v1.0.41+). Wins if the pinned filename still exists on disk.
  //   2. Auto-pick: highest `_v{N}` version, lex-desc tie-break. Files
  //      follow `{code}_Thumb{NN}_v{V}.png` or similar.
  // The auto rule preserves pre-v1.0.41 behaviour for episodes the user
  // never touched the picker for, so installs upgrade silently.
  let thumbnailPath = ''
  try {
    if (existsSync(paths.thumb_dir)) {
      const thumbs = await fsp.readdir(paths.thumb_dir)
      const validImages = thumbs.filter(f => /\.(png|jpe?g)$/i.test(f))

      // 1. Honour the pin if it points at a still-existing file.
      let pinned = ''
      if (existsSync(overridesPath)) {
        try {
          const raw = await fsp.readFile(overridesPath, 'utf-8')
          const data = JSON.parse(raw)
          const platformBlock = input.platform && typeof data[input.platform] === 'object' ? data[input.platform] : null
          if (platformBlock && typeof platformBlock.selected_thumbnail === 'string') {
            pinned = platformBlock.selected_thumbnail
          }
        } catch { /* fall through to auto-pick */ }
      }
      if (pinned && validImages.includes(pinned)) {
        thumbnailPath = path.join(paths.thumb_dir, pinned)
      } else {
        // 2. Fall back to auto-pick. Sort descending so '_v3' wins over
        // '_v2'/'_v1'; lexicographic tie-break covers `Thumb01_v1` vs
        // `Thumb02_v1` (later variant wins — preserves pre-v1.0.41
        // behaviour).
        const candidates = validImages
          .slice()
          .sort((a, b) => versionOf(b) - versionOf(a) || b.localeCompare(a))
        if (candidates.length) {
          thumbnailPath = path.join(paths.thumb_dir, candidates[0])
        }
      }
    }
  } catch { /* swallow */ }

  return {
    title: title.trim(),
    description,
    tags,
    thumbnailPath,
  }
}

function pickFirstNonEmpty(candidates: string[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

function versionOf(filename: string): number {
  const m = filename.match(/_v(\d+)\./i)
  return m ? parseInt(m[1], 10) : 0
}

// ── snippetFromMeta sanitization ──────────────────────────────────────────
// Everything user/LLM-generated funnels through here before hitting YouTube.
// A misbehaving provider could smuggle control chars, oversize payloads, or
// promotional URLs into the title; this is the last line of defense. Keep
// it synchronous and dependency-free — called from hot upload paths.

// YouTube Data API v3 hard limits (as of 2026). Verify against
// https://developers.google.com/youtube/v3/docs/videos if updating.
const YT_TITLE_MAX = 100
const YT_DESCRIPTION_MAX = 5000
const YT_TAGS_TOTAL_MAX = 500
const PER_TAG_MAX = 30
const MAX_TAGS = 15

// Strip ASCII control chars except \t (0x09) and \n (0x0A). YouTube accepts
// UTF-8 but not raw 0x00-0x1f (minus TAB/LF) or 0x7f; leaving them in risks
// a null byte or terminal escape landing in the description.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F]/g

// http(s)://… up to the next whitespace. Intentionally greedy on the path
// so query strings and fragments go with it.
const URL_RE = /https?:\/\/\S+/gi

function stripControl(s: string): string {
  return s.replace(CONTROL_CHARS_RE, '')
}

function capLength(s: string, max: number, label: string, logs?: string[]): string {
  if (s.length <= max) return s
  logs?.push(`${label} truncated ${s.length} → ${max} chars`)
  // Reserve 1 char for the ellipsis so the returned string never exceeds max.
  return s.slice(0, max - 1) + '…'
}

function stripUrlsFromTitle(s: string, logs?: string[]): string {
  if (!URL_RE.test(s)) return s
  URL_RE.lastIndex = 0
  const cleaned = s.replace(URL_RE, '').replace(/\s+/g, ' ').trim()
  logs?.push('⚠ URL stripped from title (prompt-injection heuristic)')
  return cleaned
}

function cleanTags(tags: string[], logs?: string[]): string[] {
  const inputCount = tags.filter(t => typeof t === 'string' && t.trim()).length
  const seen = new Set<string>()
  const out: string[] = []
  let totalLen = 0
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const cleaned = stripControl(raw).trim()
    if (!cleaned) continue
    const capped = cleaned.slice(0, PER_TAG_MAX)
    const key = capped.toLowerCase()
    if (seen.has(key)) continue
    // YouTube's 500-char budget counts each tag plus ~2 chars overhead
    // (separator; tags with spaces get wrapped in quotes too — reserve 4
    // to stay conservative).
    const overhead = capped.includes(' ') ? 4 : 2
    if (totalLen + capped.length + overhead > YT_TAGS_TOTAL_MAX) break
    if (out.length >= MAX_TAGS) break
    seen.add(key)
    out.push(capped)
    totalLen += capped.length + overhead
  }
  if (out.length < inputCount) {
    logs?.push(`tags trimmed ${inputCount} → ${out.length} (dedupe/length caps)`)
  }
  return out
}

// Exposed for unit tests only. Call `snippetFromMeta` for production paths.
export const __sanitize = { stripControl, capLength, stripUrlsFromTitle, cleanTags }

/**
 * Build the YouTube `snippet` payload from a project's metadata.
 *
 * `categoryId` defaults to `'24'` ("Entertainment") — the right bucket for
 * narrative AI / story-driven content (Story Studio's primary use case).
 * Older builds used `'22'` (People & Blogs); the Settings → YouTube backfill
 * action migrates existing projects to the new default. Coerced to string
 * because YouTube expects it as a string in the API.
 */
export const DEFAULT_YT_CATEGORY_ID = '24'

export function snippetFromMeta(meta: EpisodeMetadataForUpload, logs?: string[], categoryId?: string | number): VideoSnippet {
  // Title: strip control chars + angle brackets (YouTube rejects < and >
  // silently in titles), strip URLs with a warning, then cap length.
  let title = stripControl(meta.title).replace(/[<>]/g, '')
  title = stripUrlsFromTitle(title, logs)
  title = capLength(title.trim(), YT_TITLE_MAX, 'title', logs)

  // Description: strip control chars (keeping newlines/tabs for formatting),
  // then cap length. YouTube auto-escapes `<>` here, so we leave them.
  const description = capLength(stripControl(meta.description), YT_DESCRIPTION_MAX, 'description', logs)

  const tags = cleanTags(meta.tags, logs)

  // Coerce to string and validate it's a positive integer before sending —
  // YouTube rejects non-numeric or negative categoryIds with a vague
  // "invalid value" error.
  let resolvedCategoryId = DEFAULT_YT_CATEGORY_ID
  if (categoryId != null) {
    const asNum = typeof categoryId === 'number' ? categoryId : parseInt(String(categoryId), 10)
    if (Number.isFinite(asNum) && asNum > 0) {
      resolvedCategoryId = String(asNum)
    } else {
      logs?.push(`category_id "${categoryId}" is not a positive integer — falling back to ${DEFAULT_YT_CATEGORY_ID} (Entertainment)`)
    }
  }

  return {
    title,
    description,
    tags,
    categoryId: resolvedCategoryId,
  }
}
