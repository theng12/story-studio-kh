/**
 * Per-scene story links and state — Episode Visual Setup Phase 2.
 *
 * The story inventory (`story-entities.json`) says what THIS episode uses. This
 * sidecar says which of those entities appear in each scene, and what has
 * changed for them in that scene: outfit, age, time, weather, damage. It is
 * episode state, keyed by `ScenePlanEntry.id` — the stable scene id that
 * survives reorder, split and merge — never by `scene_index`, which is a
 * position recomputed on every save. A re-plan that renumbers scenes therefore
 * cannot move one scene's links onto another.
 *
 * Deliberately NOT here: channel look. `style_bible` / `negative_prompt` stay
 * in the continuity config; this file only carries story facts. Nothing here
 * names a model or a reference count — selection adapts to the live published
 * capability record at render time.
 */

import { STORY_ENTITY_ID_PATTERN } from './story-entities.js'

export const SCENE_STORY_CONTEXT_FILENAME = 'scene-story-context.json'

/** The state a scene may override for an entity. Omitted fields fall back to the inventory description. */
export const STORY_STATE_FIELDS = ['outfit', 'age', 'time', 'weather', 'damage'] as const
export type StoryStateField = (typeof STORY_STATE_FIELDS)[number]
export type StoryState = Partial<Record<StoryStateField, string>>

export interface SceneStoryEntityLink {
  entity_id: string
  /** Only what this scene changes; absent means the entity as the inventory describes it. */
  state?: StoryState
}

export interface SceneStoryContextEntry {
  /** `ScenePlanEntry.id` — stable, never a positional index. */
  scene_id: string
  entities: SceneStoryEntityLink[]
}

export interface SceneStoryContextDoc {
  schema_version: 1
  scenes: SceneStoryContextEntry[]
  updated_at: string
}

export class SceneStoryContextValidationError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'SceneStoryContextValidationError'
  }
}

function invalid(message: string): never {
  throw new SceneStoryContextValidationError(message)
}

export function emptySceneStoryContext(): SceneStoryContextDoc {
  return { schema_version: 1, scenes: [], updated_at: '' }
}

/**
 * Validate one state object. Unknown fields are refused rather than dropped:
 * a typo must not look like a saved state the renderer then ignores.
 */
export function normalizeStoryState(value: unknown, label: string): StoryState | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`${label}: state must be an object`)
  const state: StoryState = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(STORY_STATE_FIELDS as readonly string[]).includes(key)) {
      invalid(`${label}: state '${key}' is not one of ${STORY_STATE_FIELDS.join(', ')}`)
    }
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string') invalid(`${label}: state '${key}' must be text`)
    const text = raw.trim()
    if (text) state[key as StoryStateField] = text
  }
  return Object.keys(state).length ? state : undefined
}

export function normalizeSceneStoryEntry(value: unknown, index: number): SceneStoryContextEntry {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const sceneId = typeof raw.scene_id === 'string' ? raw.scene_id.trim() : ''
  const label = sceneId ? `Scene '${sceneId}'` : `Scene #${index + 1}`
  if (!sceneId) invalid(`${label}: scene_id is required`)
  if (!Array.isArray(raw.entities)) invalid(`${label}: entities must be a list`)
  const seen = new Set<string>()
  const entities: SceneStoryEntityLink[] = []
  for (const entry of raw.entities) {
    const link = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>
    const entityId = typeof link.entity_id === 'string' ? link.entity_id.trim() : ''
    if (!entityId) invalid(`${label}: every entity link needs an entity_id`)
    if (!STORY_ENTITY_ID_PATTERN.test(entityId)) {
      invalid(`${label}: entity id '${entityId}' is not canonical`)
    }
    if (seen.has(entityId)) invalid(`${label}: duplicate entity link '${entityId}'`)
    seen.add(entityId)
    const state = normalizeStoryState(link.state, `${label}, '${entityId}'`)
    entities.push({ entity_id: entityId, ...(state ? { state } : {}) })
  }
  return { scene_id: sceneId, entities }
}

/** Parse the stored sidecar. Malformed JSON is refused, never read as "no links". */
export function parseSceneStoryContext(raw: string): SceneStoryContextDoc {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `${SCENE_STORY_CONTEXT_FILENAME} is not valid JSON — fix or move that file aside before rendering or saving scene story context`,
    )
  }
  const doc = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  if (doc.schema_version !== 1 || !Array.isArray(doc.scenes)) {
    throw new Error(`${SCENE_STORY_CONTEXT_FILENAME} is not a schema_version 1 scene story context file`)
  }
  const scenes: SceneStoryContextEntry[] = []
  const seen = new Set<string>()
  for (const [index, entry] of doc.scenes.entries()) {
    const normalized = normalizeSceneStoryEntry(entry, index)
    if (seen.has(normalized.scene_id)) invalid(`duplicate scene '${normalized.scene_id}' in ${SCENE_STORY_CONTEXT_FILENAME}`)
    seen.add(normalized.scene_id)
    scenes.push(normalized)
  }
  return { schema_version: 1, scenes, updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : '' }
}

/** `outfit: red coat; time: night` — the fields a scene actually changed, in a fixed order. */
export function describeStoryState(state: StoryState | undefined): string {
  if (!state) return ''
  return STORY_STATE_FIELDS
    .filter(field => state[field])
    .map(field => `${field}: ${state[field]}`)
    .join('; ')
}
