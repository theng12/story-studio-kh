/**
 * Scene Review "Reference to Image": turn the customer's character selection
 * into reference files THIS episode actually owns.
 *
 * The client sends character IDS, never paths (AGENTS.md §4). Resolving an id
 * to a file is an ownership lookup against the same list the picker was built
 * from — `listCharacters(slug, { episodeCode })`, the unified view the
 * `/characters?episode_code=` route returns — so a character from another
 * episode of the same project is refused here rather than rendered from.
 *
 * Every outcome other than "no ids were selected" is a blocking refusal that
 * names the character, the episode and the published limit. A reference render
 * must never quietly become a text-to-image render, and a character with no
 * portrait must never quietly become N−1 references.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { listCharacters, referenceImagePath } from './character-manager.js'
import { findReferencedCharacters } from '../lib/character-name-match.js'
import { FITTED_REFERENCE_DIRNAME, fitReferenceImage } from '../lib/reference-image-fit.js'
import type { ScenePlanEntry } from '../models/types.js'

/** Where fitted character portraits are cached, beside the episode anchor's. */
export const SCENE_REFERENCE_DIRNAME = 'img2img-references'

export interface ResolvedSceneReferences {
  /** Absolute paths to submit, in the customer's selection order. */
  paths: string[]
  /** Content digests of the SOURCE portraits, same order — the request identity. */
  digests: string[]
  /** Character names, same order, for the job log. */
  names: string[]
  /** Downscales performed to meet the model's published pixel ceiling. */
  fitted: Array<{ name: string; from: { width: number; height: number }; to: { width: number; height: number } }>
}

export interface ResolveSceneReferencesInput {
  slug: string
  episodeCode: string
  characterIds: readonly string[]
  /** The model's published display name, used in every refusal. */
  modelName: string
  /** `publishedSupportsReferenceImages` on the live catalogue entry. */
  supportsReferences: boolean
  /** The model's published `max_reference_images`; unpublished (undefined) takes none. */
  maxReferences: number | undefined
  /** The model's published pixel ceiling, when it publishes one. */
  maxDimension?: number
  /** The episode directory; fitted copies live under it, never beside a portrait. */
  episodeDir: string
  /** `Scene 4` when the selection belongs to one scene, so a refusal names it. */
  sceneLabel?: string
}

/**
 * CHANNEL-scoped reference resolution — the same rules as an episode, one scope up.
 *
 * Still Posts has no episodes: the character belongs to the channel, and every post may use any of
 * the channel's own characters. Rather than a second copy of this logic (which is how the two
 * would drift), both scopes run the one implementation below; only the ownership list, the cache
 * directory and the words in a refusal differ.
 */
export interface ResolveChannelReferencesInput {
  slug: string
  characterIds: readonly string[]
  modelName: string
  supportsReferences: boolean
  maxReferences: number | undefined
  maxDimension?: number
  /** Where fitted copies are cached — under the channel, never beside a portrait. */
  cacheDir: string
  /** `Post 3` when the selection belongs to one post, so a refusal names it. */
  postLabel?: string
}

async function resolveReferencesFrom(
  owned: ReadonlyArray<{ id: string; name: string; references?: { images?: string[] } }>,
  input: {
    slug: string
    characterIds: readonly string[]
    modelName: string
    supportsReferences: boolean
    maxReferences: number | undefined
    maxDimension?: number
    episodeDir: string
    sceneLabel?: string
    /** What a character must belong to, in the refusal sentence. */
    belongsTo: string
  },
): Promise<ResolvedSceneReferences> {
  const scopeIds = [...new Set(input.characterIds.filter(Boolean))]
  if (!scopeIds.length) return { paths: [], digests: [], names: [], fitted: [] }
  const where = input.sceneLabel ? `${input.sceneLabel}: ` : ''

  // An unpublished limit is not a number to guess (§1): NaN >= 1 is false, so it refuses.
  const maxReferences = Number(input.maxReferences)
  if (!input.supportsReferences || !(maxReferences >= 1)) {
    throw new Error(
      `${where}${input.modelName} accepts no reference images, so the ${scopeIds.length} selected character reference(s) cannot be attached. ` +
      'Choose a reference-capable model or clear the selection. No image was requested.',
    )
  }

  const byId = new Map(owned.map(character => [character.id, character]))

  const chosen: Array<{ id: string; name: string; file: string; source: string }> = []
  for (const id of scopeIds) {
    const character = byId.get(id)
    if (!character) {
      throw new Error(
        `${where}Character '${id}' is not part of ${input.belongsTo}, so it cannot be used as a reference here. ` +
        'Clear it and choose a character of this channel. No image was requested.',
      )
    }
    const filename = character.references?.images?.[0]
    if (!filename) {
      throw new Error(
        `${where}'${character.name}' has no reference image, so it cannot be used as a reference here. ` +
        'Add one on the Character Sheet or clear it. No image was requested.',
      )
    }
    const source = referenceImagePath(input.slug, character.id, filename)
    if (!existsSync(source)) {
      throw new Error(
        `${where}'${character.name}'s reference image is missing: ${source}. ` +
        'Add it again on the Character Sheet or clear the character. No image was requested.',
      )
    }
    chosen.push({ id: character.id, name: character.name, file: filename, source })
  }

  // The ceiling is the model's live published figure — re-read on every job,
  // so a model switch always enforces the new model's number (§1).
  if (chosen.length > maxReferences) {
    throw new Error(
      `${where}${chosen.length} character reference(s) were selected but ${input.modelName} accepts at most ` +
      `${maxReferences}. Remove ${chosen.length - maxReferences} and retry. No image was requested.`,
    )
  }

  const fitted: ResolvedSceneReferences['fitted'] = []
  const paths: string[] = []
  for (const item of chosen) {
    // A per-character cache directory: two characters may both have a
    // "portrait.png", and a shared directory would silently submit one
    // character's discarded copy for the other (AGENTS.md §4).
    const fit = await fitReferenceImage(
      item.source,
      input.maxDimension,
      path.join(input.episodeDir, SCENE_REFERENCE_DIRNAME, FITTED_REFERENCE_DIRNAME, item.id),
    )
    paths.push(fit.path)
    if (fit.resized) fitted.push({ name: item.name, from: fit.from!, to: fit.to! })
  }
  return {
    paths,
    // Digests come from the SOURCE portraits, not the fitted copies: a derived
    // copy is re-encoded on every run, and its bytes must never be able to move
    // the request identity (that would buy a second render on a plain retry).
    digests: await Promise.all(chosen.map(item => referenceContentDigest(item.source))),
    names: chosen.map(item => item.name),
    fitted,
  }
}

export async function resolveSceneReferences(
  input: ResolveSceneReferencesInput,
): Promise<ResolvedSceneReferences> {
  // Membership in THIS episode's own list is the ownership statement.
  const owned = await listCharacters(input.slug, { episodeCode: input.episodeCode })
  return resolveReferencesFrom(owned, {
    slug: input.slug,
    characterIds: input.characterIds,
    modelName: input.modelName,
    supportsReferences: input.supportsReferences,
    maxReferences: input.maxReferences,
    maxDimension: input.maxDimension,
    episodeDir: input.episodeDir,
    sceneLabel: input.sceneLabel,
    belongsTo: input.episodeCode,
  })
}

/**
 * Resolve references for a CHANNEL-scoped surface (Still Posts).
 *
 * Ownership is the channel's own character list — `listCharacters(slug)` with no episode — so a
 * character belonging to another channel is never rendered from, and a character that belongs to
 * this channel is usable on every post without being re-picked per post.
 */
export async function resolveChannelReferences(
  input: ResolveChannelReferencesInput,
): Promise<ResolvedSceneReferences> {
  const owned = await listCharacters(input.slug)
  return resolveReferencesFrom(owned, {
    slug: input.slug,
    characterIds: input.characterIds,
    modelName: input.modelName,
    supportsReferences: input.supportsReferences,
    maxReferences: input.maxReferences,
    maxDimension: input.maxDimension,
    episodeDir: input.cacheDir,
    sceneLabel: input.postLabel,
    belongsTo: 'this channel',
  })
}

/** One file's short content digest, as used in request identities. */
export async function referenceContentDigest(sourcePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex').slice(0, 16)
}

/**
 * Identity of WHICH reference files a request carries, from their CONTENT.
 *
 * Appended to the request identity so that changing only the attached
 * characters produces a new Gateway request instead of replaying the previous
 * render (AGENTS.md §8: a retry reconnects, a change does not). `''` when
 * nothing is attached, so a text-only request keeps the identity it has always
 * had on disk and no existing manifest entry stops matching.
 */
export async function referenceContentIdentity(paths: readonly string[]): Promise<string> {
  const parts: string[] = []
  for (const source of paths) parts.push(await referenceContentDigest(source))
  return parts.join('-')
}

/** A scene the renderer puts the cast in (the pre-v1.0.336 default). */
export function sceneTakesCharacterReferences(
  scene: Pick<ScenePlanEntry, 'scene_type'>,
): boolean {
  return !scene.scene_type || scene.scene_type === 'character'
}

/**
 * The ids a scene actually uses.
 *
 * A scene's OWN list wins — including an empty one, which means "this scene
 * renders from its prompt alone". Only a scene that never chose falls back to
 * the episode-level selection, so a deliberate text-only scene is not quietly
 * re-populated from the default (§4: replace, or blank, never inherit).
 */
export function sceneReferenceIds(
  scene: Pick<ScenePlanEntry, 'reference_character_ids'>,
  fallback: readonly string[] = [],
  imageMode?: 'text2img' | 'img2img',
): string[] {
  if (imageMode === 'text2img') return []
  const own = Array.isArray(scene.reference_character_ids)
    ? scene.reference_character_ids
      .filter((id): id is string => typeof id === 'string' && !!id.trim())
      .map(id => id.trim())
    : undefined
  return [...new Set(own ?? fallback)]
}

/**
 * The cast the planner may propose from: this episode's ContinuityConfig
 * anchors first, then the channel's project-scoped characters (a mascot is
 * just a project-scoped character). Episode-scoped characters of OTHER
 * episodes are never in this list.
 */
export async function sceneReferenceCandidates(
  slug: string,
  episodeCode: string,
  anchorIds: readonly string[] = [],
): Promise<Array<{ id: string; name: string }>> {
  const owned = await listCharacters(slug, { episodeCode })
  const byId = new Map(owned.map(character => [character.id, character]))
  const anchors = [...new Set(anchorIds)].map(id => byId.get(id)).filter(Boolean)
  const rest = owned.filter(character => character.scope === 'project'
    && !anchors.some(anchor => anchor!.id === character.id))
  return [...anchors, ...rest].map(character => ({ id: character!.id, name: character!.name }))
}

/**
 * Propose each scene's references from the cast, by NAME.
 *
 * Character scenes only; a non-character scene is proposed none. A scene whose
 * text names nobody is proposed none — the mascot is only proposed for scenes
 * it actually appears in, and a scene nobody is in renders from its prompt
 * alone, which is the intended outcome rather than a fallback. The customer can
 * add or remove characters per scene afterwards.
 */
export function proposeSceneReferenceCharacters(
  scenes: ScenePlanEntry[],
  cast: ReadonlyArray<{ id: string; name: string }>,
): void {
  for (const scene of scenes) {
    if (!sceneTakesCharacterReferences(scene)) {
      scene.reference_character_ids = []
      continue
    }
    const text = `${scene.visual_prompt || ''}\n${scene.transcript_segment || ''}`
    scene.reference_character_ids = findReferencedCharacters(text, [...cast]).map(character => character.id)
  }
}

/**
 * Propose per-scene references for a freshly planned episode.
 *
 * The cast is the episode's own: its ContinuityConfig anchors first, then the
 * channel's project-scoped characters (a mascot is just one of those). The
 * proposal is a starting point the customer edits per scene — never a decision
 * that rides in a preset.
 */
export async function proposeSceneReferencesForEpisode(
  slug: string,
  episodeCode: string,
  episodeDir: string,
  scenes: ScenePlanEntry[],
): Promise<void> {
  let anchors: string[] = []
  try {
    const raw = JSON.parse(await fs.readFile(path.join(episodeDir, 'continuity.json'), 'utf-8'))
    anchors = Array.isArray(raw?.anchor_character_ids)
      ? raw.anchor_character_ids.filter((id: unknown): id is string => typeof id === 'string')
      : []
  } catch { /* no sidecar = no anchors */ }
  const cast = await sceneReferenceCandidates(slug, episodeCode, anchors)
  proposeSceneReferenceCharacters(scenes, cast)
}
