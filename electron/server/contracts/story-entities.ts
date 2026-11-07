/**
 * Episode-owned story entity inventory — the Episode Visual Setup contract
 * (owner-approved 2026-11-05: decisions 54959 proposal → 54963 approval →
 * 54879 scope). Phase 1: the inventory API and the Character Sheet's Story
 * context editing. Per-scene links, story state and reference generation are
 * later phases — this file is the typed seam they consume.
 *
 * The inventory records what THIS episode's story uses — recurring cast,
 * important locations, world facts and distinctive objects — reviewed against
 * the whole completed script / chapter context, one entity at a time (keep or
 * drop). It lives in its own atomic sidecar beside `continuity.json` and never
 * mixes with the channel look: story facts here, `style_bible` /
 * `negative_prompt` in the continuity config.
 *
 * Reference policy — adaptive, never a quota: one canonical reference per
 * IMPORTANT entity (`reference_images[0]`, or for `cast` the linked Channel
 * Character's portrait through the existing character reference pipeline),
 * and additional references only when a scene actually needs them. Nothing
 * here names or runs a model (AGENTS.md §1): generation reads the selected
 * preset's live capability record in a later phase, and per-channel
 * automation stays OFF by default.
 *
 * IDs are canonical and stable: `^[a-z0-9][a-z0-9-]{0,63}$`, minted from
 * kind + name (`canonicalStoryEntityId`), with a deterministic hash fallback
 * so non-Latin (Khmer) names still get a stable id.
 */

export const STORY_ENTITIES_FILENAME = 'story-entities.json'

export const STORY_ENTITY_KINDS = ['cast', 'location', 'world', 'object'] as const
export type StoryEntityKind = (typeof STORY_ENTITY_KINDS)[number]

/** Plain-words labels for the picker, one source for UI and API tests. */
export const STORY_ENTITY_KIND_LABELS: Record<StoryEntityKind, string> = {
  cast: 'Cast',
  location: 'Locations',
  world: 'World',
  object: 'Objects',
}

/**
 * The one review decision per entity: `keep` (in the inventory) or `drop`
 * (retired from it). Dropped entities stay in the sidecar, visibly marked
 * and restorable — nothing is deleted for good.
 */
export const STORY_ENTITY_REVIEWS = ['keep', 'drop'] as const
export type StoryEntityReview = (typeof STORY_ENTITY_REVIEWS)[number]

export interface StoryEntity {
  /** Canonical, stable across renames — minted by `canonicalStoryEntityId`. */
  id: string
  kind: StoryEntityKind
  name: string
  /** Story facts only (appearance, state, changes) — never channel style. */
  description: string
  /**
   * `true` when this entity is important enough to hold one canonical
   * reference. Adaptive: importance is decided per entity, never per kind or
   * by a fixed count.
   */
  important: boolean
  review: StoryEntityReview
  /** `cast` only: the Channel Character that owns its canonical reference. */
  character_id?: string
  /**
   * Episode-owned reference filenames. `[0]` is the canonical reference;
   * further entries exist only when a scene needs them. Ownership is checked
   * against the real file on disk inside this episode's folder (realpath),
   * never inferred from a path string.
   */
  reference_images: string[]
  created_at: string
  updated_at: string
}

/**
 * Provenance of the last extraction from this episode's completed script.
 * Server-owned: the save boundary preserves it and never accepts it from a
 * client payload, so a browser cannot claim a script was read when it was not.
 */
export interface StoryEntityExtractionRecord {
  extracted_at: string
  /** The live writing model id that read the script (never chosen here). */
  model: string
  /** Chapter files the extraction read. */
  chapters: number
  /**
   * Fingerprint of those chapter files. The read route returns the CURRENT
   * fingerprint beside it, so a changed script is reported honestly instead
   * of the old inventory silently standing in for the new story.
   */
  script_fingerprint: string
}

export interface StoryEntitiesDoc {
  schema_version: 1
  entities: StoryEntity[]
  updated_at: string
  /** Absent = never extracted. Never written by a client save. */
  extraction?: StoryEntityExtractionRecord
  /**
   * The last extraction's review draft, kept beside the inventory so it
   * survives a page reload or an app restart. It is never the inventory: the
   * customer still keeps or drops each proposal, and only an explicit review
   * save clears the draft. Re-annotated against `entities` on every read, so a
   * stored Keep/Drop decision always wins over the draft's.
   */
  pending_proposals?: StoryEntityProposalSource[]
}

/** What `GET /projects/:slug/story-entities/:episodeId` answers. */
export interface StoryEntitiesRead {
  /** `false` when this episode has no sidecar yet — an absent inventory, not an error. */
  exists: boolean
  doc: StoryEntitiesDoc
  /**
   * Chapter files found in this episode's completed-script folder.
   * `null` = the folder is not there or could not be read — the two are the
   * same honest "could not measure", and it is never flattened to `0`
   * (AGENTS.md §6: a zero that means two things is a defect).
   */
  chapters: number | null
  /** Fingerprint of those same chapter files; `null` = could not be measured. */
  script_fingerprint: string | null
  /**
   * The last extraction's review draft, re-annotated against `doc.entities`
   * so a stored Keep/Drop decision always wins. Empty when there is no draft.
   */
  pending_proposals: StoryEntityProposal[]
}

/**
 * A proposal-shaped entity before review — exactly what extraction read.
 * Persisted as the review draft; it never becomes inventory by itself.
 */
export interface StoryEntityProposalSource {
  id: string
  kind: StoryEntityKind
  name: string
  description: string
  important: boolean
}

/**
 * One entity the extraction proposes. Nothing is added to the inventory until
 * the customer keeps it; an existing entity carries its stored Keep/Drop
 * decision so a retry or a re-extraction never reverses a choice.
 */
export interface StoryEntityProposal {
  id: string
  kind: StoryEntityKind
  name: string
  description: string
  important: boolean
  /** True when this id is already in the inventory. */
  existing: boolean
  /** The stored decision for an existing entity, `keep` for a new proposal. */
  review: StoryEntityReview
  /** Existing only: the story facts already stored, when they differ from the script's. */
  current_description?: string
}

/** What `POST /projects/:slug/story-entities/:episodeId/extract` answers. */
export interface StoryEntitiesExtraction {
  proposals: StoryEntityProposal[]
  chapters: number
  model: string
  script_fingerprint: string
  extracted_at: string
  /** Rows the model returned that were unusable and were left out. */
  skipped_rows: number
}

export const STORY_ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Enforced AND shown: the Character Sheet's inputs carry these as `maxlength`. */
export const STORY_ENTITY_NAME_MAX = 200
export const STORY_ENTITY_DESCRIPTION_MAX = 4000

export function isStoryEntityKind(value: unknown): value is StoryEntityKind {
  return typeof value === 'string' && (STORY_ENTITY_KINDS as readonly string[]).includes(value)
}

export function isStoryEntityReview(value: unknown): value is StoryEntityReview {
  return typeof value === 'string' && (STORY_ENTITY_REVIEWS as readonly string[]).includes(value)
}

/**
 * Attach the stored record to a proposal when its id already exists. The
 * customer's Keep/Drop and `important` choices win over the model's — a
 * re-extraction never reverses a decision, and a dropped entity stays dropped.
 * Pure, so both the extraction and the persisted-draft read use one rule.
 */
export function annotateProposals(
  extracted: StoryEntityProposalSource[],
  stored: StoryEntity[],
): StoryEntityProposal[] {
  const byId = new Map(stored.map(entity => [entity.id, entity]))
  return extracted.map(entity => {
    const existing = byId.get(entity.id)
    if (!existing) return { ...entity, existing: false, review: 'keep' }
    const current = existing.description || ''
    return {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      description: entity.description,
      important: existing.important,
      existing: true,
      review: existing.review,
      ...(current && current !== entity.description ? { current_description: current } : {}),
    }
  })
}

export function emptyStoryEntities(): StoryEntitiesDoc {
  return { schema_version: 1, entities: [], updated_at: '' }
}

/** djb2 over UTF-16 code units — deterministic across engines, Khmer-safe. */
function shortHash(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

/**
 * Mint (or keep) a canonical entity id from kind + name. Deterministic, so a
 * retried save mints the same id; `taken` de-duplicates against ids already
 * in the document. A name with no Latin characters (Khmer titles on the
 * Khmer channels) falls back to a short hash of the name — the id stays
 * stable and valid instead of empty.
 */
export function canonicalStoryEntityId(
  kind: string,
  name: string,
  taken: Iterable<string> = [],
): string {
  const prefix = isStoryEntityKind(kind) ? kind : 'entity'
  const slug = slugify(name)
  const base = `${prefix}-${slug || shortHash(name.trim() || 'entity')}`
  const used = new Set(taken)
  if (!used.has(base) && STORY_ENTITY_ID_PATTERN.test(base)) return base
  for (let n = 2; n <= 999; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate) && STORY_ENTITY_ID_PATTERN.test(candidate)) return candidate
  }
  // 999 collisions on one slug cannot happen through the UI; if a caller
  // forces it anyway, stay deterministic and valid instead of looping.
  return `${prefix}-${shortHash(name)}-${shortHash([...used].join(' '))}`
}
