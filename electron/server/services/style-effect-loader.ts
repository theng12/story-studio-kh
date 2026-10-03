/**
 * Caption looks and scene effects, from the app and from installed packs.
 *
 * v1.2.1 — Phase 3. v1.1.0 made a caption look a document and v1.2.0 made a
 * camera move and an overlay documents; this is where an installed Content Pack
 * gets to add its own alongside them.
 *
 * ── What this module guarantees ────────────────────────────────────────────
 *
 * 1. **The built-ins are the floor.** Every list starts from the shipped
 *    library and a pack can only append. With zero packs installed each
 *    function returns exactly what v1.2.0 returned, in the same order — the
 *    sixteen caption looks, twenty-four scene motions, seven B-Roll motions and
 *    thirteen overlays keep working whether or not anything is installed, and
 *    whether or not the pack subsystem can even be read.
 *
 * 2. **A pack never shadows a built-in.** Built-in ids are bare slugs and pack
 *    item ids are qualified reverse-DNS, so the namespaces cannot collide — but
 *    "cannot" is an invariant to enforce, not one to rely on. A colliding id is
 *    REFUSED, reported by name, and the built-in keeps the slot. The refusal is
 *    also made at install time in `content-packs/schemas.ts`; this is the
 *    second of the two, because a registry that silently prefers one of two
 *    same-named things is the failure mode worth spending a check on.
 *
 * 3. **A broken pack costs its own entries and nothing else.** One unreadable
 *    document is dropped with a named refusal, exactly as
 *    `thumbnail-template-loader` skips a malformed template: one bad file must
 *    not hide the whole library. A pack subsystem that cannot be read at all
 *    (no state file, a locked directory) falls back to the built-ins rather
 *    than failing the picker.
 *
 * 4. **Provenance travels with the entry.** Every record carries `origin`, so
 *    the picker can say which pack a look came from and — when the pack is
 *    gone — why the look is no longer there.
 */

import {
  listCatalogEntries,
  type CatalogEntry,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { registryOptionsForCurrentJob } from '../content-packs/project-pins.js'
import {
  contentPackDocumentToSceneMotion,
  contentPackDocumentToSceneOverlay,
  contentPackDocumentToSceneReveal,
  contentPackDocumentToSubtitlePreset,
  type PackSceneMotion,
  type PackSceneOverlay,
  type PackSceneReveal,
  type PackSubtitlePreset,
} from '../content-packs/legacy-adapters.js'
import type { ContentPackDocument, ContentPackItemKind } from '../content-packs/types.js'
import { BUILT_IN_ORIGIN, type ContentOrigin } from '../contracts/content-origin.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import {
  BUILT_IN_FOOTAGE_MOTIONS,
  BUILT_IN_OVERLAYS,
  BUILT_IN_SCENE_MOTIONS,
} from '../contracts/scene-effect-presets.js'
import { SCENE_EFFECT_SCHEMA_VERSION } from '../contracts/scene-effects.js'
import { BUILT_IN_SCENE_REVEALS } from '../contracts/scene-reveal-presets.js'

/** One pack item that did not make it into the library, and why. */
export interface ContentEntryRefusal {
  item_id: string
  kind: ContentPackItemKind
  pack_id?: string
  pack_version?: string
  reason: string
}

export interface SubtitleStyleCatalog {
  presets: PackSubtitlePreset[]
  refusals: ContentEntryRefusal[]
}

export interface SceneEffectLibrary {
  schema_version: typeof SCENE_EFFECT_SCHEMA_VERSION
  /** The reveal library — the engine's own presets, then installed reveal packs. */
  reveals: PackSceneReveal[]
  scene_motions: PackSceneMotion[]
  footage_motions: PackSceneMotion[]
  overlays: PackSceneOverlay[]
  grouped_overlays: Array<{ category: string; overlays: PackSceneOverlay[] }>
  refusals: ContentEntryRefusal[]
}

function originFor(entry: CatalogEntry<ContentPackDocument>): ContentOrigin {
  return entry.pack
    ? { origin: 'content-pack', pack_id: entry.pack.pack_id, pack_version: entry.pack.version }
    : { origin: 'content-pack' }
}

function withBuiltInOrigin<T extends { id: string }>(entries: readonly T[]): Array<T & { origin: ContentOrigin }> {
  return entries.map(entry => ({ ...entry, origin: BUILT_IN_ORIGIN }))
}

/**
 * Append pack entries to the built-ins, refusing anything that would shadow one.
 *
 * Order is built-ins first, then packs in the registry's own deterministic
 * precedence order, so installing a pack never reshuffles the shipped library
 * under a customer who was halfway down it.
 */
export function appendPackEntries<T extends { id: string; origin: ContentOrigin }>(
  builtIns: readonly T[],
  packEntries: readonly T[],
  kind: ContentPackItemKind,
  refusals: ContentEntryRefusal[],
): T[] {
  const merged = [...builtIns]
  const claimed = new Map(merged.map(entry => [entry.id, entry]))
  for (const entry of packEntries) {
    const existing = claimed.get(entry.id)
    if (existing) {
      refusals.push({
        item_id: entry.id,
        kind,
        ...(entry.origin.pack_id ? { pack_id: entry.origin.pack_id } : {}),
        ...(entry.origin.pack_version ? { pack_version: entry.origin.pack_version } : {}),
        reason: existing.origin.origin === 'built-in'
          ? `refused: "${entry.id}" is the id of a built-in ${kind} that ships with Story Studio, and a Content Pack may never replace or shadow a built-in`
          : `refused: "${entry.id}" was already supplied by ${existing.origin.pack_id ?? 'another Content Pack'}`,
      })
      continue
    }
    claimed.set(entry.id, entry)
    merged.push(entry)
  }
  return merged
}

/**
 * Read one kind out of the installed catalog.
 *
 * Never throws. The pack subsystem is optional infrastructure sitting under a
 * picker; if it cannot be read, the customer gets the free library rather than
 * an error page.
 */
async function packEntriesFor<T>(
  kind: ContentPackItemKind,
  options: ContentPackRegistryOptions,
  map: (entry: CatalogEntry<ContentPackDocument>, origin: ContentOrigin) => T,
  refusals: ContentEntryRefusal[],
): Promise<T[]> {
  let entries: CatalogEntry<ContentPackDocument>[]
  try {
    const effective = await registryOptionsForCurrentJob([kind], options)
    entries = await listCatalogEntries(kind, effective)
  } catch (error) {
    console.warn(`[style-effect-loader] installed ${kind} content is unavailable: ${(error as Error).message}`)
    return []
  }
  const mapped: T[] = []
  for (const entry of entries) {
    if (entry.value.kind !== kind) continue
    try {
      mapped.push(map(entry, originFor(entry)))
    } catch (error) {
      refusals.push({
        item_id: entry.value.id,
        kind,
        ...(entry.pack ? { pack_id: entry.pack.pack_id, pack_version: entry.pack.version } : {}),
        reason: `refused: ${(error as Error).message}`,
      })
      console.warn(`[style-effect-loader] skipping unusable ${kind} ${entry.value.id}: ${(error as Error).message}`)
    }
  }
  return mapped
}

/** The caption gallery: sixteen built-in looks plus anything installed. */
export async function listSubtitleStylePresets(
  options: ContentPackRegistryOptions = {},
): Promise<SubtitleStyleCatalog> {
  const refusals: ContentEntryRefusal[] = []
  const packEntries = await packEntriesFor(
    'subtitle-style',
    options,
    (entry, origin) => contentPackDocumentToSubtitlePreset(
      entry.value as Extract<ContentPackDocument, { kind: 'subtitle-style' }>,
      origin,
    ),
    refusals,
  )
  return {
    presets: appendPackEntries(
      withBuiltInOrigin(BUILT_IN_SUBTITLE_PRESETS),
      packEntries,
      'subtitle-style',
      refusals,
    ),
    refusals,
  }
}

function groupOverlays(overlays: readonly PackSceneOverlay[]): SceneEffectLibrary['grouped_overlays'] {
  const out: SceneEffectLibrary['grouped_overlays'] = []
  for (const item of overlays) {
    let bucket = out.find(candidate => candidate.category === item.category)
    if (!bucket) { bucket = { category: item.category, overlays: [] }; out.push(bucket) }
    bucket.overlays.push(item)
  }
  return out
}

/** Every camera move and overlay the app can render, built-in and installed. */
export async function listSceneEffectLibrary(
  options: ContentPackRegistryOptions = {},
): Promise<SceneEffectLibrary> {
  const refusals: ContentEntryRefusal[] = []
  const [motions, overlays] = await Promise.all([
    packEntriesFor(
      'scene-effect',
      options,
      (entry, origin) => contentPackDocumentToSceneMotion(
        entry.value as Extract<ContentPackDocument, { kind: 'scene-effect' }>,
        origin,
      ),
      refusals,
    ),
    packEntriesFor(
      'overlay',
      options,
      (entry, origin) => contentPackDocumentToSceneOverlay(
        entry.value as Extract<ContentPackDocument, { kind: 'overlay' }>,
        origin,
      ),
      refusals,
    ),
  ])

  // The two motion engines are separate registries on purpose (see
  // MOTION_SOURCES): six of the seven footage ids also name a scene animation
  // and they render differently. A pack move joins exactly one of them, decided
  // by `motion.source`, which `schemas.ts` has already tied to `category`.
  const stillPackMotions = motions.filter(entry => entry.document.source !== 'footage')
  const footagePackMotions = motions.filter(entry => entry.document.source === 'footage')

  const mergedOverlays = appendPackEntries(
    withBuiltInOrigin(BUILT_IN_OVERLAYS),
    overlays,
    'overlay',
    refusals,
  )
  const reveals = await listRevealPresets(options)
  return {
    schema_version: SCENE_EFFECT_SCHEMA_VERSION,
    reveals,
    scene_motions: appendPackEntries(
      withBuiltInOrigin(BUILT_IN_SCENE_MOTIONS),
      stillPackMotions,
      'scene-effect',
      refusals,
    ),
    footage_motions: appendPackEntries(
      withBuiltInOrigin(BUILT_IN_FOOTAGE_MOTIONS),
      footagePackMotions,
      'scene-effect',
      refusals,
    ),
    overlays: mergedOverlays,
    grouped_overlays: groupOverlays(mergedOverlays),
    refusals,
  }
}

/**
 * The reveal library: the engine's own presets, then whatever packs installed.
 *
 * Same contract as the caption and effect libraries above — built-ins are the floor, a pack only
 * appends, a colliding id is refused by name, and a broken pack costs its own entries and nothing
 * else. The reveal engine's defaults stay usable with no pack installed, which is what makes the
 * six-wipe default pool a promise rather than a hope.
 */
export async function listRevealPresets(
  options: ContentPackRegistryOptions = {},
): Promise<Array<PackSceneReveal>> {
  const refusals: ContentEntryRefusal[] = []
  const packReveals = await packEntriesFor(
    'reveal',
    options,
    (entry, origin) => contentPackDocumentToSceneReveal(
      entry.value as Extract<ContentPackDocument, { kind: 'reveal' }>,
      origin,
    ),
    refusals,
  )
  return appendPackEntries(
    withBuiltInOrigin(BUILT_IN_SCENE_REVEALS),
    packReveals,
    'reveal',
    refusals,
  )
}
