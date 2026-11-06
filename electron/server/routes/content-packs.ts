import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { assertContentPackAppCompatible, installContentPack, verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import { setContentPackDiscoveryDisabled, uninstallContentPackVersion } from '../content-packs/lifecycle.js'
import {
  ContentPackRemovalError,
  readContentPackRemovalStatus,
  removeContentPack,
  restoreContentPack,
} from '../content-packs/removal.js'
import {
  applyProjectContentUpgradeToActive,
  listProjectSlugsPinningContentPackVersionLocked,
  planProjectContentUpgradeToActive,
} from '../content-packs/project-pins.js'
import { listVerifiedRecoveryPacks } from '../content-packs/recovery.js'
import type { ContentPackRegistryOptions } from '../content-packs/registry.js'
import {
  getContentPackRuntimePaths,
  resolveVerifiedPackFile,
  type ContentPackRuntimePaths,
} from '../content-packs/runtime-paths.js'
import { ContentPackVersionRefSchema } from '../content-packs/runtime-types.js'
import {
  acknowledgeContentPackRecoveryIncident,
  readContentPackRecoveryIncident,
  readContentPackState,
} from '../content-packs/state.js'
import type { VerifiedContentPack } from '../content-packs/archive.js'
import {
  MAX_IMPORT_BYTES,
  firstParam,
  importFailure,
  routeOptions,
} from './content-pack-route-support.js'

const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const PackIdSchema = ContentPackVersionRefSchema.shape.pack_id
const VersionSchema = ContentPackVersionRefSchema.shape.version
const AssetIdSchema = ContentPackVersionRefSchema.shape.archive_sha256
const RecoveryIncidentIdSchema = z.string().uuid()
const ProjectPinMoveSchema = z.object({ project_slug: z.string().trim().min(1).max(200) }).strict()

type LocalContentPackOptions = ContentPackRegistryOptions

interface DirectoryIdentity {
  path: string
  dev: bigint
  ino: bigint
}

export const router = Router()

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

function requireBinary(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/octet-stream')) {
    res.status(415).json({ detail: 'Content Pack import requires application/octet-stream.' })
    return
  }
  next()
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
    } catch (error) {
      importFailure(res, error)
    }
  },
)

router.get('/content-packs/recovery', async (req, res) => {
  try {
    res.json({ recovery: await readContentPackRecoveryIncident(runtimePaths(routeOptions(req))) })
  } catch {
    res.status(500).json({
      code: 'CONTENT_PACK_RECOVERY_STATE_INVALID',
      detail: 'Your Content Pack recovery notice could not be read.',
    })
  }
})

router.delete('/content-packs/recovery/:incidentId', async (req, res) => {
  const parsed = RecoveryIncidentIdSchema.safeParse(firstParam(req.params.incidentId))
  if (!parsed.success) {
    res.status(400).json({
      code: 'CONTENT_PACK_RECOVERY_REQUEST_INVALID',
      detail: 'Invalid Content Pack recovery incident.',
    })
    return
  }
  try {
    const acknowledged = await acknowledgeContentPackRecoveryIncident(
      parsed.data,
      runtimePaths(routeOptions(req)),
    )
    if (!acknowledged) {
      res.status(409).json({
        code: 'CONTENT_PACK_RECOVERY_INCIDENT_CHANGED',
        detail: 'The Content Pack recovery notice changed. Refresh and try again.',
      })
      return
    }
    res.json({ ok: true })
  } catch {
    res.status(500).json({
      code: 'CONTENT_PACK_RECOVERY_STATE_INVALID',
      detail: 'Your Content Pack recovery notice could not be updated.',
    })
  }
})

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

const REMOVAL_FAILURE_STATUS: Record<string, number> = {
  CONTENT_PACK_NOT_INSTALLED: 404,
  CONTENT_PACK_NOT_REMOVED: 404,
  CONTENT_PACK_REMOVAL_STATE_UNREADABLE: 500,
}

function removalFailure(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ContentPackRemovalError) {
    res.status(REMOVAL_FAILURE_STATUS[error.code] ?? 409).json({
      code: error.code,
      detail: error.message,
      ...(error.channels.length ? { channels: error.channels } : {}),
    })
    return
  }
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && code.startsWith('CONTENT_PACK_')) {
    res.status(409).json({ code, detail: (error as Error).message })
    return
  }
  lifecycleFailure(res, error, fallback)
}

/**
 * The renderer needs where a version came from and where it went, not the
 * signed manifest and install record it was verified against.
 */
function publicRemovalStatus(status: Awaited<ReturnType<typeof readContentPackRemovalStatus>>) {
  return {
    unreadable: status.unreadable,
    channels: status.channels,
    packs: Object.fromEntries(Object.entries(status.packs).map(([packId, entry]) => [packId, {
      ...entry,
      versions: entry.versions.map(({ version, install_path, trash_path, active }) => ({
        version, install_path, trash_path, active,
      })),
    }])),
  }
}

/** What Story Studio knows locally about removing and restoring its Content Packs. */
router.get('/content-packs/removals', async (req, res) => {
  try {
    // `channels` is what the Installed view shows beside each pack and what the
    // removal itself refuses on: one reader, so the two cannot disagree.
    res.json(publicRemovalStatus(await readContentPackRemovalStatus(runtimePaths(routeOptions(req)))))
  } catch {
    res.status(500).json({
      code: 'CONTENT_PACK_REMOVAL_STATE_UNREADABLE',
      detail: 'This Mac could not read its Content Pack removal records.',
    })
  }
})

router.post('/content-packs/:packId/remove', async (req, res) => {
  let packId: string
  try { packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID') } catch (error) {
    lifecycleFailure(res, error, 'Invalid Content Pack ID.')
    return
  }
  try {
    res.json(await removeContentPack(packId, routeOptions(req)))
  } catch (error) {
    removalFailure(res, error, 'This Content Pack could not be removed from this Mac.')
  }
})

router.post('/content-packs/:packId/restore', async (req, res) => {
  let packId: string
  try { packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID') } catch (error) {
    lifecycleFailure(res, error, 'Invalid Content Pack ID.')
    return
  }
  try {
    res.json(await restoreContentPack(packId, routeOptions(req)))
  } catch (error) {
    removalFailure(res, error, 'This Content Pack could not be restored from Story Studio Trash.')
  }
})

/**
 * Move one channel's pin to this Mac's active installed version of the same
 * pack. Plan writes nothing; apply is the explicit second request.
 */
for (const [action, apply] of [['plan', false], ['apply', true]] as const) {
  router.post(`/content-packs/:packId/pin-move/${action}`, async (req, res) => {
    let packId: string
    try { packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID') } catch (error) {
      lifecycleFailure(res, error, 'Invalid Content Pack ID.')
      return
    }
    const body = ProjectPinMoveSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ code: 'CONTENT_PACK_PIN_MOVE_REQUEST_INVALID', detail: 'A channel is required.' })
      return
    }
    try {
      const options = routeOptions(req)
      const plan = apply
        ? await applyProjectContentUpgradeToActive(body.data.project_slug, packId, options)
        : await planProjectContentUpgradeToActive(body.data.project_slug, packId, options)
      res.json({ ok: true, ...plan })
    } catch (error) {
      pinMoveFailure(res, error)
    }
  })
}

/** Uninstall one non-active, unpinned installed version. Bytes move to Trash. */
router.post('/content-packs/:packId/versions/:version/uninstall', async (req, res) => {
  let packId: string
  let version: string
  try {
    packId = parseParam(PackIdSchema, firstParam(req.params.packId), 'pack ID')
    version = parseParam(VersionSchema, firstParam(req.params.version), 'version')
  } catch (error) {
    lifecycleFailure(res, error, 'Invalid Content Pack version.')
    return
  }
  try {
    await uninstallContentPackVersion(packId, version, listProjectSlugsPinningContentPackVersionLocked, routeOptions(req))
    res.json({ ok: true, pack_id: packId, version })
  } catch (error) {
    versionUninstallFailure(res, error)
  }
})

function pinnedChannelSlugs(message: string): string[] {
  const match = /pinned by projects:\s*(.*)$/i.exec(message)
  return match ? match[1].split(',').map(slug => slug.trim()).filter(Boolean) : []
}

function pinMoveFailure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  if (/Project not found/i.test(message)) {
    res.status(404).json({ code: 'PROJECT_NOT_FOUND', detail: 'This channel no longer exists.' })
    return
  }
  const status = Number((error as { statusCode?: unknown })?.statusCode) || 409
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : 'CONTENT_PACK_PIN_MOVE_REFUSED'
  res.status(status).json({ code, detail: message || 'This channel pin could not be moved.' })
}

function versionUninstallFailure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  if (/Content Pack is not installed/i.test(message)) {
    res.status(404).json({ code: 'CONTENT_PACK_VERSION_NOT_INSTALLED', detail: 'This Content Pack version is not installed on this Mac.' })
    return
  }
  if (/active version cannot be uninstalled/i.test(message)) {
    res.status(409).json({ code: 'CONTENT_PACK_VERSION_ACTIVE', detail: 'The active version cannot be uninstalled. Activate another installed version first.' })
    return
  }
  const channels = pinnedChannelSlugs(message)
  if (channels.length) {
    res.status(409).json({
      code: 'CONTENT_PACK_VERSION_PINNED',
      detail: `This version is still pinned by: ${channels.join(', ')}.`,
      channels,
    })
    return
  }
  if (/required by installed dependent packs/i.test(message)) {
    res.status(409).json({ code: 'CONTENT_PACK_VERSION_REQUIRED_BY_OTHERS', detail: message })
    return
  }
  lifecycleFailure(res, error, 'This Content Pack version could not be uninstalled.')
}

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
