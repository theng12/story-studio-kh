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
import { OVERRIDES_FILENAME, resolveOverrideEpisodePaths } from '../services/upload-overrides.js'
import { assertVariantUploadable } from '../services/thumbnail-text-variants.js'
import { parseMetadataTxt } from '../services/metadata-format.js'
import type { VideoSnippet } from './youtube-client.js'
import { truncateChars, toWellFormedText } from './well-formed-text.js'
import { fitYouTubeDescription } from './youtube-description-limit.js'
import { stripInternalSectionLabels } from './metadata-label-leak.js'
import { isScaffoldTitleLine, stripMarkdownScaffold, stripTitleScaffold } from './metadata-scaffold.js'
import { YOUTUBE_TITLE_MAX_CHARACTERS } from './title-wrapping.js'

export interface EpisodeMetadataForUpload {
  title: string
  description: string
  tags: string[]
  /** Highest-version thumbnail file on disk, or empty string if none. */
  thumbnailPath: string
  /**
   * True when `title` came from the operator's own override sidecar rather
   * than from the generator.
   *
   * It is the difference between "a model wrote this" and "the owner typed
   * this", and the two are not cleaned the same way. The editorial strips
   * (the URL heuristic in a title, the markdown scaffold and the internal
   * section labels in a description) exist for generated text: they keep a
   * model's furniture off YouTube. They are not the owner's business — the
   * owner sees the result in the preview panel and approves it there.
   */
  title_from_override?: boolean
  /** True when `description` came from the operator's own override sidecar. */
  description_from_override?: boolean
}

export interface ResolveUploadMetadataInput {
  slug: string
  episode_code: string
  /** Episode title from the idea (used as last-resort fallback for title). */
  fallback_title?: string
  /** Platform id, for future per-platform override routing. */
  platform?: 'youtube' | 'tiktok' | 'facebook'
  /** Exact episode thumbnail chosen for this operation. Never accepts a path. */
  /** `null` explicitly selects no thumbnail; undefined keeps legacy auto-pick. */
  thumbnail_filename?: string | null
}

export interface UploadThumbnailOption {
  filename: string
  path: string
  is_pinned: boolean
}

export function validateUploadThumbnailFilename(filename: string): string {
  const requested = filename.trim()
  if (!requested || path.basename(requested) !== requested || !/\.(png|jpe?g)$/i.test(requested)) {
    throw new Error('thumbnail_filename must be a bare PNG/JPG filename')
  }
  return requested
}

/**
 * Drop text-layer variants whose source artwork changed.
 *
 * A text layer is a NEW file beside the art it was drawn on, so it sorts and pins like any other
 * thumbnail. When that art is re-rendered the text stays frozen in the old picture, which is a lie
 * about what the customer is about to upload — so a stale one is removed from BOTH the list and the
 * automatic pick here, at the one boundary every upload path reads (AGENTS §8).
 */
async function dropStaleTextLayers(options: UploadThumbnailOption[]): Promise<UploadThumbnailOption[]> {
  const kept: UploadThumbnailOption[] = []
  for (const option of options) {
    const refusal = await assertVariantUploadable(option.filename, path.dirname(option.path))
    if (!refusal) kept.push(option)
  }
  return kept
}

/**
 * Return every usable thumbnail for an episode in the same order as the
 * automatic picker. Paths are resolved server-side so callers never have to
 * construct or trust an arbitrary filesystem location from the browser.
 */
export async function listUploadThumbnails(input: ResolveUploadMetadataInput): Promise<UploadThumbnailOption[]> {
  const platform = input.platform || 'youtube'
  // The ONE resolver, shared with every writer of this sidecar: the folder a
  // read looks in and the folder a write lands in are the same folder, by
  // construction rather than by two implementations agreeing.
  const paths = await resolveOverrideEpisodePaths(
    input.slug, input.episode_code, input.fallback_title || '', platform,
  )
  if (!existsSync(paths.thumb_dir)) return []

  const filenames = sortByNewestVersion(
    (await fsp.readdir(paths.thumb_dir)).filter(filename => /\.(png|jpe?g)$/i.test(filename)),
  )

  let pinned = ''
  const overridesPath = path.join(paths.episode_dir, OVERRIDES_FILENAME)
  if (existsSync(overridesPath)) {
    try {
      const data = JSON.parse(await fsp.readFile(overridesPath, 'utf-8'))
      const platformBlock = typeof data[platform] === 'object' ? data[platform] : null
      if (platformBlock && typeof platformBlock.selected_thumbnail === 'string') {
        pinned = platformBlock.selected_thumbnail
      }
    } catch { /* an invalid optional override must not hide valid thumbnails */ }
  }

  const options = await dropStaleTextLayers(filenames.map(filename => ({
    filename,
    path: path.join(paths.thumb_dir, filename),
    is_pinned: filename === pinned,
  })))

  // A pin that is still on disk but was dropped as a STALE TEXT LAYER must not be answered with a
  // silent fall back to different artwork (2026-10-25). It is reported as a refusal by the caller
  // that can say so; here it is simply not offered as the pinned choice.
  return options
}

/**
 * The pinned filename when it names a text layer whose artwork has since changed.
 *
 * `null` when the pin is fine, or when it is missing for an ordinary reason. The upload preview
 * uses this to explain WHY the customer's pinned choice is not on offer, instead of showing a
 * different image without a word (AGENTS §4: announce what was dropped).
 */
export async function stalePinnedTextLayer(input: ResolveUploadMetadataInput): Promise<string | null> {
  const platform = input.platform || 'youtube'
  const paths = await resolveOverrideEpisodePaths(
    input.slug, input.episode_code, input.fallback_title || '', platform,
  )
  const overridesPath = path.join(paths.episode_dir, OVERRIDES_FILENAME)
  if (!existsSync(overridesPath)) return null
  let pinned = ''
  try {
    const data = JSON.parse(await fsp.readFile(overridesPath, 'utf-8'))
    const block = typeof data[platform] === 'object' ? data[platform] : null
    if (typeof block?.selected_thumbnail === 'string') pinned = block.selected_thumbnail
  } catch { return null }
  if (!pinned || !existsSync(path.join(paths.thumb_dir, pinned))) return null
  return await assertVariantUploadable(pinned, paths.thumb_dir)
}

/**
 * The scored pick for this episode, when one is usable.
 *
 * `undefined` means "no scored pick" — the caller falls back to today's
 * newest-version rule. A scored pick is used only when ALL of these hold:
 *
 *   - the channel's auto-pick switch is on,
 *   - the record names a pick whose basis was the SCORE (a pin was already
 *     honoured, and a newest-version fallback is today's rule, not a pick),
 *   - the scored file is still one of this episode's own candidates,
 *   - the file's CONTENT HASH still matches the one that was scored — a
 *     regenerated or edited picture's score is stale, so it is not used.
 *
 * The record is this episode's own sidecar, resolved through the SAME folder
 * resolver every other reader uses, so one episode's scores can never reach
 * another (§4).
 */
export async function scoredThumbnailPick(
  input: ResolveUploadMetadataInput,
  options: UploadThumbnailOption[],
): Promise<UploadThumbnailOption | undefined> {
  try {
    const { readChannelConfig } = await import('./optional-steps.js')
    const { thumbnailAutoPickEnabled, readThumbnailScoreRecord, thumbnailFileHash } =
      await import('../services/thumbnail-scoring.js')
    const config = readChannelConfig(input.slug)
    if (!config || !thumbnailAutoPickEnabled(config)) return undefined
    const platform = input.platform || 'youtube'
    const paths = await resolveOverrideEpisodePaths(
      input.slug, input.episode_code, input.fallback_title || '', platform,
    )
    const record = await readThumbnailScoreRecord(paths.episode_dir, input.episode_code)
    const pick = record.pick
    if (!pick || pick.basis !== 'score') return undefined
    const option = options.find(item => item.filename === pick.filename)
    if (!option) return undefined
    const entry = record.candidates?.[pick.filename]
    if (!entry?.sha256) return undefined
    const hash = await thumbnailFileHash(option.path).catch(() => '')
    if (!hash || hash !== entry.sha256) return undefined
    return option
  } catch {
    // A scoring record that cannot be read is no scored pick. The upload
    // falls back to the newest-version rule and nothing else changes.
    return undefined
  }
}

export async function resolveUploadMetadata(input: ResolveUploadMetadataInput): Promise<EpisodeMetadataForUpload> {
  // v1.0.524 — resolve BY CODE (drift-tolerant), not by the current idea
  // title. A title edited after upload used to make the title-based path miss
  // the real `{code} - {oldTitle}` folder → thumb_dir absent → thumbnail
  // silently skipped (the dominant cause of 262 missing thumbnails). This
  // finds the sibling folder that actually holds the upload sidecar (and its
  // thumbnails); non-drifted episodes resolve to the identical canonical path.
  const platform = input.platform || 'youtube'
  // The ONE resolver, shared with every writer of this sidecar: the folder a
  // read looks in and the folder a write lands in are the same folder, by
  // construction rather than by two implementations agreeing.
  const paths = await resolveOverrideEpisodePaths(
    input.slug, input.episode_code, input.fallback_title || '', platform,
  )

  // Prefer the JSON sidecar the Metadata Generator writes. Shape:
  //   { titles: string[], description: string, tags: string[], ... }
  // Older/txt-only episodes fall through to parsing the txt.
  let title = ''
  let description = ''
  let tags: string[] = []

  const metadataDir = path.dirname(paths.metadata_json)
  let metadataFiles: string[]
  try {
    metadataFiles = await fsp.readdir(metadataDir)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    metadataFiles = []
  }
  const escapedCode = input.episode_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const jsonPattern = new RegExp(`^${escapedCode}_Metadata(?:_v(\\d+))?\\.json$`, 'i')
  const txtPattern = new RegExp(`^${escapedCode}_Metadata(?:_v(\\d+))?\\.txt$`, 'i')
  const versioned = (pattern: RegExp) => metadataFiles.flatMap(filename => {
    const match = filename.match(pattern)
    return match ? [{ filename, version: match[1] ? Number(match[1]) : 1 }] : []
  }).sort((left, right) => right.version - left.version || right.filename.localeCompare(left.filename))

  let selectedVersion: number | null = null
  for (const candidate of versioned(jsonPattern)) {
    let raw: string
    try {
      raw = await fsp.readFile(path.join(metadataDir, candidate.filename), 'utf-8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let data: any
    try {
      data = JSON.parse(raw)
    } catch (error: unknown) {
      if (error instanceof SyntaxError) continue
      throw error
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const candidateTitle = pickUsableTitle([
      typeof data.title === 'string' ? data.title : '',
      ...(Array.isArray(data.title_options) ? data.title_options : []),
      ...(Array.isArray(data.titles) ? data.titles : []),
    ])
    const candidateDescription = typeof data.description === 'string' ? data.description : ''
    const candidateTags = Array.isArray(data.tags) ? data.tags.filter((t: any) => typeof t === 'string' && t.trim()) : []
    // A syntactically valid but empty metadata object is not a saved upload
    // result. Continue to an older usable version instead of allowing `{}` to
    // mask it.
    if (!candidateTitle && !candidateDescription.trim() && !candidateTags.length) continue
    // v1.4.84 — the saved title, unless what was saved is the metadata
    // document's own heading.
    //
    // Episodes have been published titled
    // `# SEO-Optimized Video Titles — EP0061`, because the generator picked
    // the model's list heading as title[0]. The generator no longer does
    // that, but the files are already on disk and their real titles are
    // sitting right beside them in `title_options`. Saved files are never
    // rewritten — the same rule as the section-label leak — so the recovery
    // happens here, on the way out. The operator clicking "Update metadata"
    // on one of those rows now pushes the title the document actually
    // contains, rather than being refused.
    title = candidateTitle
    description = candidateDescription
    tags = candidateTags
    selectedVersion = candidate.version
    break
  }

  if (!title || !description || !tags.length) {
    const textCandidates = versioned(txtPattern)
      .filter(candidate => selectedVersion === null || candidate.version === selectedVersion)
    for (const candidate of textCandidates) {
      let raw: string
      try {
        raw = await fsp.readFile(path.join(metadataDir, candidate.filename), 'utf-8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const parsed = parseMetadataTxt(raw)
      const candidateTitle = pickUsableTitle([
        typeof parsed.title === 'string' ? parsed.title : '',
        parsed.description?.split('\n')[0] || '',
      ])
      const candidateDescription = parsed.description || ''
      const candidateTags = Array.isArray(parsed.tags) ? parsed.tags.filter(tag => typeof tag === 'string' && tag.trim()) : []
      if (!candidateTitle && !candidateDescription.trim() && !candidateTags.length) continue
      if (!title) {
        // The txt's own TITLE section first. Only if that is missing do we
        // look at the description's opening line — and v1.4.84 requires that
        // line to look like a title, so a description that begins with
        // `# <the episode title as a markdown heading>` contributes nothing.
        // Falling back to a heading is what put document furniture on YouTube
        // in the first place.
        title = candidateTitle
      }
      if (!description) description = candidateDescription
      if (!tags.length) tags = candidateTags
      break
    }
  }

  // v1.4.75 — the generator's own output, cleaned of any internal section name
  // the model published as a heading. Deliberately BEFORE the override merge:
  // everything below this line is text the operator wrote himself, and his
  // words are not something to tidy. Upload Center reads this description
  // directly as well as through `snippetFromMeta`, so the clean has to happen
  // at the read, not only at the last gate.
  // v1.4.84 — and the markdown marks themselves, for the same reason and in
  // the same place: YouTube prints `**AI DISCLOSURE:**` with the asterisks in
  // it. The heading stays, the asterisks go.
  description = stripMarkdownScaffold(stripInternalSectionLabels(description))

  // Per-platform overrides sidecar (optional).
  //
  // `title_from_override` / `description_from_override` remember WHERE the text
  // came from. The strip above ran before this merge on purpose (v1.4.75), so
  // the operator's own words already reach here untouched — but `snippetFromMeta`
  // cleans once more at the last gate, and that clean is for generated text.
  // The flags let it tell the two apart, so an owner who typed a description
  // gets it word for word, chapter list included.
  let title_from_override = false
  let description_from_override = false
  const overridesPath = path.join(paths.episode_dir, OVERRIDES_FILENAME)
  if (existsSync(overridesPath)) {
    try {
      const raw = await fsp.readFile(overridesPath, 'utf-8')
      const data = JSON.parse(raw)
      const platformOverride = input.platform && typeof data[input.platform] === 'object' ? data[input.platform] : null
      if (platformOverride) {
        if (typeof platformOverride.title === 'string' && platformOverride.title.trim()) {
          title = platformOverride.title
          title_from_override = true
        }
        if (typeof platformOverride.description === 'string') {
          description = platformOverride.description
          description_from_override = true
        }
        if (Array.isArray(platformOverride.tags)) {
          tags = platformOverride.tags.filter((t: any) => typeof t === 'string' && t.trim())
        }
      }
    } catch (error: any) {
      // Surfaced, not swallowed (2026-10-07). Swallowing it uploaded the
      // generated title/description in place of the ones the owner typed,
      // with no word that his edits had been ignored.
      throw new Error(
        `${input.episode_code}'s upload_metadata_overrides.json could not be read (${error?.message || error}). `
        + 'Fix or remove that file in the episode folder, then try again. Nothing was uploaded.',
      )
    }
  }

  // Last-resort title fallback — the idea's title. Never upload with an
  // empty title, YouTube rejects it.
  if (!title.trim()) {
    title = input.fallback_title || input.episode_code
  }

  // Resolve the thumbnail file. Three-tier (owner, 2026-11-01):
  //   1. Pinned (per-platform `selected_thumbnail` in
  //      upload_metadata_overrides.json, set via the Images-page picker
  //      in v1.0.41+). Wins if the pinned filename still exists on disk, and
  //      is NEVER overwritten by a score.
  //   2. Scored pick: the highest-scoring candidate from this episode's own
  //      score record, when the channel's auto-pick switch is on and the
  //      scored file's content hash still matches (a regenerated picture's
  //      score is stale, so it is not used).
  //   3. Auto-pick: highest `_v{N}` version, lex-desc tie-break. Files
  //      follow `{code}_Thumb{NN}_v{V}.png` or similar.
  // Tiers 2 and 3 preserve pre-v1.0.41 behaviour for episodes the user
  // never touched the picker for, so installs upgrade silently.
  let thumbnailPath = ''
  if (input.thumbnail_filename === undefined) {
    const staleTextLayer = await stalePinnedTextLayer(input)
    if (staleTextLayer) throw new Error(staleTextLayer)
  }
  try {
    const options = await listUploadThumbnails(input)
    const requested = typeof input.thumbnail_filename === 'string' ? input.thumbnail_filename.trim() : ''
    if (input.thumbnail_filename === null) {
      thumbnailPath = ''
    } else if (requested) {
      // The API accepts a filename, never a path. This blocks traversal and
      // ensures an upload can only use media owned by this episode.
      const safeFilename = validateUploadThumbnailFilename(requested)
      const exact = options.find(option => option.filename === safeFilename)
      if (!exact) {
        // A text layer that exists on disk but names changed artwork is refused by name: "choose
        // another image" would hide the reason and invite the same mistake again (AGENTS §8).
        const staleTextLayer = await assertVariantUploadable(safeFilename, paths.thumb_dir)
        throw new Error(staleTextLayer
          || `Thumbnail "${requested}" is no longer available for ${input.episode_code}. Reopen Upload preview and choose another image.`)
      }
      thumbnailPath = exact.path
    } else {
      // The order is the owner's: a HUMAN PIN ALWAYS WINS, then the scored
      // pick, then today's newest-version rule. The scored pick is only used
      // when this channel's auto-pick switch is on AND the scored file's
      // content hash still matches — a regenerated picture's score is stale,
      // so it is not used (§4: episode state must not survive a change).
      const pinned = options.find(option => option.is_pinned)
      const scored = pinned ? undefined : await scoredThumbnailPick(input, options)
      thumbnailPath = (pinned || scored || options[0])?.path || ''
    }
  } catch (error) {
    // Explicit choices are a completion contract: never silently replace the
    // user's selection. Legacy automatic resolution remains best-effort.
    if (input.thumbnail_filename !== undefined) throw error
    // A pinned-but-stale text layer is the ONE automatic case that must not fall back quietly: the
    // customer chose that picture, and uploading different art in its place is the defect the
    // staleness rule exists to prevent.
    if (error instanceof Error && /re-apply it to the current artwork/.test(error.message)) throw error
  }

  return {
    title: title.trim(),
    description,
    tags,
    thumbnailPath,
    ...(title_from_override ? { title_from_override: true } : {}),
    ...(description_from_override ? { description_from_override: true } : {}),
  }
}

/**
 * Refuse an upload whose details are only a title.
 *
 * `resolveUploadMetadata` deliberately keeps working when an episode has no
 * metadata file: it falls back to the idea's title, and used to return an empty
 * description rather than refusing. The upload then went out — publicly — with
 * a title, nothing else, and no word that anything was missing, which is the
 * exact "title-only fallback" shape this project recorded. A published video
 * with no description cannot be fixed by a later upload; it needs a second
 * provider write.
 *
 * So the check is a preflight on the upload path (`generators/youtube-upload`),
 * not inside the resolver: `resolveUploadMetadata` feeds previews and thumbnail
 * pickers too, and those must be able to SHOW an empty description. The message
 * names the episode and the missing field, and the job fails loudly (§8) rather
 * than skipping the step.
 */
export function assertUploadMetadataComplete(
  meta: Pick<EpisodeMetadataForUpload, 'title' | 'description'>,
  episodeCode: string,
): void {
  const missing: string[] = []
  if (!meta.title || !meta.title.trim()) missing.push('title')
  if (!meta.description || !meta.description.trim()) missing.push('description')
  if (!missing.length) return
  const fields = missing.length === 2 ? 'title and description' : missing[0]!
  throw new Error(
    `${episodeCode} has no ${fields} to publish, so nothing was uploaded. `
    + `Open the Metadata page for ${episodeCode}, generate or write its ${fields}, then publish again. `
    + 'Story Studio will not publish a video whose details are only part of what YouTube needs.',
  )
}

function pickFirstNonEmpty(candidates: string[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

/**
 * The first candidate that is a title rather than a piece of the document that
 * held it — no markdown heading, no echo of the instruction we gave the model,
 * no `EPISODE EP0061 —` label. Falls back to the first non-empty candidate so
 * that an episode whose every candidate is furniture still resolves to
 * something; the publish gate refuses that case out loud rather than here.
 */
function pickUsableTitle(candidates: string[]): string {
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.trim()) continue
    if (isScaffoldTitleLine(c)) continue
    const cleaned = stripTitleScaffold(c)
    if (cleaned) return cleaned
  }
  return pickFirstNonEmpty(candidates)
}

function versionOf(filename: string): number {
  const m = filename.match(/_v(\d+)\./i)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * Today's newest-version rule, as ONE function.
 *
 * Highest `_v{N}` first, then lexicographic descending — the order
 * `listUploadThumbnails` puts the files in, and the order the upload takes
 * when nothing else chose. Exported so every other reader of "which file
 * would the upload pick" applies the SAME rule instead of carrying its own
 * copy: a second copy is how the picker and the uploader drift apart.
 */
export function sortByNewestVersion(filenames: string[]): string[] {
  return filenames.slice().sort((a, b) => versionOf(b) - versionOf(a) || b.localeCompare(a))
}

// ── snippetFromMeta sanitization ──────────────────────────────────────────
// Everything user/LLM-generated funnels through here before hitting YouTube.
// A misbehaving provider could smuggle control chars, oversize payloads, or
// promotional URLs into the title; this is the last line of defense. Keep
// it synchronous and dependency-free — called from hot upload paths.

// YouTube Data API v3 hard limits (as of 2026). Verify against
// https://developers.google.com/youtube/v3/docs/videos if updating.
// Exported so the Upload Center's own validation quotes the SAME figure
// rather than a copy of it that can drift. The number itself lives once, in
// the shared title helper that also refuses an over-limit composed title.
export const YT_TITLE_MAX = YOUTUBE_TITLE_MAX_CHARACTERS
export const YT_TAGS_TOTAL_MAX = 500
const PER_TAG_MAX = 30
const MAX_TAGS = 15

// Strip ASCII control chars except \t (0x09) and \n (0x0A). YouTube accepts
// UTF-8 but not raw 0x00-0x1f (minus TAB/LF) or 0x7f; leaving them in risks
// a null byte or terminal escape landing in the description.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F]/g

// http(s)://… up to the next whitespace. Intentionally greedy on the path
// so query strings and fragments go with it.
const URL_RE = /https?:\/\/\S+/gi
const PRIVATE_YOUTUBE_DESCRIPTION_MARKER_RE = /^[\t ]*<!--[\t ]*youtube:(?:chapters|sources|lyrics):(start|end)[\t ]*-->[\t ]*(?:\r?\n|(?![\s\S]))/gim

function stripControl(s: string): string {
  // Also repairs a lone surrogate: YouTube is a UTF-8 API and a model-written
  // title routinely carries emoji. See lib/well-formed-text.ts.
  return toWellFormedText(s.replace(CONTROL_CHARS_RE, ''))
}

function capLength(s: string, max: number, label: string, logs?: string[]): string {
  if (s.length <= max) return s
  logs?.push(`${label} truncated ${s.length} → ${max} chars`)
  // Reserve 1 char for the ellipsis so the returned string never exceeds max.
  return truncateChars(s, max - 1) + '…'
}

function stripUrlsFromTitle(s: string, logs?: string[]): string {
  if (!URL_RE.test(s)) return s
  URL_RE.lastIndex = 0
  const cleaned = s.replace(URL_RE, '').replace(/\s+/g, ' ').trim()
  logs?.push('⚠ URL stripped from title (prompt-injection heuristic)')
  return cleaned
}

function cleanDescriptionForYouTube(s: string, logs?: string[]): string {
  const markerStripped = s.replace(PRIVATE_YOUTUBE_DESCRIPTION_MARKER_RE, '')
  const withoutMarkers = markerStripped !== s ? markerStripped.trimEnd() : markerStripped
  if (markerStripped !== s) logs?.push('private YouTube description markers removed')

  const withoutAngles = withoutMarkers.replace(/[<>]/g, '')
  if (withoutAngles !== withoutMarkers) logs?.push('angle brackets removed from description')
  return withoutAngles
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
    const capped = truncateChars(cleaned, PER_TAG_MAX)
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
  // The URL heuristic and the scaffold strip are for a MODEL's words: a title
  // the owner typed keeps its URL and its formatting, because the owner saw
  // it in the preview panel and approved it there. The platform's own rules
  // (control characters, angle brackets, the length cap) still apply to both.
  if (!meta.title_from_override) {
    title = stripUrlsFromTitle(title, logs)
    // v1.4.84 — a title is one line of plain text. Anything markdown about it
    // came from the document it was read out of, and YouTube would show it.
    const beforeScaffold = title
    title = stripTitleScaffold(title)
    if (title !== beforeScaffold.trim()) logs?.push('formatting marks removed from the title')
  }
  title = capLength(title.trim(), YT_TITLE_MAX, 'title', logs)

  // Description: strip control chars (keeping newlines/tabs for formatting),
  // drop any internal section name the model published as a heading, remove
  // the finalizer's private block markers, then cap length. YouTube rejects
  // literal angle brackets in both titles and descriptions.
  //
  // v1.4.75 — the last gate before the Data API. `resolveUploadMetadata`
  // already cleaned the generator's output; this repeats it (the strip is
  // idempotent) for callers that assemble a snippet from stored data by
  // another route. A package saved before the prompt fix keeps its leaked
  // `HOOK:` on disk forever — the Finalizer reuses a complete
  // `existing_package` rather than respend credits, so nothing guarantees the
  // description is ever regenerated.
  //
  // NOTE for whoever builds the per-platform description override UI: today
  // nothing writes that field, so this only ever sees generated text. Once an
  // operator can type a description here, move this strip so it runs before
  // his override lands, the way the resolver already does.
  // 2026-10-07 — the cap is YouTube's own unit: 5,000 BYTES (4,900 with
  // headroom). It used to be 5,000 characters, which let a Khmer description
  // reach ~15,000 bytes and the upload be refused. Fit before the private
  // markers are stripped so the chapter list is recognised and kept whole.
  // v1.4.347 — the operator's own words bypass the editorial strips (scaffold,
  // internal section labels), the same way the resolver already lets them past
  // at the read. Platform-authoritative constraints — control characters,
  // private marker removal, angle brackets, the 4,900-byte cap — still apply
  // to both. The NOTE from v1.4.75 ("move this strip so it runs before his
  // override lands, the way the resolver already does") is answered here:
  // when the text is the owner's, the editorial strips do not run at all.
  const rawDescription = stripControl(meta.description)
  const editoriallyStripped = meta.description_from_override
    ? rawDescription
    : stripMarkdownScaffold(stripInternalSectionLabels(rawDescription))
  const fitted = fitYouTubeDescription(editoriallyStripped)
  if (fitted.trimmed) logs?.push(`description trimmed ${fitted.bytes_before} → ${fitted.bytes_after} bytes (YouTube limit), chapter list kept`)
  const description = cleanDescriptionForYouTube(fitted.description, logs)

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
