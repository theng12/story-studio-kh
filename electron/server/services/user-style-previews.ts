/**
 * Saved previews for the owner's OWN styles (user style packs, v1.4.277).
 *
 * A user style pack is unsigned, so its style documents carry no `preview_assets`
 * and the Style Library had nothing to show for them: every one of the owner's
 * own looks read "Preview unavailable" no matter how many times it was
 * generated, because the modal kept the rendered PNG in component state and
 * threw it away when the page closed.
 *
 * So a user style's previews are saved here, on this Mac, beside the user style
 * packs themselves:
 *
 *   <userData>/content-packs/user-style-previews/index.json   ← style id → slots
 *   <userData>/content-packs/user-style-previews/<sha256>.<ext> ← the bytes
 *
 * Two properties of that layout are deliberate:
 *
 *  - **The bytes are addressed by their own SHA-256.** The URL a renderer is
 *    handed (`/api/user-style-previews/assets/<hash>`) is the content key, so it
 *    can never collide with new bytes and can be served immutable for a year —
 *    the same rule the app-wide style-preview cache already follows.
 *  - **An entry records the hash of the style text it was made from.** Edit the
 *    style's own `style_bible` or `negative_prompt` and the stored previews no
 *    longer describe it. They are still shown — they are a real picture of what
 *    the look used to be — but they are published as OUT OF DATE rather than as
 *    current, so nobody mistakes a stale render for the look they just wrote.
 *    The next generation replaces them.
 *
 * Nothing here writes into a user style pack's JSON, and nothing touches project
 * data: previews are per-machine artefacts of the OWNER's library.
 *
 * A preview is only kept after it decodes: `sharp` reads the dimensions and
 * performs a real pixel decode (the same check the Content Pack archive applies
 * to a signed style's shipped preview), because "the Gateway returned something"
 * is not evidence that an image arrived (§8).
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { writeJsonAtomic } from '../lib/atomic-store.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from '../content-packs/runtime-paths.js'

/**
 * The three previews every style shows, in the order the owner set on
 * 2026-09-08 (`content-packs/PREVIEW-BACKFILL-2026-09-08.md`): the hero first,
 * then the quiet empty scene, then the hardest legal case. The dot pager reads
 * this order, and `preview_image` is always `[0]`.
 */
export const USER_STYLE_PREVIEW_SLOTS = ['hero', 'scene', 'face'] as const
export type UserStylePreviewSlot = typeof USER_STYLE_PREVIEW_SLOTS[number]

/** The published ceiling on what a single preview may cost in pixels (and memory). */
const MAX_PREVIEW_PIXELS = 40_000_000

const FORMAT_EXTENSION: Readonly<Record<string, string>> = {
  png: 'png',
  webp: 'webp',
  jpeg: 'jpg',
}

const ASSET_HASH = /^[a-f0-9]{64}$/

export interface StoredUserStylePreview {
  /** SHA-256 of the stored bytes. Also the file name stem and the served asset id. */
  hash: string
  format: 'png' | 'webp' | 'jpeg'
  mime: string
  width: number
  height: number
  bytes: number
  created_at: string
}

/**
 * The last attempt the PROVIDER settled as failed for one slot.
 *
 * A rendered preview is bought under a stable idempotency identity, so an
 * accidental repeat replays the first job instead of paying for a second. That
 * is right until the provider SETTLES the attempt as failed: a settled job can
 * never be reopened, so replaying the same key would re-read the same dead job
 * for ever and Retry would never repair anything (§8). This record is what lets
 * the next attempt move the identity — and because it is persisted, two retries
 * after the same failure derive the same next identity and cannot both be
 * charged (`previewRequestIdentity`).
 */
export interface UserStylePreviewFailure {
  /** 1 for the first attempt, 2 for the first retry, and so on. */
  attempt: number
  /** The exact identity that attempt submitted under, kept so it can be traced. */
  identity: string
}

export interface UserStylePreviewEntry {
  /** Hash of the style's own `style_bible` + `negative_prompt` when these were made. */
  source_hash: string
  slots: Partial<Record<UserStylePreviewSlot, StoredUserStylePreview>>
  /** Slots whose last attempt the provider settled as failed. Absent when none. */
  failed?: Partial<Record<UserStylePreviewSlot, UserStylePreviewFailure>>
}

/**
 * Thrown by a caller's renderer when the PROVIDER settled this attempt —
 * failed it, or settled it and destroyed the artifact — so replaying the same
 * idempotency key could only re-read that dead outcome.
 *
 * It is a marker rather than a condition the service could work out for itself:
 * only the caller talks to the provider, so only the caller knows whether an
 * error means "the job is dead, move the key" or "the connection dropped, keep
 * the key and let the retry replay the job that may still be running". Anything
 * thrown that is NOT this class keeps the identity, so a retry can never buy the
 * same pixels twice.
 */
export class SettledPreviewFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SettledPreviewFailure'
  }
}

interface UserStylePreviewIndex {
  version: 1
  styles: Record<string, UserStylePreviewEntry>
}

/** The style text a preview renders, and the only thing that can invalidate it. */
export interface UserStylePreviewStyle {
  style_bible: string
  negative_prompt?: string
}

/**
 * The store key that makes two channels' identical style text share ONE set of
 * three previews.
 *
 * The owner's rule, 2026-10-25: every art style — a signed pack's, one of the
 * owner's own, or a channel's own custom style — shows exactly three previews
 * (hero, empty scene, hardest legal case). A channel's custom styles live in
 * `ProjectConfig.style_presets` as a `description`, so they have no registry id
 * to key a store by — and on the owner's Mac all 215 channel styles across ~17
 * channels are only 34 distinct texts, copied channel to channel.
 *
 * So a channel style's previews are addressed by THE HASH OF ITS OWN TEXT, and
 * this key names that entry. Two channels whose style text hashes the same read
 * and write one entry, so the second channel's render is a SKIP for all three
 * slots rather than three more paid images.
 *
 * The `text:` prefix is what keeps the two kinds of key apart: a user style
 * pack's registry-qualified id (`kh.art-styles.dreamlands`) never contains a
 * colon, so a shared entry can never be mistaken for one of the owner's styles,
 * and vice versa.
 */
export function sharedStylePreviewKeyForHash(sourceHash: string): string {
  return `text:${sourceHash}`
}

/** The shared store key for one style text. */
export function sharedStylePreviewKey(style: UserStylePreviewStyle): string {
  return sharedStylePreviewKeyForHash(hashUserStyleSource(style))
}

/** Where a stored preview is served from. Content-addressed, so it is immutable. */
export function userStylePreviewUrl(hash: string): string {
  return `/api/user-style-previews/assets/${hash}`
}

function previewDir(paths?: ContentPackRuntimePaths): string {
  return path.join((paths ?? getContentPackRuntimePaths()).root, 'user-style-previews')
}

function indexPath(paths?: ContentPackRuntimePaths): string {
  return path.join(previewDir(paths), 'index.json')
}

/**
 * The hash that decides whether stored previews are current.
 *
 * Whitespace is normalised and the two halves are separated by a NUL so that
 * moving a word from the bible into the negative prompt — or a null character
 * arriving in either — cannot produce the same hash for two different styles.
 */
export function hashUserStyleSource(style: UserStylePreviewStyle): string {
  const normalise = (value: string | undefined) => String(value ?? '').replace(/\s+/g, ' ').trim()
  return createHash('sha256')
    .update(normalise(style.style_bible))
    .update(Buffer.from([0]))
    .update(normalise(style.negative_prompt))
    .digest('hex')
}

async function readIndex(paths?: ContentPackRuntimePaths): Promise<UserStylePreviewIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(paths), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.styles && typeof parsed.styles === 'object') {
      return { version: 1, styles: parsed.styles as Record<string, UserStylePreviewEntry> }
    }
  } catch { /* absent or unreadable means "no previews yet" */ }
  return { version: 1, styles: {} }
}

async function writeIndex(index: UserStylePreviewIndex, paths?: ContentPackRuntimePaths): Promise<void> {
  await writeJsonAtomic(indexPath(paths), index)
}

/**
 * The idempotency identity one preview attempt submits under.
 *
 * Two properties at once, and both matter:
 *
 *  - **Stable for the same style text, slot, model and shape**, so an accidental
 *    repeat replays the first job instead of buying the same image twice.
 *  - **Moved after the provider settled an attempt as failed**, because a
 *    settled job can never be reopened: with a stable key, Retry would replay
 *    the dead job forever and never repair the slot (§8).
 *
 * The move is derived from PERSISTED state — the attempt number of the failure
 * recorded for this slot — and never from a clock or a random value, which is
 * the rule `resolveGenStudioRetryScope` states for the durable lanes. So two
 * retries issued after the SAME failure compute the same next identity and
 * replay each other rather than both being charged.
 *
 * `force` is the customer saying "give me new pixels" and is the one caller that
 * asks for a random identity on purpose.
 */
export function previewRequestIdentity(input: {
  styleId: string
  sourceHash: string
  slot: UserStylePreviewSlot
  modelId: string
  aspectRatio: string
  tier?: string
  /** The attempt already recorded for this slot, when the provider settled one. */
  failedAttempt?: number
}): string {
  const base = `user-style-preview:${input.styleId}:${input.sourceHash}:${input.slot}:${input.modelId}:${input.aspectRatio}:${input.tier || ''}`
  return input.failedAttempt ? `${base}:retry:${input.failedAttempt + 1}` : base
}

/**
 * Record that the provider settled one slot's attempt as failed.
 *
 * Written beside the entry's slots, and reset whenever the style text changes:
 * a failure belongs to the text it was rendered from, exactly as the stored
 * images do.
 */
export async function recordUserStylePreviewFailure(input: {
  styleId: string
  sourceHash: string
  slot: UserStylePreviewSlot
  identity: string
  attempt: number
  paths?: ContentPackRuntimePaths
}): Promise<void> {
  const index = await readIndex(input.paths)
  const previous = index.styles[input.styleId]
  const sameSource = previous && previous.source_hash === input.sourceHash
  const failed = sameSource ? { ...(previous.failed || {}) } : {}
  failed[input.slot] = { attempt: input.attempt, identity: input.identity }
  index.styles[input.styleId] = {
    source_hash: input.sourceHash,
    slots: sameSource ? { ...previous.slots } : {},
    failed,
  }
  await writeIndex(index, input.paths)
}

/** The stored entry for one style, or null. Absent means nothing has been rendered. */
export async function readUserStylePreviewEntry(
  styleId: string,
  paths?: ContentPackRuntimePaths,
): Promise<UserStylePreviewEntry | null> {
  const index = await readIndex(paths)
  return index.styles[styleId] ?? null
}

/**
 * Decode, verify and keep one rendered preview.
 *
 * Refuses anything that is not a single-frame PNG, WebP or JPEG, and refuses
 * anything that will not decode — the caller reports that slot as failed by
 * name rather than saving a file the library cannot show (§8).
 */
export async function saveUserStylePreview(input: {
  styleId: string
  sourceHash: string
  slot: UserStylePreviewSlot
  imageBytes: Buffer
  paths?: ContentPackRuntimePaths
  now?: () => string
}): Promise<StoredUserStylePreview> {
  if (!input.imageBytes.length) throw new Error('the renderer returned zero bytes')
  let format: string | undefined
  let width: number | undefined
  let height: number | undefined
  try {
    const image = sharp(input.imageBytes, { failOn: 'error', limitInputPixels: MAX_PREVIEW_PIXELS, animated: true })
    const metadata = await image.metadata()
    if ((metadata.pages ?? 1) !== 1) throw new Error('animated or multipage images are not permitted')
    format = metadata.format
    width = metadata.width
    height = metadata.height
    if (!width || !height) throw new Error('the image states no usable dimensions')
    if (width * height > MAX_PREVIEW_PIXELS) throw new Error(`the image is larger than ${MAX_PREVIEW_PIXELS} pixels`)
    if (!FORMAT_EXTENSION[format]) throw new Error(`the image is ${format || 'of an unknown format'}, not PNG or WebP`)
    // A real pixel decode. `metadata()` reads only the header.
    await image.stats()
  } catch (error: unknown) {
    throw new Error(`not a usable image: ${error instanceof Error ? error.message : String(error)}`)
  }

  const hash = createHash('sha256').update(input.imageBytes).digest('hex')
  const dir = previewDir(input.paths)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${hash}.${FORMAT_EXTENSION[format!]}`), input.imageBytes)

  const stored: StoredUserStylePreview = {
    hash,
    format: format as StoredUserStylePreview['format'],
    mime: `image/${format}`,
    width: width!,
    height: height!,
    bytes: input.imageBytes.length,
    created_at: (input.now ?? (() => new Date().toISOString()))(),
  }

  const index = await readIndex(input.paths)
  const previous = index.styles[input.styleId]
  // An edited style starts again: previews made from the text it no longer has
  // are not carried forward as if they described the new one — and the same goes
  // for a recorded failure, which belongs to the text it was rendered from.
  const sameSource = previous && previous.source_hash === input.sourceHash
  const slots = sameSource ? { ...previous.slots } : {}
  slots[input.slot] = stored
  // This slot's attempt is now a success, so its failure record is spent. The
  // OTHER slots' records are carried across, or a retry of a slot that failed
  // beside this one would fall back to its dead identity and replay for ever.
  const failed = sameSource ? { ...(previous.failed || {}) } : {}
  delete failed[input.slot]
  index.styles[input.styleId] = {
    source_hash: input.sourceHash,
    slots,
    ...(Object.keys(failed).length ? { failed } : {}),
  }
  await writeIndex(index, input.paths)
  return stored
}

export interface UserStylePreviewPublication {
  /** Every stored preview for this style, hero first. Empty when none are stored. */
  urls: string[]
  /**
   * True when the stored previews were made from different style text than the
   * style has now, so they must be shown as out of date rather than current.
   */
  stale: boolean
}

/** What a style publishes right now, without generating anything. */
export async function publishUserStylePreviews(
  styleId: string,
  style: UserStylePreviewStyle,
  paths?: ContentPackRuntimePaths,
): Promise<UserStylePreviewPublication> {
  const entry = await readUserStylePreviewEntry(styleId, paths)
  if (!entry) return { urls: [], stale: false }
  return {
    urls: USER_STYLE_PREVIEW_SLOTS.flatMap(slot => {
      const stored = entry.slots[slot]
      return stored ? [userStylePreviewUrl(stored.hash)] : []
    }),
    stale: entry.source_hash !== hashUserStyleSource(style),
  }
}

/**
 * The slots stored for one style TEXT, hero first and present ones only.
 *
 * This is the read side of the shared key: a channel style has no id to store
 * an entry under, only its text, so its caller already holds the text hash and
 * asks for the entry that hash names. Keyed by the hash rather than by a preset
 * id, the same three images answer for every channel whose style text hashes the
 * same — and the entry's own `source_hash` is checked, so bytes that describe
 * some other text are never published as this one's (§6: an empty answer and a
 * wrong answer must not look alike, so a mismatch returns no slots at all).
 */
export async function sharedStylePreviewSlots(
  sourceHash: string,
  paths?: ContentPackRuntimePaths,
): Promise<Array<{ slot: UserStylePreviewSlot; url: string; hash: string }>> {
  if (!ASSET_HASH.test(sourceHash)) return []
  const entry = await readUserStylePreviewEntry(sharedStylePreviewKeyForHash(sourceHash), paths)
  if (!entry || entry.source_hash !== sourceHash) return []
  return USER_STYLE_PREVIEW_SLOTS.flatMap(slot => {
    const stored = entry.slots[slot]
    return stored ? [{ slot, url: userStylePreviewUrl(stored.hash), hash: stored.hash }] : []
  })
}

/** The absolute path of one stored preview, or null. Strict: a 64-hex id and nothing else. */
export async function pathForUserStylePreviewAsset(
  hash: string,
  paths?: ContentPackRuntimePaths,
): Promise<string | null> {
  if (!ASSET_HASH.test(hash)) return null
  const index = await readIndex(paths)
  for (const entry of Object.values(index.styles)) {
    for (const stored of Object.values(entry.slots)) {
      if (!stored || stored.hash !== hash) continue
      const abs = path.join(previewDir(paths), `${stored.hash}.${FORMAT_EXTENSION[stored.format]}`)
      try {
        await fs.access(abs)
        return abs
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * The three prompt framings, appended to the style's own text.
 *
 * They are the owner's own brief, taken from
 * `content-packs/PREVIEW-BACKFILL-2026-09-08.md`: the hero is "the shot the
 * style exists for", the scene is "a quiet wide scene with no figure in it at
 * all", and the face is "the hardest case the style can be asked for, chosen
 * INSIDE the style's own bible and negative prompt rather than against it".
 *
 * Every one of them restates "no text" because no style preview contains
 * lettering of any kind, whatever the style's own bible permits.
 */
const SLOT_FRAMING: Readonly<Record<UserStylePreviewSlot, string>> = {
  hero: 'One image in this look at its most characteristic: the shot the look exists for, the one a cover would use. One strong focal subject held in the look\'s own light and materials, composed for a 16:9 frame. No text, no lettering, no watermark, no signature, no border, no logo.',
  scene: 'One image in this look of a quiet wide scene with NO FIGURE IN IT AT ALL — no person, no face, no hands and no animal anywhere in the frame: an empty room, an empty road, an empty landscape or an empty table, so the look can be judged on what it does to somewhere nobody is standing. 16:9. No text, no lettering, no watermark, no signature, no border, no logo.',
  face: 'One image in this look pushed to the hardest case it can legally be asked for from its own description: the closest, most demanding subject the look\'s own style and negative list allow — a face held close to camera, or a crowd at readable size. Nothing in the picture may break the look\'s own negative list. 16:9. No text, no lettering, no watermark, no signature, no border, no logo.',
}

/**
 * The three prompts for one style: its own `style_bible`, its own negative list,
 * and the framing for each slot. The negative list is appended the way the
 * Thumbnail prompt builder appends one ("Avoid …"), because that is the app's
 * own convention for saying what an image must not contain.
 */
export function userStylePreviewPrompts(style: UserStylePreviewStyle): Record<UserStylePreviewSlot, string> {
  const negative = String(style.negative_prompt ?? '').trim()
  const build = (slot: UserStylePreviewSlot) => {
    let prompt = `${style.style_bible.trim()} ${SLOT_FRAMING[slot]}`
    if (negative) prompt += `\n\nAvoid: ${negative}`
    return prompt
  }
  return {
    hero: build('hero'),
    scene: build('scene'),
    face: build('face'),
  }
}

export interface UserStylePreviewGeneration {
  /** The style text these previews were made from. */
  source_hash: string
  /** Every preview this style has now, hero first. */
  urls: string[]
  /** True when the previews now on disk were made from text the style no longer has. */
  stale: boolean
  generated: UserStylePreviewSlot[]
  /** Asked for and already saved for this style text: nothing was spent on them. */
  skipped: UserStylePreviewSlot[]
  /** The slots that failed, each named, with the reason its own render gave. */
  failed: Array<{ slot: UserStylePreviewSlot; error: string }>
}

/**
 * Render the previews one style needs, one image at a time.
 *
 * The generator is a parameter rather than an import so this orchestration can
 * be driven with a stub; the route supplies the real Gateway call. Behaviour the
 * owner asked for, and what §8 requires:
 *
 *  - **A listed slot that is already saved is SKIPPED, not re-rendered.** So a
 *    retry after a failure regenerates only what is absent — it never re-charges
 *    for a preview that succeeded, and `skipped` says so rather than leaving the
 *    caller to guess. `force` is the deliberate "render it again" and overrides
 *    the skip.
 *  - **A retry of a FAILED slot moves its idempotency identity.** The provider
 *    settled that job, so replaying the key could only re-read a dead outcome;
 *    the identity for the next attempt is derived from the recorded attempt
 *    (`previewRequestIdentity`), which keeps the move deterministic. A failure
 *    that was NOT settled — a dropped connection, or a render this app could not
 *    save — keeps its identity, because the job may still exist and a moved key
 *    would buy the same pixels twice. Callers signal a settled failure by
 *    throwing `SettledPreviewFailure`.
 *  - **No slot list means "the ones this style is missing".**
 *  - **Failures are reported by name, and never stop the others.** A style whose
 *    face will not render still keeps its hero and scene.
 *  - **A saved preview is only reported after it decodes.** A render that returns
 *    nothing usable is a failure for that slot, not a success.
 */
export async function generateUserStylePreviews(input: {
  styleId: string
  style: UserStylePreviewStyle
  modelId: string
  aspectRatio: string
  tier?: string
  force?: boolean
  slots?: readonly UserStylePreviewSlot[]
  generate: (job: { slot: UserStylePreviewSlot; prompt: string; requestIdentity: string }) => Promise<Buffer>
  paths?: ContentPackRuntimePaths
  now?: () => string
}): Promise<UserStylePreviewGeneration> {
  const sourceHash = hashUserStyleSource(input.style)
  const prompts = userStylePreviewPrompts(input.style)
  const entry = await readUserStylePreviewEntry(input.styleId, input.paths)
  const current = entry && entry.source_hash === sourceHash ? entry.slots : {}
  const wanted: UserStylePreviewSlot[] = []
  const skipped: UserStylePreviewSlot[] = []
  for (const slot of input.slots ?? USER_STYLE_PREVIEW_SLOTS) {
    // Already saved for THIS style text and not deliberately forced: nothing to
    // do, and nothing to charge for.
    if (current[slot] && input.force !== true) skipped.push(slot)
    else wanted.push(slot)
  }

  const generated: UserStylePreviewSlot[] = []
  const failed: Array<{ slot: UserStylePreviewSlot; error: string }> = []
  // The attempts the provider already settled as failed for THIS style text.
  const settled = entry && entry.source_hash === sourceHash ? { ...(entry.failed || {}) } : {}
  for (const slot of wanted) {
    const previousFailure = settled[slot]
    // Stable for a style's own text, so an unintended repeat is the same paid
    // identity rather than a second charge — and MOVED after a settled failure,
    // or Retry would replay the dead job forever. `force` is the customer saying
    // "render it again" and asks for new pixels on purpose.
    const identity = input.force === true
      ? `user-style-preview:${input.styleId}:${slot}:${randomUUID()}`
      : previewRequestIdentity({
          styleId: input.styleId,
          sourceHash,
          slot,
          modelId: input.modelId,
          aspectRatio: input.aspectRatio,
          tier: input.tier,
          ...(previousFailure ? { failedAttempt: previousFailure.attempt } : {}),
        })

    let bytes: Buffer
    try {
      bytes = await input.generate({ slot, prompt: prompts[slot], requestIdentity: identity })
    } catch (error: unknown) {
      // Only a PROVIDER-SETTLED failure moves the identity. A dropped connection
      // may have left the job running, so its identity stays and the retry
      // replays that job rather than buying the same image a second time.
      if (error instanceof SettledPreviewFailure) {
        const attempt = (previousFailure?.attempt ?? 0) + 1
        await recordUserStylePreviewFailure({
          styleId: input.styleId,
          sourceHash,
          slot,
          identity,
          attempt,
          paths: input.paths,
        })
        settled[slot] = { attempt, identity }
      }
      failed.push({ slot, error: error instanceof Error ? error.message : String(error) })
      continue
    }

    try {
      // Saving succeeds → this slot's failure record is spent, and the save
      // itself clears it in the same write as the stored image.
      await saveUserStylePreview({
        styleId: input.styleId,
        sourceHash,
        slot,
        imageBytes: bytes,
        paths: input.paths,
        now: input.now,
      })
      delete settled[slot]
      generated.push(slot)
    } catch (error: unknown) {
      // The pixels exist: the identity must NOT move, or a retry would pay for
      // the same image twice instead of replaying the settled success.
      failed.push({ slot, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const published = await publishUserStylePreviews(input.styleId, input.style, input.paths)
  return {
    source_hash: sourceHash,
    urls: published.urls,
    stale: published.stale,
    generated,
    skipped,
    failed,
  }
}
