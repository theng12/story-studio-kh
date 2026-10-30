/**
 * Still Posts — the channel's post store, its verification and its renderer.
 *
 * Owner, 2026-10-27. Two laws shape this module:
 *
 *  1. **The look (format), the layout (option) and the words (post) are three different things.**
 *     A format is never baked into a post; a post names the format and option it was made with and
 *     the renderer resolves both on every render.
 *  2. **Nothing here decides what is "done" by looking at a directory.** `verifyPostState` reads
 *     each artifact's own bytes, and a batch is complete only when every post has its art and a
 *     final in every requested frame (AGENTS §8).
 *
 * Characters are CHANNEL data: the roster lives in `config.json → still_posts.character_ids`, and a
 * post's `character_ids` must be a subset of it. Nothing about a character is stored in a preset.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import * as pm from './project-manager.js'
import { listCharacters, referenceImagePath } from './character-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { renderThumbnailText, type RenderBranding } from '../lib/thumbnail-text-render.js'
import { listThumbnailFonts } from '../lib/thumbnail-fonts.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'
import {
  cursorAfter,
  decideFont,
  normaliseFontPools,
  poolFontIds,
  type StillPostFontCursor,
  type StillPostFontPool,
  type StillPostFontPools,
} from '../contracts/still-post-fonts.js'
import { stillPostFormat, stillPostOption } from '../still-posts/catalog.js'
import {
  STILL_POST_ASPECTS,
  STILL_POST_CANVAS,
  STILL_POST_LANGUAGE_SCRIPT,
  isStillPostAspect,
  type ChannelCharacterRow,
  type StillPost,
  type StillPostArtifactState,
  type StillPostBranding,
  type StillPostAspect,
  type StillPostFinal,
  type StillPostFormat,
  type StillPostOption,
  type StillPostPanel,
  type StillPostPanelState,
  type StillPostState,
  type StillPostsBatchState,
  type StillPostsLanguage,
  type StillPostsProjectConfig,
  type StillPostsWorkspace,
  type StillPostPreset,
  type StillPostPresetData,
  type StillPostRedraw,
} from '../contracts/still-posts.js'

export const STILL_POSTS_DIRNAME = 'still-posts'
const POSTS_DIRNAME = 'posts'
const POST_JSON = 'post.json'

/** Validated at the one place that builds the path, so a route param cannot escape it. */
export function validatePostId(value: string): string {
  const id = String(value ?? '').trim()
  if (!/^post-[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw Object.assign(new Error(`Invalid post id '${id}'.`), { status: 400 })
  }
  return id
}

export function validateBatchId(value: string): string {
  const id = String(value ?? '').trim()
  if (!/^batch-[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw Object.assign(new Error(`Invalid batch id '${id}'.`), { status: 400 })
  }
  return id
}

export function projectRootFor(slug: string): string {
  return pm.getProjectDir(slug) || path.join(pm.projectsRoot(), slug)
}

export function stillPostsDir(slug: string): string {
  return path.join(projectRootFor(slug), STILL_POSTS_DIRNAME)
}

export function postsDir(slug: string): string {
  return path.join(stillPostsDir(slug), POSTS_DIRNAME)
}

/** Refit portraits are cached under the channel, never beside a character's own portrait. */
export function referenceCacheDir(slug: string): string {
  return path.join(stillPostsDir(slug), '.reference-cache')
}

export function postDir(slug: string, postId: string): string {
  return path.join(postsDir(slug), validatePostId(postId))
}

/** `p0.png` (one drawing, fitted to every frame) or `p0-1x1.png` (that frame's own drawing). */
export function panelArtFilename(index: number, aspect?: StillPostAspect): string {
  return aspect ? `p${index}-${aspect.replace(':', 'x')}.png` : `p${index}.png`
}

/** `final-p0-1x1.png` … one finished frame for one panel. */
export function finalFilename(index: number, aspect: StillPostAspect): string {
  return `final-p${index}-${aspect.replace(':', 'x')}.png`
}

/** The stored mode of a post. Absent = `single`, the behaviour every earlier record has. */
export function artModeOf(post: Pick<StillPost, 'art_mode'>): 'single' | 'per-size' {
  return post.art_mode === 'per-size' ? 'per-size' : 'single'
}

/** The art file a frame is drawn at, or the one fitted drawing in `single` mode. */
export function artFilenameFor(index: number, mode: 'single' | 'per-size', aspect: StillPostAspect): string {
  return mode === 'per-size' ? panelArtFilename(index, aspect) : panelArtFilename(index)
}

/** Every filename a post's folder may serve. Anything else is refused by the route. */
export function allowedArtifactNames(panelCount: number): Set<string> {
  const names = new Set<string>()
  for (let index = 0; index < panelCount; index++) {
    names.add(panelArtFilename(index))
    for (const aspect of STILL_POST_ASPECTS) {
      names.add(panelArtFilename(index, aspect))
      names.add(finalFilename(index, aspect))
    }
  }
  return names
}

// ── Config ─────────────────────────────────────────────────────────────────

export function stillPostsConfig(raw: Record<string, any> | null | undefined): StillPostsProjectConfig {
  const block = raw && typeof raw === 'object' ? (raw as any).still_posts : undefined
  if (!block || typeof block !== 'object') return {}
  return {
    character_ids: Array.isArray(block.character_ids)
      ? block.character_ids.filter((id: unknown): id is string => typeof id === 'string' && !!id.trim())
      : [],
    logo_path: typeof block.logo_path === 'string' && block.logo_path.trim() ? block.logo_path.trim() : null,
    handle: typeof block.handle === 'string' && block.handle.trim() ? block.handle.trim() : null,
  }
}

/**
 * The handle that will actually be burned in: the channel's own, unless the channel set a custom
 * one for Still Posts. Stored without a leading "@", shown with one.
 */
export function channelHandle(raw: Record<string, any> | null | undefined, config: StillPostsProjectConfig): string | null {
  const custom = (config.handle || '').trim().replace(/^@/, '')
  if (custom) return custom
  const profile = raw && typeof raw === 'object' ? (raw as any).channel_profile : undefined
  const own = typeof profile?.handle === 'string' ? profile.handle.trim().replace(/^@/, '') : ''
  return own || null
}

/** The logo file to draw, or null. A path that no longer exists draws nothing at all. */
export function channelLogoPath(raw: Record<string, any> | null | undefined, config: StillPostsProjectConfig): string | null {
  const candidates = [config.logo_path, raw && typeof raw === 'object' ? (raw as any).channel_logo_path : null]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && existsSync(candidate.trim())) return candidate.trim()
  }
  return null
}

// ── Characters (channel data) ──────────────────────────────────────────────

export interface ChannelCharacter extends ChannelCharacterRow {
  /** The refit portrait path the generator will attach, or null when the character has none. */
  portrait_path: string | null
}

/** Every character of THIS channel, with whether its reference art is really on disk. */
export async function listChannelCharacters(slug: string): Promise<ChannelCharacter[]> {
  const characters = await listCharacters(slug)
  return characters.map(character => {
    const images = character.references?.images || []
    const first = images[0]
    const portrait = first ? referenceImagePath(slug, character.id, first) : null
    const present = !!portrait && existsSync(portrait)
    return {
      id: character.id,
      name: character.name,
      description: character.description || '',
      has_reference: present,
      reference_count: images.filter(name => existsSync(referenceImagePath(slug, character.id, name))).length,
      portrait_url: present ? `/api/projects/${slug}/still-posts/characters/${character.id}/portrait` : null,
      portrait_path: present ? portrait : null,
    }
  })
}

/**
 * The channel's roster, resolved against the characters that exist NOW.
 *
 * A stored id that no longer resolves is dropped from the usable roster rather than kept as a
 * dangling selection — and `foreignCharacterIds` answers the other half of §6: an id that is not a
 * character of this channel is reported, never quietly used.
 */
export function resolveRoster(
  stored: readonly string[] | undefined,
  characters: readonly ChannelCharacter[],
): { ids: string[]; unknown: string[] } {
  const known = new Set(characters.map(character => character.id))
  const seen = new Set<string>()
  const ids: string[] = []
  const unknown: string[] = []
  for (const id of stored || []) {
    if (seen.has(id)) continue
    seen.add(id)
    if (known.has(id)) ids.push(id)
    else unknown.push(id)
  }
  return { ids: ids.slice(0, 10), unknown }
}

// ── Store ──────────────────────────────────────────────────────────────────

function postJsonPath(slug: string, postId: string): string {
  return path.join(postDir(slug, postId), POST_JSON)
}

export async function readPost(slug: string, postId: string): Promise<StillPost | null> {
  const file = postJsonPath(slug, postId)
  if (!existsSync(file)) return null
  return JSON.parse(await fs.readFile(file, 'utf-8')) as StillPost
}

/** Every post of the channel, newest first. A malformed record is skipped loudly, never silently. */
export async function listPosts(slug: string): Promise<StillPost[]> {
  const dir = postsDir(slug)
  if (!existsSync(dir)) return []
  let entries: string[] = []
  try { entries = await fs.readdir(dir) } catch { return [] }
  const posts: StillPost[] = []
  for (const entry of entries) {
    if (!entry.startsWith('post-')) continue
    try {
      const post = await readPost(slug, entry)
      if (post) posts.push(post)
    } catch (error: any) {
      console.warn(`[still-posts] skipping unreadable post '${entry}': ${error?.message || error}`)
    }
  }
  return posts.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1))
}

export async function writePost(slug: string, post: StillPost): Promise<StillPost> {
  const dir = postDir(slug, post.id)
  await fs.mkdir(dir, { recursive: true })
  const record: StillPost = { ...post, updated_at: new Date().toISOString() }
  await withLock(postJsonPath(slug, post.id), async () => {
    await writeJsonAtomic(postJsonPath(slug, post.id), record)
  })
  return record
}

/** Next free `post-NNNN` for the channel. Sequenced on disk so ids stay readable. */
export async function nextPostId(slug: string): Promise<string> {
  const posts = await listPosts(slug)
  let highest = 0
  for (const post of posts) {
    const match = /^post-(\d+)$/.exec(post.id)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `post-${String(highest + 1).padStart(4, '0')}`
}

/** A removal goes to the project's `_trash/`, never `rm` (repo rule). */
export async function trashPost(slug: string, postId: string): Promise<void> {
  const dir = postDir(slug, postId)
  if (!existsSync(dir)) return
  const trash = path.join(trashRootFor(dir, projectRootFor(slug), slug), 'still-posts', path.basename(dir))
  moveToTrashSync(dir, trash, 'still-post')
}

// ── Review: approval and redraws (owner, 2026-10-30) ───────────────────────

/** The Trash root every removed or replaced file of this channel goes under. */
function trashRootForChannel(slug: string, postId: string): string {
  return trashRootFor(postDir(slug, postId), projectRootFor(slug), slug)
}

/** Relative to the Trash root: where a redo's replaced drawings go. Kept apart from removed posts. */
export function redrawTrashDir(postId: string): string {
  return path.join('still-posts', 'redraws', validatePostId(postId))
}

/**
 * The fields a reviewer approves: the words, the scene text, the look, the frames and the characters.
 * A change to any of them makes the post a different post to approve.
 */
export function approvalKey(post: Pick<StillPost, 'format_id' | 'option_id' | 'language' | 'aspects' | 'character_ids' | 'panels'>): string {
  return JSON.stringify({
    format: post.format_id,
    option: post.option_id,
    language: post.language,
    aspects: post.aspects,
    characters: post.character_ids,
    panels: post.panels.map(panel => [panel.text, panel.scene_prompt]),
  })
}

/**
 * Move a drawing a redo is about to replace into the channel's Trash, and return where it went.
 *
 * Called only once the replacement exists on disk, so the old drawing is never gone before its
 * successor is ready. The record keeps a path relative to the Trash root, so the old and the new can
 * be compared later and the route can refuse anything outside this post's own folder.
 */
export function retireDrawing(
  slug: string,
  post: Pick<StillPost, 'id'>,
  file: string,
  panelId: string,
  aspect: StillPostAspect | null,
): StillPostRedraw {
  const at = new Date().toISOString()
  const stamp = at.replace(/[-:.TZ]/g, '').slice(0, 17)
  const root = trashRootForChannel(slug, post.id)
  const folder = path.join(redrawTrashDir(post.id), stamp)
  const moved = moveToTrashSync(file, path.join(root, folder, path.basename(file)), 'still-post-drawing')
  return { at, panel_id: panelId, aspect, trash_path: path.relative(root, moved) }
}

/** The file of one recorded redraw, or null when it is no longer in Trash or is not this post's. */
export function redrawFile(slug: string, postId: string, record: StillPostRedraw): string | null {
  const relative = path.normalize(String(record.trash_path || ''))
  const folder = redrawTrashDir(postId)
  if (path.isAbsolute(relative) || !relative.startsWith(folder + path.sep)) return null
  const file = path.join(trashRootForChannel(slug, postId), relative)
  return existsSync(file) ? file : null
}

export interface StillPostApprovalOutcome {
  approved: string[]
  cleared: string[]
  /** Each post that could not be approved, with the sentence that says why. Nothing else changed. */
  refused: Array<{ id: string, reason: string }>
}

/**
 * Approve or clear the approval of posts. Approval is only ever granted to a post that is complete in
 * every frame it asks for, verified from its files (AGENTS §8) — never because the page says so.
 */
export async function setPostApproval(slug: string, ids: readonly string[], approved: boolean): Promise<StillPostApprovalOutcome> {
  const outcome: StillPostApprovalOutcome = { approved: [], cleared: [], refused: [] }
  for (const raw of ids) {
    const id = validatePostId(raw)
    const post = await readPost(slug, id)
    if (!post) {
      outcome.refused.push({ id, reason: 'No such post in this channel.' })
      continue
    }
    if (!approved) {
      if (post.approved_at) await writePost(slug, { ...post, approved_at: null })
      outcome.cleared.push(id)
      continue
    }
    const state = await postStateFor(slug, post)
    if (!state.complete) {
      outcome.refused.push({
        id,
        reason: `Not finished: ${state.problems[0] || 'its drawing and finals are not complete.'} Fix it, then approve.`,
      })
      continue
    }
    await writePost(slug, { ...post, approved_at: new Date().toISOString() })
    outcome.approved.push(id)
  }
  return outcome
}

// ── The lettering font pool ────────────────────────────────────────────────
//
// The POOL is preset content (a reusable look, AGENTS §5). Where the rotation stands is CHANNEL
// runtime state — never a preset — so it lives in its own small file under the channel's
// `still-posts/` folder, per writing system, written atomically.

export const FONT_POOL_CURSOR_FILE = 'font-pool-cursor.json'

/** `{ "cursors": { "latn": { "last_font_id": "...", "last_index": 2 } } }` */
interface FontPoolCursorFile {
  cursors: Record<string, StillPostFontCursor>
}

export function fontPoolCursorPath(slug: string): string {
  return path.join(stillPostsDir(slug), FONT_POOL_CURSOR_FILE)
}

async function readCursorFile(slug: string): Promise<FontPoolCursorFile> {
  const file = fontPoolCursorPath(slug)
  if (!existsSync(file)) return { cursors: {} }
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as FontPoolCursorFile
    return { cursors: parsed && typeof parsed.cursors === 'object' && parsed.cursors ? parsed.cursors : {} }
  } catch {
    // A cursor we cannot read is a cursor we do not have: the next post starts the pool from its
    // first entry rather than pretending to know where it stopped.
    return { cursors: {} }
  }
}

/** Where the rotation stands for one script. Null = this channel has not assigned a face yet. */
export async function readFontPoolCursor(slug: string, script: string): Promise<StillPostFontCursor | null> {
  const cursor = (await readCursorFile(slug)).cursors[script]
  if (!cursor || typeof cursor !== 'object') return null
  return {
    last_font_id: typeof cursor.last_font_id === 'string' && cursor.last_font_id ? cursor.last_font_id : null,
    last_index: typeof cursor.last_index === 'number' && Number.isInteger(cursor.last_index) && cursor.last_index >= 0
      ? cursor.last_index
      : null,
  }
}

/**
 * Create one post, giving it a face from the channel's pool for its own script.
 *
 * Order matters and is the whole point: the cursor is advanced **only after the post record has
 * actually been written**, and the read-modify-write runs under one lock, so a failed write never
 * skips a face and two batches can never hand out the same one. A pool with no faces for the script
 * leaves the record exactly as it was before this feature (no `font_id`), so the format's own face
 * is used and nothing on disk changes shape.
 */
export async function createPostWithPoolFont(
  slug: string,
  script: string,
  pool: StillPostFontPool | null | undefined,
  build: () => StillPost,
  opts: { rng?: () => number } = {},
): Promise<StillPost> {
  if (!poolFontIds(pool).length) return writePost(slug, build())
  const file = fontPoolCursorPath(slug)
  return withLock(file, async () => {
    const state = await readCursorFile(slug)
    const chosen = decideFont(pool, state.cursors[script] || null, opts.rng)
    if (!chosen) return writePost(slug, build())
    const written = await writePost(slug, { ...build(), font_id: chosen.font_id })
    state.cursors[script] = cursorAfter(chosen.font_id, chosen.index)
    await fs.mkdir(stillPostsDir(slug), { recursive: true })
    await writeJsonAtomic(file, { cursors: state.cursors })
    return written
  })
}

/**
 * Refuse a pool that names a face this build does not ship, or one whose manifest does not list the
 * script it is being used for (AGENTS §1/§6).
 *
 * Never substitutes: a face that cannot draw Khmer is a plain sentence naming the face, because a
 * silently swapped face is a picture in the wrong writing system.
 */
export async function assertFontPoolCoversScript(
  pool: StillPostFontPool | null | undefined,
  script: string,
  languageLabel: string,
): Promise<void> {
  const ids = poolFontIds(pool)
  if (!ids.length) return
  const fonts = await listThumbnailFonts()
  for (const id of ids) {
    const font = fonts.find(entry => entry.id === id)
    if (!font) {
      throw new Error(
        `"${id}" is not one of this build's bundled fonts (${fonts.map(entry => entry.id).join(', ')}), `
        + `so it cannot letter ${languageLabel}. Nothing was drawn or written in an unchosen face.`,
      )
    }
    if (!font.scripts.includes(script)) {
      throw new Error(
        `${font.label} (${id}) does not cover ${languageLabel} (${script}), so it cannot letter it. `
        + `Choose a face whose font list includes ${script}. Nothing was drawn or written in a substituted face.`,
      )
    }
  }
}

/** Every script's pool in one payload, normalised against the shape the server will use. */
export function presetFontPools(value: unknown): StillPostFontPools {
  return normaliseFontPools(value)
}

// ── Verification ───────────────────────────────────────────────────────────

/** PNG/JPEG/WebP magic, so an empty or truncated file is never counted as a finished artifact. */
async function artifactState(file: string): Promise<StillPostArtifactState> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return 'invalid'
    if (stat.size < 512) return 'missing'
    const handle = await fs.open(file, 'r')
    try {
      const header = Buffer.alloc(12)
      const { bytesRead } = await handle.read(header, 0, 12, 0)
      if (bytesRead < 12) return 'invalid'
      const png = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
      const jpeg = header[0] === 0xff && header[1] === 0xd8
      const webp = header.subarray(0, 4).toString('latin1') === 'RIFF' && header.subarray(8, 12).toString('latin1') === 'WEBP'
      return png || jpeg || webp ? 'ok' : 'invalid'
    } finally {
      await handle.close()
    }
  } catch (error: any) {
    return error?.code === 'ENOENT' ? 'missing' : 'invalid'
  }
}

/** The worse of two artifact states. `invalid` outranks `missing`; `ok` absorbs everything else. */
function worseArtifactState(a: StillPostArtifactState, b: StillPostArtifactState): StillPostArtifactState {
  if (a === 'invalid' || b === 'invalid') return 'invalid'
  if (a === 'missing' || b === 'missing') return 'missing'
  return 'ok'
}

/**
 * What is really on disk for one post, per panel and per requested frame.
 *
 * A final whose recorded text no longer matches the panel's text is `stale`: the words were edited
 * and the picture still shows the old ones. That is the one drift a preset change does not cause,
 * and it is the one that would otherwise ship the wrong words.
 *
 * In `per-size` mode each requested frame must have its OWN drawing — one shared picture is not a
 * complete batch just because it can be fitted into every frame (AGENTS §8).
 */
export async function verifyPostState(slug: string, post: StillPost, aspects: readonly StillPostAspect[]): Promise<StillPostState> {
  const dir = postDir(slug, post.id)
  const mode = artModeOf(post)
  const problems: string[] = []
  const panels: StillPostPanelState[] = []
  const finalsByKey = new Map(post.finals.map(final => [`${final.panel_id}:${final.aspect}`, final]))

  for (const [index, panel] of post.panels.entries()) {
    const panelProblems: string[] = []
    const finals: Record<string, StillPostArtifactState> = {}
    let image: StillPostArtifactState
    let images: Record<string, StillPostArtifactState> | undefined

    if (mode === 'per-size') {
      images = {}
      image = 'ok'
      for (const aspect of aspects) {
        const state = await artifactState(path.join(dir, panelArtFilename(index, aspect)))
        images[aspect] = state
        image = worseArtifactState(image, state)
        if (state !== 'ok') {
          panelProblems.push(index === 0
            ? `The ${aspect} artwork is missing.`
            : `Panel ${index + 1}'s ${aspect} artwork is missing.`)
        }
      }
    } else {
      image = await artifactState(path.join(dir, panelArtFilename(index)))
      if (image !== 'ok') {
        panelProblems.push(index === 0 ? 'The artwork is missing.' : `Panel ${index + 1}'s artwork is missing.`)
      }
    }

    for (const aspect of aspects) {
      const final = finalsByKey.get(`${panel.id}:${aspect}`)
      if (!final) {
        finals[aspect] = 'missing'
        panelProblems.push(`No ${aspect} final has been made.`)
        continue
      }
      const onDisk = await artifactState(path.join(dir, final.filename))
      if (onDisk === 'ok' && final.text !== panel.text) {
        finals[aspect] = 'stale'
        panelProblems.push(`The ${aspect} final still shows the older words.`)
      } else {
        finals[aspect] = onDisk
        if (onDisk !== 'ok') panelProblems.push(`The ${aspect} final is unreadable.`)
      }
    }

    panels.push({ panel_id: panel.id, role: panel.role, image, ...(images ? { images } : {}), finals, problems: panelProblems })
  }

  for (const state of panels) problems.push(...state.problems)
  return { id: post.id, complete: problems.length === 0, panels, problems }
}

/** Aggregate a batch's state. Complete only when EVERY post is complete (§8). */
export function batchStateFrom(
  batchId: string,
  aspects: readonly StillPostAspect[],
  entries: readonly { post: StillPost; state: StillPostState }[],
): StillPostsBatchState {
  const completePosts = entries.filter(entry => entry.state.complete)
  const missing: string[] = []
  for (const entry of entries) {
    for (const problem of entry.state.problems) missing.push(`${entry.post.id}: ${problem}`)
  }
  return {
    batch_id: batchId,
    aspects: [...aspects],
    total: entries.length,
    complete_count: completePosts.length,
    complete: entries.length > 0 && completePosts.length === entries.length,
    posts: entries.map(entry => entry.state),
    missing,
  }
}

/** Every batch in the channel, derived from its posts (there is no separate batch file to drift). */
export async function listBatchStates(slug: string, posts: readonly StillPost[]): Promise<StillPostsBatchState[]> {
  const byBatch = new Map<string, StillPost[]>()
  for (const post of posts) {
    const list = byBatch.get(post.batch_id) || []
    list.push(post)
    byBatch.set(post.batch_id, list)
  }
  const states: StillPostsBatchState[] = []
  for (const [batchId, entries] of byBatch) {
    const aspects = unionAspects(entries)
    const verified = await Promise.all(entries.map(async post => ({
      post,
      state: await verifyPostState(slug, post, post.aspects.length ? post.aspects : aspects),
    })))
    states.push(batchStateFrom(batchId, aspects, verified))
  }
  return states.sort((a, b) => (a.batch_id < b.batch_id ? 1 : -1))
}

function unionAspects(posts: readonly StillPost[]): StillPostAspect[] {
  const seen = new Set<StillPostAspect>()
  for (const post of posts) for (const aspect of post.aspects) if (isStillPostAspect(aspect)) seen.add(aspect)
  return [...seen]
}

// ── Rendering ──────────────────────────────────────────────────────────────

/**
 * The frame the art is placed into for one export ratio.
 *
 * The picture is COMPOSED once and exported in three frames, so a 1:1 drawing is never re-imagined
 * as 9:16 (which would be a second paid render). A blurred, scaled copy of the same art fills the
 * new frame behind it and the whole picture is fitted inside, so nothing the customer paid for is
 * cropped away and every ratio looks deliberate rather than letterboxed.
 */
export async function frameArt(sourceBytes: Buffer, aspect: StillPostAspect): Promise<Buffer> {
  const canvas = STILL_POST_CANVAS[aspect]
  const meta = await sharp(sourceBytes).metadata()
  const sourceWidth = meta.width || canvas.width
  const sourceHeight = meta.height || canvas.height
  if (Math.abs(sourceWidth / sourceHeight - canvas.width / canvas.height) < 0.001) {
    return sharp(sourceBytes).resize(canvas.width, canvas.height, { fit: 'cover' }).png().toBuffer()
  }
  const backdrop = await sharp(sourceBytes)
    .resize(canvas.width, canvas.height, { fit: 'cover' })
    .blur(Math.max(8, Math.round(Math.min(canvas.width, canvas.height) * 0.03)))
    .modulate({ brightness: 0.7 })
    .png()
    .toBuffer()
  const foreground = await sharp(sourceBytes)
    .resize(canvas.width, canvas.height, { fit: 'inside' })
    .png()
    .toBuffer()
  const info = await sharp(foreground).metadata()
  const left = Math.max(0, Math.round((canvas.width - (info.width || canvas.width)) / 2))
  const top = Math.max(0, Math.round((canvas.height - (info.height || canvas.height)) / 2))
  return sharp(backdrop)
    .composite([{ input: foreground, left, top }])
    .png()
    .toBuffer()
}

/** Everything a render needs that is not stored on the post. */
export interface StillPostLook {
  format: StillPostFormat
  option: StillPostOption
  language: StillPostsLanguage
  /**
   * The face this post was given from the channel's pool when it was written, or absent.
   *
   * Absent = the format's own face for the post's script — today's behaviour, and what every post
   * recorded before the pool existed keeps.
   */
  font_id?: string | null
  /** Multiplies the fitted type size. */
  text_scale: number
  branding: RenderBranding
  /** Stable text for the handle and logo, used in the style hash. */
  brandingSignature: string
}

/**
 * Build the text style for one panel of one export frame.
 *
 * The format owns the look (font for the post's own script, weight, colour, outline, shadow,
 * leading) and the option owns the layout (the box, the alignment, the line budget). The post's
 * language picks the face; a script the format has no font for is refused rather than drawn in a
 * substituted face.
 */
export function textStyleFor(
  look: StillPostLook,
  panelIndex: number,
  aspect: StillPostAspect,
): ThumbnailTextStyle {
  const canvas = STILL_POST_CANVAS[aspect]
  const box = look.option.text[Math.min(panelIndex, look.option.text.length - 1)]!
  const script = STILL_POST_LANGUAGE_SCRIPT[look.language]
  // The post's own recorded face wins. With no pool (or a post written before the pool existed)
  // this is the format's face, byte-for-byte as before.
  const fontId = look.font_id || look.format.lettering.fonts[script]
  if (!fontId) {
    throw new Error(
      `${look.format.name} has no bundled font for ${look.language}. Choose another language or another format.`,
    )
  }
  const lettering = look.format.lettering
  const scale = Math.max(0.5, Math.min(2, Number(look.text_scale) || 1))
  // Type sizes are stated at the 1080 short edge and scaled to whatever frame is being drawn.
  const base = Math.min(canvas.width, canvas.height) / 1080
  return {
    font_id: fontId,
    weight: lettering.weight,
    size: {
      mode: 'fit',
      min_px: Math.max(10, Math.round(26 * base * scale)),
      max_px: Math.max(14, Math.round(76 * base * scale)),
    },
    max_lines: Math.max(1, box.max_lines),
    align: box.align,
    line_height: lettering.line_height,
    letter_spacing: 0,
    uppercase: lettering.uppercase,
    fill: { ...lettering.fill },
    opacity: 1,
    outline: { ...lettering.outline },
    shadow: { ...lettering.shadow },
    background: {
      enabled: look.option.text_background,
      color: look.format.text_panel.color,
      opacity: look.format.text_panel.opacity,
      padding_px: Math.round(look.format.text_panel.padding_px * base),
      radius_px: Math.round(look.format.text_panel.radius_px * base),
    },
    placement: {
      anchor: box.anchor,
      x_pct: box.x_pct,
      y_pct: box.y_pct,
      width_pct: box.width_pct,
      height_pct: box.height_pct,
    },
  }
}

/** Identity of everything one final is made from, so stale work is provable rather than assumed. */
export function styleHashFor(look: StillPostLook, panelIndex: number, aspect: StillPostAspect, text: string): string {
  const style = textStyleFor(look, panelIndex, aspect)
  return crypto.createHash('sha256')
    .update(JSON.stringify({ text, style, canvas: STILL_POST_CANVAS[aspect], branding: look.brandingSignature }))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Turn a preset's branding settings plus the channel's identity into the renderer's mark layer.
 *
 * A handle that is switched on but empty draws nothing (there is nothing true to draw), and a logo
 * that is switched on but absent draws nothing — which is exactly how a channel that has not made
 * its logo yet behaves, with no special case anywhere else.
 *
 * `base` scales the preset's 1080-edge type size to whichever frame is being drawn.
 */
export function brandingFor(
  preset: StillPostBranding,
  opts: {
    handle: string | null
    logoPath: string | null
    language: StillPostsLanguage
    format: StillPostFormat
    base?: number
  },
): RenderBranding {
  const wanted = (preset.handle_text || '').trim().replace(/^@/, '') || (opts.handle || '')
  const script = STILL_POST_LANGUAGE_SCRIPT[opts.language]
  const base = opts.base && opts.base > 0 ? opts.base : 1
  return {
    handle: {
      enabled: preset.handle_enabled && !!wanted,
      text: wanted ? `@${wanted}` : '',
      // Deliberately the FORMAT's face, never the post's pool face: the handle is the channel's mark
      // and must read the same on every post, while `textStyleFor` above owns the post's lettering.
      font_id: opts.format.lettering.fonts[script] || 'inter',
      weight: 500,
      size_px: Math.max(10, Math.round(preset.handle_size_px * base)),
      color: '#FFFFFF',
      opacity: Math.max(0, Math.min(1, preset.opacity)),
    },
    logo: {
      enabled: preset.logo_enabled && !!opts.logoPath,
      path: opts.logoPath,
      width_pct: Math.max(2, Math.min(60, preset.logo_width_pct)),
      opacity: Math.max(0, Math.min(1, preset.opacity)),
    },
    position: preset.position,
    margin_pct: Math.max(0, Math.min(20, preset.margin_pct)),
  }
}

/** Resolve the look a post is rendered with. Unknown ids are refused, never replaced. */
export function lookForPost(
  post: Pick<StillPost, 'format_id' | 'option_id' | 'language'> & { font_id?: string | null },
  branding: RenderBranding,
  textScale: number,
): StillPostLook {
  const format = stillPostFormat(post.format_id)
  if (!format) throw new Error(`Format "${post.format_id}" is not one of this build's Still Post formats.`)
  const option = stillPostOption(post.option_id)
  if (!option) throw new Error(`Option "${post.option_id}" is not one of this build's Still Post options.`)
  return {
    format,
    option,
    language: post.language,
    ...(post.font_id ? { font_id: post.font_id } : {}),
    text_scale: textScale,
    branding,
    brandingSignature: JSON.stringify(branding),
  }
}

export interface RenderedFinal {
  aspect: StillPostAspect
  panel_id: string
  filename: string
  png: Buffer
  text: string
  font_id: string
  style_hash: string
}

/**
 * Render every requested frame for every panel of one post.
 *
 * Returns buffers rather than writing, so the caller decides when a render is committed — a failed
 * render must never leave a half-written final that looks finished.
 */
export async function renderPostFinals(
  slug: string,
  post: StillPost,
  look: StillPostLook,
  aspects: readonly StillPostAspect[],
): Promise<RenderedFinal[]> {
  const dir = postDir(slug, post.id)
  const mode = artModeOf(post)
  const out: RenderedFinal[] = []
  for (const [index, panel] of post.panels.entries()) {
    for (const aspect of aspects) {
      // A per-size post letters each frame from that frame's OWN drawing; a single post letters
      // every frame from the one drawing, fitted. Neither path substitutes another frame's art.
      const artPath = path.join(dir, artFilenameFor(index, mode, aspect))
      if (!existsSync(artPath)) {
        throw new Error(mode === 'per-size'
          ? `${post.id}: the ${aspect} artwork has not been drawn yet, so there is nothing to letter.`
          : `${post.id}: panel ${index + 1} has no artwork to letter yet.`)
      }
      const artBytes = await fs.readFile(artPath)
      const style = textStyleFor(look, index, aspect)
      const framed = await frameArt(artBytes, aspect)
      const rendered = await renderThumbnailText({
        sourceBytes: framed,
        text: panel.text,
        style,
        canvas: STILL_POST_CANVAS[aspect],
        branding: look.branding,
      })
      out.push({
        aspect,
        panel_id: panel.id,
        filename: finalFilename(index, aspect),
        png: rendered.png,
        text: panel.text,
        font_id: style.font_id,
        style_hash: styleHashFor(look, index, aspect, panel.text),
      })
    }
  }
  return out
}

/** Write rendered finals and fold them into the post record. */
export async function commitFinals(slug: string, post: StillPost, rendered: readonly RenderedFinal[]): Promise<StillPost> {
  const dir = postDir(slug, post.id)
  await fs.mkdir(dir, { recursive: true })
  const now = new Date().toISOString()
  const finals: StillPostFinal[] = post.finals.filter(final =>
    !rendered.some(item => item.panel_id === final.panel_id && item.aspect === final.aspect))
  for (const item of rendered) {
    const target = path.join(dir, item.filename)
    const temporary = `${target}.partial-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, item.png)
    await fs.rename(temporary, target)
    finals.push({
      aspect: item.aspect,
      panel_id: item.panel_id,
      filename: item.filename,
      rendered_at: now,
      text: item.text,
      style_hash: item.style_hash,
      font_id: item.font_id,
    })
  }
  return writePost(slug, { ...post, finals })
}

/** Panel ids are derived from the option, so a single-panel option never leaves a stale `p1`. */
export function panelsForOption(option: StillPostOption, previous: readonly StillPostPanel[] = []): StillPostPanel[] {
  const roles = option.panels === 2 ? (['setup', 'punchline'] as const) : (['single'] as const)
  return roles.map((role, index) => ({
    id: `p${index}`,
    role,
    text: previous[index]?.text ?? '',
    scene_prompt: previous[index]?.scene_prompt ?? '',
    image: previous[index]?.image ?? null,
    ...(previous[index]?.images ? { images: { ...previous[index]!.images } } : {}),
  }))
}

/** The image prompt: format look + option composition + the panel's own scene. Never lettering. */
export function imagePromptFor(look: StillPostLook, panelIndex: number, scenePrompt: string): string {  const composition = look.option.composition[Math.min(panelIndex, look.option.composition.length - 1)] || ''
  return [
    look.format.style_bible,
    composition,
    scenePrompt,
    'The image contains no text, no letters, no numbers, no logo and no watermark anywhere: '
    + 'the words are added afterwards by the publisher.',
    `Avoid: ${look.format.negative_prompt}.`,
  ].filter(Boolean).join('\n\n')
}

// ── Presets and the workspace payload ──────────────────────────────────────

/** The customer's saved presets, filtered to well-formed records. */
export function savedPresets(raw: Record<string, any> | null | undefined): StillPostPreset[] {
  const list = raw && typeof raw === 'object' ? (raw as any).still_post_presets : undefined
  if (!Array.isArray(list)) return []
  return list
    .filter((entry: any) => entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.data)
    .map((entry: any) => ({
      id: String(entry.id),
      name: String(entry.name || entry.id),
      builtin: false,
      data: {
        ...entry.data as StillPostPresetData,
        // A preset saved before the pool existed reads as an empty pool — the format's face — rather
        // than as a shape the page has to defend against.
        font_pools: normaliseFontPools(entry.data.font_pools),
      },
    }))
}

/** Built-in presets first, then the customer's own, newest saved last. */
export async function listPresets(raw: Record<string, any> | null | undefined): Promise<StillPostPreset[]> {
  const { STILL_POST_BUILTIN_PRESETS } = await import('../still-posts/catalog.js')
  return [...STILL_POST_BUILTIN_PRESETS, ...savedPresets(raw)]
}

/**
 * Everything the workspace page renders from, assembled in one read.
 *
 * Verification is part of the payload, not something the page works out for itself: the page and
 * the job must answer "is this post done?" the same way (AGENTS §8).
 */
export async function buildWorkspace(slug: string): Promise<StillPostsWorkspace> {
  const { STILL_POST_FORMATS, STILL_POST_OPTIONS } = await import('../still-posts/catalog.js')
  const raw = (await pm.getConfig(slug)) || {}
  const config = stillPostsConfig(raw)
  const characters = await listChannelCharacters(slug)
  const roster = resolveRoster(config.character_ids, characters)
  const posts = await listPosts(slug)
  const logo = channelLogoPath(raw, config)
  const handle = channelHandle(raw, config)
  return {
    config: {
      character_ids: roster.ids,
      logo_path: config.logo_path || null,
      handle,
      logo_ready: !!logo,
    },
    characters: characters.map(({ portrait_path: _portrait, ...row }) => row),
    formats: STILL_POST_FORMATS,
    options: STILL_POST_OPTIONS,
    fonts: await listThumbnailFonts(),
    presets: await listPresets(raw),
    last_preset_id: typeof (raw as any).still_post_last_preset === 'string' ? (raw as any).still_post_last_preset : null,
    posts,
    batches: await listBatchStates(slug, posts),
  }
}

/** A post's own state, for the edit route's answer. */
export async function postStateFor(slug: string, post: StillPost): Promise<StillPostState> {
  return verifyPostState(slug, post, post.aspects.length ? post.aspects : [...STILL_POST_ASPECTS])
}
