import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ThumbnailTemplate } from '../models/types.js'
import * as pm from './project-manager.js'
import { getEffectiveNicheFor } from './niche-loader.js'
import { getEffectiveTemplateFor, loadTemplate, resolveTemplateShellImage } from './thumbnail-template-loader.js'
import { formatPoolFromConfig, resolveEpisodeFormatAssignment } from './format-pool.js'

export interface ThumbnailShellSelection {
  thumbnail_shell_id?: string
  thumbnail_template_id?: string
  thumbnail_reference_asset?: unknown
  /** The episode this shell is for — the format pool's key when the channel's switch is on. */
  episode_id?: string
}

export interface ResolvedThumbnailShell {
  id: string
  name: string
  template: ThumbnailTemplate | null
  imagePath: string | null
  guidanceAsset: unknown
  layoutNote: string
  sourceProjectSlug?: string
}

export function channelReferenceShellId(slug: string): string {
  return `channel-reference:${slug}`
}

/** A deliberate Shell selection supersedes legacy references without rewriting them. */
export async function resolveThumbnailShell(
  slug: string,
  request: ThumbnailShellSelection,
  config: ThumbnailShellSelection,
): Promise<ResolvedThumbnailShell> {
  // The format pool (owner 2026-11-15) sits IN FRONT of this single-format
  // choice: while the channel's switch is on and the request names its
  // episode, the assigned member's shell/template replace the page's picker
  // and the channel default — the same member the episode's title style came
  // from, so picture and title cannot disagree. Off (absent config) leaves
  // every line below byte-identical to today.
  const pool = formatPoolFromConfig(config)
  const member = pool && typeof request.episode_id === 'string' && request.episode_id
    ? (await resolveEpisodeFormatAssignment(slug, request.episode_id, pool, { persist: true }))?.member ?? null
    : null
  const memberDefinesShell = member?.thumbnail_shell_id !== undefined
  const memberDefinesTemplate = member?.thumbnail_template_id !== undefined
  const selected = memberDefinesShell
    ? member!.thumbnail_shell_id!
    : memberDefinesTemplate
      // The member picked a template with no Shell: no Shell selection at all,
      // so the template path below runs instead of the channel's Shell.
      ? undefined
      : typeof request.thumbnail_shell_id === 'string'
        ? request.thumbnail_shell_id
        : config.thumbnail_shell_id
  const explicit = typeof selected === 'string'
  if (explicit && !selected.trim()) {
    return { id: '', name: 'No Shell', template: null, imagePath: null, guidanceAsset: null, layoutNote: '' }
  }
  const channelShell = selected?.startsWith('channel-reference:') === true
  const sourceSlug = channelShell ? selected!.slice('channel-reference:'.length) : slug
  if (!/^[a-zA-Z0-9_-]+$/.test(sourceSlug)) throw new Error('The selected Shell channel is invalid.')
  const foreign = sourceSlug !== slug
  const sourceProject = foreign ? await pm.getProject(sourceSlug) : null
  if (foreign && !sourceProject) throw new Error('The selected Shell’s source channel was not found. Choose another Shell.')
  const legacy = foreign
    ? (await pm.getConfig(sourceSlug) as ThumbnailShellSelection | null)?.thumbnail_reference_asset
    : request.thumbnail_reference_asset || config.thumbnail_reference_asset
  // A member that names a template wants THAT template, not a legacy layout image.
  if (channelShell || (!explicit && legacy && !memberDefinesTemplate)) {
    const record = legacy as { id?: unknown; filename?: unknown; reframing_prompt?: unknown } | null
    if (!record?.id || typeof record.filename !== 'string' || !record.filename
      || path.basename(record.filename) !== record.filename || record.filename.includes('\\')) {
      throw new Error('The channel’s saved Shell is unavailable. Upload its layout image again.')
    }
    const projectDir = pm.getProjectDir(sourceSlug)
    if (!projectDir) throw new Error('Project not found')
    const directory = path.join(projectDir, 'thumbnail-reference-assets')
    const imagePath = path.join(directory, record.filename)
    try {
      const [projectRoot, root, file, stat] = await Promise.all([
        fs.realpath(projectDir), fs.realpath(directory), fs.realpath(imagePath), fs.stat(imagePath),
      ])
      const managedRelative = path.relative(projectRoot, root)
      const relative = path.relative(root, file)
      if (!managedRelative || managedRelative === '..' || managedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(managedRelative)
        || !relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !stat.isFile()) {
        throw new Error('The channel Shell image is outside its managed folder.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      // Keep the saved selection visible; render reports the missing image before submission.
    }
    const layoutNote = typeof record.reframing_prompt === 'string' ? record.reframing_prompt.trim() : ''
    return {
      id: channelReferenceShellId(sourceSlug), name: foreign ? `${sourceProject!.name} — channel Shell` : 'Channel Shell', template: null,
      imagePath, guidanceAsset: layoutNote ? { layoutNote } : legacy, layoutNote, sourceProjectSlug: sourceSlug,
    }
  }
  const templateId = explicit
    ? selected!.trim()
    : memberDefinesTemplate
      ? member!.thumbnail_template_id!.trim()
      : request.thumbnail_template_id?.trim()
  let template: ThumbnailTemplate | null
  if (templateId) {
    template = await loadTemplate(templateId)
    if (!template) throw new Error(`Thumbnail Shell '${templateId}' is unavailable. Choose an installed Shell.`)
  } else {
    const project = await pm.getProject(slug)
    if (!project) throw new Error('Project not found')
    template = await getEffectiveTemplateFor(project, await getEffectiveNicheFor(project), config as any)
  }
  const layoutNote = template?.layoutNote?.trim() || ''
  return {
    id: template?.id || '', name: template?.name || 'No Shell', template,
    imagePath: template ? await resolveTemplateShellImage(template) : null,
    guidanceAsset: layoutNote ? { layoutNote } : null, layoutNote,
  }
}

/** Paid retry records require references inside their owning project, including library Shells. */
export async function stageThumbnailShellImage(projectDir: string, source: string): Promise<string> {
  const bytes = await fs.readFile(source)
  if (!bytes.length) throw new Error('The selected Shell image is empty. Replace it before generating.')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = path.join(projectDir, 'thumbnail-reference-assets')
  await fs.mkdir(directory, { recursive: true })
  const [root, managed] = await Promise.all([fs.realpath(projectDir), fs.realpath(directory)])
  const relative = path.relative(root, managed)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The Shell reference folder is outside this project.')
  }
  const target = path.join(managed, `shell-${digest}${path.extname(source).toLowerCase()}`)
  try {
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    const stat = await fs.lstat(target)
    if (!stat.isFile() || createHash('sha256').update(await fs.readFile(target)).digest('hex') !== digest) {
      throw new Error('The saved Shell reference failed its integrity check. Replace the Shell image.')
    }
  }
  return target
}
