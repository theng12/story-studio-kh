import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import { getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { assertContentPackAppCompatible, installContentPack, verifyInstalledContentPackClosure } from '../content-packs/installer.js'
import { setContentPackDiscoveryDisabled } from '../content-packs/lifecycle.js'
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
import { getApiKey } from '../services/app-secrets-store.js'
import { getGenStudioUrl } from '../services/app-settings.js'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const GATEWAY_ARCHIVE_DIGEST = /^[a-f0-9]{64}$/
const GATEWAY_ARCHIVE_LIST_MAX_BYTES = 2 * 1024 * 1024
const GATEWAY_ARCHIVE_LIST_TIMEOUT_MS = 10_000
const GATEWAY_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 60_000
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
// The Express `Response` type is imported below; this names the global fetch
// response without shadowing or a second runtime value.
type FetchResponse = Awaited<ReturnType<typeof fetch>>
const PackIdSchema = ContentPackVersionRefSchema.shape.pack_id
const VersionSchema = ContentPackVersionRefSchema.shape.version
const AssetIdSchema = ContentPackVersionRefSchema.shape.archive_sha256
const RecoveryIncidentIdSchema = z.string().uuid()

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

function requireBinary(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/octet-stream')) {
    res.status(415).json({ detail: 'Content Pack import requires application/octet-stream.' })
    return
  }
  next()
}

// Local-storage failures are the server's problem, not the archive's. Only the
// code is inspected; no filesystem path or raw message is ever returned.
const IMPORT_STORAGE_EXHAUSTED_CODES = new Set(['ENOSPC', 'EDQUOT'])
const IMPORT_STORAGE_UNAVAILABLE_CODES = new Set([
  'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN', 'ENOTDIR', 'ELOOP',
])
// A valid package that conflicts with local state, rather than a damaged archive.
const IMPORT_CONFLICT_MESSAGE = /Content Pack version is immutable|Content Pack version is pending removal|recalled Content Pack version|Content Pack immutable orphan conflicts with candidate/i
// Refusals that name only the pack, version and required app version.
const IMPORT_VERIFICATION_MESSAGE = /requires Story Studio \d+\.\d+\.\d+ or newer|Content Pack dependency (?:is not installed exactly|cycle)|Content Pack immutable archive identity does not match state|Content Pack signed manifest does not match the expected remote pack identity|Content Pack archive SHA-256 does not match the expected digest/

function importFailure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  const rawCode = (error as NodeJS.ErrnoException)?.code
  const code = typeof rawCode === 'string' ? rawCode : ''

  if (/archive exceeds \d+ byte limit/i.test(message)) {
    res.status(413).json({ detail: `Content Pack archive exceeds the ${MAX_IMPORT_BYTES} byte limit.` })
    return
  }
  if (IMPORT_CONFLICT_MESSAGE.test(message)) {
    res.status(409).json({ detail: message })
    return
  }
  if (IMPORT_STORAGE_EXHAUSTED_CODES.has(code)) {
    res.status(503).json({ detail: 'Story Studio could not store this Content Pack because the disk is full.' })
    return
  }
  if (IMPORT_STORAGE_UNAVAILABLE_CODES.has(code)) {
    res.status(500).json({ detail: 'Story Studio could not write this Content Pack to local storage.' })
    return
  }
  if (message.startsWith('Invalid content-pack archive:')) {
    res.status(400).json({
      detail: 'This Content Pack archive could not be verified. It may be damaged, tampered with, or incompatible with this version of Story Studio.',
    })
    return
  }
  if (IMPORT_VERIFICATION_MESSAGE.test(message)) {
    res.status(400).json({ detail: message })
    return
  }
  // Anything else is a local failure — a missing verification resource, an
  // unreadable keyring, corrupt retained state — never the uploaded archive.
  res.status(500).json({ detail: 'Story Studio could not install this Content Pack because of an internal error.' })
}

export interface GatewayArchiveSummary {
  archiveSha256: string
  bytes: number | null
  packId: string
  version: string
  title: string
  minAppVersion: string
  itemKinds: string[]
  integrity: 'verified' | 'unavailable' | 'unreadable'
}

/**
 * Story speaks to the Gateway's existing authenticated archive bank. The bank
 * is a distribution shelf, not a second ownership or shelf state: the bytes it
 * returns go through the same local-import installer as a chosen `.sspack`.
 */
class GatewayArchiveFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayArchiveFailure'
  }
}

function sendGatewayArchiveFailure(res: Response, error: unknown): void {
  if (error instanceof GatewayArchiveFailure) {
    res.status(error.status).json({ code: error.code, detail: error.message })
    return
  }
  res.status(500).json({
    code: 'CONTENT_PACK_GATEWAY_RESPONSE_INVALID',
    detail: 'Story Studio could not read the Gateway archive bank.',
  })
}

async function gatewayArchiveRequest(pathname: string, init: RequestInit): Promise<FetchResponse> {
  const apiKey = await getApiKey('genstudio').catch(() => '')
  const key = apiKey.trim()
  if (!key) {
    throw new GatewayArchiveFailure(
      400,
      'CONTENT_PACK_GATEWAY_KEY_REQUIRED',
      'Save your Gateway API Key in Settings → This Mac before browsing Gateway archives.',
    )
  }
  let base: string
  try {
    base = (await getGenStudioUrl()).trim().replace(/\/+$/, '')
  } catch {
    throw new GatewayArchiveFailure(
      503,
      'CONTENT_PACK_GATEWAY_CONFIG_UNAVAILABLE',
      'Story Studio could not read its Gateway address. Open Settings → Connections, test the Gateway, then try again.',
    )
  }
  if (!base) {
    throw new GatewayArchiveFailure(
      503,
      'CONTENT_PACK_GATEWAY_CONFIG_UNAVAILABLE',
      'Story Studio has no Gateway address. Open Settings → Connections, test the Gateway, then try again.',
    )
  }
  try {
    return await fetch(`${base}${pathname}`, {
      ...init,
      // The key is sent to the configured Gateway only. Never follow a
      // redirect that could carry it to another origin.
      redirect: 'error',
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${key}`,
      },
    })
  } catch {
    throw new GatewayArchiveFailure(
      503,
      'CONTENT_PACK_GATEWAY_UNREACHABLE',
      'Story Studio could not reach the Gateway archive bank. Check the Gateway connection in Settings, then try again.',
    )
  }
}

function assertGatewayArchiveResponse(response: FetchResponse, archiveDownload = false): void {
  if (response.status === 401 || response.status === 403) {
    throw new GatewayArchiveFailure(
      502,
      'CONTENT_PACK_GATEWAY_REFUSED',
      'The Gateway refused the saved API key. Check it in Settings → This Mac, then try again.',
    )
  }
  if (archiveDownload && (response.status === 404 || response.status === 410)) {
    throw new GatewayArchiveFailure(
      404,
      'CONTENT_PACK_GATEWAY_ARCHIVE_UNAVAILABLE',
      'That archive is no longer available in the Gateway archive bank. Refresh the list and try again.',
    )
  }
  if (!response.ok) {
    throw new GatewayArchiveFailure(
      502,
      'CONTENT_PACK_GATEWAY_UNAVAILABLE',
      'The Gateway could not provide its archive bank. Try again when the Gateway is available.',
    )
  }
}

function responseLength(response: FetchResponse): number | null {
  const raw = response.headers.get('content-length')
  if (!raw) return null
  const length = Number(raw)
  return Number.isSafeInteger(length) && length >= 0 ? length : null
}

async function readGatewayBody(
  response: FetchResponse,
  limit: number,
  tooLarge: GatewayArchiveFailure,
): Promise<Buffer> {
  const declared = responseLength(response)
  if (declared !== null && declared > limit) {
    const body = response.body
    if (body) await body.cancel().catch(() => {})
    throw tooLarge
  }
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw tooLarge
    return bytes
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw tooLarge
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function gatewayText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

/** Project only display metadata; never expose Gateway paths, receipts or trust internals. */
function projectGatewayArchive(value: unknown): GatewayArchiveSummary | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const archiveSha256 = gatewayText(row.archive_sha256, 64)
  if (!GATEWAY_ARCHIVE_DIGEST.test(archiveSha256)) return null
  const bytes = typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes >= 0
    ? row.bytes
    : null
  const itemKinds = Array.isArray(row.item_kinds)
    ? [...new Set(row.item_kinds
      .filter((kind): kind is string => typeof kind === 'string')
      .map(kind => kind.trim().slice(0, 64))
      .filter(Boolean))].slice(0, 12)
    : []
  const integrity = row.integrity === 'verified' || row.integrity === 'unavailable'
    ? row.integrity
    : 'unreadable'
  return {
    archiveSha256,
    bytes,
    packId: gatewayText(row.pack_id, 160),
    version: gatewayText(row.version, 64),
    title: gatewayText(row.title, 200),
    minAppVersion: gatewayText(row.min_app_version, 64),
    itemKinds,
    integrity,
  }
}

router.get('/content-packs/gateway-archives', async (_req, res) => {
  try {
    const response = await gatewayArchiveRequest('/admin/api/content-library', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(GATEWAY_ARCHIVE_LIST_TIMEOUT_MS),
    })
    assertGatewayArchiveResponse(response)
    const text = (await readGatewayBody(
      response,
      GATEWAY_ARCHIVE_LIST_MAX_BYTES,
      new GatewayArchiveFailure(
        502,
        'CONTENT_PACK_GATEWAY_RESPONSE_TOO_LARGE',
        'The Gateway archive bank returned more data than Story Studio can read.',
      ),
    )).toString('utf8')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new GatewayArchiveFailure(
        502,
        'CONTENT_PACK_GATEWAY_RESPONSE_INVALID',
        'Story Studio could not read the Gateway archive bank.',
      )
    }
    const list = body && typeof body === 'object'
      ? (body as { archives?: unknown }).archives
      : undefined
    if (!Array.isArray(list)) {
      throw new GatewayArchiveFailure(
        502,
        'CONTENT_PACK_GATEWAY_RESPONSE_INVALID',
        'Story Studio could not read the Gateway archive bank.',
      )
    }
    const archives = (list as unknown[])
      .map(projectGatewayArchive)
      .filter((archive): archive is GatewayArchiveSummary => archive !== null)
      .sort((left, right) => (left.title || left.packId || left.archiveSha256)
        .localeCompare(right.title || right.packId || right.archiveSha256))
    res.json({ archives })
  } catch (error) {
    sendGatewayArchiveFailure(res, error)
  }
})

router.post('/content-packs/gateway-archives/:digest/install', async (req, res) => {
  const digest = firstParam(req.params.digest)
  if (!GATEWAY_ARCHIVE_DIGEST.test(digest)) {
    res.status(400).json({
      code: 'CONTENT_PACK_GATEWAY_DIGEST_INVALID',
      detail: 'Choose a valid Gateway archive digest.',
    })
    return
  }
  try {
    const response = await gatewayArchiveRequest(`/admin/api/content-library/${digest}/archive`, {
      headers: { Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(GATEWAY_ARCHIVE_DOWNLOAD_TIMEOUT_MS),
    })
    assertGatewayArchiveResponse(response, true)
    const bytes = await readGatewayBody(
      response,
      MAX_IMPORT_BYTES,
      new GatewayArchiveFailure(
        413,
        'CONTENT_PACK_GATEWAY_ARCHIVE_TOO_LARGE',
        `This Gateway archive is larger than the ${MAX_IMPORT_BYTES} byte (50 MiB) local limit.`,
      ),
    )
    if (bytes.byteLength === 0) {
      throw new GatewayArchiveFailure(
        502,
        'CONTENT_PACK_GATEWAY_ARCHIVE_EMPTY',
        'The Gateway archive bank returned an empty file. Nothing was installed.',
      )
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) {
      throw new GatewayArchiveFailure(
        502,
        'CONTENT_PACK_GATEWAY_ARCHIVE_MISMATCH',
        'The Gateway returned an archive whose SHA-256 does not match the archive you chose. Nothing was installed.',
      )
    }
    const options = routeOptions(req)
    const result = await installContentPack(
      {
        archiveBytes: bytes,
        source: 'local-import',
        expectedArchiveSha256: digest,
      },
      { paths: options.paths, policy: options.policy, appVersion: options.appVersion },
    )
    res.status(201).json(result)
  } catch (error) {
    if (error instanceof GatewayArchiveFailure) {
      res.status(error.status).json({ code: error.code, detail: error.message })
      return
    }
    importFailure(res, error)
  }
})

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
