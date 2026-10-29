import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import type { CreateProjectRequest, JobType, ProjectMeta, UpdateConfigRequest } from '../models/types.js'
import * as projectManager from '../services/project-manager.js'
import { verifyInstalledContentPackClosure } from './installer.js'
import { getFirstPartyContentPackVerificationPolicy } from './keyring.js'
import {
  resolveCatalogItem,
  resolveCatalogPackVersion,
  type CatalogPackVersion,
  type ContentPackRegistryOptions,
} from './registry.js'
import { ContentPackMissingError, isContentPackUnusable, type ContentPackMissingRequirement } from './missing-error.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import type { ContentPackProvenance, ContentPackVersionRef } from './runtime-types.js'
import { isBundleOnlyCoordinationManifest } from './schemas.js'
import { readContentPackState, withContentPackCoordinationLock } from './state.js'
import type { ContentPackItemKind } from './types.js'
import { currentJobContentPackProvenance } from './job-provenance-context.js'
import { isContentStoreRevalidationRequired } from '../content-store/commerce-state.js'

export { ContentPackMissingError } from './missing-error.js'
export type { ContentPackMissingRequirement } from './missing-error.js'

export interface ContentPackUpgradePlan {
  pack_id: string
  from: ContentPackVersionRef
  to: ContentPackVersionRef
  changed_item_ids: string[]
  affected_generation_types: JobType[]
}

export interface LegacyContentMigrationSelection {
  kind: ContentPackItemKind
  from_id: string
  to_id: string
  to: ContentPackVersionRef
}

/**
 * A preview is deliberately separate from the mutation. The exact archive
 * references make the customer-visible review meaningful and prevent a
 * later discovery change from turning a legacy migration into an upgrade.
 */
export interface LegacyContentMigrationPlan {
  project_slug: string
  preview_id: string
  selections: LegacyContentMigrationSelection[]
}

export interface ContentPackProjectPinOptions extends ContentPackRegistryOptions {
  paths?: ContentPackRuntimePaths
  hooks?: {
    /** Test seam reached under coordination after exact verification. */
    beforeProjectWrite?: () => Promise<void>
    /** Test seam proving that legacy/local writes follow a signed-catalog miss. */
    afterCatalogItemResolution?: (id: string, pin: ContentPackVersionRef | undefined) => void
    /** Test seam for crash-consistent project/config write-phase evidence. */
    consistentProjectWrite?: projectManager.ConsistentProjectWriteHooks
  }
}

export interface ProjectContentSelectionUpdate {
  replace_kinds: ContentPackItemKind[]
  selections: Array<{ id: string; kind: ContentPackItemKind }>
  update: (project: ProjectMeta) => void
}

type SignedSelection = { id: string; kind: ContentPackItemKind; ref: ContentPackVersionRef }

export interface ProjectContentBundleApplicationRequest {
  root: ContentPackVersionRef
  bundle_id: string
}

export interface ProjectContentBundleApplicationResult {
  project_slug: string
  bundle_id: string
  formula_id: string
  topic_pack_ids: string[]
  default_style_id: string
  alternative_style_ids: string[]
  style_refs: Array<{ item_id: string; ref: ContentPackVersionRef }>
  thumbnail_recipe_id: string
  content_pack_versions: Record<string, string>
}

const HIDDEN_MECHANICS_MIGRATION_TARGETS = {
  formula: {
    from: 'hidden-mechanics-history',
    to: 'com.storystudio.formula.archival-ledger',
    pack_id: 'com.storystudio.pack.formula.archival-ledger',
    kind: 'series-formula',
  },
  topics: {
    'historical-states-revolutions-collapse': {
      to: 'com.storystudio.topic.archival-ledger.states-revolutions-collapse',
      pack_id: 'com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse',
    },
    'historical-money-debt-financial-institutions': {
      to: 'com.storystudio.topic.archival-ledger.money-debt-financial-institutions',
      pack_id: 'com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions',
    },
    'historical-empires-trade-extraction': {
      to: 'com.storystudio.topic.archival-ledger.empires-trade-extraction',
      pack_id: 'com.storystudio.pack.topic.archival-ledger.empires-trade-extraction',
    },
    'historical-wars-treaties-world-order': {
      to: 'com.storystudio.topic.archival-ledger.wars-treaties-world-order',
      pack_id: 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order',
    },
    'historical-infrastructure-commodities-corporate-power': {
      to: 'com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power',
      pack_id: 'com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power',
    },
  },
  recipe: {
    from: 'archival-map-investigation',
    to: 'com.storystudio.thumbnail.archival-map-investigation',
    pack_id: 'com.storystudio.pack.thumbnail.archival-map-investigation',
    kind: 'thumbnail-recipe',
  },
} as const

/**
 * Preview capabilities are intentionally process-local and one-time. A restart
 * requires a fresh review instead of accepting a stale or caller-edited plan.
 */
const legacyMigrationPreviews = new Map<string, LegacyContentMigrationPlan>()

function applyContentSelections(
  project: ProjectMeta,
  signed: SignedSelection[],
  replaceKinds: readonly ContentPackItemKind[],
  update: (project: ProjectMeta) => void,
): void {
  for (const selection of signed) {
    const pinnedVersion = project.content_pack_versions?.[selection.ref.pack_id]
    if (pinnedVersion && pinnedVersion !== selection.ref.version) {
      throw Object.assign(new Error(
        `Project pins ${selection.ref.pack_id}@${pinnedVersion}. Review and apply an explicit upgrade before selecting content from ${selection.ref.version}.`,
      ), { statusCode: 409, expose: true })
    }
  }
  update(project)
  const replaced = new Set(replaceKinds)
  const items = Object.fromEntries(Object.entries(project.content_pack_items ?? {})
    .filter(([, ref]) => !replaced.has(ref.kind)))
  for (const selection of signed) {
    items[selection.id] = { pack_id: selection.ref.pack_id, kind: selection.kind }
  }
  const referencedPacks = new Set(Object.values(items).map(item => item.pack_id))
  const versions = Object.fromEntries(Object.entries(project.content_pack_versions ?? {})
    .filter(([packId]) => referencedPacks.has(packId)))
  for (const selection of signed) versions[selection.ref.pack_id] = selection.ref.version
  if (Object.keys(items).length) project.content_pack_items = items
  else delete project.content_pack_items
  if (Object.keys(versions).length) project.content_pack_versions = versions
  else delete project.content_pack_versions
}

function pinnedSelectionMissing(
  selection: { id: string; kind: ContentPackItemKind },
  packId: string,
  version: string,
): ContentPackMissingError {
  return new ContentPackMissingError([{
    pack_id: packId,
    version,
    item_ids: [selection.id],
    item_kinds: [selection.kind],
  }])
}

function missingPackVersion(packId: string, version: string): ContentPackMissingError {
  return new ContentPackMissingError([{ pack_id: packId, version, item_ids: [], item_kinds: [] }])
}

export async function resolveProjectPreferredSelection(
  project: ProjectMeta,
  selection: { id: string; kind: ContentPackItemKind },
  options: ContentPackProjectPinOptions,
): Promise<SignedSelection | null> {
  const owner = project.content_pack_items?.[selection.id]
  if (owner) {
    const version = project.content_pack_versions?.[owner.pack_id]
    if (owner.kind !== selection.kind || !version) {
      throw pinnedSelectionMissing(selection, owner.pack_id, version ?? 'unknown')
    }
    let exact: CatalogPackVersion | null = null
    try {
      exact = await resolveCatalogPackVersion(owner.pack_id, version, options)
    } catch { /* normalized below so a corrupt pin never reaches active discovery */ }
    if (!exact) throw pinnedSelectionMissing(selection, owner.pack_id, version)
    let entry: Awaited<ReturnType<typeof resolveCatalogItem>> = null
    try {
      entry = await resolveCatalogItem(selection.id, exact.ref, {
        ...options,
        pins: [exact.ref, ...(options.pins ?? [])],
      })
      options.hooks?.afterCatalogItemResolution?.(selection.id, exact.ref)
    } catch { /* normalized below */ }
    if (!entry?.pack
      || entry.value.kind !== selection.kind
      || entry.pack.pack_id !== owner.pack_id
      || entry.pack.version !== version
      || entry.pack.archive_sha256 !== exact.ref.archive_sha256) {
      throw pinnedSelectionMissing(selection, owner.pack_id, version)
    }
    return { id: selection.id, kind: selection.kind, ref: { ...exact.ref } }
  }

  const entry = await resolveCatalogItem(selection.id, undefined, options)
  options.hooks?.afterCatalogItemResolution?.(selection.id, undefined)
  if (!entry?.pack) return null
  if (entry.value.kind !== selection.kind) {
    throw Object.assign(new Error(`Content Pack item kind mismatch: ${selection.id}`), { statusCode: 409, expose: true })
  }
  return { id: selection.id, kind: selection.kind, ref: { ...entry.pack } }
}

async function resolveSignedSelections(
  project: ProjectMeta,
  selections: Array<{ id: string; kind: ContentPackItemKind }>,
  options: ContentPackProjectPinOptions,
): Promise<SignedSelection[]> {
  const signed: SignedSelection[] = []
  for (const selection of selections) {
    const resolved = await resolveProjectPreferredSelection(project, selection, options)
    if (resolved) signed.push(resolved)
  }
  return signed
}

const CONSUMERS: Record<ContentPackItemKind, readonly JobType[]> = {
  'series-formula': [
    'idea_campaign', 'introduction-only', 'chapter-only', 'outline_only',
    'expand_chapters', 'image_prompts', 'metadata', 'scene_plan_run',
  ],
  'topic-pack': [
    'idea_campaign', 'introduction-only', 'chapter-only', 'outline_only',
    'expand_chapters', 'image_prompts', 'metadata', 'scene_plan_run',
  ],
  // Render jobs consume already-materialised prompts/reference paths, not the
  // style/recipe documents that produced them. Missing catalog bytes must not
  // strand usable downstream work.
  'visual-style': ['image_prompts'],
  'thumbnail-recipe': ['image_prompts'],
  // v1.2.1, and the opposite case to the two above — worth stating plainly. A
  // visual style has already done its work by the time a render starts, but a
  // scene effect has NOT: Video Assembly resolves the effect document afresh on
  // every render, so a pack that is gone changes the finished picture.
  // `video_assembly` is therefore fail-closed for these kinds.
  //
  // A caption look is in between and is listed anyway. Applying one copies the
  // finished style document into the episode's own config (SubtitleStylePicker
  // emits STYLE and nothing else), so an uninstalled pack cannot silently
  // change how captions burn — but a project that pinned the pack should be
  // told the pack is missing, not left to discover it when the look quietly
  // disappears from the gallery.
  'subtitle-style': ['video_assembly'],
  'scene-effect': ['video_assembly'],
  overlay: ['video_assembly'],
  // Same reasoning as `scene-effect`, and the same job: Video Assembly resolves each scene's
  // reveal document afresh on every render, so a pack that has gone changes the finished picture.
  reveal: ['video_assembly'],
  // A lettering style is read when thumbnail prompts are written — that is the
  // job whose output carries the phrase into the image model.
  'lettering-style': ['image_prompts'],
  // A metadata formula is resolved fresh on every metadata run — it IS the
  // shape of the description being written — so a project that pinned the pack
  // supplying it must be told when that pack is missing rather than quietly
  // reverting to a different architecture.
  'metadata-formula': ['metadata'],
}

function pathsFor(options: ContentPackProjectPinOptions): ContentPackRuntimePaths {
  return options.paths ?? getContentPackRuntimePaths()
}

function itemRefsForPack(
  project: ProjectMeta,
  packId: string,
): Array<{ id: string; kind: ContentPackItemKind }> {
  const explicit = Object.entries(project.content_pack_items ?? {})
    .filter(([, ref]) => ref.pack_id === packId)
    .map(([id, ref]) => ({ id, kind: ref.kind }))
  if (explicit.length) return explicit.sort((left, right) => left.id.localeCompare(right.id))

  // Compatibility for hand-imported metadata created before the item-owner
  // map shipped. Qualified first-party item ids are pack-prefixed; new writes
  // always persist the explicit map and never rely on this inference.
  const inferred: Array<{ id: string; kind: ContentPackItemKind }> = []
  if (project.niche_id?.startsWith(`${packId}.`)) inferred.push({ id: project.niche_id, kind: 'series-formula' })
  for (const id of project.topic_pack_ids ?? []) {
    if (id.startsWith(`${packId}.`)) inferred.push({ id, kind: 'topic-pack' })
  }
  const thumbnailId = project.thumbnail_template_id
  if (thumbnailId?.startsWith(`${packId}.`)) inferred.push({ id: thumbnailId, kind: 'thumbnail-recipe' })
  const styleId = project.active_style_preset_id
  if (styleId?.startsWith(`${packId}.`)) inferred.push({ id: styleId, kind: 'visual-style' })
  return inferred.sort((left, right) => left.id.localeCompare(right.id))
}

function missingRequirement(project: ProjectMeta, packId: string, version: string): ContentPackMissingRequirement {
  const items = itemRefsForPack(project, packId)
  return {
    pack_id: packId,
    version,
    item_ids: items.map(item => item.id),
    item_kinds: [...new Set(items.map(item => item.kind))].sort(),
  }
}

function requirementAffects(requirement: ContentPackMissingRequirement, jobType: JobType): boolean {
  // Unknown item ownership is fail-closed only for generation types that can
  // consume creative pack data; local delivery/audio work remains available.
  if (!requirement.item_kinds.length) {
    return Object.values(CONSUMERS).some(types => types.includes(jobType))
  }
  return requirement.item_kinds.some(kind => CONSUMERS[kind].includes(jobType))
}

async function resolveProjectContentPinsLocked(
  project: ProjectMeta,
  options: ContentPackProjectPinOptions,
  requiredKinds?: ReadonlySet<ContentPackItemKind>,
): Promise<Array<{ pack: CatalogPackVersion; items: Array<{ id: string; kind: ContentPackItemKind }> }>> {
  const resolved: Array<{ pack: CatalogPackVersion; items: Array<{ id: string; kind: ContentPackItemKind }> }> = []
  const missing: ContentPackMissingRequirement[] = []
  for (const [packId, version] of Object.entries(project.content_pack_versions ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const items = itemRefsForPack(project, packId)
    const relevant = !requiredKinds || !items.length || items.some(item => requiredKinds.has(item.kind))
    if (!relevant) continue
    const pack = await resolveCatalogPackVersion(packId, version, options)
    if (!pack) {
      missing.push(missingRequirement(project, packId, version))
      continue
    }
    const selected = items.length ? items : pack.items.map(item => ({ id: item.id, kind: item.kind }))
    const availableIds = new Set(pack.items.map(item => item.id))
    const missingItems = selected.filter(item => !availableIds.has(item.id))
    if (missingItems.length) {
      missing.push({
        pack_id: packId,
        version,
        item_ids: missingItems.map(item => item.id),
        item_kinds: [...new Set(missingItems.map(item => item.kind))].sort(),
      })
      continue
    }
    resolved.push({ pack, items: selected })
  }
  if (missing.length) throw new ContentPackMissingError(missing)
  return resolved
}

export async function resolveProjectContentPins(
  project: ProjectMeta,
  options: ContentPackProjectPinOptions = {},
): Promise<ContentPackVersionRef[]> {
  return withContentPackCoordinationLock(pathsFor(options), async () => (
    (await resolveProjectContentPinsLocked(project, options)).map(entry => ({ ...entry.pack.ref }))
  ))
}

async function resolveCurrentJobContentPinsLocked(
  kinds: readonly ContentPackItemKind[],
  options: ContentPackProjectPinOptions,
): Promise<ContentPackVersionRef[] | null> {
  const jobSnapshot = currentJobContentPackProvenance()
  if (!jobSnapshot) return null
  const requiredKinds = new Set(kinds)
  const refs: ContentPackVersionRef[] = []
  const missing: ContentPackMissingRequirement[] = []
  for (const provenance of jobSnapshot) {
    const pack = await resolveCatalogPackVersion(
      provenance.pack_id,
      provenance.version,
      options,
      provenance.archive_sha256,
    )
    const knownKinds = pack?.items
      .filter(item => provenance.item_ids.includes(item.id))
      .map(item => item.kind) ?? []
    const relevant = !knownKinds.length || knownKinds.some(kind => requiredKinds.has(kind))
    if (!relevant) continue
    if (!pack) {
      missing.push({
        pack_id: provenance.pack_id,
        version: provenance.version,
        item_ids: [...provenance.item_ids].sort(),
        item_kinds: [],
      })
    } else refs.push({ ...pack.ref })
  }
  if (missing.length) throw new ContentPackMissingError(missing)
  return refs
}

/** Make direct loader calls inside an executor honor the immutable job snapshot. */
export async function registryOptionsForCurrentJob(
  kinds: readonly ContentPackItemKind[],
  options: ContentPackProjectPinOptions = {},
): Promise<ContentPackRegistryOptions> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const pins = await resolveCurrentJobContentPinsLocked(kinds, options)
    return pins ? { ...options, pins } : options
  })
}

/** Resolve only pins that can feed the requested content consumers. */
export async function resolveProjectContentPinsForKinds(
  project: ProjectMeta,
  kinds: readonly ContentPackItemKind[],
  options: ContentPackProjectPinOptions = {},
): Promise<ContentPackVersionRef[]> {
  const requiredKinds = new Set(kinds)
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const jobPins = await resolveCurrentJobContentPinsLocked(kinds, options)
    if (jobPins) return jobPins
    return (await resolveProjectContentPinsLocked(project, options, requiredKinds)).map(entry => ({ ...entry.pack.ref }))
  })
}

function writePackSelection(project: ProjectMeta, pack: CatalogPackVersion): void {
  const versions = { ...(project.content_pack_versions ?? {}), [pack.ref.pack_id]: pack.ref.version }
  const items = Object.fromEntries(Object.entries(project.content_pack_items ?? {})
    .filter(([, ref]) => ref.pack_id !== pack.ref.pack_id))
  for (const item of pack.items) items[item.id] = { pack_id: pack.ref.pack_id, kind: item.kind }
  project.content_pack_versions = versions
  project.content_pack_items = items
}

async function resolveExpectedPack(
  ref: ContentPackVersionRef,
  options: ContentPackProjectPinOptions,
): Promise<CatalogPackVersion> {
  const pack = await resolveCatalogPackVersion(ref.pack_id, ref.version, options, ref.archive_sha256)
  if (!pack) throw new ContentPackMissingError([{
    pack_id: ref.pack_id,
    version: ref.version,
    item_ids: [],
    item_kinds: [],
  }])
  return pack
}

export async function setProjectContentPin(
  slug: string,
  ref: ContentPackVersionRef,
  options: ContentPackProjectPinOptions = {},
): Promise<ProjectMeta> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const pack = await resolveExpectedPack(ref, options)
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.mutateProjectMetaConsistently(slug, project => writePackSelection(project, pack))
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    return updated
  })
}

/**
 * One explicit user selection transaction: resolve today's active signed
 * entries, then write the human-facing selection and exact pins together.
 * Legacy entries remain selectable but create no signed pin.
 */
export async function updateProjectContentSelections(
  slug: string,
  input: ProjectContentSelectionUpdate,
  options: ContentPackProjectPinOptions = {},
): Promise<ProjectMeta> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const project = await projectManager.readProjectMetaConsistently(slug)
    if (!project) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    const signed = await resolveSignedSelections(project, input.selections, options)
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.mutateProjectMetaConsistently(slug, project => {
      applyContentSelections(project, signed, input.replace_kinds, input.update)
    })
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    return updated
  })
}

/**
 * A selection the app cannot resolve is a defect, not a preference. Before
 * v1.4.64 an unresolvable id was accepted and then silently produced nothing:
 * the art-style resolver returned null and generation fell back to whatever
 * the channel type happened to dictate, so the customer's saved choice was
 * invisible in the UI and absent from the prompt at the same time. Both axes
 * now refuse the write.
 *
 * Resolvable is deliberately generous, because a working selection must never
 * be refused: a signed catalog item of the right kind; OR, for a style, a
 * project-local `style_presets` entry that actually carries prose; OR, for a
 * recipe, any id the template loader can load, legacy built-ins included.
 * (a real project carries the bare legacy id `archival-map-investigation`, which
 * resolves that way and must keep saving.) An empty string on either axis
 * clears the selection and is always allowed.
 */
async function assertResolvableSelections(
  slug: string,
  request: UpdateConfigRequest,
  options: ContentPackProjectPinOptions,
): Promise<void> {
  const reject = (field: string, id: string, hint: string) => {
    throw Object.assign(new Error(`${field} '${id}' could not be resolved. ${hint}`), {
      statusCode: 422,
      expose: true,
      code: 'unresolvable-content-selection',
    })
  }
  const signedOfKind = async (id: string, kind: ContentPackItemKind) => {
    // v1.4.68 — this call was the one unguarded route out of catalogue
    // resolution, and installer verification failures escaped through it raw.
    //
    // The two outcomes are not the same and must not be flattened. "We never
    // found this id" means try the legacy routes below. "We found the version
    // and verification REFUSED it" means the customer asked for something
    // real that cannot be served, and they are owed that answer — the same
    // answer whether it is uninstalled, recalled, or has bytes that no longer
    // verify. Anything else, the resolver could not answer and the legacy
    // fallbacks decide.
    try {
      const entry = await resolveCatalogItem(id, undefined, options)
      return Boolean(entry) && entry!.value.kind === kind
    } catch (error) {
      if (isContentPackUnusable(error)) {
        throw new ContentPackMissingError([{
          pack_id: error.ref.pack_id ?? 'unknown',
          version: error.ref.version ?? 'unknown',
          item_ids: [id],
          item_kinds: [kind],
        }])
      }
      return false
    }
  }

  const styleId = typeof request.active_style_preset_id === 'string'
    ? request.active_style_preset_id.trim()
    : ''
  if (styleId) {
    let resolvable = await signedOfKind(styleId, 'visual-style')
    if (!resolvable) {
      // The picker writes the preset into `style_presets` in the same payload,
      // so read the incoming list first and only then what is already on disk.
      const incoming = Array.isArray((request as any).style_presets)
        ? (request as any).style_presets
        : (await projectManager.getConfig(slug))?.style_presets
      resolvable = Array.isArray(incoming) && incoming.some((preset: any) =>
        preset && preset.id === styleId && typeof preset.description === 'string' && preset.description.trim())
    }
    if (!resolvable) {
      reject('Art style', styleId, 'Pick a style from the library, or install the pack that provides it.')
    }
  }

  const recipeId = typeof request.thumbnail_template_id === 'string'
    ? request.thumbnail_template_id.trim()
    : ''
  if (recipeId && !(await signedOfKind(recipeId, 'thumbnail-recipe'))) {
    const { loadTemplate } = await import('../services/thumbnail-template-loader.js')
    if (!(await loadTemplate(recipeId, options))) {
      reject('Thumbnail recipe', recipeId, 'Pick a recipe from the library, or install the pack that provides it.')
    }
  }
}

/**
 * Route boundary for config-backed signed selections. Legacy/local ids still
 * update config and project metadata but do not invent a Content Pack pin.
 */
export async function updateProjectContentConfigSelections(
  slug: string,
  request: UpdateConfigRequest,
  options: ContentPackProjectPinOptions = {},
): Promise<ProjectMeta> {
  const hasStyle = Object.prototype.hasOwnProperty.call(request, 'active_style_preset_id')
  const hasRecipe = Object.prototype.hasOwnProperty.call(request, 'thumbnail_template_id')
  // Validate BEFORE taking the coordination lock. The resolvers this uses take
  // that same lock themselves and it is not reentrant, so checking inside would
  // deadlock — and a rejected write has no reason to hold a write barrier.
  await assertResolvableSelections(slug, request, options)
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const project = await projectManager.readProjectMetaConsistently(slug)
    if (!project) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    const selections = [
      ...(hasStyle && typeof request.active_style_preset_id === 'string' && request.active_style_preset_id
        ? [{ id: request.active_style_preset_id, kind: 'visual-style' as const }]
        : []),
      ...(hasRecipe && typeof request.thumbnail_template_id === 'string' && request.thumbnail_template_id
        ? [{ id: request.thumbnail_template_id, kind: 'thumbnail-recipe' as const }]
        : []),
    ]
    const signed = await resolveSignedSelections(project, selections, options)
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.updateConfigAndProjectMetaConsistently(slug, request, project => {
      applyContentSelections(
        project,
        signed,
        [
          ...(hasStyle ? ['visual-style' as const] : []),
          ...(hasRecipe ? ['thumbnail-recipe' as const] : []),
        ],
        current => {
          if (hasStyle) current.active_style_preset_id = request.active_style_preset_id || undefined
          if (hasRecipe) current.thumbnail_template_id = request.thumbnail_template_id || undefined
        },
      )
    })
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    return updated
  })
}

/** Apply one already-installed bundle closure to one project; never installs or purchases content. */
export async function applyProjectContentBundle(
  slug: string,
  request: ProjectContentBundleApplicationRequest,
  options: ContentPackProjectPinOptions = {},
): Promise<ProjectContentBundleApplicationResult> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const project = await projectManager.readProjectMetaConsistently(slug)
    if (!project) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })

    const paths = pathsFor(options)
    const state = await readContentPackState(paths)
    const rootState = state.packs[request.root.pack_id]
    if (!rootState?.versions[request.root.version]
      || rootState.versions[request.root.version].archive_sha256 !== request.root.archive_sha256) {
      throw missingPackVersion(request.root.pack_id, request.root.version)
    }
    if (rootState.discovery_disabled) {
      throw Object.assign(new Error(`Content Pack is disabled: ${request.root.pack_id}`), { statusCode: 409, expose: true })
    }
    const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
    let root
    try {
      root = await verifyInstalledContentPackClosure(
        state,
        request.root.pack_id,
        request.root.version,
        policy,
        options.appVersion,
      )
    } catch {
      throw missingPackVersion(request.root.pack_id, request.root.version)
    }
    if (root.archiveSha256 !== request.root.archive_sha256
      || root.manifest.lifecycle !== 'active'
      || !isBundleOnlyCoordinationManifest(root.manifest)) {
      throw Object.assign(new Error('The requested Content Pack root is not an active bundle-only coordination pack.'), { statusCode: 400, expose: true })
    }
    const bundles = root.manifest.bundles.filter(bundle => bundle.id === request.bundle_id)
    if (bundles.length !== 1 || root.manifest.bundles.length !== 1) {
      throw Object.assign(new Error(`Channel Kit bundle not found: ${request.bundle_id}`), { statusCode: 400, expose: true })
    }

    const selections: SignedSelection[] = []
    for (const component of bundles[0]!.components) {
      const packState = state.packs[component.pack_id]
      if (packState?.discovery_disabled) {
        throw Object.assign(new Error(`Content Pack is disabled: ${component.pack_id}`), { statusCode: 409, expose: true })
      }
      let verified
      try {
        verified = await verifyInstalledContentPackClosure(
          state,
          component.pack_id,
          component.version,
          policy,
          options.appVersion,
        )
      } catch {
        throw pinnedSelectionMissing({ id: component.item_id, kind: component.kind }, component.pack_id, component.version)
      }
      const item = verified.manifest.items.find(candidate => candidate.id === component.item_id)
      if (verified.manifest.lifecycle !== 'active' || item?.kind !== component.kind) {
        throw Object.assign(new Error(`Content Pack component kind or lifecycle mismatch: ${component.item_id}`), { statusCode: 409, expose: true })
      }
      selections.push({
        id: component.item_id,
        kind: component.kind,
        ref: {
          pack_id: component.pack_id,
          version: component.version,
          archive_sha256: verified.archiveSha256,
        },
      })
    }

    const formula = selections.find(selection => selection.kind === 'series-formula')!
    const topics = selections.filter(selection => selection.kind === 'topic-pack')
    const recipe = selections.find(selection => selection.kind === 'thumbnail-recipe')!
    const styles = selections.filter(selection => selection.kind === 'visual-style')
    const defaultStyle = styles[0]!
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.updateConfigAndProjectMetaConsistently(slug, {
      active_style_preset_id: defaultStyle.id,
      thumbnail_template_id: recipe.id,
    }, current => {
      applyContentSelections(
        current,
        selections,
        ['series-formula', 'topic-pack', 'visual-style', 'thumbnail-recipe'],
        meta => {
          meta.niche_id = formula.id
          meta.topic_pack_ids = topics.map(topic => topic.id)
          meta.active_style_preset_id = defaultStyle.id
          meta.thumbnail_template_id = recipe.id
        },
      )
    }, options.hooks?.consistentProjectWrite)
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    return {
      project_slug: updated.slug,
      bundle_id: request.bundle_id,
      formula_id: formula.id,
      topic_pack_ids: topics.map(topic => topic.id),
      default_style_id: defaultStyle.id,
      alternative_style_ids: styles.slice(1).map(style => style.id),
      style_refs: styles.map(style => ({ item_id: style.id, ref: { ...style.ref } })),
      thumbnail_recipe_id: recipe.id,
      content_pack_versions: Object.fromEntries(selections.map(selection => [selection.ref.pack_id, selection.ref.version])),
    }
  })
}

/** Create a project and its first exact pins under one coordination barrier. */
export async function createProjectWithContentSelections(
  request: CreateProjectRequest,
  options: ContentPackProjectPinOptions = {},
): Promise<ProjectMeta> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const selections: Array<{ id: string; kind: ContentPackItemKind }> = [
      ...(request.niche_id ? [{ id: request.niche_id, kind: 'series-formula' as const }] : []),
      ...(request.topic_pack_ids ?? []).map(id => ({ id, kind: 'topic-pack' as const })),
    ]
    const signed = await resolveSignedSelections({} as ProjectMeta, selections, options)
    const versions: Record<string, string> = {}
    const items: NonNullable<ProjectMeta['content_pack_items']> = {}
    for (const selection of signed) {
      const existingVersion = versions[selection.ref.pack_id]
      if (existingVersion && existingVersion !== selection.ref.version) {
        throw Object.assign(new Error(`Selected content spans conflicting versions of ${selection.ref.pack_id}.`), {
          statusCode: 409,
          expose: true,
        })
      }
      versions[selection.ref.pack_id] = selection.ref.version
      items[selection.id] = { pack_id: selection.ref.pack_id, kind: selection.kind }
    }
    return projectManager.createProject(request, {
      ...(Object.keys(versions).length ? { content_pack_versions: versions } : {}),
      ...(Object.keys(items).length ? { content_pack_items: items } : {}),
    })
  })
}

async function resolveLegacyMigrationSelection(
  fromId: string,
  target: { to_id: string; pack_id: string; kind: ContentPackItemKind },
  options: ContentPackProjectPinOptions,
): Promise<LegacyContentMigrationSelection> {
  const entry = await resolveCatalogItem(target.to_id, undefined, options)
  if (!entry?.pack || entry.value.kind !== target.kind || entry.pack.pack_id !== target.pack_id) {
    throw Object.assign(new Error(`Exact migration target is unavailable: ${target.to_id}`), { statusCode: 409, expose: true })
  }
  return { kind: target.kind, from_id: fromId, to_id: target.to_id, to: { ...entry.pack } }
}

type LegacyHiddenMechanicsTarget = {
  from_id: string
  to_id: string
  pack_id: string
  kind: ContentPackItemKind
}

function legacyHiddenMechanicsTargetsFor(project: ProjectMeta): LegacyHiddenMechanicsTarget[] {
  if (project.niche_id !== HIDDEN_MECHANICS_MIGRATION_TARGETS.formula.from) {
    throw Object.assign(new Error('Project does not select the legacy Hidden Mechanics Formula.'), { statusCode: 409, expose: true })
  }
  const targets: LegacyHiddenMechanicsTarget[] = [{
    from_id: HIDDEN_MECHANICS_MIGRATION_TARGETS.formula.from,
    to_id: HIDDEN_MECHANICS_MIGRATION_TARGETS.formula.to,
    pack_id: HIDDEN_MECHANICS_MIGRATION_TARGETS.formula.pack_id,
    kind: HIDDEN_MECHANICS_MIGRATION_TARGETS.formula.kind,
  }]
  for (const legacyTopicId of project.topic_pack_ids ?? []) {
    const target = HIDDEN_MECHANICS_MIGRATION_TARGETS.topics[legacyTopicId as keyof typeof HIDDEN_MECHANICS_MIGRATION_TARGETS.topics]
    if (!target) {
      throw Object.assign(new Error(`Project selects a Topic Pack outside the legacy Hidden Mechanics migration: ${legacyTopicId}`), {
        statusCode: 409,
        expose: true,
      })
    }
    targets.push({ from_id: legacyTopicId, to_id: target.to, pack_id: target.pack_id, kind: 'topic-pack' })
  }
  // No style leg: a Formula never applied a style id to a project, so there is
  // no legacy style selection for this migration to carry across.
  if (project.thumbnail_template_id) {
    if (project.thumbnail_template_id !== HIDDEN_MECHANICS_MIGRATION_TARGETS.recipe.from) {
      throw Object.assign(new Error(`Project selects a Recipe outside the legacy Hidden Mechanics migration: ${project.thumbnail_template_id}`), {
        statusCode: 409,
        expose: true,
      })
    }
    targets.push({
      from_id: project.thumbnail_template_id,
      to_id: HIDDEN_MECHANICS_MIGRATION_TARGETS.recipe.to,
      pack_id: HIDDEN_MECHANICS_MIGRATION_TARGETS.recipe.pack_id,
      kind: HIDDEN_MECHANICS_MIGRATION_TARGETS.recipe.kind,
    })
  }
  return targets
}

async function planLegacyHiddenMechanicsMigrationLocked(
  slug: string,
  options: ContentPackProjectPinOptions,
): Promise<LegacyContentMigrationPlan> {
  const project = await projectManager.readProjectMetaConsistently(slug)
  if (!project) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
  const selections = await Promise.all(legacyHiddenMechanicsTargetsFor(project)
    .map(target => resolveLegacyMigrationSelection(target.from_id, target, options)))
  const plan = { project_slug: project.slug, preview_id: randomUUID(), selections }
  legacyMigrationPreviews.set(plan.preview_id, structuredClone(plan))
  return plan
}

function isRecordedLegacyMigrationPlan(
  candidate: LegacyContentMigrationPlan,
  recorded: LegacyContentMigrationPlan | undefined,
): boolean {
  if (!recorded) return false
  return candidate.project_slug === recorded.project_slug
    && candidate.preview_id === recorded.preview_id
    && candidate.selections.length === recorded.selections.length
    && candidate.selections.every((selection, index) => {
      const expected = recorded.selections[index]
      return selection.kind === expected?.kind
        && selection.from_id === expected.from_id
        && selection.to_id === expected.to_id
        && selection.to.pack_id === expected.to.pack_id
        && selection.to.version === expected.to.version
        && selection.to.archive_sha256 === expected.to.archive_sha256
    })
}

/**
 * Read-only HMH migration preview. This is never called by startup or normal
 * catalog discovery: a project changes only when the caller explicitly asks
 * for the companion apply function after reviewing this exact plan.
 */
export async function planLegacyHiddenMechanicsMigration(
  slug: string,
  options: ContentPackProjectPinOptions = {},
): Promise<LegacyContentMigrationPlan> {
  return withContentPackCoordinationLock(pathsFor(options), () => planLegacyHiddenMechanicsMigrationLocked(slug, options))
}

/** Apply the exact targets returned by the explicit HMH migration preview. */
export async function applyLegacyHiddenMechanicsMigration(
  slug: string,
  plan: LegacyContentMigrationPlan,
  options: ContentPackProjectPinOptions = {},
): Promise<LegacyContentMigrationPlan> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const recorded = legacyMigrationPreviews.get(plan.preview_id)
    if (!isRecordedLegacyMigrationPlan(plan, recorded) || plan.project_slug !== slug) {
      throw Object.assign(new Error('Legacy Hidden Mechanics migration preview is not recognized. Review the current project before applying it.'), { statusCode: 409, expose: true })
    }
    for (const selection of plan.selections) {
      const resolved = await resolveCatalogItem(selection.to_id, selection.to, options)
      if (!resolved?.pack || resolved.value.kind !== selection.kind) {
        throw Object.assign(new Error(`Exact migration target is unavailable: ${selection.to_id}`), { statusCode: 409, expose: true })
      }
    }
    const selected = new Map(plan.selections.map(selection => [selection.to_id, selection]))
    const formula = selected.get(HIDDEN_MECHANICS_MIGRATION_TARGETS.formula.to)
    if (!formula) throw new Error('Legacy Hidden Mechanics migration has no Formula target')
    const topicIds = plan.selections
      .filter(selection => selection.kind === 'topic-pack')
      .map(selection => selection.to_id)
    const recipe = plan.selections.find(selection => selection.kind === 'thumbnail-recipe')
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.updateConfigAndProjectMetaConsistently(slug, {
      ...(recipe ? { thumbnail_template_id: recipe.to_id } : {}),
    }, project => {
      // This callback holds the project metadata/config locks. Re-read the
      // selected legacy inputs here, after the test seam and immediately
      // before writes, so a concurrent customer edit can never be overwritten.
      const expected = legacyHiddenMechanicsTargetsFor(project)
      if (plan.selections.length !== expected.length || plan.selections.some((selection, index) => {
        const target = expected[index]
        return !target
          || selection.kind !== target.kind
          || selection.from_id !== target.from_id
          || selection.to_id !== target.to_id
          || selection.to.pack_id !== target.pack_id
      })) {
        throw Object.assign(new Error('Project selections changed since the legacy Hidden Mechanics migration preview.'), { statusCode: 409, expose: true })
      }
      project.niche_id = formula.to_id
      project.topic_pack_ids = topicIds
      if (recipe) project.thumbnail_template_id = recipe.to_id
      const supersededIds = new Set(plan.selections.flatMap(selection => [selection.from_id, selection.to_id]))
      const items = Object.fromEntries(Object.entries(project.content_pack_items ?? {})
        .filter(([id]) => !supersededIds.has(id)))
      Object.assign(items, Object.fromEntries(plan.selections.map(selection => [selection.to_id, {
        pack_id: selection.to.pack_id,
        kind: selection.kind,
      }])))
      const referencedPacks = new Set(Object.values(items).map(item => item.pack_id))
      const versions = Object.fromEntries(Object.entries(project.content_pack_versions ?? {})
        .filter(([packId]) => referencedPacks.has(packId)))
      for (const selection of plan.selections) versions[selection.to.pack_id] = selection.to.version
      project.content_pack_items = items
      project.content_pack_versions = versions
    })
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    legacyMigrationPreviews.delete(plan.preview_id)
    return plan
  })
}

function affectedTypes(items: Array<{ kind: ContentPackItemKind }>): JobType[] {
  const affected = new Set<JobType>()
  for (const item of items) for (const type of CONSUMERS[item.kind]) affected.add(type)
  return [...affected].sort()
}

async function planProjectContentUpgradeLocked(
  slug: string,
  packId: string,
  targetVersion: string,
  options: ContentPackProjectPinOptions,
): Promise<{ plan: ContentPackUpgradePlan; project: ProjectMeta; target: CatalogPackVersion }> {
  const project = await projectManager.readProjectMetaConsistently(slug)
  if (!project) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
  const fromVersion = project.content_pack_versions?.[packId]
  if (!fromVersion) throw Object.assign(new Error(`Project does not pin Content Pack: ${packId}`), { statusCode: 409, expose: true })
  const from = await resolveCatalogPackVersion(packId, fromVersion, options)
  const target = await resolveCatalogPackVersion(packId, targetVersion, options)
  if (!from || !target) throw new ContentPackMissingError([
    ...(!from ? [missingRequirement(project, packId, fromVersion)] : []),
    ...(!target ? [missingRequirement(project, packId, targetVersion)] : []),
  ])
  const selected = itemRefsForPack(project, packId)
  const fromHashes = new Map(from.items.map(item => [item.id, item.content_sha256]))
  const targetHashes = new Map(target.items.map(item => [item.id, item.content_sha256]))
  const missingTarget = selected.filter(item => !targetHashes.has(item.id))
  if (missingTarget.length) {
    throw Object.assign(new Error(`Target Content Pack version removes selected items: ${missingTarget.map(item => item.id).join(', ')}`), {
      statusCode: 409,
      expose: true,
    })
  }
  const changed = selected.filter(item => fromHashes.get(item.id) !== targetHashes.get(item.id))
  return {
    project,
    target,
    plan: {
      pack_id: packId,
      from: { ...from.ref },
      to: { ...target.ref },
      changed_item_ids: changed.map(item => item.id).sort(),
      affected_generation_types: affectedTypes(changed),
    },
  }
}

export async function planProjectContentUpgrade(
  slug: string,
  packId: string,
  targetVersion: string,
  options: ContentPackProjectPinOptions = {},
): Promise<ContentPackUpgradePlan> {
  return withContentPackCoordinationLock(pathsFor(options), async () => (
    (await planProjectContentUpgradeLocked(slug, packId, targetVersion, options)).plan
  ))
}

export async function applyProjectContentUpgrade(
  slug: string,
  packId: string,
  targetVersion: string,
  options: ContentPackProjectPinOptions = {},
): Promise<ContentPackUpgradePlan> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const { plan, target } = await planProjectContentUpgradeLocked(slug, packId, targetVersion, options)
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.mutateProjectMetaConsistently(slug, project => {
      const selectedIds = new Set(itemRefsForPack(project, packId).map(item => item.id))
      project.content_pack_versions = { ...(project.content_pack_versions ?? {}), [packId]: targetVersion }
      const items = { ...(project.content_pack_items ?? {}) }
      for (const item of target.items) {
        if (selectedIds.has(item.id)) items[item.id] = { pack_id: packId, kind: item.kind }
      }
      project.content_pack_items = items
    })
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    return plan
  })
}

export async function snapshotProjectContentPackProvenance(
  slug: string,
  jobType: JobType,
  options: ContentPackProjectPinOptions = {},
): Promise<ContentPackProvenance[]> {
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const project = await projectManager.readProjectMetaConsistently(slug)
    if (!project) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    const provenance: ContentPackProvenance[] = []
    const missing: ContentPackMissingRequirement[] = []
    for (const [packId, version] of Object.entries(project.content_pack_versions ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      let pack: CatalogPackVersion | null
      try {
        pack = await resolveCatalogPackVersion(packId, version, options)
      } catch (error) {
        if (!isContentStoreRevalidationRequired(error)) throw error
        const { revalidateContentStoreTrustForGeneration } = await import('../services/content-store-delivery.js')
        await revalidateContentStoreTrustForGeneration(error.scope)
        // Retry local immutable-pack verification exactly once. The restore
        // above creates no generation, quote, purchase, or download work.
        pack = await resolveCatalogPackVersion(packId, version, options)
      }
      const requirement = missingRequirement(project, packId, version)
      if (!pack) {
        if (requirementAffects(requirement, jobType)) missing.push(requirement)
        continue
      }
      const selectedItems = itemRefsForPack(project, packId)
      const availableIds = new Set(pack.items.map(item => item.id))
      const missingItems = selectedItems.filter(item => !availableIds.has(item.id))
      if (missingItems.length) {
        const itemRequirement: ContentPackMissingRequirement = {
          pack_id: packId,
          version,
          item_ids: missingItems.map(item => item.id).sort(),
          item_kinds: [...new Set(missingItems.map(item => item.kind))].sort(),
        }
        if (requirementAffects(itemRequirement, jobType)) missing.push(itemRequirement)
      }
      const itemIds = selectedItems.map(item => item.id)
      provenance.push({
        ...pack.ref,
        item_ids: (itemIds.length ? itemIds : pack.items.map(item => item.id)).sort(),
      })
    }
    if (missing.length) throw new ContentPackMissingError(missing)
    return provenance
  })
}

/**
 * Every folder that could be a channel here: the project list plus any real
 * directory beside it. A removal check must not miss a channel just because a
 * project index entry is missing, so this stays generous.
 */
export async function candidateProjectSlugs(): Promise<string[]> {
  const slugs = new Set((await projectManager.listProjects()).map(project => project.slug))
  for (const name of await fs.readdir(projectManager.projectsRoot()).catch(() => [] as string[])) {
    if (name.startsWith('.') || name.includes('.bak-')) continue
    slugs.add(name)
  }
  return [...slugs].sort()
}

/**
 * Lifecycle callback: caller already owns coordination → state. This inner
 * reader must never reacquire coordination or the lock order would deadlock.
 */
export async function listProjectSlugsPinningContentPackVersionLocked(
  packId: string,
  version: string,
): Promise<string[]> {
  const pinned: string[] = []
  for (const slug of await candidateProjectSlugs()) {
    try {
      const project = await projectManager.readProjectMetaConsistently(slug)
      if (project?.content_pack_versions?.[packId] === version) pinned.push(project.slug)
    } catch {
      // Unreadable project metadata is not proof that deletion is safe.
      pinned.push(slug)
    }
  }
  return [...new Set(pinned)].sort()
}

/** Lifecycle prune callback; caller already owns coordination → state. */
export async function isProjectContentPackVersionPinnedLocked(packId: string, version: string): Promise<boolean> {
  return (await listProjectSlugsPinningContentPackVersionLocked(packId, version)).length > 0
}
