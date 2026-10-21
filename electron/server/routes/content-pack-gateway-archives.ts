import { createHash } from 'node:crypto'

import { Router, type Response } from 'express'

import { installContentPack } from '../content-packs/installer.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getGenStudioUrl } from '../services/app-settings.js'
import {
  MAX_IMPORT_BYTES,
  firstParam,
  importFailure,
  routeOptions,
} from './content-pack-route-support.js'

const GATEWAY_ARCHIVE_DIGEST = /^[a-f0-9]{64}$/
const GATEWAY_ARCHIVE_LIST_MAX_BYTES = 2 * 1024 * 1024
const GATEWAY_ARCHIVE_LIST_TIMEOUT_MS = 10_000
const GATEWAY_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 60_000
// The Express `Response` type is imported above; this names the global fetch
// response without shadowing or a second runtime value.
type FetchResponse = Awaited<ReturnType<typeof fetch>>

export const router = Router()

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
