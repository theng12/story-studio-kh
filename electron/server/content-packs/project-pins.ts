import fs from 'node:fs/promises'

import type { CreateProjectRequest, JobType, ProjectMeta, UpdateConfigRequest } from '../models/types.js'
import * as projectManager from '../services/project-manager.js'
import {
  resolveCatalogItem,
  resolveCatalogPackVersion,
  type CatalogPackVersion,
  type ContentPackRegistryOptions,
} from './registry.js'
import { getContentPackRuntimePaths, type ContentPackRuntimePaths } from './runtime-paths.js'
import type { ContentPackProvenance, ContentPackVersionRef } from './runtime-types.js'
import { withContentPackCoordinationLock } from './state.js'
import type { ContentPackItemKind } from './types.js'
import { currentJobContentPackProvenance } from './job-provenance-context.js'

export interface ContentPackMissingRequirement {
  pack_id: string
  version: string
  item_ids: string[]
  item_kinds: ContentPackItemKind[]
}

export class ContentPackMissingError extends Error {
  readonly code = 'content-pack-missing' as const
  readonly statusCode = 409
  readonly expose = true
  constructor(readonly requirements: ContentPackMissingRequirement[]) {
    super(`Required Content Pack version is unavailable: ${requirements
      .map(requirement => `${requirement.pack_id}@${requirement.version}`)
      .join(', ')}`)
    this.name = 'ContentPackMissingError'
  }
}

export interface ContentPackUpgradePlan {
  pack_id: string
  from: ContentPackVersionRef
  to: ContentPackVersionRef
  changed_item_ids: string[]
  affected_generation_types: JobType[]
}

export interface ContentPackProjectPinOptions extends ContentPackRegistryOptions {
  paths?: ContentPackRuntimePaths
  hooks?: {
    /** Test seam reached under coordination after exact verification. */
    beforeProjectWrite?: () => Promise<void>
  }
}

export interface ProjectContentSelectionUpdate {
  replace_kinds: ContentPackItemKind[]
  selections: Array<{ id: string; kind: ContentPackItemKind }>
  update: (project: ProjectMeta) => void
}

type SignedSelection = Awaited<ReturnType<typeof resolveSignedSelections>>[number]

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

async function resolveSignedSelections(
  selections: Array<{ id: string; kind: ContentPackItemKind }>,
  options: ContentPackProjectPinOptions,
): Promise<Array<{ id: string; kind: ContentPackItemKind; ref: ContentPackVersionRef }>> {
  const signed: Array<{ id: string; kind: ContentPackItemKind; ref: ContentPackVersionRef }> = []
  for (const selection of selections) {
    const entry = await resolveCatalogItem(selection.id, undefined, options)
    if (!entry?.pack) continue
    if (entry.value.kind !== selection.kind) {
      throw Object.assign(new Error(`Content Pack item kind mismatch: ${selection.id}`), { statusCode: 409, expose: true })
    }
    signed.push({ id: selection.id, kind: selection.kind, ref: entry.pack })
  }
  return signed
}

const CONSUMERS: Record<ContentPackItemKind, readonly JobType[]> = {
  'series-formula': [
    'idea_campaign', 'script-only', 'introduction-only', 'chapter-only', 'outline_only',
    'expand_chapters', 'image_prompts', 'metadata', 'scene_plan_run',
  ],
  'topic-pack': [
    'idea_campaign', 'script-only', 'introduction-only', 'chapter-only', 'outline_only',
    'expand_chapters', 'image_prompts', 'metadata', 'scene_plan_run',
  ],
  // Render jobs consume already-materialised prompts/reference paths, not the
  // style/recipe documents that produced them. Missing catalog bytes must not
  // strand usable downstream work.
  'visual-style': ['image_prompts'],
  'thumbnail-recipe': ['image_prompts'],
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
    const signed = await resolveSignedSelections(input.selections, options)
    await options.hooks?.beforeProjectWrite?.()
    const updated = await projectManager.mutateProjectMetaConsistently(slug, project => {
      applyContentSelections(project, signed, input.replace_kinds, input.update)
    })
    if (!updated) throw Object.assign(new Error(`Project not found: ${slug}`), { statusCode: 404, expose: true })
    return updated
  })
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
  return withContentPackCoordinationLock(pathsFor(options), async () => {
    const selections = [
      ...(hasStyle && typeof request.active_style_preset_id === 'string' && request.active_style_preset_id
        ? [{ id: request.active_style_preset_id, kind: 'visual-style' as const }]
        : []),
      ...(hasRecipe && typeof request.thumbnail_template_id === 'string' && request.thumbnail_template_id
        ? [{ id: request.thumbnail_template_id, kind: 'thumbnail-recipe' as const }]
        : []),
    ]
    const signed = await resolveSignedSelections(selections, options)
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
    const signed = await resolveSignedSelections(selections, options)
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
      const pack = await resolveCatalogPackVersion(packId, version, options)
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

async function candidateProjectSlugs(): Promise<string[]> {
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
