/**
 * ONE stable identity for a YouTube video's snippet — the value a caller holds
 * up and says "this is the video I prepared my change against".
 *
 * It exists because the metadata-update route refuses to overwrite a video that
 * moved underneath it (`expected_baseline_hash`), and a refusal is only useful
 * if the caller can obtain the expected value. Before this module the read
 * surface published a hash over THREE fields (title, description, tags) while
 * the update route compared against a hash over SIX, so no read route could
 * produce the value the write route wanted; the only way to satisfy the
 * precondition was to guess, which forces a guaranteed 409.
 *
 * So both sides now call THIS function: the read route publishes its value as
 * `snippet_sha256`, and the write route compares it as `expected_baseline_hash`.
 * There is no second implementation to drift.
 *
 * Every field YouTube returns in `part=snippet` that the update route PRESERVES
 * is in the hash. A preserved field that is outside the identity could change
 * without the precondition noticing, and the update would silently carry the
 * new value forward as if the caller had approved it.
 *
 * The algorithm travels WITH the value (`METADATA_SNIPPET_HASH_ALGORITHM`):
 * a bare hex string cannot say which rule produced it, and a hash from the
 * 3-field era would otherwise be mistaken for a 6-field one and produce a
 * phantom 409.
 */

import { createHash } from 'node:crypto'

/** The snippet fields the identity covers. */
export interface HashedSnippetFields {
  title: string
  description: string
  tags: string[]
  categoryId?: string
  defaultLanguage?: string
  defaultAudioLanguage?: string
}

/**
 * Labels the rule below. Published beside every hash so a caller can tell an
 * older, narrower hash from a current one — the two are not comparable.
 */
export const METADATA_SNIPPET_HASH_ALGORITHM =
  'sha256:utf8-json:{title,description,tags,categoryId,defaultLanguage,defaultAudioLanguage}'

/**
 * Hash over the six fields, in a fixed key order, with absent optional fields
 * pinned to `null` so "YouTube did not echo categoryId" and "categoryId is the
 * string null" cannot collide.
 *
 * `JSON.stringify` of a plain object is `utf8-json` with a defined key order,
 * which is what the algorithm name says. Tags are hashed in the order given, so
 * this is an identity of the observation, not a comparison of tag sets — the
 * tag-set comparison is `sameTags` in the update service, and it is a
 * different question.
 */
export function metadataSnippetHash(snapshot: HashedSnippetFields): string {
  return createHash('sha256').update(JSON.stringify({
    title: snapshot.title,
    description: snapshot.description,
    tags: snapshot.tags,
    categoryId: snapshot.categoryId ?? null,
    defaultLanguage: snapshot.defaultLanguage ?? null,
    defaultAudioLanguage: snapshot.defaultAudioLanguage ?? null,
  })).digest('hex')
}
