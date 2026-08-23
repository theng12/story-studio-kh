import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { assertContentPackAppCompatible, installContentPack } from '../content-packs/installer.js'
import {
  rollbackContentPack,
  setContentPackDiscoveryDisabled,
  uninstallContentPackVersion,
} from '../content-packs/lifecycle.js'
import {
  applyProjectContentBundle,
  listProjectSlugsPinningContentPackVersionLocked,
} from '../content-packs/project-pins.js'
import { listVerifiedRecoveryPacks } from '../content-packs/recovery.js'
import { resolveCatalogPackVersion, type ContentPackRegistryOptions } from '../content-packs/registry.js'
import {
  getContentPackRuntimePaths,
  resolveVerifiedPackFile,
  type ContentPackRuntimePaths,
} from '../content-packs/runtime-paths.js'
import { ContentPackVersionRefSchema } from '../content-packs/runtime-types.js'
import { readContentPackState } from '../content-packs/state.js'
import { verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import type { VerifiedContentPack } from '../content-packs/archive.js'
import * as projectManager from '../services/project-manager.js'
import { compareVersionStrings } from '../content-packs/version-order.js'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const PackIdSchema = ContentPackVersionRefSchema.shape.pack_id
const VersionSchema = ContentPackVersionRefSchema.shape.version
const AssetIdSchema = ContentPackVersionRefSchema.shape.archive_sha256
const ProjectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/)
const ProjectBundleApplicationSchema = z.object({
  root: ContentPackVersionRefSchema,
  bundle_id: PackIdSchema,
}).strict()

type LocalContentPackOptions = ContentPackRegistryOptions

interface DirectoryIdentity {
  path: string
  dev: bigint
  ino: bigint
}

export const router = Router()

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function routeOptions(req: Request): LocalContentPackOptions {
  return req.app.locals.contentPackOptions ?? {}
}

function runtimePaths(options: LocalContentPackOptions): ContentPackRuntimePaths {
  return options.paths ?? getContentPackRuntimePaths()
}

function parseParam(schema: typeof PackIdSchema, value: string, label: string): string {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400, expose: true })
  return parsed.data
}

function lifecycleFailure(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : ''
  const status = Number((error as { statusCode?: unknown })?.statusCode)
    || (/not installed|not found/i.test(message) ? 404 : 409)
  res.status(status).json({ detail: fallback })
}

function verifiedItems(pack: VerifiedContentPack): Array<{ id: string; kind: string }> {
  return pack.manifest.items
    .map(item => ({ id: item.id, kind: item.kind }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function compatibleRecoveryPacks(options: LocalContentPackOptions): Promise<VerifiedContentPack[]> {
  const packs = await listVerifiedRecoveryPacks({
    paths: runtimePaths(options),
    policy: options.policy,
    recoveryRoot: options.recoveryRoot,
    appVersion: options.appVersion,
  })
  const compatible: VerifiedContentPack[] = []
  for (const pack of packs) {
    try {
      await assertContentPackAppCompatible(pack.manifest.min_app_version, options.appVersion)
      compatible.push(pack)
    } catch { /* a future recovery resource stays unavailable to this app */ }
  }
  return compatible
}

async function projectPins(): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  for (const summary of await projectManager.listProjects()) {
    let project
    try { project = await projectManager.readProjectMetaConsistently(summary.slug) } catch { continue }
    if (!project) continue
    for (const [packId, version] of Object.entries(project.content_pack_versions ?? {})) {
      const key = `${packId}@${version}`
      const slugs = result.get(key) ?? []
      slugs.push(project.slug)
      result.set(key, slugs)
    }
  }
  for (const slugs of result.values()) slugs.sort()
  return result
}

async function managementCatalog(options: LocalContentPackOptions) {
  const paths = runtimePaths(options)
  const state = await readContentPackState(paths)
  const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
  const pins = await projectPins()
  const byPack = new Map<string, {
    pack_id: string
    publisher_id: string | null
    discovery_disabled: boolean
    active_version: string | null
    versions: Array<Record<string, unknown>>
  }>()

  for (const [packId, packState] of Object.entries(state.packs).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = {
      pack_id: packId,
      publisher_id: null as string | null,
      discovery_disabled: packState.discovery_disabled,
      active_version: packState.active_version ?? null,
      versions: [] as Array<Record<string, unknown>>,
    }
    // v1.4.1 — numeric, not `localeCompare`: '1.0.10' sorts before '1.0.2' as a
    // string, so a pack's version history was misordered the moment it reached a
    // double-digit patch release.
    for (const [version, installed] of Object.entries(packState.versions).sort(([left], [right]) => compareVersionStrings(left, right))) {
      let verified: VerifiedContentPack | null = null
      try {
        verified = await verifyInstalledContentPackClosure(state, packId, version, policy, options.appVersion)
      } catch { /* retained damaged versions remain manageable but undiscoverable */ }
      if (verified) entry.publisher_id = verified.manifest.publisher_id
      entry.versions.push({
        version,
        archive_sha256: installed.archive_sha256,
        source: 'signed-installed',
        active: packState.active_version === version,
        verified: Boolean(verified),
        pending_removal: Boolean(installed.pending_removal),
        lifecycle: verified?.manifest.lifecycle ?? null,
        items: verified ? verifiedItems(verified) : [],
        affected_projects: pins.get(`${packId}@${version}`) ?? [],
      })
    }
    byPack.set(packId, entry)
  }

  for (const verified of await compatibleRecoveryPacks({ ...options, paths, policy })) {
    const packId = verified.manifest.pack_id
    const statePack = state.packs[packId]
    const entry = byPack.get(packId) ?? {
      pack_id: packId,
      publisher_id: verified.manifest.publisher_id,
      discovery_disabled: statePack?.discovery_disabled ?? false,
      active_version: statePack?.active_version ?? null,
      versions: [],
    }
    if (!entry.versions.some(version => version.version === verified.manifest.version)) {
      entry.versions.push({
        version: verified.manifest.version,
        archive_sha256: verified.archiveSha256,
        source: 'signed-recovery',
        active: false,
        verified: true,
        pending_removal: false,
        lifecycle: verified.manifest.lifecycle,
        items: verifiedItems(verified),
        affected_projects: pins.get(`${packId}@${verified.manifest.version}`) ?? [],
      })
    }
    // v1.4.1 — numeric; see the note above on double-digit patch releases.
      entry.versions.sort((left, right) => compareVersionStrings(left.version, right.version))
    byPack.set(packId, entry)
  }

  return { packs: [...byPack.values()].sort((left, right) => left.pack_id.localeCompare(right.pack_id)) }
}

function requireBinary(req: Request, res: Response, next: () => void): void {
  if (!req.is('application/octet-stream')) {
    res.status(415).json({ detail: 'Content Pack import requires application/octet-stream.' })
    return
  }
  next()
}

router.get('/content-packs', async (req, res) => {
  try {
    res.json(await managementCatalog(routeOptions(req)))
  } catch {
    res.status(500).json({ detail: 'Failed to read the local Content Pack catalog.' })
  }
})

router.post(
  '/content-packs/import',
  requireBinary,
  express.raw({ type: 'application/octet-stream', limit: MAX_IMPORT_BYTES }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      res.status(400).json({ detail: 'Content Pack archive bytes are required.' })
      return
    }
    try {
      const options = routeOptions(req)
      const result = await installContentPack(
        { archiveBytes: req.body, source: 'local-import' },
        { paths: options.paths, policy: options.policy, appVersion: options.appVersion },
      )
      res.status(201).json(result)
    } catch {
      res.status(400).json({ detail: 'Content Pack import failed verification.' })
    }
  },
)

for (const [action, disabled] of [['disable', true], ['enable', false]] as const) {
  router.post(`/content-packs/:packId/${action}`, async (req, res) => {
    let packId: string
    try { packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID') } catch (error) {
      lifecycleFailure(res, error, 'Invalid Content Pack ID.')
      return
    }
    try {
      const options = routeOptions(req)
      await setContentPackDiscoveryDisabled(packId, disabled, {
        paths: options.paths, policy: options.policy, appVersion: options.appVersion,
      })
      res.json({ ok: true, pack_id: packId, discovery_disabled: disabled })
    } catch (error) {
      lifecycleFailure(res, error, 'The Content Pack discovery state could not be changed.')
    }
  })
}

router.post(
  '/content-packs/:packId/rollback',
  express.json({ limit: '16kb' }),
  async (req, res) => {
    let packId: string
    let version: string
    try {
      packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID')
      version = parseParam(VersionSchema, req.body?.version, 'version')
    } catch (error) {
      lifecycleFailure(res, error, 'A valid exact Content Pack version is required.')
      return
    }
    try {
      const options = routeOptions(req)
      await rollbackContentPack(packId, version, {
        paths: options.paths, policy: options.policy, appVersion: options.appVersion,
      })
      res.json({ ok: true, pack_id: packId, active_version: version })
    } catch (error) {
      lifecycleFailure(res, error, 'The selected Content Pack version cannot be activated.')
    }
  },
)

router.delete('/content-packs/:packId/versions/:version', async (req, res) => {
  let packId: string
  let version: string
  try {
    packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID')
    version = parseParam(VersionSchema, firstParam(req.params.version), 'version')
  } catch (error) {
    lifecycleFailure(res, error, 'Invalid Content Pack identity.')
    return
  }
  try {
    const options = routeOptions(req)
    await uninstallContentPackVersion(packId, version, listProjectSlugsPinningContentPackVersionLocked, {
      paths: options.paths, policy: options.policy, appVersion: options.appVersion,
    })
    res.json({ ok: true, pack_id: packId, removed_version: version })
  } catch (error) {
    lifecycleFailure(res, error, 'The Content Pack version cannot be removed while it is active, pinned, or required.')
  }
})

router.post(
  '/content-packs/projects/:slug/bundles/apply',
  async (req, res, next) => {
    const slug = ProjectSlugSchema.safeParse(firstParam(req.params.slug))
    const body = ProjectBundleApplicationSchema.safeParse(req.body)
    if (!slug.success || !body.success) {
      res.status(400).json({ detail: 'A valid project slug, exact bundle root, and bundle ID are required.' })
      return
    }
    try {
      res.json(await applyProjectContentBundle(slug.data, body.data, routeOptions(req)))
    } catch (error) {
      const status = Number((error as { statusCode?: unknown })?.statusCode)
      const exposed = (error as { expose?: unknown })?.expose === true && error instanceof Error
      if (exposed && [400, 404, 409].includes(status)) {
        res.status(status).json({ detail: error.message })
        return
      }
      next(error)
    }
  },
)

router.get('/content-packs/projects/:slug/requirements', async (req, res) => {
  const rawSlug = firstParam(req.params.slug)
  const parsedSlug = ProjectSlugSchema.safeParse(rawSlug)
  if (!parsedSlug.success) {
    res.status(400).json({ detail: 'Invalid project slug.' })
    return
  }
  const project = await projectManager.readProjectMetaConsistently(rawSlug)
  if (!project) {
    res.status(404).json({ detail: 'Project not found' })
    return
  }
  try {
    const options = routeOptions(req)
    const requirements = []
    for (const [packId, version] of Object.entries(project.content_pack_versions ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const pack = await resolveCatalogPackVersion(packId, version, options)
      const selected = Object.entries(project.content_pack_items ?? {})
        .filter(([, owner]) => owner.pack_id === packId)
        .map(([id, owner]) => ({ id, kind: owner.kind }))
        .sort((left, right) => left.id.localeCompare(right.id))
      requirements.push({
        pack_id: packId,
        version,
        available: Boolean(pack),
        archive_sha256: pack?.ref.archive_sha256 ?? null,
        item_ids: selected.map(item => item.id),
        item_kinds: [...new Set(selected.map(item => item.kind))].sort(),
      })
    }
    res.json({ project_slug: project.slug, requirements })
  } catch {
    res.status(500).json({ detail: 'Failed to resolve project Content Pack requirements.' })
  }
})

async function snapshotDirectoryChain(root: string, target: string): Promise<DirectoryIdentity[]> {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Content Pack asset root is invalid')
  }
  const identities: DirectoryIdentity[] = []
  let cursor = resolvedRoot
  for (const segment of ['.', ...relative.split(path.sep)]) {
    if (segment !== '.') cursor = path.join(cursor, segment)
    const stat = await fs.lstat(cursor, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Content Pack asset directory is unsafe')
    identities.push({ path: cursor, dev: stat.dev, ino: stat.ino })
  }
  return identities
}

function sameDirectoryChain(left: readonly DirectoryIdentity[], right: readonly DirectoryIdentity[]): boolean {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index]?.path && entry.dev === right[index]?.dev && entry.ino === right[index]?.ino
  ))
}

function configureAssetResponse(res: Response, mime: string, length: number): void {
  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Length', String(length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
}

async function streamInstalledAsset(
  res: Response,
  paths: ContentPackRuntimePaths,
  installPath: string,
  relativePath: string,
  assetId: string,
  mime: string,
): Promise<void> {
  const beforeDirectories = await snapshotDirectoryChain(paths.installedRoot, installPath)
  const assetPath = resolveVerifiedPackFile(installPath, relativePath)
  const before = await fs.lstat(assetPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('Content Pack asset is unsafe')
  const handle = await fs.open(assetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    const after = await fs.lstat(assetPath, { bigint: true })
    const afterDirectories = await snapshotDirectoryChain(paths.installedRoot, installPath)
    if (!opened.isFile() || opened.nlink !== 1n
      || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.dev !== after.dev || opened.ino !== after.ino
      || !sameDirectoryChain(beforeDirectories, afterDirectories)) {
      throw new Error('Content Pack asset changed during verification')
    }
    const bytes = await handle.readFile()
    if (createHash('sha256').update(bytes).digest('hex') !== assetId) throw new Error('Content Pack asset hash is invalid')
    configureAssetResponse(res, mime, bytes.byteLength)
    await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), res)
  } finally {
    await handle.close().catch(() => {})
  }
}

router.get('/content-packs/:packId/:version/assets/:assetId', async (req, res) => {
  let packId: string
  let version: string
  let assetId: string
  try {
    packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID')
    version = parseParam(VersionSchema, firstParam(req.params.version), 'version')
    assetId = parseParam(AssetIdSchema, firstParam(req.params.assetId), 'asset ID')
  } catch {
    res.status(400).json({ detail: 'Invalid Content Pack asset identity.' })
    return
  }

  try {
    const options = routeOptions(req)
    const paths = runtimePaths(options)
    const state = await readContentPackState(paths)
    const policy = options.policy ?? await getFirstPartyContentPackVerificationPolicy()
    const installed = state.packs[packId]?.versions[version]
    let verified: VerifiedContentPack | undefined
    if (installed?.pending_removal) {
      res.status(404).json({ detail: 'Verified Content Pack asset not found.' })
      return
    }
    if (installed) {
      verified = await verifyInstalledContentPackClosure(state, packId, version, policy, options.appVersion)
    } else {
      verified = (await compatibleRecoveryPacks({ ...options, paths, policy }))
        .find(pack => pack.manifest.pack_id === packId && pack.manifest.version === version)
    }
    if (!verified) {
      res.status(404).json({ detail: 'Verified Content Pack asset not found.' })
      return
    }
    const declared = verified.manifest.files
      .filter(file => file.sha256 === assetId && RASTER_MIMES.has(file.mime))
      .sort((left, right) => left.path.localeCompare(right.path))[0]
    if (!declared) {
      res.status(404).json({ detail: 'Verified Content Pack asset not found.' })
      return
    }
    if (installed) {
      await streamInstalledAsset(res, paths, installed.install_path, declared.path, assetId, declared.mime)
      return
    }
    const bytes = verified.files.get(declared.path)
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== assetId) throw new Error('Content Pack recovery asset is invalid')
    configureAssetResponse(res, declared.mime, bytes.byteLength)
    res.end(Buffer.from(bytes))
  } catch {
    if (!res.headersSent) res.status(404).json({ detail: 'Verified Content Pack asset not found.' })
    else res.destroy()
  }
})

// Keep raw-parser failures bounded and JSON-shaped when this router is mounted
// on its own as well as behind the application's terminal error boundary.
router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if ((error as { type?: unknown })?.type === 'entity.too.large') {
    res.status(413).json({ detail: `Content Pack archive exceeds the ${MAX_IMPORT_BYTES} byte limit.` })
    return
  }
  next(error)
})
