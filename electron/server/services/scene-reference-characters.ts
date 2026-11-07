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
import { withLock } from '../lib/atomic-store.js'
import { listCharacters, referenceImagePath } from './character-manager.js'
import { readStoryEntities } from './story-entities.js'
import { resolveEpisodePathsByCode, resolveEpisodeTitleByCode, resolveScenePlanPath } from './utils.js'
import { findReferencedCharacters } from '../lib/character-name-match.js'
import { FITTED_REFERENCE_DIRNAME, fitReferenceImage } from '../lib/reference-image-fit.js'
import type { StoryEntity } from '../contracts/story-entities.js'
import {
  SCENE_STORY_CONTEXT_FILENAME,
  SceneStoryContextValidationError,
  describeStoryState,
  emptySceneStoryContext,
  normalizeSceneStoryEntry,
  parseSceneStoryContext,
  type SceneStoryContextDoc,
  type SceneStoryContextEntry,
  type StoryState,
} from '../contracts/scene-story-context.js'
import type { ScenePlan, ScenePlanEntry } from '../models/types.js'
import { STORY_STATE_SUFFIX_PREFIX } from './scene-plan-staleness.js'

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
  /**
   * Linked story references left out because the live model published no free
   * slot for them. Adaptive selection truncates rather than refusing: the
   * character selection keeps its existing blocking refusal.
   */
  omitted?: string[]
}

export interface ResolveSceneReferencesInput {
  slug: string
  episodeCode: string
  characterIds: readonly string[]
  /**
   * Story entities this scene links to. Only a kept, important entity's
   * canonical reference (`reference_images[0]`) is attached, and only into
   * slots the live model leaves after the character references. Ids are
   * membership-checked against this episode's own inventory — never paths.
   */
  storyEntityIds?: readonly string[]
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
    /** Episode-owned story files, already ownership-checked by the caller. */
    storyReferences?: ReadonlyArray<{ id: string; name: string; source: string }>
  },
): Promise<ResolvedSceneReferences> {
  const scopeIds = [...new Set(input.characterIds.filter(Boolean))]
  const storyReferences = input.storyReferences ?? []
  if (!scopeIds.length && !storyReferences.length) return { paths: [], digests: [], names: [], fitted: [], omitted: [] }
  const where = input.sceneLabel ? `${input.sceneLabel}: ` : ''

  // An unpublished limit is not a number to guess (§1): NaN >= 1 is false, so it refuses.
  const maxReferences = Number(input.maxReferences)
  if ((!input.supportsReferences || !(maxReferences >= 1)) && (scopeIds.length || storyReferences.length)) {
    const what = scopeIds.length
      ? `${scopeIds.length} selected character reference(s)`
      : `${storyReferences.length} linked story reference(s)`
    throw new Error(
      `${where}${input.modelName} accepts no reference images, so the ${what} cannot be attached. ` +
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

  // Story references are ADAPTIVE: they fill what the character selection left
  // free and the surplus is reported, never silently swapped in for a character.
  const room = Math.max(0, maxReferences - chosen.length)
  const keptStory = storyReferences.slice(0, room)
  const omitted = storyReferences.slice(room).map(item => item.name)
  for (const item of keptStory) {
    chosen.push({ id: item.id, name: item.name, file: path.basename(item.source), source: item.source })
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
    omitted,
  }
}

export async function resolveSceneReferences(
  input: ResolveSceneReferencesInput,
): Promise<ResolvedSceneReferences> {
  // Membership in THIS episode's own list is the ownership statement.
  const owned = await listCharacters(input.slug, { episodeCode: input.episodeCode })
  const storyReferences = await resolveStoryReferenceFiles(
    input.slug,
    input.episodeCode,
    input.episodeDir,
    input.storyEntityIds || [],
  )
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
    storyReferences,
  })
}

/**
 * Resolve linked story entities to files THIS episode owns.
 *
 * Ownership is membership in the episode's own inventory plus realpath
 * containment in its folder — never how a path string looks. A kept, important
 * entity contributes `reference_images[0]`; a dropped or non-important entity
 * contributes nothing, and a cast entity with a linked Channel Character is
 * already attached through the character pipeline, so its file is not repeated.
 */
async function resolveStoryReferenceFiles(
  slug: string,
  episodeCode: string,
  episodeDir: string,
  entityIds: readonly string[],
): Promise<Array<{ id: string; name: string; source: string }>> {
  const ids = [...new Set(entityIds.filter(Boolean))]
  if (!ids.length) return []
  const { doc } = await readStoryEntities(slug, episodeCode)
  const byId = new Map(doc.entities.map(entity => [entity.id, entity]))
  const root = await fs.realpath(episodeDir).catch(() => null)
  const chosen: Array<{ id: string; name: string; source: string }> = []
  const seenPaths = new Set<string>()
  for (const id of ids) {
    const entity = byId.get(id)
    if (!entity) {
      throw new Error(
        `Story entity '${id}' is not part of ${episodeCode}'s story context, so it cannot be used as a reference here. ` +
        'Remove it from the scene and retry. No image was requested.',
      )
    }
    if (entity.review !== 'keep' || !entity.important) continue
    // A cast entity's canonical reference is its Character portrait, already in
    // the selection when that character is attached — never a second file.
    if (entity.kind === 'cast' && entity.character_id) continue
    const filename = entity.reference_images?.[0]
    if (!filename) continue
    const real = await fs.realpath(path.resolve(episodeDir, filename)).catch(() => null)
    const rel = real && root ? path.relative(root, real) : ''
    if (!real || !root || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `'${entity.name}' lists reference image '${filename}', but it is missing from this episode's folder. ` +
        'Add it again in Story context or clear the entity from the scene. No image was requested.',
      )
    }
    if (seenPaths.has(real)) continue
    seenPaths.add(real)
    chosen.push({ id: entity.id, name: entity.name, source: real })
  }
  return chosen
}

// ── Per-scene story links and state ───────────────────────────────────

export interface SceneStoryContextRead {
  /** `false` when this episode has no sidecar yet — no links, not an error. */
  exists: boolean
  doc: SceneStoryContextDoc
  /** The episode's whole inventory, dropped entities included; callers filter by `review`. */
  entities: StoryEntity[]
}

/** Read this episode's per-scene story links beside its inventory. */
export async function readSceneStoryContext(
  slug: string,
  episodeId: string,
): Promise<SceneStoryContextRead> {
  const story = await readStoryEntities(slug, episodeId)
  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const file = path.join(paths.episode_dir, SCENE_STORY_CONTEXT_FILENAME)
  try {
    const doc = parseSceneStoryContext(await fs.readFile(file, 'utf-8'))
    return { exists: true, doc, entities: story.doc.entities }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
    return { exists: false, doc: emptySceneStoryContext(), entities: story.doc.entities }
  }
}

/**
 * Save per-scene links. A payload entry REPLACES that scene's entry and scenes
 * the payload never mentions are kept, so a partial save cannot wipe another
 * scene's links. Scene ids must exist in the saved plan and entity ids in the
 * kept inventory — a stale link is refused, not written into a phantom scene.
 */
export async function writeSceneStoryContext(
  slug: string,
  episodeId: string,
  body: unknown,
): Promise<{ exists: true; doc: SceneStoryContextDoc }> {
  if (!await resolveEpisodeTitleByCode(slug, episodeId)) {
    throw Object.assign(new Error(`Episode ${episodeId} not found`), { statusCode: 404 })
  }
  const raw = (body ?? {}) as Record<string, unknown>
  if (!Array.isArray(raw.scenes)) {
    throw new SceneStoryContextValidationError('scenes must be a list')
  }
  const payload = raw.scenes.map((entry, index) => normalizeSceneStoryEntry(entry, index))

  const paths = await resolveEpisodePathsByCode(slug, episodeId)
  const planPath = await resolveScenePlanPath(slug, episodeId, paths.episode_dir)
  let plan: ScenePlan
  try {
    plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  } catch {
    throw new SceneStoryContextValidationError('Save a Scene Plan before linking story entities to scenes')
  }
  const knownScenes = new Set((plan.scenes || []).map(scene => scene.id))
  const { doc: inventory } = await readStoryEntities(slug, episodeId)
  const keptEntities = new Set(inventory.entities.filter(entity => entity.review === 'keep').map(entity => entity.id))
  for (const entry of payload) {
    if (!knownScenes.has(entry.scene_id)) {
      throw new SceneStoryContextValidationError(`Scene '${entry.scene_id}' is not in the saved Scene Plan`)
    }
    for (const link of entry.entities) {
      if (!keptEntities.has(link.entity_id)) {
        throw new SceneStoryContextValidationError(
          `Story entity '${link.entity_id}' is not in this episode's kept story context`,
        )
      }
    }
  }

  const file = path.join(paths.episode_dir, SCENE_STORY_CONTEXT_FILENAME)
  return withLock(file, async () => {
    let stored = emptySceneStoryContext()
    try {
      stored = parseSceneStoryContext(await fs.readFile(file, 'utf-8'))
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
    const byScene = new Map(stored.scenes.map(entry => [entry.scene_id, entry]))
    for (const entry of payload) byScene.set(entry.scene_id, entry)
    const doc: SceneStoryContextDoc = {
      schema_version: 1,
      scenes: [...byScene.values()],
      updated_at: new Date().toISOString(),
    }
    await fs.mkdir(paths.episode_dir, { recursive: true })
    await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf-8')
    return { exists: true as const, doc }
  })
}

export interface SceneStoryEntityLink {
  entity: StoryEntity
  state?: StoryState
}

/** This scene's links, resolved against the inventory; a dropped or unknown entity is skipped. */
export function sceneStoryEntityLinks(
  sceneId: string,
  story: Pick<SceneStoryContextRead, 'doc' | 'entities'>,
): SceneStoryEntityLink[] {
  const entry = story.doc.scenes.find(item => item.scene_id === sceneId)
  if (!entry) return []
  const byId = new Map(story.entities.map(entity => [entity.id, entity]))
  const links: SceneStoryEntityLink[] = []
  for (const link of entry.entities) {
    const entity = byId.get(link.entity_id)
    if (!entity || entity.review !== 'keep') continue
    links.push({ entity, ...(link.state ? { state: link.state } : {}) })
  }
  return links
}

export interface SceneAdaptiveReferenceInput {
  scene: Pick<ScenePlanEntry, 'id' | 'scene_type' | 'reference_character_ids'>
  story: Pick<SceneStoryContextRead, 'doc' | 'entities'>
  /** The request-level default, used only when neither the scene nor its links name a character. */
  fallback?: readonly string[]
  imageMode?: 'text2img' | 'img2img'
}

/**
 * The character ids a scene actually uses.
 *
 * Order of authority: a deliberate text-only request, the scene's OWN list
 * (including an empty one), the cast entities the scene links, then the
 * request default. A non-character scene gets none — no unrelated guide — and
 * a scene nobody linked falls back rather than inheriting another scene's cast.
 */
export function sceneAdaptiveCharacterIds(input: SceneAdaptiveReferenceInput): string[] {
  if (input.imageMode === 'text2img') return []
  const own = Array.isArray(input.scene.reference_character_ids)
    ? input.scene.reference_character_ids
      .filter((id): id is string => typeof id === 'string' && !!id.trim())
      .map(id => id.trim())
    : undefined
  if (own) return [...new Set(own)]
  if (!sceneTakesCharacterReferences(input.scene)) return []
  const linked = sceneStoryEntityLinks(input.scene.id, input.story)
    .map(link => link.entity.kind === 'cast' ? link.entity.character_id : undefined)
    .filter((id): id is string => !!id)
  if (linked.length) return [...new Set(linked)]
  return [...new Set(input.fallback ?? [])]
}

/**
 * Linked entities whose canonical reference this scene should attach.
 *
 * Kept + important + a real `reference_images[0]`; cast entities with a
 * Channel Character are excluded because that portrait is the character
 * pipeline's job. The caller passes the ids to the reference resolver, which
 * enforces the model's live slot count and reports what did not fit.
 */
export function sceneStoryReferenceEntityIds(
  sceneId: string,
  story: Pick<SceneStoryContextRead, 'doc' | 'entities'>,
): string[] {
  return sceneStoryEntityLinks(sceneId, story)
    .filter(({ entity }) =>
      entity.important
      && !(entity.kind === 'cast' && entity.character_id)
      && !!entity.reference_images?.[0])
    .map(({ entity }) => entity.id)
}

/**
 * The scene's story state as a prompt suffix. Only linked entities appear, so
 * a scene that never links the mascot gets no mascot text, and a field the
 * scene did not change adds nothing.
 */
export function sceneStoryStateSuffix(
  sceneId: string,
  story: Pick<SceneStoryContextRead, 'doc' | 'entities'>,
): { suffix: string; applied: string[] } {
  const parts: string[] = []
  const applied: string[] = []
  for (const { entity, state } of sceneStoryEntityLinks(sceneId, story)) {
    const described = describeStoryState(state)
    if (!described) continue
    parts.push(`${entity.name} — ${described}`)
    applied.push(entity.name)
  }
  return {
    suffix: parts.length ? `${STORY_STATE_SUFFIX_PREFIX}${parts.join(' | ')}.` : '',
    applied,
  }
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
