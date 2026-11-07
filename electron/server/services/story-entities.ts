/**
 * Episode-owned story entity inventory — read / merge / write of the
 * `story-entities.json` sidecar that lives beside `continuity.json`
 * (Episode Visual Setup Phase 1, owner-approved 2026-11-05).
 *
 * Ownership, concretely:
 *   - the folder comes from `resolveEpisodePathsByCode` (the idea index's
 *     own title for this code), never from a path string the client sends —
 *     and an unknown episode code is refused BEFORE anything is written, so
 *     a stale code cannot create a phantom `{code} - ` folder;
 *   - a `character_id` is resolved against `listCharacters(slug,
 *     { episodeCode })`, the same unified character list the Scene Review
 *     picker is built from — a character of another episode is refused here;
 *   - a `reference_images` entry must be a real file inside this episode's
 *     folder, proven by realpath containment, not by how the string looks.
 *
 * The write is a merge inside the sidecar lock: fields the payload omits
 * keep their stored value (so an out-of-date or partial save cannot reset a
 * review decision or drop a reference), entities the payload never mentions
 * are preserved, and `keep`/`drop` is a restorable retire — nothing is
 * deleted for good.
 */

import fs from 'fs/promises'
import path from 'path'
import { withLock } from '../lib/atomic-store.js'
import { matchChapterFile } from '../lib/episode-artifacts.js'
import { listCharacters } from './character-manager.js'
import { resolveEpisodePathsByCode, resolveEpisodeTitleByCode } from './utils.js'
import {
  STORY_ENTITIES_FILENAME,
  STORY_ENTITY_DESCRIPTION_MAX,
  STORY_ENTITY_ID_PATTERN,
  STORY_ENTITY_KINDS,
  STORY_ENTITY_NAME_MAX,
  STORY_ENTITY_REVIEWS,
  canonicalStoryEntityId,
  emptyStoryEntities,
  isStoryEntityKind,
  isStoryEntityReview,
  type StoryEntitiesDoc,
  type StoryEntitiesRead,
  type StoryEntity,
  type StoryEntityKind,
} from '../contracts/story-entities.js'

export class StoryEntitiesValidationError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'StoryEntitiesValidationError'
  }
}

export class StoryEntitiesEpisodeNotFoundError extends Error {
  readonly statusCode = 404
  constructor(message = 'Episode not found') {
    super(message)
    this.name = 'StoryEntitiesEpisodeNotFoundError'
  }
}

function invalid(message: string): never {
  throw new StoryEntitiesValidationError(message)
}

/**
 * The episode must exist in the idea index before any read or write: the
 * resolver falls back to `{code} - ` when the title is unknown, and writing
 * there would create a folder that belongs to no episode.
 */
async function requireEpisode(slug: string, episodeId: string): Promise<void> {
  const title = await resolveEpisodeTitleByCode(slug, episodeId)
  if (!title) throw new StoryEntitiesEpisodeNotFoundError()
}

function parseStored(raw: string): StoryEntitiesDoc {
  try {
    return JSON.parse(raw) as StoryEntitiesDoc
  } catch {
    // A malformed sidecar must never read as "no inventory" — that would let
    // the next save overwrite it with an empty one (AGENTS.md §8).
    throw new Error(
      `${STORY_ENTITIES_FILENAME} is not valid JSON — fix or move that file aside before saving story context`,
    )
  }
}

/** `null` = the script folder is absent/unreadable; `0` = readable, no chapters. */
export async function countScriptChapters(slug: string, episodeId: string): Promise<number | null> {
  try {
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    const entries = await fs.readdir(paths.script_dir)
    const numbers = new Set(
      entries.map(name => matchChapterFile(name, episodeId)).filter((n): n is number => n !== null),
    )
    return numbers.size
  } catch {
    return null
  }
}

export async function readStoryEntities(slug: string, episodeId: string): Promise<StoryEntitiesRead> {
  await requireEpisode(slug, episodeId)
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const file = path.join(paths.episode_dir, STORY_ENTITIES_FILENAME)
  let exists = true
  let doc: StoryEntitiesDoc
  try {
    doc = parseStored(await fs.readFile(file, 'utf-8'))
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
    exists = false
    doc = emptyStoryEntities()
  }
  return { exists, doc, chapters: await countScriptChapters(slug, episodeId) }
}

/**
 * Validate ONE payload entity and merge it onto its stored counterpart.
 * `ctx` carries the id bookkeeping shared across the whole payload.
 */
interface MergeContext {
  slug: string
  episodeId: string
  episodeDir: string
  stored: StoryEntitiesDoc
  storedById: Map<string, StoryEntity>
  /** Every id occupied in the output document (stored ids pre-seeded). */
  usedIds: Set<string>
  /** Stored ids claimed by a payload entity (one-to-one adoption). */
  matchedStoredIds: Set<string>
  /** Ids already seen in THIS payload — a repeat is a malformed request. */
  payloadIds: Set<string>
  ownedCharacterIds: Set<string> | null
  now: string
}

function entityLabel(entity: Record<string, unknown>, index: number): string {
  const name = typeof entity.name === 'string' ? entity.name.trim() : ''
  return name ? `'${name}'` : `#${index + 1}`
}

async function loadOwnedCharacterIds(slug: string, episodeId: string): Promise<Set<string>> {
  const owned = await listCharacters(slug, { episodeCode: episodeId })
  return new Set(owned.map(c => c.id))
}

/** Prove the reference is a real file of THIS episode — realpath containment. */
async function assertEpisodeReferenceFile(
  episodeDir: string,
  filename: unknown,
  label: string,
): Promise<string> {
  if (typeof filename !== 'string' || !filename.trim()) {
    invalid(`${label}: reference file names must be non-empty strings`)
  }
  const name = filename.trim()
  if (path.isAbsolute(name)) {
    invalid(`${label}: reference '${name}' must be a file inside this episode's folder`)
  }
  const root = await fs.realpath(episodeDir).catch(() => null)
  if (!root) {
    invalid(`${label}: this episode's folder is not on disk, so '${name}' cannot be owned by it`)
  }
  const resolved = await fs.realpath(path.join(episodeDir, name)).catch(() => null)
  if (!resolved) {
    invalid(`${label}: reference '${name}' is not a file of this episode`)
  }
  const rel = path.relative(root!, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    invalid(`${label}: reference '${name}' resolves outside this episode's folder`)
  }
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat?.isFile()) {
    invalid(`${label}: reference '${name}' is not a file of this episode`)
  }
  return rel
}

async function mergeEntity(
  raw: unknown,
  index: number,
  ctx: MergeContext,
): Promise<StoryEntity> {
  const entity = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const label = entityLabel(entity, index)

  // ── id: canonical, unique, or adopted/minted ───────────────────────
  let id = typeof entity.id === 'string' && entity.id.trim() ? entity.id.trim() : ''
  if (id && !STORY_ENTITY_ID_PATTERN.test(id)) {
    invalid(
      `${label}: id '${id}' is not canonical — use lowercase letters, digits and hyphens (1–64 characters)`,
    )
  }
  if (id && ctx.payloadIds.has(id)) {
    invalid(`${label}: duplicate entity id '${id}' in this save`)
  }

  // ── kind + name: the identity fields ──────────────────────────────
  if (!isStoryEntityKind(entity.kind)) {
    invalid(`${label}: kind must be ${STORY_ENTITY_KINDS.join(', ')}`)
  }
  const kind = entity.kind as StoryEntityKind
  const name = typeof entity.name === 'string' ? entity.name.trim() : ''
  if (!name) invalid(`${label}: name is required`)
  if (name.length > STORY_ENTITY_NAME_MAX) {
    invalid(`${label}: name must be ${STORY_ENTITY_NAME_MAX} characters or fewer`)
  }

  // An id-less payload entity adopts the stored record of the same kind and
  // name (a retried save of rows the client never minted ids for), so a
  // retry updates in place instead of duplicating.
  if (!id) {
    const adopted = ctx.stored.entities.find(e =>
      !ctx.matchedStoredIds.has(e.id) && !ctx.payloadIds.has(e.id) && e.kind === kind && e.name === name,
    )
    if (adopted) id = adopted.id
  }
  if (id) {
    // Explicit id or adopted id: replace that record in place.
    ctx.payloadIds.add(id)
    ctx.usedIds.add(id)
  } else {
    // Brand new — mint a canonical id that collides with nothing in play.
    id = canonicalStoryEntityId(kind, name, ctx.usedIds)
    if (ctx.usedIds.has(id)) {
      invalid(`${label}: could not mint a unique id for '${name}' in this save`)
    }
    ctx.payloadIds.add(id)
    ctx.usedIds.add(id)
  }

  const previous = ctx.storedById.get(id) || null
  if (ctx.storedById.has(id)) ctx.matchedStoredIds.add(id)

  // ── description: story facts, bounded where enforced and shown ─────
  let description: string
  if (entity.description === undefined) {
    description = previous?.description ?? ''
  } else if (entity.description === null) {
    description = ''
  } else if (typeof entity.description === 'string') {
    description = entity.description.trim()
  } else {
    invalid(`${label}: description must be text`)
  }
  if (description.length > STORY_ENTITY_DESCRIPTION_MAX) {
    invalid(`${label}: description must be ${STORY_ENTITY_DESCRIPTION_MAX} characters or fewer`)
  }

  // ── review: absent means "keep the stored decision" (out-of-date save) ──
  let review: StoryEntity['review']
  if (entity.review === undefined) {
    review = previous?.review ?? 'keep'
  } else if (isStoryEntityReview(entity.review)) {
    review = entity.review
  } else {
    invalid(`${label}: review must be ${STORY_ENTITY_REVIEWS.join(' or ')}`)
  }

  const important = entity.important === undefined ? previous?.important ?? false : !!entity.important

  // ── character link: cast only, ownership looked up in this episode's list ──
  let characterId: string | undefined
  if (kind === 'cast') {
    if (entity.character_id === null) {
      characterId = undefined
    } else if (entity.character_id === undefined) {
      characterId = previous?.kind === 'cast' ? previous.character_id : undefined
    } else if (typeof entity.character_id === 'string' && entity.character_id.trim()) {
      characterId = entity.character_id.trim()
      if (!ctx.ownedCharacterIds) ctx.ownedCharacterIds = await loadOwnedCharacterIds(ctx.slug, ctx.episodeId)
      if (!ctx.ownedCharacterIds.has(characterId)) {
        invalid(
          `${label}: character '${characterId}' is not part of this channel's cast for this episode, ` +
          'so it cannot be the entity\'s canonical reference. Choose a character of this episode or clear the link.',
        )
      }
    } else {
      invalid(`${label}: character_id must be a character id or empty`)
    }
  }

  // ── reference files: actual files of this episode, proven by realpath ──
  let referenceImages: string[]
  if (entity.reference_images === undefined) {
    referenceImages = previous?.reference_images ?? []
  } else if (entity.reference_images === null) {
    referenceImages = []
  } else if (Array.isArray(entity.reference_images)) {
    const validated: string[] = []
    for (const entry of entity.reference_images) {
      validated.push(await assertEpisodeReferenceFile(ctx.episodeDir, entry, label))
    }
    referenceImages = [...new Set(validated)]
  } else {
    invalid(`${label}: reference_images must be a list of file names`)
  }

  return {
    id,
    kind,
    name,
    description,
    important,
    review,
    ...(characterId ? { character_id: characterId } : {}),
    reference_images: referenceImages,
    created_at: previous?.created_at ?? ctx.now,
    updated_at: ctx.now,
  }
}

/**
 * Build the next sidecar document from a payload + what is already stored.
 * Merge semantics (the idempotence/retry contract):
 *   - payload entity with an id → replaces that record field-by-field,
 *     omitted fields keep their stored values;
 *   - payload entity without an id → adopts the stored record of the same
 *     kind+name, else becomes a new record with a minted canonical id;
 *   - stored records the payload never mentions → preserved untouched;
 *   - duplicates inside one payload → refused loudly.
 */
async function buildDoc(
  slug: string,
  episodeId: string,
  episodeDir: string,
  body: unknown,
): Promise<StoryEntitiesDoc> {
  const raw = (body ?? {}) as Record<string, unknown>
  if (!Array.isArray(raw.entities)) invalid('entities must be a list')

  let stored: StoryEntitiesDoc = emptyStoryEntities()
  try {
    const file = path.join(episodeDir, STORY_ENTITIES_FILENAME)
    stored = parseStored(await fs.readFile(file, 'utf-8'))
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
  }
  const storedEntities = Array.isArray(stored.entities) ? stored.entities : []
  stored = { schema_version: 1, entities: storedEntities, updated_at: stored.updated_at ?? '' }

  const now = new Date().toISOString()
  const ctx: MergeContext = {
    slug,
    episodeId,
    episodeDir,
    stored,
    storedById: new Map(storedEntities.map(e => [e.id, e])),
    usedIds: new Set(storedEntities.map(e => e.id)),
    matchedStoredIds: new Set(),
    payloadIds: new Set(),
    ownedCharacterIds: null,
    now,
  }

  const entities: StoryEntity[] = []
  for (let i = 0; i < raw.entities.length; i++) {
    entities.push(await mergeEntity(raw.entities[i], i, ctx))
  }
  // Records this save never mentioned are kept: a stale or partial payload
  // must not silently delete an entity somebody else added.
  for (const entity of storedEntities) {
    if (!ctx.payloadIds.has(entity.id)) entities.push(entity)
  }

  return { schema_version: 1, entities, updated_at: now }
}

export async function writeStoryEntities(
  slug: string,
  episodeId: string,
  body: unknown,
): Promise<{ exists: true; doc: StoryEntitiesDoc }> {
  await requireEpisode(slug, episodeId)
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  const file = path.join(paths.episode_dir, STORY_ENTITIES_FILENAME)
  // Read-merge-write ALL inside the lock, exactly like continuity.json: a
  // second save arriving while this one is in flight must build on what this
  // one wrote, not on a file it has not written yet.
  return withLock(file, async () => {
    const doc = await buildDoc(slug, episodeId, paths.episode_dir, body)
    await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf-8')
    return { exists: true as const, doc }
  })
}
