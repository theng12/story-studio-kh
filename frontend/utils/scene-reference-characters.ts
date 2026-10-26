/**
 * Scene Review "Reference to Image" — the pure rules behind the surface.
 *
 * Every number here comes from the model's LIVE published row (AGENTS.md §1):
 * a model that publishes no reference support, or a ceiling of zero, gets no
 * block; the window, the pixel ceiling and the slot clamp are re-derived on
 * every model change because the page calls these from computeds.
 *
 * The selection itself is EPISODE STATE (AGENTS.md §5): it names specific
 * characters of one episode, so it is never captured by a preset and never
 * survives an episode change unexamined.
 */

export interface SceneReferenceModel {
  display_name?: string
  supports_reference_images?: boolean
  max_reference_images?: number
  min_reference_images?: number
  reference_image_max_dimension?: number
}

export interface SceneReferenceLimits {
  /** Published floor. 0 when the model publishes none. */
  min: number
  /** Published ceiling; at least 1 or there is no block at all. */
  max: number
  /** Published longest-edge ceiling, when the model publishes one. */
  maxDimension?: number
}

/** What the block may offer for this model, or `null` when it must not render. */
export function sceneReferenceLimits(model: SceneReferenceModel | null | undefined): SceneReferenceLimits | null {
  if (!model || model.supports_reference_images !== true) return null
  const max = Number.isInteger(model.max_reference_images) ? (model.max_reference_images as number) : 0
  if (max < 1) return null
  const min = Number.isInteger(model.min_reference_images) && (model.min_reference_images as number) > 0
    ? (model.min_reference_images as number)
    : 0
  const maxDimension = Number.isInteger(model.reference_image_max_dimension) && (model.reference_image_max_dimension as number) > 0
    ? (model.reference_image_max_dimension as number)
    : undefined
  return { min, max, ...(maxDimension ? { maxDimension } : {}) }
}

/**
 * What the block says under its heading.
 *
 * The published COUNT window is already stated by the model picker directly
 * above (its `referenceCountNotice`), so this states the two facts the picker
 * cannot: which scenes the references reach, and what happens to a portrait
 * over the published pixel ceiling.
 */
export function sceneReferenceNotice(limits: SceneReferenceLimits): string {
  const dimension = limits.maxDimension
    ? ` Portraits larger than ${limits.maxDimension.toLocaleString()}px on the longest side are scaled down to fit before upload.`
    : ''
  return `References are attached to character scenes; cutaways render without them.${dimension}`
}

export interface SceneReferenceCharacter {
  id: string
  name: string
  references?: { images?: string[] }
  /** `library` for a Channel Character, `project` for a legacy on-disk one. */
  source?: string
}

export interface SceneReferenceDrop {
  id: string
  name: string
  reason: string
}

/**
 * Filter a selection through THIS episode's own character list.
 *
 * Called on every episode change and whenever new characters arrive, so a
 * selection can never keep an id the open episode does not own (AGENTS.md §4)
 * — and every drop is named, never applied quietly.
 */
export function reconcileSceneReferenceCharacters(
  selected: readonly string[],
  characters: readonly SceneReferenceCharacter[],
  max: number,
): { kept: string[]; dropped: SceneReferenceDrop[] } {
  const byId = new Map(characters.map(character => [character.id, character]))
  const kept: string[] = []
  const dropped: SceneReferenceDrop[] = []
  for (const id of selected) {
    const character = byId.get(id)
    if (!character) {
      dropped.push({ id, name: id, reason: 'not a character of this episode' })
      continue
    }
    if (!character.references?.images?.length) {
      dropped.push({ id, name: character.name, reason: 'no reference image' })
      continue
    }
    if (kept.length >= max) {
      dropped.push({ id, name: character.name, reason: `beyond the model's ${max} slot${max === 1 ? '' : 's'}` })
      continue
    }
    kept.push(id)
  }
  return { kept, dropped }
}

/** One sentence naming what left the selection and why, or '' when nothing did. */
export function describeSceneReferenceDrops(dropped: readonly SceneReferenceDrop[]): string {
  if (!dropped.length) return ''
  const noun = dropped.length === 1 ? 'reference character' : 'reference characters'
  return `Dropped ${dropped.length} ${noun}: ${dropped.map(item => `${item.name} (${item.reason})`).join(', ')}.`
}

/** The portrait to show for a character row, or '' when it has none. */
export function sceneReferencePortrait(character: SceneReferenceCharacter): string {
  return character.references?.images?.[0] || ''
}

/** True when a scene may carry character references (a cutaway may not). */
export function sceneTakesCharacterReferences(scene: { scene_type?: string }): boolean {
  return !scene.scene_type || scene.scene_type === 'character'
}
