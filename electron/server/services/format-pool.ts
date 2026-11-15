import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { normaliseFormatPool, type FormatPool, type FormatPoolMember, type LiveFormatPool } from '../contracts/format-pool.js'
import { EpisodeSettingFileUnreadable, episodeDir, isEpisodeCode } from './episode-sketch-pen.js'

/**
 * The format pool's per-episode half: which member this episode runs under.
 *
 * Lives in the episode's folder beside `sketch_pen.json` — not in config.json
 * (channel-wide), not in a preset (round-trips), not in a generated artifact
 * (regenerated). A read never creates the file; only an assignment write or a
 * generation-time pin does, and a write never creates the episode folder.
 *
 * The pick is FNV-1a over the episode id — same id, same pool order, same
 * member, on every machine and every reload — and generation pins it to disk
 * so editing the pool later never reshuffles episodes that already ran.
 */
export const EPISODE_FORMAT_ASSIGNMENT_FILENAME = 'format_assignment.json'

export interface ResolvedFormatAssignment {
  member: FormatPoolMember
  /** 0-based index in the pool as it stands today (for "member 3 of 5" copy). */
  index: number
  /** 'stored' = an explicit or already-pinned choice; 'pooled' = picked by the hash this call. */
  source: 'stored' | 'pooled'
}

/** FNV-1a over UTF-16 code units — stable across runs, machines and Node versions. */
export function formatMemberIndex(episodeId: string, count: number): number {
  let hash = 2166136261
  for (let i = 0; i < episodeId.length; i++) {
    hash ^= episodeId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % count
}

/** The episode's stored member id, or null. A read never creates the file. */
export async function readEpisodeFormatAssignment(slug: string, episodeId: string): Promise<string | null> {
  const file = path.join(await episodeDir(slug, episodeId), EPISODE_FORMAT_ASSIGNMENT_FILENAME)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new EpisodeSettingFileUnreadable(
      `This episode's format assignment file (${EPISODE_FORMAT_ASSIGNMENT_FILENAME} for ${episodeId}) is malformed and cannot be read. Pick its format again on the YouTube Finalizer page to rewrite it.`,
    )
  }
  const memberId = (value as { member_id?: unknown } | null)?.member_id
  if (memberId === null || memberId === undefined) return null
  if (typeof memberId !== 'string' || !memberId.trim()) {
    throw new EpisodeSettingFileUnreadable(
      `This episode's format assignment file (${EPISODE_FORMAT_ASSIGNMENT_FILENAME} for ${episodeId}) names an unknown format. Pick its format again on the YouTube Finalizer page to rewrite it.`,
    )
  }
  return memberId
}

/**
 * Set the episode's member, or null to hand it back to the deterministic pick.
 * Never creates an episode folder just to hold an assignment.
 */
export async function writeEpisodeFormatAssignment(slug: string, episodeId: string, memberId: string | null): Promise<void> {
  if (memberId !== null && (typeof memberId !== 'string' || !memberId.trim())) throw new Error('Choose a format from the pool.')
  const dir = await episodeDir(slug, episodeId)
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`Episode ${episodeId} has no folder yet.`)
  const file = path.join(dir, EPISODE_FORMAT_ASSIGNMENT_FILENAME)
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, member_id: memberId, updated_at: new Date().toISOString() })
  })
}

/**
 * The member this episode runs under, or null when the pool is off/absent.
 *
 * A stored choice wins while it still names a live member (one the owner has
 * not removed from the pool); otherwise the episode id picks one. `persist`
 * pins that pick — generation and render contexts only, and best-effort: the
 * hash is the contract, storage only shields the episode from later pool
 * edits, so a pin failure must never fail a run that already may have cost
 * credits. A malformed assignment file is NOT swallowed: it is thrown as
 * EpisodeSettingFileUnreadable so the state stays honest.
 */
export async function resolveEpisodeFormatAssignment(
  slug: string,
  episodeId: string,
  pool: FormatPool | null,
  opts?: { persist?: boolean },
): Promise<ResolvedFormatAssignment | null> {
  if (!pool?.members?.length || !isEpisodeCode(episodeId)) return null
  const stored = await readEpisodeFormatAssignment(slug, episodeId)
  if (stored) {
    const index = pool.members.findIndex(member => member.id === stored)
    if (index >= 0) return { member: pool.members[index]!, index, source: 'stored' }
    // The stored member was removed from the pool: fall through and repin.
  }
  const index = formatMemberIndex(episodeId, pool.members.length)
  const member = pool.members[index]!
  if (opts?.persist) {
    await writeEpisodeFormatAssignment(slug, episodeId, member.id).catch(() => { /* pin is best-effort; see doc */ })
  }
  return { member, index, source: 'pooled' }
}

/**
 * The member's thumbnail fields over a generation request — shell, template
 * and lettering. Fields the member leaves out keep the request's (and then
 * the channel's) existing fallbacks, so a member that only changes the title
 * style leaves the thumbnail path byte-identical.
 */
export function overlayThumbnailRequest<T extends Record<string, any>>(request: T, member: FormatPoolMember): T {
  const out: Record<string, any> = { ...request }
  if (member.thumbnail_shell_id !== undefined) out.thumbnail_shell_id = member.thumbnail_shell_id
  if (member.thumbnail_template_id !== undefined) out.thumbnail_template_id = member.thumbnail_template_id
  if (member.style_tag !== undefined) out.style_tag = member.style_tag
  if (member.thumb_font_style !== undefined) out.thumb_font_style = member.thumb_font_style
  if (member.thumb_text_style !== undefined) out.thumb_text_style = member.thumb_text_style
  if (member.thumb_text_position !== undefined) out.thumb_text_position = member.thumb_text_position
  return out as T
}

/**
 * The member's title style over a metadata request — the fields
 * generateMetadata's title chain reads (mode, channel prefix/suffix). Tone
 * guidance is not a request field; metadata.ts reads it from the member
 * directly above the Format's titleStyleHint.
 */
export function overlayTitleRequest<T extends Record<string, any>>(request: T, member: FormatPoolMember): T {
  const out: Record<string, any> = { ...request }
  if (member.title_mode !== undefined) out.title_mode = member.title_mode
  if (member.title_prefix !== undefined) out.title_prefix = member.title_prefix
  if (member.title_suffix !== undefined) out.title_suffix = member.title_suffix
  return out as T
}

/** Config field → pool in force. One reading of the owner's switch, used everywhere. */
export function formatPoolFromConfig(config: unknown): LiveFormatPool | null {
  return normaliseFormatPool((config as { format_pool?: unknown } | null | undefined)?.format_pool)
}
